# Plan: tailored drafts that read like a person wrote them

Status: proposed 2026-10-19, open questions answered the same day. Not built.

## Goal

A drafted resume shows a recruiter, in the first skim, that the candidate has what this posting requires. It reads like an engineer wrote it, not a model.

Two things follow from that:

- **Tailored, not reworded.** The draft starts from the posting's requirements and picks the facts that prove them. Facts that prove nothing for this job are left out.
- **No generated tells.** No pronoun at the start of every bullet, no repeated openers, no uniform rhythm, no keyword lists posing as sentences.

The facts-only rule stays. A draft can't claim experience that no confirmed fact backs. When the posting asks for something the facts don't show, the app tells the candidate, so they can add a fact if it's true.

## What's wrong today

Measured on the Owner "Senior Software Engineer, Backend" draft (opportunity `45daca57`, 2026-10-19):

| Symptom | Cause in the code |
|---|---|
| All 51 confirmed facts are cited. Nothing is left out. | The resume task (`src/domain/prompts.ts:57`) says only "Lead with the facts that matter most". Every fact is in the prompt and nothing asks for a selection. |
| Roles and bullets keep CV order. Tailor.video has 9 bullets. | No bullet budget per role, and no step that ranks facts against the posting. |
| Every bullet starts with "I". | `VOICE_RULES` (`src/domain/style.ts:53`) says "plain first person" for every kind, and the format rule's example is "I built the payments API". The guide already says resumes use no pronouns, but slice B of `docs/plans/clean-files.md` was never built. |
| The body starts with `# Riel Joseph Bulaybulay`, and Skills comes last. | Same: the guide's structure (Summary, Skills, Experience, Projects, Education, no name) was never applied to the prompt. |
| The Summary says "full-stack… React, TypeScript, Python" for a backend role. | Nothing tells the model which of the posting's requirements matter most. |

## Design

### 1. The guide is the drafting prompt's source

Each draft prompt includes the guide's rules for its kind. The guide stops being a document the code is supposed to follow and becomes text the model reads on every draft.

- Move `docs/drafting-guide.md` to `src/domain/drafting-guide.md`. The runtime image copies `src/domain` but not `docs/`, so this is the only place a file is sure to exist in production. `docs/drafting-guide.md` becomes a one-line pointer.
- `prompts.ts` imports it with `import guide from "./drafting-guide.md" with { type: "text" }` and extracts sections by heading: "Constraints that override any advice", "Shared rules", "Sounds like a person" (new), and the section for the kind ("Resume", "Cover letter", "Short message (job)", "Short message (contract proposal)"). "Sources", "Disagreements and our picks" and "Changes this implies in the code" are never sent.
- A unit test fails when a heading the prompt needs is missing or renamed, so editing the guide can't silently empty the prompt.
- `VOICE_RULES` and `FORMAT_RULES` shrink to what the guide doesn't say: the marker and blank syntax, and the Markdown subset. Voice moves into the guide, per kind.
- Cost: about 2,500 extra input tokens per resume call (draft, retry and style rewrite). Slice A confirms that the spending-cap estimate counts the longer prompt.

### 2. Read the posting's requirements first

Before drafting, one AI call reads the posting and the candidate's facts and returns a requirement map:

```json
{
  "role": "Senior backend engineer",
  "requirements": [
    { "id": "R1", "text": "5+ years building and operating backend systems in production", "weight": "must", "facts": ["FACT-149", "FACT-161"] },
    { "id": "R2", "text": "TypeScript and Node.js", "weight": "must", "facts": ["FACT-155", "FACT-192"] },
    { "id": "R3", "text": "Reliability and performance at scale", "weight": "must", "facts": ["FACT-161", "FACT-165", "FACT-175"] },
    { "id": "R4", "text": "Marketing or lifecycle systems", "weight": "nice", "facts": ["FACT-168", "FACT-171"] },
    { "id": "R5", "text": "MongoDB in production", "weight": "must", "facts": [] }
  ]
}
```

- `weight` is `must`, `duty` or `nice`. At most 12 requirements, in the posting's order of importance.
- The server validates the reply with zod and drops any fact key that isn't confirmed. A requirement with no facts is a **gap**.
- The map is stored on the opportunity with a hash of the posting description and of the confirmed fact set. A redraft reuses it until the posting or the facts change. Letters, messages and answers use the same map.
- The writing tier does this call, because the selection decides what the recruiter sees.

### 3. Draft from the map

The resume prompt gets the requirement map ahead of the fact list, and only the facts the map selected, plus enough to keep the work history readable:

