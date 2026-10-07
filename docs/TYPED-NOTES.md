<!-- Generated from docs:TYPED-NOTES.md by .tools/readme-export.py. Edit the source, not this file. -->

# Typed Notes

[Overview](#overview) · [Setting a Type](#setting-a-type) · [Type Reference](#type-reference) · [Dashboard and Dotfile Pairs](#dashboard-and-dotfile-pairs) · [Project and Report Pairs](#project-and-report-pairs) · [Project Notes](#project-notes) · [Type Help Popovers](#type-help-popovers)

---

Notes with a recognised `type:` frontmatter value get a **rich header strip** rendered above the note body — an icon, a label, and contextual pills drawn from other FM fields. The strip replaces the plain title display and makes the note's role immediately visible without reading the body.

This is provided by the **NbWeb-specialty** plugin, loaded globally for all notebooks.

---

## Setting a Type

Add `type:` to any note's frontmatter:

```yaml
---
title: Hansen House — Phase 1
type: project
status: active
client: Hansen Family
---
```

If the type is recognised, the specialty header renders automatically when the note is opened. Unknown types fall back to plain rendering.

---

## Type Reference

| Type | Icon | Header shows |
|------|------|-------------|
| `project` | 🏗️ | Status pill · client · **+ Today** date button |
| `report` | 📊 | Status pill · client |
| `invoice` | 🧾 | Invoice number · due date · status pill |
| `quote` | 📋 | Status pill · client |
| `budget` | 💰 | Status pill · client |
| `reports` | 📊 | Actions injected by accounting plugin (Quote · Invoice buttons) |
| `tools` | 🔧 | Label only |
| `materials` | 📦 | Label only |
| `transport` | 🚗 | Label only |
| `dashboard` | 🗂️ | File count · folder count · sync status · config link |
| `dotfile` | ⚙️ | Scope · parent name · field count · dashboard link |

**FM fields used by the header** — declare these in frontmatter to populate the pills:

| Field | Used by |
|-------|---------|
| `status:` | project, report, invoice, quote, budget |
| `client:` | project, report, quote, budget |
| `invoice_num:` | invoice |
| `due:` | invoice |
| `help:` | any — adds **?** button; see [TYPED NOTES](#type-help-popovers) |

---

## Dashboard and Dotfile Pairs

Every notebook and folder has a natural pair of notes:

| Note | Type | Role |
|------|------|------|
| `djp.md` | `dashboard` | Front of house — visible, pinned, shows live counts |
| `.djp.md` | `dotfile` | Back of house — hidden config, carries rules and access |

The **dashboard** header shows a live count of files and folders in the same scope, the current sync status (clickable to open the sync dialog), and a **[config]** link to its dotfile pair.

The **dotfile** header shows its config scope (global / notebook / folder), the parent name, a count of configured keys, and a **[dashboard]** link back to its front-of-house note.

nb-web derives the pair automatically from the filename: `djp.md` ↔ `.djp.md`. You don't wire them manually — the link is implicit in the `.` prefix convention.

See [FOLDER CONFIG](FOLDER-CONFIG.md) for how to create and edit config dotfiles.

---

## Project and Report Pairs

`type: project` and `type: report` are designed to work as a named pair:

| Note | Type | Role |
|------|------|------|
| `name.md` | `project` | Living document — accumulates freely, date-sectioned |
| `name-reports.md` | `reports` | Output page — holds one or more curated reports, hand-edited |

The project is the workspace; the reports page is what you show someone. Both get the specialty header, and each shows a navigation chip linking to the other. The naming convention (`-reports` suffix) is the only wiring required — no explicit link needed.

**Recommended frontmatter for the reports note:**
```yaml
---
type: reports
source: name.md
---
```

`source:` records which project this reports page belongs to. No `help:` key needed — `type: reports` alone gets the **?** button explaining the pair relationship automatically (see "Type Help Popovers" below).

---

## Project Notes

`type: project` gets one extra interactive element: the **+ Today** button in the header strip. Clicking it checks whether today's date heading (`## YYYY-MM-DD`) already exists in the note body — if not, it appends one before opening the editor. This keeps diary-style project logs organised without manual heading management.

The same behaviour is also available via `date_headers: true` frontmatter on any note type — see [foldable — Collapsible Headings](foldable.md).

---

## Type Help Popovers

Click the **?** at the far right of the preview toolbar for help on the note you're looking at. A
`type: project` note gets `.lib/help-type-project.md` automatically; docs topics can declare the
types, blocks and keys they explain with `help_for:`. How it all fits together, including `help:`
and `help_add:`: [Help](help.md).
