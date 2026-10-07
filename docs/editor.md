<!-- Generated from docs:editor.md by .tools/readme-export.py. Edit the source, not this file. -->

# Editor

## Summary

Click **Edit** (or press `e`) to edit the open note: its whole text, frontmatter included,
appears in a plain Markdown editor. `Ctrl+Enter` saves and `Escape` cancels. The toolbar adds
line numbers, a Markdown cheat sheet and image embedding (`Ctrl+Shift+1`). Every save is a git
commit, so an earlier version is always in the notebook's history.

## How it works

The editor replaces the preview with the note's raw text, frontmatter block (`---` … `---`) at
the top. Save, and the preview shows the result.

### The toolbar

| Button | Does |
|---|---|
| **ln#** | show line numbers |
| **mkd ref** | a Markdown quick reference |
| **📷** | embed an image at the cursor: **Camera**, **Images** (pick one already in the notebook) or **Browse…** (`Ctrl+Shift+1`) |
| **Save** | save (`Ctrl+Enter`) |
| **Cancel** | discard changes (`Escape`) |

### When Edit isn't there

- **The type has no text to edit** (an image, a PDF, a spreadsheet…): no Edit button.
- **The folder or notebook is locked** (a `.nb-lock` marker): no Edit; a 🔒 says why.
- **The note is locked** (`lock: yes` in its frontmatter): Edit becomes **🔒 Unlock**. An
  unlocked note with a `lock:` key shows a 🔒 to lock it again.
- **Someone else is editing it**: Edit is greyed out and says who; **Edit anyway** still lets you
  in. This is a warning, not a lock; two people saving at once can still overwrite each other.

## Reference

- **Annotations** have their own editor: the **Edit** on the annotation box opens it below the
  note, so you can see both.
- **Encrypted notes** ask for their password before they show.
- **Plugins** can add editor keys (the cine plugin's `Ctrl+[` inserts a shot in a scene).
- All editor keys: [Keyboard → Adding and editing](KEYBOARD.md#adding-and-editing).

## For developers

- [Frontmatter editor](dev/dev-frontmatter-editor.md)
- [Security and access](dev/dev-security.md)

`_openEditor`, `_computeEditGate` and the save path in `main.js`; nb-web `CLAUDE.md` invariants
59 (the Edit gate) and 60 (the in-use notice and overlay focus rules).
