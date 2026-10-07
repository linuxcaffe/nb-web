<!-- Generated from docs:KEYBOARD.md by .tools/readme-export.py. Edit the source, not this file. -->

# Keyboard

## Summary

Most of nb-web works without the mouse. `↑`/`↓` move through the list and `→` steps into the
preview; `/` searches, `#` filters by tag, `a` adds a note and `e` edits the open one. `Escape`
always backs you out to somewhere safe. Shortcuts are single keys, so they only work when you're
not typing in a field.

## How it works

The arrow keys act on whichever pane has focus, the **list** or the **preview**.

### In the list

| Key | Does |
|-----|------|
| `↑` / `↓` | select the previous / next note (it opens in the preview) |
| `Page Up` / `Page Down` | jump 8 notes |
| `→` / `Enter` | move to the preview, or open a folder |
| `←` | go up a folder |
| `Delete` | delete the selected note (asks first) |

### In the preview

| Key | Does |
|-----|------|
| `↑` / `↓`, `Page Up` / `Page Down` | scroll |
| `Home` / `End` | jump to the top / bottom |
| `←` | back to the list |

### Anywhere (not in a text field)

| Key | Does |
|-----|------|
| `/` or `s` | jump to the search bar |
| `#` | jump to the tags field |
| `a` | open the **Add** bar |
| `e` | edit the open note |
| `l` | show the **List** |
| `p` | move to the preview |
| `n` | jump to the notebook selector |
| `c` | open the calendar |
| `C` | show **Contacts** |
| `T` | open the terminal |
| `,` | open Settings |
| `.` | show or hide the extras (frontmatter table and annotation) |
| `Backspace` | go back |
| `Escape` | close whatever is open, clear a selection, or leave a field |

### Adding and editing

| Key | Does |
|-----|------|
| `Enter` (Add bar) | create the note |
| `Ctrl+Enter` (Add bar) | create it and open it in the editor |
| `Ctrl+Enter` (editor) | save |
| `Escape` (editor) | cancel without saving |
| `Ctrl+Shift+1` (editor) | embed an image at the cursor |

## Reference

**`Escape` is the universal way out.** In a text field it leaves the field (and cancels an open
editor); otherwise it closes a menu, dialog or bar, or clears a multi-selection, and finally parks
focus on the Menu button, from where `Tab` and the arrows take you on.

**Hide the extras by default**: instead of pressing `.` each time, a note, folder or notebook can
set `ui_hide:` in its frontmatter or config:

```yaml
ui_hide: fm              # hide the frontmatter table
ui_hide: annotation      # hide the annotation
ui_hide: fm,annotation   # hide both
```

Set in a `.{folder}.md` or `.{notebook}.md`, it applies to every note there (see
[FOLDER CONFIG](FOLDER-CONFIG.md)); `.` still toggles it for the note you're on.

**Find text in a note**: `Ctrl+F` is the browser's own find.

## For developers

- [Architecture](dev/dev-architecture.md)

The key handler is in `ui-chrome.js` (one `keydown` listener on `document`); the editor's own keys
are in `main.js`. nb-web `CLAUDE.md` invariant 60 explains how dialogs must handle `Escape`.
