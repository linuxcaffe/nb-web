<!-- Generated from docs:blocks/tw.md by .tools/readme-export.py. Edit the source, not this file. -->

# tw — Taskwarrior

## Summary

A `tw` block runs a Taskwarrior filter and shows the matching tasks as a live table in the note,
sorted by urgency. The body is a task filter (`project:kitchen +next`); columns for project,
priority, due and tags appear only when some task uses them. Each row has a ✓ to finish it and a
▶/◼ to start or stop its timer, clicking an id shows `task information`, and `+` opens a form to
add a task. The **task** label in the header opens Taskwarrior itself.

## How it works

````markdown
```tw
project:kitchen +next
```
````

The body is a Taskwarrior filter, the same words you'd type before a report: tags (`+next`,
`-waiting`), attributes (`project:kitchen`, `priority:H`, `status:pending`), and ranges
(`due.before:eow`). It is only ever a filter: a word that names a Taskwarrior command is refused,
so a block can read tasks but never run other task commands. Tasks come back sorted by urgency,
highest first.

**Columns.** Id and description always show; project, priority, due and tags appear only when at
least one task in the result has them. Fix the columns yourself with a `columns:` line in the
body:

````markdown
```tw
columns:id,description,due
+work
```
````

**Rows.** Due dates are tinted (overdue, soon, later) and a started task is highlighted. Per row:

| Control | Does |
|---|---|
| ✓ | marks the task done (it fades out) |
| id | shows `task information` below the row; click again to close (one open at a time) |
| ▶ / ◼ | starts or stops the task's timer |

**Adding a task (`+`).** Opens a form under the header: description, project, a date (due,
scheduled, wait or until, with a date picker), priority and tags. It adds the task with your
account's own `task`, so you can only create what you could create by hand.

**The task label.** Clicking it opens Taskwarrior as set in Settings → Codeblocks: in the
terminal, or in [tw-web](https://github.com/linuxcaffe/taskwarrior-web) if a web command is set
(until it's set, the click opens that setting). An admin script `.lib/open-block-tw-<level>.sh`
takes over the click when present.

**In a reports note.** A body of `source:` / `filter:` / `timeframe:` lines reads the `tw` blocks
of another note (a project diary) sliced to a timeframe, instead of a plain filter; see
[CBQL](../dev/dev-cbql.md#cbql-read-path). #REVIEW

## Reference

- Needs `task` (Taskwarrior) on the server's `$PATH`. Without it the block shows a short card
  saying what to install.
- Reads your live Taskwarrior data (the server's `~/.task`); there's no per-note task file yet,
  the way `hl` has `journal:`.
- Anyone who can see the note can read a `tw` block (an admin can still limit it with
  `codeblock_access: tw: {read:}`, see [Access gates](../CODEBLOCKS.md#access-gates)); adding,
  finishing, starting or stopping a task needs at least a `user`-level account.
- In frontmatter (`tw: +work`) it shows in the note's header strip instead of the body.

## For developers

Renderer: `_loadTwBlock` / `_buildTwTable` (`plugins/nbweb-codeblocks.js`), reports-note variant
`_loadTwCBQLBlock`; backed by `/api/task-query` (read) and `/api/task-add` · `/api/task-action` ·
`/api/task-info` (write and detail). A filter is screened by `_tw_filter_args` in `app.py` so it
can name no Taskwarrior command, alias or `rc` override. Taskwarrior domain notes: the
`taskwarrior` skill.
