# hanapbuhay: decisions and research

This file records every decision made during initial planning, and the research behind them. `PLAN.md` builds on it. Change a decision here first, then update the plan.

## Product

hanapbuhay is a local job-search workspace for a person based in the Philippines who applies globally, mainly to Philippine and US employers and clients. It finds postings, ranks them against the user's confirmed facts, tracks applications and contracts, and drafts tailored files and answers that use only those facts.

The first user is the author. A few friends will each run their own copy.

## Decisions

### Profile and facts

1. **One confirmed fact list.** The CV and the add-ons are both turned into facts. The user confirms each fact before it is used. Generated text may only use confirmed facts and cites them by id.
2. **Add-ons use one form with a type tag.** Types: experience, open source, challenge, other. Fields: title, what you did and the result, and optional date, link and skills. The app splits each add-on into facts for the user to confirm.
3. **Add-on usage setting.** Each add-on is usable either everywhere (the default) or in answers and letters only, never on the resume.
4. **Add-on links.** Replaced by 55 for GitHub links. Other links are stored only: they can be cited in generated text, and the app never fetches them.
5. **Profile input.** A CV file (PDF or DOCX) or pasted text. Portfolio items go in as add-ons. Reading a portfolio URL is later work.

### Jobs and sources

6. **Add a job by link, with a paste fallback.** The app reads the page once. If it gets too little text, the user pastes the description. This is how jobs from LinkedIn, JobStreet, Upwork and referrals get in.
7. **Eligibility verdict.** The question is "can I be hired from the Philippines?" Verdicts: open to PH, worldwide, region (APAC or Americas), excluded, unclear. Rules come first, and an optional AI pass handles unclear jobs. The UI shows the phrase that decided the verdict. "Excluded" is hidden by default.
8. **Working hours.** When a posting states hours or an overlap requirement, the job shows it converted to Philippine time. Filtering on hours is later work.
9. **Match level.** Strong, Possible or Weak, computed by rules from confirmed facts and preferences: title fit, skills matched and missing, seniority and years, eligibility. Each job lists its reasons.
10. **Duplicates.** Jobs with the same apply URL, or the same company and normalized title within a few weeks, merge automatically. Likely duplicates get a "possible duplicate" suggestion with a one-click merge. Board status and files stay on the merged job.
11. **Sync timing.** A Refresh button only. No timers or schedules. The top bar shows when the last Refresh finished ("Refreshed 3 days ago"), so a stale feed is visible (51).
12. **Own sources.** Built-in boards are on or off. Users can add company boards (Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, Workable) by careers-page link. The board is checked before it is saved.
13. **Keywords.** The target titles in the profile are the default search for keyword sources. Each source can override them with its own list.
14. **Dismiss.** Dismissing hides the job and takes an optional reason (wrong stack, too senior, pay, location, other). Reasons are stored but not yet used for ranking.
15. **Old jobs.** Jobs on the board, dismissed jobs, and jobs with files are kept forever. Untouched jobs closed for 60 days or more are deleted on Refresh. Excluded jobs follow the same rule; an override to Matches (53) does not count as touched. A sync never changes statuses, files, answers or notes.

### Opportunities and board

16. **Jobs and contracts share one board.** Each opportunity has a type: job or contract. Contracts add a rate, a rate type (hourly or fixed), a currency and a platform, and use "Proposal sent" in place of "Applied". Tracking active contracts (hours, invoices) is later work.
17. **Statuses.** Saved, Applied (shown as Proposal sent for contracts), Interviewing, Offer, and Closed with an outcome: Accepted, Rejected, No response, Withdrawn. Every change is logged with its date.
18. **Board extras.** Each opportunity has notes. An Applied opportunity with no change for 14 days shows a quiet "follow up or close?" hint.
19. **Contractor caution.** Contract opportunities show a short caution: "US clients usually need a W-8BEN; payment and tax setup come up at interview." The app tracks nothing about it.
20. **Pay.** Pay is stored as posted: min, max, currency and period. For display and filtering it is converted to a view currency using a rate the user sets. There is no live FX feed. Jobs with no pay stated show "not stated" and are never filtered out.

### Files and answers

