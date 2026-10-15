<!-- Generated from docs:blocks/check.md by .tools/readme-export.py. Edit the source, not this file. -->

# check — Embedded Checks

## Summary

A `check` block runs one or more check scripts from `~/.nb/.checks/` and shows the result in the
note — no terminal needed. Give it a script name with no label and it runs as the note renders,
staying invisible when all is well and surfacing only on a problem; give it a label and it becomes
a button you click. It's how a note carries its own health check: a dashboard that's blank until
something needs attention.

## How it works

A `check` block's body is one or more script names (the `.sh` is optional). There are four forms:

**On demand — with a label.** Renders a `▶ <label>` button; clicking runs the script and shows
its output.

````markdown
```check
hl-recent-txn | Recent transactions
```
````

**Automatic — no label.** Runs as the note renders. **Exit 0 with no output → the block
disappears entirely**; any output or a non-zero exit renders as Markdown. A note with several of
these is blank when everything is healthy.

````markdown
```check
hl-ok
```
````

**A group — several scripts, one per line.** All run in parallel; all pass → the block vanishes;
any fail → an `N of M checks failed` header with a row per failure. A `| Label` line (on its own,
or after the first script) makes the group an on-demand button instead.

````markdown
```check
hl-ok
nb-dirty
tw-due
```
````

**A family — a dangling dash.** A name ending in `-` runs every matching script, so adding a
`nb-schem-size.sh` to the family makes it appear with no edit to the note.

````markdown
```check
nb-schem-
```
````

**Where scripts live.** All check scripts are in `~/.nb/.checks/`, named by domain
(`hl-` hledger, `nb-` nb/nb-web, `tw-` Taskwarrior, `note-` system), with families adding a second
hyphen (`hl-budget-`, `nb-schem-`). Browse them with a `nav` block:

````markdown
```nav
~/.nb/.checks
```
````

**`check:` as a config directive.** The same names in a notebook or folder config's `check:` key
run automatically on every note in scope, as if each had an unlabelled block — a policy you set
once, not a block you paste into every note.

```yaml
# in a .notebook or .folder config note
check: |
  nb-dirty
  note-disk-warn
```

**Status notes.** A note of nothing but automatic blocks (`accts:status.md`) has no footprint
when healthy; `{{inline: accts:status.md}}` at the top of any note surfaces its failures there,
with the host note's context — so `nb-dirty` reports on the notebook you're actually in. In a
`type: book`, failing checks in chapter notes show as `⚠` entries in the table of contents; see
[Books](../BOOKS.md) and [Inline includes](../inline-includes.md).

## Reference

- A script's first output line should be a headline (`**Name** — why`, or a `### ⚠` heading so a
  book TOC picks it up); see `.rules/checks.md`.
- Running a check needs a `user`-level account. Check scripts live in `.checks/`, which only a
  tech account may write (invariant 80) — so the scripts are trusted and admin-authored; a block
  only names one, it can't define one.
- Automatic (ambient) checks run last, after the rest of the note, deferred; only
  frontmatter/config (`check:`) checks reach the status badge, body checks render in place
  (invariant 20).
- Config `check:` cascades global → notebook → folder → note; it has no frontmatter-strip
  (toolbar) form — it's a policy directive, declared in config notes.

## For developers

Renderer: `_loadTestBlock` (`plugins/nbweb-codeblocks.js`, lang `check`; the header's `?` still
uses the legacy `block:test` context, hence both in `help_for:`); deferred by `_deferCheckBlocks`
(`main.js`). Backed by `/api/check/run`, `/api/check/batch`, `/api/check/glob`, `/api/check/sweep`;
`_check_script_path` resolves the name under `CHECK_DIR`. The sweep never runs `nb`, and
`_note_check_tokens` (py) / `_virtualTestPrefix` (js) are twins (invariant 63). Authoring a check:
the `checks` skill, `.rules/checks.md`, [dev-checks-authoring](../dev/dev-checks-authoring.md). #REVIEW
