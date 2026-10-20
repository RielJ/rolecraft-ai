# Drafting guide: resume, cover letter, message, answer

Every draft prompt includes parts of this file (decision 72). It turns published advice for software engineers into rules the drafter follows within our constraints. Researched 2026-10-18; the "Sounds like a person" section on 2026-10-19.

## How this guide is used

`src/domain/prompts.ts` sends the sections named in `GUIDE_SECTIONS` to the model, word for word, with the bracketed source references removed. The other sections, this one included, are for people and are never sent.

- Every kind gets: "Facts and limits", "Tailoring to the posting", "Shared rules" and "Sounds like a person".
- Each kind also gets its own section: "Resume", "Cover letter", "Short message (job)", "Short message (contract proposal)" or "Application answer".
- A resume tailored from the candidate's own CV (decision 75) also gets "Editing a base resume".

Sent sections are written to the model, as instructions. Keep them that way: no notes about the code, no "today the prompt does X". A unit test fails when a heading the prompt needs is missing.

The marker syntax (`[FACT-n]`, `[[...]]`, `[ROLE-n]`), the Markdown subset, the banned-phrase list and the topics never to mention live in `prompts.ts` and `style.ts`, because the checks read them too.

## Facts and limits

These override any other advice in this guide.

- Use only the confirmed facts. Every number, employer, title, date, tool and link comes from a fact. Never estimate a metric. When a fact has no number, describe the scope in words ("for a financial platform").
- The posting is the only company context you have. "Specific to the company" means specific to what the posting says, not to news or a blog you can't see.
- Mention a time zone, overlap hours or remote tools only if a fact says so.
- When the posting asks for something no fact shows, leave it out. Never hint at it, and never claim it in different words.

## Tailoring to the posting

The reader decides in seconds whether the candidate has what this job requires. Write for that decision.

1. Before writing, read the posting and list what it requires: the must-haves, the main duties, the stack, and the nice-to-haves.
2. For each requirement, find the facts that prove it. The strongest proof is a fact that shows the work with a result or a scope.
3. Build the text from those facts. The most important requirement gets the first and clearest proof.
4. Leave out facts that prove nothing this posting asks for. Reworded, the whole fact list is not a tailored document. Never leave out a fact that proves a requirement or carries a measured result: cutting the strongest evidence to save space makes the document weaker, not tighter.
5. Use the posting's own words for a skill or duty where a fact backs it, once, inside a sentence. Never list the posting's keywords.

## Shared rules

- Lead with what matters most to this posting. Readers skim the first lines and decide. ([TIH][tih], [Interview Guys][ig])
- Show, don't claim. Replace adjectives such as hard-working, detail-oriented or team player with what was done. ([ResumeTrick][rt], [Job200][j200])
- No hedges: "built", not "I believe I helped build". ([Job200][j200])
- Use a verb as big as the work. Write "coordinated" for work that was coordinated, "led" only where a fact says the candidate led. ([Hireflow][hfai])

## Sounds like a person

Recruiters don't run detectors. They notice when several of these patterns show up on one page, and then they stop trusting the page. ([Hireflow][hfai], [Gem][gem], [Corporate Navigators][cn])

- **Vary the openers.** Never start most bullets or sentences the same way. Within one role, no two bullets start with the same verb. Across the whole text, use a verb at most three times.
- **Vary the length.** A big piece of work gets a sentence with its context. A small one gets a few words. Bullets that are all the same length read as generated in one pass.
- **Vary the shape.** Not every bullet needs a result clause. Never end most bullets with ", improving …", ", resulting in …" or ", enabling …".
- **No transition words** in bullets: furthermore, additionally, moreover.
- **Specific beats impressive.** A detail that only someone who did this work would know ("removed expensive UNION queries") is worth more than a general claim ("optimized performance").
- **The summary describes this candidate,** not a category of person. If the sentence could open anyone's resume with the same title, rewrite it with a fact.
- **Every skill listed should appear in the work** where a fact backs it. A list of tools with no proof reads as keyword padding.

## Resume

The resume is used as a file: the PDF is the main view. The contact header (name, email, phone, location, links) is added by the app. Never write the candidate's name or contact details in the body.

### Structure

Use these `##` sections, in this order, with these names so applicant tracking systems can parse them. Leave out a section that has no facts. ([TIH][tih], [ResumeMate][rm])

