# Agent notes

## Worktrees

Every code change — feature, fix or chore, however small — starts in its own
git worktree off `origin/main`, never in the main checkout. Other sessions
share the main checkout and switch its branch under you, and whatever branch
it happens to be on is not where your change belongs.

```sh
git fetch origin
git worktree add -b <feat|fix|chore>/<name> ../fwai_app-<name> origin/main
cd ../fwai_app-<name> && pnpm install --frozen-lockfile
```

Work, test, commit and open the PR from that worktree. Remove it once the PR
has merged: `git worktree remove ../fwai_app-<name>` and delete the branch.
