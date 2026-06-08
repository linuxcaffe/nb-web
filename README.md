---
draft: true
---

- Project: https://github.com/linuxcaffe/nb-web
- Issues:  https://github.com/linuxcaffe/nb-web/issues

# nb-web

A browser-based interface for [nb](https://github.com/xwmx/nb) — the plain-text, git-backed, CLI note-taking tool.

---

## TL;DR

- Browse, search, and edit all your nb notebooks in a split-pane, mardkown rendering web UI
- Full CRUD: add notes, bookmarks, todos, and contacts with per-notebook templates
- **Wikilinks** — `[[Note Title]]` links between notes, resolved live on click
- **Terminal links** — `[label](term:command)` in any note runs a shell command in the built-in terminal pane
- **Live codeblocks** — embed Taskwarrior queries, hledger reports, git logs, and timeclock status directly in notes
- **Git sync** — commit, push, and pull per notebook; one-repo branch-per-notebook model
- **Plugins** — extend the UI without touching core; ships with Contacts, Archive, Quartz, and Codeblocks plugins
- **Archive** — export any notebook as a portable `.nbz` file; import on any machine
- Installable as a **PWA** (Epiphany / GNOME Web recommended); works offline via service worker
- Your notes stay plain Markdown files in `~/.nb/` — nb-web never locks you in

---

## Why this exists

nb is an exceptionally capable note-taking tool, but it lives entirely in the terminal. Browsing a large notebook, following wikilinks, previewing images, or editing a long note are all friction-heavy at the CLI. Reaching for a GUI editor means leaving nb's git-backed, plain-text world.

nb-web closes that gap. It wraps nb's CLI via a local Flask API, giving you a real browser UI — with rendered Markdown, clickable wikilinks, tag filtering, and live data widgets — while keeping every note as a plain file in `~/.nb/`. The CLI and the browser UI coexist: anything you do in one is immediately visible in the other.

The sync model is explicit and notebook-scoped. nb-web talks to git directly rather than calling `nb sync`, so you always know exactly what is being pushed and where.

---

## What this means for you

Your notes are always a browser tab away — searchable, readable, and editable — while remaining plain Markdown files you can grep, script, and back up like any other text. You get the power of a polished UI, both at the desktop with full keyboard support, and finger friendly and compact for mobile use, without giving up the permanence of plain text or the safety of git.

---

## Feature Tour

### Note list and preview

[screenshot: split-pane note list with rendered preview]

The left pane lists notes with title and excerpt. The right pane renders the selected note as Markdown. Switch notebooks, filter by type, sort, and search — all without leaving the page. Keyboard shortcuts (`/` to search, `#` to filter by tag, arrow keys to navigate) keep your hands off the mouse.

→ [[KEYBOARD]] · [[SEARCH_TAGS]]

---

### Editor

[screenshot: inline editor with toolbar]

Click **Edit** or press `e` to edit any note inline. A lightweight formatting toolbar handles bold, italic, headings, links, and lists. `Ctrl+Enter` saves; `Escape` cancels. Encrypted notes are supported with per-note password protection.

→ [[KEYBOARD]]

---

### Templates

[screenshot: Add bar with template picker]

Templates are plain Markdown files with `{{placeholder}}` substitution — title, date, time, tags, weather, or any shell expression. Store them globally or per-notebook. A single local template becomes the notebook's default, pre-applied every time you add a note.

→ [[TEMPLATES]]

---

### Wikilinks

[screenshot: rendered note with clickable wikilink]

Write `[[Note Title]]` anywhere in a note body to link to another note. Links resolve on click — nb-web finds the note by title, case-insensitively, within the current notebook. Anchor to a heading with `[[Note Title#Section]]`. A `backlinks` codeblock shows every note that links to the current one.

→ [[WIKILINKS]]

---

### Terminal links

[screenshot: rendered note with ▶ terminal link clicked, terminal pane open below]

Write `[label](term:command)` anywhere in a note to create a clickable link that runs a shell command in the built-in terminal pane. The `▶` prefix and monospace yellow styling make terminal links visually distinct.

```markdown
[Preview site](term:cd ~/dev/mysite && npx quartz build --serve)
[Sync notes](term:nb sync)
[Today's tasks](term:task due:today)
```

Click once — the terminal opens and the command runs immediately. If the terminal is already open, the command is sent to the running session. Works in note bodies, templates, and wikilinked docs. The right tool for anything interactive: local servers, TUI apps, long-running processes.

→ [[WIKILINKS#Terminal Links]]

---

### Live codeblocks

[screenshot: tw codeblock showing task list inside a note]

Fenced code blocks with recognised language tags render as live, interactive widgets rather than static code. Write a query, read a live result — all from your local tools, no cloud involved.

| Block | What it shows |
|-------|--------------|
| ` ```tw ` | Taskwarrior task table — filterable, clickable, with inline Add |
| ` ```hledger ` | hledger balance / register / income statement |
| ` ```git ` | git log or status for any configured repo alias |
| ` ```nb ` | nb notebooks panel or backlinks |
| ` ```t ` | Timeclock status and period report |

→ [[CODEBLOCKS]]

---

### Notebooks

[screenshot: notebooks panel showing list and detail]

Each nb notebook is its own git repo under `~/.nb/`. The Notebooks panel shows note count, sync status, git branch, remote URL, and last commit for every notebook. Wire a remote, sync, set per-notebook defaults (sort order, list type, default template), and manage the Danger Zone — all from one place. Create a new notebook from the Add bar.

→ [[NOTEBOOKS]]

---

### Sync

[screenshot: sync dialog showing unpushed count and Sync Now button]

nb-web uses a **one-repo, branch-per-notebook** model: all notebooks live as branches of a single remote repository (typically `nb-notes` on Codeberg or GitHub). Wire once, sync per notebook. The sync dialog shows exactly what is pending before you push.

→ [[SYNC]]

---

### Search and tags

[screenshot: search bar active with tag filter showing]

Full-text search and tag filtering work simultaneously and update the list live. Press `/` to jump to search, `#` to jump to the tags field. Tag queries support AND logic (`recipes dinner`) and exclusion (`recipes -draft`). Switch scope to **all** to search every notebook at once.

→ [[SEARCH_TAGS]]

---

### Contacts

[screenshot: contact card rendered with clickable email and phone]

Add a notebook named `contacts` and nb-web renders its notes as structured contact cards — email, phone, address, and URL fields all clickable. Import contacts from a `.vcf` file via the 📇 browser. Sort by last name. Filter by tag.

→ [[CONTACTS]]

---

### Archive

[screenshot: archive section in notebook settings panel]

Export any notebook as a self-contained `.nbz` file (a standard ZIP with a metadata manifest). Optionally include full git history. Import a `.nbz` on any machine — nb-web extracts, reconciles, and makes notes available immediately. A planned `docs.nbz` will ship with nb-web so new users can import the reference documentation as a local notebook.

→ [[Import / Export]]

---

### Plugins

[screenshot: plugins panel showing installed plugins]

nb-web's plugin system lets JavaScript modules extend the UI without modifying core files. Plugins are loaded from `nb-settings.json` and can add note renderers, sort options, toolbar buttons, notebook sections, and custom plugin-page content.

Four plugins ship with nb-web:

| Plugin | What it adds |
|--------|-------------|
| **NbWeb-codeblocks** | Live `tw`, `hledger`, `git`, `nb`, `t` blocks |
| **NbWeb-contacts** | Contact card renderer and VCF importer |
| **NbWeb-archive** | Notebook archive, export, and import |
| **NbWeb-quartz** | Quartz static site publishing workflow |

→ [[PLUGINS]]

---

## Installation

### Requirements

- Python 3.8+
- [nb](https://github.com/xwmx/nb) installed and initialised (`nb` must be on `$PATH`)
- A modern browser (Firefox, Chrome, or Epiphany/GNOME Web for PWA mode)

Optional: `gh` CLI for Create & Wire (new GitHub repo from the UI), `rg` (ripgrep) for faster search.

### Quick start

```bash
git clone https://github.com/linuxcaffe/nb-web.git
cd nb-web
pip install flask
python app.py
```

Open `http://localhost:5001` — your existing nb notebooks appear immediately.

### PWA install (Epiphany / GNOME Web)

[screenshot: Epiphany install-as-app dialog]

nb-web is a full PWA. In Epiphany, open `http://localhost:5001`, then **⋮ → Install as Web Application**. It launches in its own window with no browser chrome, indistinguishable from a native app.

A launcher script (`nb-web-launch`) is included that starts the Flask server, opens Epiphany, and cleans up on exit. See [[Install]] for setup details.

### Settings

Copy `nb-settings.json.example` to `nb-settings.json` and edit:

```json
{
  "default_git_remote": "git@github.com:you/nb-notes.git",
  "git_repos": {
    "nb-web": "~/dev/nb-web"
  }
}
```

→ [[Install]]

---

## Project status

nb-web is active and stable at v2.x. The core note-browsing, editing, sync, and plugin system are solid. The archive/import round-trip, live codeblocks, and contacts plugin are new additions — well-tested but still accumulating real-world use. APIs may evolve between minor versions.

---

## Further reading

The full documentation lives in the `docs` notebook — importable as `docs.nbz` (planned) or browsable at [linuxcaffe.github.io/docs-site](https://linuxcaffe.github.io/docs-site/).

| Doc | Contents |
|-----|---------|
| [[Install]] | Dependencies, launch script, Epiphany setup |
| [[QUICKSTART]] | Five-minute orientation |
| [[NOTEBOOKS]] | Notebook management, wiring, defaults |
| [[SYNC]] | Git model, sync dialog, troubleshooting |
| [[TEMPLATES]] | Placeholder syntax, per-notebook defaults |
| [[WIKILINKS]] | Syntax, anchor links, backlinks |
| [[CODEBLOCKS]] | All live block types and configuration |
| [[SEARCH_TAGS]] | Search, tag filter, cross-notebook search |
| [[CONTACTS]] | Contact notes, VCF import |
| [[Import / Export]] | .nbz archive format, import workflow |
| [[PLUGINS]] | Plugin architecture and development |
| [[KEYBOARD]] | All keyboard shortcuts |

---

## Related projects

| Project | What it is |
|---------|-----------|
| [nb](https://github.com/xwmx/nb) | The CLI note-taking tool nb-web wraps |
| nb-quartz | Convert any notebook to a static website using quartz 
| nb-plugins | plugins for CLI |
| [tw-web](https://github.com/linuxcaffe/tw-web) | Sister app: web interface for Taskwarrior; designed to run alongside nb-web |
| [hledger-codeblock](https://github.com/linuxcaffe/hledger-codeblock) | Standalone hledger live block; the same widget used in nb-web |
| [mkd-codeblocks](https://codeberg.org/linuxcaffe/mkd-codeblocks) | The broader codeblock collection nb-web draws from |

---

## Metadata

- License: MIT
- Language: Python (Flask) + Vanilla JavaScript
- Requires: Python 3.8+, nb 7+
- Platforms: Linux (primary), macOS (untested)
- Version: 2.x