1. `## Summary`: 2 to 3 sentences, under 50 words. Start with the role noun that fits this posting and the facts, for example "Backend engineer with 7+ years …". Say why the candidate fits this posting, using its main requirements. ([TIH][tih])
2. `## Skills`: 2 to 4 lines, each `- **Category:** a, b, c`. Put the posting's stack first. Leave out categories this posting doesn't touch. Only skills that appear in facts. No soft skills. ([TIH][tih], [ResumeMate][rm])
3. `## Experience`: every role, in the order given.
4. `## Projects`: only projects that prove something this posting asks for. A bold title, then one sentence. ([TIH][tih], [LockedIn][li])
5. `## Education`: only if a fact gives it.

Leave out: an objective statement, "references available", hobbies, photos and age. ([TIH][tih], [Remoote][remoote])

### Roles

- **Keep every role**, so the work history has no gaps. ([Remoote][remoote])
- A role that matches the posting gets 3 to 5 bullets. Put the strongest proof for this posting first. Recent roles get the most room.
- A role that matches nothing gets one bullet that says what the product or company did and what the candidate built or owned there, so a reader understands the role.
- Never merge facts from different roles into one bullet.

### Bullets

- **Formula:** action verb + what + how (tool or approach) + result or scope, when a fact gives one. ([StylingCV][xyz], [TIH][tih])
- **No pronouns.** Never write "I", "my", "me", "we" or "our" anywhere in a resume. Start with the verb: "Migrated …", not "I migrated …". ([TIH][tih], [ResumeMate][rm])
- **Tense:** past tense for past roles. For the current role, present tense for ongoing work.
- One sentence, one to two lines.
- **Combine related facts** from the same role into one bullet when they describe one piece of work: an auth rewrite with its roles, sign-in providers and tests; a build fix with each of its numbers. One bullet per small fact reads like a list of tickets.
- **Verbs** to draw from, varied: built, designed, led, migrated, cut, shipped, automated, mentored, owned, rewrote, replaced, wrote, added, integrated, moved, reduced, ran, set up.
- **Weak openers to avoid:** responsible for, worked on, helped with, assisted in, involved in. ([ResumeMate][rm])

Bad: `I was responsible for improving performance and worked on backend features.`
Good: `Rewrote core database queries and removed expensive UNION queries, cutting query time by 40-66%.`

### Length

No page limit. Relevance decides what goes in: every bullet must prove something this posting asks for, or explain a role that doesn't match. Padding a resume with unrelated facts makes the relevant ones harder to find. For a senior candidate with several matching roles, that usually fills about two pages; a resume much shorter than that has most likely dropped evidence.

## Editing a base resume

The candidate's own CV is the resume. You propose edits to it; you never rewrite it. Every line you leave alone stays word for word as the candidate wrote it, so the best edit list is short.

- **Change the least that makes the posting's top requirements obvious.** Prefer reordering over rewording, and rewording over adding. A line that already fits stays as it is.
- **Reword only to use the posting's term** for something the line already proves, or to lead with the part the posting cares about. Keep every number, tool and name the line has. Never add one the line and its cited facts don't have.
- **Never upgrade ownership.** "Contributed to" never becomes "led", "helped build" never becomes "built", a team result never becomes a solo one. ([Bloom][bloom])
- **Remove only what this posting doesn't need**, such as a skills line for a stack it never mentions. Never remove a role, and never leave a role with no bullets.
- **Add only from the facts offered for adding**, under the role they belong to, when they prove a requirement better than what the CV shows.
- **Rewrite the Summary** for this posting: 2 to 3 sentences, under 50 words, from the CV's summary and the facts.
- **Give each edit the requirements it serves.** An edit that serves none is not worth the candidate's time to review.

## Cover letter

Hiring managers are split on reading letters, and a weak one can hurt. The letter must say something the resume doesn't. If deleting it would lose no information, it isn't doing its job. ([Ask a Manager][aam], [CareerKit][ck], [Interview Guys][ig], [HN][hn])

Write in first person, as the candidate. 250 to 350 words, in 3 to 4 short paragraphs:

1. **Greeting:** "Dear {name}," when the posting names a person, otherwise "Dear Hiring Manager,". Never "To Whom It May Concern". ([WhatIsACoverLetter][gr], [Ask a Manager][aam])
2. **Opening, 1 to 2 sentences:** name the role and the company. Connect the posting's most important requirement to the candidate's most relevant work. Don't open with excitement or by praising the company. ([Ryser][ryser], [CareerKit][ck])
3. **Proof, 2 to 3 sentences:** one story that answers the posting's main need: what was done, how, and the result the fact gives. Don't repeat the resume line for line. ([Ryser][ryser], [CareerKit][ck])
4. **Fit, 1 to 2 sentences:** why this role, from something specific in the posting. ([Resumize][resumize])
5. **Close, 1 to 2 sentences:** a short thanks and a direct ask for a conversation. Then "Best regards," and the full name. ([Ryser][ryser])

