import { z } from "zod";
import type { GitlabAbout } from "@/domain/project-source";
import { type HttpClient, HttpError } from "./http";

/**
 * Reading one public GitLab project to fill the add-on form (decision 80): its name, description,
 * languages and README. Unauthenticated REST v4 through the polite `http.ts` client, so public
 * projects only; a private one answers 404 like a missing one. Only hosts the caller allows
 * (gitlab.com and `HB_GITLAB_HOSTS`) are ever asked, and `http.ts` refuses private addresses.
 */

export class GitlabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitlabError";
  }
}

export type GitlabReader = {
  /** Hosts besides gitlab.com that may be read (`HB_GITLAB_HOSTS`). */
  readonly hosts: readonly string[];
  about(input: { host: string; path: string }): Promise<GitlabAbout>;
};

const Project = z.object({
  id: z.number().int(),
  name: z.string(),
  web_url: z.string(),
  description: z.string().nullable().default(null),
  default_branch: z.string().nullable().default(null),
  readme_url: z.string().nullable().default(null),
});
const Languages = z.record(z.string(), z.number());

/** README text kept: the form takes only its first paragraph. */
const README_CHARS = 16_000;

function parse<T>(schema: z.ZodType<T>, body: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new GitlabError(`GitLab sent something other than JSON for ${what}.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GitlabError(`GitLab's answer for ${what} was not the shape expected.`);
  return parsed.data;
}

/** The README's path in the repo, from `readme_url` (`…/-/blob/<branch>/docs/README.md`). */
export function readmePath({ readmeUrl, branch }: { readmeUrl: string; branch: string }): string | null {
  const marker = `/-/blob/${branch}/`;
  const at = readmeUrl.indexOf(marker);
  return at < 0 ? null : decodeURIComponent(readmeUrl.slice(at + marker.length));
}

export function createGitlabReader({
  http,
  hosts = [],
}: {
  http: HttpClient;
  hosts?: readonly string[];
}): GitlabReader {
  async function get(url: string, what: string): Promise<string> {
    try {
      return (await http.getText(url, { accept: "application/json" })).body;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (err.kind === "status" && (err.status === 404 || err.status === 401 || err.status === 403)) {
        throw new GitlabError(`GitLab has no public ${what} there. Private GitLab projects can't be read yet.`);
      }
      throw new GitlabError(`GitLab could not be read: ${err.message}`);
    }
  }

  return {
    hosts,
    async about({ host, path }) {
      const api = `https://${host}/api/v4/projects`;
      const project = parse(Project, await get(`${api}/${encodeURIComponent(path)}`, "project"), "the project");
      const base = `${api}/${project.id}`;
      const languages = await get(`${base}/languages`, "language list").then(
        (body) => parse(Languages, body, "the languages"),
        () => ({}),
      );
      const branch = project.default_branch;
      const file = project.readme_url && branch ? readmePath({ readmeUrl: project.readme_url, branch }) : null;
      const readme =
        file && branch
          ? await http
              .getText(`${base}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(branch)}`, {
                accept: "text/plain",
              })
              .then(
                (r) => r.body.slice(0, README_CHARS),
                () => null,
              )
          : null;
      return {
        name: project.name,
        webUrl: project.web_url,
        description: project.description,
        languages: Object.entries(languages)
          .sort(([, a], [, b]) => b - a)
          .map(([name]) => name),
        readme,
      };
    },
  };
}
