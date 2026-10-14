<!-- Generated from docs:blocks/fm/edit.md by .tools/readme-export.py. Edit the source, not this file. -->

# fm edit — the Frontmatter Form

## Summary

The frontmatter form edits a note's fields without touching YAML: one row per field, with a
dropdown, checkbox, date picker or text box depending on what the folder says the field is. It
also offers the fields the folder expects that the note doesn't have yet. Open it with the
toolbar's **FM** button on any note, or put an `fm` block with `edit` in a note to give it its
own button.

## How it works

````markdown
```fm
edit |Edit this job
```
````

This shows a button labelled with the text after `|` (**fm-edit** if there's none). Clicking it
opens the same form as the toolbar's **FM** button, for the note you're viewing. (In a chapter
pulled into a book with `{{inline:}}`, that's the book.)
Jones kitchen has one to try.

**The rows.** Each top-level `key: value` line of the note's frontmatter gets a row. Multi-line
values (`key: |`) and nested lines aren't shown, and stay as they are. A list shows as its text,
`[kitchen, acme]`, and saves as you type it.

**The widgets** come from the folder config's `constraints:` (see
[Folder config: constraints](../../FOLDER-CONFIG.md#constraints)):

| In `constraints:` | Widget |
|---|---|
| `type: enum` with `values: [a, b]` | a dropdown |
| `type: bool` | a checkbox |
| `type: date` | a date picker |
| `type: multiline` | a text area |
| anything else | a text box |

A value that isn't one of the dropdown's choices is kept as an extra choice, so opening the form
never changes it.

**Fields the note doesn't have yet.** The fields the folder declares that are missing from this
note come after the others, marked as new. They're saved only if you fill them in. A field the
folder marks `required: true` has a `*`.

**Save** (or `Ctrl+Enter`) writes the fields and reopens the note; **Cancel** (or `Escape`) closes
the form. Nothing below the frontmatter changes.

## Reference

- The declared fields come from the note's own folder config only, not from folders further up.
  A note can add its own with `constraints:` (replaces the folder's rule for that field) or
  `constraints_add:` (only for fields the folder doesn't mention).
- The form doesn't check `required:` or `pattern:`; the `nb-check-front` check reports notes
  that break them.
- A note with no frontmatter at all has no **FM** button; add a first field in the editor.
- A locked note (`lock: yes`, or a locked folder) has no **FM** button, and saving from a block
  is refused.
- `changes` is the old name for `edit` and still works.

## For developers

One form builder, `_fmEditForm` (`plugins/nbweb-codeblocks.js`, exported as
`NbWeb.fmUtils.form`), serves both the toolbar button (`main.js`) and the block (`_loadFmEdit`).
It reads `/api/note`, `/api/note/constraints` (widgets) and `/api/note/constraints-full`
(declared fields), and saves the whole note with `PUT /api/note` after patching the frontmatter
lines (`_fmPatch`). More: [frontmatter editor](../../dev/dev-frontmatter-editor.md) #REVIEW.