Openers and closers to avoid: "I am writing to express my interest", "I have long admired", "I am confident I would be a valuable asset", "I thrive in", "I look forward to the opportunity to discuss". ([Job200][j200], [Ryser][ryser])

Don't start most sentences with "I". Start some with the work, the result or the posting's need.

## Short message (job)

Pasted into a job site's message field, an email or LinkedIn. Text only, in first person.

- Under 120 words. ([getinterview][gi], [Elvatix][elv])
- **First line:** something specific to this posting, not "I am a developer with X years". The first line is what shows in previews. ([Elvatix][elv], [upworkerx][uwx])
- **Body:** 1 to 2 sentences with the most relevant result, then 1 sentence tying it to the posting's main need. ([getinterview][gi], [Algocademy][algo])
- **Ask:** one low-effort ask, such as a short call. Never two asks. ([Elvatix][elv], [getinterview][gi])
- **Sign-off:** first name only.
- Avoid "I'd be a great fit" without proof, "exciting opportunity", and anything that would read the same with another company's name. ([proposaldraft][pd], [getinterview][gi])

## Short message (contract proposal)

Pasted into a proposal box or a client email. Text only, in first person.

- 150 to 200 words, in 3 to 4 short paragraphs. ([upworkerx][uwx], [proposaldraft][pd])
- **First sentence:** the client's problem in your own words, naming their stack or goal. Never open with "Hi, I'm …". ([upworkerx][uwx], [freeltools][fl])
- **Relevance, 1 to 2 sentences:** the past work that matches most closely, with one result from the facts. ([upworkerx][uwx], [proposaldraft][pd])
- **Approach, 2 to 3 sentences:** how the candidate would start, with a concrete first step. ([freeltools][fl])
- **Ask:** one line inviting a short call. ([upworkerx][uwx])
- No price, rate or availability. ([Upwork Income Club][uic])

## Application answer

An answer to one question on the application form, in first person.

- Answer the question in the first sentence. Then give the one or two facts that back the answer.
- When the question asks about something this posting requires, use the posting's words for it.
- No greeting and no sign-off.

## Disagreements and our picks

| Topic | Views | Pick |
|---|---|---|
| Resume length at ~7 years | One page only ([TIH][tih]) vs one to two pages for senior roles ([PE][pe], [LockedIn][li]) | No page limit (decision 75). Relevance decides, and unrelated facts are left out |
| Skills before or after Experience | Before ([TIH][tih]) vs after for seniors ([LockedIn][li]) | Before, kept to 2 to 4 lines so Experience still starts high on the page |
| Estimating missing metrics | Estimate (some guides) vs never invent (others) | Never invent. Describe scope in words |
| Whether letters are read | 83–94% in vendor surveys vs 41% "never" in a LinkedIn poll and HN | Keep letters short and specific. They are optional per job already |
| Price in a proposal | Name a number ([proposaldraft][pd]) vs use the bid field ([UIC][uic]) | Never in the text |
| Cold message length | ≤150 words ([getinterview][gi]) vs 200–300 ([Algocademy][algo]) | Under 120 for job messages |
| Irrelevant roles | Drop them vs keep the timeline whole | Keep every role; one bullet that explains it (user, 2026-10-19) |

## Sources

Credibility, high to low. "Vendor" means a company that sells resume, recruiting or proposal tools, so it has a commercial interest.

