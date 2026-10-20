# Plan: tailor the resume from the base CV (decision 75)

Merged from the four-model plan run `20261019-112641-plan`. A supplied the edit contract, the line-level fact check and the protected-line rule. C and D supplied "changes apply until rejected" and op-level checks in place of a whole-body check. B supplied fail-closed parsing and the snapshot on the output.

## Summary

Today a resume is written from loose facts (`buildDraftPrompt`), which throws away the user's own CV wording. In tailor mode, the imported CV text (`profile_items.body`, kind `cv`) is parsed into numbered base lines (`L1…Ln`). One writing-tier call returns JSON edit ops: `summary`, `order`, `reword`, `remove` and `add`. Pure domain code validates each op against the base and the confirmed facts. Each surviving op becomes a change with a reason. Every change applies until the user rejects it, and `outputs.body` is always `applyEdits(base, changes not rejected)`. Export, Copy, gate, citations and CV preview read `outputs.body` as before. Letters, messages, answers and resumes without a usable CV keep the fact generator.

## Design

- **Base lines** (`src/domain/base-cv.ts`). `parseBaseCv({ text, roles })` returns `{ hash, lines }`. Each `BaseLine` has `{ id, kind: contact | heading | role | bullet | text, text, section, roleKey, facts }`.
  - Wrapped lines are joined, using the same continuation rule as `headerLines`, and bullet glyphs are stripped. Wording is otherwise kept exactly.
  - A role header block (up to 4 lines) that matches a stored role becomes one `role` line, rendered as `### roleHeader(role)`.
  - Lines before the first heading are `contact` and are dropped from the body, because the PDF prints the contact.
  - `mapFactsToLines` attaches each confirmed fact to the bullet in its role that covers most of its content words. Unmapped facts are extras that `add` may use.
  - `isUsableBase` falls back to the generator when there are fewer than 3 bullets or roles exist but none matched.
- **Ops**, for example `{ op: "reword", line: "L16", text, facts: ["FACT-21"], reasons: ["R6"] }`:
  - `order` is a permutation of one role's bullets or of the skills lines.
  - `add` places a bullet after an anchor line.
  - `summary` replaces the Summary section's text.
  - Zod lives in `ai-replies.ts`; the TypeScript types live in `src/domain/tailor.ts`.
- **Validation** (`validateEdits`). Invalid ops are dropped and kept in a list for the retry, so the base line stays.
  - Targets must exist and be the right kind. Headings, roles and contact lines are never edited.
  - Reword and add text must pass `checkLine`. Its evidence is the base line, the line's facts and the cited facts, all from the same role.
  - No pronouns.
  - A line is protected, and can't be removed, when one of its facts is in `requiredResumeFacts`. This carries decision 74 over.
  - An `add` that repeats an existing bullet is dropped.
  - Each line gets one op. At most 12 rewords and 6 adds.
  - Unknown requirement ids are filtered out of `reasons`.
- **Storage.** A new `outputs.tailoring` jsonb column holds `{ baseHash, base, changes, dropped }`. A change is `TailorOp & { id, status: "accepted" | "rejected" }`. A check limits it to `kind = 'resume'`. Migration 0018.
- **Deriving the body.**
  - The body is rendered from the base. Bullets keep their mapped `[FACT-n]` markers, so `output_facts` and the outdated warnings keep working.
  - Ops apply in this order: order, then summary and reword, then add (anchors resolve against the base), then remove.
  - Style hits count only on changed lines.
  - Each decision recomputes the body, `output_facts` and style hits in one transaction and clears `reviewedAt`.
  - A manual edit or blank fill clears `tailoring`.
- **Requirement map (73/74).**
  - The map step runs as before. `selectResumeFacts` is not used, because the CV is the selection.
  - `requiredResumeFacts` becomes the protected-line rule.
  - `requirementsByFact` labels base lines and extras with the requirements they prove.
  - `requirementGaps` becomes the gaps list in the UI.
  - "The Summary opens with the posting's role noun" moves into the tailor prompt.
- **Retry and fallback.**
  - Retry once when the reply can't be read or an op was dropped for a check reason.
  - When the retry can't be read, keep the first reply's valid ops.
  - When both can't be read, save the base unchanged with no changes and add a task-step note. The old generator is never used when a usable CV exists.
