# Plan: clean files, file-first display, fill-in blanks

Status: design agreed with the user in two grilling rounds on 2026-10-18. Not built. It ships as two slices: display first (slice A), then prompts (slice B). Slice B follows `docs/drafting-guide.md`.

## Problem

- The job page shows each file as a raw text box with `FACT-n` chips and Markdown (`#`, `**`, `-`). A hiring manager has no access to our facts, so none of that may appear in anything the user sends.
- A resume is used as a file. The page should offer the PDF, not a wall of text.
- A cover letter is used both as a file and pasted into a "cover letter" text field, so it needs both forms.
- Blanks (`[[...]]`) can only be fixed by editing the raw body. They need their own inputs. After the user submits them, the next preview shows the change.
- "Copy as text" (`exportText`, `src/server/services/workspace.ts:575`) strips the fact markers but keeps the Markdown.
- Resume bodies start with `# name`, which the PDF header already prints.

## Decisions

### Display per kind

| Kind | On the page | Actions |
|---|---|---|
| Resume | Summary card only: "Drafted 2 h ago · 1 page · 2 blanks" | Preview PDF, Copy text, Download PDF; overflow: Edit text, Regenerate |
| Cover letter | Summary card ("· 290 words") with the clean text below it, read-only | Preview PDF, Copy text, Download PDF; overflow: Edit text, Regenerate |
| Message | Same as the letter, with no PDF | Copy text; overflow: Edit text, Regenerate |
| Answers (question rows) | Same as the message, one per row | Copy text; Edit text, Regenerate |

- **Preview modal:** only the PDF, in the browser's viewer, with Copy text, Download PDF and Close in the footer. Preview works while blanks remain, and shows each unfilled blank as a highlighted box. It fetches the PDF fresh each time it opens, so filled blanks show up.
- **Copy text and Download PDF** stay locked until the file has no blanks, as today.
- **Copy format:** "content only". Headings become their own lines with a blank line before them, `-` bullets become `• `, and `**bold**` loses its asterisks. Markers and blanks never appear. This is one pure domain function, `toPlainText`, used by Copy and by the letter's inline view.
- **Length:** no page count (dropped; see decision 70). The card warns "Likely over one page" when a resume passes 400 words, and Preview PDF shows the real length.
- **Applied (frozen) jobs:** Preview, Copy text and Download PDF still work. Edit text, Regenerate and the blank inputs are hidden.
- **No facts list on files.** The per-file "Cited facts" list is removed. The "Facts changed" warning stays, worded without `FACT-n` keys.
- **Facts rail:** kept, but shown as plain sentences grouped by employer or project, with no `FACT-n`.
- **Old drafts:** when rendering the PDF and the copy text, drop a first `# ` line that matches the contact name. No data migration.

### Blanks ("Needs your input", under the card)

- **Missing info**, for example `[[Employer for the 2019 role]]`: a labelled input for each blank, with "Also save to my facts" ticked by default.
- **Check this**, a sentence the facts don't back: an input pre-filled with the sentence. Saving keeps the edited text as the user's own words, with no source. Remove drops the sentence.
- **One "Save answers" button** applies every filled input together. Empty inputs stay as blanks.
- **Saved as facts:** they go into one add-on of kind `other`, "Filled in while drafting", created on first use. Each answer becomes one line and one confirmed fact, written as "question: answer", with no AI split. It is editable and deletable in Settings like any add-on.

### Edit text

- "Edit text" turns the card into a text box, inline, with Save and Cancel. The box shows clean text: no markers, and blanks as `[[...]]` so they can still be typed.
- On save, the server keeps the sources of every sentence the user did not change. A sentence the user rewrote becomes their own words and loses its sources, so a later fact change won't flag it. This is a pure domain function with tests.

## Slice A: display (first)

- Domain: `toPlainText`, stripping the leading name line, and restoring markers from a clean edit. Each has unit tests.
- Server:
  - `GET /outputs/:id/preview.pdf`: inline, not gated, blanks highlighted.
  - `PATCH` accepts `{ text }` (the clean edit).
  - A fill endpoint takes `{ answers: [{ blank, value, saveAsFact }], remove: [blank] }`.
  - `OutputDto` gains `text` (clean) and `words`, and loses `citations` from the UI.
- Web:
  - A file card for each kind, the preview dialog, the blanks form and the inline editor.
  - Remove `BodyPreview` and the cited-facts list. Rail facts without keys.
- e2e: preview opens; filling a blank changes the next preview and unlocks Download; copy has no `#`, `**` or `FACT`; an applied job is view-only.

## Slice B: prompts (second)

From `docs/drafting-guide.md`, "Changes this implies in the code":

- `VOICE_RULES` per kind: resumes have no pronouns.
- The resume structure, with role headers taken from each fact's `section`, which the prompt now includes. The anti-invention check accepts section text as evidence for header lines.
- Letter and message structures, lengths, and banned openers and closers.

## Not decided here

- Decision numbers and the migration number get assigned when slice A starts, after the latest in `docs/DECISIONS.md` and `drizzle/`.
