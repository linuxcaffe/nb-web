<!-- Generated from docs:dev/dev-tw-interop.md by .tools/readme-export.py. Edit the source, not this file. -->

# Taskwarrior ↔ nb-web: task notes

> Developer documentation for nb-web. See [DEVELOPERS](../DEVELOPERS.md) for the full index.
> Design narrative and decisions: tw_nb_interop_plan_2026-11-01.md (tw-nb-interop).
> Status: M1–M6 working (2026-11-01, tag `tw-nb-interop-m6`); refinements and the user topic
> (M9) still to come.
> **Across stations** (nbnotes, syncing, the phone, nb Docs, finding the other app):
> [Task notes: the round trip across stations (dev)](dev-task-notes-round-trip.md).

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
- **The task's fields, for nb's search and sort** (2026-11-04): `title` (the description),
  `tw_project`, `tw_due` (a local date), `tw_priority` and `tags`, written when the note is made
  and on every `nb tw status`, in place (an unchanged task writes nothing). `tags` holds nb's own
  beside the task's; `tw_tags` records which came from the task. One-way: editing them in nb
  doesn't change the task.

```yaml
---
type: task
tw: 0badc0de-1234-4abc-8def-0123456789ab
tw_status: pending
title: Retile the Jones kitchen
tw_project: kitchen
tw_due: 2026-12-01
tags: [pat-smith, reno]
tw_tags: [reno]
---
```

**Deleting a task note** (2026-11-04). nb-web's Delete on a `type: task` note whose task is
open asks (`NbWeb.choose`): delete the note and keep the task (the default: `note-action`
`unlink`), delete both (`note-action` `delete`, hooks on), or keep it as a plain note
(`nb tw unlink`: `type: note`, frontmatter kept, `tw:` renamed `tw_was:`, so the plugin never
adopts it again). A closed task: the plain confirm, saying what still points at the note (a completed task's journal
entry; a deleted task's own link) and leaving the task alone. **An orphan** (its task deleted
elsewhere, or gone): the note is never deleted behind your back; the header's **Orphaned ⋯**
offers undelete (`note-action` `undelete`, only for a deleted task: 409 otherwise), keep it as a
plain note (`unlink`, which passes `--note` so it works for a purged task too) or delete the
note. Deletes that bypass nb-web (`nb delete`,
git) leave the task linked to nothing: `.checks/tw-tasknote-deleted.sh` in the `tasknotes:`
dashboard lists them, with `nb tw restore` (the note back from git), `nb tw unlink` or
`task <uuid> delete`. A link that only doesn't resolve here (another station's notebook), or a
move (git sees a delete), isn't reported.

`type: task` is in `_FM_TYPES`; `_note_status()` turns `tw_status` into the list icon
(`INDICATORS` `task_<status>`: ☐ pending, ⏳ waiting, 🔁 recurring, ☑ completed, ✖ deleted).

## Getting from one app to the other

nb-web's menu footer has **tw-web** and the `W` key; tw-web's has **nb-web** and the `N` key.
Each checks first, from a list of addresses (this device's saved one, its own setting, the usual
ports), and asks for this device's address when none answers: the lists and their order are in
[Task notes: the round trip across stations (dev)](dev-task-notes-round-trip.md#finding-the-other-app). nb-web's setting is `tw_web_url`
(via `/api/tw/embed-url`, `user` floor); tw-web's is its `nb` annotation launcher. Same tab, so
Back returns. In the bundle (`~/dev/tw-nb-bundle`: nb-web at `/`,
tw-web at `/tw/`, one origin) both stay in one window: tw-web names its files relatively
(`api/…`, never `/api/…`), each service worker keeps to its own caches (invariant 8), and
`tw_web_url` may carry the path (`http://localhost:5080/tw`).

## Adding a task from nb-web

nb-web doesn't copy tw-web's dialog: it **frames** it, so hooks, recurrence and parent links all
behave exactly as in tw-web, and new fields there appear here with no change.

1. Add bar ☑ Task (or the task header's +) calls `NbTwAdd.open({description, project, notebook})`.
2. `GET /api/tw/embed-url` gives `tw_web_url` (a setting: tw-web's address as the *browser*
   reaches it, `scheme://host[:port]` plus an optional plain path, such as `/tw` when a proxy
   serves tw-web beside nb-web on one origin; no query, fragment or `..`). Frame messages are
   checked against its origin (`new URL(url).origin`), not the whole setting.
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
- `POST /api/tw/note-action {selector, uuid, action}`: `action` is done, start, stop, delete or
  unlink (`nb tw unlink`, not a task command); `uuid`
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
`test_check_tw_tasknote_drift.py`, `test_check_tw_tasknote_deleted.py`; e2e `tw-add.spec.js`,
`tw-task-header.spec.js` and `tw-task-delete.spec.js` (all stub tw-web and Taskwarrior). tw-web: `tests/test_embed_add.py`, `tests/e2e/embed-add.check.cjs`.
nb-plugins: `tests/test_tw.py`, `test_tw_fields.py`, `test_tw_unlink_restore.py`.

Live checks with a scratch task fire the real hooks: a done task gets a journal entry in
today's daily note (tw2nb). Remove it afterwards. In 2.6.2, `purge` only sticks once
garbage collection has moved the deleted task to `completed.data`.
