---
draft: true
toc: true
xref: "docs:"
processed: true
---

- Project: https://github.com/linuxcaffe/nb-web
- Issues:  https://github.com/linuxcaffe/nb-web/issues

# nb-web

A browser-based interface for [nb](https://github.com/xwmx/nb) — the plain-text, git-backed, CLI note-taking tool.

nb is built for working with a collection of text files — fast, scriptable, entirely at home in a terminal. nb-web puts a rich browser UI on top of that same collection: Markdown, `.txt`, `.csv` files rendered and edited in place, images and audio embedded inline, all without changing what's on disk. The original `nb` keeps working exactly as it always has — nb-web doesn't replace it, it runs on top of it, calling the same CLI underneath every click.

There is no database. No import format to get locked into, no export button standing between you and your own words. Every note, every config, every theme is a plain file you could open in `vi` and read without translation. nb-web renders it, makes it clickable, hands you an editor when you want one — but the files were always yours, and they still are.

nb-web is free and open source, and it runs locally — the Flask process behind it lives on your machine, not someone else's. Nothing leaves the computer unless you tell git to push it somewhere.

If you already enjoy working with nb, or with text files as your primary way of thinking, nb-web will feel like the same tool with a window added — not a rewrite, not a migration. It's not trying to be everyone's note app.

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

Commands can reference the **current note** using `{variable}` placeholders resolved at click time — `{file}` (full path), `{dir}` (directory), `{name}` (basename), `{selector}`, `{notebook}`, `{title}`:

```markdown
[Open in vim](term:vim {file})
[Run as script](term:bash {file})
[→ PDF](term:pandoc {file} -o {dir}/{name}.pdf)
[Encrypt](term:nb encrypt {selector})
```

Put a `[Run](term:bash {file})` link in a notebook template and every note in that notebook gets a run button. The note *is* the script. Click once — the terminal opens and the command runs immediately. If the terminal is already open, the command is sent to the running session. Works in note bodies, templates, and wikilinked docs.

→ [[WIKILINKS#Terminal Links]]

---

### Live codeblocks

[screenshot: tw codeblock showing task list inside a note]

Fenced code blocks with recognised language tags render as live, interactive widgets rather than static code. Write a query, read a live result — all from your local tools, no cloud involved.

| Block | What it shows |
|-------|--------------|
| ` ```tw ` | Taskwarrior task table — filterable, clickable, with inline Add |
| ` ```hl ` | hledger balance / register / income statement |
| ` ```git ` | git log or status for any configured repo alias |
| ` ```nb ` | nb notebooks panel or backlinks |
| ` ```t ` | Timeclock status and period report |
| ` ```cfg ` | Config inheritance tree or org chart — audit every notebook config at a glance |
| ` ```fm ` | Frontmatter filter — browse and query FM keys across all notes |
| ` ```nav ` | Folder navigator — drill into subfolders inline |
| ` ```chart ` | Financial charts from hledger data |
| ` ```gallery ` | Image gallery from a folder |

→ [[CODEBLOCKS]]

---

### Project diaries and live reports

[screenshot: reports page showing timeline, time totals, and financial summary]

A `type: project` note is a **diary** — dated headings, prose, time entries, expense records, decisions. Nothing is forced; you write what happened and the system reads it.

A companion `type: reports` note is a **live projection** of that diary. A timeframe selector on the reports bar lets you navigate between billing phases — current work, a past invoice period, or the full project history. Every block on the page responds instantly, scoping its totals to the selected window.

The two notes are a pair. The project note accumulates; the reports note presents. When billing time comes, the Invoice button reads the current phase, generates an invoice note, and writes a marker back into the diary as its own receipt. To regenerate: delete the marker, click Invoice again.

Your project notes are always plain Markdown. The reports are assembled on demand — no separate database, no import step.

→ [[PROJECT-REPORTS]]

---

### Notebooks

[screenshot: notebooks panel showing list and detail]

Each nb notebook is its own git repo under `~/.nb/`. The Notebooks panel shows note count, sync status, git branch, remote URL, and last commit for every notebook. Wire a remote, sync, set per-notebook defaults (sort order, list type, default template), and manage the Danger Zone — all from one place. Create a new notebook from the Add bar.

→ [[NOTEBOOKS]]

---

### Themes

[screenshot: theme picker popup showing Default and Groovy cards with colour swatches]

Full-colour themes are plain Markdown files in `~/.nb/.themes/` with `dark:` and `light:` YAML sections that map key names directly to CSS custom properties. Switch themes from the **🎨** button on any notebook dashboard — the picker shows live colour swatches and saves your choice back to the notebook config automatically.

The **☀/☾** toggle in the top nav bar switches dark and light mode globally. Every theme defines both palettes independently.

`theme:` is a config chain key — set it in `.nb.md` for a global default, in a notebook manifest for a per-notebook look, or in a folder config to theme a subtree. Opening a note auto-applies its resolved theme.

→ [[THEMES]] · [[docs:FOLDER-CONFIG]]

---

### Sysadmin corner

[screenshot: cfg:org SVG org chart with filter bar and access tints]

The **`cfg: org`** codeblock renders the entire notebook's config topology as an interactive SVG tree — every config file, its type icon, key count badge, and access tint in one view. Click any node to open the config directly; click an empty node (`○`) to create it. The filter bar accepts any `key` or `key:value` and highlights exactly which configs set it, with grep-style `-C N` context in the hover tooltip.

The **`dotfile.md`** global template pre-wires `cfg: org` into every new folder config so the sysadmin view is available from day one.

→ [[SYSADMIN]] · [[CODEBLOCKS#cfg]]

---

### Folder and notebook locks

Any folder or notebook can be made read-only by placing an `.nb-lock` file inside it. Locked notes hide the **Edit** and **Delete** buttons and show a 🔒 indicator in the toolbar. Hovering the indicator shows the reason, if one was given.

The lock is **hierarchical**: a notebook-level `.nb-lock` covers every folder inside it; a folder-level lock covers every note in that folder without affecting sibling folders.

**Via the UI:**
- **Folder** — click `⋯` on any folder → 🔒 Lock tab → *Lock folder* (add an optional reason)
- **Notebook** — Menu → Notebooks → select a notebook → *🔒 Lock notebook*

Toggling lock/unlock **renames** the file between `.nb-lock` (locked) and `.nb-unlock` (unlocked) rather than deleting it, so the reason text is preserved across cycles.

**Manually:**

```bash
# Lock a folder:
echo "Tutorial — read only" > ~/.nb/home/tutorial/.nb-lock

# Unlock (preserves the reason for next time):
mv ~/.nb/home/tutorial/.nb-lock ~/.nb/home/tutorial/.nb-unlock

# Re-lock:
mv ~/.nb/home/tutorial/.nb-unlock ~/.nb/home/tutorial/.nb-lock
```

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

Four plugins ship with nb-web; additional plugins are loaded from `nb-settings.json`:

| Plugin | What it adds |
|--------|-------------|
| **NbWeb-codeblocks** | Live `tw`, `hl`, `git`, `nb`, `t`, `cfg`, `fm`, `nav`, `gallery`, `chart` blocks |
| **NbWeb-contacts** | Contact card renderer and VCF importer |
| **NbWeb-archive** | Notebook archive, export, and import |
| **NbWeb-quartz** | Quartz static site publishing workflow |
| **NbWeb-specialty** | Typed note headers — dashboard, invoice, project, quote, budget (external) |
| **NbWeb-cine** | Film production — shot lists, stripboard, screenplay, cast/location index (external) |
| **NbWeb-hledger** | Accounting journals, invoice generation, contact lookup (external) |

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
| Doc | Contents |
|-----|---------|
| [[Install]] | Dependencies, launch script, Epiphany setup |
| [[QUICKSTART]] | Five-minute orientation |
| [[NOTEBOOKS]] | Notebook management, wiring, defaults |
| [[SYNC]] | Git model, sync dialog, troubleshooting |
| [[TEMPLATES]] | Placeholder syntax, `typename.md` convention, per-notebook defaults |
| [[THEMES]] | Theme files, config chain key, picker, dark/light, custom themes |
| [[SYSADMIN]] | Dotfile vs dashboard split, `cfg: org`, admin templates |
| [[WIKILINKS]] | Syntax, anchor links, backlinks |
| [[CODEBLOCKS]] | All live block types and configuration |
| [[PROJECT-REPORTS]] | Project diary pattern, timeframe selector, invoice generation |
| [[SEARCH_TAGS]] | Search, tag filter, cross-notebook search |
| [[CONTACTS]] | Contact notes, VCF import |
| [[Import / Export]] | .nbz archive format, import workflow |
| [[PLUGINS]] | Plugin architecture and development |
| [[KEYBOARD]] | All keyboard shortcuts |

### Security

nb-web uses session-based login. Users are `.md` files in `~/.nb/.users/` with YAML frontmatter (`name`, `level`, `password_hash`, `notebooks`). Four access levels: `user`, `office`, `admin`, `tech`. Admin and tech users see five dotfolder notebooks (`.users`, `.tools`, `.changes`, `.images`, `.rules`) in the notebook selector. See [[dev/SECURITY]] for full details.

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

- License: [AGPL v3](LICENSE)
- Language: Python (Flask) + Vanilla JavaScript
- Requires: Python 3.8+, nb 7+
- Platforms: Linux (primary), macOS (untested)
- Version: 2.x
