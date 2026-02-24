# Branch Protection Setup (GitHub UI)

These settings cannot be configured via files — apply them once after pushing to GitHub.

## master branch rule

**GitHub → Settings → Branches → Add branch ruleset** (or classic rule for `master`):

### Required settings

| Setting | Value |
|---------|-------|
| Branch name pattern | `master` |
| Require a pull request before merging | ✅ |
| Required approvals | **1** |
| Require review from Code Owners | ✅ ← enforces `CODEOWNERS` (i.e. andranikasd must approve) |
| Dismiss stale pull request approvals when new commits are pushed | ✅ |
| Require status checks to pass before merging | ✅ |
| Require branches to be up to date before merging | ✅ |
| Do not allow bypassing the above settings | ✅ |
| Allow force pushes | ❌ |
| Allow deletions | ❌ |

### Required status checks

Add all of these (they come from `.github/workflows/ci.yml`):

- `Lint`
- `Type Check`
- `Test (Node 20)` ← matrix job
- `Test (Node 22)` ← matrix job
- `Build`
- `Validate conventional commit title` ← from `pr-title.yml`

> **Note:** Status check names must match the `name:` field of each job exactly.
> Run the CI workflow once on any PR to make the check names available in the dropdown.

## Enabling CodeQL alerts

**GitHub → Settings → Security → Code security and analysis:**

- Enable **Dependency graph** ✅
- Enable **Dependabot alerts** ✅
- Enable **Dependabot security updates** ✅ (auto-PRs for vulnerable deps)
- Enable **Code scanning** — select **CodeQL** (the workflow in `.github/workflows/codeql.yml` handles this automatically once pushed)

## Dependabot labels

For the label filtering in `.github/dependabot.yml` to work, create these labels in
**GitHub → Issues → Labels → New label**:

| Name | Suggested colour |
|------|-----------------|
| `dependencies` | `#0075ca` |
| `github-actions` | `#e4e669` |