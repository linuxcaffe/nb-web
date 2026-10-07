<!-- Generated from docs:CODEBLOCKS.md by .tools/readme-export.py. Edit the source, not this file. -->

# Codeblocks

[Block Types](#block-types) · [Block Controls](#block-controls) · [Access Gates](#access-gates) · [tw](#tw--taskwarrior) · [nb](#nb--nb-panel) · [git](#git--git-log) · [hl](#hl--accounting) · [chart](#chart--financial-charts) · [nav](#nav--folder-navigator) · [gallery](#gallery--image-gallery) · [fm](#fm--frontmatter-filter) · [cfg](#cfg--config-inheritance-tree) · [toc](#toc--table-of-contents) · [test](#test--embedded-assertions) · [t](#t--timeclock) · [timedot](#timedot--time-journal) · [toolbar](#toolbar--shortcut-buttons) · [cine](#cine--film-production) · [csv](#csv--spreadsheet-table)

---

Live codeblocks are delivered by the **NbWeb-codeblocks** plugin — enabled by default and listed in **Menu → Plugins**. Disabling it there removes all live block rendering; fences revert to plain static code display.

Write a fenced code block with a recognised language tag and nb-web renders it as a live, interactive widget instead of static code.

````markdown
```tw
status:pending due:today
```

```hl
bal -p thisweek
```

```nb
backlinks
```

```git
nb-web log --oneline -10
```
````

These blocks are **local-first**: no cloud, no sync service. Data comes from your actual tools — Taskwarrior, hledger, timeclock, git — via the nb-web Flask server running alongside the app.

---

## FM-mode — Blocks Declared in Frontmatter

Any codeblock type can be promoted out of the note body into the **toolbar strip** (between the TOC bar and body) by declaring it in frontmatter. The FM field name is the codeblock language tag; the value is the query — identical to what you'd write inside the fence.

```yaml
---
fm: type:item
---
```

is equivalent to writing ` ```fm\ntype:item\n``` ` in the body, except the block appears in `#nb-fm-blocks` (above the body, collapsed by default) rather than floating in the text.

**Multiple blocks** — each key that matches a registered codeblock lang gets its own slot:

```yaml
---
fm: type:shot loc:LG
tw: project:film status:pending
hl: bal expenses
---
```

**Boolean shorthand** — `true` means an empty query (block with no filter):

```yaml
---
fm: true
---
```

**Collapse state** — FM-mode blocks start collapsed. State is then persisted per-block in `localStorage` the same as body blocks.

**`check:` is excluded** — `check:` in frontmatter is a config directive (see below), not a codeblock to display. It has no FM-mode toolbar incarnation. To show check output explicitly, use ` ```check``` ` in the body.

**`toc: true`** — adds a Table of Contents barblock to the FM strip. Collapses to a heading count; expands to a clickable list that scrolls to any heading in the note.

```yaml
---
toc: true
---
```

---

## Block Controls

Every block header carries the same universal controls:

| Control | Action |
|---------|--------|
| **▼/▶** | Collapse / expand the block body. State is persisted in `localStorage` keyed on block type + query, so collapsed blocks stay collapsed across reloads and note switches. |
| **↻** | Refresh — re-fetch data on demand |
| **+** | Open inline add form (where supported: `tw`, `hl`). Hidden when the current user is below the configured write level for that block type; also hidden when the note has `lock: yes` frontmatter. |
| **⎋** | Launch external app (where supported: `t`) |

---

## Access Gates

Block types fall into two categories: those with a **codeblock-level gate** (the tool itself requires a minimum level), and those gated **by destination** (the tool is neutral; the target notebook or dotfolder determines access).

**Codeblock-level gate** — if you're below the required level, the block silently doesn't exist. No placeholder, no error, no lock icon. A `test` block with an explicit label is the one exception: the button still appears, and clicking it tells you what level you need.

**Destination gate** — `nav` and `nb` have no level of their own. They show what the target allows. A nav block pointing at a dotfolder the user can't access vanishes silently — the same disappearing magic as everything else.

**Write gate** — the `+` (add) and `✎` (edit) buttons are simply absent from the header. The block still shows your data; you just can't write to it.

### Per-block override

Add `read:` and `write:` lines anywhere in the fence body to override the defaults for that specific block:

````markdown
```hl
read: office
write: tech
bal expenses --monthly
```
````

These lines are stripped before the query runs — they never reach hledger. Any level string works: `guest`, `user`, `office`, `admin`, `tech`. `write:` can be omitted to leave the write default unchanged.

### Default levels

| Block | Read gate | Write gate | Notes |
|-------|-----------|------------|-------|
| `hl`, `chart` | `office` | `admin` | `chart` has no write |
| `tw` | `user` | `user` | |
| `git`, `t`, `test`, `tui` | `user` | none | read-only |
| `fm` | `admin` | none | system-wide metadata search |
| `nav`, `nb` | — | none | gated by destination, not tool |

**`nav`** respects the target's own access level: a dotfolder requires admin+; a regular notebook follows its `.<notebook>.md` config `access:` field. A 403 from the destination → silent removal, never an error banner.

**`fm`** is admin-gated by default because it queries frontmatter across all notebooks — a broad view of the whole system that lower-level users shouldn't have by default.

See [security](dev/dev-security.md) for the full access level scheme.

---

## Block Types

### tw — Taskwarrior

````markdown
```tw
project:myproject +next
```
````

Renders a live task table from any `task` filter or report expression.

- Columns auto-hide when empty (project, priority, due, tags)
- Click any **ID** to expand `task information` inline (one at a time)
- **+** button opens an inline form to create tasks with description, project, due, priority, tags
- Override column selection with a `columns:` line in the fence body:

````markdown
```tw
columns:id,description,due
+work
```
````

---

### nb — nb Panel

````markdown
```nb
notebooks
```
````

Embeds a live nb panel. Supported commands:

| Command | What it shows |
|---------|--------------|
| `notebooks` | All notebooks with note count and last-modified age; click any to switch |
| `backlinks [N]` | Notes that wiki-link `[[to this note]]`; N caps results (default 20) |

The active notebook is highlighted in the `notebooks` view.

---

### git — Git Log

````markdown
```git
nb-web log --oneline -10
```
````

The first word is a repo **alias** (configured in `nb-settings.json`) or **`.`** to use the current note's notebook. The rest is the git subcommand and flags. Useful for dev-journal notes, project planning pages, or any note that lives alongside a codebase.

**`.` (current notebook)** — resolves to the notebook containing the open note:

````markdown
```git
. log --oneline -6
```
````

**Configuration** — add repo aliases to `nb-settings.json`:

```json
{
  "git_repos": {
    "nb-web":    "~/dev/nb-web",
    "myproject": "~/dev/myproject"
  }
}
```

Permitted subcommands (read-only): `branch`, `describe`, `diff`, `log`, `ls-files`, `remote`, `shortlog`, `show`, `stash`, `status`, `tag`.

---

### hl — Accounting

````markdown
```hl
bal expenses --monthly -3
```
````

Any hledger subcommand: `bal`, `reg`, `is`, `bs`, `cf`. Positive and negative amounts are coloured.

**Add Transaction (`+` button)**

Opens an inline posting form. Two smart pre-fills happen automatically:

- **Account from query** — if the fence body contains an account name (e.g. `reg Assets:Bank`), the first account field in the form is pre-populated with it.
- **Date from filename** — if the currently open note is a daily note named `YYYYMMDD.md`, the date field is pre-filled from the filename instead of today's date.

**Bookkeeper panel**

The hledger panel (☰ → hledger) has a persistent **+ Add Transaction** section at the top that also applies both smart pre-fills above.

**Files tab**

The hledger panel's **Files** tab handles bulk import and export between daily notes and journal files:

- **Export** — scans `YYYYMMDD.md` daily notes for ` ```hl ``` ` fenced blocks and writes their contents to a `.journal` file. Optionally filtered by date range.
- **Import** — parses an existing `.journal` file and appends each dated transaction block to the matching `YYYYMMDD.md` daily note (creating it if it doesn't exist), then commits.

**Static `ledger` blocks**

Use ` ```ledger ` (not ` ```hl `) for example journal entries in tutorial or documentation notes. These render as static syntax-highlighted code via Prism — never executed against your real journal.

Requires `hledger` on `$PATH`. See also: [hledger-codeblock](https://github.com/linuxcaffe/hledger-codeblock) — this block is also released as a standalone package.

---

### chart — Financial Charts

````markdown
```chart
cashflow thisyear
```
````

Interactive Chart.js visualisations driven by hledger data. Requires the **NbWeb-hledger** plugin with a configured journal.

**Syntax:** `` ```chart\n<report> [period] [depth:N]\n``` ``

| Report | Chart | Description |
|--------|-------|-------------|
| `cashflow` | bar + line | Monthly income vs expenses, cumulative net change |
| `networth` | line | Assets, liabilities, and net worth over time |
| `expenses` | stacked bar | Monthly expense breakdown by category |
| `expenses-pie` | doughnut | Expense share by category for the period |
| `assets-pie` | doughnut | Asset allocation snapshot |
| `income-pie` | doughnut | Income sources for the period |

**Period** is any hledger period expression: `thismonth`, `thisyear`, `lastyear`, `last3months`, `2025`, `2025-01..2025-06`, etc.

**`depth:N`** controls account depth for category breakdown (default `2`).

**Header controls:**

| Control | Action |
|---------|--------|
| **▾ / ▸** | Collapse/expand |
| **mo / yr / prev** | Quick period switcher (reloads chart) |
| **◕ / ▦** | Doughnut ↔ bar toggle on `*-pie` and `expenses`; redraws from cached data |
| **↺** | Force reload from hledger |

---

### t — Timeclock

````markdown
```t
today
```
````

The `t` block is a live time-tracking widget. It reads your `tw.timeclock` file via the `t` CLI and shows clock-in/out status and a period report side-by-side.

**Argument** — a period expression that controls the report column:

| Value | Period |
|-------|--------|
| `today` *(default)* | Since midnight |
| `thisweek` | Since Monday |
| `lastweek` | Previous Mon–Sun |
| `thismonth` | Since 1st of month |
| `lastmonth` | Previous calendar month |

**Header controls:**

| Button | Action |
|--------|--------|
| `.` | Toggle to timedot mode (shows last timedot entry + timedot report) |
| `tc` | Toggle back to timeclock mode |
| `⏱ In` | Open the clock-in form (account picker + description) |
| `◼ Out` | Clock out of the current entry |
| `↻` | Refresh |

**The combined total row** — when both your timeclock file and timedot file have entries in the selected period, a summary row appears at the bottom of the report:

```
1h15m tc + 2.5h td  →  3.8h
```

**Timedot mode (`.` toggle)** — switches the header to show your last timedot entry (account, time logged, date) and the report to show timedot hours. The combined total remains visible at the foot so you always see the full picture.

**FM usage** — put a `t` block in the frontmatter toolbar strip:

```yaml
---
t: thisweek
---
```

**File scoping** — by default the block uses the timeclock file from `~/.task/config/timelog.rc`. Override per-note or per-notebook:

```yaml
---
timelog_file: ~/client/acme/time.timeclock
timedot_file: ~/client/acme/time.timedot
---
```

With these keys set, **every** interaction — clock in, clock out, report, dot-mode — targets those files instead of the global ones. Set them in a `.notebook` config note to scope an entire notebook at once. See [File Scoping](#file-scoping) below.

---

### timedot — Time Journal

The `timedot` block tracks time in [hledger timedot format](https://hledger.org/timedot.html) — accounts and durations, one per line, optionally grouped by date or section headings. It works in two modes depending on where it appears:

| Mode | How declared | What you see |
|------|-------------|-------------|
| **Body block** | ` ```timedot ``` ` fence in note body | Raw entries verbatim, with inline `✎` editing |
| **FM barblock** | `timedot: true` in frontmatter | Aggregate summary: hours, billing, filter, sections |

---

**Body block — verbatim view**

The body block shows your entries exactly as written in a monospace block. This is the right mode for a project diary, where timedot entries live inside the note and grow with it.

````markdown
```timedot
2026/06/24
djp:siding  ....  ; prepped surfaces
djp:siding  ....  ; first coat

2026/06/25
djp:siding  1.5   ; trim work
```
````

**Body block header controls:**

| Button | Action |
|--------|--------|
| `✎` | Switch to textarea edit — change entries directly, then Save / Cancel |
| `↻` | Re-render (after editing in Edit mode) |

The meta slot shows an entry count (`N entries`). On Save the fence content in the note source is replaced in-place.

---

**FM barblock — aggregate summary**

Declaring `timedot:` in frontmatter adds a collapsible barblock to the FM strip. It collects all inline timedot blocks from the note body and shows an aggregate total — hours by account, optional billing if `rate:` is set, and a date filter.

```yaml
---
timedot: true
---
```

**FM barblock header controls (inline aggregation mode):**

| Button | Action |
|--------|--------|
| `all` / `mo` / `wk` | Cycle date filter: all entries → this month → this week → all |
| `↻` | Re-aggregate from body blocks |
| total display | Click `12.5h · $1062` to open per-account summary popover |

The `+` add-entry form is not available in inline aggregation mode — the FM block reads from all body blocks and has no single write target. Use the body block's `✎` edit to add entries directly.

**Date filter** — cycles through `all → mo → wk → all`. Applies to section bodies and subtotals; sections with no entries in the filtered window are hidden.

**Summary popover** — click the hours/amount display in the FM header to open a floating per-account breakdown (and billing amounts if `rate:` is set) for the current filter window.

---

**Time format** — multiple styles, freely mixed:

| Syntax | Meaning |
|--------|---------|
| `....` | Dots — each dot = 15 min (four dots = 1 h) |
| `.... ....` | Dot groups separated by spaces — all counted |
| `1.5h` | Decimal hours |
| `90m` | Minutes |
| `1.5` | Decimal hours (bare number) |

**Account names** — accounts may contain single spaces; the separator between account and time is **two or more spaces**:

```
home laundry  2.5h     ← "home laundry" is the account
home:laundry  2.5h     ← "home:laundry" is the account (colon hierarchy)
```

**Section headings** — use `##`, `###`, or `####` (with optional `-`) to divide entries into collapsible groups. These headings are visible in the FM barblock aggregate view. Level-2 sections start open; level-3 and level-4 start collapsed. State persists in `localStorage`.

````markdown
```timedot
##- November

###- Week 45

2024/11/14
work:hh  8.5h
```
````

**Other extended syntax** (passed through / skipped):

| Syntax | Meaning |
|--------|---------|
| `; comment` | Comment line — ignored |
| `* task item` | Task line — ignored |
| `// vim: ...` | Vim modeline — ignored |

**FM frontmatter keys:**

```yaml
---
project: work:client-a     # prefixes bare entries and :sub accounts
rate: 85                   # enables the $ billing column (hourly rate)
---
```

With `project: work:client-a`, bare time entries (`....`) are rewritten to `work:client-a  ....` before display. Sub-accounts (`:website`) become `work:client-a:website`. Full accounts pass through unchanged.

---

**External file mode** — instead of embedding data in the note body, point at an external `.timedot` file. This is the right choice when:

- you already have a `tw.timedot` file built up with `t . i` from the CLI, or
- you want one shared timesheet file that multiple notes can display, or
- the notebook's `.notebook` config should scope every note to the same file.

```yaml
---
timedot_file: ~/client/acme/time.timedot
---
```

When `timedot_file:` is set, the FM barblock fetches from that file on every render. The `+` button (available in this mode) appends new entries to the file rather than editing the note. **The file does not need to exist yet** — the first `+` save creates it. Write an empty fence as a body placeholder:

````markdown
```timedot
```
````

**Add-entry form** (FM barblock with `timedot_file:` only):

| Field | Notes |
|-------|-------|
| Date | Defaults to today |
| Time | Any supported format: `....`, `1.5h`, `90m` |
| Sub-account | Optional `:sub` suffix or full account name; autocomplete from existing accounts |
| Comment | Appended as `; comment` |

The entry is appended to the file. If the last date in the file is today, no new date heading is written; otherwise a new `YYYY/MM/DD` line is added first.

Set `timedot_file:` on a `.notebook` config note to scope the whole notebook — every note's timedot FM block reads the same file. See [File Scoping](#file-scoping) below.

---

### File Scoping

Two FM keys redirect the `t` and `timedot` blocks to project-specific files instead of the global defaults:

| Key | Affects | Default |
|-----|---------|---------|
| `timelog_file:` | `t` block — clock-in/out, status, report | `timelog.file` in `~/.task/config/timelog.rc` |
| `timedot_file:` | `timedot` block — content, `+` append | `timelog.timedot_file` in rc (or `tw.timedot` alongside timeclock) |

**Per-note** — set in the note's own frontmatter. Only that note's blocks are scoped:

```yaml
---
title: Acme Project — March 2025
timelog_file: ~/client/acme/time.timeclock
timedot_file: ~/client/acme/time.timedot
rate: 85
project: work:acme
---
```

**Per-notebook** — set in the `.notebook` config note (Hamburger → Configure Notebook). Every note in the notebook inherits the keys automatically via the config walk-up chain:

```yaml
---
title: .notebook
timelog_file: ~/freelance/time.timeclock
timedot_file: ~/freelance/time.timedot
---
```

When both keys are set on a note that has both a `t` block and a `timedot` block, the `t` block's clock-in/out and dot-mode toggle, and the `timedot` block's `+` add form, all write to the same pair of files — keeping timeclock and timedot in sync for the same project.

---

### toolbar — Shortcut Buttons

Notes with `toolbar: true` frontmatter appear as icon shortcut buttons in the list toolbar — instant one-click access to any note regardless of which folder or sort is active.

```yaml
---
title: Cashflow Report
toolbar: true
toolbar_icon: 💰
---
```

The button appears in the list header bar alongside any plugin-provided toolbar buttons. Clicking it opens the note in the preview pane immediately.

**`toolbar_icon:`** — sets the icon displayed on the button. Falls back in order: `toolbar_icon:` value → plugin icon function (if the note's type has a registered icon) → `indicator:` frontmatter → 📌.

**Scope** — toolbar notes are scanned notebook-wide at load time. A note in any folder of the current notebook can expose a button. Switching notebooks rebuilds the toolbar.

**Common patterns:**

| Note | `toolbar_icon:` | Purpose |
|------|----------------|---------|
| `cashflow.md` | `💰` | Jump to financial overview |
| `checklist.md` | `📋` | Daily checklist |
| `schedule.md` | `🗓` | Weekly schedule |
| `dashboard.md` | `📊` | Project hub |

There is no codeblock form — `toolbar: true` is a frontmatter-only directive. No FM-mode slot; the button itself is the presentation.

---

### cine — Film Production

Requires the **[NbWeb-cine](https://github.com/linuxcaffe/nbweb-cine)** plugin and a `.nb-cine.json` anchor file in the notebook.

````markdown
```cine
shots.strip | day: 1
```
````

**Syntax:** `field[.format] [: code, code, …] [| filter: value, …]`

| Query | Result |
|-------|--------|
| `shots` | Compact shot list — all shots, all days |
| `shots \| day: 1` | Shot list for shoot day 1 |
| `shots.strip` | Draggable stripboard — drag to resequence |
| `shots.strip \| day: 1` | Stripboard filtered to one day |
| `shots.sheet \| day: 1` | Call sheet cards — verbose, print-friendly |
| `scenes` | Scene index: all scenes, colour-coded by I/E · D/N |
| `storylines` | 2D story structure board — draggable cards across named lanes |
| `storylines.large` | Board with full card detail (scenes, metadata) |
| `actor.phone: JD, AM` | Field lookup — phone numbers for listed actors |
| `location.address: LG` | Field lookup — address for location LG |

Filters stack: `shots.sheet | day: 1, actor: JD`. See the [NbWeb-cine README](https://github.com/linuxcaffe/nbweb-cine) for the full query reference, frontmatter schemas, and storylines board documentation.

---

### nav — Folder Navigator

````markdown
```nav
accts:guide/
```
````

Renders a stateful folder navigator in the preview pane. Clicking folders drills in; clicking notes opens them. The breadcrumb header is fully clickable.

| Format | Example | Navigates to |
|--------|---------|-------------|
| `.` | `.` | Current note's folder |
| nb selector | `accts:guide/` | Notebook folder |
| Filesystem path | `~/.nb/accts/guide` | Same, via path |
| Hidden dir path | `~/.nb/.test` | Raw filesystem listing |

**`.` (current folder)** — resolves to the folder containing the open note. Useful as a dashboard block or FM-mode entry on a hub note: the navigator starts where you are.

The hidden-dir form (`~/.nb/.*`) uses a raw filesystem listing — useful for browsing `~/.nb/.test` (check scripts), `~/.nb/.templates`, etc.

**Controls:** **▼/▶** collapse (persists in `localStorage` by starting path) · **↻** refresh · breadcrumb segments are clickable.

**Default collapsed** on first render for hidden-dir paths.

---

### gallery — Image Gallery

````markdown
```gallery
med
```
````

Renders a CSS grid of images from the nearest `images/` folder, found by walking up from the current note's location. Click any image to open a full-screen lightbox with keyboard navigation (← → Esc).

**Adding images** — while editing a note, click the 📷 button next to **mkd ref** (or press `Ctrl+Shift+1`) to embed an image: capture with a camera (coming soon), pick from the note's own nearest `images/` folder, or browse for a file. A brand-new upload lets you rename it first (handy for camera-roll names like `IMG_20260904_143201.jpg`); picking an already-existing image skips straight to choosing a size. Either way the image lands in this same `images/` folder, so it shows up here automatically — no gallery configuration needed. See [Keyboard § Adding and editing](KEYBOARD.md#adding-and-editing) for the shortcut.

**Sizes** — the first word sets the cell width:

| Size | Cell width |
|------|-----------|
| `thumb` | 80 px |
| `small` | 140 px |
| `med` | 220 px |
| `large` | 320 px |

Grid columns auto-fill the available width at the chosen cell size.

*The single-image embed step above (📷) offers this same thumb/small/med/large vocabulary, plus "Full size" — but there it sets that one image's own display width in the note body, not a grid cell size. Two different mechanisms sharing one size scale for consistency, not the same setting.*

**Path argument** — optional second word overrides the folder search:

````markdown
```gallery
med .
```

```gallery
large pfinds:items/photos/
```
````

| Path | Behaviour |
|------|-----------|
| *(absent)* | Walk up from note dir; use first `images/` found |
| `.` | Look only for `images/` in the current note's folder; vanish silently if absent |
| `notebook:path/` | Use that specific folder directly |

**FM-mode** — declare in frontmatter to surface the gallery in the toolbar strip above the body (collapses to a header bar, shows "no images" when empty):

```yaml
gallery: med .
gallery: "thumb .images:"
gallery: "large pfinds:items/photos/"
```

**YAML syntax rules for FM-mode:**

- The value is always `size path` — the size keyword must come first, separated by a space. A value with no space (e.g. `gallery: ../.images`) is parsed entirely as the size key; the path is silently ignored and defaults to walk-up behaviour.
- Values ending with `:` must be quoted — `"thumb .images:"` not `thumb .images:` (bare trailing colon breaks YAML).
- Values starting with `.` or `/` must be quoted — `"med ~/.nb/.images"`.

| Path in FM value | Behaviour |
|-----------------|-----------|
| *(absent — size only)* | Walk up from note dir; use first `images/` found |
| `.` | Look only for `images/` in the current note's folder |
| `notebook:path/` | Explicit folder — `.images:` resolves to `~/.nb/.images/` |
| `~/path` | Absolute path with `~` expansion |

**Lightbox controls:** click any thumbnail to open · ← / → to navigate · Esc or click outside to close.

---

### fm — Frontmatter Filter

````markdown
```fm
shot: | All shots
```
````

Renders a collapsible list of notes matching frontmatter field conditions. Results are clickable — opening the note in the preview pane. Hover any row to see all frontmatter fields in a tooltip.

**Scope prefix** — leading bare words (no colon) name notebooks to search. No prefix = all notebooks. **`.`** resolves to the current note's notebook.

**Folder scope** — a scope token can also carry a folder path: `notebook:folder/path/` (trailing slash required). Recursive — matches notes in nested subfolders too, not just the folder's immediate contents. A colon-bearing token only counts as folder scope when it ends in `/`; without the trailing slash it's parsed as the first filter instead, not a folder.

**Pseudo-fields** — `mtime` (last-modified date, `YYYY-MM-DD`), `wordcount`, and `linecount` (both counted from the note's body, frontmatter excluded) are computed per note, not stored in YAML, and filterable with the exact same `field:value` syntax as real frontmatter:

```fm
mtime:2026-08-04 | Touched today
```

A pseudo-field always overrides a real frontmatter field of the same name if a note happens to have one.

**Filter conditions** (AND logic):

| Syntax | Meaning |
|--------|---------|
| `field:value` | Field equals value (case-insensitive) |
| `field:` | Field exists (any value) |
| `field:""` | Field absent or empty |
| `field:>value` | Field greater than value |
| `field:<value` | Field less than value |
| `field:value1,value2` | Field equals any of the listed values |
| `-field:value` | Negates any of the above — field does *not* match |

`>`/`<` try numeric comparison first (so `seq:>6` correctly treats `10 > 6`, not a lexicographic `"10" < "6"`), falling back to string comparison — which is exactly right for `mtime` and any other `YYYY-MM-DD` field, since lexicographic order matches chronological order for that format:

```fm
mtime:>2026-07-28 | Touched this week
```

A note missing the field entirely never matches a `>`/`<`, `eq`, or any-of filter (same as `eq` always has) — **except under negation**, where a missing field counts as a pass: `-type:cut` matches a note with no `type:` at all just as readily as one with `type: something-else`, since it certainly isn't `type: cut`.

type:story,plotline | Story or plotline cards
```fm
type:story,plotline | Story or plotline cards
```
---
type:story,plotline | Story or plotline cards
```fm
type:story,plotline | Story or plotline cards
```

-type:cut | Everything except cut material
```fm
-type:cut | Everything except cut material
```

**`sort:`/`limit:`** — directives, not match conditions; can appear anywhere among the filters, not just at the end:

| Syntax | Meaning |
|--------|---------|
| `sort:field` | Order ascending by field's value |
| `sort:-field` | Order descending (leading `-` on the field name) |
| `limit:N` | Keep only the first N results, after sorting |

Applied after the fact to whatever the scan already matched — a display-level cap, separate from the query's own internal safety limit (500 matches max, regardless of `limit:`). Same numeric-first-then-string comparison as `>`/`<`, so `sort:-mtime` correctly orders by real date and `sort:-seq` correctly orders `10` after `6`, not lexicographically:

Takeout:storylines/film-school/ type:story sort:-mtime limit:5 | 5 most recently touched
```fm
Takeout:storylines/film-school/ type:story sort:-mtime limit:5 | 5 most recently touched
```

`limit:` composes with `count`/`sum:` too — `count type:story limit:5` (count capped at 5) and `sum:budget sort:-mtime limit:5` (total spend across the 5 most recent) are both valid, if less common, shapes.

**`\| Label`** — optional label shown in the header bar.

**Examples:**

````markdown
```fm
shot: | All shots
```
````
Takeout type:shot loc:LG | Lee Gardens shots
```fm
Takeout type:shot loc:LG | Lee Gardens shots
```

Takeout:storylines/film-school/ type:story sort:seq | Film School story cards
```fm
Takeout:storylines/film-school/ type:story sort:seq | Film School story cards
```

model:true | Example notes
```fm
model:true | Example notes
```

#### fm: group — Grouped Counts

````markdown
```fm
group:plotline Takeout:storylines/ type:story | Story cards per plotline
```
````

A leading `group:<field>` verb (same reserved-prefix convention `list` uses — must be the very first token) buckets matches by that field's value instead of rendering one flat list. Each bucket shows as its own labeled sub-list, largest group first. Notes missing the field land in a `(none)` bucket rather than being dropped — a completeness scan wants those surfaced, not hidden.

Scope and filters after the `group:` token work exactly like the plain form — folder scope, multiple filters, and the `| Label` suffix all compose normally:

````markdown
```fm
group:type Takeout:storylines/film-school/
```
````

#### fm: count / sum — Header-Only Aggregates

````markdown
```fm
count Takeout:storylines/film-school/ type:story
```
````

```fm
sum:budget Takeout:storylines/ type:story
```

Two more leading verbs, same reserved-prefix convention as `group`/`list`. Neither renders a list — just the header, with the number. `count` shows the match count; `sum:<field>` totals that field's numeric value across every match. For counting inline in prose instead of as a standalone block, see `{{fm: count ...}}` in [Inline live queries](inline-queries.md) — same underlying query, different rendering surface.

`sum:` silently skips any matching note that lacks the field or holds a non-numeric value for it — the header shows `(counted/total)` so that's visible rather than hidden, and a missing/bad value is never treated as `0` (which would understate nothing but silently implies every match contributes, which usually isn't true — a budget field genuinely unset on 3 of 10 cards is very different from those 3 being budgeted at zero). Works for pseudo-fields too: `sum:wordcount` totals word count across every match, e.g. total words written across all scenes in a folder — no separate `wordcount` verb needed since it's exactly this with a fixed field name.

#### fm: list — FM Key Browser

````markdown
```fm
list
```
````

Shows a scrollable table of every frontmatter key found across the current notebook — sorted by note count. Columns: **Key · # notes · Sample values**. Click any row to drill into that field's note list (the same view as `field:`). A **← list** button returns to the browser.

**Scope tokens** narrow the key set:

| Token | Keys shown |
|-------|-----------|
| `list` | All keys in the notebook |
| `list-core` | Built-in nb-web keys (title, type, status, tags, access…) |
| `list-cine` | Film production keys (scene, shot, loc, cast, day_night…) |
| `list-empty` | Keys present in notes but with a null or empty value — useful for finding cruft |

**Row limit** — an integer after the token sets how many rows are visible before scrolling. Default is 8.

````markdown
```fm
list 20
```

```fm
list-core
```

```fm
list-empty 12
```
````

FM-mode syntax (`fm: list-core 10` in frontmatter) is also supported — the key browser appears as a collapsible FM strip block.

---

### cfg — Config Inheritance Tree

````markdown
```cfg
access: .
```
````

Visualises the configuration resolution chain from the global root (`~/.nb/.nb.md`) down to the current note's notebook and folder. Each level shows only what it **contributes** — inheritance is implied by indentation. Gated: `admin` read level.

**Syntax:**

| Form | Meaning |
|------|---------|
| `field: .` | Walk to current note's location; show `field` contributions |
| `field: Notebook:folder/` | Walk to a specific target |
| *(bare)* | Walk to current location; show all contributed keys |
| `tree` | Folder-tree walk mode — shows all config nodes in the notebook |
| `tree access nb:` | Tree walk, filtered to nodes that set `access`, scoped to `nb` notebook |

**FM-mode syntax rules:**

`field` must start with a word character (`a-z`, `0-9`, `_`). The parser splits on the first `:` after a valid field name. A value like `. access:` fails — the leading `.` is not a word character, so the whole string is treated as the target, not a field name.

```yaml
cfg: "access:"      # ✓ field=access, target=current note's notebook
cfg: "access: ."    # ✓ same — explicit current-context dot
cfg: "access: nb:"  # ✓ explicit notebook target
cfg: ". access:"    # ✗ parses as target='. access', not field=access
```

Values ending with `:` must be quoted in YAML.

**Output:**

```
● 🌐 ~/.nb/.nb.md                 codeblock_access, …
  ● 📒 Takeout/.Takeout.md        access, plugins, cine
    ● 📁 shots/.shots.md          default_type, sort, constraints
    ○ 📁 schedule/                (no config file)
```

`●` nodes are clickable — opens the config file in the preview pane for editing via **FM** or **Edit**. `○` nodes have no config file yet.

When a `field` is specified, only nodes that actually set that field show a value beside them:

````markdown
```cfg
access: .
```
````

Useful for tracing where `access:`, `default_type:`, or any other setting is actually coming from. Admin-only — does not appear for lower access levels.

**Config files** are identified by `type: dotfile` in frontmatter and their path convention (`~/.nb/notebook/folder/.folder.md`). Query them with `fm`:

````markdown
```fm
read: admin
type:dotfile | All config files
```
````

---

**Fenced body mode**

All `cfg` variants work equally in fenced codeblocks — the query goes in the **body**, not the info string. This is the recommended pattern for dotfile admin sections:

````markdown
```cfg
org -C 2 access, theme, check
```

```cfg
tree
```

```cfg
access: .
```
````

The FM form (`cfg: org` in frontmatter) propagates the block via the config chain — every note in scope sees it. The fenced form is local to the note body only, which makes it the right choice for the admin tools section of a dotfile: the FM frontmatter propagates policy, the body holds the sysadmin codeblocks. Two clear zones, one file.

---

#### cfg: org — Config Org Chart

The `org` mode renders an interactive, zoomable SVG org chart of every config file in the current notebook — the fastest way to audit, navigate, and fix your configuration landscape.

````markdown
```cfg
org
```
````

Or with filter chips pre-loaded in frontmatter:

```yaml
cfg: org access, access:guest, access:office, check, xref
```

**Global scope**

When the `cfg: org` block lives inside `~/.nb/.nb.md` (the super-notebook config file), it renders the *entire installation* — all notebooks as branches off the `⊕ .nb` global root. Every notebook and its folders appear in one chart. This is the sysadmin bird's-eye view: zoom out to see the whole wiring picture, zoom in to read labels, hover for tooltips, click to open or create any config file.

**What you see**

- **Left-to-right tree** — global `⊕ .nb` root (or notebook root for per-notebook charts) on the left; folders fan right.
- **Left slot** — type icon from the config file's own `type:` field, or `●`/`○` fallback. `○` = no config file exists yet at this level.
- **BG tint** — appears only on nodes that *explicitly set* `access:`; inherited access shows in the tooltip but is not painted on every node. green=guest · amber=office · red=admin · purple=tech.
- **Border** — solid stroke = has a config file; dashed stroke = no config file yet.
- **Border glow** — brightens when a filter is active and this node *explicitly sets* the filtered key.
- **Right slot** — number of FM keys this config contributes, or `…` if the node's children are suppressed by `cfg_skip:` (see below).
- **Hover tooltip** — path on line one; key: value lines from the config file with grep-style context around the active filter (see `-C` below).

**Zoom and pan**

The chart is fully interactive at any depth.

| Input | Action |
|-------|--------|
| `Ctrl` + scroll wheel | Zoom in / out at cursor |
| Pinch (touchpad) | Zoom in / out |
| Click and drag | Pan |
| `f` (mouse over chart) | Fit the whole tree into view |
| `+` / `-` | Zoom in / out by fixed step |
| `0` | Reset to fit |

The initial view centres the root node and scales to show as much of the tree as fits. Large installations may open zoomed in to the root — scroll back or press `f` to see the full picture.

**Filter bar**

Always visible above the chart. Three ways to filter:

| Control | What it does |
|---------|-------------|
| Freeform input | Type any `key` or `key:value`; live-filtered at 180 ms debounce; Esc resets |
| `[all]` chip | Remove filter — show full tree |
| `[access]` chip | Highlight nodes that *explicitly set* `access` (any value) |
| `[access:office]` chip | Highlight nodes that *explicitly set* `access: office` |

Chips are declared in the codeblock query as a comma-separated list after `org`. Key-only and `key:value` chips can be mixed freely:

```yaml
cfg: org access, access:guest, access:user, access:office, access:admin, check, xref
```

The chips control *client-side* display only — all nodes are always fetched. Dimmed nodes still exist; they just don't match the active filter.

**Extending the chip list without restating it (`cfg_attr_add:`/`cfg_attr_skip:`)**

The chip list above is set once, wherever the FM `cfg: org ...` block lives (usually the notebook root or global `.nb.md`) — every note in scope inherits that exact list. A deeper folder wanting one extra chip had to copy the whole comma-separated list into its own `.{folder}.md` just to add one token. `cfg_attr_add:`/`cfg_attr_skip:` avoid that: set on any config file in the walk-up chain (global → notebook → folder), they union additional chips in / remove chips from the inherited list, same accumulate pattern as `check_add:`/`check_skip:`:

```yaml
# home/.home.md — add a `hledger` chip on top of whatever .nb.md already declares
cfg_attr_add: hledger
```

```yaml
# accts/.accts.md — this notebook doesn't want the xref chip cluttering its chart
cfg_attr_skip: xref
```

Only affects `cfg: org`/`cfg: tree` values (the only `cfg:` shapes with a chip list) — plain `cfg: access:` target-form queries are untouched. Not the same key as `cfg_skip:` below, which is unrelated (per-node chart pruning, not a chip-list edit).

**Depth limit (`-D N`)**

Cap how many folder levels the walk descends. Useful for large notebooks where you only need to see the top-level folder layer:

```yaml
cfg: org -D 2 access, check
```

`-D 0` (the default) is unlimited. `-D 1` shows only the notebook root; `-D 2` adds one folder layer; and so on. Can be combined with `-C`:

```yaml
cfg: org -D 3 -C 4 access, check
```

**Tooltip context (`-C N`)**

Each hover tooltip shows the matched key plus N lines of context above and below (grep-style `-C`). Default is 2:

```yaml
cfg: org -C 4 access, check
```

No filter active → first C keys + overflow hint. Filter active → C lines before ▶ matched key, C lines after, with `⋯ N above/below` hints when there's more.

**Pruning noisy branches (`cfg_skip:`)**

Add `cfg_skip: true` to any config file (`.{notebook}.md` or `.{folder}.md`) to suppress that node's children from the org chart. The node itself stays visible with a `…` indicator in the right slot; clicking it still opens or creates the config file.

This is useful for reference notebooks or large folder collections where subfolders have no config files and don't need to appear in the chart. Example — add to `tutorial:.tutorial.md`:

```yaml
---
cfg_skip: true
---
```

After a chart refresh, the `tutorial` notebook shows as a single leaf node instead of 19 branches.

**Clicking nodes**

- `●` node (solid border) — opens the config file directly in the preview pane.
- `○` node (dashed border) — creates the config file from the global template and opens it immediately.

**The sysadmin loop**

Zoom out → read the coloured outlines to understand wiring at a glance → hover any node for specifics → zoom in on a gap → click to open or create → fix → refresh. The chart is the live, always-current map of your configuration landscape.

---

### sysadmin — Admin Dashboard

````markdown
```sysadmin
```
````

A dashboard block for installation-wide admin tasks — notebook inventory, plugin list, key config file checklist, and (via its two modes below) user management and the live crontab. **Requires `tech` level** — every mode's own backend endpoint checks this independently of any page the block happens to sit on, so it's a real access lock, not just a note-level convention. `djp:sysadmin.md` is the reference installation of this block; copy its structure for a second admin dashboard rather than starting from scratch.

**Bare form** (no argument) — notebook inventory (dotfile presence, wired/remote/branch, active plugins, has `.checks/`, note count), the installed plugin list, and a checklist of key config files (global dotfile, manifest, checks index, guards rule, tools index, `nb-settings.json`) with existence ticks. Click a notebook name to open its dotfile.

**`users` mode** — a full user-management panel, not just a read-only list:

````markdown
```sysadmin
users
```
````

Lists every account (username, access level, display name, notebook scoping). Change a user's level inline via the dropdown; delete a user (except yourself) via 🗑; **+ Add user** creates a new account with username/name/level/password. Backend (`/api/users`) enforces `admin` level independently — one level below the `tech` this block type itself defaults to, so in practice anyone who can see this block can also use it.

**`crontab` mode** — the real, current output of `crontab -l` for the user running nb-web, parsed into schedule / command / description (a leading `#`-comment line above an entry is taken as its description — the same convention `check-sweep`'s own cron entry uses):

````markdown
```sysadmin
crontab
```
````

**Access note**: this block type is also gated in `codeblock_access` (`{read: tech}`, added 2026-07-21) — belt-and-suspenders on top of each mode's own independent backend check above, so the block silently disappears from the page for a sub-`tech` viewer instead of showing an inline denial.

---

### toc — Table of Contents

`toc` is FM-mode only — declare `toc: true` in frontmatter; there is no fenced body form.

```yaml
---
toc: true
---
```

Adds a collapsible TOC barblock to the FM strip. The header shows the heading count; expanding it reveals a clickable list of every heading in the note. Clicking a heading scrolls smoothly to it.

Headings `h1`–`h6` are all included. Indentation in the list reflects heading level. IDs are auto-assigned via slug if the heading has none (`# My Section` → `my-section`).

The block starts collapsed; open/closed state persists in `localStorage` per note.

---

### test — Embedded Assertions

Script-driven checks embedded directly in notes. Scripts live in `~/.nb/.checks/` and run via the nb-web Flask server — no terminal needed. Browse the bundled scripts with a `nav` block:

````markdown
```nav
~/.nb/.test
```
````

**Form 1 — on-demand (with label):**

````markdown
```check
hl-recent-txn | Recent transactions
```
````

Renders a `▶ Recent transactions` button. Click to run; output replaces the button area.

**Form 2 — automatic (no label):**

````markdown
```check
hl-ok
```
````

Runs at render time. **Exit 0 + no output → block vanishes completely.** Output or non-zero exit → renders as full markdown. A note peppered with Form 2 blocks is invisible when everything is healthy.

**Form 3 — group (multiple scripts, one per line):**

````markdown
```check
hl-ok
tw-due
nb-dirty
```
````

All run in parallel. All pass → block vanishes. Any fail → `N of M checks failed` header with a collapsible toggle row per failure. Add a label to auto-run as a button instead:

````markdown
```check
hl-ok | Health checks
tw-due
nb-dirty
```
````

A bare `| Label` line sets the group label without labelling individual scripts:

````markdown
```check
| Dashboard checks
hl-ok
tw-due
```
````

---

#### Bundled scripts

| Script | Form | Purpose |
|--------|------|---------|
| `hl-test` | 2 | hledger binary self-test; silent when all 245 pass |
| `hl-ok` | 2 | Silent when journal is clean; shows `hledger check` errors |
| `hl-strict` | 2 | `hledger check --strict`; explains undeclared commodity errors |
| `hl-optional` | 2 | Radar sweep — all 5 optional checks; silent when all pass |
| `hl-ordereddates` | 2 | Transactions out of date order within a file |
| `hl-recentassertions` | 2 | Balance assertions older than 7 days |
| `hl-tags` | 2 | Undeclared tag names |
| `hl-payees` | 2 | Undeclared payees |
| `hl-uniqueleafnames` | 2 | Two accounts share a leaf name |
| `hl-budget-has-periodic` | 2 | Guides setup if no `~ monthly` rules found |
| `hl-budget-balanced` | 2 | Detects unbalanced budget transactions |
| `hl-budget-include-check` | 2 | Verifies periodic journal is included in main journal |
| `hl-budget-has-actuals` | 2 | Checks that actual transactions exist |
| `hl-budget-has-income` | 2 | Checks that income postings exist in the budget |
| `hl-budget-runs` | 2 | Verifies `hledger bal --budget` runs without error |
| `nb-dirty` | 2 | Silent when committed; lists dirty files in current notebook |
| `note-disk-warn` | 2 | Silent under 80% disk; warns above that |
| `note-slow` | 2 | Notice when file >50 KB or ≥5 inline includes |
| `tw-due` | 2 | Silent with no due tasks; lists overdue/today tasks |
| `note-approved` | 2 | Amber banner when `approved:` frontmatter is blank |
| `hl-recent-txn` | 1 | Last 14 days of transactions — on demand |
| `note-context` | 1 | Markdown table of all context variables — on demand |
| `hl-balances` | 1 | Depth-1 balance table — on demand |

**Form 4 — glob prefix (dangling dash):**

A script name ending in `-` expands to all matching scripts in `~/.nb/.checks/` at render time:

````markdown
```check
nb-schem-
```
````

Runs every `nb-schem-*.sh` script as a group. Add a new script to the family and it appears automatically — no codeblock edits needed. Works in single-line and multi-line forms:

````markdown
```check
| nb checks
nb-config-
nb-schem-
nb-ref-
```
````

---

**Script naming convention:**

Scripts use hyphen-separated names. The prefix is the application domain; sub-families add a second level separated by another hyphen. The dangling-dash glob runs an entire family.

| Prefix | App | Example families |
|--------|-----|-----------------|
| `hl-` | hledger | `hl-budget-`, `hl-entry-`, `hl-reconcile-`, `hl-close-`, `hl-tax-` |
| `nb-` | nb / nb-web | `nb-config-`, `nb-schem-`, `nb-ref-` |
| `tw-` | Taskwarrior | — |
| `note-` | system/global | — |

---

#### Placement patterns

**Health dashboard** — Form 2 blocks at the top of a hub note. Invisible when healthy; surface on failure:

````markdown
```check
hl-ok
```
```check
nb-dirty
```
```check
tw-due
```

# My Hub Note
````

**On-demand reference** — Form 1 in a journal or guide:

````markdown
```check
hl-recent-txn | Recent transactions
```
```check
hl-balances | Account balances
```
````

**Invisible guardrail** — embed a check in a setup note. New users see the error; experienced users with everything configured see nothing.

---

#### `check:` as a config directive

Declared in a config note's frontmatter, `check:` specifies scripts that auto-run (Form 2) on every note that inherits that config — no explicit codeblock in the body needed:

```yaml
# in .notebook.md or .folder.md
check: |
  nb-dirty
  note-disk-warn
```

Notes inheriting this config behave as if they had an unlabelled ` ```check``` ` block at render time. All pass → invisible. Any fail → surfaces at the top of the note.

Inherited through the config chain: notebook config → folder config → note. A folder config scopes checks to that folder only; a notebook config applies across the whole notebook.

`check:` is **not** a toolbar block (it has no FM-mode incarnation). It is a policy directive — declare it in config files, not in regular notes.

---

#### Status panels

A dedicated `status.md` note containing only Form 2 blocks, included anywhere via `{{inline:}}`:

```markdown
{{inline: accts:status.md}}

# My Note
```

`status.md` has **zero visual footprint when everything is healthy** — the inline renders nothing. The moment any check fails, its output surfaces right at the top of whatever note you're reading. Because `{{inline:}}` runs the full render pipeline on the included content, test blocks in `status.md` receive the **host note's context** — `nb-dirty` reports on the right notebook automatically.

Different notebooks have different concerns:

```markdown
{{inline: accts:status.md}}     ← journal health, uncommitted changes
{{inline: home:status.md}}      ← disk space, overdue tasks
```

---

#### Books — the diagnostic TOC

When Form 2 blocks are embedded in chapter notes inside a `type: book`, failing checks produce `### ⚠ Heading` output that gets picked up by the book's TOC rebuild. The table of contents becomes simultaneously a chapter navigator and a live health dashboard — `⚠` entries appear inline with chapter headings, positioned exactly where the problem lives.

A healthy book shows a clean TOC. A book with problems shows `⚠` entries. No separate dashboard, no extra code — an emergent property of the test + inline + TOC pipeline.

See [BOOKS](BOOKS.md) for the full pattern.

---

#### Self-censoring includes

`{{inline:}}` silently respects access levels — inaccessible content renders as nothing, leaving the note looking normal to lower-level users.

**Markdown notes** — any note with `access:` frontmatter self-censors when inlined:

```yaml
---
title: Q4 Payroll Summary
access: admin
---
```

```markdown
{{inline: accts:q4-payroll.md}}
```

Users below `admin` see an empty render. The note is not visible, not 403'd — just absent.

**`.lib/` components** — HTML and other non-markdown files declare their level in the filename suffix:

```markdown
{{inline: .lib:dashboard-user.html}}
{{inline: .lib:dashboard-office.html}}
{{inline: .lib:dashboard-admin.html}}
```

Each file renders for users at that level and above; others see nothing. Stack multiple inlines for additive tiers — guest through admin each see their appropriate layer accumulate.

See [security](dev/dev-security.md#ii-access-control) and `.rules/access.md` for the full convention.

---

---

### csv — Spreadsheet Table

Renders an editable spreadsheet grid directly in the note preview. Data lives inside the fenced block and is written back on save — no separate file, no sync step.

````markdown
```csv
Item,Qty,Price
Wrench,2,14.99
Tape,5,3.50
```
````

The first row is always the **column header**. Remaining rows are data. The grid uses [Jspreadsheet CE](https://bossanova.uk/jspreadsheet/) — you can sort, resize columns, and manage rows via right-click context menu.

**Controls:**

| Control | Action |
|---------|--------|
| Click header bar | Collapse / expand the block |
| Right-click cell | Jspreadsheet context menu — insert/delete rows and columns, copy, paste |
| **↓** (save button) | Write current grid contents back to the note |

Changes made directly in the grid are **not auto-saved** — click **↓** when done.

---

#### csv templates

A named token after `csv` loads a reusable column template from `~/.nb/.lib/<token>.csv`, keeping column structure out of the note body.

````markdown
```csv materials
Copper pipe 1/2,3,m,4.50,13.50
PVC elbow fitting,6,ea,1.20,7.20
```
````

The template file (`~/.nb/.lib/materials.csv`) defines the structure:

```csv
Description,Qty,Unit,Unit Cost,Total
contents
TOTAL,,,,=SUM(E1:E1)
```

**Template format:**

| Row | Role |
|-----|------|
| First row | Column headers — displayed as the spreadsheet header |
| `contents` | Sentinel — separates header rows from footer rows |
| Rows after `contents` | Footer rows — appended after user data; formula cells are evaluated by Jspreadsheet |

The `contents` row never appears in the rendered grid. Rows above it become column headers; rows below become a fixed footer (useful for `=SUM()` totals). The codeblock body holds only the **data rows** — the template rows are never written back to the note.

**Formula ranges are rewritten at render time.** The upper bound of any range starting at row 1 is replaced with the actual data row count before the grid is initialised. This prevents circular references when the footer row lands inside the formula range (which happens whenever the data is shorter than the range you wrote).

In practice: always write footer formulas with `1` as the upper bound — `=SUM(E1:E1)`, `=SUM(D1:D1)`. The renderer expands it to the correct last row automatically. You never need to update the template when rows are added or removed, and the same template works correctly for notes with one row or a hundred.

**Template controls:**

| Control | Action |
|---------|--------|
| **CSV** badge (header) | Open the catalog checklist picker (see below) |
| **↓** button | Save data rows back to the note (header and footer rows excluded) |
| Right-click | Jspreadsheet context menu for row/column management |

**Creating a template:** write a plain `.csv` file to `~/.nb/.lib/` with the token name. The `contents` sentinel and footer rows are optional — a template with only a header row is valid. Formula syntax is standard spreadsheet style (`=SUM(E1:E6)`, `=E2*D2`); adjust row ranges to match your expected data size.

#### Checklist picker

Click the **CSV** badge on any template block header to open a catalog checklist. It reads the nearest `type: <token>` note (walking up the folder tree) and shows all its items grouped by heading.

Items already present in the spreadsheet are pre-checked. Check or uncheck items, then click **Save** — the selection replaces the spreadsheet's data rows and writes immediately back to the note. The catalog remains untouched.

This is the primary way to populate a template block from a master list: write the catalog once, pick from it per-note.

#### csv in FM-mode — compact catalog view

Declaring `csv: <token>` in frontmatter renders a compact read-only summary in the FM strip instead of a full spreadsheet. This is useful for a quick cost overview without expanding the grid.

```yaml
csv: materials
csv: materials 12
```

The value is the catalog token. An optional integer sets the visible row limit before scrolling (default 8). The FM strip shows **description left, cost right**, grouped by the catalog's headings. Clicking a group heading opens the catalog note.

#### Opening a `.csv` file directly

This is a different, simpler path than the codeblock above — any `.csv` file anywhere in a notebook opens as a full-pane spreadsheet editor automatically, no fence needed. Column widths are set from actual content (same as the codeblock form), and the grid fills the whole preview pane.

**Header row** is a manual toggle (**First row is header**, in the toolbar next to Save/Cancel) — off by default, every time you open the file. It's not remembered between sessions and never auto-detected: a raw export file (bank statement, etc.) often has no header row at all, and guessing wrong would risk quietly turning a real data row into a column title. Check it to pin row 1 as column headers and pull it out of the data grid; uncheck to put it back. Toggling preserves any edits you've already made — it doesn't reload the file.

---

Developer internals and script authoring: [codeblocks](dev/dev-codeblocks.md)