21. **File set.** Tailored resume, cover letter, and short message. All three are ticked by default and the user can untick any per job. The short message also covers contract proposals.
22. **Formats.** Files are edited in the app. The resume and letter export to PDF from one template. Any file can be copied as text.
23. **Questions.** The user types questions in. The AI suggests questions it finds in the posting's text. The app never reads application forms.
24. **Must-answer questions.** Salary, visa or work authorization, notice period, start date and references are detected and never drafted. They are filled from reusable answers in the profile and can be overridden per job.
25. **"Needs your input" gate.** A job cannot be marked ready, and final files cannot be exported, while it still has unanswered must-answer questions or placeholders. The job page lists exactly what to fix.
26. **Outdated files.** Each file and answer records the facts it used. When any of those facts change, it shows "outdated" with the changed facts listed. It is regenerated only when the user asks. Jobs marked applied stay frozen.
27. **Never submit.** The app never submits applications or fills forms on other sites. This is a stated non-goal.

### Users, AI and cost

28. **Users.** v1 is single-user and has no login. Each person runs their own copy with their own database and their own AI key. Tables carry a user id so that accounts can be added later. Running only your own data falls under the personal-use exemption in RA 10173.
29. **AI providers.** Anthropic or OpenAI, using an API key the user pastes into settings, behind one small interface.
30. **Model choice.** AI work is split into two tiers. The light tier covers fact extraction, eligibility checks and finding questions in postings. The writing tier covers the resume, letter, message and answers. Each tier has its own model setting. The default is the cheapest model that passes a small evaluation set: no invented claims and no missed exclusions.
31. **Spending.** Each AI call records tokens and estimated cost. Settings shows this month's total, and an optional monthly cap asks for confirmation before going over it. AI runs only when the user clicks, except the optional eligibility pass on unclear jobs during Refresh.
32. **Retrieval.** No vector search in v1. Every draft gets the whole confirmed fact list. Jobs are searched with Postgres full-text search. pgvector can be added later if the fact list outgrows one request.

### Stack

33. **App shape.** A Vite React SPA (TanStack Router and TanStack Query) and a Hono API. In production one Bun process serves both.
34. **Database access.** Drizzle, with SQL migrations generated from the TypeScript schema.
35. **Postgres.** Docker Compose runs Postgres and the app for everyone.
36. **Long tasks.** Tasks run in the same process and are recorded in a `tasks` table (kind, status, current step, error), which the UI polls. On restart, unfinished tasks are marked interrupted and offer a retry. Every task goes through one `startTask`/`getTask` module, so pg-boss can replace it later.
37. **Tooling.** Bun, Biome, `bun test`, and Playwright for a few end-to-end flows.

### UI

38. **UI kit.** shadcn/ui, Tailwind and lucide icons. Every screen is built with the `design-engineering` skill, following its craft floor and refusing the generic template patterns it lists. Components use the `shadcn` skill. The goal is that it does not look like a generic AI-built app.
39. **Theme.** Replaced by 50.
40. **Job view.** Matches is a list with a reading pane, navigated with the keyboard. The workspace (files, questions and answers, apply checklist) is a full page.
41. **Navigation.** A slim top bar: Matches, Board, Profile, Sources, with Settings and Refresh on the right.
42. **First run.** A setup checklist on the empty screens: AI key, CV, confirm facts, preferences, sources, first refresh. Steps can be done in any order. There is no wizard.

### Added while synthesizing the plan (`docs/PLAN.md`)

