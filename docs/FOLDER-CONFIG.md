<!-- Generated from docs:FOLDER-CONFIG.md by .tools/readme-export.py. Edit the source, not this file. -->

# Folder Config

[How It Works](#how-it-works) · [Config File Location](#config-file-location) · [Schema](#schema) · [Constraints](#constraints) · [Dashboard Convention](#dashboard-convention) · [Editing Config Files](#editing-config-files)

---

Notebooks and folders can carry their own configuration — a hidden Markdown file with YAML frontmatter that controls access, default note type, sort order, and field constraints for that scope. Settings inherit from parent to child; you only need to declare what differs.

---

## How It Works

Configuration resolves by walking up the folder tree from the current note to the notebook root, then to the global config. The first value found for each key wins — closer wins over further:

```
note frontmatter
  → .{folder}.md       (current folder)
    → .{parent}.md     (parent folder)
      → .{notebook}.md (notebook root)
        → .nb.md       (global)
```

Every level is optional. Omit a config file at any level and that level is simply skipped. Only create a folder config when something genuinely differs from the parent.

---

## Config File Location

Config files live **inside the folder they configure**, as a hidden file named after that folder:

| Scope | File location |
|-------|--------------|
| Global | `~/.nb/.nb.md` |
| Notebook | `~/.nb/{notebook}/.{notebook}.md` |
| Folder | `~/.nb/{notebook}/{folder}/.{folder}.md` |
| Subfolder | `~/.nb/{notebook}/{folder}/{sub}/.{sub}.md` |

The hidden `.` prefix keeps config files out of the normal note list. Because the config travels inside its own folder, moving a folder preserves all its rules — no external references to update.

---

## Schema

```yaml
---
type: dotfile

default_type: shot       # type applied to new notes created in this folder
sort: alias              # default sort for the list panel (alias, title, date…)
access: user             # minimum access level; inherits from parent if omitted
pinned: items.md         # note to open when navigating into this folder
---
```

**`default_type:`** — sets the type for new notes added in this folder. The Add button uses this type automatically; the user can still override it per-note.

**`sort:`** — overrides the list panel sort order for this folder. Valid values match the sort options available in the list panel header.

**`access:`** — the minimum access level required to see notes in this folder. Valid levels: `guest`, `user`, `office`, `admin`, `tech`. Inherits from parent config if omitted.

**`pinned:`** — filename of the note to open automatically when navigating into this folder (the "dashboard" note).

**`ui_hide:`** — comma-separated list of extras to hide by default: `fm` (the frontmatter table), `annotation` (the annotation foot), or both (`fm,annotation`). Same cascade as everything else on this page — set it on one folder to apply it to every note underneath. The `.` key/◉ button in the preview toolbar still works as a one-off override for whatever note is currently open. See [Keyboard § Reference](KEYBOARD.md#reference) for the full extras-toggle behavior.

---

## Constraints

The `constraints:` block defines field rules for notes of the folder's `default_type`. Notes of other types in the same folder are not affected.

```yaml
constraints:
  alias:
    required: true
    pattern: '^\d+[a-z]+'
    note: Shot code — number + letter suffix, e.g. 4f
  day_night:
    required: true
    type: enum
    values: [D, N]
  day:
    required: false
    type: integer
    note: Leave empty for unscheduled shots
```

**Constraint types:**

| Type | Meaning |
|------|---------|
| `string` | Free text (default) |
| `integer` | Whole number |
| `boolean` | true / false |
| `enum` | One of a declared `values:` list |
| `multiline` | Multi-line text area |

**`pattern:`** — a regex the field value must match (strings only).
**`required: true`** — the field must be non-empty.
**`note:`** — human explanation shown in the editor; not enforced.

Constraints power the **Changes** button's guided form and the `nb-` check scripts that scan a folder for violations.

---

## Dashboard Convention

A folder commonly has two companions sharing the same stem:

| File | Role |
|------|------|
| `items.md` | Dashboard note — visible, pinned to top, shows live state |
| `.items.md` | Config dotfile — hidden, carries rules and access |

The config's `pinned: items.md` points to the dashboard. The dashboard's `config: .` codeblock shows the config chain at a glance. Together they form the complete face + policy of a folder.

---

## Editing Config Files

Config files are notes — open them in nb-web like any other note.

- **Changes button** — guided field-by-field form, driven by the constraints defined in the file. Safe for any access level; shows only declared fields.
- **Edit button** — raw YAML editor. Gated to `admin` level by default.

Navigate to a config file via the `cfg: .` codeblock on any dashboard note (shows the full config chain as a clickable tree), or by searching for `type: dotfile` in the fm codeblock to find all config files in a notebook.
