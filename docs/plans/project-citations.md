# Citing projects in drafted files (decision 82)

Drafts receive project facts as bare lines (`FACT-n: text (repo link)`). Nothing tells the drafter which project a fact belongs to, what the project is called, or whether the user owns it, so it guesses names and groupings. Roles solved the same problem with `[ROLE-n]`: the server writes the header, and checks keep each fact under its own role. This plan does the same for projects. Each slice must leave the build and all tests passing.

## Shared pieces

- **What a project is.** An add-on of kind `open_source` with at least one confirmed fact the file may use.
- **Own or contribution.** A new nullable `project_role` column on `profile_items` holds `own` or `contribution`. A read sets it from the commit share (decision 81): at least half of the commits are the user's means `own`. A pull request someone else owns is always a contribution. The add-on form lets the user switch it, and the user's choice wins over later reads. While it is null, a GitHub link owned by another account counts as a contribution and anything else as own.
- **Project keys.** Like roles, the projects a file may use are keyed `PROJECT-1`, `PROJECT-2` in add-on order, and each fact from a project is marked `(PROJECT-n)` in the prompt.
- **Citations.** Commit and file citations stay in the app (Profile, the draft's fact panel). A file gets at most the project's repo link, and only when the project is public.

## Resume layout

Own projects go under `## Projects`, contributions under `## Open Source Contributions`, which follows Projects. The drafter writes `[PROJECT-n]` alone on a line and the server replaces it with the head:

```
#### Nyx | https://github.com/rielj/nyx | Go, TypeScript
```

The name is the add-on title. The link is left out for a private project, and when any of the project's facts had its link withheld. The skills are up to 3 of the add-on's skills, left out when it has none. The PDF shows the head like a role: the name in bold, then the link without its scheme and the skills on the line below. Copy text reads it as one line: `Nyx · github.com/rielj/nyx · Go, TypeScript`. An own project then gets one line saying what it is, and at most 2 bullets, only for facts that prove a requirement of this posting. A contribution gets bullets saying what the user did.

## Slices

1. **Own or contribution.** Add `project_role`, set it on reads, add the form switch, and show a "Contribution" badge on Profile. Tests cover the read rule, the null fallback, and that a read never overwrites the user's choice.
2. **Resume project heads.** Add the PROJECTS list and the `(PROJECT-n)` marks to the resume prompt, expand `[PROJECT-n]` to the head, and add a check that a fact marked `(PROJECT-n)` sits under its own head. A failed check goes back to the drafter like a role check. A head in the wrong section is not a retry: the server moves the project, head and lines, to `## Projects` or `## Open Source Contributions`, adding that section when the draft lacks it. Done. The PDF treats a bold-only first line as an entry title even when no bullets follow, and Copy text and the clean view show the head as plain lines.
3. **Letters, proposals and answers.** These prompts get the PROJECTS list with each project's name and whether it is a contribution. Rule: name a project as listed, and for a contribution say what the user did in it ("contributed X to Viem"), never that they built or own it. A check flags a sentence that says "built", "created", "founded", "my project", "our project" or "creator of" next to a contribution's name. It runs on every sentence, cited or not, and in resumes too. The name must end the thing claimed, so "built value support in Viem" and "built Viem's docs" pass. A sentence citing a project's fact may say the project's name even when the fact does not. Done.
4. **Tailoring a base CV.** A new `project` op adds a project the CV does not have, with its head from slice 2 and lines from its facts, into the right section. The section heading is created when the CV lacks it. At most 2 per tailor. A project is in the CV when one of its facts is on a CV line, or a line outside Summary, Skills, Experience and Education says its name; only the others are offered. The op has 1 to 3 lines, each citing that project's facts only, checked like an add, and a contribution's lines may not claim it. The change keeps the head as it was when tailored. A Projects heading goes after Experience; a contributions heading goes after Projects. The review list shows the head as one line, then the lines; Undo takes the project and any heading it added out. Done.

## Later

- A GitLab deep read, which would set `project_role` for GitLab projects too.
