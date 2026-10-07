<!-- Generated from docs:TYPED-NOTES.md by .tools/readme-export.py. Edit the source, not this file. -->

# Typed notes

## Summary

`type:` in a note's frontmatter says what kind of note it is: `project`, `dashboard`, `invoice`
and so on. The list shows its icon, and many types get a **header bar** above the note: the
icon, the type's name, details taken from the note's frontmatter (status, client, due date) and
links to related notes, such as a folder's dashboard and its config. A type nb-web doesn't
know is simply shown as a plain note.

## How it works

```yaml
---
title: Hansen House, phase 1
type: project
status: active
client: contacts:hansen.md
---
```

Only types nb-web knows count; anything else is treated as a plain note (types come from nb-web
itself and from plugins, see Reference).

**Header bars.** Most headers show the note's `status:`, `client:` (a `contacts:` link shown by
name), `billing_type:` and `platform:` as pills. Clicking the icon at the left lists the typed
notes at the top of the notebook.

**[+]** at the right of a header opens a wizard that creates the notes and folders that go with
this one (a new project's folder, diary, reports page and config, say). The wizard is a note at
the top of the notebook named `.{type}-org.md` (`.project-org.md` for projects), or another one
named by `add_org:` in the note, or by `types: {project: {add_org: …}}` in the notebook's config.
`add_org_add:` in a folder or notebook config offers extra wizards beside it. No wizard, no
**[+]**.

**Dashboards and configs.** A folder's visible front page is a `type: dashboard` note (usually
named after the folder and pinned, so the folder opens on it); its hidden config is
`.{folder}.md`, `type: dotfile`.

- The **dashboard** header counts the files and folders beside it, shows the notebook's sync state
  (click to sync) and access level, has 🎨 to choose the notebook's theme, and a **config** link
  to the folder's config.
- The **config** header shows its scope (global, notebook or folder), the folder's name, how many
  settings it has, and a **dashboard** link back to the folder's dashboard.

See [Folder config](FOLDER-CONFIG.md) for what goes in the config.

**Projects and reports.** A `type: project` note is a running diary; its `type: reports` partner
holds the reports you show someone. They find each other by name (`hansen.md` and
`hansen-reports.md`), or by `source: hansen.md` in the reports note, and each header links to the
other. A reports note without `source:` offers **link…** to set it. The reports header also has a
timeframe picker, and the accounting plugin adds **Quote** and **Invoice** buttons. Full story:
[Project diaries and reports](PROJECT-REPORTS.md).

**Marker lines.** In a note with a header, a line such as `> MILESTONE: walls done` shows as a
marker bar, and an empty `> TODAY:` shows today's date and time.

## Reference

| Type | Icon | Header shows |
|------|------|--------------|
| `dashboard` | 🗂️ | config link, file and folder counts, 🎨 theme, sync state, access |
| `dotfile` | ⚙️ | dashboard link, scope, folder, number of settings |
| `project` | 🏗️ | reports link, status, client, billing type |
| `reports` | 📊 | project link, timeframe; Quote / Invoice (accounting plugin) |
| `report` | 📊 | status, client (a report on its own, without a project) |
| `invoice` | 🧾 | invoice number, due date, status |
| `quote`, `budget` | 📋, 💰 | status, client |
| `tools`, `materials`, `transport` | 🔧, 📦, 🚗 | the label |
| `topic`, `feature`, `doc` | 📘, 🎯, 📃 | the help system's docs, tour pages and reviewed docs ([Help](help.md)) |

Plugins add their own types (the film plugin's `scene`, `shot`, `actor`, `location` and others),
with their own cards rather than these headers.

## For developers

- Headers: `plugins/nbweb-specialty.js`. Four header builders, not one (dashboard, dotfile and
  reports build their own): CLAUDE.md's "Specialty headers" section. A plugin adds a type with
  `NbSpecialty.register(type, {icon, label})`.
- A new type must be in `_FM_TYPES` and `INDICATORS` (`app.py`) or it's silently a plain note
  (CLAUDE.md invariant 36; `report` was missing until 2026-10-07).
- The **[+]** wizard: `effective_add_org` (invariant 43).
