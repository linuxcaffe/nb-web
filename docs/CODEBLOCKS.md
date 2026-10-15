<!-- Generated from docs:CODEBLOCKS.md by .tools/readme-export.py. Edit the source, not this file. -->

# Codeblocks

[Block Controls](#block-controls) · [Access Gates](#access-gates)

**Navigation:** [nav](#nav--folder-navigator) · [gallery](#gallery--image-gallery) · [toc](#toc--table-of-contents)  
**Introspection:** [fm](#fm--frontmatter-filter) · [cfg](#cfg--config-inheritance-tree) · [sysadmin](#sysadmin--admin-dashboard)  
**Authoring:** [toolbar](#toolbar--shortcut-buttons) · [csv](#csv--spreadsheet-table) · [add](#add--create-wizards)  
**External data:** [tw](#tw--taskwarrior) · [hl](#hl--accounting) · [nb](#nb--nb-panel) · [git](#git--git-log)  
**Time tracking:** [t](#t--timeclock) · [timedot](#timedot--time-journal)  
**Testing:** [test](#test--embedded-assertions)  
**Under review:** [chart](#chart--financial-charts) · [cine](#cine--film-production)

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

**Collapse state** — FM-mode blocks start collapsed. Most (anything with its own `+`/`↻`-driven
lazy load — `tw`, `hl`, `nb`, `git`, `fm`, `cfg`, `nav`, `gallery`, `toc`, `t`, `timedot`, `csv`,
`sysadmin`, `add`) **always** start collapsed on every open — clicking one open is a per-visit
convenience, not a remembered preference; it does not survive a reload. The exceptions are the
few blocks that render immediately rather than lazily (`check`, `tui`) — those do remember
open/closed in `localStorage` across reloads, the same as body blocks. Checked against code
2026-10-09, writing `block-toc`: the previous wording ("persisted the same as body blocks")
described only this second, smaller group.

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

## Navigation

Move around your notes without leaving the one you are in.

### nav — Folder Navigator

#### Summary

A `nav` block renders a small, stateful file browser right inside the note: a breadcrumb trail
plus a list of folders and notes you click through, no page navigation involved. Point it at a
notebook folder, the current note's own folder, or — for admins — a raw filesystem path under
`~/.nb/`. Leave the fence empty and it opens at the top, listing every notebook.

#### How it works

````markdown
```nav
accts:guide/
```
````

| Body | Navigates to |
|---|---|
| *(empty)* | Every notebook — click one to drill in (also where the `nb` breadcrumb segment returns to) |
| `.` | The current note's own folder |
| `notebook` | That notebook's root (same as `notebook:`, just without the colon) |
| `notebook:folder/path` | A specific folder (trailing slash optional) |
| `~/.nb/notebook/folder` | The same folder, written as a filesystem path |
| `~/.nb/.hidden-dir` | A raw filesystem listing of a hidden dot-folder (`.test`, `.templates`, …) |

Clicking a folder drills in; clicking a note opens it in the preview pane. Every breadcrumb
segment is clickable, including the root `nb` segment, which returns to the notebook list.

**Collapse state is keyed to the block's original body, not wherever you've navigated to** — so
a `nav` block written as `accts:guide/`, clicked three folders deeper then collapsed, reopens
the note still three folders deep and still collapsed, both remembered under the one key
`accts:guide/` was given, regardless of where you last left it.

**Hidden-dir browsing is admin-gated**, except `.lib` and `.images`, which stay world-readable —
the raw filesystem-listing form is meant for config/dev browsing (`.test`, `.checks`,
`.templates`), not general-purpose use.

#### Reference

- No read/write level of its own — gated **by destination** (see
  [Access gates](#access-gates)): a notebook folder follows that notebook's
  own `access:`; a hidden dir needs `admin` unless it's `.lib` or `.images`. A 403 from the
  destination removes the block silently, the same as everywhere else in nb-web.
- No `+` (add) or `⎋` (open) controls on this block — browse and open only.
- In frontmatter (`nav: accts:guide/`) it shows in the note's header strip instead of the body.

#### For developers

Renderer: `_loadNavBlock` (`plugins/nbweb-codeblocks.js`), query parsed by `_navParseQuery`.
Backed by `/api/notes` (notebook/folder mode), `/api/nb/notebooks` (empty/root mode), or
`/api/fs/list` (raw filesystem mode — the admin gate above is enforced there, server-side).
Already on the shared `_buildBarHeader`/`_initCollapseToggle` header, so it gets the universal
`?` and `↻` controls for free rather than building its own. Broader renderer architecture:
[codeblocks](dev/dev-codeblocks.md) #REVIEW.

---

### gallery — Image Gallery

#### Summary

A `gallery` block renders a responsive grid of images from the nearest `images/` folder —
walking up from the note's own location unless told otherwise — with a full-screen lightbox on
click. It shares its size vocabulary and `images/` folder convention with the editor's own
image-embed button, so dropping a photo in while editing shows up here automatically.

#### How it works

````markdown
```gallery
med
```
````

```gallery
thumb features:images/
```

| Body | Finds images in |
|---|---|
| *(size only, e.g. `med`)* | The nearest `images/` folder, walking up from the note |
| `med .` | Only this note's own folder's `images/` — vanishes silently if there's none |
| `large notebook:path/` | A specific folder, named directly |

**Sizes** — the first word sets the grid cell width: `thumb` 80px, `small` 140px, `med` 220px,
`large` 320px.

**Adding images while editing** — the 📷 button next to **mkd ref** (or `Ctrl+Shift+1`) opens a
small picker: an existing image from the note's own gallery folder, or **Browse…** for a new
file. The dedicated "📷 Camera" quick-button in that picker is still a disabled stub ("coming
soon") — but **Browse… already triggers your device's native photo/camera picker on a phone**,
since it's a plain file input with no source restriction; that's full camera capture today,
just not as a dedicated one-tap shortcut yet. A brand-new upload lets you rename it first
(handy for camera-roll names like `IMG_20260904_143201.jpg`); picking an existing image skips
straight to size. Either way the file lands in this gallery's own folder — no configuration
needed. See [Keyboard § Adding and editing](KEYBOARD.md#adding-and-editing).

*The single-image embed picker shares this same size vocabulary, plus a "Full size" option —
but there it sets just that one image's own display width in the note body, a different
setting from the grid's cell size, not the same one.*

**Lightbox** — click any thumbnail to open; ← / → to navigate; Esc or click outside to close.

#### Reference

- **No access gate of its own, client or server.** Any `read:`/`write:` lines in the fence body
  are parsed out like every other block, but have no effect here — this block never checks
  them. The backend (`/api/gallery`, `/api/file`) only enforces the account's `notebooks:`
  scope restriction, not the target notebook's own `access:` level — flagged for a dedicated
  security pass, not yet fixed.
- In frontmatter (`gallery: med .`) it shows in the note's header strip instead of the body.
- **FM-mode YAML quoting** — the value is always `size path`; a value with no space is parsed
  entirely as the size (the path is silently dropped, falling back to walk-up behaviour); a
  value starting with `.`/`/` or ending in `:` must be quoted (`"thumb .images:"`,
  `"med ~/.nb/.images"`) or YAML parsing breaks.

#### For developers

Renderer: `_loadGalleryBlock` (`plugins/nbweb-codeblocks.js`), backed by `/api/gallery`
(`list_images`/`_nearest_image_dir` in `app.py`). Lightbox: `_galleryLightbox`. The editor's
image-embed modal (`_openImageEmbedModal`, `main.js`) is a separate feature sharing the same
`images/` convention and size scale. Already on the shared `_buildBarHeader`/
`_initCollapseToggle` header. Broader renderer architecture: [codeblocks](dev/dev-codeblocks.md)
#REVIEW.

---

### toc — Table of Contents

#### Summary

`toc: true` in frontmatter adds a collapsible table of contents to the note's FM strip: the
header shows the note's path and heading count, and expanding it lists every heading, indented
by level, each a clickable link that scrolls smoothly to it.

#### How it works

```yaml
---
toc: true
---
```

Headings `h1`–`h6` are all included, indented by level. A heading with no `id` gets one
auto-assigned from its text (`# My Section` → `my-section`); clicking a list entry scrolls the
heading into view.

**It starts collapsed every time you open the note** — like most FM-mode blocks (see
[FM-mode](#fm-mode)), expanding it is a per-visit convenience, not a
remembered preference; it does not stay open across a reload.

**`toc_min:`** — an integer frontmatter key that suppresses the TOC entirely on notes with
fewer headings than that count, so a short note doesn't carry a near-empty TOC block. It
cascades through the config chain the same way `toc:` itself does (folder → notebook → note).

#### Reference

- No fenced body form is documented, and there's no reason to reach for one — `toc` is
  FM-mode only by design (`toc: true` in frontmatter). The generic renderer pipeline doesn't
  technically forbid a ` ```toc``` ` fence in a note's body, but the block ignores whatever text
  is inside it, so a body fence would render the exact same (notebook-wide) TOC with no
  advantage over the frontmatter form.
- **Books get a free diagnostic TOC**: when `test`/`check` blocks inside a `type: book`'s
  chapters fail, their `### ⚠ Heading` output surfaces inline in this same list — see
  [Books: the diagnostic TOC](#books--the-diagnostic-toc).

#### For developers

Renderer: `_loadTocBlock` (`plugins/nbweb-codeblocks.js`) — reads headings live from
`#nb-preview-content`, not from parsed markdown, so it reflects whatever `{{inline:}}` chapters
have actually landed in the DOM. Already on the shared `_buildBarHeader`/`_initCollapseToggle`
header. Broader renderer architecture: [codeblocks](dev/dev-codeblocks.md) #REVIEW.

---

## Introspection

Look at the notes and settings themselves: frontmatter, config, the server.

### fm — Frontmatter Filter

#### Summary

An `fm` block lists the notes whose frontmatter matches a query: `status:active` finds every
note with that status, in every notebook you can open. Put notebook or folder names first to
narrow where it looks, add more `field:value` filters to narrow what it finds, and sort or cap
the list. Click a result to open it; hover it to see all its fields. The same block can also
count, total or group the matches, list every key in a notebook, or show an edit form.

#### How it works

````markdown
```fm
features:examples/jobs/ type:job status:active | Active jobs
```
````

A query has three parts, in this order, separated by spaces:

1. **Where to look** (optional). A bare word is a notebook: `features`. `notebook:folder/` is a
   folder and everything under it (the trailing `/` is required). `.` is the current note's
   notebook. Give several to search several places. With none, it searches every notebook you
   can open.
2. **Filters** (optional), all of which must match: `field:value`, as in the table below.
3. **A label** (optional): ` | Label` at the end shows in the block's header.

The live examples on this page query the made-up jobs in
features:examples/jobs/: six renovation jobs, each with `client`,
`status`, `budget`, `due` and `tags`.

```fm
features:examples/jobs/ type:job status:active | Active jobs
```

##### Filters

| Filter | Matches notes where |
|---|---|
| `field:value` | the field equals the value (upper/lower case doesn't matter) |
| `field:"two words"` | the same, for a value with spaces |
| `field:a,b` | the field equals any of the values |
| `field:` | the field is there, with any value |
| `field:""` | the field is missing or empty |
| `field:>value` / `field:<value` | the field is greater / less than the value |
| `-field:…` | the opposite of any of the above |

A note without the field never matches a filter, except a negated one: `-status:done` also finds
notes with no `status` at all.

**Lists.** A field that holds a list, like `tags: [kitchen, acme]`, matches if any item does:
`tags:kitchen` finds it, and `-tags:acme` leaves it out.

**Greater and less than.** A number compares as a number, so `budget:>5000` finds 9000 and
12000, and leaves out a budget of `TBD`. Anything else compares as text, which works for dates
written `YYYY-MM-DD`: `due:<2026-12-31` is due before the new year.

````markdown
```fm
features:examples/jobs/ type:job -status:done due:<2026-12-31 | Open, due this year
```
````

```fm
features:examples/jobs/ type:job -status:done due:<2026-12-31 | Open, due this year
```

**Fields every note has.** `mtime` (the day the file last changed, `YYYY-MM-DD`), `wordcount`
and `linecount` (of the body, frontmatter left out) are worked out for each note, and filter
like any other field: `wordcount:>500`, `mtime:>2026-10-01`. They win over a real frontmatter
field of the same name.

##### Sorting and a limit

`sort:field` puts the list in order of that field; `sort:-field` reverses it. Numbers sort as
numbers, then come text values, and notes without the field always come last. `limit:N` keeps
the first N, after sorting. Both can go anywhere among the filters.

````markdown
```fm
features:examples/jobs/ type:job sort:-budget limit:3 | Three biggest jobs
```
````

```fm
features:examples/jobs/ type:job sort:-budget limit:3 | Three biggest jobs
```

##### The list

The header shows how many notes matched, which notebook they're from (or how many notebooks),
and the label. When the results come from more than one notebook, each row also shows its
notebook. Click a row to open the note; hover it to see all its fields, `mtime`, `wordcount` and
`linecount` included.

**In the header strip.** As frontmatter, the same query shows above the note instead of in it:
`fm: features:examples/jobs/ type:job status:active`.

#### Reference

- **Other forms of the block:** [group, count and sum](blocks/fm/aggregate.md),
  [the key browser](blocks/fm/list.md) (`list`), [the edit form](blocks/fm/edit.md)
  (`edit`).
- **In a sentence:** `{{fm: count …}}` takes the same query and shows just the number, and
  `{{fm: tags}}` shows one field of the current note. See [Inline live queries](inline-queries.md).
- **Access:** `admin` by default (`codeblock_access: fm:` in `~/.nb/.nb.md`, or `read:` in the
  block). Whatever the level, the results only ever include notes you can open, from notebooks
  your account may use.
- **Limit:** a query stops at 500 matches. An empty block lists every note it can find, up to
  that.
- Config files inside notebooks (`.notebook.md`, folder configs) and dot-folders are never
  results. With no notebook named, admins also search the global config files at the top of
  `~/.nb` (`.nb.md`).

#### For developers

Renderer: `_loadFrontBlock` (`plugins/nbweb-codeblocks.js`) parses the query with
`_frontParseQuery` and draws the list with `_frontRender`; `_fmSortLimit` sorts and limits in the
browser. Backend: `/api/front-query` → `_run_front_query` (`app.py`), which walks the notebooks
and filters with `_front_matches`/`_fm_eval_one`. `_parse_fm_scope` is the Python twin of the
parser, for `{{fm: count}}`; change both together. Codeblock architecture:
[codeblocks](dev/dev-codeblocks.md) #REVIEW.

---

### fm group, count, sum — Totals

#### Summary

Start an `fm` query with `group:field`, `count` or `sum:field` and it stops listing notes one by
one. `group:` splits the matches into one list per value of a field, biggest first; `count` shows
just how many matched; `sum:` adds up a number field across them. Everything else in the query
(where to look, filters, sorting, a label) works as in a plain [fm query](blocks/fm.md).

#### How it works

The word goes first, before where to look:

````markdown
```fm
group:status features:examples/jobs/ type:job | Jobs by status
```
````

```fm
group:status features:examples/jobs/ type:job | Jobs by status
```

**`group:field`** makes one list per value of the field, the biggest group first, with each
group's size beside its name. Notes without the field go in a `(none)` group, so you can see
what's missing:

```fm
group:client features:examples/jobs/ type:job | Jobs by client
```

A list field (`tags: [kitchen, acme]`) groups by the whole list, not by each item.

**`count`** shows only the number of matches, in the header:

````markdown
```fm
count features:examples/jobs/ type:job -status:done | Open jobs
```
````

```fm
count features:examples/jobs/ type:job -status:done | Open jobs
```

**`sum:field`** adds up a field across the matches. A note whose field is missing or not a number
is left out of the total rather than counted as 0, and the header says how many were counted,
as in `(4/6)`:

````markdown
```fm
sum:budget features:examples/jobs/ type:job | Booked
```
````

```fm
sum:budget features:examples/jobs/ type:job | Booked
```

Two of the six jobs have no number for `budget` (one says `TBD`, one has none), so the total
covers four. `sum:wordcount` adds up the words in every match, for instance across a book's
chapters.

**Sorting and `limit:`** apply before grouping, counting or adding: `sum:budget sort:-mtime
limit:5` totals the five most recently changed.

#### Reference

- In a sentence, `{{fm: count …}}` gives the same count as the `count` block. See
  [Inline live queries](inline-queries.md).
- `group`, `count` and `sum` are only words when they come first. A field really called `count`
  still filters normally further on (`count:5`).
- `group:field` and `sum:field` need something after them, a place or a filter. Alone,
  `sum:budget` is read as a filter (notes whose `sum` is `budget`); `sum:budget .` totals the
  current notebook.
- Same access and the same 500-match limit as [fm](blocks/fm.md).

#### For developers

`_loadFrontBlock` (`plugins/nbweb-codeblocks.js`) spots the leading word and hands off to
`_frontRenderGrouped`, `_frontRenderCount` or `_frontRenderSum`; all three fetch the same
`/api/front-query` as the plain list and work on the result in the browser. Codeblock
architecture: [codeblocks](dev/dev-codeblocks.md) #REVIEW.

---

### fm list — Key Browser

#### Summary

`list` in an `fm` block shows a table of every frontmatter key used in the current notebook:
how many notes have it and a few of its values. Click a key to see the notes that have it, and
**← list** to come back. Use it to learn a notebook's fields before you query them, or with
`list-empty` to find fields left blank.

#### How it works

````markdown
```fm
list
```
````

The table is about the notebook of the note the block is in, and has three columns: **Key**,
**# notes**, and up to four sample values. The most used keys come first. Clicking a key turns
the block into a plain [fm query](blocks/fm.md) for that key in that notebook
(`notebook key:`); **← list** goes back.

```fm
list 6
```

A number after the word sets how many rows show before the table scrolls (8 if you leave it out).

**Narrower lists:**

| Block | Keys shown |
|---|---|
| `list` | every key |
| `list-empty` | keys that some notes have but left empty: a cleanup list |
| `list-core` | nb-web's own keys: `title`, `type`, `status`, `tags`, `access`, `alias`, `date`, `due`, `started`, `completed`, `project`, `draft`, `pinned`, `color`, `icon`, `template`, `renderer`, `related`, `description` |
| `list-<plugin>` | the keys a plugin declares, e.g. `list-cine` (scene, shot, loc, cast, day_night…) |

A plugin name that declares no keys shows **Unknown scope** instead of a table.

#### Reference

- Only notes you can open are counted, and only in notebooks your account may use.
- Config files (`.notebook.md`, folder configs) aren't counted: their keys are settings, not
  note fields.
- As frontmatter: `fm: list-core 10` puts the table in the header strip.
- Same access as [fm](blocks/fm.md) (`admin` by default).

#### For developers

`_loadFmListBlock` (`plugins/nbweb-codeblocks.js`) fetches `/api/fm/keys?notebook=` (`api_fm_keys`,
`app.py`), filtered with `keys=` for a scope. Scopes come from `NbWeb.getFmKeysForScope`
(`nbweb.js`): `core` is built in, and a plugin adds its own with `fmKeys: [...]` in
`registerModule`. Codeblock architecture: [codeblocks](dev/dev-codeblocks.md) #REVIEW.

---

### fm edit — the Frontmatter Form

#### Summary

The frontmatter form edits a note's fields without touching YAML: one row per field, with a
dropdown, checkbox, date picker or text box depending on what the folder says the field is. It
also offers the fields the folder expects that the note doesn't have yet. Open it with the
toolbar's **FM** button on any note, or put an `fm` block with `edit` in a note to give it its
own button.

#### How it works

````markdown
```fm
edit |Edit this job
```
````

This shows a button labelled with the text after `|` (**fm-edit** if there's none). Clicking it
opens the same form as the toolbar's **FM** button, for the note you're viewing. (In a chapter
pulled into a book with `{{inline:}}`, that's the book.)
Jones kitchen has one to try.

**The rows.** Each top-level `key: value` line of the note's frontmatter gets a row. Multi-line
values (`key: |`) and nested lines aren't shown, and stay as they are. A list shows as its text,
`[kitchen, acme]`, and saves as you type it.

**The widgets** come from the folder config's `constraints:` (see
[Folder config: constraints](FOLDER-CONFIG.md#constraints)):

| In `constraints:` | Widget |
|---|---|
| `type: enum` with `values: [a, b]` | a dropdown |
| `type: bool` | a checkbox |
| `type: date` | a date picker |
| `type: multiline` | a text area |
| anything else | a text box |

A value that isn't one of the dropdown's choices is kept as an extra choice, so opening the form
never changes it.

**Fields the note doesn't have yet.** The fields the folder declares that are missing from this
note come after the others, marked as new. They're saved only if you fill them in. A field the
folder marks `required: true` has a `*`.

**Save** (or `Ctrl+Enter`) writes the fields and reopens the note; **Cancel** (or `Escape`) closes
the form. Nothing below the frontmatter changes.

#### Reference

- The declared fields come from the note's own folder config only, not from folders further up.
  A note can add its own with `constraints:` (replaces the folder's rule for that field) or
  `constraints_add:` (only for fields the folder doesn't mention).
- The form doesn't check `required:` or `pattern:`; the `nb-check-front` check reports notes
  that break them.
- A note with no frontmatter at all has no **FM** button; add a first field in the editor.
- A locked note (`lock: yes`, or a locked folder) has no **FM** button, and saving from a block
  is refused.
- `changes` is the old name for `edit` and still works.

#### For developers

One form builder, `_fmEditForm` (`plugins/nbweb-codeblocks.js`, exported as
`NbWeb.fmUtils.form`), serves both the toolbar button (`main.js`) and the block (`_loadFmEdit`).
It reads `/api/note`, `/api/note/constraints` (widgets) and `/api/note/constraints-full`
(declared fields), and saves the whole note with `PUT /api/note` after patching the frontmatter
lines (`_fmPatch`). More: [frontmatter editor](dev/dev-frontmatter-editor.md) #REVIEW.

---

### cfg — Config Inheritance Tree

#### Summary

A `cfg` block shows how a setting is resolved: the chain from the global `~/.nb/.nb.md` down
through the notebook and folder configs to the current note, and which level sets the value
that wins. `access: .` traces one key here; a bare block lists every key; `tree` and `org` map
all the config files in a notebook. Click a node to open its config file, or create one where
none exists. Admin only by default.

#### How it works

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

`●` nodes are clickable — opens the config file in the preview pane for editing via **FM** or **Edit**. `○` nodes have no config file yet. With a key traced, `▶` marks the level whose value wins, and `◉` the config file you're looking at.

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

#### Org chart (`cfg: org`)

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
| `0` | Reset zoom to 100% |

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

#### For developers

Parser: `_loadConfigBlock` (`plugins/nbweb-codeblocks.js`); org chart: `_configOrgRender`; backend `/api/config-tree`. Chain resolution: [Folder config](FOLDER-CONFIG.md).

---

### sysadmin — Admin Dashboard

#### Summary

A `sysadmin` block is the installation's control panel, for the person who runs nb-web. Empty,
it lists every notebook (its config, whether it syncs, its plugins and checks, how many notes),
the installed plugins, and whether the key config files exist. `users` lists the accounts and
lets you add, remove and change their level; `crontab` shows the jobs scheduled on the server.
It's for `tech` accounts; anyone below doesn't see it at all.

#### How it works

Three forms, one per thing you'd want to check on:

````markdown
```sysadmin
```

```sysadmin
users
```

```sysadmin
crontab
```
````

Each has the usual block header: **?** for this help, **↻** to refresh, and a click on the
header folds it away. Put them together in one note and you have an admin dashboard.

##### The installation (empty block)

```sysadmin
```

**Notebooks**, one row each:

| Column | Means |
|---|---|
| name | click it to open the notebook's config (`.notebook.md`), if it has one |
| config | the notebook has a config file |
| wired | its git repository has a remote (`origin`), so Sync can push it |
| .checks | it has its own `.checks/` folder of check scripts |
| plugins | the plugins its config turns on (`plugins:`) |
| notes | how many notes it holds |

The header counts the notebooks and the check scripts in `~/.nb/.checks/`.

**Plugins** lists the plugins in `nb-settings.json`, grouped by kind; a disabled one is dimmed,
and hovering one shows where it comes from.

**Config files** ticks off the files an installation should have: the global config
(`~/.nb/.nb.md`), the manifest, the checks index, the guards rule, the tools index and
`nb-settings.json`. Click one to open it; a ✗ means it's missing.

##### Accounts: `users`

````markdown
```sysadmin
users
```
````

A table of every account: its username, level, display name and the notebooks it's limited to
(`(all)` if none). In it you can:

- **change a level** with the dropdown, saved at once;
- **delete an account** with 🗑 (never your own);
- **add one** with **+ Add user**: username, display name, level and a first password.

You can only manage accounts below your own level, and only give out levels up to your own. A
`tech` account manages everyone, and is the only one that can open an account's file (click the
username) or limit it to some notebooks (its `notebooks:` line). People change their own name and
password on their [Account](ACCOUNT.md) page; there's no way here to reset someone else's
password.

##### Scheduled jobs: `crontab`

```sysadmin
crontab
```

The server's scheduled jobs (`crontab -l` for the account nb-web runs as): each job's schedule,
its command, and a description taken from the `#` comment line(s) just above it in the crontab.
It only shows them; edit the crontab in a terminal.

#### Reference

- **Access:** `tech` (`codeblock_access: sysadmin:` in `~/.nb/.nb.md`). Each form's data is also
  checked on the server: the installation and crontab need `tech`, accounts need `admin`. Below
  the level, the block is simply not there.
- **Levels**, from least to most: guest, user, office, admin, tech. See
  [Access levels](ACCOUNT.md#access-level).
- In a container, `crontab` shows the container's own (usually empty) crontab, not the host's.
- More admin tools (the config org chart, dotfile templates): [Sysadmin corner](SYSADMIN.md).

#### For developers

Renderer: `_dispatchSysadminBlock` (`plugins/nbweb-codeblocks.js`) picks the form;
`_loadSysadminBlock`, `_loadSysadminUsersBlock` and `_loadSysadminCrontabBlock` draw into
`_saFrame` (the shared header and a body). Backend: `/api/sysadmin`, `/api/sysadmin/crontab`, and
`/api/users` (GET/POST, PUT/DELETE `/api/users/<name>`), whose `_may_manage_user` keeps an admin
to accounts below its level (nb-web `CLAUDE.md` invariant 80). Codeblock architecture:
[codeblocks](dev/dev-codeblocks.md) #REVIEW.

---

## Authoring

Tools for writing notes and entering data.

### toolbar — Shortcut Buttons

#### Summary

Put `toolbar: true` in a note's frontmatter and a button for it appears in the list header,
next to the other list buttons, whenever that note's notebook is the one in the list. One click
opens the note, whatever folder or sort you're in, so it suits the notes you go back to all day:
a dashboard, a checklist, this month's books. `toolbar_icon:` picks the button's icon.

#### How it works

```yaml
---
title: Job board
toolbar: true
toolbar_icon: 🧰
---
```

Pat's Job board has exactly this: switch the list to the
`features` notebook and the 🧰 in its header opens it, from any folder.

- **Which notes:** every note in the notebook with `toolbar: true`, in any folder; notes in
  dot-folders (`.templates/` and the like) don't count. Buttons come in path order.
- **The icon:** `toolbar_icon:` if set; otherwise the icon a plugin gives that kind of note;
  otherwise the note's type icon (📊 for a dashboard, 📘 for a topic…); otherwise 📌.
- **Hovering** a button shows the note's title.
- Saving a note refreshes the buttons, so adding or removing `toolbar:` shows at once.

#### Reference

- Frontmatter only: there's no `toolbar` codeblock, and it doesn't cascade from folder or
  notebook config. Each note opts in for itself.
- You only get buttons for notes you can open: a note gated above your level, or in a folder you
  can't open, has no button.
- Any value YAML reads as true works (`true`, `yes`); remove the line or set `false` to drop the
  button.

#### For developers

`/api/toolbar-notes?notebook=` (`api_toolbar_notes`, `app.py`) scans the notebook and filters by
access; `main.js` draws the buttons into `#nb-list-plugin-btns` when it renders the list
(`_fetchToolbarNotes`, cached per notebook in `_toolbarCache`, cleared on save). The plugin icon
comes from `NbWeb.getListItemIcon`. Codeblock architecture: [codeblocks](dev/dev-codeblocks.md) #REVIEW.

---

### csv — Spreadsheet Table

#### Summary

A `csv` block turns comma-separated rows into a spreadsheet grid right in the note: the first row
is the column headers, the rest is data. Edit cells, add and remove rows and columns from the
right-click menu, then click **Save** to write the grid back into the note. Name a template after
`csv` (`csv materials`) for a fixed set of columns, a totals row and a pick-list. The data stays in
the note as plain text.

#### How it works

````markdown
```csv
Item,Qty,Length
Cedar 2x6,40,12'
Cedar 5/4 decking,60,12'
Joist hanger,24,
```
````

This is Pat's lumber order for the Jones deck, live (pulled in from
the job note, so it's read-only here):

```csv
Item,Qty,Length
Cedar 2x6,40,12'
Cedar 5/4 decking,60,12'
Joist hanger,24,
Deck screws 5 lb,3,
```

**Editing.** Click a cell to change it. Right-click for the grid's menu: insert or delete rows and
columns, copy and paste. Column widths fit the content. Click the header to fold the block away.

**Saving.** Edits aren't saved by themselves: click **Save** in the block's header (or press
`Ctrl+Enter` after clicking in the grid) when you're done. It writes back every grid in the note at
once, rewriting each `csv` block's rows. A grid inside a chapter pulled in with `{{inline:}}` has
no **Save**: open the chapter's own note to edit it.

**More than one block** in a note is fine; each gets its own grid.

#### Reference

- **The first row is always the header.** A block needs at least two lines: one line on its own
  (`csv materials` in the body, or just a header row) is read as the name of a price list to show,
  not a grid (see [csv templates](blocks/csv/templates.md)).
- Cells are split on commas, so a cell can't contain one; quotes around a cell are removed.
- Spreadsheet formulas (`=SUM(B1:B3)`) work in the grid; they're saved as written.
- In frontmatter, `csv:` shows a price list in the header strip, not a grid; see
  [csv templates](blocks/csv/templates.md).
- A `.csv` file opens as a full-page spreadsheet of its own; see [csv files](blocks/csv/files.md).

#### For developers

Not a plugin renderer: `marked` leaves a multi-line `csv` fence as `<pre><code class="language-csv">`
and `_renderCsvBlocks` (`main.js`) swaps in a Jspreadsheet CE grid (`_buildCsvBarblock` for the
header). `_saveCsvBlocks` rewrites the note's blocks in order from its own grids
(`_ownGrids`, which leaves out chapters and the annotation footer) and saves with `PUT /api/note`.
The one-line form is the codeblocks plugin's `csv` entry (`_loadCsvCatalogBlock`). Codeblock
architecture: [codeblocks](dev/dev-codeblocks.md) #REVIEW.

---

### csv templates — Columns, Totals, Price Lists

#### Summary

Write a name after `csv` (`csv materials`) and the block takes its columns and a totals row from
the template `~/.nb/.lib/materials.csv`, so the note holds only the data rows. Its **CSV** badge
opens a pick-list built from a price list note (`type: materials`), to fill the table by ticking
items. In frontmatter, `csv: materials` shows that price list as a compact summary instead. In a
project with a `journal:`, saving a template table also writes its hledger journal.

#### How it works

````markdown
```csv materials
Maple cabinet box,ea,180.00,Anytown Lumber,1080.00
Butcher block counter 8',ea,420.00,Anytown Lumber,420.00
Cabinet hinge,ea,4.50,Main St Hardware,54.00
```
````

The materials for Pat's Jones kitchen, live (from the job note; open it to try the pick-list):

```csv materials
Maple cabinet box,ea,180.00,Anytown Lumber,1080.00
Butcher block counter 8',ea,420.00,Anytown Lumber,420.00
Cabinet hinge,ea,4.50,Main St Hardware,54.00
```

##### The template file

`~/.nb/.lib/<name>.csv`: the first row is the column headers, then a row reading `contents`,
then any footer rows, such as totals:

```
Description,Unit,Unit Cost,Supplier,Total
contents
TOTAL,,,,=SUM(E1:E1)
```

The headers and footer come from the template every time; only the rows between them live in the
note and are saved back. Click the template's name in the block header to open the file (admin).

**Footer formulas fit the data.** Write a range's last row as `1` (`=SUM(E1:E1)`): before the grid
is drawn, the last row of every range in the footer is set to the number of data rows, so the same
template totals one row or a hundred, and the total never includes itself.

A template saved from a spreadsheet program is fine: trailing commas (`contents,,,,`) and empty
`,,,,` rows are ignored. A template with only a header row is fine too.

##### The pick-list

Click the **CSV** badge on a template table's header. It finds the nearest note with
`type: <name>` (here `type: materials`), looking in the note's folder and then each folder above
it, and lists that note's items: each heading in it is a group, each `csv` table under a heading
is the group's items. Items already in your table are ticked. Tick and untick, then **Save** (or `Ctrl+Enter`; `Escape` closes it): the
ticked items become the table's rows, saved at once. The price list itself isn't changed.

Pat's price list is Materials.

##### The summary in frontmatter

```yaml
csv: materials
csv: materials 12
```

In a note's frontmatter (or in the body as a one-line block, ` ```csv materials``` `), this shows
the price list compactly in the header strip: each group's heading, then each item's description
on the left and its cost on the right. The number is how many rows show before it scrolls (8 if
left out); several names (`csv: materials tools`) show several lists. Click a group's heading to
open the price list.

##### Accounts

If the note or its folder config sets `journal:` (a project's hledger journal), saving a template
table also writes `<journal>-gen.<name>.journal` beside it, generated and never edited by hand,
so a job's materials show up in its accounts. Without `journal:` nothing else is written. See
[Project diaries and reports](PROJECT-REPORTS.md).

#### Reference

- Template names are letters, digits, `_` and `-`; the file must exist in `~/.nb/.lib/`.
- The price list's columns: the description is the first column whose header has `desc`, `name`
  or `item`, the cost the first with `cost` or `price`.
- The pick-list matches the items already in your table by their first column.

#### For developers

`_renderMarkdown` turns ` ```csv <name>` into a `.nb-csv-tmpl-pending` placeholder;
`_renderCsvTmplBlock` (`main.js`) loads `/api/lib/csv-template?name=` and builds the grid;
`_openCsvChecklist` finds the price list with `/api/csv/source` and parses it with
`_parseCatalogFull`. The summary is `_loadCsvCatalogBlock`/`_csvRenderCompact`
(`plugins/nbweb-codeblocks.js`). Saving calls `/api/t/journal/from-csv` per name. Codeblock
architecture: [codeblocks](dev/dev-codeblocks.md) #REVIEW.

---

### csv files — Spreadsheet Files

#### Summary

A `.csv` file in a notebook (a bank export, an estimates sheet) opens as a spreadsheet that fills
the preview pane: no fence, no note around it. Edit cells, then **Save**, or **Cancel** to drop
the changes. Tick **First row is header** to pin the first row as column titles.

#### How it works

Open Pat's estimates to see one.

- Column widths fit the content, as in a `csv` block.
- **First row is header** (beside Save and Cancel) is off every time the file opens, and never
  guessed: an export often has no header row, and taking a real row for titles would hide it.
  Tick it to pin row 1 as the column titles; untick to put it back in the grid. Your edits are
  kept either way.
- **Save** writes the file; **Cancel** reloads it.

#### Reference

- The whole file is the table; there's no frontmatter. Notes about the file go in its annotation
  (the box below it).
- Inside a note, use a [csv block](blocks/csv.md) instead.

#### For developers

`classify()` (`app.py`) makes `.csv` the `sheet` type; `renderPreview` (`main.js`) draws it into
`#nb-sheet-host` with the same Jspreadsheet grid and the header toggle (`#nb-sheet-header-toggle`).

---

### add — Create Wizards

#### Summary

An `add` block shows a wizard as a small chart: the steps to create something new, such as a
project with its folder, diary, reports page and config. Click a step and a form asks for the
names and choices its templates need, shows what it will make, and creates it all in one go.
The same wizard opens from the **[+]** in a project's (or other typed note's) header. A wizard is
a note you write; see [writing a wizard](blocks/add/wizards.md).

#### How it works

````markdown
```add
org new-job
```
````

`org new-job` draws the wizard in the note `.new-job-org.md` at the top of this notebook. Try
Pat's on the Job board: its **Add a job** section has this
block, and the **[+]** in its header opens the same wizard.

**The chart.** The wizard's title is the root; each step is a box. Hover a box for its
description.

**Clicking a step** that creates something opens a form:

- one field per thing its templates ask for (`{{job_title}}`), a dropdown where the template
  offers choices (`{{client:acme|smith|none}}`);
- a preview of what will be made, updated as you type;
- **Create** makes it, then opens the main new note. Anything that already exists is left alone
  and reused.

A step with nothing to ask (adding today's heading, say) runs straight away. Clicking a heading
that only groups other steps runs all of them, in order. A step that links to a note
(`## [[Projects]]`) just opens it.

**The [+] button** appears on a typed note's header when a wizard fits it: the one named by the
note's `add_org:`, or its notebook's `types: <type>: add_org:`, or `.<type>-org.md` if it exists.
Folders and notebooks can add more with `add_org_add:`. It lists each wizard's steps; pick one.

#### Reference

- In frontmatter, `add: org new-job` shows the chart in the header strip.
- Names you type become file and folder names: anything but letters, digits, `_` and `-` turns
  into `_`.
- No access level of its own: you can only create what your account could create by hand.
- Writing wizards, the `[+]` settings and the step kinds: [writing a wizard](blocks/add/wizards.md).

#### For developers

`_loadAddOrgBlock` (`plugins/nbweb-codeblocks.js`) reads `<notebook>:.<name>-org.md`, parses it
with `_parseAddOrgSource` and draws it with `_addOrgRender`; a click opens `_openAddOrgModal`,
which scans the steps' templates for fields (`_addOrgScanForm`) and runs them
(`_addOrgExecuteBranch`/`_addOrgExecuteLeaf`). The [+] is `NbWeb.openAddOrgPicker`, its target
`effective_add_org` (`app.py`, nb-web `CLAUDE.md` invariants 40 and 43); the design narrative is the
`add_org_scaffolding_wizard_design_2026-08-16` note in the `claude` notebook.

---

### Writing a wizard

#### Summary

A wizard is a note named `.<name>-org.md` at the top of a notebook. Its headings are the steps
(nested headings are sub-steps), and lines starting `>` under a heading say what that step does:
`> KIND:` what to make, `> TEMPLATE:` which template fills it, `> AT:` where it goes, `> IF:`
when to skip it. Placeholders like `{{job_slug}}` in those lines and in the templates become the
form's fields.

#### How it works

Pat's New job wizard:

```markdown
# New job

## Job
> KIND: note
> TEMPLATE: job
> AT: examples/jobs/{{job_slug}}
The job's note in the jobs folder, filled in from the job template.
- job_slug becomes the file name; the template asks for the rest.

## Site visit
> KIND: note
> TEMPLATE: site-visit
> AT: examples/jobs/{{job_slug}}-visit
> IF: visit_date
A note for the first site visit, made only if you give a visit date.
```

##### The lines under a heading

| Line | Means |
|---|---|
| `> KIND: note` | what this step makes (below) |
| `> TEMPLATE: job` | the template that fills the note: `.templates/job.md` in this notebook (the notebook's own, or one of its folders'). Global templates aren't found here. |
| `> AT: path/{{field}}` | where it goes, inside the notebook; `.md` can be left off |
| `> IF: field` | skip this step if `field` is left empty |
| other text, or `> text` | the step's description (hover the box) |
| `- text` | a comment for whoever edits the wizard; never shown |

A heading without `KIND` groups the steps under it; clicking it runs them all. A heading that is a
link (`## [[Projects]]`) opens that note instead.

##### Kinds

| `KIND` | Makes |
|---|---|
| `note` | a note at `AT`, from `TEMPLATE` (a dotfile like `.{{slug}}.md` is fine) |
| `folder` | the folder at `AT`, and any missing folders above it |
| `contact` | a note in the `contacts` notebook |
| `notebook` | a new notebook named by `AT` |
| `today` | adds today's date heading to the note you're on (above `> TODAY:` if it has one) |

An existing note or folder is never overwritten: it's reused.

##### The form's fields

Every `{{field}}` in the steps' `AT` lines and in their templates becomes one field, asked once
even if used in several places:

- `{{field}}`: a text box;
- `{{field|default}}`: a text box, with `default` used when it's left empty;
- `{{field:a|b|c}}` (in a template): a dropdown of `a`, `b`, `c`;
- an `IF:` field is asked for too.

Built-in values are filled in for you and never asked: `{{date}}`, `{{day}}`, `{{time}}`,
`{{weather}}`, `{{title}}`, `{{tags}}` and the like. What you type is made safe for a file name
in `AT` paths (anything but letters, digits, `_`, `-` becomes `_`); in the template text it's
used as typed.

##### Which wizard the [+] opens

For a note of type `<type>`, the first of:

1. the note's own `add_org: <name>`;
2. the notebook config's `types: <type>: add_org: <name>`;
3. `.<type>-org.md`, if it exists.

`add_org_add: [<name>, …]` in a folder or notebook config (or global config) adds more wizards to
the [+] list; these add up from the top down. Pat's Job board sets `add_org: new-job`.

#### Reference

- The wizard file is a plain note (`type: dotfile` is usual): edit it like any other. In the [+]
  list, **✎ edit source** opens it (for developers).
- A wizard only creates in its own notebook, except `contact` (the `contacts` notebook) and
  `notebook` (a new one).
- Nothing is created until **Create**; a step that fails shows in the result, and the others
  still run.

#### For developers

Grammar: `_ADD_ORG_FIELD_RE`/`_parseAddOrgSource`; fields: `_addOrgPlaceholderFields`,
`_ADD_ORG_BUILTIN_VARS`; templates: `_addOrgFetchTemplate` (this notebook's only); values into
paths: `_addOrgResolveText`; server-side template filling: `_resolve_template_vars`'s `extra_vars`
(`app.py`). The [+]: `_effective_add_org`/`_resolve_add_org_list` (`app.py`, invariant 43).

---

## External data

Live views of your other tools: tasks, accounts, notebooks, git.

### tw — Taskwarrior

#### Summary

A `tw` block runs a Taskwarrior filter and shows the matching tasks as a live table in the note,
sorted by urgency. The body is a task filter (`project:kitchen +next`); columns for project,
priority, due and tags appear only when some task uses them. Each row has a ✓ to finish it and a
▶/◼ to start or stop its timer, clicking an id shows `task information`, and `+` opens a form to
add a task. The **task** label in the header opens Taskwarrior itself.

#### How it works

````markdown
```tw
project:kitchen +next
```
````

The body is a Taskwarrior filter, the same words you'd type before a report: tags (`+next`,
`-waiting`), attributes (`project:kitchen`, `priority:H`, `status:pending`), and ranges
(`due.before:eow`). It is only ever a filter: a word that names a Taskwarrior command is refused,
so a block can read tasks but never run other task commands. Tasks come back sorted by urgency,
highest first.

**Columns.** Id and description always show; project, priority, due and tags appear only when at
least one task in the result has them. Fix the columns yourself with a `columns:` line in the
body:

````markdown
```tw
columns:id,description,due
+work
```
````

**Rows.** Due dates are tinted (overdue, soon, later) and a started task is highlighted. Per row:

| Control | Does |
|---|---|
| ✓ | marks the task done (it fades out) |
| id | shows `task information` below the row; click again to close (one open at a time) |
| ▶ / ◼ | starts or stops the task's timer |

**Adding a task (`+`).** Opens a form under the header: description, project, a date (due,
scheduled, wait or until, with a date picker), priority and tags. It adds the task with your
account's own `task`, so you can only create what you could create by hand.

**The task label.** Clicking it opens Taskwarrior as set in Settings → Codeblocks: in the
terminal, or in [tw-web](https://github.com/linuxcaffe/taskwarrior-web) if a web command is set
(until it's set, the click opens that setting). An admin script `.lib/open-block-tw-<level>.sh`
takes over the click when present.

**In a reports note.** A body of `source:` / `filter:` / `timeframe:` lines reads the `tw` blocks
of another note (a project diary) sliced to a timeframe, instead of a plain filter; see
[CBQL](dev/dev-cbql.md#cbql-read-path). #REVIEW

#### Reference

- Needs `task` (Taskwarrior) on the server's `$PATH`. Without it the block shows a short card
  saying what to install.
- Reads your live Taskwarrior data (the server's `~/.task`); there's no per-note task file yet,
  the way `hl` has `journal:`.
- Anyone who can see the note can read a `tw` block (an admin can still limit it with
  `codeblock_access: tw: {read:}`, see [Access gates](#access-gates)); adding,
  finishing, starting or stopping a task needs at least a `user`-level account.
- In frontmatter (`tw: +work`) it shows in the note's header strip instead of the body.

#### For developers

Renderer: `_loadTwBlock` / `_buildTwTable` (`plugins/nbweb-codeblocks.js`), reports-note variant
`_loadTwCBQLBlock`; backed by `/api/task-query` (read) and `/api/task-add` · `/api/task-action` ·
`/api/task-info` (write and detail). A filter is screened by `_tw_filter_args` in `app.py` so it
can name no Taskwarrior command, alias or `rc` override. Taskwarrior domain notes: the
`taskwarrior` skill.

---

### hl — Accounting

#### Summary

An `hl` block runs an hledger report and shows the result in the note: balances, registers,
income statement, balance sheet, cash flow. The body is an hledger command line (`bal expenses
--monthly -3`); it reads the note's `journal:` when the line names no file. `+` adds a
transaction, ↻ re-runs the report, and the **hledger** label opens hledger itself.

#### How it works

````markdown
```hl
bal expenses --monthly -3
```
````

The body is what you'd type after `hledger`. Balance, register and the sectioned reports
(`is`, `bs`, `bse`, `cf`) render as tables; other commands (`print`, `stats`, `files`, …) as
plain text. Amounts are coloured by sign.

| Command | Shows |
|---|---|
| `balance` · `bal` · `b` | account tree |
| `register` · `reg` · `r` | postings with a running balance |
| `incomestatement` · `is` | revenues and expenses |
| `balancesheet` · `bs` (`bse` with equity) | assets and liabilities |
| `cashflow` · `cf` | cash flow |

**Which journal.** A body starting with a path (`~/…` or `/…`) or containing `-f` uses that
file. Otherwise the note's `journal:` frontmatter (its own, or inherited from a folder or
notebook config) is put in front. Filters are hledger's own: `--period thisweek`, `--depth 2`,
`tag:name`, `--begin 2026-01-01`, `--end 2026-12-31`.

**Adding a transaction (`+`).** Opens a posting form under the header. If the query names an
account (`reg Assets:Bank`), the first account field starts with it; in a daily note named
`YYYYMMDD.md`, the date starts at that day instead of today. Account fields suggest names from
the journal.

**The hledger label.** Clicking it opens hledger: in the terminal or hledger-web, as set in
Settings → Codeblocks (until it's set, the click opens that setting). An admin script
`.lib/open-block-hl-<level>.sh` takes over the click when present.

**Special bodies**

| Body | Shows |
|---|---|
| `ui` (`~/x.journal ui \| label`) | hledger-ui in a terminal inside the note |
| `web` | a button that opens hledger-web |
| `regen .tools/<name>.py \| label` | a button that runs that script in the note's notebook (regenerating journals), then refreshes the note's other `hl` blocks |

A body of `source:` / `filter:` / `timeframe:` / `group:` lines queries entries kept in another
note's codeblocks instead of a journal file (a project diary's timedot and csv blocks); see
[CBQL](dev/dev-cbql.md#cbql-read-path).

**Example entries.** Use a ` ```ledger ` block, not `hl`, for sample journal text in docs and
tutorials: it's shown highlighted and never run.

#### Reference

- Needs `hledger` on the server's `$PATH` (`hledger-ui` / `hledger-web` for those bodies).
- Who can see blocks and who can add transactions: `codeblock_access: hl: {read:, write:}`
  (see [Access gates](#access-gates)).
- Also released on its own: [hledger-codeblock](https://github.com/linuxcaffe/hledger-codeblock).
- In frontmatter (`hl: bal -2`) it shows in the note's header strip instead of the body.

#### For developers

Renderer: `_loadHledgerBlock` (`plugins/nbweb-codeblocks.js`), backed by `/api/hledger-query`;
the add form is `_showHledgerAddForm`. Accounting domain notes: the `hledger` skill and
[nbweb-hledger](https://github.com/linuxcaffe/nbweb-hledger).

---

### nb — nb Panel

#### Summary

An `nb` block embeds a small live panel about your notes. `notebooks` lists every notebook with
its note count and how long ago it changed, each one a click away; `backlinks` lists the notes
that wiki-link to the note you're reading. Both show only what your account may open.

#### How it works

````markdown
```nb
notebooks
```
````

Two commands:

| Body | Shows |
|---|---|
| `notebooks` | every notebook, with its note count and last-changed age; the open notebook is highlighted, and clicking one switches the list to it |
| `backlinks` | the notes whose text contains `[[` this note's title `]]`; click one to open it |
| `backlinks 5` | the same, capped at 5 (the default is 20) |

**backlinks reads the open note.** It matches the title of the note you're viewing, so the same
`backlinks` block shows different results in each note; in a note with nothing linking to it, it
says so. It's most at home in a note's frontmatter (`nb: backlinks`), where it rides along in the
header strip of every note.

#### Reference

- `notebooks` and `backlinks` both list only notebooks and notes your account is in scope for and
  may read; a restricted account never sees the rest.
- `backlinks` matches the title exactly as written between `[[` and `]]`; a note linked only by
  its filename stem or an `alias:` won't appear (that's how the wikilink resolver differs from the
  backlink scan).
- Unknown commands show a short error in the block; `notebooks` and `backlinks` are all it knows.
- An admin can gate it with `codeblock_access: nb: {read:}` (see
  [Access gates](#access-gates)).

#### For developers

Renderer: `_loadNbBlock` with `_buildNbNotebooks` / `_buildNbBacklinks`
(`plugins/nbweb-codeblocks.js`), backed by `/api/nb/notebooks` and `/api/nb/backlinks` (ripgrep,
falling back to `nb search`); both filter results by `_notebook_in_scope` and `_can_access`
(invariant 79). nb domain notes: the `nb` skill.

---

### git — Git Log

#### Summary

A `git` block shows the output of a read-only git command in the note: a log, a status, a diff.
The first word names the repository — a `.` for the current note's own notebook, or an alias an
admin has set in `nb-settings.json` — and the rest is the git command. It's for notes that live
next to code: a dev journal, a planning page, a release note.

#### How it works

````markdown
```git
. log --oneline -10
```
````

The first word is the repo, the rest is the git command and its flags:

| First word | Repo |
|---|---|
| `.` | the notebook the open note is in (every notebook is its own git repo) |
| an alias | a path from `git_repos` in `nb-settings.json` |

Clicking the repo name in the header opens its `origin` remote in a browser, when it has one.

**Repo aliases.** An admin maps names to paths in `nb-settings.json`, so a note can read a repo
outside `~/.nb`:

```json
{
  "git_repos": {
    "nb-web":    "~/dev/nb-web",
    "myproject": "~/dev/myproject"
  }
}
```

Then `nb-web log --oneline -10` reads that repo.

#### Reference

- **Read-only.** Only these subcommands run: `branch`, `describe`, `diff`, `log`, `ls-files`,
  `remote`, `shortlog`, `show`, `stash`, `status`, `tag`. A command that would change a repo is
  refused — no `--output` file, and `stash`, `branch` and `tag` only in their listing forms
  (`branch -a`, `tag -l 'v*'`, `stash list`), never to create, delete or stash.
- The repo must be `.` or a configured alias; an unknown name lists the ones that exist.
- An admin can gate it with `codeblock_access: git: {read:}` (see
  [Access gates](#access-gates)).
- In frontmatter (`git: . status`) it shows in the note's header strip instead of the body.

#### For developers

Renderer: `_loadGitBlock` / `_buildGitOutput` (`plugins/nbweb-codeblocks.js`), backed by
`/api/nb/git`; the read-only screen is `_git_read_only` and the subcommand allowlist `_GIT_ALLOWED`
in `app.py`.

---

## Time tracking

Clock in and out, and log time.

### t — Timeclock

#### Summary

A `t` block is a live time clock in the note: it shows whether you're clocked in and a report of
the hours logged this period, side by side, with buttons to clock in and out. It reads your
Taskwarrior timeclock file through the `t` CLI; a toggle flips it to show timedot hours instead,
and when both have entries for the period it shows a combined total.

#### How it works

````markdown
```t
today
```
````

The body is the report period:

| Body | Report covers |
|---|---|
| `today` *(default)* | since midnight |
| `thisweek` | since Monday |
| `lastweek` | the previous Monday–Sunday |
| `thismonth` | since the 1st |
| `lastmonth` | the previous calendar month |

**The header.** The left shows status — clocked in (with a running timer), out, or no entries —
and the right has the controls:

| Button | Does |
|---|---|
| `⏱ In` | opens a form (account picker + description) and clocks in |
| `◼ Out` | clocks out of the current entry |
| `.` / `tc` | toggles between timeclock and timedot view |
| `↻` | refresh |

**Timedot view (`.`).** Flips the header to your last timedot entry and the report to timedot
hours. Use it when you log some work by the clock and some as [timedot](blocks/timedot.md)
dots.

**Combined total.** When the period has both clocked and timedot hours, a row at the foot adds
them: `1h15m tc + 2.5h td → 3.8h`.

**Which files.** By default the clock is your global timeclock file (`timelog.file` in
`~/.task/config/timelog.rc`). Point a note or a whole notebook at project files with
`timelog_file:` / `timedot_file:` in frontmatter — see [[docs:blocks/timedot.md#Reference|File
scoping]]. Every button then reads and writes those files.

#### Reference

- Needs the `t` timeclock CLI (part of the Taskwarrior timewarrior/timeclock setup) and a
  readable timeclock file.
- `⏱ In` / `◼ Out` write to the timeclock file, so they need at least a `user`-level account; a
  `file:` outside your notebooks needs tech (invariant 77).
- In frontmatter (`t: thisweek`) it shows in the note's header strip instead of the body.

#### For developers

Renderer: `_loadTBlock` / `_buildTBlock` (`plugins/nbweb-codeblocks.js`), backed by `/api/t/status`,
`/api/t/report`, `/api/t/in`, `/api/t/out` and the `/api/t/timedot/*` reads. Period bounds:
`_t_period_bounds` in `app.py`; every `file=` goes through `@_time_file_gate` /
`_time_file_refusal`. Billing on top of this data: `docs:dev/dev-billing-milestones.md`. #REVIEW

---

### timedot — Time Journal

#### Summary

A `timedot` block logs time in [hledger timedot format](https://hledger.org/timedot.html): an
account and a duration per line, grouped by date. In a note's body it shows your entries as you
wrote them, with an edit button; declared in frontmatter (`timedot: true`) it adds up every body
entry into an hours-by-account summary, with optional billing. Point it at an external `.timedot`
file and it reads and appends there instead.

#### How it works

**Body block — your entries, verbatim.** A fence in the note body shows the entries exactly as
written; `✎` opens a textarea to edit them, Save writes them back into the note. This is the mode
for a project diary, where the hours live in the note and grow with it.

````markdown
```timedot
2026/06/24
djp:siding  ....  ; prepped surfaces
djp:siding  ....  ; first coat

2026/06/25
djp:siding  1.5   ; trim work
```
````

**FM barblock — the totals.** `timedot: true` in frontmatter adds a collapsible bar to the
header strip that collects every body block in the note and totals the hours by account, with a
date filter (`all` / `mo` / `wk`) and, if `rate:` is set, a billing column. Click the total to
open a per-account popover. It has no `+` (it reads from the body blocks, which have no single
write target — edit them with `✎`).

**Time formats**, freely mixed:

| Written | Means |
|---|---|
| `....` | dots — 15 min each, so four dots = 1 h (groups separated by spaces all count) |
| `1.5h` | decimal hours |
| `90m` | minutes |
| `1.5` | a bare number is decimal hours |

**Account names** can contain single spaces; it's **two or more spaces** that separate the
account from the time — `home laundry  2.5h` logs to `home laundry`, `home:laundry  2.5h` to the
colon hierarchy.

**Sections.** `##`, `###` or `####` headings (an optional `-` after the hashes) group entries
into collapsible blocks shown in the FM total; level-2 open, deeper ones collapsed, state kept in
the browser. Comment (`;`), task (`*`) and modeline (`//`) lines are skipped.

**Frontmatter keys.** `project: work:acme` prefixes bare entries and `:sub` accounts
(`....` → `work:acme  ....`, `:website` → `work:acme:website`); `rate: 85` turns on the `$`
billing column.

**External file mode.** `timedot_file: ~/path/time.timedot` points the FM barblock at a file
instead of the body — right when you already log with `t . i` from the CLI, or want one timesheet
shown in several notes. In this mode the `+` form is available and appends to the file (creating
it on first save); write an empty ` ```timedot ``` ` fence in the body as the placeholder. The
form takes a date (today by default), a time in any format, an optional `:sub` account, and a
comment; it adds a `YYYY/MM/DD` heading only when the day changes.

#### Reference

- **File scoping** — two frontmatter keys redirect the time blocks to project files:
  `timelog_file:` for the [t](blocks/t.md) block, `timedot_file:` for this one. Set them on
  a note, or on a notebook's config note to scope every note in it; the `t` block's clock and this
  block's `+` then write the same pair of files. Defaults come from `~/.task/config/timelog.rc`.
- A `file:` must be a `.timedot`/`.journal`/`.timeclock` inside a notebook you can open; naming a
  path outside your notebooks needs a tech account (invariant 77). Appending or saving needs
  `user`.
- Needs no external tool for the block itself (nb-web parses timedot); `hledger` only if you also
  run reports over the file.
- In frontmatter (`timedot: true`) it rides in the note's header strip.

#### For developers

Renderers: `_loadTimedotBlock` (body) and the FM-aggregate path, external-file variant
`_loadTimedotCBQLBlock` (`plugins/nbweb-codeblocks.js`); backed by `/api/t/timedot/content`,
`/api/t/timedot/append`, `/api/t/timedot/write` (all `@_time_file_gate`). Saving a `-gen` file
also stubs the project's master journal (`_ensure_journal_stubs`). Billing:
`docs:dev/dev-billing-milestones.md`. #REVIEW

---

## Testing

Checks that warn you when something is wrong.

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

## Under review

Not yet checked against the code: `chart`'s display is currently missing, and `cine` belongs to a plugin.

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

Developer internals and script authoring: [codeblocks](dev/dev-codeblocks.md)
