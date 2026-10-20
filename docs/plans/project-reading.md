# Reading a project for facts (decision 81)

Find my projects (78, 79) and Fill from a project (80) only say what a project is. This plan reads what the user did in it: their commits, the files those commits changed, and the hunks of a few commits picked by feature. Each slice must leave the build and all tests passing.

## Shared pieces

- **Identity.** A commit is the user's when its GitHub login is theirs or its author email is in git config, `HB_GIT_EMAILS` or the noreply address. The folder scan already computes these emails; GitHub reads reuse them.
- **Framing.** If at least half the commits are the user's, the project is theirs; otherwise it is a contribution. Feature facts cite only the user's commits either way. `ownershipLine` in `src/domain/prompts.ts` changes from "owner" to this share.
- **Commit list.** One record per user commit: sha, subject, date, and changed files with additions and deletions. Lock files, generated files and vendored code are left out of the counts.
- **Feature grouping.** A new light-tier call reads the README and the commit list and returns up to 6 features, each with 2 or 3 commit shas copied from the list. Shas not in the list are dropped. A project with fewer than 5 of the user's commits skips grouping and reads its biggest commits.
- **Hunks.** Only the picked commits' diffs are read, trimmed to fit the 12,000-token cap. Hunks are cut before the README, manifests or the commit list.
- **Secrets.** `.env*`, `*.pem`, `*.key`, `id_*`, credentials files and git-ignored paths are never read, in files or in hunks.
- **Visibility and citations.** A fact's citation (sha or path) is always stored. It is rendered and linked only when the project is public. A folder is public when its GitHub or GitLab remote answers the public API. A private fact shows only the project name, in the app and in exports.

## Slices

1. **Local folder deep read.** A git-based reader produces the commit list and hunks from a folder. The add-on stores its folder path, which is never exported. The folder's add-on gets a Read for facts button that runs grouping and extraction through the existing split and confirm flow. Tests use real temporary repos (`test/git-repos.ts`) with commits by two people and a secret file that must not be read.
2. **GitHub evidence.** GitHub reads use the same commit list, grouping and hunks. Hunks come from a local clone when the scan matched one, from the API with `HB_GITHUB=gh`, or else from a temp clone with `--filter=blob:none`, a 2-minute timeout and cleanup on every path. A repo over 500 MB is not cloned; the API gives hunks for 10 commits. Fixture snapshots gain per-commit files and patches. Framing switches to commit share.
3. **Read after adding.** The Find my projects dialog gets a "Read each project for facts" checkbox with the estimated cost, and the spending cap is checked once for the batch. Reads run one at a time in the background with progress on each add-on. The Fill form gets a "Read for facts" checkbox, on by default after a fill. An e2e test covers both, with an accessibility check in both themes.

## Later

- A deep read of GitLab projects.
- Letting the user pick features before their hunks are read.