- [tih]: https://www.techinterviewhandbook.org/resume/ Yangshun Tay, ex-Meta staff engineer and interviewer. Checked directly on 2026-10-18.
- [pe]: https://blog.pragmaticengineer.com/the-pragmatic-engineers-resume-template/ Gergely Orosz, author of *The Tech Resume Inside Out*.
- [aam]: https://www.askamanager.org/category/cover-letters Alison Green, a hiring practitioner with no product to sell.
- [hn]: https://news.ycombinator.com/item?id=46429025 Engineering hiring managers, first-hand. A single thread.
- [ck]: https://www.careerkit.me/blog/cover-letter-reddit An analysis of 126 top-voted Reddit comments. Vendor, but the method is stated.
- [hfai]: https://hireflow.net/blog/how-recruiters-spot-ai-resumes Reviewed by a corporate recruiter. Uniform bullets, inflated verbs, generic summaries, orphaned skills, transition words. Vendor. Read 2026-10-19.
- [gem]: https://www.gem.com/blog/detect-ai-generated-resumes One model in one session gives every bullet the same tone and structure. Recruiting-software vendor. Read 2026-10-19.
- [cn]: https://www.corporatenavigators.com/articles/hr-trends/ai-generated-resume/ Every bullet starting the same way ("Led…", "Managed…") as a generated-text tell. Recruiting firm. Search snippet, 2026-10-19.
- [remoote]: https://remoote.app/articles/123-what-location-should-you-put-on-a-remote-resume Location lines for remote resumes.
- [ig]: https://blog.theinterviewguys.com/we-analyzed-80-cover-letter-studies-from-2024-2025/ An aggregator of hiring-manager surveys. Interested in letters mattering.
- [xyz]: https://stylingcv.com/blog/xyz-resume-format-2026-the-google-formula-that-turns-job-duties-into-interview-winning-achievements/ Describes the Google XYZ formula.
- [li]: https://www.lockedinai.com/blog/best-resume-format-software-engineers-guide Vendor.
- [rm]: https://www.resumemate.io/blog/software-engineer-resume-examples-templates-ats-keywords/ Vendor.
- [rt]: https://resumetrick.com/blog/resume-cliches-and-buzzwords.html Vendor. A buzzword replacement table.
- [j200]: https://www.job200.com/blog/how-to-humanize-ai-generated-cover-letters-so-they-sound-authentic Vendor. Lists the tells of generated letters.
- [ryser]: https://ryserapp.com/blog/software-engineer-cover-letter-structure-and-example Vendor.
- [resumize]: https://resumize.ai/blog/ultimate-guide-write-cover-letter-remote-software-engineer Vendor. Remote-specific.
- [gr]: https://www.whatisacoverletter.com/blog/cover-letter-greeting-guide No named author. Agrees with the other sources.
- [gi]: https://www.getinterview.io/blog/cold-email-hiring-manager Vendor.
- [elv]: https://elvatix.com/en/blog/linkedin-inmail-examples Recruiting-tool blog.
- [algo]: https://algocademy.com/blog/tips-for-crafting-an-effective-cold-outreach-email-to-a-hiring-manager/ Career blog for engineers.
- [uwx]: https://upworkerx.com/blog/how-to-write-upwork-proposals-that-win/ Upwork tooling vendor.
- [pd]: https://proposaldraft.ai/blog/upwork-proposal-tips/ Vendor. Its pricing advice conflicts with our rules.
- [fl]: https://freeltools.com/blog/freelance-proposal-template Vendor.
- [uic]: https://www.upworkincomeclub.com/free-resources/how-to-follow-up-on-a-proposal Freelancer community resource.

[tih]: https://www.techinterviewhandbook.org/resume/
[pe]: https://blog.pragmaticengineer.com/the-pragmatic-engineers-resume-template/
[aam]: https://www.askamanager.org/category/cover-letters
[hn]: https://news.ycombinator.com/item?id=46429025
[ck]: https://www.careerkit.me/blog/cover-letter-reddit
[hfai]: https://hireflow.net/blog/how-recruiters-spot-ai-resumes
[gem]: https://www.gem.com/blog/detect-ai-generated-resumes
[cn]: https://www.corporatenavigators.com/articles/hr-trends/ai-generated-resume/
[remoote]: https://remoote.app/articles/123-what-location-should-you-put-on-a-remote-resume
[ig]: https://blog.theinterviewguys.com/we-analyzed-80-cover-letter-studies-from-2024-2025/
[xyz]: https://stylingcv.com/blog/xyz-resume-format-2026-the-google-formula-that-turns-job-duties-into-interview-winning-achievements/
[li]: https://www.lockedinai.com/blog/best-resume-format-software-engineers-guide
[rm]: https://www.resumemate.io/blog/software-engineer-resume-examples-templates-ats-keywords/
[rt]: https://resumetrick.com/blog/resume-cliches-and-buzzwords.html
[j200]: https://www.job200.com/blog/how-to-humanize-ai-generated-cover-letters-so-they-sound-authentic
[ryser]: https://ryserapp.com/blog/software-engineer-cover-letter-structure-and-example
[resumize]: https://resumize.ai/blog/ultimate-guide-write-cover-letter-remote-software-engineer
[gr]: https://www.whatisacoverletter.com/blog/cover-letter-greeting-guide
[gi]: https://www.getinterview.io/blog/cold-email-hiring-manager
[elv]: https://elvatix.com/en/blog/linkedin-inmail-examples
[algo]: https://algocademy.com/blog/tips-for-crafting-an-effective-cold-outreach-email-to-a-hiring-manager/
[uwx]: https://upworkerx.com/blog/how-to-write-upwork-proposals-that-win/
[pd]: https://proposaldraft.ai/blog/upwork-proposal-tips/
[fl]: https://freeltools.com/blog/freelance-proposal-template
[uic]: https://www.upworkincomeclub.com/free-resources/how-to-follow-up-on-a-proposal
[bloom]: https://bloomcareer.io/blog/resume-hallucination-report
