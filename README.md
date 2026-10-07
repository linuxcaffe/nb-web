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

- Browse, search, and edit all your nb notebooks in a split-pane, Markdown-rendering web UI
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

<!-- readme:categories (generated from the features notebook) -->

### Basics

_Your nb notes, in a browser_

**[Notebooks](docs/NOTEBOOKS.md)** — separate collections of notes, each its own folder and git repo

A notebook is a folder of notes under `~/.nb/` with its own git history: `home`, `work`,
`recipes`… Pick one from the notebook selector at the top left to list and add notes there, or
choose **all** to see every notebook at once. **Menu → Notebooks** shows each one's size and sync
state, and is where you set its defaults, connect it to a remote, or delete it.

**[Note list and preview](docs/note-list.md)** — the list of notes on the left, and the preview on the right

The left pane lists the notes in the current notebook or folder; click one (or move with the
arrow keys) to show it on the right. Folders come first, then pinned notes, then the rest. The
row above the list filters by type (notes, bookmarks, todos, contacts, folders, images), the
**⇅** button changes the sort, and Ctrl-click selects several notes to move, export or delete
together. Notes pinned in their frontmatter (dashboards, usually) come first, then ones you pin
from the menu.

**[Search and tags](docs/SEARCH_TAGS.md)** — find notes by their text, by their tags, or both

Type in the **search** bar (or start search with `/`) to narrow the list to notes containing those words, or in the **tags** field (use `#yourtag` to jump there) to show only notes with those tags. Both work together and update the list as you type. Put `-` before a tag to leave notes with it out (`recipes -tested`), and switch the notebook selector to **all** to search every notebook.

**[Editor](docs/editor.md)** — editing a note's Markdown right in the browser

Click **Edit** (or press `e`) to edit the open note: its whole text, frontmatter included,
appears in a plain Markdown editor. `Ctrl+Enter` saves and `Escape` cancels. The toolbar adds
line numbers, a Markdown cheat sheet and image embedding (`Ctrl+Shift+1`). Every save is a git
commit, so an earlier version is always in the notebook's history.

**[Keyboard](docs/KEYBOARD.md)** — keyboard shortcuts for moving around, finding and editing notes

Most of nb-web works without the mouse. `↑`/`↓` move through the list and `→` steps into the
preview; `/` searches, `#` filters by tag, `a` adds a note and `e` edits the open one. `Escape`
always backs you out to somewhere safe. Shortcuts are single keys, so they only work when you're
not typing in a field.

**[Help](docs/help.md)** — the ? button, and how help finds what to show

The **?** at the far right of the toolbar opens help for whatever you're looking at: the note's
type, the live blocks in it, its frontmatter keys, its notebook. Each topic shows a short summary,
with **More** for the full page and **Try it** for a live example you can edit. The help comes
from the same docs you can read in the `docs:` notebook, so there's one copy of everything.

---

### Linking

_Connect notes to each other_

**[Wikilinks](docs/wikilinks.md)** — making connections across paragraphs, files and notebooks

Write `[[Note Title]]` in a note to link to another note; click it to open the target. Links
find notes by title or filename, in the current notebook or another one (`[[docs:THEMES.md]]`),
and can jump straight to a heading (`[[Page#Heading]]`). The label shown is the target's `alias:`,
then its `title:`, so renaming a note's display never breaks a link.

**[Terminal links](docs/terminal-links.md)** — links that run a command in the built-in terminal

A Markdown link whose URL starts with `term:` runs a shell command in nb-web's terminal pane
when clicked: `[Today's tasks](term:task%20due:today)`. Write spaces in the command as `%20`.
Commands can name the current note with `{file}`, `{dir}`, `{notebook}` and friends, so one link
in a template gives every note a "run this" button.

**[Inline includes](docs/inline-includes.md)** — show another note, or one section of it, inside this one

`{{inline: notebook:path/note.md}}` on its own line shows another note's body right there, as if
it were part of this note. Add `#Heading` to include just one section
(`{{inline: docs:wikilinks.md#Summary}}`), or `card` to show the note's card instead of its text.
Several includes plus `toc: true` make one long, navigable document out of separate notes.

**[Tab strip](docs/tabs.md)** — a row of tabs linking a set of related notes

A `tabs:` list in a note's frontmatter shows a row of tabs above the note, one per listed note or
folder; the current note's tab is highlighted, and clicking another opens it. Put `tabs:` in a
notebook or folder config and every note there gets the same strip.

---

### Structure

_Shape notebooks to fit what's in them_

**[Folder config](docs/FOLDER-CONFIG.md)** — settings for a whole folder or notebook, kept in a hidden note inside it

