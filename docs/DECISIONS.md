# hanapbuhay: decisions

This file lists the product and design decisions that hold now. Each entry states the current rule, with a short reason when the reason is not obvious. The numbers are stable: code comments cite them as "decision N", so a number is never reused or renumbered. To change a decision, edit its entry so that it states the new rule. To add one, use the next free number. An entry that no longer applies names the decision that replaced it.

For how the app is built, see [ARCHITECTURE.md](ARCHITECTURE.md). For the Chrome extension, see [EXTENSION.md](EXTENSION.md). The research on job sources, privacy law and foreign clients is in [research/sources.md](research/sources.md).

## Product

hanapbuhay is a local job-search workspace for a person based in the Philippines who applies globally, mainly to Philippine and US employers and clients. It finds postings, ranks them against the user's confirmed facts, tracks applications and contracts, and drafts tailored files and answers that use only those facts.

The first user is the author. A few friends will each run their own copy.

## Decisions

### Profile and facts

1. **One confirmed fact list.** The CV, the add-ons and project reads all become facts, and the user confirms each fact before it is used. Generated text uses only confirmed facts and cites them by id.
2. **Add-ons use one form with a type tag.** The types are experience, open source, challenge and other, and the fields are title, what you did and the result, and an optional date, link and skills. The app splits each add-on into facts for the user to confirm.
3. **Add-on usage setting.** Each add-on is usable everywhere (the default) or in answers and letters only, never on the resume.
4. **Add-on links.** A GitHub link is read for facts (decision 55), and a GitLab link can fill the add-on form (decision 80). Any other link is stored only: it can be cited in generated text, and the app never fetches it.
5. **Profile input.** The profile starts from a CV file (PDF or DOCX) or pasted text. Portfolio items go in as add-ons.
49. **CV text cleanup and contact details from the CV.** In a PDF's text, rules join lines that the page wrapped and drop lone bullet glyphs, and never change, add or reorder a word. Saving a CV also reads its first eight lines for contact details and fills only the empty contact fields (the default `Philippines` counts as empty).
54. **Fact strictness stays.** Drafts use only confirmed facts, and the gate still blocks export. When drafts are thin, the fix is cheaper fact entry, not an unverified tier or an override.
62. **Facts are grouped by job.** Each fact stores a `section` (the employer, project, school or heading it sits under), kept only when the item's text contains it word for word, so a label cannot invent an employer. Profile groups confirmed facts by section, and a re-split reuses saved wording where the text still says the same thing, so confirmations survive.
69. **A PDF CV is kept so you can view it.** A PDF of 5 MB or less is stored in `cv_files`, and a DOCX, a larger PDF or changed pasted text deletes it. Profile → CV → View shows the PDF beside the text the facts came from, served by `GET /api/profile/cv/file` with headers that block cross-site use. Why: users could not check what was read against what they uploaded.
71. **Resume roles are records, and the server writes their headers.** The split reads each role (title, company, location, dates) into the `roles` table, keeping a field only when the role's own header block in the text has it. A resume draft writes `[ROLE-n]`, the server writes the header, and a sentence under a role may cite only that role's facts. Why: a header that the model types can invent or misspell a title or a date.

### Projects

