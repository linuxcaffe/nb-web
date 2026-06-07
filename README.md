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

See [[TEMPLATES]] for full documentation: placeholder syntax, storage locations, saving notes as templates, and per-notebook defaults.

## Wikilinks

nb-web supports `[[wikilink]]` syntax in note bodies for linking between notes.

### Basic syntax

| Syntax | Effect |
|---|---|
| `[[Note Title]]` | Link to a note by title; display text resolved automatically |
| `[[Note Title\|display text]]` | Link with custom display text |
| `[[notebook:id]]` | Link by explicit nb selector |

Plain-title wikilinks are resolved within the current notebook first. Matching
is case-insensitive, so `[[shop]]` and `[[Shop]]` both find a note titled "Shop".

### Anchor links — linking to a heading

Append `#Heading Text` to jump directly to a section within a note:

| Syntax | Effect |
|---|---|
| `[[Page#Heading]]` | Open note and scroll to that heading |
| `[[Page#Heading\|label]]` | Same, with custom display text |
| `[[#Heading]]` | Scroll to a heading in the **current** note (no page reload) |

Heading matching is case-insensitive and compares against the heading text
directly — use the heading words with spaces, not a slug. `[[#Contact Import]]`
and `[[#contact import]]` both work; `[[#contact-import]]` does not.

### Backlinks

Use a `backlinks` codeblock to see all notes that link to the current one:

~~~
```nb
backlinks
```
~~~

See [Live codeblocks → `nb`](#nb--nb-commands) below.

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

## Git menu

nb-web's **☰ → Git** menu surfaces nb's per-notebook git model with a few
additions beyond what the CLI gives you in one command.

| Item | What it does |
|---|---|
| **log** | Shows the last 30 commits for the current notebook, with remote info at the top |
| **remote** | Runs `nb remote` — shows the configured remote for the current notebook |
| **status** | Runs `nb status` — git status of the current notebook |
| **sync** | Opens the Sync dialog — two-way pull+push for the current notebook |
| **wire remotes** | One-shot setup: configures the default remote for every notebook that lacks one |

### nb's git model

Each notebook (`~/.nb/home/`, `~/.nb/tw/`, etc.) is its own git repo. nb
auto-commits on every edit with messages like `[nb] Edit: filename.md`. Notes
are therefore always committed locally — **sync** is what pushes them to a
remote and pulls changes made elsewhere (another machine, GitHub web editor, etc.).

### Sync dialog

**☰ → Git → sync** opens a modal dialog that shows the current notebook's sync
state before you commit to syncing:

- **Status area** — lists uncommitted files and unpushed commit count; shows
  "Up to date" when nothing is pending, or "No remote configured" if wire
  remotes hasn't been run yet
- **Commit message** — optional free-text field; if filled, a git commit with
  that message is created before syncing (useful for labelling a batch of
  auto-committed edits)
- **Sync Now** — runs the full two-way cycle: `nb sync` (auto-commit any
  pending changes) → `git pull --no-edit origin <notebook>` (merge remote
  changes) → `git push origin HEAD:<notebook>` (push to the notebook's branch)
- **Show Log** — fetches the last 30 commits + remote info inline, without
  closing the dialog

The **sync** menu item shows a live badge that updates every 60 seconds:
`sync (3 changed, 1 unpushed)` when there's work to do, or
`sync (no remote)` if wire remotes hasn't been run for the current notebook.

### Notebooks as branches

nb-web uses a **one-repo, branch-per-notebook** model for remote sync:

```
github.com/you/nb-notes
  branch: home     ← ~/.nb/home/  (your default notebook)
  branch: work     ← ~/.nb/work/
  branch: tw       ← ~/.nb/tw/
  branch: claude   ← ~/.nb/claude/
  …
```

All notebooks live in a single remote repository; each gets its own branch
named after the notebook. This means:

- You can browse, edit, and commit notes directly on GitHub (web editor)
- Changes sync back to nb-web on the next Sync — pull merges remote commits
  automatically
- Multiple machines share the same repo; each notebook branch is independent
- History per notebook is clean and readable

### First-time setup

1. Create a single empty repo on GitHub/Gitea/etc. (e.g. `nb-notes`), SSH preferred
2. **☰ → Settings → nb-web settings** — paste the SSH URL into *Default remote URL*, Save
3. **☰ → Git → wire remotes** — one click configures all notebooks: adds the
   remote, pushes each notebook's commits to its branch, and sets the git
   tracking ref so future syncs go to the right branch
4. **☰ → Git → sync** from then on — opens the Sync dialog for the current notebook

Notebooks that already have a remote are skipped (`·`). If a push fails (SSH
key not set up), the remote is rolled back so you can fix credentials and retry.

### Settings

`nb-settings.json` (in the nb-web directory) holds nb-web-specific settings:

```json
{
  "default_git_remote": "git@github.com:you/nb-notes.git",
  "git_repos": {
    "nb-web":    "~/dev/nb-web",
    "myproject": "~/dev/myproject"
  }
}
```

`git_repos` is used by the `git` codeblock (aliases → local paths). It is
separate from notebook sync remotes, which are stored in each notebook's own
`.git/config`.
