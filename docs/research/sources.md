# Research: job sources, privacy law, and working for foreign clients

This research was done during initial planning. The source, privacy, and contractor decisions in [DECISIONS.md](../DECISIONS.md) rest on it. The numbers in brackets point to the source list at the end.

## Sources that allow automated reading

| Source | Access | Notes |
|---|---|---|
| Jobicy | Free JSON API, no key | Geo filters. Keep the Jobicy listing URL. [4] |
| Himalayas | Free JSON API and RSS | An optional free key raises the limits. |
| RemoteOK | Free JSON API | Attribution and a link back are required. [5] |
| We Work Remotely | RSS and JSON API with published terms | Attribution is required. Applicants apply on WWR. Do not build a competing board. [6] |
| Remotive | Free JSON API | Attribution is required. At most 2 requests a minute and about 4 a day. Listings are delayed 24 hours. [7] |
| Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, Workable | Public, unauthenticated job board APIs | Ashby has the best structured remote and location fields. Lever has `workplaceType`. Greenhouse location is free text. [8] [9] |

## Sources that forbid automated access

LinkedIn [2], Indeed (partner API only) [3], JobStreet [1], Kalibrr, OnlineJobs.ph, Upwork (partner API only), Glassdoor (API retired), Wellfound, and Toptal. Jobs from these sites come in through "add a job by link" or the paste form.

JobStreet's terms (updated 20 July 2026) were checked directly. §9(b) bans "any automated process, script, tool, bot, scraper" except through an API that SEEK provides. §9(d) allows SEEK to suspend accounts that do this.

## Other findings

- **Privacy law.** RA 10173 §3(h) says a person who processes personal information for personal, family, or household affairs is not a personal information controller [10]. A shared copy with several users would lose this exemption.
- **AI data use.** Neither OpenAI nor Anthropic trains on API data by default [11] [12]. Anthropic's docs say conversation content is not retained by default, with 30-day retention for some covered models. The "7 days" figure from earlier research could not be confirmed.
- **Working for US clients.** The two common setups are a direct contractor arrangement or an employer of record such as Deel, Remote.com, or Oyster [14]. A W-8BEN avoids the 30% US withholding. The common payment rails are Wise, Payoneer, and PayPal. On the Philippine side, BIR registration and the 8% income tax option apply [13]. USAJOBS help on federal employment of non-citizens is [18].
- **Stack.** Postgres.app bundles pgvector, checked directly [15]. Drizzle's guide to vector similarity search is [17]. The TanStack blog shows the Start v1 release candidate from September 2025 [16]. The stable release date comes only from a third-party post.

## Sources

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
