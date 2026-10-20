# Research: which projects belong in a resume, a letter or an answer

Researched 2026-10-20. This file is for people. Nothing here is sent to the model until a rule is copied into `src/domain/drafting-guide.md`. The last section lists the rule changes this research suggests. None of them is applied yet.

Most search results on this topic are SEO pages from resume-tool vendors. They repeat one another and rarely cite anything. This file leans on the few sources with data or a named practitioner behind them. It uses vendor pages only where they agree with those sources, and it labels each source in the list at the end.

## 1. Do projects matter at all?

They matter, but they come after work history.

- **Survey of hiring teams.** HackerRank asked about 1,000 hiring managers and technical recruiters in 50 countries for the three qualifications they check before an onsite interview. They named previous work experience (77%), years of experience (45.8%) and personal projects (37.3%). Certifications and prestigious schools ranked in the bottom half. ([HackerRank 2018][hr18])
- **Recruiters reject for a missing skill.** In a 2024 study, 76 technical recruiters made about 2,200 judgments on 1,000+ real resumes. The reason they gave most often for a rejection was "missing skill". The pattern the data actually showed was "no top firm". The median time per resume was 31 seconds. ([interviewing.io 2024][iio24])
- **Engineers read projects better.** In an earlier, smaller study (152 reviewers, 716 judgments), engineers judged candidates a little better when the resume had projects and a clear description of what the person built. Recruiters did better on candidates from top companies. ([interviewing.io 2014][iio14])

**What this means.** A project earns its space when it fills a gap. Either it shows a skill the posting asks for that the roles don't show, or it is the candidate's best evidence for the posting's main need. A project that proves only what the roles already prove is padding. It also costs the reader some of their 31 seconds.

## 2. Which projects pass

One practitioner guide gives a decision test. The other sources agree with it. ([techinterview.org][tio])

Include a project when at least one of these is true:

- The work history is thin (new graduates, career switchers).
- The project shows a skill the jobs don't, and the candidate wants to be hired for that skill.
- The project has substance: adoption, technical depth, or a recognized contribution.
- The project shows taste that a reader can check: code quality, design choices, a write-up.

Leave a project out when:

- The work history already proves the same thing and the project would dilute it.
- It is shallow: a todo, weather or recipe app, or a basic CRUD demo. It will fall apart in any technical conversation.
- It came from a tutorial, a course capstone or a book's sample project.
- It is abandoned and looks abandoned: a bare README, no commits in 18 months, a last commit called "wip". Linking a repo like that is worse than not listing the project.
- The candidate can't talk about it for 10 minutes under interview pressure.

**Signals of substance**, any one of which is enough ([techinterview.org][tio]):

- **Adoption:** stars judged against the category (a niche networking tool with 800 stars beats a web template with 5,000), registry downloads (npm, PyPI, crates.io), use in production at known companies, or citations in posts, talks or papers.
- **Depth:** a compiler or interpreter, a storage or query engine with benchmarks, or a system that runs at real scale (indexes 100M items, handles a live feed).
- **Recognized contribution:** substantial merged PRs to a major project, a maintainer role, or a feature the candidate championed and shipped.
- **A write-up:** a README or post that explains the design tradeoffs, a talk, or a paper.

## 3. How many, by career stage

| Stage | Advice | Source |
|---|---|---|
| Any | At least 2 projects, each linked to GitHub or a page where it can be seen | [TIH][tih] |
| New grad, career switcher | A Projects section after Experience: 2 to 3 projects with 2 to 3 bullets each | [techinterview.org][tio] |
| Mid-level | 1 to 2 projects, one line each, with one signal of substance | [techinterview.org][tio] |
| Senior and above | Usually no Projects section. At most one line for something truly notable ("Maintainer, foo-cli, 12k stars, used in production at …") | [techinterview.org][tio] |

