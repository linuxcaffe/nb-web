<!-- Generated from docs:dev/dev-storage.md by .tools/readme-export.py. Edit the source, not this file. -->

# STORAGE & BACKUP TOPOLOGY

> Developer documentation for nb-web. See [DEVELOPERS](../DEVELOPERS.md) for the full index.

Everything lives in git. This document maps what lives where, why the scheme is structured
the way it is, and what's needed to reconstruct it on a new machine.

---

## The three layers

```
Layer 1 — Undercarriage    ~/.nb/          → Codeberg: nb-notes.git  (master branch)
Layer 2 — Notebook data    ~/.nb/{name}/   → Codeberg: nb-notes.git  ({name} branch)
Layer 3 — App code         ~/dev/nb-web/   → Codeberg: nb-web.git
                           ~/dev/nbweb-*/  → GitHub:   linuxcaffe/*
```

These are independent git repos. They sync separately, fail independently, and can be
restored independently. Config files deliberately live in Layer 2 (inside notebooks)
so they travel with the data that needs them.

---

## Layer 1 — Undercarriage

**Repo:** `~/.nb/.git`
**Remote:** `git@codeberg.org:linuxcaffe/nb-notes.git` (branch: `master`)

Tracks machine identity and shared config — things that need to exist before any notebook
is opened and that don't belong inside any one notebook.

```
~/.nb/
  .nb.md              ← global config (access floor, check:, tag_color:, etc.)
  .users/             ← user cards (djp.md, guest.md, office.md, admin.md …)
    users.md          ← dotfolder dashboard (pinned, admin-only)
  .rules/             ← domain convention files (hledger.md, docs.md, preview.md …)
    rules.md          ← dotfolder dashboard
  .checks/            ← check scripts (nb-*, hl-*, tw-*, sys-*, syntax-*, test-*)
    checks.md         ← dotfolder dashboard
  .tools/             ← utility scripts (nb-restore.sh, nb-daily-init.sh …)
    tools.md          ← dotfolder dashboard
  .lib/               ← reusable inline components (.md and .html)
    lib.md            ← dotfolder dashboard
    nav-config-admin.md  ← nav clipping: row of links to all five dashboards
    user-mgmt-admin.md   ← admin user management component
    user-mgmt-office.html
    user-mgmt-user.html
  .templates/         ← global note templates
  .gitignore          ← ignores /[A-Za-z]*/ (each notebook is its own repo)
```

**Gitignored (intentionally not tracked):**

| Path | Why |
|------|-----|
| `/[a-zA-Z]*/` | Each notebook is its own git repo (Layer 2) |
| `/.plugins/` | Installed per machine; wired via `nb-settings.json` |
| `/.cache/` | Transient — nb query cache |
| `/.web/` | Transient — nb web artefacts |

**Currently untracked (should be added):**

| Path | Status |
|------|--------|
| `.images/` | Global image stubs — probably worth tracking |
| `.changes/` | UI snapshot cache — probably gitignore |

---

## Layer 2 — Notebook data (branch-per-notebook)

**Remote:** `git@codeberg.org:linuxcaffe/nb-notes.git` (branch: `{notebook-name}`)

Every notebook is a fully independent git repo. They all push to **one Codeberg repo**
on branches named after the notebook. This is the central architectural decision:

```
nb-notes.git
  master          ← undercarriage (Layer 1)
  home            ← ~/.nb/home/
  docs            ← ~/.nb/docs/
  accts           ← ~/.nb/accts/
  claude          ← ~/.nb/claude/
  tw              ← ~/.nb/tw/
  work            ← ~/.nb/work/
  nb              ← ~/.nb/nb/
  pfinds          ← ~/.nb/pfinds/
  openfilmmaker   ← ~/.nb/openfilmmaker/
  bkmk            ← ~/.nb/bkmk/
  tasks           ← ~/.nb/tasks/
  contacts        ← ~/.nb/contacts/
  exp             ← ~/.nb/exp/
  ...
```

**Why branch-per-notebook:** One credential, one clone, full history per notebook,
independent sync cadence. `nb sync` handles the push/pull per notebook. The web UI's
"Wire remotes" action sets this up automatically for new notebooks.

**Notebook config travels with data:** `.Takeout.md`, `.shots.md`, `.accts.md` etc.
live *inside* their notebook repos. Clone the notebook, get its full config, constraints,
and type definitions. No separate config step needed.

### Exceptions and gaps

| Notebook | Remote | Issue |
|----------|--------|-------|
| `preciousfinds.ca` | GitHub `linuxcaffe/preciousfinds.ca` | Publishing pipeline requires GitHub; no Codeberg backup |
| `Takeout` | Codeberg `nb-notes.git` | On `feature/notebook-config` branch — should be on `Takeout` |
| `friends` | Codeberg `nb-notes.git` | Wired 2026-06-20 |
| `hledger` | Codeberg `nb-notes.git` | Wired 2026-06-20 |
| `tutorial` | none | No backup (low priority) |

