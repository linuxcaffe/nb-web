<!-- Generated from docs:dev/dev-task-notes-round-trip.md by .tools/readme-export.py. Edit the source, not this file. -->

# Task notes: the round trip across stations (dev)

> Developer documentation. Index: [DEVELOPERS](../DEVELOPERS.md).
> **User side, with the flowchart:** [the hub](https://github.com/linuxcaffe/tw-mobilize/blob/main/docs/task-notes.md)
> (`~/dev/tw-mobilize/docs/task-notes.md`; the SVG is drawn by `docs/task-notes-svg.py`, edit
> that, not the SVG). This page is its twin: why, the rules that mustn't break, and where each
> piece's details live.
> **nb-web's part** (the header, Add task, deleting a task note): [Taskwarrior ↔ nb-web: task notes](dev-tw-interop.md).
> **nb-web's Sync:** [sync](dev-sync.md). **Design narrative:**
> tw_nb_interop_plan_2026-11-01.md.

A bare `nb:` on a task, on any station, gets the task its note there and then; the note and the
link reach every other station by git; the link opens wherever an nb-web answers, or in nb Docs
on a phone with none.

## Who does what

| Piece | Repo | Job |
|---|---|---|
| nbnotes (`on-exit_nbnotes.py`) | `~/dev/tw-nbnotes-hook` | after a task command: a request → `nb tw note`; a path link → `nb tw status` |
| `tw.nb-plugin` (`nb tw`) | `~/dev/nb-plugins` | makes, links, mirrors; the only code that writes a task note's frontmatter |
| tw2nb | `~/dev/tw2nb` | archive (`tasks:`) and daily journal; not task notes since 1.5.0 |
| gittw | `~/dev/gittw` | `~/.task` over git: the on-exit hook commits, `gittw sync` pulls and pushes |
| tw-web | `~/dev/tw-web` | `nb:` links on cards, `N`, the menu line, auto-sync of `~/.task`, the Documents fallback |
| nb-web | `~/dev/nb-web` | the task header, `W`, Add task, Sync of the notebooks |
| m-sync, mobilize | `~/dev/tw-mobilize` | the phone's notebook sync; a station's hooks, plugin check, Documents step |
| nb Docs | `~/dev/nb-Docs` (Fossify Documents with the fork's additions; `io.github.linuxcaffe.nbdocs`) | opens and edits a note offline on the phone |

## The request

- **Pattern:** `^nb:(?:\s+([A-Za-z0-9_.-]+):)?\s*$`, a bare `nb:` or `nb: <notebook>:`. It's
  in nbnotes and in `tw.nb-plugin` (its `REQUEST`): twins, change both. Numeric links
  (`nb: tasks:42`, tw2nb's archive) match `^nb: [\w.-]+:\d+$` and cost nothing.
- **on-exit, not on-modify:** on-modify runs before Taskwarrior writes, so the plugin's
  `task export` would see the old task. on-exit sees what was written.
- **Never holds a task command up** (nbnotes 1.1.0): the nb work runs in a process of its own
  (its own session, none of Taskwarrior's pipes, or Taskwarrior would wait for it anyway); the
  hook waits at most `NBNOTES_WAIT` (3 s). Incident: on s5 `nb tw note` takes several seconds
  (2.4 s just for a status) and tw-web gives a command 15 (`TASK_TIMEOUT`), so deleting a task
  with a bare `nb:` "failed" in tw-web though it went through, and the note came 8 s later.
  After the wait, problems go to `~/.task/logs/nbnotes.log`.
- **No note for a deleted task:** a request on a task whose status is `deleted` is dropped (an
  on-exit hook sees only the result, not what changed). A completed task's request is made.
- **Never fails a task command.** Problems go to stderr. No nb on the station: silent (the
  notes live elsewhere). nb but no plugin: one line naming the install, once per run.
- **Where the note goes:** `tasknotes:` (or the notebook named), a folder from the top of the
  project (`tw.folder_depth`, default 1, only in the default notebook), file
  `<slug>-<uuid8>.note.md`. An unknown notebook leaves the request and says why.
- **On the phone it needs no network:** nb and the plugin run there; the sync carries the rest.

## A plugin that's needed is installed (djp 2026-11-05)

"Any part of the program that needs an nb-plugin should a) install it quietly, or b) install
it with a prompt." Where each caller stands:

- `tw -I nbnotes`: installs `tw.nb-plugin` quietly when nb is here; keeps one already there
  (a symlink into `~/dev` too); names the command when there's no nb or no network.
- `tw -I nb-plugins` (1.3.0): installs cal, grep, send, tw (before, only its README). Its
  installer is `# HANDCRAFTED`, so make-awesome never regenerates it.
- nb-web: Add task's card offers **Install it** (`POST /api/tw/install-plugin`, admin floor,
  through `run_nb`).
- `mobilize init`: asks at a terminal, installs with `--yes`, names it otherwise.
- tw-web only checks for it (`/api/nb/health`); tw2nb doesn't need it.
- **Updates** (2026-11-05): an ordinary copy that differs from nb-plugins' main is replaced
  (nbnotes 1.1.1, nb-plugins 1.3.1, `mobilize init` 0.10.4); a symlink is never touched; no
  network keeps the copy and says so. The phone gets updates only from `mobilize init`: tw
  doesn't update there (the update station's job) and `~/.nb/.plugins` isn't shared. s5's
  copy had fallen behind yoga's because every installer said "already installed".

## Each station's hooks

`~/.task` is shared, hooks included, but a station can choose which run:
`mobilize hooks --set '…'` writes `hooks.location = ~/.task/hooks.d/<station>` (links into
`hooks/`) in that station's `local.rc`. The phone runs gittw and nbnotes, **not tw2nb**:
`tw2nb.rc` is shared with no per-station override, so on the phone it would journal into its
own `home` (never synced) and start a `tasks` notebook there. That is why nbnotes was split out
of tw2nb (tw2nb 1.5.0, nbnotes 1.0.0): the phone's bare `nb:` on task 106 stayed bare because
its hook list had no tw2nb, and yoga's hooks never run on synced data.

## One station installs

`~/.task/config/.tw_manifest` is merged with git's union rule, so when two stations each
updated an app, both versions' lines survived. tw 2.22.0: the manifest is read settled (the
newer version's lines win, duplicates go, the file is rewritten), `tw -I/-u/-r` pull first,
and `tw.update_station` (shared rc) names the one station that installs; anywhere else
(`gittw.device`) tw asks at a terminal and refuses without one. tw itself is exempt.

## What syncs what

| Data | Who | When |
|---|---|---|
| `~/.task` | gittw's on-exit hook | **commits only**, after every change (`gittw.autocommit`) |
| `~/.task` | tw-web's auto-sync (`gittw sync`) | 10 s after start, 60 s after a change, every 900 s; retry after 300 s (`AUTO_SYNC_*`, setting `sync_auto`); and tw-web's Sync |
| notebooks, phone | m-sync | every 15 min with a network (Termux job 7301), soon after a quick note (7302) |
| notebooks, desktop | nb-web's Sync | when pressed; on yoga also every 15 min: `nb-sync-notebooks.timer` runs `~/.nb/.tools/sync-notebooks.py`, which asks nb-web's `/api/sync` for each notebook with a remote (djp's setup, not shipped with nb-web) |

A task command does **not** pull or push (a 2026-11-05 answer got this wrong). Until both
syncs have run, a station can have the link without the note, or the note without the link.
m-sync also asks the phone's tw-web to check for its own update (`POST /api/version/check`, at
most once a minute), so the pill shows within 15 minutes.

## Conflicts

The same note changed on two stations ends the same way in m-sync and in nb-web's Sync: the
remote's version keeps the name, this station's is saved beside it as
`note.conflict-<station>.md` (then `-2`, …), the merge is committed and pushed, and the sync
says which notes it set aside. Station: `gittw.device` in `~/.task/local.rc`, else the
hostname, then `phone` (m-sync), or `nb-web` (nb-web). A merge that stops for any other reason is aborted,
never left. **Conflict markers are never pushed**, whoever wrote them: nb-web refuses the
push. `.index` merges by line (`/.index merge=union` in `.git/info/attributes`). Incident:
until 2026-11-05 nb-web left the half-done merge, the next nb run committed it (`e6c0315`), and
markers reached both stations. nb-web details: [sync](dev-sync.md#conflicts).

## Finding the other app

Each app probes a list of addresses in parallel (2.5 s), opens the first **in list order**
that answers, and saves only an address you typed:

| From | Tries, in order |
|---|---|
| tw-web → nb-web (`nbWebCandidates`, `nbHealth`) | this device's (`localStorage tw-nb-web-here`), the `nb` launcher, nb-web's port 5001 on the page's host |
| nb-web → tw-web (`_twWebCandidates`, `goTwWeb`) | this device's (`nb-tw-web-here`), `tw_web_url`, `localhost:5000` (the phone's own), port 5000 on the page's host |

`localhost:5000` comes before the page's host because on the phone the page's host is yoga
over Tailscale, and nb-web's link then led to yoga's tw-web, not the phone's. `unset` (no saved
address and no setting, and nothing answered) is its own state, so the card can say which.
Both menus end with the station (`/api/station`, `gittw.device`), the other app, and Sign out
(nb-web) or Stop (tw-web). The bundle (`~/dev/tw-nb-bundle`, :5080, nb-web at `/`, tw-web at
`/tw/`) keeps both in one window; [Taskwarrior ↔ nb-web: task notes](dev-tw-interop.md#getting-from-one-app-to-the-other).

## Offline on the phone: nb Docs

When no nb-web answers, tw-web's card calls `POST /api/nb/open`, which opens the note in
Documents through Termux's documents provider: `am start -a VIEW -t text/markdown -d
content://com.termux.documents/tree/<enc tasknotes root>/document/<enc path> -n
<pkg>/org.fossify.documents.activities.DocumentOpenActivity` (`<pkg>` from the whole `pm list packages`,
first of `io.github.linuxcaffe.nbdocs`, its `.debug`, then Fossify's two; a `pm` filter is a
substring and hid nb Docs). The class keeps Fossify's name: nb Docs changed only its app id.
The card names the app it used (`/api/nb/open` → `app`).
`termux-open` is the last resort: it hands a file to another app only with
`allow-external-apps=true`, which stays **off** on s5. An edit made there is committed by
m-sync's next run.

## Gaps, as of 2026-11-05

- The task header doesn't show the task's annotations.

## A link that arrives before its note

Until both syncs have run, nb-web may get a link to a note it doesn't have. `openNote` on a
404 calls `_showMissingNote` (main.js): "This note isn't on this station", no toolbar (an Edit
there once failed to save with "unknown error"), and **Sync <notebook>** (`/api/sync`), which
tries the note again; still missing, it says to let the other station sync first. The note
isn't kept as the one to reopen. Test: e2e `note-missing.spec.js`.

## nb Docs releases

`~/dev/nb-Docs`: `main` is the Documents fork's `phone` branch plus the branding (id, name,
icon from `graphics/nb-docs-icon.py`, workflows). Features are still offered upstream from
`linuxcaffe/Documents`. A release: set `VERSION_NAME` (`<Fossify's>-nb.<n>`) and `VERSION_CODE`
(+1), commit, push a `v<VERSION_NAME>` tag; `nb-docs-release.yml` signs it with the key whose only
copies are `~/.android-keys/nb-docs/` and the repo's `SIGNING_*` secrets (SHA-256
`4C:F4:E4:78:…:BB:14:C4`; check an APK with `~/.claude/skills/termux/apkcert.py`). First release
`v1.1.0-nb.1`, 2026-11-05, on s5; Fossify's debug build uninstalled.

## Releases and checksums

tw2nb, nbnotes, nb-plugins, mobilize, tw-web: djp runs `make-awesome.py --push` in the app
repo; it copies `.meta`/`.install` to the registry, rewrites `registry.d/index.json` and the
README's list of extensions. **Any edit to a file in a `.meta`'s `files=`** (a README too)
needs `checksums=` redone, or `tw -I/-u` says "Checksum mismatch": five READMEs did that on
2026-11-05. awesome-taskwarrior's `test_registry_checksums_match_the_app_repos_here` catches
it for apps checked out in `~/dev`.

## Tests

- nbnotes: `tests/test_nbnotes.py` (the hook against the real plugin in a throwaway HOME; the
  installer with a fake nb).
- nb-plugins: `tests/test_tw*.py`, `test_tw_request.py`, `tests/test_installer.py`.
- tw2nb: `tests/test_tasknotes.py`, `tests/test_installer_include.py`.
- tw-web: `test_nb_health.py`, `test_nb_note_fallback.py` (Documents), `test_update.py`,
  `test_station.py`, `test_installer_mirrors.py`; e2e `sibling-here`, `sibling-fallback`,
  `ann-launch-fallback`.
- nb-web-tests: `test_sync_conflicts.py`, `test_tw_install_plugin.py`, `test_tw_health.py`;
  e2e `tw-sibling-here`, `tw-sibling-link`, `tw-health`, `tw-add`.
- mobilize: `tests/test_mobilize.py` (m-sync's conflict copies, the plugin step, hooks).
- awesome-taskwarrior: `tests/test_tw_shared_station.py`, `tests/test_tw_registry.py`.