- **CV re-import.** The output keeps its snapshot. `baseChanged` (stored hash ≠ hash of the current CV) shows "Your CV changed. Regenerate to start from it."
- **API.** `POST /api/outputs/:id/changes` takes `{ ids, status }` (bulk, so it also serves Accept all and Reject all) and returns the workspace.
- **UI.**
  - `src/web/components/tailor-changes.tsx` sits under the resume card. Each change gets a row with old text (struck through) and new text, reason chips and Keep/Undo `aria-pressed` buttons.
  - Header: "N of M changes kept", plus Keep all and Undo all.
  - Below the rows: the gaps list and the dropped count.
  - Native buttons in DOM order give keyboard access.

## Not doing

- Tailoring letters, messages or answers.
- Moving roles, sections or bullets across roles.
- Version history.
- A match score.
- A new table.
- GitHub ingestion.
- A style-rewrite pass in tailor mode.
- Changes to the PDF renderer or `cv-preview-dialog`.

## Slices

1. Decision 75 and this plan. `bun run check`.
2. `base-cv.ts` with parse, map, render and usability, plus `base-cv.test.ts`. The tests cover: wrapped bullets joined; glyphs stripped and wording kept; role blocks matched; a fact mapped to its bullet; an extra fact; an unusable text; render with markers.
3. `checkLine` in `citations.ts`, and `validateEdits`/`applyEdits`/`tailoringView` in `tailor.ts`, with one test per rule.
4. `buildTailorPrompt`/`buildTailorRetryPrompt` and a guide section, with prompt tests.
5. Contract: `parseTailorReply`, the DTOs (`OutputDto.tailoring`, `DecideChangesInput`), migration 0018 and fake AI support (`queueTailor`, `tailorCalls`, default `{"ops":[]}`).
6. Server tailor run in `draftOne`, with retry and the generator fallback. `test/tailor.test.ts` covers: 2 calls; the base kept; a reword applied; an invented tool dropped and retried; both replies unreadable leaving the base; no CV going to the generator; a cover letter unchanged.
7. Decide endpoint, plus clearing `tailoring` on manual edit and fill. Tests: reject restores the line exactly; Undo all restores the base; `output_facts` follows; frozen is refused; an unknown id gives `output_changed`.
8. UI and `e2e/tailor.spec.ts`. Test flow: draft, see the changes, undo one, check that the body and preview change, then keep all.
9. Evaluation: a real redraft of opportunity `45daca57-…` compared with the 2-page CV, recorded below.

## Evaluation

A real redraft of Owner "Senior Software Engineer, Backend" (opportunity `45daca57`, 2026-10-19, `claude-opus-5-5`). The requirement map was reused, so the run made one call: 11,590 input and 409 output tokens, $0.066. The checks dropped no ops.

| Change | What it did | For |
|---|---|---|
| C1 summary | "Full-stack Software Engineer … React, TypeScript, Python …" became "Backend engineer … TypeScript, Node.js, PostgreSQL and MongoDB". Every claim is in the CV or the facts. | 5+ years backend, TypeScript and Node.js, Mongo, ownership, performance |
| C2 order | The Backend & Databases skills line moved from 4th to 1st. | TypeScript and Node.js, Mongo |
| C3 reword | The same line lists Node.js, MongoDB and PostgreSQL first. The tools are unchanged. | TypeScript and Node.js, Mongo |
| C4 order | Cashflowy's query and Docker results lead its role. | Performance, ownership at scale |

Gap reported: "Collaborating with Product and Design" (required). No fact shows it, and the resume does not claim it.

Against the old generated draft (568 words, rewritten from facts), the resume keeps the user's wording, all five roles and the projects. It reads 712 words. The uploaded CV is 2 pages, but our PDF template renders the same text in 3 pages, with the last project bullet and Education on page 3. That is the template's density (font size, margins, project name and URL on separate lines), not the tailoring. The old draft hid it by writing less. Decided: more pages than the CV are fine, but no page may start mid-entry. The PDF template wraps each role or project with its bullets in an `.entry` that never splits, keeps headings with the next entry, and bolds project names, so every page starts on a heading, a role title or a project name (`test/pdf-pages.test.ts`). An entry taller than a page still splits. When the last page is under 30% full, the renderer tries four tighter steps (text never under 10pt; line height down to 1.34, margins down to 13/15mm) and keeps the loosest that saves a page; if none does, the normal layout stands. The tightest step is tried first, so when no step can save a page the cost is one extra render. Measured: about 50 ms for one render, 63 ms when nothing saves a page, 100 ms when one does. This resume's last page is 41% full, so it stays at 3 pages: a third page with that much on it is fine, and smaller text is not worth it.
