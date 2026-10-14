<!-- Generated from docs:blocks/nb.md by .tools/readme-export.py. Edit the source, not this file. -->

# nb — nb Panel

## Summary

An `nb` block embeds a small live panel about your notes. `notebooks` lists every notebook with
its note count and how long ago it changed, each one a click away; `backlinks` lists the notes
that wiki-link to the note you're reading. Both show only what your account may open.

## How it works

````markdown
```nb
notebooks
```
````

Two commands:

| Body | Shows |
|---|---|
| `notebooks` | every notebook, with its note count and last-changed age; the open notebook is highlighted, and clicking one switches the list to it |
| `backlinks` | the notes whose text contains `[[` this note's title `]]`; click one to open it |
| `backlinks 5` | the same, capped at 5 (the default is 20) |

**backlinks reads the open note.** It matches the title of the note you're viewing, so the same
`backlinks` block shows different results in each note; in a note with nothing linking to it, it
says so. It's most at home in a note's frontmatter (`nb: backlinks`), where it rides along in the
header strip of every note.

## Reference

- `notebooks` and `backlinks` both list only notebooks and notes your account is in scope for and
  may read; a restricted account never sees the rest.
- `backlinks` matches the title exactly as written between `[[` and `]]`; a note linked only by
  its filename stem or an `alias:` won't appear (that's how the wikilink resolver differs from the
  backlink scan).
- Unknown commands show a short error in the block; `notebooks` and `backlinks` are all it knows.
- An admin can gate it with `codeblock_access: nb: {read:}` (see
  [Access gates](../CODEBLOCKS.md#access-gates)).

## For developers

Renderer: `_loadNbBlock` with `_buildNbNotebooks` / `_buildNbBacklinks`
(`plugins/nbweb-codeblocks.js`), backed by `/api/nb/notebooks` and `/api/nb/backlinks` (ripgrep,
falling back to `nb search`); both filter results by `_notebook_in_scope` and `_can_access`
(invariant 79). nb domain notes: the `nb` skill.