- **Every role stays, with at least one bullet**, so the timeline has no holes. A role with no matching fact keeps the fact that best says what the product was and what the candidate did there (for example "Built frontend and backend systems for a Web3 streaming platform…"), so a reader understands the role even when it doesn't match this job. The requirement call marks that fact as the role's `context` fact.
- **No length limit.** Relevance decides what goes in, not a page count. As a guide in the prompt, not a check: 3 to 5 bullets for roles that match the posting, 1 to 2 for the rest.
- **Order:** each role's first bullet is the fact that proves the highest-weight requirement. Skills lines put the posting's stack first and drop categories the posting doesn't touch (no Blockchain line for a backend role).
- **Summary:** 2 to 3 sentences, under 50 words, built from the `must` requirements that have facts. It may use the posting's role noun ("backend engineer") when the cited facts show that work, even if the titles say "Full-stack".
- **Projects:** only projects that back a requirement.
- **Posting vocabulary:** where a fact backs it, the bullet uses the posting's words once ("reliability", "distributed systems"). The existing anti-invention check still rejects tokens that no cited fact has.

### 4. Checks after the draft

All deterministic, in `src/domain`:

| Check | Rule | On failure |
|---|---|---|
| `pronoun` (resume only) | A bullet or Summary sentence starts with, or contains, I, my, me, we or our. | Style hit, fixed by the existing style rewrite. |
| `repeated_opener` | Three or more bullets in one role start with the same word, or one word starts more than a quarter of all bullets. | Style hit, fixed by the style rewrite. |
| `same_shape` | More than half the bullets end in a trailing ", improving …" / ", resulting in …" clause. | Style hit. |
| Every role present | A role from the ROLES list has no bullet. | Joins the retry, naming the role and its `context` fact. |
| Coverage | Which requirements the draft cites a backing fact for. | Never fails the draft. Saved with the output and shown in the UI. |

### 5. Show the candidate what the draft proves

In the drafts tab, next to the resume, a "Requirements" list:

- **Shown:** the requirement and the bullet that proves it.
- **Not shown:** facts back it, but the draft left it out. One click redrafts with it required.
- **Gap:** no confirmed fact backs it. A link to Profile to add one, if it's true.

This is how the candidate learns that, for Owner, nothing in their facts shows MongoDB or Node.js in a role, or any number about scale.

### 6. "Sounds like a person" in the guide

A new guide section, researched and sourced like the rest, covering the tells readers and hiring managers name for generated resumes and letters: identical bullet shapes, every bullet ending in a metric clause, pronoun-led bullets, stacked buzzwords, summaries that list skills, "leveraging" and "utilizing" style verbs, and perfect parallelism across roles. Each tell becomes either a prompt rule (in the guide) or a deterministic check (section 4). Phrases that the style check can match without false hits join `BANNED_PHRASES`.

## Slices

Each slice leaves `bun run check` green and ships on its own.

### Slice A. Guide in the prompt, voice per kind

Status: built 2026-10-19 (decision 72). The guide adds about 1,400 input tokens to a resume call, not 2,500. The by-hand Owner redraft passed with slice B.

- Move the guide to `src/domain/drafting-guide.md`. Add "Sounds like a person" (research included) and "Tailoring" (sections 3 and 6 above).
- `prompts.ts`: build the system prompt from the guide's sections per kind. The resume no longer starts with `# name`; it uses the guide's section order.
- `style.ts`: the `pronoun`, `repeated_opener` and `same_shape` checks. The style rewrite prompt gets the kind's voice rules.
- Absorbs slice B of `docs/plans/clean-files.md`, except role headers, which decision 71 already covers.

Acceptance:
- A prompt test shows the resume prompt contains the guide's Resume section and none of its Sources.
- A guide-heading test fails when a needed heading is renamed.
- Style tests: "I built X" and four "Built…" bullets in one role are flagged. Letters keep first person and aren't flagged.
- A workspace test with the fake AI: a first draft whose bullets start with "I" comes back rewritten.
- Redraft the Owner resume by hand: no bullet starts with a pronoun, and the body has no name heading.

### Slice B. Requirement map and selected facts

Status: built 2026-10-19 (decision 73). Owner Backend redraft: 23 facts cited (was 51), 18 bullets (was 36), no bullet starts with a pronoun (was 26), no name heading, all five roles present, Soulbound reads "a Web3 streaming platform", no Blockchain skills line. The Summary names databases, Node.js and MongoDB but still opens "Full-stack software engineer", which matches every role title in the facts. Cost: $0.04 for the map, $0.11 for the draft and one retry.

- Migration: `requirement_map jsonb` and `requirement_map_key text` on `opportunities`.
- `src/domain/requirements.ts`: the prompt, zod schema, validation and gap list.
- `workspace.ts`: build or reuse the map before drafting. The resume prompt gets the map, the selected facts and each role's `context` fact.

