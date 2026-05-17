# nb-web
A lightweight PWA web interface for [nb](https://github.com/xwmx/nb) — the
plain-text, git-backed, CLI note-taking tool.

## Related

| Project | What it is |
|---|---|
| [nb](https://github.com/xwmx/nb) | The CLI note-taking tool nb-web wraps — notes, todos, bookmarks, plain-text, git-backed |
| [tw-web](https://github.com/linuxcaffe/tw-web) | Sister app: web interface for [Taskwarrior](https://taskwarrior.org/). Same Epiphany PWA packaging; designed to run alongside nb-web |
| [hledger-codeblock](https://github.com/linuxcaffe/hledger-codeblock) | nb plugin that adds a live hledger query block type, rendered and launchable in nb-web |

## Templates

nb-web supports nb's template system when adding notes. Templates are plain
Markdown files with `{{tag}}` placeholders that nb substitutes at note-creation
time.

### Template storage

| Location | Scope |
|---|---|
| `~/.nb/.templates/` | Global — available in all notebooks |
| `~/.nb/<notebook>/.templates/` | Local — that notebook only; overrides global templates of the same name |

nb-web merges both directories and shows them in the **Template** picker that
appears in the Add opts bar when the note type is *note* or *todo*.

### Template tags

| Tag | Substituted with |
|---|---|
| `{{title}}` | Note title (from the Title field) |
| `{{tags}}` | Hashtag list (from the Tags field) |
| `{{content}}` | Body text (from the Content field or piped input) |
| `{{date}}` | Full output of the system `date` command |
| `{{date +"%Y-%m-%d"}}` | ISO date — `YYYY-MM-DD` |
| `{{date +"%H:%M"}}` | Current time — `HH:MM` |
| `$(command)` | Any shell command substitution |

Templates are processed as Bash strings with `eval`, so arbitrary shell
expressions are valid — keep template files trusted.

### Starter template: `dated-note`

`~/.nb/.templates/dated-note.md` is included as a ready-to-use global template.
It produces a note headed with today's ISO date and a tags line, leaving the
body for your content:

```markdown
# {{title}}

**Date:** {{date +"%Y-%m-%d"}}
**Tags:** {{tags}}

---

{{content}}
```

### Saving a note as a template

Open any note, click **☰** (note menu) → **Save as template…**. A bar appears
below the toolbar where you can name the template and choose *Notebook* (local)
or *Global* scope. The note's raw content — including any existing template tags
— is saved as-is, so you can iterate on a template by editing the template file
itself and re-saving.

### Previewing a template before use

Selecting a template in the Add opts bar loads a read-only preview of the raw
template content in the preview pane, so you can confirm you have the right one
before creating a note.

### Default template per notebook

If a notebook's local `.templates/` directory contains **exactly one** template,
nb-web treats it as that notebook's default and applies it automatically whenever
you open the **Add** command while that notebook is the active scope. The 📋
button in the opts bar lights up to show a template is already applied — click it
to browse all templates or revert to a blank note.

When two or more local templates exist the auto-apply is suppressed and you pick
manually as usual.

**Setting a default from the Templates view**

Open **Templates**, select any template, then use the notebook selector and
**📌 Set default** button in the preview footer. This copies the template into
`~/.nb/<notebook>/.templates/`, making it the auto-default for that notebook
(or one of the options in the picker if other templates are already there).

**Example: contacts notebook**

Place a single contact template at `~/.nb/contacts/.templates/contact.md`.
Every time you open **Add** while the contacts notebook is active, nb-web
silently pre-applies it — just type the contact's name and press Save.

## Live codeblocks

nb-web renders fenced code blocks with special language tags as live, interactive
widgets rather than static code. All blocks share two universal controls:

- **▼/▶** — collapse/expand the block body to just its header bar. State is
  persisted in `localStorage` keyed on block type + query, so collapsed blocks
  stay collapsed across reloads and note switches.
- **↻** — refresh the block data on demand.

### `nb` — nb commands

```
```nb
notebooks
```
```

Embeds a live nb panel. Supported commands:

| Command | What it shows |
|---|---|
| `notebooks` | All notebooks with note count and last-modified age; click to switch |
| `backlinks [N]` | Notes that wiki-link `[[to this note]]`; limit to N results (default 20) |

The active notebook is highlighted in the `notebooks` view. `backlinks` uses
ripgrep when available for speed.

### `tw` — Taskwarrior queries

```
```tw
project:myproject +next
```
```

Renders a live task table from any `task` filter or report expression. Features:

- Columns auto-hide when empty (project, priority, due, tags)
- Click any **ID** to expand `task information` inline (one at a time)
- **Add** button opens an inline form to create tasks with due date, priority, tags
- `columns:id,description,due` in the fence body overrides auto column selection

### `git` — git repository status

```
```git
nb-web log --oneline -10
```
```

The first word is a repo **alias** configured in `nb-settings.json`; everything
after is the git subcommand and flags. Useful for dev-journal notes, project
planning pages, or any note that lives alongside a codebase.

**Configuration** — add repo aliases to `nb-settings.json`:

```json
{
  "git_repos": {
    "nb-web":   "~/dev/nb-web",
    "myproject": "~/dev/myproject"
  }
}
```

Permitted subcommands (read-only): `branch`, `describe`, `diff`, `log`,
`ls-files`, `remote`, `shortlog`, `show`, `stash`, `status`, `tag`.

### `hledger` — hledger queries

```
```hledger
balance expenses --monthly -3
```
```

Renders balance, register, or income-statement output from hledger. See
[hledger-codeblock](https://github.com/linuxcaffe/hledger-codeblock) for full
details. Requires `hledger` on `$PATH`.
