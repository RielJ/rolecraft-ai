import {
  type AddonPrefill,
  folderPrefill,
  githubPrefill,
  gitlabPrefill,
  parseProjectSource,
} from "@/domain/project-source";
import type { AddonPrefillDto, PrefillAddonInput } from "@/shared/api";
import { GithubError } from "../adapters/github";
import { GitlabError } from "../adapters/gitlab";
import { AppError, type Deps } from "./context";
import { githubAppError, githubUserFor } from "./github";
import { loadContact } from "./profile";

/**
 * Filling the add-on form from one GitHub or GitLab link or folder path (decision 80). Reads
 * only; nothing is saved. GitHub goes through the configured reader (gh or public), GitLab through
 * its public API on allowed hosts, and a folder through git on this machine.
 */
export async function prefillAddon(deps: Deps, { source }: PrefillAddonInput): Promise<AddonPrefillDto> {
  const parsed = parseProjectSource({ raw: source, gitlabHosts: deps.gitlab.hosts });
  const needs = (message: string) => new AppError({ code: "needs_input", message });
  const githubUser = async () =>
    githubUserFor({ configured: deps.github.user, links: (await loadContact(deps)).contact.links })?.user ?? null;

  let prefill: AddonPrefill;
  switch (parsed.kind) {
    case "unknown":
      throw needs(parsed.message);
    case "github":
      try {
        prefill = githubPrefill({ about: await deps.github.about(parsed.link), user: await githubUser() });
      } catch (err) {
        if (err instanceof GithubError) throw githubAppError(err);
        throw err;
      }
      break;
    case "gitlab":
      try {
        prefill = gitlabPrefill(await deps.gitlab.about(parsed));
      } catch (err) {
        if (err instanceof GitlabError) throw needs(err.message);
        throw err;
      }
      break;
    case "folder": {
      let folder: Awaited<ReturnType<Deps["folders"]["read"]>>;
      let path: string;
      try {
        path = await deps.folders.resolve(parsed.path);
        folder = await deps.folders.read(path);
      } catch (err) {
        throw needs(err instanceof Error ? err.message : String(err));
      }
      const filled = folderPrefill({ folder, emails: await deps.folders.emails(), githubUser: await githubUser() });
      // Only a git repo can be read for facts (decision 81).
      return { ...filled, folder: folder.git ? path : null };
    }
  }
  return { ...prefill, folder: null };
}
