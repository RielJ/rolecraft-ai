# Roles: employer, title, location and dates on every resume role

Status: agreed with the user on 2026-10-19. Not built. This is the first part of slice B in `docs/plans/clean-files.md`. Decision 71.

## Problem

A drafted resume lists every bullet under one Experience heading, with a blank where the role headers should be. The user's CV has a header for each role:

```
Full-stack Software Engineer          January 2026 – June 2026
CASHFLOWY, REMOTE
```

Splitting the CV into facts throws the header away. The split prompt asks for "just the company name" as each fact's `section`, so all four Cashflowy facts carry only `CASHFLOWY`. The title, location and dates exist only in the stored CV text. `docs/drafting-guide.md` assumed `section` held all of them; it does not.

## Agreed

- **Roles are their own records.** A role is a title, a company, a location, a start and an end, read from the CV (or an experience add-on). Facts keep `section` as today.
- **Roles are editable on Profile.** The user can fix any field, add a missing role or remove one. Drafts use what is saved.
- **Every field comes from one header in the source text.** When roles are read, the title and company must each start a part of a line in the same header block (up to four lines with no bullet text or section heading). Location and dates are kept only from that block. Case and whitespace are ignored. A role whose title and company are not found together is dropped.
- **Headers are not facts.** The split prompt skips job header lines. Any split candidate made only of one role's fields and separators is still dropped before the evidence check, using the roles just read or, when that read fails, the item's saved roles.
- **The model never writes a header.** It writes `[ROLE-n]` on its own line; the server replaces it with the header built from the saved role. A title or date cannot be invented or misspelled.

## Data (migration 0016)

- New table `roles`:
  - `id` uuid primary key
  - `user_id` foreign key to `users`, cascade
  - `item_id` foreign key to `profile_items`, cascade
  - `position` integer: the order the source lists them, most recent first
  - `title` text, not empty
  - `company` text, not empty
  - `location` text, null when the source gives none
  - `start_text` text, null when unknown
  - `end_text` text, null when unknown

  Dates stay as the CV writes them ("January 2026"). An end of "Present" is kept as text.
- `facts.role_id`: nullable foreign key to `roles`, `on delete set null`.

## Reading roles

- A new prompt, `buildRolesPrompt`, asks for the roles in an item's text as JSON, copied exactly. It runs in the same task as the split, for items of kind `cv` and `experience`, through `runAi` and its retry. The fake AI returns roles for the test fixtures.
- Domain function `checkRoles({ text, roles })` keeps a role only when one header block has its title and company, and its other fields only from that block. It is pure and unit-tested, including made-up roles built from real CV fields.
- After roles are saved, each fact of that item whose `section` equals exactly one role's company (case-insensitive) gets that `role_id`. A section matching two roles (two roles at one company) is left unassigned.
- Reading roles again replaces the item's roles and clears the `role_id` of that item's facts first. Confirmed facts are never changed or re-split.
- **Existing CVs:** an item with no roles shows "Read roles from your CV" on Profile. The user starts it; nothing runs on its own.

## Profile

- Under the CV, and under each experience add-on, a "Roles" list. Each row holds title, company, location, start and end inputs and a Remove button. An "Add a role" button appends an empty row. One Save roles button saves the list.
- Each row shows how many facts sit under it ("4 facts").
- Errors name the problem and the way out, as elsewhere.

## Drafting

- The resume prompt gets a ROLES block, `ROLE-1: Full-stack Software Engineer, CASHFLOWY, REMOTE, January 2026 – June 2026`. Each fact line with a role ends with `(ROLE-1)`.
- The resume task: under `## Experience`, write `[ROLE-n]` on its own line before that role's bullets, in the order of the ROLES list. Roles may overlap in time (a part-time role next to a full-time one), so the list's order, not the dates, decides. Use only the facts of a role under it; facts with no role go in Summary, Skills, Projects or Education. Never write a role's title, company or dates yourself.
- Before the check, the server replaces each `[ROLE-n]` line with `### Title | Company, Location | Start – End` (parts the role lacks are left out). A key that is not in the list is a new violation, `unknown_role`, and goes through the existing retry.
- **Facts sit under their own role.** In the check, a sentence under a role header that cites a fact not marked with that role, or a cited sentence under `## Experience` before any header, is a `wrong_role` violation and gets the normal retry. Roles are matched by key, never by date, so overlapping roles never conflict.
- `checkDraft` skips a line that equals a rendered header of an allowed role.
- **PDF:** a `### a | b | c` line renders like the user's CV: the title in bold on the left, the dates on the right, and the company and location on the line below.
- **Copy text and the clean preview:** "Full-stack Software Engineer, CASHFLOWY, REMOTE (January 2026 – June 2026)".
- Letters and messages do not get role headers. Their prompts may still mention role names that the facts back.

## Tests

- Unit: `checkRoles` (a field missing from the text is dropped; a role without a company is dropped); role expansion and `unknown_role`; `checkDraft` accepts an expanded header and still flags an invented one; `toPlainText` and the PDF HTML for a header line.
- Server: a split of the CV fixture saves roles and links facts; a section matching two roles stays unassigned; reading again replaces roles and keeps confirmed facts; saving edited roles; a draft with the fake AI has one header per role.
- e2e: on Profile, read roles, fix a title, save; draft a resume; the preview text shows each role's header with the fixed title.

## Out of scope

- Moving a fact to another role by hand.
- Education and project headers.
- The rest of slice B: voice rules, dropping `# name`, and the letter and message structures.
