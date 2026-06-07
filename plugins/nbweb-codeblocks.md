# NbWeb-codeblocks

Live interactive widgets for fenced code blocks in your notes. Write a query in a fence, read a live result.

````markdown
```tw
status:pending due:today
```

```hledger
bal -p thisweek
```

```t
today
```

```git
nb-web log --oneline -10
```
````

These blocks are **local-first**: no cloud, no sync service. Data comes from your actual tools — Taskwarrior, hledger, `t` timeclock, git — via the nb-web API running alongside the app.

---

## Block types

### `tw` — Taskwarrior

Any `task` filter expression. Results render as an interactive table; click a task ID for full details, use the **+** button to add a new task inline.

### `hledger` — ledger accounting

Any hledger subcommand: `bal`, `reg`, `is`, `bs`, `cf`. Positive and negative amounts are coloured. The **+** button opens an inline journal entry form.

### `t` — timeclock

Shows clocked-in account, elapsed time, and a period report. Argument is a period expression (`today`, `thisweek`, `lastmonth`). The **⎋** button opens the full timeclock UI.

### `nb` — nb panel

Two commands:
- `notebooks` — all notebooks with note count and last-modified age; click to switch
- `backlinks` — notes wiki-linking to the current note's title

### `git` — git log / status

First word is a repo alias configured in `nb-settings.json` under `git_repos`. Remaining words are the git subcommand and args (read-only: `log`, `status`, `diff`, `branch`, `show`, `remote`, …).

```json
{ "git_repos": { "nb-web": "~/dev/nb-web" } }
```

---

## Block controls

Every block header has the same controls:

| Control | Action |
|---------|--------|
| **▼/▶** | Collapse / expand (persisted per block) |
| **↻** | Refresh |
| **+** | Open inline add form (where supported) |
| **⎋** | Launch external app (where supported) |

---

## Broader context

These blocks are nb-web's implementation of the [mkd-codeblocks](https://codeberg.org/linuxcaffe/mkd-codeblocks) collection — interactive live-query widgets designed to be self-contained drop-ins for any markdown note app. The `hledger` block is also released as a standalone package at [linuxcaffe/hledger-codeblock](https://github.com/linuxcaffe/hledger-codeblock). The others are planned for extraction as the mkd-codeblocks project matures.
