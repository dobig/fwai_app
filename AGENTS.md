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

## Threads and window APIs

The app froze as Not Responding on quit and on restart-after-update because
window state was saved from a tokio task. Plugins hold their own locks while
they call window getters, and off the main thread every getter is sent to the
main thread and awaited, while the main thread takes those same locks when it
handles window events. So:

- Call window and webview getters on the main thread (the `app.run` callback,
  sync window-event handlers), or post the work with `run_on_main_thread`.
  Never call them from a tokio task or an `async` command while holding a lock.
- Don't call blocking sync APIs from async code.
- Let tauri run its exit and restart lifecycle. Plugins do their teardown in
  `RunEvent::Exit`; don't `prevent_exit` and then `std::process::exit` past it.
