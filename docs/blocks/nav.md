<!-- Generated from docs:blocks/nav.md by .tools/readme-export.py. Edit the source, not this file. -->

# nav — Folder Navigator

## Summary

A `nav` block renders a small, stateful file browser right inside the note: a breadcrumb trail
plus a list of folders and notes you click through, no page navigation involved. Point it at a
notebook folder, the current note's own folder, or — for admins — a raw filesystem path under
`~/.nb/`. Leave the fence empty and it opens at the top, listing every notebook.

## How it works

````markdown
```nav
accts:guide/
```
````

| Body | Navigates to |
|---|---|
| *(empty)* | Every notebook — click one to drill in (also where the `nb` breadcrumb segment returns to) |
| `.` | The current note's own folder |
| `notebook` | That notebook's root (same as `notebook:`, just without the colon) |
| `notebook:folder/path` | A specific folder (trailing slash optional) |
| `~/.nb/notebook/folder` | The same folder, written as a filesystem path |
| `~/.nb/.hidden-dir` | A raw filesystem listing of a hidden dot-folder (`.test`, `.templates`, …) |

Clicking a folder drills in; clicking a note opens it in the preview pane. Every breadcrumb
segment is clickable, including the root `nb` segment, which returns to the notebook list.

**Collapse state is keyed to the block's original body, not wherever you've navigated to** — so
a `nav` block written as `accts:guide/`, clicked three folders deeper then collapsed, reopens
the note still three folders deep and still collapsed, both remembered under the one key
`accts:guide/` was given, regardless of where you last left it.

**Hidden-dir browsing is admin-gated**, except `.lib` and `.images`, which stay world-readable —
the raw filesystem-listing form is meant for config/dev browsing (`.test`, `.checks`,
`.templates`), not general-purpose use.

## Reference

- No read/write level of its own — gated **by destination** (see
  [Access gates](../CODEBLOCKS.md#access-gates)): a notebook folder follows that notebook's
  own `access:`; a hidden dir needs `admin` unless it's `.lib` or `.images`. A 403 from the
  destination removes the block silently, the same as everywhere else in nb-web.
- No `+` (add) or `⎋` (open) controls on this block — browse and open only.
- In frontmatter (`nav: accts:guide/`) it shows in the note's header strip instead of the body.

## For developers

Renderer: `_loadNavBlock` (`plugins/nbweb-codeblocks.js`), query parsed by `_navParseQuery`.
Backed by `/api/notes` (notebook/folder mode), `/api/nb/notebooks` (empty/root mode), or
`/api/fs/list` (raw filesystem mode — the admin gate above is enforced there, server-side).
Already on the shared `_buildBarHeader`/`_initCollapseToggle` header, so it gets the universal
`?` and `↻` controls for free rather than building its own. Broader renderer architecture:
[codeblocks](../dev/dev-codeblocks.md) #REVIEW.
