# Upstream synchronization

This fork preserves `wolfiesch/gpt-control` as the upstream source and uses
merge commits so future upstream ancestry remains visible. Do not squash or
rebase an upstream synchronization.

## One-time remote setup

```bash
git remote -v
git remote add upstream https://github.com/wolfiesch/gpt-control.git
git fetch --prune origin
git fetch --prune upstream
```

If `upstream` already exists, confirm that its fetch URL is exactly the URL
above. Do not change a push URL or push to upstream.

## Inspect changes before integration

Start from a clean fork branch and record the exact refs:

```bash
git fetch --prune origin
git fetch --prune upstream
git rev-parse origin/main
git rev-parse upstream/main
git log --oneline --left-right --cherry-pick origin/main...upstream/main
git diff --stat origin/main...upstream/main
```

Read upstream release notes and inspect security-sensitive changes before the
merge. Update `GPT_CONTROL_EXPECTED_UPSTREAM_BASE` during verification when the
new upstream tip is not yet the script default.

## Merge upstream into the fork

Create a dedicated branch from the current fork main:

```bash
git switch main
git pull --ff-only origin main
git switch -c sync/upstream-YYYYMMDD
git merge --no-ff --no-commit upstream/main
```

Resolve conflicts by preserving both the new upstream behavior and the fork's
security contracts. Pay special attention to browser ownership, model
read-back, prompt transport, cancellation ordering, durable recovery,
attachment snapshots, connector provenance, and the committed MCP bundle.

After conflict resolution, rebuild and verify:

```bash
bun install --frozen-lockfile
bun run build:mcp
GPT_CONTROL_EXPECTED_UPSTREAM_BASE=$(git rev-parse upstream/main) bash scripts/verify-security.sh
git diff --check
git status --short
```

Commit the merge without changing its two-parent structure:

```bash
git commit -m "Merge upstream main into hardened fork"
git push -u origin sync/upstream-YYYYMMDD
gh pr create --draft --repo mdahmann/gpt-control --base main --head sync/upstream-YYYYMMDD
```

Use a merge commit when the pull request is accepted. Do not use squash merge
or rebase merge. Confirm the resulting fork main still contains the upstream
tip as an ancestor:

```bash
git fetch --prune origin upstream
git merge-base --is-ancestor upstream/main origin/main
```

An exit status of zero proves the ancestry connection is intact. Repeat this
workflow for later upstream releases.
