# Plan: skills (slice 15) and CV preview (slice 16)

Merged from multi-plan run `20261018-111623-plan`: Plan A (Opus 5.5) is the base. Two parts come from Plan D (Opus 5): job skills are read in one place, and a timing test runs with no database. The user approved this on 2026-10-18 with these choices:
- The dictionary grows to 96 entries. Measured extras then bring it to about 110.
- Spark is tightened, and its known miss is accepted.
- The title-fit fixes are included as the last step of slice 15.

## Facts checked in the code

- `SKILLS` has 76 entries. Kotlin, Ruby, Rails, Vue, Kafka, Svelte, dbt, PyTorch, Swift, Playwright, Spark, Snowflake, React Native, Flutter, Elasticsearch and Cypress **already exist**. There are 20 real additions: 9 CV skills and 11 frequent ones.
- `extractSkills` has a single caller that reads jobs: `derive()` in `src/domain/posting.ts:58`. `skillsInFacts` is called from `profile.ts` (`skillsFound`) and `matches.ts` (`loadMatchProfile`). Nothing in drafting calls either one.
- `runRefresh` is started from `src/server/services/sources.ts:155`, with app-role `deps`. Read the user's skill list there and pass it into `runRefresh`. The `hb_sync` role gets no new grants.
- The upload body limit is `MAX_CV_BYTES` (10 MB). A stored file is capped at 5 MB. An upload over 5 MB and up to 10 MB is still read, but its file is not kept.
- `localGuard` checks Origin only on mutating methods. So the GET route that serves the file must also refuse `Sec-Fetch-Site: cross-site`.

## Slice 15: Skills

### Design
1. **Strict patterns** (`features.ts`): `Skill` gets the optional fields `strict` (a capitalized spelling must not start a sentence or line), `notAfter` (a negative lookahead for following words) and `notBefore` (a negative lookbehind).
   - Spark: `Spark` is strict and `notAfter` Networks/Capital/Labs/Group. `pyspark`, `apache spark`, `spark sql` and `spark streaming` stay as spellings. Known miss: "Spark, Hadoop" at the start of a bullet.
   - Grafana: `notAfter` Labs.
   - Foundry: strict, `notBefore` Palantir, plus `foundry-rs`.
   - Prisma: `notAfter` Cloud/Access.
   - Jest: exact case.
   - RAG: exact case, plus the long forms.
   - Bash: exact case, plus `bash scripting` and `bash script`.
   - Solidity: strict.
2. **Additions:**
   - The 9 CV skills: Solidity, Vite, Nginx, Bash, Hardhat, Foundry, shadcn, Cloudflare, React Router.
   - 11 frequent skills: LLM, Web3, Supabase, OpenAI, RAG, Datadog, Prisma, Firebase, Jest, Grafana, Prometheus.
   - Then count these candidates in open jobs: Vitest, Redux, Storybook, Webpack, Jenkins, GitHub Actions, Sentry, Vercel, LangChain, Hugging Face, BigQuery, Databricks, Ethereum, Zod, Hono, Drizzle, Tableau, Looker. Keep each one that appears in at least 5 open jobs, up to about 14 total, and record the counts in a comment.
   - Each new entry gets a positive fixture. Each ambiguous entry also gets a negative one.
   - Test that names are unique and that the count is between 100 and 115.
3. **Per-user dictionary:**
   - `compileSkills(custom)` returns a `SkillDictionary`.
   - `extractSkills(text, dict = BUILTIN_SKILLS)` returns built-in skills in dictionary order, then custom skills in the order the user added them.
   - A custom name of 3 characters or fewer must match its case exactly. Longer names match in any case.
   - Escape names with `escapeRegExp` and use the same boundaries as built-ins.
   - Thread `dict` through `derive(fields, dict?)`. Callers that pass no dictionary behave exactly as today.
4. **Normalization** (`src/domain/user-skills.ts`): `normalizeSkillName(raw)` does the following:
   - trims the name and collapses whitespace
   - rejects control characters, empty names, names over 60 characters, and names with no letter or digit
   - maps a built-in name or spelling to its canonical name ("golang" becomes Go)
   - returns `{ name, key, builtin }`.
5. **Storage:** `user_skills(user_id, key, name, kind 'added'|'hidden', created_at)`.
   - Primary key `(user_id, key)`, so one skill cannot be both added and hidden.
   - A user can add at most 100 skills.
   - No grants to `hb_sync`. Add an explicit part (b) case for it in `test/sync-invariant.test.ts`.
   - Generate the migration with drizzle-kit (it becomes 0011, after the uncommitted 0010).
6. **Assembly:** one pure function `profileSkills({ factSkills, rows })` returns `{ matching, chips }`.
   - `matching` = (skills found in facts ∪ added) − hidden.
   - Chips: a skill that is both found in facts and added shows as found in facts. A hidden skill still shows, so it can be restored.
   - Both `getProfile` and `loadMatchProfile` use it.
   - `skillsFound` keeps its meaning: skills in facts only.
7. **Known-name filter:** Matches drops job skills that are not built-in and not in the user's current custom list. Removing a custom skill therefore takes effect at once.
8. **Refresh re-read:** after the sources loop, add the step `ctx.step("Reading skills in stored jobs")`.
   - It works on all of the user's open jobs, in batches of 500, inside `asSync`.
   - It updates only rows whose skills changed, with a single `UPDATE … FROM (VALUES)` per batch.
   - Add `RefreshResult.skillsReread`, defaulting to 0.