A folder can carry its own settings in a hidden note named after it: `projects/.projects.md` for
the `projects` folder, `.work.md` at the top of the `work` notebook. Its frontmatter sets things
like who may see the folder (`access:`), which note it opens on (`pinned:`), its tab strip
(`tabs:`) and field rules for its notes (`constraints:`). Settings pass down to every subfolder
and note below, and the nearest one wins, so you only write down what's different.

---

### Templates

[screenshot: Add bar with template picker]

Templates are plain Markdown files with `{{placeholder}}` substitution — title, date, time, tags, weather, or any shell expression. Store them globally or per-notebook. A single local template becomes the notebook's default, pre-applied every time you add a note.

→ [TEMPLATES](docs/TEMPLATES.md)

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

→ [CODEBLOCKS](docs/CODEBLOCKS.md)

---

### Project diaries and live reports

[screenshot: reports page showing timeline, time totals, and financial summary]

A `type: project` note is a **diary** — dated headings, prose, time entries, expense records, decisions. Nothing is forced; you write what happened and the system reads it.

A companion `type: reports` note is a **live projection** of that diary. A timeframe selector on the reports bar lets you navigate between billing phases — current work, a past invoice period, or the full project history. Every block on the page responds instantly, scoping its totals to the selected window.

The two notes are a pair. The project note accumulates; the reports note presents. When billing time comes, the Invoice button reads the current phase, generates an invoice note, and writes a marker back into the diary as its own receipt. To regenerate: delete the marker, click Invoice again.

Your project notes are always plain Markdown. The reports are assembled on demand — no separate database, no import step.

→ [Project Diaries and Reports](docs/PROJECT-REPORTS.md)

---

### Themes

[screenshot: theme picker popup showing Default and Groovy cards with colour swatches]

Full-colour themes are plain Markdown files in `~/.nb/.themes/` with `dark:` and `light:` YAML sections that map key names directly to CSS custom properties. Switch themes from the **🎨** button on any notebook dashboard — the picker shows live colour swatches and saves your choice back to the notebook config automatically.

The **☀/☾** toggle in the top nav bar switches dark and light mode globally. Every theme defines both palettes independently.

`theme:` is a config chain key — set it in `.nb.md` for a global default, in a notebook manifest for a per-notebook look, or in a folder config to theme a subtree. Opening a note auto-applies its resolved theme.

→ [Themes](docs/THEMES.md) · [FOLDER CONFIG](docs/FOLDER-CONFIG.md)

---

### Sysadmin corner

[screenshot: cfg:org SVG org chart with filter bar and access tints]

The **`cfg: org`** codeblock renders the entire notebook's config topology as an interactive SVG tree — every config file, its type icon, key count badge, and access tint in one view. Click any node to open the config directly; click an empty node (`○`) to create it. The filter bar accepts any `key` or `key:value` and highlights exactly which configs set it, with grep-style `-C N` context in the hover tooltip.

The **`dotfile.md`** global template pre-wires `cfg: org` into every new folder config so the sysadmin view is available from day one.

→ [SYSADMIN](docs/SYSADMIN.md) · [CODEBLOCKS](docs/CODEBLOCKS.md#cfg)

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

→ [SYNC](docs/SYNC.md)

---

### Contacts

[screenshot: contact card rendered with clickable email and phone]

Add a notebook named `contacts` and nb-web renders its notes as structured contact cards — email, phone, address, and URL fields all clickable. Import contacts from a `.vcf` file via the 📇 browser. Sort by last name. Filter by tag.

→ [CONTACTS](docs/CONTACTS.md)

---

### Archive

[screenshot: archive section in notebook settings panel]

Export any notebook as a self-contained `.nbz` file (a standard ZIP with a metadata manifest). Optionally include full git history. Import a `.nbz` on any machine — nb-web extracts, reconciles, and makes notes available immediately. A planned `docs.nbz` will ship with nb-web so new users can import the reference documentation as a local notebook.

→ [IMPORT/EXPORT](docs/import-export.md)

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

→ [PLUGINS](docs/PLUGINS.md)

<!-- readme:categories-end -->

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

A launcher script (`nb-web-launch`) is included that starts the Flask server, opens Epiphany, and cleans up on exit. See [INSTALL](docs/Install.md) for setup details.

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

nb-web uses session-based login. Users are `.md` files in `~/.nb/.users/` with YAML frontmatter (`name`, `level`, `password_hash`, `notebooks`). Five access levels: `guest`, `user`, `office`, `admin`, `tech`. Admin and tech users see five dotfolder notebooks (`.users`, `.tools`, `.changes`, `.images`, `.rules`) in the notebook selector. See [security](docs/dev/dev-security.md) for full details.

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
