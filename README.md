<!-- Generated from docs:README.md by .tools/readme-export.py. Edit the source, not this file. -->

- Project: https://github.com/linuxcaffe/nb-web
- Issues:  https://github.com/linuxcaffe/nb-web/issues

# nb-web README

A browser-based interface for [nb](https://github.com/xwmx/nb) — the plain-text, git-backed, CLI note-taking tool.

nb is built for working with a collection of text files — fast, scriptable, entirely at home in a terminal. nb-web puts a rich browser UI on top of that same collection: Markdown, `.txt`, `.csv` files rendered and edited in place, images and audio embedded inline, all without changing what's on disk. The original `nb` keeps working exactly as it always has — nb-web doesn't replace it, it runs on top of it, calling the same CLI underneath every click.

There is no database. No import format to get locked into, no export button standing between you and your own words. Every note, every config, every theme is a plain file you could open in `vi` and read without translation. nb-web renders it, makes it clickable, hands you an editor when you want one — but the files were always yours, and they still are.

nb-web is free and open source, and it runs locally — the Flask process behind it lives on your machine, not someone else's. Nothing leaves the computer unless you tell git to push it somewhere.

If you already enjoy working with nb, or with text files as your primary way of thinking, nb-web will feel like the same tool with a window added — not a rewrite, not a migration. It's not trying to be everyone's note app.

---

## TL;DR

- Create notes quickly with as much or as little markdown, with keyboard, mouse or mobile
- Browse, search, and edit all your nb notebooks in a split-pane, Markdown-rendering web UI
- Full CRUD: add notes, bookmarks, todos, and contacts with per-notebook templates
- **Wikilinks** — `[[Note Title]]` links between notes, resolved live on click
- **Terminal links** — `[label](term:command)` in any note runs a shell command in the built-in terminal pane
- **Live codeblocks** — embed Taskwarrior queries, hledger reports, git logs, and timeclock status directly in notes
- **Git sync** — commit, push, and pull per notebook; one-repo branch-per-notebook model
- **Plugins** — extend the UI without touching core; ships with Codeblocks, Specialty, Contacts, Archive and Quartz, with hledger, cine and Claude plugins alongside
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

## Feature tour

### Basics

_Your nb notes, in a browser_

Everything you touch in the first five minutes. nb-web shows your nb notebooks in a browser: pick
a notebook, find a note in the list or by search and tags, read it rendered, edit it, move around
from the keyboard, and press **?** for help on whatever is in front of you. Your notes stay plain
Markdown files in `~/.nb/`, each notebook its own git repo; nothing is locked away in a database.

- [Notebooks](docs/NOTEBOOKS.md) — separate collections of notes, each its own folder and git repo
- [Note list and preview](docs/note-list.md) — the list of notes on the left, and the preview on the right
- [Search and tags](docs/SEARCH_TAGS.md) — find notes by their text, by their tags, or both
- [Editor](docs/editor.md) — editing a note's Markdown right in the browser
- [Keyboard](docs/KEYBOARD.md) — keyboard shortcuts for moving around, finding and editing notes
- [Help](docs/help.md) — the ? button, and how help finds what to show

[↑ Feature tour](#feature-tour) · [Linking →](#linking)

### Linking

_Connect notes to each other_

Notes that point at each other. Link by name with `[[wikilinks]]`, pull another note (or one of
its sections) into this one with `{{inline:}}`, put a strip of tabs over a set of related notes,
see what links to what with xref, and give a note links that run commands in the terminal.

**Before you start.** Terminal links run in nb-web's built-in terminal, which only tech-level
accounts can open.

- [Wikilinks](docs/wikilinks.md) — making connections across paragraphs, files and notebooks
- [Terminal links](docs/terminal-links.md) — links that run a command in the built-in terminal
- [Inline includes](docs/inline-includes.md) — show another note, or one section of it, inside this one
- [Tab strip](docs/tabs.md) — a row of tabs linking a set of related notes
- [xref](docs/xref.md) — headings that link themselves to matching notes elsewhere

[← Basics](#basics) · [↑ Feature tour](#feature-tour) · [Structure →](#structure)

### Structure

_Shape notebooks to fit what's in them_

Make a notebook fit what's in it. A config note in a folder sets rules for the notes in it:
fields, types, access, checks. Templates start new notes in the right shape, a `type:` gives a
note its own header and behaviour, foldable headings and locks keep long or finished notes in
hand, and a book stitches notes into one long read.

**Before you start.** Configs are notes too (`.<folder>.md`, `.<notebook>.md`, and the global
`~/.nb/.nb.md`), and settings cascade: a folder's config wins over its notebook's, which wins over
the global one. Who may lock and unlock is set the same way (`lock_level:`, admins by default).

- [Folder config](docs/FOLDER-CONFIG.md) — settings for a whole folder or notebook, kept in a hidden note inside it
- [Templates](docs/TEMPLATES.md) — notes to start new notes from, with placeholders filled in as they're created
- [Typed notes](docs/TYPED-NOTES.md) — a type: in frontmatter, and the header bar some types get
- [Foldable headings](docs/foldable.md) — headings that fold away the section under them
- [Locks](docs/LOCKS.md) — make a note, folder or notebook read-only
- [Books](docs/BOOKS.md) — one long document stitched from chapter notes, with a table of contents
- [Sections](docs/sections.md) — a header note for a folder of pages, with a contents list that writes itself

[← Linking](#linking) · [↑ Feature tour](#feature-tour) · [Live blocks →](#live-blocks)

### Live blocks

_Notes that do things_

A live block is a fenced codeblock that runs when the note is shown: write a query, read the
answer in place. Find notes by their frontmatter, browse folders, total a price list, add a job
from a wizard, or see this month's books, all from plain text in your notes, all on your own
machine, no cloud involved. Most blocks can also sit in a note's frontmatter (`fm: status:active`),
where they show in the header strip above the note.

**Before you start.** Blocks that read outside data need the tool installed: `hledger` for `hl`.
An admin can limit any block to an access level (Settings → Codeblocks); a block you're below
the level for simply doesn't show. Every block's **?** opens its help, and
[Codeblocks](docs/CODEBLOCKS.md) is the full reference. The examples here use
Pat's made-up business, never your own notes.

**Navigation**

- [nav](docs/blocks/nav.md) — a clickable folder/notebook browser embedded in a note
- [gallery](docs/blocks/gallery.md) — a clickable image grid rendered from a note's nearest images/ folder
- [toc](docs/blocks/toc.md) — a clickable heading list for the note, in the FM strip

**Introspection**

- [fm](docs/blocks/fm.md) — find notes by their frontmatter, across notebooks
  - [fm group, count, sum](docs/blocks/fm/aggregate.md) — count, total or group the notes an fm query finds
  - [fm list](docs/blocks/fm/list.md) — every frontmatter key in a notebook, with counts and sample values
  - [fm edit](docs/blocks/fm/edit.md) — edit a note's frontmatter in a form, with the fields its folder expects
- [cfg](docs/blocks/cfg.md) — where a setting comes from, and a map of every config file

**Authoring**

- [toolbar](docs/blocks/toolbar.md) — a button in the list header that opens a note
- [csv](docs/blocks/csv.md) — an editable spreadsheet grid inside a note
  - [csv templates](docs/blocks/csv/templates.md) — reusable columns and totals for csv tables, and a price list to pick rows from
  - [csv files](docs/blocks/csv/files.md) — a .csv file opens as a full-page spreadsheet
- [add](docs/blocks/add.md) — a step-by-step wizard that creates the notes and folders a new thing needs
  - [Writing a wizard](docs/blocks/add/wizards.md) — the .<name>-org.md file behind an add block and a [+] button

**External data**

- [hl](docs/blocks/hl.md) — live hledger reports in a note

**Inline values**

- [Inline queries](docs/inline-queries.md) — live numbers and values right inside a sentence

[← Structure](#structure) · [↑ Feature tour](#feature-tour) · [Work →](#work)

### Work

_Run real work from your notes_

Project diaries and reports, quotes and invoices, contacts, and the wizard that sets a new project up.

A `type: project` note is a **diary**: dated headings, prose, time entries, expenses, decisions.
Nothing is forced; you write what happened and nb-web reads it. Its `type: reports` companion is a
live view of that diary: pick a timeframe (current work, a past invoice period, the whole
project) and every block on the page totals just that window. When it's time to bill, Invoice
writes the invoice note and puts a marker in the diary as its receipt. Everything stays plain
Markdown: no database, no import step. See [Project reports](docs/PROJECT-REPORTS.md).

A notebook named `contacts` shows its notes as contact cards with clickable email, phone,
address and links, sorted by last name; 📇 imports a `.vcf` file. See
[Contacts](docs/CONTACTS.md).

[← Live blocks](#live-blocks) · [↑ Feature tour](#feature-tour) · [Look →](#look)

### Look

_Make it yours_

Themes, languages, and installing nb-web as an app.

Themes are Markdown files in `~/.nb/.themes/` with a `dark:` and a `light:` palette. Pick one
with 🎨 on a notebook's dashboard; ☀/☾ switches light and dark everywhere. `theme:` cascades like
any config key: set it globally, per notebook or per folder, and each note opens in its theme.
See [Themes](docs/THEMES.md).

[← Work](#work) · [↑ Feature tour](#feature-tour) · [Sharing →](#sharing)

### Sharing

_Sync, share and publish_

Git sync, import and export, publishing a notebook as a website, and accounts with access levels.

Every notebook is its own git repo; they all sync to one remote as one branch per notebook. Wire
once, then sync per notebook; the sync dialog shows what's pending before you push. See
[Sync](docs/SYNC.md).

Export any notebook as a `.nbz` archive (a ZIP with a manifest, git history optional) and import
it on another machine. See [Import and export](docs/import-export.md).

[← Look](#look) · [↑ Feature tour](#feature-tour) · [Health →](#health)

### Health

_Keep everything in good shape_

Checks that explain themselves, the sysadmin corner, and settings.

The `cfg org` block draws every config file in a notebook as an interactive chart: type icons,
key counts, access tints. Click a node to open its config, or an empty one (`○`) to create it;
filter by any `key` or `key:value` to see which configs set it. New folder configs made from the
`dotfile` template come with it built in. See [Sysadmin](docs/SYSADMIN.md) and
[Checks](docs/CHECKS.md).

[← Sharing](#sharing) · [↑ Feature tour](#feature-tour) · [Plugins →](#plugins)

### Plugins

_Extend it_

The plugin system, and the hledger, cine and Claude plugins.

Plugins are JavaScript modules listed in `nb-settings.json`. They add note renderers, codeblocks,
sort options, toolbar buttons and notebook sections without touching core files.

| Plugin | What it adds |
|--------|-------------|
| codeblocks | the live blocks (`tw`, `hl`, `git`, `nb`, `t`, `cfg`, `fm`, `nav`, `gallery`, …) |
| specialty | typed note headers: dashboard, project, reports, invoice, quote, budget |
| contacts | contact cards and `.vcf` import |
| archive | notebook archive, export and import |
| quartz | publishing a notebook as a Quartz website |
| hledger | accounting: journals, chart of accounts, invoices (separate repo) |
| cine | film production: shot lists, stripboard, screenplay (separate repo) |
| claude | ask Claude about a note (separate repo) |

See [Plugins](docs/PLUGINS.md).

[← Health](#health) · [↑ Feature tour](#feature-tour)

## Installation

### Requirements

- Python 3.10+
- [nb](https://github.com/xwmx/nb) installed and initialised (`nb` must be on `$PATH`)
- A modern browser (Firefox, Chrome, or Epiphany/GNOME Web for PWA mode)

Optional: `gh` CLI for Create & Wire (new GitHub repo from the UI), `rg` (ripgrep) for faster search.

### Quick start

```bash
git clone https://github.com/linuxcaffe/nb-web.git
cd nb-web
pip install -r requirements.txt
python3 app.py
```

Open `http://localhost:5001` and sign in; your existing nb notebooks appear immediately.

<!-- FIXME first account: /login redirects to /setup when ~/.nb/.users/ is empty, but no /setup route exists (found 2026-10-08). -->

### PWA install (Epiphany / GNOME Web)

[screenshot: Epiphany install-as-app dialog]

nb-web is a full PWA. In Epiphany, open `http://localhost:5001`, then **⋮ → Install as Web Application**. It launches in its own window with no browser chrome, indistinguishable from a native app.

A launcher script (`nb-web-launch.sh`) is included that starts the Flask server, opens Epiphany, and cleans up on exit. See [INSTALL](docs/Install.md) for setup details.

### Settings

Machine settings (port, terminal, plugins, git remote) live in `nb-settings.json`, written when you
first change one in **Menu → Settings**. Everything else is per notebook, in its config note.

→ [INSTALL](docs/Install.md)

---

## Project status

nb-web is active and stable at v2.x. The core note-browsing, editing, sync, and plugin system are solid. The archive/import round-trip, live codeblocks, and contacts plugin are new additions — well-tested but still accumulating real-world use. APIs may evolve between minor versions.

---

## Further reading

The full documentation lives in nb-web's own `docs` notebook; the pages linked here are copies of it in [docs/](docs/), also browsable at [linuxcaffe.github.io/docs-site](https://linuxcaffe.github.io/docs-site/).

| Doc | Contents |
|-----|---------|
| [INSTALL](docs/Install.md) | Dependencies, launch script, Epiphany setup |
| [QUICKSTART](docs/QUICKSTART.md) | Five-minute orientation |
| [NOTEBOOKS](docs/NOTEBOOKS.md) | Notebook management, wiring, defaults |
| [SYNC](docs/SYNC.md) | Git model, sync dialog, troubleshooting |
| [TEMPLATES](docs/TEMPLATES.md) | Placeholder syntax, `typename.md` convention, per-notebook defaults |
| [Themes](docs/THEMES.md) | Theme files, config chain key, picker, dark/light, custom themes |
| [SYSADMIN](docs/SYSADMIN.md) | Dotfile vs dashboard split, `cfg: org`, admin templates |
| [WIKILINKS](docs/wikilinks.md) | Syntax, anchor links, backlinks |
| [CODEBLOCKS](docs/CODEBLOCKS.md) | All live block types and configuration |
| [Project Diaries and Reports](docs/PROJECT-REPORTS.md) | Project diary pattern, timeframe selector, invoice generation |
| [SEARCH_TAGS](docs/SEARCH_TAGS.md) | Search, tag filter, cross-notebook search |
| [CONTACTS](docs/CONTACTS.md) | Contact notes, VCF import |
| [IMPORT/EXPORT](docs/import-export.md) | .nbz archive format, import workflow |
| [PLUGINS](docs/PLUGINS.md) | Plugin architecture and development |
| [KEYBOARD](docs/KEYBOARD.md) | All keyboard shortcuts |

### Security

nb-web uses session-based login. Users are `.md` files in `~/.nb/.users/` with YAML frontmatter (`name`, `level`, `password_hash`, `notebooks`). Five access levels: `guest`, `user`, `office`, `admin`, `tech`. Admin and tech users also see the dotfolders (`.users`, `.tools`, `.changes`, `.images`, `.rules`, `.lib`, `.checks`) in the notebook selector. See [security](docs/dev/dev-security.md) for full details.

---

## Related projects

| Project | What it is |
|---------|-----------|
| [nb](https://github.com/xwmx/nb) | The CLI note-taking tool nb-web wraps |
| [nb-quartz](https://github.com/linuxcaffe/nb-quartz) | Convert a notebook to a static website with Quartz |
| [nb-plugins](https://github.com/linuxcaffe/nb-plugins) | Plugins for the nb CLI |
| [tw-web](https://github.com/linuxcaffe/tw-web) | Sister app: web interface for Taskwarrior; designed to run alongside nb-web |
| [hledger-codeblock](https://github.com/linuxcaffe/hledger-codeblock) | Standalone hledger live block; the same widget used in nb-web |
| [mkd-codeblocks](https://github.com/linuxcaffe/mkd-codeblocks) | The broader codeblock collection nb-web draws from |

---

## Metadata

- License: [AGPL v3](LICENSE)
- Language: Python (Flask) + Vanilla JavaScript
- Requires: Python 3.10+, nb 7+
- Platforms: Linux (primary), macOS (untested)
- Version: 2.x