9. **API:**
   - `PUT /api/profile/skills {name, state: added|hidden|none}` returns `ProfileDto`.
   - Hiding a skill that facts don't name returns 409 `not_in_facts`.
   - Going over the limit returns 409.
   - `ProfileDto` gains `skillChips[] {name, source: facts|added|hidden, builtin}` and `skillCatalog: string[]`.
10. **UI** (in Profile → Facts):
    - The heading becomes "Skills used for matching", with a legend.
    - Each chip has an × button: "Hide {skill} from matching" for skills found in facts, "Remove {skill}" for added ones.
    - A collapsed "Hidden from matching (n)" list has Restore buttons.
    - "+ Add skill" opens a searchable picker with the option `Add "{text}" as your own skill`. After adding an off-list skill, show this note: "Jobs you already have are read for {skill} on the next Refresh."
11. **Drafting guard:**
    - A static test fails if drafting or citation modules mention `userSkills`, `user_skills`, `skillChips`, `profileSkills` or `loadSkillDictionary`.
    - A behaviour test checks that a manually added skill never appears in the draft prompt.
12. **Timing:** a test with no database runs `extractSkills` over 1,250 texts of 8 KB each with 20 custom skills, logs the time in ms, and fails over 5 s. Also add a database test of the re-read step that logs its time.
13. **Title fit** (last, approved): change only `titleTokens`. Leave `titleKey` alone, because dedup depends on it.
    - Split compounds: fullstack → full stack, frontend → front end, backend → back end.
    - Cut at ` - `, ` | `, ` — `, ` – ` or `(` when at least 2 tokens remain.
    - Treat developer and programmer as engineer.
    - Fixtures: "Fullstack Developer" vs "Full Stack Engineer" → fit. "Senior Full-Stack Engineer - Payments | Remote (PH)" → fit. "Web Developer" → partial or better, and if it doesn't get there, report the result instead of adding a synonym for "web". "Data Analyst" stays none. `titleKey` does not change.
14. **Docs:**
    - Add decision 66.
    - Amend decision 63 and the skills wording of decision 9 to point to 66.
    - Update PLAN §3.7 and the doc comment on `skillsInFacts`.

### Order
Strict patterns → additions → measured extras → dictionary and normalization → `profileSkills` → table → contract → service and route → Matches → `derive` threading (sync, add job, import) → Refresh re-read and timing → drafting guard → UI and e2e → docs → title fit.

### Verify
`bun run check`, `bun run build && bunx playwright test`, and one real Refresh: the re-read step takes under 2 s.

## Slice 16: CV preview

### Design
1. `cv_files(user_id PK FK, file_name, content_type CHECK = 'application/pdf', size CHECK 1..5242880, data bytea, created_at)`.
   - Define bytea with a Drizzle `customType`.
   - No grants to `hb_sync`. Add a part (b) case for it.
   - Only PDFs are stored.
2. The file's lifecycle is handled inside the `saveCv` transaction:
   - Uploading a PDF of 5 MB or less inserts the file, or replaces the stored one.
   - Uploading a DOCX, uploading a PDF over 5 MB, or pasting text that differs from the stored text deletes the stored file.
   - Saving the same text again keeps the file.
3. `ProfileDto.cvFile {fileName, size, uploadedAt} | null`. Never select the `data` column for the profile.
4. `GET /api/profile/cv/file` sits behind `localGuard`.
   - It refuses `Sec-Fetch-Site: cross-site` with 403.
   - It sends these headers:
     - `Content-Type: application/pdf` (a constant)
     - `Content-Disposition: inline` with an ASCII filename and `filename*`
     - `nosniff`
     - `no-store`
     - `CORP: same-origin`
     - `X-Frame-Options: SAMEORIGIN`
   - It does not send a `sandbox` CSP, because Chrome's viewer refuses to render under one.
   - It returns 404 when there is no file.
5. UI:
   - The `FileDropZone.footer` prop changes to a `ReactNode`, so the footer can read "Last read from x.pdf · View".
   - The dialog's PDF tab shows an iframe with `src` `/api/profile/cv/file?v=<uploadedAt>`. The Text tab shows a `<pre>`.
   - At 1024 px and wider, the facts sit beside the tabs. Narrower than that, they move to a Facts tab.
   - When no file is stored, there is only the Text tab, with one of these hints:
     - For a DOCX: "Word files show as the text the AI read."
     - For a PDF uploaded before this change: "This CV was read before copies were kept. Upload it again to see the PDF here."
6. Copy and docs:
   - Replace "The file itself is not kept."
   - Add decision 69. Rates (decision 67, migration 0012) and skill speed (`docs/plans/skill-speed.md`, decision 68, migrations 0013 and 0014) are built before this slice, so `cv_files` is migration 0015.
   - Update PLAN §3.3 and the line near 61.
   - Update the comment in `extract.ts`.

### Verify
- `bun run check`.
- e2e:
  - After a PDF upload, View opens a dialog with the iframe `src`, and the route returns `application/pdf`.
  - The Text tab shows a known line.
  - At 1280 px, the facts are visible beside the tabs.
  - After a DOCX upload, there is no PDF tab and the hint shows.
  - At 390 px, there is a Facts tab.
- Manual: the PDF renders in Chrome, Firefox and Safari.
