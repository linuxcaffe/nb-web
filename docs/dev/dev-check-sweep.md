<!-- Generated from docs:dev/dev-check-sweep.md by .tools/readme-export.py. Edit the source, not this file. -->

# Check sweep — every applicable check across a notebook

> Developer documentation for nb-web. See [DEVELOPERS](../DEVELOPERS.md) for the full index.
> Companion to [testing](dev-checks.md) — that page covers the `check` codeblock and the
> per-note script model; this one covers sweeping a whole notebook outside the per-note UI.

Rebuilt 2026-10-03 ("check sweep v2"). Design and decisions:
`claude:check_sweep_v2_design_2026-10-02.md`. Why the old version was replaced:
`claude:check_sweep_index_churn_2026-10-02.md`.

## What it's for

Notes you open are already checked as they render. A sweep catches problems in notes **nobody
opens**, mainly in notebooks that get published, before they go live.

## Where it runs

Inside nb-web, at `/api/check/sweep`:

| Call | Does |
|------|------|
| `POST {notebook, mode: "changed"}` | Re-check notes changed since the last sweep; merge into the stored result |
| `POST {notebook, mode: "full"}` | Re-check every note |
| `GET ?notebook=` | The last stored result (404 if never swept) |

Needs `user` level plus access to the notebook. One sweep per notebook at a time: a second POST
gets `409` with the last stored result.

Results are stored in `~/.nb/.logs/sweep/<notebook>.json`, which is gitignored and outside every
notebook repo, so a sweep can never move a notebook's HEAD.

**It never runs `nb`.** Notes come from a file walk (dotfiles and dot-directories skipped), paths
are known, and each note's checks are resolved server-side exactly as the browser resolves them
(`_note_check_tokens`, pinned to `main.js`'s `_virtualTestPrefix` by a test that runs the real
JavaScript). Concurrent `nb` processes are what corrupted `docs/.index` under the old sweep.

## Who triggers it

- **Publishing.** `NbWeb.publishWebsite` runs a `changed` sweep first. Clean → publishes. Errors
  or warnings → a dialog with **Fix first** (default, also Escape) or **Publish anyway**. If the
  sweep can't run at all, publishing goes ahead: a soft gate.
- **The Notebooks page.** Each swept notebook's row shows `⚠ N` when its last sweep found
  problems (red if any errors, yellow if only warnings; nothing when clean). The detail panel's
  **Checks** section lists the findings and has **Sweep now** (a full sweep).
- **Nightly, 03:17.** The systemd user timer `nb-check-sweep.timer` (`Persistent=true`, so a missed
  night runs at next boot) runs `~/.nb/.tools/check-sweep.py`, a thin client that POSTs a
  `changed` sweep for every notebook whose dotfile has `check_sweep: true`.

```bash
python3 ~/.nb/.tools/check-sweep.py                 # all check_sweep: true notebooks, changed mode
python3 ~/.nb/.tools/check-sweep.py --notebook docs --full
journalctl --user -u nb-check-sweep.service         # what the nightly run said
```

## What "changed" re-checks

- Notes changed since the last sweep's commit: committed, uncommitted, untracked, or renamed.
- Every note under a folder whose `.{folder}.md` changed (config cascades).
- A note whose annotation sidecar changed (annotation frontmatter feeds the note's meta).
- **Everything**, when the notebook's own `.{notebook}.md` changed, a check script or the global
  `.nb.md` changed, there's no previous sweep, the previous commit isn't in history any more, or
  the notebook isn't a git repo.

## Per-note and notebook-wide scripts

A script can only vary per note through `NB_NOTE_*` or `NB_FM_LINES`. One that never mentions
them, and sources nothing, gives the same answer for every note in a notebook, so the sweep runs
it **once** and reports it once, with the number of notes it applies to (`notebook_findings`).
Everything else runs per note (`note_findings`). Decided from the script's text, erring toward
per-note: a mention in a comment counts. As of 2026-10-03, 56 of 85 scripts are notebook-wide,
including every `hl-*`.

(The old sweep guessed this by sampling: "same result on two notes = notebook-wide". Two
*passing* notes look the same, so per-note checks were silently skipped after two passes.)

## Result levels

| Level | Meaning |
|-------|---------|
| `error` | Script exited 1 (or couldn't run) |
| `warn` | Script exited 2 |
| `skipped` | Script hit the time limit (`_CHECK_SCRIPT_TIMEOUT`, 30s). Says nothing about the note. |

The message is the first non-empty line of the script's output.

## Opting a notebook in

Add `check_sweep: true` to the notebook's own `.{notebook}.md`. That only affects the nightly
run; publishing sweeps any notebook being published, and **Sweep now** works on any notebook.
