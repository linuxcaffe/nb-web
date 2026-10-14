<!-- Generated from docs:blocks/toolbar.md by .tools/readme-export.py. Edit the source, not this file. -->

# toolbar — Shortcut Buttons

## Summary

Put `toolbar: true` in a note's frontmatter and a button for it appears in the list header,
next to the other list buttons, whenever that note's notebook is the one in the list. One click
opens the note, whatever folder or sort you're in, so it suits the notes you go back to all day:
a dashboard, a checklist, this month's books. `toolbar_icon:` picks the button's icon.

## How it works

```yaml
---
title: Job board
toolbar: true
toolbar_icon: 🧰
---
```

Pat's Job board has exactly this: switch the list to the
`features` notebook and the 🧰 in its header opens it, from any folder.

- **Which notes:** every note in the notebook with `toolbar: true`, in any folder; notes in
  dot-folders (`.templates/` and the like) don't count. Buttons come in path order.
- **The icon:** `toolbar_icon:` if set; otherwise the icon a plugin gives that kind of note;
  otherwise the note's type icon (📊 for a dashboard, 📘 for a topic…); otherwise 📌.
- **Hovering** a button shows the note's title.
- Saving a note refreshes the buttons, so adding or removing `toolbar:` shows at once.

## Reference

- Frontmatter only: there's no `toolbar` codeblock, and it doesn't cascade from folder or
  notebook config. Each note opts in for itself.
- You only get buttons for notes you can open: a note gated above your level, or in a folder you
  can't open, has no button.
- Any value YAML reads as true works (`true`, `yes`); remove the line or set `false` to drop the
  button.

## For developers

`/api/toolbar-notes?notebook=` (`api_toolbar_notes`, `app.py`) scans the notebook and filters by
access; `main.js` draws the buttons into `#nb-list-plugin-btns` when it renders the list
(`_fetchToolbarNotes`, cached per notebook in `_toolbarCache`, cleared on save). The plugin icon
comes from `NbWeb.getListItemIcon`. Codeblock architecture: [codeblocks](../dev/dev-codeblocks.md) #REVIEW.