55. **GitHub add-ons.** An add-on can take a GitHub repo or pull request link, and a read stays within a 12,000-token cap (decision 81). Reads use the public API by default, or with `HB_GITHUB=gh` the local `gh` CLI pinned to `HB_GITHUB_USER`, and the app never reads gh's token. Repo text goes to the AI as data, never as instructions, and a private repo or commit URL never appears in an exported file.
78. **Find my projects lists your projects, and you pick which to add.** It lists the repos `HB_GITHUB_USER` owns through gh (private ones included, never an organization's), the public repos of your GitHub profile without gh (decision 86), and the folders in `HB_PROJECTS_DIR` (decision 79). Rules, not AI, move forks, near-empty repos, repos mostly by others and clones of other people's repos (decision 85) to a "Hidden by rules" group, and each pick becomes an `open_source` add-on. Why: projects reach drafts only as add-ons, and adding each by hand meant most were never added.
79. **Find my projects also looks in a local folder.** With `HB_PROJECTS_DIR`, the dialog lists its subfolders first, and counts commits by `git config --global user.email`, `HB_GIT_EMAILS` or your GitHub noreply address as yours. A folder is hidden when it is not a git repo or when few or under half of its commits are yours. It gets a link only when its remote is your repo, and that link stays out of exports until a read shows the repo is public.
80. **One project can fill the add-on form.** "Fill from a project" takes a GitHub link, a GitLab project link, or a folder path, and fills the form without saving. GitLab is read only on gitlab.com and `HB_GITLAB_HOSTS`, so a pasted link never makes the server call a host the user did not list. A link from a private repo, or from a folder remote of unknown visibility, is saved with `githubPrivate` set and stays out of exports.
81. **Project facts come from your own changes.** For GitHub repos and local folders, a project is yours when at least half its commits are yours and a contribution otherwise, and feature facts come only from your commits either way. The light model groups your commits into up to 6 features and reads the hunks of 2 or 3 commits for each, never from secret or git-ignored files, and a private project's facts show only its name. Why: shallow add-on text said what a project is, not what the user did in it.
85. **The folder scan hides a clone of someone else's GitHub repo.** A folder whose GitHub remote another account owns is hidden as "Owned by <owner>", even when every commit is yours, and this check wins over the commit rules. Such a folder is never linked. Why: a checkout of an employer's repo looked like a personal project.
86. **Find my projects works from a public profile, counts commits, and lists contributions.** Without gh, the dialog uses `HB_GITHUB_USER` or the GitHub profile in your contact links, or asks for one, and refuses a profile that differs from either. Each repo shows your commits out of the total and is ordered by your commits, never by stars, and a Contributions group lists your merged pull requests in other people's public repos.

### Jobs and sources

6. **Add a job by link, with a paste fallback.** The app reads the page once, and if it gets too little text, the user pastes the description. Jobs from LinkedIn, JobStreet, Upwork and referrals get in this way.
7. **Eligibility verdict.** The question is "can I be hired from the Philippines?", with the verdicts open to PH, worldwide, region (APAC or Americas), excluded and unclear. Rules come first, an optional AI pass handles unclear jobs, the UI shows the phrase that decided the verdict, and excluded jobs are hidden by default.
8. **Working hours.** When a posting states hours or an overlap requirement, the job shows them in Philippine time.
9. **Match level.** Strong, Possible or Weak, computed by rules from title fit, the posting's required skills that you have and lack (decisions 66 and 76), seniority and years, and eligibility. Each job lists its reasons.
10. **Duplicates.** The same posting merges automatically (decision 46). The same company and normalized title alone gets a "possible duplicate" suggestion with a one-click merge, and board status and files stay on the merged job.
11. **Sync timing.** A Refresh button only, with no timers or schedules. The top bar shows when the last Refresh finished ("Refreshed 3 days ago"), so a stale feed is visible.
12. **Own sources.** Built-in boards are on or off. Users can add Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee and Workable boards by careers-page link, and the app checks a board before it saves it.
13. **Keywords.** The profile's target titles are the default search for keyword sources, and each source can override them.
14. **Dismiss.** Dismissing hides the job and takes an optional reason (wrong stack, too senior, pay, location, other). Reasons are stored but not used for ranking.
15. **Old jobs.** Jobs on the board, dismissed jobs and jobs with files are kept forever, and an untouched job closed for more than 60 days is deleted on Refresh. An override to Matches (decision 53) does not count as touched, and a sync never changes statuses, files, answers or notes.
44. **Role filter.** Every source sorts titles into role families, and a title that is surely out of family, or has an exclude word, is dropped at sync and stored as a slim row (decision 53). Mixed or unknown titles are kept and tagged "Role unclear": when in doubt, the job is kept.
45. **Sources in setup.** All five built-in sources are on by default, and the setup checklist lets the user turn each one off before the first sync.
46. **Exact-match merge.** A job merges automatically only with the same apply URL and title, or the same company, title and description within 28 days. A feed closes a job after 30 days without a sighting.
53. **Filtered-out postings.** Matches shows a count on its Excluded toggle, and the Board has a collapsed "Filtered out" section with excluded jobs and role drops, grouped by reason. An excluded job can be overridden to Matches in a table the sync role cannot write, so no sync undoes it, and a role drop offers Add by link.

### Matches and skills

63. **Skills lines are facts, and skill coverage orders each level.** The split keeps each skills line of a CV as one fact. Within a level, Matches sorts by search rank when searching, then by the share of the posting's required skills that your facts name (decision 76), then by how many, then newest first. Why: a CV that listed "PostgreSQL, Redis" only under Skills matched as if it did not.
64. **Matches has two layouts and three ways to act on a job.** "List" shows the list beside the job, "One at a time" shows one job with a pager, and L switches layouts. **Start application** (Enter) saves the job and opens the workspace, **Save for later** (S) saves it and moves on with Undo, and **Save and write files** (Shift+S) also starts the draft in the background.
65. **Matches filters by company and source, and can hide a company.** The filters run on the server before the 500-job cut, and the Company filter matches `companyKey`, so "Acme" and "Acme Inc." are one company. "Hide all from {company}" stores the company in `hidden_companies` until you show it again. The filters reset between visits.
66. **You can add skills to matching and hide them from it.** Matching uses the skills in confirmed facts, plus up to 100 skills you add, minus the skills you hide, stored in `user_skills`. Drafting never reads this list, so a skill you add is never claimed for you. Why: a CV with "Solidity" or "Nginx" matched as if it did not, and a skill named in an old fact could not be left out.
68. **Skill edits apply at once, and Refresh reads only what changed.** Adding or removing a skill of your own updates the stored open jobs inside `PUT /api/profile/skills`, narrowed by a substring scan, because full-text search misses words like "React/Redux". Each job stores a `skills_stamp`, and a Refresh reads again only the open jobs whose stamp is not current. `jobs` uses `fillfactor = 50`, so these updates do not rewrite the search index.
76. **Matches counts required skills and shows a percentage.** A skill named only in a posting's nice-to-have text (found by rules) goes in `jobs.nice_skills`. Only required skills decide Weak and the order within a level, and the row shows "67% required skills" from 3 skills, else a count. Why: a missing Kafka under "Nice to have" counted as much as a missing Node.js under "Requirements".

### Opportunities and board

16. **Jobs and contracts share one board.** Each opportunity is a job or a contract. A contract adds a rate, a rate type (hourly or fixed), a currency and a platform, and shows "Proposal sent" in place of "Applied".
17. **Statuses.** Saved, Applied (Proposal sent for contracts), Interviewing, Offer, and Closed with an outcome: Accepted, Rejected, No response or Withdrawn. Every change is logged with its date.
18. **Board extras.** Each opportunity has notes. An Applied opportunity with no change for 14 days shows a quiet "follow up or close?" hint.
19. **Contractor caution.** Contract opportunities show: "US clients usually need a W-8BEN; payment and tax setup come up at interview." The app tracks nothing about it.
20. **Pay.** Pay is stored as posted (min, max, currency, period) and converted to a view currency for display and filtering, with rates from decision 67. Jobs with no stated pay show "not stated" and are never filtered out.
51. **Success measure.** The app is judged on interview rate: applications that reach Interviewing over applications sent, with time from Saved to Ready as the early signal. It serves one person until it has produced interviews, so install polish waits, and backups are out of scope by choice.
52. **Metrics line.** The Board shows one quiet line for the last 30 days: applied, reached Interviewing, the rate, and the median time from Saved to Ready, all from the dated status history. That time includes idle time, so it is an upper bound.
67. **Exchange rates fill themselves.** Rates come from the ECB through Frankfurter, and from currency-api for currencies the ECB does not publish, with no AI. Each Refresh fills them when a needed currency has no rate or the last fetch is stale, **Fill rates** in Settings fetches at once, and a failed fetch keeps the old rates and never fails the Refresh. A rate the user types is never overwritten.

### Files and answers

21. **File set.** A tailored resume, a cover letter and a short message, all ticked by default and each untickable per job. The short message also covers contract proposals.
22. **Formats.** Files are edited in the app. The resume and the letter export to PDF from one template, and any file can be copied as text.
23. **Questions.** The user types questions in, and the AI suggests questions it finds in the posting. The web app never reads application forms, and the extension scans one only when the user clicks **Scan form**.
24. **Must-answer questions.** Salary, visa or work authorization, notice period, start date and references are detected and never drafted. They come from reusable answers in the profile and can be overridden per job.
25. **"Needs your input" gate.** A job cannot be marked ready, and its files cannot be exported or copied, while it has unanswered must-answer questions or blanks. The job page lists exactly what to fix.
26. **Outdated files.** Each file and answer records the facts it used and shows "outdated", with the changed facts, when any of them change. It is regenerated only when the user asks, and moving a job to Applied or later freezes its files and answers until it moves back to Saved.
27. **Never submit.** Neither the app nor the extension submits an application. The extension fills empty fields on approved sites only after the user clicks **Prefill**, and the user submits.
43. **Natural writing.** Outputs must read as if the user wrote them, so the prompt carries voice rules (plain first person, no em dashes, no AI-tell phrases). A style check flags leftover tells, makes one targeted rewrite, and shows anything left as an editor warning that does not block export.
58. **Edits clear the reviewed state.** A generated answer or file fills a form only after the user marks it reviewed (`outputs.reviewed_at`), and a redraft or any body edit clears the mark. Why: the reviewed text is the text that fills a form.
70. **Files show as files, never as fact-marked text.** Nothing the user sees as a file shows `FACT-n` keys or Markdown: a file is a card with Preview PDF, Copy text and Download PDF, and Copy and Download stay locked until no blanks remain. Why: a hiring manager cannot see the facts, so keys mean nothing outside the app.
72. **The drafting guide is part of every draft prompt.** Every draft, retry and style rewrite sends the shared sections of `src/domain/drafting-guide.md` plus the section for its kind, and a missing section throws. A resume has no pronouns, and the style check adds `pronoun`, `repeated_opener` and `same_shape` rules. Why: drafts were reworded fact lists in first person, because nothing made the code follow the guide.

### Tailoring

73. **A draft is tailored from a requirement map.** One writing-tier call lists the posting's requirements and the confirmed facts that prove each, cached until the posting or the facts change, and a requirement with no facts is a gap the draft never mentions. A resume drafted from facts keeps every fact of a role that proves something and only the context fact of a role that does not, while letters, messages and answers keep all their facts.
74. **A resume never drops its strongest evidence.** Every fact that proves a requirement, and every fact with a number, in a role that proves something, is REQUIRED, and a draft that leaves one out is retried once with the missing keys named. Why: one strong bullet often combines several atomic facts, and the map can miss one.
75. **A resume is tailored from the base CV.** When the imported CV parses into usable lines, the resume starts as that CV, and the AI may only propose bounded changes, each checked for no new tool, number or name. A line with REQUIRED facts (decision 74) cannot be removed. Why: Bloom measured unconstrained tailoring inventing about one claim in three runs, and none in 106 bullets when grounded in the source resume.
77. **A project always shows its name, link and what it is.** Tailoring may remove a project's bullets but never its last one (`only_description`). In the PDF, a project's first line is bold, its link and stack lines are muted, and a line that is only a URL becomes a link.
82. **Projects in drafted files are your own projects or contributions, each under a head the server writes.** A read sets the role from the commit share (decision 81), and the user can switch it. In a resume, the server writes each `[PROJECT-n]` head under `## Projects` or `## Open Source Contributions`, and no file says you built or own a project you contributed to. Why: a recruiter reading "built Viem" about a merged pull request stops trusting the rest.
83. **Your own project is one paragraph that names its stack.** An own project is its name and public link, then one paragraph of 2 to 4 sentences on what it is, what it does and what it is built with, and the server joins any bullets under it into that paragraph. A contribution keeps up to 3 stack skills in its head and 1 to 3 bullets about what you did.
84. **Projects earn their place, and contributions keep their status.** A resume includes your own project only when it proves a requirement no role proves, or proves the main requirement better than any role. A contribution says "merged" or "shipped" only when a fact says so, and never claims the project's stars, users or the "maintainer" title, following [research/projects.md](research/projects.md).

### Users, AI and cost

28. **Users.** The app is single-user with no login, and each person runs their own copy with their own database and AI access. Tables carry a user id so that accounts can be added later, and processing only your own data falls under the personal-use exemption in RA 10173.
29. **AI providers.** Anthropic or OpenAI with an API key pasted into Settings, or the local pi runner (decision 48), all behind one small interface.
30. **Model choice.** The light tier (fact extraction, eligibility, questions, project reads) and the writing tier (requirement map, files and answers) each have a model setting. The light default is the cheapest model that passes the evaluation set: no invented claims and no missed exclusions.
31. **Spending.** Each AI call records tokens and estimated cost, Settings shows this month's total, and an optional monthly cap asks before going over. AI runs only after a user action, except the optional eligibility pass on unclear jobs during Refresh.
32. **Retrieval.** There is no vector search. Every draft gets the whole confirmed fact list, and jobs are searched with Postgres full-text search.
48. **Local pi runner.** With `HB_AI=pi`, the server runs each AI call through the local `pi` CLI and its own sign-in, with no tools, extensions or context files, so the app's prompt is the only input. The defaults are Claude Opus 5.5 for writing and Claude Haiku 5.5 for light calls. pi is not in the Docker image, so this mode is for running on the host.

### Stack

33. **App shape.** A Vite React SPA (TanStack Router and TanStack Query) and a Hono API, served by one Bun process in production.
34. **Database access.** Drizzle, with SQL migrations generated from the TypeScript schema.
35. **Postgres.** Docker Compose runs Postgres and the app.
36. **Long tasks.** Tasks run in the same process and are recorded in a `tasks` table that the UI polls, and unfinished tasks are marked interrupted on restart and offer a retry. Every task goes through `startTask` and `getTask`, so pg-boss can replace the runner later.
37. **Tooling.** Bun, Biome, `bun test`, and Playwright for end-to-end flows.
47. **Smaller defaults.** The `hb_sync` Postgres role limits what a sync may touch, PDFs come from headless Chromium, and the AI key lives in a 0600 file, not in Postgres. A deleted cited fact blocks the gate, applied outputs are read-only, and a CV re-import is compared line by line and asks before it removes a fact.

### UI

38. **UI kit.** shadcn/ui, Tailwind and lucide icons, with screens built to the `design` skill's craft floor and components through the `shadcn` skill. The app must not look like a generic AI-built app.
39. Replaced by 50.
40. **Job view.** Matches is a list with a reading pane, driven by the keyboard (decision 64). The workspace (files, questions and answers, apply checklist) is a full page.
41. **Navigation.** A slim top bar with Matches, Board, Profile and Sources, and Settings and Refresh on the right.
42. **First run.** A setup checklist on the empty screens: AI key, CV, confirm facts, preferences, sources, first refresh. Steps can be done in any order, and there is no wizard.
50. **Dark brand look.** The app uses one warm dark palette with an orange accent and Geist, and ignores the OS light setting. Glow is kept to brand moments (primary button, top bar, setup checklist, empty states, dialogs), and the working screens stay flat for long reading.

### Chrome extension

56. **Local hardening instead of a login.** The server listens on `127.0.0.1` by default and answers 403 to an unknown `Host` header (DNS rebinding) and to an `/api` write from a foreign origin (CSRF). `/api/extension/*` needs the bearer token from pairing instead. Why: a login would only protect against other users of the same computer.
57. **Session lifetimes.** An application session from **Apply** stays pending for 15 minutes, its first claim extends it to 4 hours, and a new **Apply** expires the live one. A pairing code lasts 10 minutes and works once.
59. **`combobox` control type.** A type-ahead widget whose options appear only after typing, such as Greenhouse's react-select questions, is scanned as `combobox` and left blank with `unsupported_control`, so the review lists it under **Left blank**.
60. **Positional option tokens.** When two options of a select share a value, or radios have no `value`, the scan offers that control's options as `opt:<index>`, and fill checks the field's signature before it writes.
61. **Blocked sites.** On the hosts in `src/shared/hosts.ts`, the extension never reads, scans, fills or checks a page, and jobs from those sites get in through the paste form. Open question: should prefill be allowed there? Their terms forbid automated tools, and prefill runs on the user's click, so the user has to decide whether that counts.

## Later (not v1)

- Reading a portfolio URL.
- Filtering on working hours.
- Using dismiss reasons to tune ranking.
- Tracking active contracts: hours, invoices, payments, W-8BEN and BIR reminders.
- Vector search (pgvector).
- Scheduled syncs.
- Accounts, login, a hosted version, and RA 10173 consent work.
- A command palette.
- DOCX export.
- Reading GitLab code for project facts.
