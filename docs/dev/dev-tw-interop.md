<!-- Generated from docs:dev/dev-tw-interop.md by .tools/readme-export.py. Edit the source, not this file. -->

# Taskwarrior ↔ nb-web: task notes

> Developer documentation for nb-web. See [DEVELOPERS](../DEVELOPERS.md) for the full index.
> Design narrative and decisions: tw_nb_interop_plan_2026-11-01.md (tw-nb-interop).
> Status: M1–M6 working (2026-11-01, tag `tw-nb-interop-m6`); refinements and the user topic
> (M9) still to come.

One Taskwarrior task (or recurring series) can have one note. Taskwarrior keeps the task;
the note, an ordinary nb note with `type: task`, keeps what you write about it.

## The pieces

| Piece | Where | Role |
|---|---|---|
| `tw.nb-plugin` | `~/dev/nb-plugins`, installed in `~/.nb/.plugins/` | `nb tw note/add/link/status/info`: finds or makes a task's note, links the two, mirrors the status. Works from the CLI with no nb-web. |
| `tasknotes:` | `~/.nb/tasknotes` | The default notebook, a folder per project (`tw.folder_depth`). `~/.task/notes` is a symlink to it. |
| `tw-tasknote-drift` | `~/.nb/.checks/` | Note-scoped check: status out of date, task not found, lost link. |
| tw-web `/embed-add` | `~/dev/tw-web/embed-add.html` | tw-web's own Add dialog on a page of its own, for nb-web to frame. |
| `NbTwAdd` | `nb-web/tw-add.js` | Opens that dialog over nb-web, then makes the note. |
| Task header | `plugins/nbweb-specialty.js` (`task` branch of the generic builder) | Live fields, ✓ ▶ ◼, +. |

## The link, both ways

- **Task → note:** an annotation `nb: <notebook>:<path>`, a path selector (never a numeric id,
  invariant 23). The plugin always writes the notebook.
- **Note → task:** frontmatter `tw: <uuid>`, or a list once a note is shared by several tasks
  (`nb tw link`). `tw_status:` (and `tw_end:`) mirror the task's status, written by
  `nb tw status`. A waiting task is stored as pending in 2.6; the note says `waiting`.

```yaml
---
type: task
tw: 0badc0de-1234-4abc-8def-0123456789ab
tw_status: pending
title: Retile the Jones kitchen
---
```

`type: task` is in `_FM_TYPES`; `_note_status()` turns `tw_status` into the list icon
(`INDICATORS` `task_<status>`: ☐ pending, ⏳ waiting, 🔁 recurring, ☑ completed, ✖ deleted).

## Adding a task from nb-web

nb-web doesn't copy tw-web's dialog: it **frames** it, so hooks, recurrence and parent links all
behave exactly as in tw-web, and new fields there appear here with no change.

1. Add bar ☑ Task (or the task header's +) calls `NbTwAdd.open({description, project, notebook})`.
2. `GET /api/tw/embed-url` gives `tw_web_url` (a setting: tw-web's origin as the *browser*
   reaches it, `scheme://host[:port]` only).
3. An overlay frames `<tw_web_url>/embed-add?description=…&project=…`. tw-web serves it with
   `Content-Security-Policy: frame-ancestors` naming the origin of tw-web's own `nb`
   annotation launcher, so **only that nb-web can frame it**.
4. The page posts messages to its parent (checked by origin and source): `tw-add-ready`,
   `tw-task-added {uuid, description, logged?}`, `tw-add-closed`.
5. On `tw-task-added`, `POST /api/tw/note {uuid, notebook}` runs
   `nb tw note <uuid> --porcelain [--notebook <nb>]` and returns `{selector, created}`.
   From home or All the note goes to `tasknotes:`; from any other notebook, there.

No `tw_web_url`, or no `tw-add-ready` within 6 s (tw-web down, or its `nb` launcher names
another origin), shows a message saying which, never a silent nothing.

## The task header

Both endpoints are **keyed by the note**, so a user reads or changes only tasks named by notes
they can read or write:

- `GET /api/tw/note-tasks?selector=`: exports the note's own `tw:` uuids (each must be exactly
  a uuid), hooks off. Read access to the note.
- `POST /api/tw/note-action {selector, uuid, action}`: `action` is done, start or stop; `uuid`
  must be one of the note's own. User floor, `tw` write level, note write access, `_locked`.
  Runs **with hooks on**, as tw-web's writes do (timelog on start/stop, recurrence on done,
  gittw, tw2nb's journal entry on done; stdin is empty so a prompting hook gets EOF), then
  `nb tw status <uuid>` mirrors the status into the note.

## Gates and invariants

- **`/api/tw/note`:** user floor, `tw` write level, account scope, notebook access, lock. The
  uuid is the only user value that reaches nb and must be exactly a uuid (invariant 82).
- **The nb lock:** `nb tw` takes nb-web's flock itself unless `NB_LOCK_HELD=1`. `run_nb` holds
  that lock and sets the variable, so call `nb tw` only through `run_nb` (invariant 83).
- **Two binaries, one data set:** the container runs its own `task` (Debian 12's 2.6.2) on the
  bind-mounted `~/.task`; tw-web uses the host's. Taskwarrior's file locking covers both.

## Tests

nb-web-tests: `test_tw_note_endpoint.py`, `test_task_type.py`, `test_tw_note_tasks.py`,
`test_check_tw_tasknote_drift.py`; e2e `tw-add.spec.js` and `tw-task-header.spec.js` (both stub
tw-web and Taskwarrior). tw-web: `tests/test_embed_add.py`, `tests/e2e/embed-add.check.cjs`.
nb-plugins: `tests/test_tw.py`.

Live checks with a scratch task fire the real hooks: a done task gets a journal entry in
today's daily note (tw2nb). Remove it afterwards. In 2.6.2, `purge` only sticks once
garbage collection has moved the deleted task to `completed.data`.
