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

Notebooks, the note list, search and tags, the editor, the keyboard and the ? help — everything you touch in the first five minutes.

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

### Linking

_Connect notes to each other_

Wikilinks between notes, links that run commands in the terminal, pulling one note into another, and cross-references.

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

### Structure

_Shape notebooks to fit what's in them_

Folder and notebook config, templates, typed notes, foldable headings, locks and books.

**[Folder config](docs/FOLDER-CONFIG.md)** — settings for a whole folder or notebook, kept in a hidden note inside it

A folder can carry its own settings in a hidden note named after it: `projects/.projects.md` for
the `projects` folder, `.work.md` at the top of the `work` notebook. Its frontmatter sets things
like who may see the folder (`access:`), which note it opens on (`pinned:`), its tab strip
(`tabs:`) and field rules for its notes (`constraints:`). Settings pass down to every subfolder
and note below, and the nearest one wins, so you only write down what's different.

**[Templates](docs/TEMPLATES.md)** — notes to start new notes from, with placeholders filled in as they're created

A template is a note that new notes start from. Click **📋** in the **Add** bar to pick one; its
`{{title}}`, `{{date}}` and other placeholders are filled in as the note is created. Templates
live in a `.templates` folder: `~/.nb/.templates/` for every notebook, a notebook's own for that
notebook, or a folder's own for that folder. If a folder (or notebook) has exactly one template,
**Add** uses it without asking.

**[Typed notes](docs/TYPED-NOTES.md)** — a type: in frontmatter, and the header bar some types get

`type:` in a note's frontmatter says what kind of note it is: `project`, `dashboard`, `invoice`
and so on. The list shows its icon, and many types get a **header bar** above the note: the
icon, the type's name, details taken from the note's frontmatter (status, client, due date) and
links to related notes, such as a folder's dashboard and its config. A type nb-web doesn't
know is simply shown as a plain note.

**[Foldable headings](docs/foldable.md)** — headings that fold away the section under them

`foldable: [Notes, Ideas]` in a note's frontmatter puts a ▾ before every heading containing
"Notes" or "Ideas"; click the heading (or the ▾) to fold away the section under it, and again to
open it. Each heading remembers whether it's folded. Set `foldable:` in a folder's config and
every note in the folder gets it, which suits long diaries: fold every past day with a date
pattern.

**[Locks](docs/LOCKS.md)** — make a note, folder or notebook read-only

A lock makes something read-only, for everyone. Lock a single note with `lock: yes` in its
frontmatter, or a whole folder or notebook from its menu; nothing inside can then be edited,
moved, renamed or deleted until it's unlocked, and a note's annotation is locked with it. Who may
lock and unlock is up to each notebook or folder (`lock_level:`, admins by default); others see a
🔒.

**[Books](docs/BOOKS.md)** — one long document stitched from chapter notes, with a table of contents

A book is a note with `type: book` whose chapters are other notes, pulled in with
`{{inline: notebook:chapter.md}}`, one per line. It reads as one long document, with a table of
contents across every chapter. Each chapter stays an ordinary note you can open and edit on its
own. A check block placed in a chapter warns right there, so a failing check shows up in the
book's contents beside the section it's about.

### Live blocks

_Notes that do things_

Fenced codeblocks that render as live widgets — tasks, accounts, git, frontmatter queries and more — in the body or the header strip.

Write a query, read a live result, all from your own tools, no cloud involved. The same block can
also sit in a note's frontmatter (`tw: +work`), where it shows in the header strip above the note.

| Block | What it shows |
|-------|--------------|
| `tw` | Taskwarrior tasks, filterable, with inline Add |
| `hl` | hledger balances, registers, income statement |
| `git` | git log or status for a repo |
| `nb` | notebooks panel or backlinks |
| `t` / `timedot` | time tracking: timeclock status and reports, timedot journals |
| `cfg` | where a setting comes from; an org chart of every config file |
| `fm` | frontmatter queries across notes, and an edit form |
| `nav` | a folder navigator |
| `gallery` | an image gallery from a folder |
| `csv` | a spreadsheet-style table |
| `toc` | a table of contents |

A block's **?** opens its help. Full reference: [Codeblocks](docs/CODEBLOCKS.md).

### Work

_Run real work from your notes_

Project diaries and reports, quotes and invoices, contacts, and the scaffolding wizard that sets a new project up.

A `type: project` note is a **diary**: dated headings, prose, time entries, expenses, decisions.
Nothing is forced; you write what happened and nb-web reads it. Its `type: reports` companion is a
live view of that diary: pick a timeframe (current work, a past invoice period, the whole
project) and every block on the page totals just that window. When it's time to bill, Invoice
writes the invoice note and puts a marker in the diary as its receipt. Everything stays plain
Markdown: no database, no import step. See [Project reports](docs/PROJECT-REPORTS.md).

A notebook named `contacts` shows its notes as contact cards with clickable email, phone,
address and links, sorted by last name; 📇 imports a `.vcf` file. See
[Contacts](docs/CONTACTS.md).

### Look

_Make it yours_

Themes, languages, and installing nb-web as an app.

Themes are Markdown files in `~/.nb/.themes/` with a `dark:` and a `light:` palette. Pick one
with 🎨 on a notebook's dashboard; ☀/☾ switches light and dark everywhere. `theme:` cascades like
any config key: set it globally, per notebook or per folder, and each note opens in its theme.
See [Themes](docs/THEMES.md).

### Sharing

_Sync, share and publish_

Git sync, import and export, publishing a notebook as a website, and accounts with access levels.

Every notebook is its own git repo; they all sync to one remote as one branch per notebook. Wire
once, then sync per notebook; the sync dialog shows what's pending before you push. See
[Sync](docs/SYNC.md).

Export any notebook as a `.nbz` archive (a ZIP with a manifest, git history optional) and import
it on another machine. See [Import and export](docs/import-export.md).

### Health

_Keep everything in good shape_

Checks that explain themselves, the sysadmin corner, and settings.

The `cfg org` block draws every config file in a notebook as an interactive chart: type icons,
key counts, access tints. Click a node to open its config, or an empty one (`○`) to create it;
filter by any `key` or `key:value` to see which configs set it. New folder configs made from the
`dotfile` template come with it built in. See [Sysadmin](docs/SYSADMIN.md) and
[Checks](docs/CHECKS.md).

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
