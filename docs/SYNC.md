<!-- Generated from docs:SYNC.md by .tools/readme-export.py. Edit the source, not this file. -->

# Sync

[The Model](#the-model) · [Git Menu](#git-menu) · [Sync Status](#sync-status) · [Wiring a Notebook](#wiring-a-notebook) · [Syncing](#syncing) · [Hard Rules](#hard-rules) · [Danger Zone](#danger-zone) · [If Things Go Wrong](#if-things-go-wrong)

---

nb-web syncs notebooks using git. Each nb notebook is a git repository in `~/.nb/<name>/`. Syncing means committing any uncommitted changes and pushing to (and pulling from) a remote.

---

## The model

- **One git repo per notebook locally.** `~/.nb/home/` is its own git repo, `~/.nb/docs/` is another, etc.
- **One branch per notebook on the remote.** A notebook named `home` pushes to a branch called `home`, `docs` pushes to `docs`, and so on.
- **All notebooks share one remote repo** — typically `nb-notes` on GitHub. Each notebook is a branch of that repo, not a separate repository. Set this once in **Settings → Git → Default remote**.
- **nb-web does not call `nb sync`.** It uses git directly — explicit, scoped to one notebook at a time, no surprises.

### Setting the default remote

Open **Menu → Settings → Git** and paste your `nb-notes` SSH URL (e.g. `git@github.com:yourname/nb-notes.git`). After that, wiring a new notebook to the remote requires no typing — just click **Wire** with the URL field blank.

---

## Git Menu

**☰ → Git** surfaces nb's per-notebook git model with convenient shortcuts:

| Item | What it does |
|------|-------------|
| **log** | Last 30 commits for the current notebook, with remote info at the top |
| **remote** | Runs `nb remote` — shows the configured remote URL |
| **status** | Runs `nb status` — git status of the current notebook |
| **sync** | Opens the Sync dialog for the current notebook |
| **wire remotes** | One-shot: wires every notebook that lacks a remote, using the default URL from Settings |

### Sync dialog

The sync dialog shows the notebook's current state before you commit to syncing:

- **Status** — lists uncommitted files and unpushed commit count; "Up to date" when nothing is pending; "No remote configured" if not yet wired
- **Commit message** — optional; creates a labelled commit before syncing (useful for annotating a batch of auto-commits)
- **Sync Now** — full two-way cycle: auto-commit pending → `git pull` (merge remote edits) → `git push` to the notebook's branch
- **Show Log** — fetches the last 30 commits inline without closing the dialog

The **sync** menu item shows a live badge (updated every 60 s): `sync (3 changed, 1 unpushed)` or `sync (no remote)`.

---

## Sync status indicators

The **logo button** in the top-left corner changes color:

- Normal — everything committed and pushed (or no remote)
- **Yellow tint** — uncommitted changes or unpushed commits in the current notebook

The **Sync button** in the menu header shows the active notebook name and its status:  
`Sync home · 3 unpushed` — three commits waiting to push.

The status updates immediately when you switch notebooks, save a note, or open the menu.

---

## Wiring a notebook to a remote

Before you can sync, a notebook needs a remote. Open **Menu → Notebooks**, click a notebook — if it has no remote the wire area appears automatically.

### Wire to nb-notes (the normal path)

With a default remote set in Settings → Git, leave the URL field blank and click **Wire**. nb-web will:

1. Add `origin` pointing at your `nb-notes` repo
2. Set the tracking config for the `master` branch
3. Push `HEAD:<notebook-name>` to create a new branch on the remote

The default remote is shown as a hint below the URL field so you always know where blank goes. This is the right path for any new notebook — it lands as a new branch on `nb-notes`, alongside all your other notebooks.

### Wire to a specific URL

Paste any SSH URL in the field and click **Wire** to override the default. Useful when a notebook genuinely needs its own remote (e.g. a public project repo).

### Create a new separate GitHub repo (requires gh CLI)

Expand **"Create a new separate GitHub repo"**, choose Private or Public, and click **Create & Wire**. nb-web calls `gh repo create <user>/<notebook>`, sets that new repo as the remote, and pushes. On failure the remote is rolled back so you can retry cleanly.

Use this only when you want a dedicated standalone repo — not for the normal nb-notes branch model.

> Requires `gh` installed and authenticated (`gh auth login`). See [INSTALL](docs:12).

---

## Syncing

Once a notebook is wired, a **Sync** button appears in the notebook detail panel (Menu → Notebooks → select notebook). Click it to commit any pending changes and push/pull.

You can also trigger sync from the **Sync button in the menu header** — it targets whichever notebook is currently in focus.

After a sync, nb-web reloads the notebook detail so you can see the updated unpushed count.

---

## Hard rules

These are operational lessons, not suggestions:

#TODO — section was never completed; needs: NB_AUTO_SYNC rule, default-remote-first rule, one-branch-per-notebook rule

---

## Danger Zone

#TODO — needs: force-push warning, deleting remote branch consequences, merge conflict resolution

---

## If Things Go Wrong

#TODO — needs: merge conflicts, missing remote, auth failures, recovery steps

---

Developer internals: [sync](dev/dev-sync.md)