43. **Natural writing.** Outputs must read as if the user wrote them. The prompt carries voice rules (plain first person, no em dashes, no AI-tell phrases). A style check flags leftover tells, makes one targeted rewrite, and shows anything left as an editor warning. Warnings don't block export. `[FACT-n]` markers appear only inside the app. PDF and Copy as text never contain them.
44. **Role filter.** Every source, company boards included, sorts titles into role families. A sure out-of-family title or one with an exclude word is dropped at sync. Mixed or unknown titles are kept and tagged "Role unclear". In-family titles are kept. When in doubt, the job is kept. Dropped titles are stored as slim rows and shown on the Board (53).
45. **Sources in setup.** All five built-in sources are on by default. The first-refresh step of the setup checklist lets the user turn each one off before the first sync.
46. **Exact-match merge (narrows 10).** A job is merged automatically only when it is the same posting: the same apply URL and title, or the same company, title and description within 28 days. The same company and title alone is only a "possible duplicate" suggestion. Feeds close a job after 30 days without a sighting.
47. **Other plan defaults confirmed:** services call Drizzle directly, and the `hb_sync` Postgres role enforces the sync rule. PDFs come from headless Chromium. The AI key is stored in a 0600 file, not in Postgres. Sites that forbid automation go straight to the paste form. A deleted cited fact blocks the gate. Copy as text is gated. Applied outputs are read-only. A CV re-import is compared line by line, and the app asks before removing a fact. FX rates are typed in per currency.
48. **Local pi runner (extends 29).** The API key in Settings stays the default. A local copy can set `HB_AI=pi` instead: the server then runs each AI call through the `pi` CLI on the same machine, using pi's own sign-in, so no key is pasted or stored. pi runs with no tools, extensions, skills, context files or prompt templates, and with the app's own system prompt. That keeps the app's prompt as the only input and cut the overhead from about 6,800 to 68 tokens per call when measured. The writing tier defaults to Claude Opus 5.5 and the light tier to Claude Haiku 5.5. Thinking is off for light calls and low for writing. Each call records the tokens and cost that pi reports, so spending and the cap still work. On a pi subscription that cost is a list-price estimate, not a bill. pi is not in the Docker image, so `HB_AI=pi` is for running the app directly on your own machine.
49. **CV text cleanup and contact from the CV (extends 9 and the Profile in section 4).** A PDF's text keeps the page's line breaks, so the reader joins lines the page wrapped and drops bullet glyphs that sit on a line of their own. It never changes, adds or reorders a word. Pasted and DOCX text is left as is. Saving a CV also reads its first eight lines for a name, email, phone, location and links, and fills only the contact fields that are empty. A field the user filled is never overwritten; the default `Philippines` counts as empty and is kept after a city. Both steps are rules, not AI, so they cost nothing and every value they produce is text from the CV.
50. **Dark brand look (replaces 39).** One warm dark palette with an orange accent; the app no longer follows the OS light setting. Geist is the UI and heading face, with large light page headings, and the reading surfaces keep the serif. Glow and glossy surfaces are kept to brand moments: the primary button, the top bar, the setup checklist, empty states and dialogs. The working screens (the Matches list, the reading pane, the board and the workspace editor) stay flat, so long reading is not competing with light. A disabled primary drops its glow and goes flat grey, because a dimmed glow reads as brown, not as "not yet". The craft spec's axe contrast check guards the palette.
51. **Success measure.** The app is judged on interview rate: applications that reach Interviewing over applications sent. Time from Saved to Ready is the early signal. The baseline is rebuilt by hand from the two months before real use. The app is for one person until it has produced interviews; install polish and friend onboarding wait until then. Day to day it runs on the host with `HB_AI=pi` and Postgres in Docker. Backups are out of scope by choice: losing the volume means re-importing the CV.
52. **Metrics line.** One quiet line on the Board for the last 30 days: applied, reached Interviewing, the rate, and the median Saved to Ready time. Saved to Ready includes idle time, so it is an upper bound. The numbers come from the dated status history; no new table.
53. **Filtered-out postings.** Matches shows a count on its Excluded toggle. The Board has a collapsed "Filtered out" section with two kinds of item. Excluded jobs are real jobs whose eligibility rule said no. Role drops are slim rows (title, company, link, source, the word that dropped them), replaced for a source on each of its runs, so they stay bounded by feed size. Items are grouped by reason; each group shows its newest 50, and a search box finds the rest. An excluded job can be overridden to Matches; the override lives in a user-owned table the sync role cannot write, so no sync undoes it. A role drop offers Add by link with its URL filled in.
54. **Fact strictness stays.** Drafts use only confirmed facts and the gate still blocks export. When drafts are thin, the fix is cheaper fact entry (55), not an unverified tier or an override.
55. **GitHub add-ons (replaces 4 for GitHub).** An add-on can take a GitHub repo link (a side project) or a pull request link (a contribution). The app reads, within a hard token cap: the README, the manifest, the file tree, up to five files the light-tier AI picks from the tree, and the user's last 50 commits on the repo. Reads use the public API by default. With `HB_GITHUB=gh` they go through the local `gh` CLI, pinned to `HB_GITHUB_USER`; a call is refused when gh's active account differs, so a work account never leaks in. The app never reads gh's token, and Docker stays public-only. Repo text is passed to the AI as data, never as instructions. Each proposed fact links the file or commit it came from, and the user confirms each one as with CV facts. Facts from private repos carry a lock badge; their text may be drafted from, but a private repo or commit URL never appears in an exported file. A manual Re-read compares new proposals with the current facts like CV re-import (47). Three recorded fixture repos join the evaluation set, one with a README that tries prompt injection; the pass mark is zero invented claims and zero injected facts.

