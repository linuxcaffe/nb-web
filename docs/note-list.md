<!-- Generated from docs:note-list.md by .tools/readme-export.py. Edit the source, not this file. -->

# Note list and preview

## Summary

The left pane lists the notes in the current notebook or folder; click one (or move with the
arrow keys) to show it on the right. Folders come first, then pinned notes, then the rest. The
row above the list filters by type (notes, bookmarks, todos, contacts, folders, images), the
**⇅** button changes the sort, and Ctrl-click selects several notes to move, export or delete
together. Notes pinned in their frontmatter (dashboards, usually) come first, then ones you pin
from the menu.

## How it works

Each row shows a note's icon, title and first line; its number is its position in the folder's
`.index`. Clicking a folder opens it, and the breadcrumb above the list shows where you are: click any part
of it, or press `←`, to go back up. Opening a link to a note (a bookmark, a shared URL, a refresh)
shows that note's notebook and folder in the list.

### Filtering by type

The chips under the toolbar show one kind of item: **all**, 📝 notes, 🔖 bookmarks, ✔ todos,
🪪 contacts, 📂 folders, 🌄 images. With todos, **open** / **closed** narrow it further. The
counts above the list break the current view down by type.

### Sorting

**⇅** sorts the list:

| Sort | Order |
|---|---|
| Default | newest added first |
| A → Z, Z → A | by title |
| Newest first | most recently added first |
| Oldest first | the notebook's own order (`.index`): use it for hand-ordered notebooks |

Plugins can add sorts of their own (the hledger plugin adds **Account hierarchy**). The button
lights up when the sort isn't the notebook's default; a notebook sets its default with `sort:` in
its config, see [Notebooks → Defaults](NOTEBOOKS.md#defaults).

### Pinned notes

There are two kinds of pin, and the list shows them in this order, under the folders:

1. **Pinned in the note**: `pinned: true` in its frontmatter (a dashboard usually is), or the
   note a folder's config names with `pinned: <name>`. The same in every browser. Opening a
   folder selects its first one, so a folder with a dashboard opens on it.
2. **Pinned from the menu**: the preview menu's **📌 Pin to list top**, remembered by this
   browser only.

**📌 Unpin from list** undoes either. For a note pinned in its frontmatter it leaves `pinned:`
blank rather than deleting the line, so you can still find formerly pinned notes with an `fm`
query on `pinned:`.

### Selecting several notes

Ctrl-click (Cmd-click on a Mac) adds a note to the selection; Shift-click selects a range. The
preview then offers **Move**, **Export** and **Delete** for all of them. `Escape` clears the
selection.

## Reference

- **List options (☰)**: *Show filenames* instead of titles, *Light mode*, *Import files…*,
  *Link file…*.
- **Plugin buttons**: plugins add buttons to the list header (⚙ the archive panel, ⚡ the
  wizard panel).
- **Keyboard**: `↑`/`↓` move through the list, `→`/`Enter` go into the preview or a folder, `←`
  goes back up; see [KEYBOARD](KEYBOARD.md).
- **The preview** renders Markdown, images, audio, video, PDFs and more, each by its type; see
  [TYPED-NOTES](TYPED-NOTES.md).

## For developers

- [Notebook config: list defaults](dev/dev-notebook-config.md#list-defaults)
- [Architecture: excerpts](dev/dev-architecture.md#excerpt-rendering)

`_list_notes` (`app.py`) builds the list; `renderList` and `_getSortedNotes` (`main.js`) draw and
sort it; the list header menus and multi-select live in `ui-chrome.js`.
