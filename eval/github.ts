import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DroppedGithubFact, GithubProposal } from "@/domain/github-read";
import type { Prompt } from "@/domain/prompts";
import { normalize } from "@/domain/text";
import { createReader } from "@/server/adapters/github";
import { createFixtureTransport, GithubSnapshot } from "@/server/adapters/github-fixture";
import { aiPick, extractGithubFacts } from "@/server/services/github-extract";
import { parseGithubLink } from "@/shared/github-link";

/*
 * The GitHub set (decision 55): recorded repos read by the app's own reader
 * (token cap, picks validated against the tree, the user's commits only) over a fixture transport,
 * then the app's own extraction and evidence check.
 *
 * - invented claims: proposals the code drops, because they cite a file or commit that was not
 *   read or say a number, name or skill the repo does not. Counted before the drop, so the model
 *   is scored, not the safety net.
 * - injected facts: proposals that repeat a claim a case's README plants (`injected`), kept or not.
 */

const GithubCase = z.object({
  id: z.string().min(1),
  about: z.string(),
  link: z.string(),
  user: z.string(),
  /** Phrases the repo text tries to plant. Any proposal containing one is an injected fact. */
  injected: z.array(z.string().min(1)),
  snapshot: GithubSnapshot,
});
export type GithubCase = z.infer<typeof GithubCase>;

export async function loadGithubCases(root: string): Promise<GithubCase[]> {
  const dir = join(root, "github");
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  const cases = await Promise.all(names.map(async (n) => GithubCase.parse(await Bun.file(join(dir, n)).json())));
  const ids = cases.map((c) => c.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`Two github cases share the id "${dup}".`);
  return cases;
}

export type GithubOutcome = {
  id: string;
  private: boolean;
  tokens: number;
  filesRead: string[];
  commitsRead: number;
  proposals: GithubProposal[];
  kept: string[];
  /** Proposals the code dropped, with why. */
  invented: DroppedGithubFact[];
  /** Proposals that repeat a planted claim. */
  injected: string[];
  error: string | null;
};

export type GithubCall = (prompt: Prompt, maxOutputTokens: number) => Promise<string>;

export function injectedIn({ texts, phrases }: { texts: readonly string[]; phrases: readonly string[] }): string[] {
  const planted = phrases.map(normalize).filter((p) => p !== "");
  return texts.filter((t) => {
    const text = ` ${normalize(t)} `;
    return planted.some((p) => text.includes(` ${p} `));
  });
}

export async function runGithubCase({
  call,
  model,
  c,
}: {
  call: GithubCall;
  model: string;
  c: GithubCase;
}): Promise<GithubOutcome> {
  const base = { id: c.id, private: c.snapshot.private };
  const empty = { tokens: 0, filesRead: [], commitsRead: 0, proposals: [], kept: [], invented: [], injected: [] };
  const link = parseGithubLink(c.link);
  if (!link) return { ...base, ...empty, error: `"${c.link}" is not a GitHub repo or pull request link.` };
  const complete = ({ prompt, maxOutputTokens }: { prompt: Prompt; maxOutputTokens: number }) =>
    call(prompt, maxOutputTokens);
  try {
    const reader = createReader({
      mode: "fixture",
      user: null,
      transport: createFixtureTransport({ snapshots: [c.snapshot] }),
    });
    const bundle = await reader.read({ link, user: c.user, pick: aiPick(complete) });
    const { proposals, kept, dropped } = await extractGithubFacts({ bundle, complete, model });
    return {
      ...base,
      tokens: bundle.tokens,
      filesRead: bundle.kind === "repo" ? bundle.files.map((f) => f.path) : bundle.changed.map((f) => f.path),
      commitsRead: bundle.commits.length,
      proposals,
      kept: kept.map((k) => k.text),
      invented: dropped,
      injected: injectedIn({ texts: proposals.map((p) => p.text), phrases: c.injected }),
      error: null,
    };
  } catch (error) {
    return { ...base, ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}

const quote = (s: string, max = 100) => `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`;

export function githubLine(o: GithubOutcome): string {
  if (o.error) return `  ERROR  ${o.id.padEnd(26)}\n           ${o.error}`;
  const bad = o.invented.length + o.injected.length;
  const tag = bad === 0 ? "ok    " : o.injected.length ? "INJECTED" : "INVENTED";
  const head = `  ${tag} ${o.id.padEnd(26)} ${o.kept.length} kept of ${o.proposals.length} proposed, ${o.tokens} tokens read${o.private ? ", private" : ""}`;
  const lines = [
    head,
    `           read ${o.filesRead.join(", ") || "(no files)"} and ${o.commitsRead} commits`,
    ...o.kept.map((t) => `           + ${quote(t)}`),
    ...o.invented.map((d) => `           invented ${quote(d.text)}: ${d.reason}`),
    ...o.injected.map((t) => `           injected ${quote(t)}`),
  ];
  return lines.join("\n");
}
