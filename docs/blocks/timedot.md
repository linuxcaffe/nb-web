<!-- Generated from docs:blocks/timedot.md by .tools/readme-export.py. Edit the source, not this file. -->

# timedot — Time Journal

## Summary

A `timedot` block logs time in [hledger timedot format](https://hledger.org/timedot.html): an
account and a duration per line, grouped by date. In a note's body it shows your entries as you
wrote them, with an edit button; declared in frontmatter (`timedot: true`) it adds up every body
entry into an hours-by-account summary, with optional billing. Point it at an external `.timedot`
file and it reads and appends there instead.

## How it works

**Body block — your entries, verbatim.** A fence in the note body shows the entries exactly as
written; `✎` opens a textarea to edit them, Save writes them back into the note. This is the mode
for a project diary, where the hours live in the note and grow with it.

````markdown
```timedot
2026/06/24
djp:siding  ....  ; prepped surfaces
djp:siding  ....  ; first coat

2026/06/25
djp:siding  1.5   ; trim work
```
````

**FM barblock — the totals.** `timedot: true` in frontmatter adds a collapsible bar to the
header strip that collects every body block in the note and totals the hours by account, with a
date filter (`all` / `mo` / `wk`) and, if `rate:` is set, a billing column. Click the total to
open a per-account popover. It has no `+` (it reads from the body blocks, which have no single
write target — edit them with `✎`).

**Time formats**, freely mixed:

| Written | Means |
|---|---|
| `....` | dots — 15 min each, so four dots = 1 h (groups separated by spaces all count) |
| `1.5h` | decimal hours |
| `90m` | minutes |
| `1.5` | a bare number is decimal hours |

**Account names** can contain single spaces; it's **two or more spaces** that separate the
account from the time — `home laundry  2.5h` logs to `home laundry`, `home:laundry  2.5h` to the
colon hierarchy.

**Sections.** `##`, `###` or `####` headings (an optional `-` after the hashes) group entries
into collapsible blocks shown in the FM total; level-2 open, deeper ones collapsed, state kept in
the browser. Comment (`;`), task (`*`) and modeline (`//`) lines are skipped.

**Frontmatter keys.** `project: work:acme` prefixes bare entries and `:sub` accounts
(`....` → `work:acme  ....`, `:website` → `work:acme:website`); `rate: 85` turns on the `$`
billing column.

**External file mode.** `timedot_file: ~/path/time.timedot` points the FM barblock at a file
instead of the body — right when you already log with `t . i` from the CLI, or want one timesheet
shown in several notes. In this mode the `+` form is available and appends to the file (creating
it on first save); write an empty ` ```timedot ``` ` fence in the body as the placeholder. The
form takes a date (today by default), a time in any format, an optional `:sub` account, and a
comment; it adds a `YYYY/MM/DD` heading only when the day changes.

## Reference

- **File scoping** — two frontmatter keys redirect the time blocks to project files:
  `timelog_file:` for the [t](t.md) block, `timedot_file:` for this one. Set them on
  a note, or on a notebook's config note to scope every note in it; the `t` block's clock and this
  block's `+` then write the same pair of files. Defaults come from `~/.task/config/timelog.rc`.
- A `file:` must be a `.timedot`/`.journal`/`.timeclock` inside a notebook you can open; naming a
  path outside your notebooks needs a tech account (invariant 77). Appending or saving needs
  `user`.
- Needs no external tool for the block itself (nb-web parses timedot); `hledger` only if you also
  run reports over the file.
- In frontmatter (`timedot: true`) it rides in the note's header strip.

## For developers

Renderers: `_loadTimedotBlock` (body) and the FM-aggregate path, external-file variant
`_loadTimedotCBQLBlock` (`plugins/nbweb-codeblocks.js`); backed by `/api/t/timedot/content`,
`/api/t/timedot/append`, `/api/t/timedot/write` (all `@_time_file_gate`). Saving a `-gen` file
also stubs the project's master journal (`_ensure_journal_stubs`). Billing:
`docs:dev/dev-billing-milestones.md`. #REVIEW