The two sources disagree for experienced candidates. TIH's template always has projects. techinterview.org says recruiters don't expect seniors to list hobby projects, and that the work history should carry the resume. The approach that fits both: a senior includes a project only when it passes the test in section 2, which in practice usually means it shows a skill the roles don't.

School projects drop off after 1 to 2 years of work, unless they led to a publication or to notable open source. A school project that stays is described honestly: "Senior capstone, 4-person team, 8 months". ([techinterview.org][tio])

## 4. Contributions to other people's projects

- **The substance test still applies.** A big repo plus a small contribution is still small. Typo fixes aren't worth listing, even when they went into a famous project. ([techinterview.org][tio])
- **Say what the candidate did, and its status.** "Submitted a fix", "merged a documentation update" and "maintained a module" are different levels of involvement. A PR that was never merged is "proposed", never "shipped". ([CreateResume][cr])
- **Don't borrow the project's results.** The project's stars, downloads or speedups were not caused by one small change. One PR doesn't make someone a maintainer. ([CreateResume][cr])
- **Link the evidence for the exact claim.** Link the merged PR or release note, not the profile. A bare "GitHub: github.com/jdoe" is dead weight, because reviewers don't reliably follow links in a PDF. ([CreateResume][cr], [techinterview.org][tio])
- **Sustained work is different.** "Top-20 contributor" or a maintainer role carries a strong signal. Open source done as part of a job goes under that job, not under projects. Never list the same work twice. ([techinterview.org][tio])

## 5. Kinds of work, and where each one goes

| Kind | Where it goes | Notes |
|---|---|---|
| Own side project | Projects | Only if it passes section 2 |
| Contribution to someone else's project | Open Source Contributions | Section 4 |
| Work done for an employer (internal tool, migration) | Under that role | Never presented as a side project ([techinterview.org][tio]) |
| Employer hackathon | Under that role, framed as "internal hackathon, [Company]" | Only if it won or reached production ([techinterview.org][tio]) |
| Freelance or client work | Experience, as a role | Under an NDA, replace the client's name with its sector and scale ("a US fintech client"), keep the stack and the scope, and leave out absolute numbers that identify the client ([Resume Worded][rw]) |
| Own startup or a product with users | Experience, as a role | Vendor guides agree; no stronger source found |
| Hackathon or contest win | Awards: placement, event, year | "Participated in" is not a signal. Drops off at mid-level unless the win was major ([techinterview.org][tio], [TIH][tih]) |
| School project | Projects, for new graduates only | Section 3 |
| Talk, post, paper | Can be the substance signal of a project | Section 2 |

## 6. Projects built with AI help

No source with data was found. Every page on this is a vendor blog. They agree on one point, and that point matches the "10 minutes under pressure" test in section 2: interviewers now ask candidates to explain design choices, problems they hit and what they would change. A project the candidate can't defend hurts the application.

For hanapbuhay, the safe signal is authorship, which the scan already measures: the candidate's share of commits and of changed lines. The question for a hiring manager is "can you explain it", not "did a tool help". So the share of the work is the right thing to show the user. Whether AI wrote the code is not.

## 7. Before linking a repo

Reviewers who do click a link want ([techinterview.org][tio]):

- a README that says what the project is and why it exists;
- a demo or screenshots, if the project is user-facing;
- recent commits, if the project is meant to be alive;
- the stack.

A messy repo costs more than the link is worth, so polish the repo first or don't link it.

## 8. Cover letters

The drafting guide already requires the letter to say something the resume doesn't, using one proof story. A project fits the letter in two cases:

1. It is the best proof of the posting's main need, and the resume gives it only a line.
2. It shows real interest in the company's domain or stack, for example a tool built on the company's API or in its problem space. This is the only honest way to show interest without praising the company.

Use one project at most, with a result or a scope from the facts. A project in the letter must match the resume's name and link. ([CreateResume][crl] says the same: the letter and the resume should name the same projects and tools.) No source with data backs these rules. They follow from the guide's existing letter rules.

## 9. Application answers

