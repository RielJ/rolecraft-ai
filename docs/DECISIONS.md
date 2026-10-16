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
4. **Add-on links are stored only.** A link can be cited in generated text. The app never fetches it. Pre-filling from GitHub links is later work.
5. **Profile input.** A CV file (PDF or DOCX) or pasted text. Portfolio items go in as add-ons. Reading a portfolio URL is later work.

### Jobs and sources

6. **Add a job by link, with a paste fallback.** The app reads the page once. If it gets too little text, the user pastes the description. This is how jobs from LinkedIn, JobStreet, Upwork and referrals get in.
7. **Eligibility verdict.** The question is "can I be hired from the Philippines?" Verdicts: open to PH, worldwide, region (APAC or Americas), excluded, unclear. Rules come first, and an optional AI pass handles unclear jobs. The UI shows the phrase that decided the verdict. "Excluded" is hidden by default.
8. **Working hours.** When a posting states hours or an overlap requirement, the job shows it converted to Philippine time. Filtering on hours is later work.
9. **Match level.** Strong, Possible or Weak, computed by rules from confirmed facts and preferences: title fit, skills matched and missing, seniority and years, eligibility. Each job lists its reasons.
10. **Duplicates.** Jobs with the same apply URL, or the same company and normalized title within a few weeks, merge automatically. Likely duplicates get a "possible duplicate" suggestion with a one-click merge. Board status and files stay on the merged job.
11. **Sync timing.** A Refresh button only. No timers or schedules.
12. **Own sources.** Built-in boards are on or off. Users can add company boards (Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, Workable) by careers-page link. The board is checked before it is saved.
13. **Keywords.** The target titles in the profile are the default search for keyword sources. Each source can override them with its own list.
14. **Dismiss.** Dismissing hides the job and takes an optional reason (wrong stack, too senior, pay, location, other). Reasons are stored but not yet used for ranking.
15. **Old jobs.** Jobs on the board, dismissed jobs, and jobs with files are kept forever. Untouched jobs closed for 60 days or more are deleted on Refresh. A sync never changes statuses, files, answers or notes.

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
39. **Theme.** Light and dark themes from one palette, following the OS setting. The use scene is long reading at a desk, by day and by evening.
40. **Job view.** Matches is a list with a reading pane, navigated with the keyboard. The workspace (files, questions and answers, apply checklist) is a full page.
41. **Navigation.** A slim top bar: Matches, Board, Profile, Sources, with Settings and Refresh on the right.
42. **First run.** A setup checklist on the empty screens: AI key, CV, confirm facts, preferences, sources, first refresh. Steps can be done in any order. There is no wizard.

### Added while synthesizing the plan (`docs/PLAN.md`)

43. **Natural writing.** Outputs must read as if the user wrote them. The prompt carries voice rules (plain first person, no em dashes, no AI-tell phrases). A style check flags leftover tells, makes one targeted rewrite, and shows anything left as an editor warning. Warnings don't block export. `[FACT-n]` markers appear only inside the app. PDF and Copy as text never contain them.
44. **Role filter.** Every source, company boards included, sorts titles into role families. A sure out-of-family title or one with an exclude word is dropped at sync. Mixed or unknown titles are kept and tagged "Role unclear". In-family titles are kept. When in doubt, the job is kept.
45. **Sources in setup.** All five built-in sources are on by default. The first-refresh step of the setup checklist lets the user turn each one off before the first sync.
46. **Exact-match merge (narrows 10).** A job is merged automatically only when it is the same posting: the same apply URL and title, or the same company, title and description within 28 days. The same company and title alone is only a "possible duplicate" suggestion. Feeds close a job after 30 days without a sighting.
47. **Other plan defaults confirmed:** services call Drizzle directly, and the `hb_sync` Postgres role enforces the sync rule. PDFs come from headless Chromium. The AI key is stored in a 0600 file, not in Postgres. Sites that forbid automation go straight to the paste form. A deleted cited fact blocks the gate. Copy as text is gated. Applied outputs are read-only. A CV re-import is compared line by line, and the app asks before removing a fact. FX rates are typed in per currency.

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