**Fix for unwired notebooks:** run "Wire remotes" from the Git menu, or manually:
```bash
nb {notebook}: git remote add origin git@codeberg.org:linuxcaffe/nb-notes.git
nb {notebook}: sync
```

---

## Layer 3 — App code

| Repo | Remote | Notes |
|------|--------|-------|
| `~/dev/nb-web/` | Codeberg `linuxcaffe/nb-web` | Core app — Flask + JS |
| `~/dev/tw-web/` | Codeberg `linuxcaffe/tw-web` | Taskwarrior web UI |
| `~/dev/nb-plugins/` | GitHub `linuxcaffe/nb-plugins` | CLI plugins (grep, cal…) |
| `~/dev/nbweb-cine/` | GitHub `linuxcaffe/nbweb-cine` | Cine plugin |
| `~/dev/nbweb-hledger/` | none yet | hledger plugin — no remote, not restored by script |
| `~/dev/nb-website/` | GitHub `linuxcaffe/nb-website` | Quartz publishing package |
| `~/dev/nb/` | GitHub `linuxcaffe/nb` | nb CLI fork/notes |

App code is separate from data by design. nb-web can be updated without touching any
notebook. Notebooks sync without touching app code.

---

## `nb-settings.json` — in transition

`~/dev/nb-web/nb-settings.json` currently holds a mix of portable config and
machine-specific settings. The portable keys are being migrated into `.nb.md` and
notebook manifests via the config chain. What will remain in `nb-settings.json` is
a thin residual of truly machine-specific values:

| Moving to `.nb.md` / manifests | Staying in `nb-settings.json` |
|-------------------------------|-------------------------------|
| `codeblock_access`, `lang` | server port, PTY dimensions |
| `notebook_prefs` → notebook configs | `pty_init`, `pty_cwd` |
| plugin config → notebook manifests | `git_repos` aliases (machine paths) |
| `default_git_remote` → `.nb.md` | `hledger_web_cmd`, `tw_web_cmd` |

Once migration is complete, `nb-settings.json` will be small, clearly machine-specific,
and reconstructible from a short checklist. It will still not be version-controlled
(intentionally — ports and paths differ per machine) but it won't be a restore blocker.

---

## Restore sequence (new machine)

A bootstrap script handles the full restore. On a fresh machine:

```bash
# Prerequisites: git, curl, SSH key added to Codeberg
curl -fsSL "https://codeberg.org/linuxcaffe/nb-notes/raw/branch/master/.tools/nb-restore.sh" | bash
```

Or after cloning the undercarriage manually, or to resume a partial run:

```bash
bash ~/.nb/.tools/nb-restore.sh
```

The script is **idempotent** — safe to re-run; each phase skips steps already complete.

### What `nb-restore.sh` does

| Phase | Action |
|-------|--------|
| 0 | Pre-flight: verify `git`, `curl`, SSH → Codeberg |
| 1 | Install `nb` binary if missing |
| 2 | Clone undercarriage (`nb-notes.git master → ~/.nb`) |
| 3 | Restore all notebooks — discovers branches from remote, no hardcoded list |
| 4 | Clone dev repos (`nb-web`, `nb-plugins`, `nbweb-cine`, `tw-web`) |
| 5 | Install nb CLI plugins from `~/dev/nb-plugins/*.nb-plugin` |
| 6 | Seed `nb-settings.json` from `.tools/nb-settings-template.json` |
| 7 | Write and enable `nb-daily-init` systemd timer (06:00 daily note) |

Prints `✓` / `·` / `✗` per step; summarises failures and manual steps at the end.

### After restore — manual steps

- Edit `~/dev/nb-web/nb-settings.json` — fill in `__SET_ME__` values (port, `tw_web_cmd`, `hledger_web_cmd`)
- Wire `nbweb-hledger` to a remote (no remote yet — see Layer 3 table)
- Merge `Takeout` off `feature/notebook-config` onto its own branch

---

## What this scheme does well

- **One credential, full restore** — Codeberg covers undercarriage + all notebooks
- **Config co-located with data** — notebook manifests and folder configs travel with the notebook
- **Independent failure domains** — a broken notebook repo doesn't affect others
- **nb sync works per-notebook** — granular sync, granular history
- **`master` is always the undercarriage** on `nb-notes.git` — clean conceptual anchor

## What needs improvement

1. **Add `preciousfinds.ca` as a Codeberg secondary remote** — GitHub-only is a single point
2. ~~**Track `.tools/` and `.lib/`**~~ — `.tools/` tracked 2026-06-20; `.lib/` still pending
3. **Migrate `nb-settings.json`** portable keys into `.nb.md` (in progress)
4. **Merge `Takeout/feature/notebook-config`** — notebook data shouldn't live on a dev branch
5. ~~**Bootstrap script**~~ — done 2026-06-20; see `.tools/nb-restore.sh`
6. **Wire `nbweb-hledger` remote** — no git remote; not included in restore script yet

~~Wire `friends` and `hledger`~~ — done 2026-06-20, both on `nb-notes.git`.

---

> The architecture is sound. The branch-per-notebook pattern on a single remote is
> elegant and scales cleanly. The gaps are all in the restore story, not the structure.