Common questions: "Tell us about a project you're proud of", "the most technically challenging thing you've built", "a link to something you've built".

- **Pick one project and match it to the role.** The choice itself is part of the answer. Interviewers listen for credibility (did the candidate build it?), ownership (driver or passenger?) and judgment (does the impact matter?). ([datarekha][dr])
- **Lead with the result,** then the specific actions and tradeoffs ("chose X over Y because Z"), one honest problem the candidate hit, and a number. Stories where nothing went wrong sound made up. ([datarekha][dr])
- **Pick a project the candidate can defend from every angle.** The answer is the warm-up for the follow-up questions. ([datarekha][dr], [techinterview.org][tio])
- **For a "link to something you built" field,** give the most relevant repo, PR or demo, not the profile page.

Work done for an employer often makes the best answer to "a project you're proud of". Describe it under the NDA rules in section 5.

## 10. Ownership and confidentiality

This is not legal advice. Contracts vary, and a signed agreement can change the defaults below.

- **Never publish employer code or internal material** to build a portfolio piece. ([CreateResume][cr])
- **Philippines:** under the Intellectual Property Code (RA 8293, s. 178.3), a work created as part of the employee's regularly assigned duties belongs to the employer unless they agree otherwise. A work outside those duties belongs to the employee, even if it used the employer's time, facilities or materials. ([RA 8293 s. 178.3][ra8293])
- **California employers:** Labor Code s. 2870 limits invention assignment clauses. They can't take an invention made entirely on the employee's own time, without the employer's equipment or trade secrets, unless it relates to the employer's business or came from work for the employer. ([Cal. Labor Code 2870][ca2870])
- **Practical rule:** a side project in the employer's line of business is the risky case. Check the employment contract before listing it or making it public.

## What this suggests for hanapbuhay

**Picked by the user on 2026-10-20:** all seven, with these choices:

- Rule 1 as written: a project must add something the roles don't prove.
- Rule 2 with all four parts: the PR's status, no borrowed results, no "maintainer" without a fact, and the PR's link rather than the profile's.
- Rule 3 in the set order. Rule 4 with at most one project, for one of the two reasons.
- Item 5: show stale repos with a warning. Don't hide them.
- Item 6: show stars, but don't sort by them.
- Item 7: check a PR's size only after the user picks it. A tiny one gets a note. The scan makes no extra calls.
- Also: the folder scan moves a folder whose remote is owned by someone else to the hidden group, with the reason "Owned by <org>".
- Build order: the guide rules first, then the folder scan, then the GitHub profile scan.

The proposals as first written:

1. **Resume, Projects: a project must add something.** Include a project only when it proves a requirement the roles don't prove, or proves the main requirement better than they do. When the roles already cover everything a project proves, leave it out. (Sections 1 to 3. Today the rule is "own projects that prove something this posting asks for", which lets a senior's resume repeat what the roles say.)
2. **Resume, Open Source: say the status.** Use "proposed" for a PR that was never merged. Never give the project's stars, downloads or results as the candidate's. Never write "maintainer" unless a fact says so. (Section 4. The existing contribution check covers "built, created or owns" but not borrowed results.)
3. **Application answer: a project question gets one project.** Lead with the result, give the choices made and one problem, and end with the scope or number from the facts. (Section 9.)
4. **Cover letter: a project only as the proof story or as domain interest.** At most one, using the same name as the resume. (Section 8.)

Changes to the GitHub profile scan plan (`docs/plans/github-profile-scan.md`):

5. **Flag repos that would hurt when linked:** no README, archived, or no push in 18 months. Show them, but say why before the user picks one. The repo listing already returns `archived`, `pushed_at` and the description, at no extra cost. Checking for a README takes one more call per repo, so it can wait until the repo is read. (Sections 2 and 7.)
6. **Show stars in each row, but don't sort by them.** Stars mean something only next to similar projects, so a ranking by stars would mislead. The planned sort (by the candidate's commits, then size) stays. Adding stars next to the commit share and the last push gives the user the adoption signal. (Section 2.)
7. **Merged PRs: hide tiny ones.** A one-line or docs-typo PR is not worth listing. The search results don't include a PR's changed lines. Getting them takes one call per PR, which counts against the same rate limit as the commit counts. So the plan can hide PRs under a size threshold only for repos the user picks, or only when gh is set up. (Section 4.)

