<!-- Generated from docs:TEMPLATES.md by .tools/readme-export.py. Edit the source, not this file. -->

# Templates

[Storage](#storage) · [Placeholders](#placeholders) · [Using Templates](#using-templates) · [Saving a Note as a Template](#saving-a-note-as-a-template) · [Default Template per Notebook](#default-template-per-notebook) · [Schema Validation](#schema-validation)

---

## Storage

Templates are plain Markdown files stored in `.templates/` directories. nb-web merges both scopes and shows them in the **Template** picker in the Add bar.

| Location | Scope |
|----------|-------|
| `~/.nb/.templates/` | Global — available in all notebooks |
| `~/.nb/<notebook>/.templates/` | Local — that notebook only; overrides a global template of the same name |

---

## Placeholders

Templates use `{{placeholder}}` syntax, substituted once, at note-creation time. For a *live*,
re-resolved-on-every-render equivalent usable anywhere in prose (not just templates) — including
`day` and `weather` by the same name — see [Inline live queries](inline-queries.md).

| Placeholder | Resolves to |
|-------------|-------------|
| `{{title}}` | Note title (from the Title field) |
| `{{name}}` | Alias for `{{title}}` — used by some notebook-scoped templates |
| `{{input}}` | Alias for `{{title}}` — same value, named for "whatever the user typed" |
| `{{tags}}` | Hashtag list (from the Tags field) |
| `{{content}}` | Body text (from the Content field) |
| `{{date}}` | `YYYY-MM-DD` |
| `{{day}}` | `Saturday, May 9, 2026` |
| `{{time}}` | `HH:MM` |
| `{{weather}}` | wttr.in one-liner (fetched lazily, cached 1 h) |

This is a fixed set — resolution is a plain literal-string replace over the template
text, not a scripting language. There is no shell/`eval` step and no arbitrary
`$(command)` substitution; unrecognized `{{placeholder}}` text is left in the note
as-is. A template can still contain real Markdown, frontmatter, and fenced codeblocks
freely — those just aren't placeholders.

## Naming convention — `typename.md`

Global templates follow a simple naming rule: **the template filename is the type name it produces.**

| File | Creates notes of type |
|------|-----------------------|
| `~/.nb/.templates/note.md` | `type: note` |
| `~/.nb/.templates/dotfile.md` | `type: dotfile` |
| `~/.nb/.templates/dashboard.md` | `type: dashboard` |
| `~/.nb/.templates/daily.md` | `type: daily` |
| `~/.nb/.templates/invoice.md` | `type: invoice` |

This means the Template picker label alone tells you what kind of note you'll get. Local (per-notebook) templates can use any name — the convention only applies to globals.

---

### Built-in global templates

| Template | Purpose |
|----------|---------|
| `note.md` | Generic dated note with title, tags, content placeholders |
| `dotfile.md` | Folder/notebook config — FM skeleton + `cfg: org` + `cfg: tree` pre-wired |
| `dashboard.md` | Notebook dashboard with gallery, nav block, and links section |
| `daily.md` | Daily log starter |
| `invoice.md` | Timesheet-style invoice header |

---

## Using Templates

The **Template** picker appears in the Add opts bar when the note type is *note* or *todo*. Select a template to load a read-only preview of its raw content in the preview pane — confirming you have the right one before committing.

Once selected, the 📋 button lights up in the opts bar. Click it to browse all templates or revert to a blank note.

---

## Saving a Note as a Template

Open any note → **☰** (note menu) → **Save as template…**

A bar appears below the toolbar where you name the template and choose scope:

- **Notebook** — saves to `~/.nb/<current-notebook>/.templates/`
- **Global** — saves to `~/.nb/.templates/`

The note's raw Markdown is saved as-is, including any existing placeholders, so you can iterate on a template by editing it in nb-web and re-saving.

---

## Default Template per Notebook

If a notebook's local `.templates/` directory contains **exactly one** template, nb-web treats it as that notebook's default and pre-applies it automatically whenever you open **Add** while that notebook is active.

When two or more local templates exist, auto-apply is suppressed and you pick manually.

### Setting a default from the Templates view

Open **Menu → Templates**, select any template, then use the notebook selector and **📌 Set default** button in the preview footer. This copies the template into `~/.nb/<notebook>/.templates/`, making it the auto-default (or one of the picker options if others already exist there).

### Example: contacts notebook

Place a single contact template at `~/.nb/contacts/.templates/contact.md`. Every time you open **Add** while the contacts notebook is active, nb-web silently pre-applies it — just type the contact's name and press Save.

See [NOTEBOOKS](NOTEBOOKS.md) → Defaults for how template defaults interact with per-notebook sort and list-type settings.

---

## Schema Validation

Templates double as **validation schemas**. Any template whose frontmatter uses the
conventions below can be passed to `nb-check` to audit an entire folder of notes for
missing or malformed fields.

### Template field conventions

| Template value | Meaning |
|----------------|---------|
| `~req` | Required — any non-empty value |
| `A\|B\|C` | Required — value must be one of the listed options (case-insensitive) |
| *(empty)* | Optional |
| *(literal value)* | Optional with example — not enforced (e.g. `type: shot`) |

A pipe-separated list acts as both "required" and "must be one of these values."
Only free-text required fields need the explicit `~req` sentinel.

### Example — shot template

```yaml
---
scene:     ~req
shot:      ~req
day_night: N|D
int_ext:   I|E
title:
day:
loc:       ~req
desc:      ~req
tech: |
  camera: 
  sound: 
  lights: 
  grip: 
art: |
  props: 
  hair: 
  wardrobe: 
cast: |
  actors: 
  extras: 
type:      shot
seq:
lock:
---
```

`scene`, `shot`, `loc`, and `desc` are required free-text. `day_night` and `int_ext`
are required enums. Block-scalar fields (`tech`, `art`, `cast`) are optional containers
for sub-fields — they are treated as a single value by the validator.

### nb-check — the validation script

`~/.local/bin/nb-check` reads a template, derives its schema, then checks every
matching file in a folder and reports issues.

```bash
# Report all issues in shots/ against the shot template
nb-check ~/.nb/Takeout/.templates/shot.md ~/.nb/Takeout/shots/

# Auto-fix safe issues; prompt interactively for missing required fields
nb-check ~/.nb/Takeout/.templates/shot.md ~/.nb/Takeout/shots/ --fix

# Also warn about fields present in notes but absent from the template
nb-check ~/.nb/Takeout/.templates/shot.md ~/.nb/Takeout/shots/ --strict

# Check all files regardless of type: field
nb-check ~/.nb/Takeout/.templates/shot.md ~/.nb/Takeout/shots/ --all-types
```

**Auto-detected type filter** — if the template itself contains a literal `type:` field
(e.g. `type: shot`), nb-check only validates files whose `type:` matches. Other files
in the same folder are skipped silently (count reported in the summary). Pass
`--all-types` to disable this filter.

**Issues detected:**

| Severity | Code | Description |
|----------|------|-------------|
| error | `required_missing` | Required field absent or empty |
| error | `bad_enum` | Enum field value not in allowed set |
| error | `orphaned_continuation` | Value on next line (`day:\n1`) — malformed YAML |
| error | `heading_before_fm` | Markdown heading before `---` frontmatter |
| error | `parse_error` | YAML parse failure or missing `---` delimiters |
| warn | `case_mismatch` | Enum value has wrong case (`n` instead of `N`) |
| warn | `unknown_field` | Field in note not present in template (--strict only) |

**Auto-fixable with `--fix`:** case normalization, orphaned continuation lines,
heading-before-frontmatter removal. Missing required fields prompt interactively in
the terminal.

### Template as single source of truth

The template file is the canonical definition for a note type. Editing the template
changes the validation spec immediately — no separate schema file to keep in sync.
The same template is also used as the scaffold for **Create New** notes in nb-web,
so required fields (`~req`, enums) guide both creation and validation.

To add a required field to a shot: edit `~/.nb/Takeout/.templates/shot.md`, set its
value to `~req` or `A|B`, then run `nb-check` to surface gaps in existing notes.

---

Developer internals: [templates](dev/dev-templates.md)
