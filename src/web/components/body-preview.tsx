import type { ReactNode } from "react";
import type { OutputDto, StyleHit } from "@/shared/api";
import { styleHitLabel } from "@/shared/labels";
import { cn } from "../lib/utils";

const TOKEN = /\[FACT-[1-9]\d*\]|\[\[[^\]]*\]\]/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mark every style-hit phrase in a run of plain text. */
function highlight(text: string, hits: readonly StyleHit[], keyBase: string): ReactNode[] {
  const phrases = [...new Set(hits.map((h) => h.phrase).filter((p) => p.trim() !== ""))];
  if (phrases.length === 0) return [text];
  const re = new RegExp(
    phrases
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|"),
    "g",
  );
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const hit = hits.find((h) => h.phrase === m[0]);
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <mark
        key={`${keyBase}-${m.index}`}
        title={hit ? styleHitLabel(hit) : undefined}
        className="rounded-sm bg-warning-surface text-inherit underline decoration-warning decoration-wavy underline-offset-4"
      >
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** One line: citation chips, placeholders, and highlighted style hits. */
function Line({ text, output, lineKey }: { text: string; output: OutputDto; lineKey: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) nodes.push(...highlight(text.slice(last, m.index), output.styleHits, `${lineKey}-${last}`));
    const token = m[0];
    if (token.startsWith("[[")) {
      nodes.push(
        <span
          key={`${lineKey}-p${m.index}`}
          className="rounded-sm bg-warning-surface px-1 font-sans text-sm text-warning-foreground ring-1 ring-warning/40"
        >
          {token.slice(2, -2)}
        </span>,
      );
    } else {
      const key = token.slice(1, -1);
      const cited = output.citations.find((c) => c.key === key);
      nodes.push(
        <span
          key={`${lineKey}-c${m.index}`}
          title={
            cited ? `${key}: ${cited.text}${cited.deleted ? " (deleted)" : ""}` : `${key} is not one of your facts`
          }
          className={cn(
            "ml-1 inline-block rounded-sm px-1 align-baseline font-mono text-[0.7rem] tabular-nums leading-snug",
            cited?.deleted || !cited
              ? "bg-destructive/10 text-destructive line-through decoration-1"
              : "bg-accent text-accent-foreground",
          )}
        >
          {key}
        </span>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push(...highlight(text.slice(last), output.styleHits, `${lineKey}-${last}`));
  return <>{nodes}</>;
}

/**
 * The saved body as it reads, with each `[FACT-n]` as a chip (hover shows the fact) and each
 * style hit underlined. Style hits are warnings only; they never block export.
 */
export function BodyPreview({ output }: { output: OutputDto }) {
  const body = output.body ?? "";
  if (body.trim() === "") return null;
  const lines = body.split("\n");
  return (
    <section aria-label="Preview" className="grid max-w-[68ch] gap-2">
      <h3 className="font-medium text-muted-foreground text-xs">Preview of the saved text</h3>
      <div className="grid gap-1 rounded-lg border px-5 py-4 font-serif leading-relaxed">
        {lines.map((raw, i) => {
          const key = `l${i}`;
          const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
          if (heading) {
            return (
              <p key={key} className={cn("font-sans font-semibold", heading[1] === "#" ? "text-lg" : "mt-2 text-sm")}>
                <Line text={heading[2] ?? ""} output={output} lineKey={key} />
              </p>
            );
          }
          const bullet = /^\s*[-*•]\s+(.*)$/.exec(raw);
          if (bullet) {
            return (
              <p key={key} className="relative pl-4">
                <span aria-hidden className="absolute left-0 text-muted-foreground">
                  •
                </span>
                <Line text={bullet[1] ?? ""} output={output} lineKey={key} />
              </p>
            );
          }
          if (raw.trim() === "") return <div key={key} className="h-2" />;
          return (
            <p key={key}>
              <Line text={raw} output={output} lineKey={key} />
            </p>
          );
        })}
      </div>
      {output.styleHits.length > 0 && (
        <div className="grid gap-1">
          <h4 className="font-medium text-sm">
            Wording to check <span className="text-muted-foreground tabular-nums">({output.styleHits.length})</span>
          </h4>
          <ul className="grid gap-1 text-muted-foreground text-sm">
            {output.styleHits.map((hit, i) => (
              // Hits are a stored list with no id; the same phrase can repeat in one sentence.
              // biome-ignore lint/suspicious/noArrayIndexKey: static list, never reordered in place
              <li key={`${i}:${hit.rule}:${hit.phrase}`}>{styleHitLabel(hit)}</li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">These are suggestions. They do not block export.</p>
        </div>
      )}
    </section>
  );
}