## Sources

Credibility, high to low.

- [iio24]: https://interviewing.io/blog/are-recruiters-better-than-a-coin-flip-at-judging-resumes interviewing.io with the Learning Collider research lab, 2024. 76 recruiters, about 2,200 judgments, compared against mock-interview outcomes. The company sells interview practice, so it has an interest in resumes looking weak, but the method is published. Read 2026-10-20.
- [iio14]: https://interviewing.io/blog/resumes-suck-heres-the-data Aline Lerner, 2014. 152 reviewers, 716 judgments. Small, and the ground truth was her own placement record. Read 2026-10-20.
- [hr18]: https://www.hackerrank.com/blog/top-10-learnings-from-the-2018-tech-recruiting-report/ HackerRank survey of about 1,000 hiring managers and recruiters. Skills-test vendor. Old, but the only survey found that ranks projects against other qualifications. Read 2026-10-20.
- [tih]: https://www.techinterviewhandbook.org/resume/ Yangshun Tay, ex-Meta staff engineer and interviewer. The projects section was checked directly on 2026-10-20.
- [tio]: https://www.techinterview.org/post/3233474610/side-projects-open-source-engineering-resume/ An interview-prep site with no named author. It is the most complete decision framework found, and the other sources agree with it. Read in full on 2026-10-20.
- [ra8293]: https://source.gosupra.com/widget/provision/9509 Text of RA 8293 s. 178.3, also summarized by [NDV Law](https://ndvlaw.com/who-owns-the-copyright-if-an-employee-creates-a-work/). Search snippets, 2026-10-20.
- [ca2870]: https://california.public.law/codes/labor_code_section_2870 Statute text. Search snippet, 2026-10-20.
- [cr]: https://createresume.io/blog/open-source-contributions-on-resume/ Resume-builder vendor, 2026-10-06. It is careful about honesty and status, and it agrees with [tio]. Read 2026-10-20.
- [crl]: https://createresume.io/blog/software-engineer-cover-letter/ Same vendor. Search snippet only.
- [rw]: https://resumeworded.com/blog/resume-nda/ Resume Worded, a vendor. Practical NDA rules. Read 2026-10-20.
- [dr]: https://datarekha.com/interview/case-study/tell-me-about-a-project/ An interview-prep site with no named author. Low credibility. Used only where it matches [tio]. Read 2026-10-20.

Considered and not used: pages about "vibe coding" portfolios (all vendors, no data), the claim "71% of hiring managers check GitHub" (no source traced), the claim that tailored resumes get "a 115% higher interview rate" (it traces to one vendor's application data, and its method is unpublished), and an anecdote about a $42,000 non-compete lawsuit (no source).

[iio24]: https://interviewing.io/blog/are-recruiters-better-than-a-coin-flip-at-judging-resumes
[iio14]: https://interviewing.io/blog/resumes-suck-heres-the-data
[hr18]: https://www.hackerrank.com/blog/top-10-learnings-from-the-2018-tech-recruiting-report/
[tih]: https://www.techinterviewhandbook.org/resume/
[tio]: https://www.techinterview.org/post/3233474610/side-projects-open-source-engineering-resume/
[ra8293]: https://source.gosupra.com/widget/provision/9509
[ca2870]: https://california.public.law/codes/labor_code_section_2870
[cr]: https://createresume.io/blog/open-source-contributions-on-resume/
[crl]: https://createresume.io/blog/software-engineer-cover-letter/
[rw]: https://resumeworded.com/blog/resume-nda/
[dr]: https://datarekha.com/interview/case-study/tell-me-about-a-project/
