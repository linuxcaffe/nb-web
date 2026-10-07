<!-- Generated from docs:SYSADMIN.md by .tools/readme-export.py. Edit the source, not this file. -->

# Sysadmin Corner

[The Split](#the-split) · [Dotfile Templates](#dotfile-templates) · [Dashboard Templates](#dashboard-templates) · [Admin Codeblocks](#admin-codeblocks) · [The Config Org Chart](#the-config-org-chart) · [Code Guards](#code-guards)

---

nb-web has two audiences living in the same notebook: the **creator** who writes notes, and the **sysadmin** who wires up the plumbing. The sysadmin corner is the set of tools, templates, and conventions aimed squarely at the second role.

---

## The Split

| Layer | File | Audience | What lives there |
|-------|------|----------|-----------------|
| Dotfile | `.notebook`, `.folder.md`, `.nb.md` | Sysadmin | `cfg: org`, access gates, checks, plugin config |
| Dashboard | `{notebook}.md` | Creator | `nav:`, `tw:`, `nb:`, live queries, shortcuts |

The dotfile is the **behind-the-scenes plumbing** — it sets policy, declares access levels, seeds type defaults, and is mostly invisible to everyday users. The dashboard is the **stage** — it surfaces live data and navigation in a way that makes sense for the notebook's purpose.

The goal: a creator opens the dashboard and gets straight to work. An admin opens the dotfile and gets straight to the controls.

---

## Dotfile Templates

The global template `~/.nb/.templates/dotfile.md` is the standard starting point for any new folder or notebook config. Select it from the **Template** picker when adding a note, or from **Menu → Templates**.

It comes pre-wired with:

- FM skeleton — `theme:`, `access:`, `default_type:`, `check:` and others commented out, ready to uncomment
- `cfg: org -C 2` — instant org chart on first open, no setup
- `cfg: tree` — folder structure below a divider

```yaml
---
type: dotfile
title: {{title}}
date: {{date}}
pinned: true
# theme: default
# access: user
# default_type: note
# check: |
#   nb-dirty
#   note-disk-warn
---
<!-- {{title}} — describe this folder here -->

​```cfg: org -C 2
​```
---
​```cfg: tree
​```
```

The template is deliberately lean — delete what you don't need, uncomment what you do. It's designed to be replaced, not curated.

See [TEMPLATES](TEMPLATES.md) for the full `typename.md` naming convention.

---

## Dashboard Templates

The dashboard (`{notebook}.md`) is creator-facing. Pre-load it with the blocks that matter for the notebook's purpose:

```yaml
---
title: My Notebook
type: dashboard
---
```

```markdown
`​``nav
.
`​``

`​``tw
project:myproject status:pending
`​``

`​``nb
backlinks
`​``
```

The dashboard should *not* contain `cfg:` or other admin blocks — those belong in the dotfile.

---

## Admin Codeblocks

These blocks are sysadmin tools — place them in dotfiles, not dashboards:

| Block | What it does |
|-------|-------------|
| `cfg: org` | SVG org chart of all config files in the notebook |
| `cfg: tree` | Folder-tree walk showing config inheritance |
| `cfg: access: .` | Chain view of access resolution to current location |
| `fm: type:dotfile` | List all dotfiles in the notebook |
| `test` | Embedded assertions / checks |

---

## The Config Org Chart

`cfg: org` is the flagship sysadmin tool. It renders the entire notebook's config topology as a left-to-right SVG tree:

- **BG tint** — colour on nodes that *explicitly set* `access:` (inherited access is in the tooltip, not painted everywhere)
- **Filter chips** — isolate every node that sets a given key, or a specific `key:value`
- **Freeform input** — type any key ad-hoc; live x-ray vision across all configs
- **Tooltip** — `path/filename` + grep-C context around the filtered key
- **Click** — opens the config for editing (`●`) or creates it (`○`)

The full admin loop in one view: **spot → read → click → fix**.

See [CODEBLOCKS](CODEBLOCKS.md#cfg-org--config-org-chart) for full syntax reference.

---

*Video screencasts of the org chart and filter workflow are planned for this section.*

---

## Code Guards

The **code guard** system prevents large edits from silently deleting
load-bearing functions in plugin source files. It's the source-code
counterpart to the checks system — checks audit note *data*, guards audit
*code*.

### How it works

Each plugin repo has a `.guards` file at its root. Each line names a file
and an identifier that must exist there before any commit is accepted:

```
nbweb-cine.js:_openStorylineOverlay
nbweb-cine.js:_parseFountain
main.js:_enrichRendered
```

A shared runner (`~/.nb/.tools/check-guards.sh`) greps for each identifier
before every commit. If anything is missing, the commit is blocked with a
clear message naming the missing function.

### Covered repos

| Repo | What is guarded |
|------|----------------|
| `nb-web` | Plugin API (`nbweb.js`), render pipeline (`main.js`), nav, Flask endpoints |
| `nbweb-cine` | Storylines board, Fountain pipeline, shot/scene renderers |
| `nbweb-hledger` | Account setup, invoice pipeline, note renderers |
| `nbweb-specialty` | Specialty/dotfile/dashboard/reports renderers, theme editor |

### Maintenance rule

When you introduce a major new feature section, add its entry-point function
to `.guards` in the same commit. New plugin repos get a `.guards` file and
hook wired at creation time.

Full convention and troubleshooting: .rules/guards.md
