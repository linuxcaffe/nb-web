<!-- Generated from docs:TEMPLATES.md by .tools/readme-export.py. Edit the source, not this file. -->

# Templates

## Summary

A template is a note that new notes start from. Click **📋** in the **Add** bar to pick one; its
`{{title}}`, `{{date}}` and other placeholders are filled in as the note is created. Templates
live in a `.templates` folder: `~/.nb/.templates/` for every notebook, a notebook's own for that
notebook, or a folder's own for that folder. If a folder (or notebook) has exactly one template,
**Add** uses it without asking.

## How it works

**Where templates live**

| Folder | Used for |
|--------|----------|
| `~/.nb/.templates/` | every notebook (global) |
| `<notebook>/.templates/` | that notebook |
| `<notebook>/<folder>/.templates/` | that folder |

The **📋** picker (shown when adding a note) lists every template you can see, global and local,
with the notebook it belongs to.

**The default template.** When you open **Add**, nb-web looks in the current folder's
`.templates/`, then the notebook's. If the first one it finds holds exactly one template, that
template is applied straight away, and a note made from a folder's template is created in that
folder. With two or more, pick one with **📋**, or leave it blank.

**Placeholders** are replaced once, when the note is created:

| Placeholder | Becomes |
|-------------|---------|
| `{{title}}` (also `{{name}}`, `{{input}}`) | what you typed as the title |
| `{{date}}` | `2026-10-07` |
| `{{day}}` | `Wednesday, October 7, 2026` |
| `{{time}}` | `14:05` |
| `{{weather}}` | a one-line forecast (wttr.in) |
| `{{tags}}`, `{{content}}` | empty from the **Add** bar, which has no tags or content field |

Anything else in `{{ }}` is left as written: that's how a template can carry a live query such as
`{{fm: count docs: type:topic}}` into every new note. (The org-chart wizard fills in its own
`{{field}}`, `{{field|default}}` and `{{field:a|b}}` names; see the `add` block.) For values
that update every time the note is shown instead of once, see
[Inline queries](inline-queries.md).

Everything else in a template, frontmatter included, is copied as is. A template value such as
`status: draft` becomes the new note's value; one like `~req` (an old convention for "required")
is copied literally too. For required fields, use the folder's
[constraints](FOLDER-CONFIG.md#constraints) instead: the **FM** form then offers the field
and the check reports it missing.

**Making templates.** Open a note, then **☰ → Save as template…**:

- **Regular**: give it a name and choose **Notebook** (the note's notebook) or **Global**.
- **Annotation**: choose a notebook and folder. It's saved there as `.template-annotation.md`,
  and a new annotation on any note in that folder starts from it (with `{{title}}` the note's
  title).

**Menu → Templates** lists every template, annotation template and HTML export template. Select
one to preview it, then **Edit**, **Duplicate** (to any notebook and folder) or **Delete**.

## Reference

| Action | Needs |
|--------|-------|
| use or read a global template | any account |
| use or read a notebook's template | access to that folder |
| save, edit or delete a notebook's template | `user` level and access to that folder |
| save, edit or delete a global template | `admin` |

Global templates shipped with nb-web: `note`, `daily`, `dashboard`, `dotfile`, `project`,
`project-reports`.

## For developers

- [Templates (dev)](dev/dev-templates.md): generator functions and seeded templates (keep
  them in step: CLAUDE.md invariant 5)
- `_resolve_template_vars` (`app.py`) does the substitution; `/api/template/default` picks the
  default (`nav.js` `_applyDefaultTemplate`); `templates.js` is the picker and the Templates
  view; `/api/note/annotation-template` serves annotation templates.
- Access: `_template_path_ok` (CLAUDE.md invariant 74) gates every template endpoint.
- `nb-check` (in `~/.local/bin` on the author's machine, not part of nb-web) validates a folder of
  notes against a template written with the `~req` / `A|B` convention.
