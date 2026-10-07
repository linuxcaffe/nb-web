<!-- Generated from docs:FOLDER-CONFIG.md by .tools/readme-export.py. Edit the source, not this file. -->

# Folder config

## Summary

A folder can carry its own settings in a hidden note named after it: `projects/.projects.md` for
the `projects` folder, `.work.md` at the top of the `work` notebook. Its frontmatter sets things
like who may see the folder (`access:`), which note it opens on (`pinned:`), its tab strip
(`tabs:`) and field rules for its notes (`constraints:`). Settings pass down to every subfolder
and note below, and the nearest one wins, so you only write down what's different.

## How it works

Each setting is looked up from the note outwards, and the first place that sets it wins:

```
the note's own frontmatter
  → .{folder}.md        the note's folder
    → .{parent}.md      each folder above it
      → .{notebook}.md  the notebook's top level
        → ~/.nb/.nb.md  every notebook
```

Every level is optional. Settings that are blocks of their own (`constraints:`, `hledger:`) merge
key by key rather than replacing each other, so a folder can add one field rule without repeating
its parent's.

The config note lives *inside* the folder it configures, so moving or copying a folder takes its
settings along. The leading `.` keeps it out of the note list; it's still a note, opened and
edited like any other, by anyone who can write in that folder. (Only `~/.nb/.nb.md` and the
hidden folders at the top of `~/.nb`, such as `.rules` and `.lib`, need an admin.)

A folder usually pairs its config with a **dashboard**, a visible note with the same name
(`projects.md` beside `.projects.md`) that's pinned, so the folder opens on it. A `cfg` block on
the dashboard shows the folder's settings and where each one comes from:

````
```cfg
.
```
````

Not every setting reaches every note. Some are read straight from the config by the feature that
needs them (a notebook's `sort:`, `hledger:`, `website:`); the rest pass down to each note.

## Reference

| Key | Where | Effect |
|-----|-------|--------|
| `access:` | any level | lowest account level that may see the notes: `guest`, `user`, `office`, `admin`, `tech` |
| `pinned:` | folder | note to show first, and open on arrival (a dashboard sets `pinned: true` itself instead) |
| `tabs:` | any level | a tab strip on every note below ([Tab strip](tabs.md)) |
| `ui_hide:` | any level | hide `fm` (the frontmatter table), `annotation` (the notes foot), or both: `fm,annotation`; the toolbar's ◉ button still shows them on one note |
| `sort:` | notebook | default list sort: `title`, `za`, `newest`, `oldest` (`.index` order) |
| `help_header:`, `help_add:` | any level | the `?` popover's top line and extra topics ([Help](help.md)) |
| `check:`, `check_add:` | any level | which checks run on the notes ([Checks](CHECKS.md)) |
| `constraints:` | folder | field rules for the folder's notes (below) |
| `default_type:` | folder | the note type `constraints:` is checked against |

### Constraints

```yaml
default_type: shot
constraints:
  alias:
    required: true
    pattern: '^\d+[a-z]+'
  day_night:
    type: enum
    values: [D, N]
  notes:
    type: multiline
  loc: scene.loc
```

The toolbar's **FM** button (edit frontmatter fields) shows each rule as an input, for the
fields the note has: `enum` (or `select`) with `values:` a
drop-down, `bool` a checkbox, `date` a date picker, `multiline` (or `area`) a text box, anything
else a line of text. A value like `scene.loc` shows that field read-only, taken from another
note.

The `nb-check-front` check reports notes that break the rules: an empty `required:` field, a
value that doesn't match `pattern:` (a regular expression), or one that isn't in `values:`. It
only checks notes whose `type:` is the folder's `default_type:`, and skips folders without one.

A note can adjust its folder's rules in its own frontmatter: `constraints:` replaces the folder's
rule for a field, `constraints_add:` adds rules for fields the folder doesn't mention.

## For developers

- [Notebook config](dev/dev-notebook-config.md): the resolution functions and every key
- `_folder_config` / `_notebook_config` (`app.py`) walk and merge; `_merge_configs` merges nested
  blocks. Which keys reach a note is the `effective_*` list in `api_note` (CLAUDE.md invariant 15).
- Constraints: `_load_constraints` (`/api/note/constraints`, the FM form, full cascade) and
  `api_note_constraints_full` (immediate folder plus the note's own `constraints:` /
  `constraints_add:`, invariant 38); widgets in `nbweb-codeblocks.js` (`_fmWidget`); validation in
  `~/.nb/.checks/nb-check-front.sh`.