Acceptance:
- Domain tests: unknown fact keys are dropped; a requirement left with no facts is a gap; the cache key changes when the posting or the fact set changes.
- A workspace test: a redraft with the same posting and facts makes no second map call.
- A workspace test: facts the map didn't select are not in the resume prompt, apart from one per uncovered role.
- Owner resume, redrafted: fewer facts cited than the 51 of today, every role present, Soulbound's bullet says what the platform was, the Summary names backend work, and no Blockchain skills line.

### Slice B2. Never drop the strongest evidence

Status: built 2026-10-19 (decision 74). Owner Backend redraft: Summary opens "Backend engineer"; every experience bullet of the 2-page CV is now covered (Docker numbers, 4 pipelines, Better Auth with 37 tests, Plaid and Stripe, Remix to React Router 7, Hyperdrive); 16 requirements (was about 10), with performance, security and maintainability split out. 568 words (was 371). Cost: $0.04 map, $0.15 draft and one retry. Still missing against the CV: side projects other than Viem, and the school name, because they are not facts.

### Slice C. Role check and coverage

- The every-role check joins the retry. Coverage is saved with the output.

Acceptance:
- A domain test: a draft missing a role fails, naming the role.
- A workspace test where the fake AI's first draft drops a role: the retry prompt names it and its `context` fact.
- A domain test for coverage: a requirement counts as shown only when a sentence cites one of its facts.

### Slice D. Requirements list in the drafts tab

- The list from section 5, with "redraft with this" and the link to Profile.

Acceptance:
- Server tests for the response shape. An e2e test: the list shows Shown, Not shown and Gap rows for a seeded map, and "redraft with this" starts a draft.

### Slice E. Evaluation cases

- `eval/drafting/tailoring.json`: synthetic candidates (not real CVs) with a backend posting, a frontend posting and a contract. Metrics: pronoun-led bullets (target 0), distinct opener ratio, share of facts cited, and `must` coverage.

### Slice F (later). Requirement coverage on the Matches board

The user asked for a percentage on every listing: how many of the posting's requirements the facts meet. They prefer string matching to AI. Measured on 2026-10-19 against the 1,999 open jobs and the 51 confirmed facts:

| Approach | Result |
|---|---|
| Find the requirements section by its heading ("Requirements", "What you'll need", …) | Found in 1,415 jobs (71%). 584 have none a rule can find. |
| Word overlap between each requirement and the best fact | Called 2% of `must` lines met. It missed obvious matches: "JavaScript or TypeScript, Postgres, and modern frontend frameworks" scored 0.25 against facts that name all three. Not usable. |
| Judge only the lines a rule can decide: a named tool (met if the facts name any tool in the line) or a number of years | Only 22% of requirement lines name a tool or years. 303 jobs (15%) have 3 or more such lines; most have 0 to 2. In a typical engineering posting this judges 3 of 13 lines. |

Conclusion: string matching can't give a requirement percentage that means anything. Most requirements are phrases like "distributed systems for several years", "ETL pipelines at scale" or "code quality and testing", which need reading. The tool-and-years part is what the board's skill count (decision 26) already shows. A percentage from 2 judged lines out of 13 would mislead.

With AI it is cheap. Slice B already builds the requirement map. Run with the model the drafts use for small calls (Haiku: about 2,300 input and 800 output tokens, $0.0007 per call in `ai_calls`), it would cost about $0.001 to $0.002 per job: $2 to $4 once for the 1,999 open jobs, then about 5 cents a day for the roughly 28 new jobs a day. Shape when we build it:

- Split slice B's map in two: the requirement list, which depends only on the posting and can be stored on the job, and the coverage (which facts meet each requirement), which depends on the facts and is recomputed when they change.
- Map a job when it is first scored at Strong or Good, not every listing, and count it against the spending cap.
- The board shows "6 of 9 requirements" from the `must` lines, never a bare percentage, so a 2-requirement posting doesn't read as 100%.

Decided 2026-10-19: wait. Build slice B so its map can be split this way.

Built 2026-10-20 instead, with no AI (decision 76): the skill count now counts only required skills, splits off nice-to-have ones found by rule, and shows a percentage from 3 skills up. The AI requirement percentage above still waits.

## Decisions to record

Next free numbers in `docs/DECISIONS.md` are 72 onward:

- 72: The drafting guide is part of every draft prompt and lives in `src/domain`.
- 73: Resumes are drafted from a requirement map; facts that back no requirement are left out, except one per role.
- 74: Gaps are shown to the candidate, never written into a draft.

- 75: Resumes have no page limit; relevance decides what goes in. The guide's "one page target" changes to match.

## Answered questions (2026-10-19)

1. **Roles with nothing relevant:** keep every role with one bullet, and that bullet must say what the role achieved and what the candidate did there.
2. **Length:** no limit.
3. **Requirements list:** later, in slice D.
4. **Summary role noun:** yes, the posting's role noun is allowed when the cited facts show the work.
