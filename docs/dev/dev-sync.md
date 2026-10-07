<!-- Generated from docs:dev/dev-sync.md by .tools/readme-export.py. Edit the source, not this file. -->

# SYNC (dev)

Developer reference for the sync system internals. For user-facing sync docs see [SYNC](../SYNC.md).

---

## `/api/sync` — pull-then-push flow

```
POST /api/sync  { notebook, message }
```

1. Optional pre-commit if `message` provided: `git commit -a -m <message>`
2. `nb <notebook>:sync` — nb auto-commits any pending changes (nb's own bookkeeping)
3. `git pull --no-edit origin <notebook>` — merges remote commits (handles edits from GitHub web, other machines)
4. `git push origin HEAD:<notebook>` — pushes to the notebook's branch on the remote

Steps 3 and 4 are explicit git calls, not `nb sync`, because `nb sync` pushes `master→master` by default — not `master→<notebook>`. The explicit form is required for the one-repo/branch-per-notebook model.

**No-remote detection:** before step 1, checks `git remote` — returns `{no_remote: true}` with a message if unconfigured. The sync dialog disables "Sync Now" and shows guidance.

**Env for all git subprocess calls:** `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true` — prevents credential prompts from hanging the Flask worker.

---

## `/api/nb/sync/status` — status API

```
GET /api/nb/sync/status?notebook=<name>
```

Returns `{changes, has_remote, unpushed, files}`:

- `changes` — count of modified files (`git status --porcelain`)
- `has_remote` — bool
- `unpushed` — count via `git rev-list origin/<notebook>..HEAD --count`
  - Uses `origin/<notebook>` explicitly (not `@{u}`) — avoids wrong tracking-branch config from notebooks wired before `git-wire` fixed the tracking setup
- `files` — `[{status, path}]` from `git status --porcelain`

---

## `/api/nb/git-wire` — wire remotes flow

```
POST /api/nb/git-wire  { url }   (url optional — falls back to nb-settings.json default_git_remote)
```

For each notebook dir in `~/.nb/` that lacks a remote:

1. `git remote add origin <url>`
2. `git push --set-upstream origin HEAD:<name>` — creates remote branch named after notebook
3. `git config branch.master.merge refs/heads/<name>` — fixes tracking so `@{u}` = `origin/<name>`

Step 3 is critical. Without it, `nb sync` pushes to the wrong branch and `/api/nb/sync/status` reports 0 unpushed even when commits exist (because `@{u}` points at `origin/master`).

Failed pushes roll back (`git remote remove origin`); skipped notebooks are marked `·` in the output. Timeout: 20 s per notebook.

Skips: dirs starting with `-`, notebooks with an existing remote.

---

## `_pollNbSyncStatus()` — nav.js polling

Runs every 60 s. Fetches `/api/nb/sync/status?notebook=<current>` and updates the "sync" menu badge:

- `sync (N changed, M unpushed)` — pending work, gets `.nb-sync-pending` class
- `sync (no remote)` — not wired

The poll is initiated in `NbNav.init()` via `_initSyncDialog()`. The sync dialog itself is created once on init (inside `_initMenu` to capture the `shut` closure) and reused.

**Badge update is additive** — it patches the existing menu item text without rebuilding the menu. Switching notebooks triggers an immediate re-poll.

---

## Tracking-branch config history

Early wired notebooks used `git push --set-upstream origin master:<name>`, which set tracking to `origin/master`, not `origin/<name>`. This caused:
- `nb sync` pushing commits to `master` branch on the remote instead of `<name>`
- `/api/nb/sync/status` always reporting 0 unpushed

Fix: `git-wire` now sets `branch.master.merge refs/heads/<name>` explicitly after push. Notebooks wired before this fix can be repaired by re-running wire remotes (it skips notebooks that already have a remote, so run `git remote remove origin` in the notebook first if needed).