## Later (not v1)

- Fetching add-on links (GitHub PRs and repos) to pre-fill the form.
- Reading a portfolio URL.
- Filtering on working hours.
- Using dismiss reasons to tune ranking.
- Tracking active contracts: hours, invoices, payments, W-8BEN and BIR reminders.
- Vector search (pgvector) for facts or jobs.
- Scheduled syncs, which may bring in pg-boss.
- Accounts and login, a hosted version, and privacy-notice and consent work under RA 10173.
- A command palette.
- DOCX export.
- Reading application forms on ATS sites.

## Research findings

### Sources that allow automated reading

| Source | Access | Notes |
|---|---|---|
| Jobicy | Free JSON API, no key | Geo filters. Keep the Jobicy listing URL. |
| Himalayas | Free JSON API and RSS | Optional free key for higher limits. |
| RemoteOK | Free JSON API | Attribution and a link back are required. |
| We Work Remotely | RSS and JSON API with published terms | Attribution required. Applicants apply on WWR. Do not build a competing board. |
| Remotive | Free JSON API | Attribution required. At most 2 requests a minute and about 4 a day. Listings are delayed 24 hours. |
| Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, Workable | Public, unauthenticated job board APIs | Ashby has the best structured remote and location fields. Lever has `workplaceType`. Greenhouse location is free text. |

### Sources that forbid automated access

LinkedIn, Indeed (partner API only), JobStreet, Kalibrr, OnlineJobs.ph, Upwork (partner API only), Glassdoor (API retired), Wellfound and Toptal. Jobs from these come in through "add a job by link".

JobStreet's terms (updated 20 July 2026) were checked directly. §9(b) bans "any automated process, script, tool, bot, scraper" except through an API that SEEK provides, and §9(d) allows suspension of accounts that do this.

### Other findings

- **RA 10173 §3(h):** a person processing personal information for personal, family or household affairs is not a personal information controller. A shared multi-user copy would lose this exemption.
- **AI data use:** neither OpenAI nor Anthropic trains on API data by default. Anthropic's docs say conversation content is not retained by default, with 30-day retention for some covered models. The "7 days" figure from the research could not be confirmed.
- **Working for US clients:** contractor or employer-of-record (Deel, Remote.com, Oyster). A W-8BEN avoids the 30% withholding. Common payment rails are Wise, Payoneer and PayPal. BIR registration and the 8% income tax option apply on the Philippine side.
- **Stack:** Postgres.app bundles pgvector (checked directly). The TanStack blog shows the Start v1 release candidate from September 2025. The stable date comes only from a third-party post.

### Sources

1. https://ph.jobstreet.com/terms/en
2. https://www.linkedin.com/legal/l/service-terms
3. https://docs.indeed.com/legal-terms/additional-api-terms-and-guidelines
4. https://jobicy.com/jobs-rss-feed
5. https://remoteok.com/api
6. https://weworkremotely.com/api-terms-and-guidelines
7. https://github.com/remotive-com/remote-jobs-api
8. https://conorscode.github.io/ats-api-reference/
9. https://developers.ashbyhq.com/changelog/2026-02-19-job-postings-api-workplace-type
10. https://lawphil.net/statutes/repacts/ra2012/ra_10173_2012.html
11. https://developers.openai.com/api/docs/guides/your-data
12. https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
13. https://www.respicio.ph/commentaries/bir-registration-for-self-employed-professionals-under-the-8-income-tax-rate
14. https://www.globalsolo.global/blog/deel-vs-oyster-vs-remote-eor-comparison-2026
15. https://postgresapp.com/extensions/
16. https://tanstack.com/blog/announcing-tanstack-start-v1
17. https://orm.drizzle.team/docs/guides/vector-similarity-search
18. https://usajobshelp.opm.gov/hc/en-us/articles/52944257563027-Employment-of-non-citizens
