<!-- Generated from docs:dev/dev-codeblocks.md by .tools/readme-export.py. Edit the source, not this file. -->

# CODEBLOCKS (dev)

Developer reference for the codeblock renderer system. For user-facing codeblock docs see [CODEBLOCKS](../CODEBLOCKS.md). For writing check scripts see [testing](dev-checks.md).

---

## Architecture

Codeblock renderers are registered via the `codeblockRenderers` extension point in any NbWeb plugin. See [PLUGINS](../PLUGINS.md#codeblockrenderers) for the full API.

The skeleton/hydrate pattern applies to all blocks:
- `html(text)` — synchronous placeholder stamped at markdown parse time
- `render(container)` — async hydration after the DOM is ready

All block renderers wire into `NbWeb.statusPill` for render progress tracking. See [RENDER_PIPELINE](../RENDER_PIPELINE.md#_statuspill) for the pill API.

---

## "." current-location awareness #pattern

Several block types accept **`.`** as a shorthand for the current note's location, resolved at render time via `NbMain?.activeSelector?.()`.

| Block | `.` resolves to | Implementation |
|-------|----------------|----------------|
| `nav` | Current note's `notebook:folder` | `_navParseQuery(raw, currentSelector)` — exact `raw === '.'` branch |
| `fm` | Current notebook (scope prefix) | `_frontParseQuery(raw, currentSelector)` — dot token in notebook list |
| `git` | Current notebook (repo name) | Inline in `_loadGitBlock` before fetch |
| `cfg` | Current note's `notebook:folder/` | `_configParseQuery(raw, currentSelector)` — `!target \|\| target === '.'` |
| `gallery` | Nearest `images/` folder, walking up | No `path` param sent at all when the query is bare (e.g. `gallery: thumb`) — `path=.` only when a literal `.` is written explicitly. See "gallery block — implementation notes" below. |

**Selector extraction pattern** (used by `nav`, `fm`, `git`):
```javascript
const sel = NbMain?.activeSelector?.() || '';
const colon = sel.indexOf(':');
const notebook = colon >= 0 ? sel.slice(0, colon) : '';
const rel      = colon >= 0 ? sel.slice(colon + 1) : '';
const folder   = rel.split('/').length > 1 ? rel.split('/').slice(0, -1).join('/') : '';
```

**YAML gotcha** — any FM-mode codeblock query ending with `:` (e.g. `cfg: . access:`) is invalid YAML: PyYAML treats the trailing `:` as a nested mapping indicator and throws, silently falling back to the dumb line-split parser. Quote the value: `cfg: ". access:"`. #gotcha

---

## External block renderers

Two codeblock types are provided by external plugins rather than `NbWeb-codeblocks`:

| Block | Plugin | Docs |
|-------|--------|------|
| `chart` | NbWeb-hledger (`~/dev/nbweb-hledger`) | `~/dev/nbweb-hledger/README.md` |
| `cine` | NbWeb-cine (`~/dev/nbweb-cine`) | `~/dev/nbweb-cine/README.md` |

When writing a new codeblock renderer that depends on an external tool or plugin, document the user-facing query syntax in the external plugin's README, and document the renderer internals here or in that plugin's own dev notes.

---

## test block internals

User-facing syntax and bundled scripts: [CODEBLOCKS](../CODEBLOCKS.md#test--embedded-assertions).

### Exit code / output contract

| Exit | stdout | Result |
|------|--------|--------|
| 0 | empty | Block vanishes (Form 2) or silent reset (Form 1) |
| 0 | has content | Output rendered as markdown |
| non-zero | anything | Output rendered as markdown with red left border |

Output goes through the full render pipeline — headings, tables, wikilinks, `{{hledger:}}` inline expressions, `term:` and `note:` links all work inside test output.

### Context variables

Injected as environment variables by the Flask endpoint before running the script:

| Variable | Example | Notes |
|----------|---------|-------|
| `NB_DIR` | `/home/djp/.nb` | nb root |
| `NB_NOTE_SELECTOR` | `accts:guide/review.md` | Currently open note |
| `NB_NOTEBOOK` | `accts` | Notebook portion of selector |
| `NB_NOTE_PATH` | `/home/djp/.nb/accts/guide/review.md` | Absolute path |

Scripts that shell out to hledger should resolve the journal explicitly — Flask's subprocess environment may not match a login shell: #gotcha

```bash
journal="${HLEDGER_FILE:-$HOME/.hledger.journal}"
[ ! -f "$journal" ] && exit 0
```

### `subtest:` links

A script can output `[label](subtest:scriptname)` in its markdown. Renders as a toggle row; click fetches and expands the named script's output inline — no pre-run. Use the full script name including subgroup: `(subtest:hl-opt-ordereddates)`, not `(subtest:hl-ordereddates)`.

### Writing scripts

**Passing silently** — exit 0 with no output. Block disappears entirely.

```bash
#!/usr/bin/env bash
pct=$(df "$HOME" | awk 'NR==2 { gsub(/%/,""); print $5 }')
[ "${pct:-0}" -lt 80 ] && exit 0
echo "### ⚠ Disk ${pct}% full"
df -h "$HOME" | awk 'NR==1||NR==2'
```

**Amber banner** — informational notice (not a failure). Exit 0 with a `<div class="nb-alert-banner">`. Renders in the app's amber palette, no red border. `note-approved` is the reference implementation.

```bash
echo '<div class="nb-alert-banner">⚠ This note is pending approval.</div>'
```

**Scoped to current note** — use `NB_NOTEBOOK` to target the right git repo:

```bash
[ -z "$NB_NOTEBOOK" ] && exit 0
status=$(git -C "$NB_DIR/$NB_NOTEBOOK" status --short 2>/dev/null)
[ -z "$status" ] && exit 0
echo "### Uncommitted changes in \`$NB_NOTEBOOK\`"
```

### Good output anatomy #pattern

`hl-budget-has-periodic.sh` is the gold standard — read it before writing a new script.

```
### ⚠ Short description        ← always H3 + warning sign
                                ← one sentence: what's wrong and why it matters
**Fix** —                       ← concrete fix with a code block
```ledger
~ monthly ...
```

```check                         ← embedded verify block (shows pass/vanish in place)
hl-budget-include-check
```

[Open actual-filename.journal](note:/absolute/path)   ← always last line
```

**Rules:**
- Heading: always `### ⚠` (H3, warning sign, short phrase) — appears in book TOCs
- First body line: one sentence of context, no "Note:" or "Warning:" preamble
- Fix blocks: `**Fix**` or `**Fix 1**`/`**Fix 2**` with a concrete code block
- Verify block: embed the cheapest confirming test right after the fix
- Open link: last line, use the actual filename not a generic label
- No output on exit 0 — causes block to render instead of disappear #gotcha

### `term:` links in output

Test output goes through the full render pipeline — `term:` links work there exactly as they do in regular notes. A script can embed a one-click fix command alongside the `note:` open link:

```
[Apply in editor](term:$EDITOR%20${HLEDGER_FILE})
[Open budget.journal](note:/home/djp/.nb/...)    ← still last line
```

The `term:` URL must be percent-encoded. Generate it in bash:

```bash
cmd="hledger -f $journal check budget"
encoded=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$cmd")
echo "[Verify now](term:${encoded})"
```

Good candidates: open-in-editor, run-checker-after-fix, single-command remediation. Not for multi-step or destructive commands — those belong in prose. #pattern

### Reference scripts

Browse and edit in place:

````markdown
```nav
~/.nb/.test
```
````

Key reads before writing new scripts:

- `hl-budget-has-periodic.sh` — gold standard: heading, context, fix, embedded verify, open link
- `hl-core-journal.sh` — simplest Form 2: silent pass, one check, raw error fallback
- `hl-opt-*.sh` — the `hl-opt-` subgroup; `subtest:` drill-down links show the pattern
- `note-approved.sh` — reference for amber `.nb-alert-banner`; reads frontmatter with awk
- `nb-dirty.sh` — `NB_NOTEBOOK` context var usage

---

## gallery block — implementation notes

**Backend (`/api/gallery`):** Three path modes — walk-up (no `path` param), here-only (`path=.`), explicit (`path=nb:rel/`). Walk-up stops at `NB_DIR` boundary (`d.relative_to(NB_DIR)` raises `ValueError`). Returns `{'images': []}` for missing folders — no error, just an empty list — so the frontend can vanish cleanly.

**`_GALLERY_IMAGE_EXTS`** — module-level frozenset. Skips dotfiles and non-image extensions. `classify()` is not used here because the gallery lists files directly from the filesystem, not via nb's index.

**Frontend `_loadGalleryBlock(el)`:** parses `data-query` as `<size> [path]` with a single `indexOf(' ')` split. Fetches `/api/gallery?selector=<activeSelector>&path=<pathArg>`. Empty result → `el.innerHTML = ''` → block vanishes completely (no header, no spinner).

**`wasCollapsed` preservation** — same pattern as `_loadFrontBlock`: reads `el.classList.contains('nb-collapsed')` before clearing innerHTML, restores the class after building. `_initCollapseToggle` then reads localStorage to apply the persisted state.

**Lightbox `_galleryLightbox(images, activeUrl)`** — appended to `document.body`, not the block. `cur` index wraps with `((idx % len) + len) % len`. The `keydown` listener checks `document.getElementById('nb-gallery-lb')` on every key event — if the lightbox was removed (click-outside), the listener self-cleans on next key press rather than needing a MutationObserver.

**FM-mode + `.` path** — `gallery: med .` in frontmatter injects the block into `#nb-fm-blocks` via `_buildFmBlocks`. The empty-result vanish means the block is completely invisible on dashboards until an `images/` folder exists. No placeholder, no error state needed.

**Collapse key** — `_collapseKey` uses `block.dataset.query` (the raw fence text, e.g. `"med ."`) as the localStorage key. Different size/path combinations are independent collapse states.

---

## fm block — implementation notes

Key lessons from the `fm` codeblock (frontmatter filter/query block) and its sibling, the
`{{fm: count ...}}` inline-query provider. Full query-language design history and the day it
was all built: `claude:fm_query_language_extension_plan_2026-08-04.md` (all 5 phases shipped
same-day). User-facing reference: [CODEBLOCKS](../CODEBLOCKS.md#fm--frontmatter-filter),
[Inline live queries](../inline-queries.md).

**Scope prefix parsing** (`_frontParseQuery` in `nbweb-codeblocks.js`, `_parse_fm_scope` in
`app.py` — kept in sync by hand, no shared source, since one runs in the browser and the other
server-side for the inline provider) — leading tokens are consumed as scope until one both
contains `:` *and* doesn't end in `/`. A colon-bearing token IS still scope if its tail ends in
`/`: `notebook:folder/path/` (2026-08-04, Phase 1) — the trailing slash is load-bearing, it's
the only thing distinguishing a folder scope token from the first `field:value` filter; don't
try to make it optional/auto-appended without also solving that ambiguity (a filter like
`type:story` would misparse as `notebook="type", folder="story/"` otherwise — considered and
rejected in the original plan's open questions).

**Filter token shape** — `(-)?(\w[\w.-]*):"([^"]*)"|(-)?(\w[\w.-]*):(\S*)` (quoted / unquoted).
Within the unquoted branch, the parsed `value` is inspected before deciding the op: leading
`-` on the whole token → `neg: true` (inverts the result, including the missing-field case —
see `_fm_eval_one` in `app.py`); `>`/`<` prefix on value → comparison (`_fm_compare`: numeric
first, string fallback — correct for both `seq` and `mtime`'s `YYYY-MM-DD`); comma in value →
`anyof` (value becomes a list); `sort`/`limit` field names are directives, extracted and
**never added to `filters`** — see below. Everything else is bare `eq`/`exists`/`empty`.

**Pseudo-fields** (`_scan_file` in `app.py`, 2026-08-04 Phase 2) — `mtime`/`wordcount`/
`linecount` are computed once per file (already being read for `parse_frontmatter` anyway, no
second read) and merged into the same `meta` dict real frontmatter lives in, always winning
over a same-named real field. This is what makes `group:`/`sort:`/filters treat them identically
to real frontmatter with zero special-casing anywhere downstream — the one-namespace design is
load-bearing, don't special-case a pseudo-field name anywhere except where it's computed.

**Recursive scan, and a real dotfile-leak bug found 2026-08-04** — `os.walk(walk_root)`
(`walk_root` is `nb_dir` or `nb_dir / folder`, per Phase 1's folder-scoping) walks the whole
subtree; `dirnames[:] = sorted(d for d in dirnames if not d.startswith('.'))` already excluded
hidden *directories*, but **filenames were never filtered the same way** until 2026-08-04 —
`.index` and `.<notebook>.md` have no `type:` field, so any filter permissive of a missing
field (concretely: `neg`, or no filters at all) silently counted them as real results. Every
positive `eq`/`>`/`<` filter happened to exclude them by coincidence (dotfiles don't share a
real note's field values), which is exactly why this sat invisible through three phases of this
same feature before negation's "missing field still matches" semantics exposed it. Fixed by
filtering `filenames` the same way `dirnames` already was
(`nb-web/CLAUDE.md` invariant 24) — **any new `os.walk`-based notebook scan needs this same
filename filter, it is not automatic.**

**`sort:`/`limit:` directives** (Phase 5) — extracted during the same token pass as filters but
carried out-of-band (`sort`/`limit` return values, not filter dicts), applied as a
*post-processing* step on the already-fetched result list — orthogonal to `_run_front_query`'s
own `limit` param, which is a scan-safety cap (200 default/500 max) applied *while walking*,
not a display truncation. Client-side equivalent is `_fmSortLimit`/`_fmNum` in
`nbweb-codeblocks.js`. **`_fmNum` exists specifically because `parseFloat` silently partial-
parses** — `parseFloat("2026-08-01")` returns `2026` (stops at the first non-numeric char)
instead of failing, unlike Python's `float()` which requires the whole string and raises. Every
date in the same year would sort as equal, useless keys with plain `parseFloat`. `_fmNum` does
`Number(s.trim())` with an explicit empty-string guard (`Number('')` is `0`, not `NaN`) —
whole-string strict, matching `_fm_compare`'s Python-side behaviour. **Any new client-side
numeric-vs-string field comparison should reuse `_fmNum`, not reach for `parseFloat` directly.**

**Access control** (`_run_front_query`, 2026-08-04) — per-note `_can_access(user, meta,
notebook_config)` check, same floor `/api/note` already enforces; admin floor on the
root-dotfiles scan (`.nb.md` etc., only reachable with `notebooks` omitted), matching the
existing `.nb:.nb.md` special case in `api_note`. **This didn't exist at all before 2026-08-04**
— found while writing Phase 1's own tests, unrelated to folder-scoping itself but fixed in the
same commit (`nb-web/CLAUDE.md` invariants 17/19 already documented this exact recurring shape
for other endpoints; this one just hadn't been audited).

**Shared scan logic, two callers** — `_run_front_query(user, nb_list, folder_list, filters,
limit)` backs both `/api/front-query` (the codeblock) and the `fm` provider inside
`api_inline_query` (`{{fm: count ...}}`, `count`-only, via `_parse_fm_scope` to turn the raw
query string into the same args). One implementation, one set of access-control guarantees —
don't reimplement the scan for a future inline-provider-only feature; extend
`_run_front_query`/`_fm_sort_limit` and add a thin caller instead.

**Aggregation verbs** (`group:field`, `count`, `sum:field` — codeblock only, reserved-prefix
convention matching `list`/`list-core`) — all three are *alternative render modes*, not
composable with the flat list (a block renders either a list or an aggregate, never both — the
plan's own open-question call). `group`/`count`/`sum` are entirely client-side aggregation over
the same `/api/front-query` response the flat list already fetches — no backend awareness of
"grouping" or "summing" exists at all. `sum:` skips notes missing the field or holding a
non-numeric value rather than treating them as `0` or excluding the note from the underlying
match (djp's explicit call) — header shows `(counted/total)` so the gap stays visible rather
than silently implying completeness. A dedicated `wordcount` verb was considered and dropped:
once `wordcount` is a pseudo-field and `sum:field` is generic, `sum:wordcount` already covers
it — building both would just be two ways to write the same query.

**Pipe label parsing** — use `indexOf(' |')` (space + pipe), not `' | '` (which requires space after the pipe too). `raw.slice(pipeIdx + 2).trim()` gets the label regardless of spacing after the pipe.

**CSS tooltips** — native `title=` attribute is ugly and browser-controlled. Use `data-tip` + CSS `::after { content: attr(data-tip); white-space: pre }` instead: instant, styled, no JS, matches theme. Standard pattern for all blocks going forward.

**`overflow:hidden` clips absolute children** — `overflow: hidden` on a block container clips absolutely-positioned tooltip children (they disappear below the fold). Fix: remove `overflow:hidden`, apply `border-radius` directly to first/last child via `:first-child`/`:last-child` selectors instead.

**Collapsible header conventions** — whole header bar is the collapse toggle (click handler on header div, not a child button). Refresh button right-justified via `margin-left: auto`. Default collapsed; restore open state via `wasOpen` flag before clearing `innerHTML`.

**API meta field** — return `{k: str(v) for k,v in meta.items()}` — stringify all values so YAML lists/dicts don't break JSON serialisation. Multiline YAML strings: collapse to single space in tooltip via `v.replace(/\n/g,' ')` in JS.

**`model: true` convention** — frontmatter key to mark exemplary/reference notes. `` ```fm\nmodel:true | Model notes\n``` `` lists them across all notebooks.

---

## Access gates — implementation

User-facing behaviour: [CODEBLOCKS](../CODEBLOCKS.md#access-gates). Dev-security reference: [security](dev-security.md#codeblock-gates).

### Two gate models #pattern

**Codeblock-level gate** — the block type itself has a minimum read level in `codeblock_access`. Below that level, the block never fires: `_cbCan()` → `_cbDenyRead()` → `el.remove()` before any network request.

**Destination gate** — `nav` and `nb` have `null` read in `codeblock_access` (no tool-level gate). They fire unconditionally, but their backend endpoints enforce access by destination:
- `/api/fs/list` — dotfolders check `_DOT_OPEN` or admin+; regular notebook dirs check `_notebook_config(nb).access`
- `/api/notes` — already filtered by notebook config + per-note `access:` in `_list_notes()`

A 403 from a destination endpoint is caught in the load function and becomes `_cbDenyRead(el)` — silent removal, never an error banner. #invariant: users never see a 403 in the UI.

### Settings

**Corrected 2026-07-21** — this section previously (and wrongly) documented `codeblock_access`
as living in `nb-settings.json`/`_SETTINGS_SCHEMA`. It does not. It lives in `~/.nb/.nb.md`'s
frontmatter — the root of the global config walk-up chain (see the `nb-web` skill's "Config
resolution" section) — resolved server-side via `_effective_setting('codeblock_access')` →
`_global_config()`. It is **not** a key in `_SETTINGS_SCHEMA` (confirmed by reading it: no such
entry exists), so a `PATCH /api/nb-settings` naming it 400s as an unknown setting.

`GET /api/nb-settings` merges it into the response read-only, sourced from `.nb.md` (fixed
2026-07-21 — before this fix, `codeblock_access` never appeared in the response at all, which
meant `_cbAccess` in `nbweb-codeblocks.js` was always `{}` and the frontend read-gate silently
never fired for *any* block type since this mechanism shipped — see "Access gates —
implementation" below for the consequence). Current values, straight from `~/.nb/.nb.md` —
edit that file directly, not this doc, if they change:

```yaml
codeblock_access:
  fm:       {read: admin}
  cfg:      {read: admin}
  hl:       {read: office, write: admin}
  chart:    {read: office}
  tw:       {read: user, write: user}
  git:      {read: user}
  check:    {read: user}
  t:        {read: user}
  tui:      {read: user}
  nb:       {}
  nav:      {}
  sysadmin: {read: tech}
```

`{}`/absent `read` = destination-gated (no codeblock-level check). Absent `write` = no write controls exist.

### Frontend utilities (`nbweb-codeblocks.js`)

All live in the top of the IIFE, before any block-specific code:

| Function | Purpose |
|----------|---------|
| `_cbAccess` | Module-level dict, populated by a single `fetch('/api/nb-settings')` on plugin load |
| `_cbParseGates(text)` | Strips `read:` / `write:` lines from fence body; returns `{readLevel, writeLevel, query}` |
| `_cbGateAttrs(r, w)` | Produces `data-cb-read="…" data-cb-write="…"` attribute string for the block div |
| `_cbLevel(el, type, mode)` | Per-block attr wins over `_cbAccess[type][mode]` |
| `_cbCan(el, type, mode)` | `window.NbAuth?.is(level) ?? true` — fails open if auth not loaded |
| `_cbDenyRead(el)` | `el.remove()` — no trace |

### html() / render() wiring

Every `html:` function in `codeblockRenderers` calls `_cbParseGates(text)` and stores the results as `data-cb-read` / `data-cb-write` on the block div. The cleaned `query` (with gate lines removed) is stored in `data-query` / `data-cmd` / `data-period` as normal.

Every `_load*Block()` function begins with a read gate check:

```javascript
if (!_cbCan(el, 'blocktype', 'read')) { _cbDenyRead(el); return; }
```

Write buttons (`+`, `✎`) are conditionally created:

```javascript
if (_cbCan(el, 'hl', 'write')) {
    const addBtn = ...
    acts.appendChild(addBtn);
}
```

### render() vs renderOne() for different behaviour #pattern

Most renderers use the same private loader for both paths: `render(container)` iterates body blocks and calls `_loadXBlock(el)`, while `renderOne(el)` is the same call routed through the FM lazy expand. Same function, two call sites.

The `timedot` renderer breaks this pattern intentionally — body and FM need genuinely different UIs:

```javascript
{
    lang: 'timedot',
    renderOne: async el => _loadTimedotBlock(el),    // FM: aggregate summary + filter
    render: async container => {
        ...blocks.map(el => _loadTimedotRawBlock(el)) // body: verbatim + ✎ inline edit
    },
}
```

Use this split when a block type has semantically different display needs in body vs FM context. The body block is data-entry; the FM block is overview. Same source format, different viewer.

### _CB_ICONS — text, image, and emoji variants

Block icons are defined in `_CB_ICONS` at the top of the IIFE:

```javascript
const _CB_ICONS = {
    hl:      { img: '.images:hledger-logo.png', alt: 'hledger' },  // image
    nav:     { text: 'NAV' },                                       // text chip
    timedot: { text: '⏱', emoji: true },                           // emoji
};
```

| Spec field | CSS class added | Renders as |
|------------|----------------|-----------|
| `img:` | `nb-cb-icon` (img element) | Logo image at 1.2em |
| `text:` only | `nb-cb-icon` (span) | Monospace chip with border, 0.65em |
| `text:` + `large: true` | + `nb-cb-icon--large` | Serif italic, 1.1em, no border |
| `text:` + `emoji: true` | + `nb-cb-icon--emoji` | Default font, 1.1em, no border |

Use `emoji: true` for any icon that is a Unicode emoji — it disables the monospace chip styling and lets the emoji render at a readable size.

### test block special case #pattern

Other block types auto-render so a denied read → silent removal is always correct. `test` blocks have two forms:

- **Form 2** (no label, auto-run): `el.remove()` — same as all other types
- **Form 1** (labeled button): block was explicitly surfaced by the note author; label still renders, clicking shows `🔒 Requires X access` via `_buildTestDenied(el, label, level)`

The form detection happens *before* the gate check in `_loadTestBlock` — parse label first, then decide.

### Backend enforcement

**Write endpoints** — `_cb_write_allowed(block_type)` in `app.py` reads `codeblock_access[type].write`
via `_effective_setting('codeblock_access')` (i.e. from `~/.nb/.nb.md`, **not** `_settings`/
`nb-settings.json` — see "Settings" above) and compares via `_level_gte()`:

- `api_hledger_add()` → 403 if insufficient
- `api_task_add()` → 403 if insufficient
- `api_task_action()` → 403 if insufficient

**Destination listing** — `/api/fs/list` enforces access by the path's first component:
- Dotfolder not in `_DOT_OPEN` → admin+
- Regular notebook dir → `_notebook_config(name).get('access', 'user')`

**Read side has no equivalent `_cb_read_allowed()`.** There is no backend function that checks
a `codeblock_access[type].read` level anywhere — confirmed by grep, 2026-07-21. For block types
with a `read:` level but no independent per-endpoint check of their own (e.g. `hl`'s data source,
`/api/hledger-query`, has no level gate at all beyond "logged in"), the *only* enforcement was
ever the frontend `_cbAccess` gate — which, per the "Settings" section above, was silently
non-functional (`_cbAccess` always `{}`) from when this mechanism shipped until 2026-07-21. In
practice this meant any authenticated user, any level, could read `hl`/`chart`-gated data by
calling the underlying endpoint directly, regardless of the `office`-level intent — a real
backend gap the frontend fix does not close (the frontend gate is UX, not a lock; see the
invariant below). `sysadmin`, by contrast, is safe because `api_sysadmin()` and
`api_sysadmin_crontab()` each do their own explicit `tech`-level check independent of
`codeblock_access` entirely (see "sysadmin block internals" below).

Frontend codeblock gate is UX; backend is the actual lock. #invariant — **not yet true for
`read:`-gated block types that lack their own endpoint-level check** (see above); true today
only for `write:` (via `_cb_write_allowed`) and for the small set of blocks whose destination
endpoint enforces its own level check regardless of `codeblock_access`.

### 403 → silent removal #pattern

Any 403 from a destination endpoint in a load function must call `_cbDenyRead(el)` and return, not render an error. The user never learns the resource exists.

```javascript
const r = await fetch(`/api/fs/list?path=${encodeURIComponent(rawPath)}`);
if (r.status === 403) { _cbDenyRead(el); return; }
```

Applied in `_loadNavBlock` (rawPath and notebook paths) and `_loadFmBlock`. Any new load function that calls a listing or content endpoint should follow this pattern.

---

## cfg block internals

User-facing syntax: [CODEBLOCKS](../CODEBLOCKS.md#cfg--config-inheritance-tree).

**Endpoint:** `GET /api/config-tree?notebook=X&folder=Y&key=Z&selector=S`

Returns an ordered array of nodes from global root → target → note. Each node:
```json
{ "level": "global|notebook|folder|subfolder|note",
  "path": "/abs/path/.shots.md",
  "selector": "/abs/path/.shots.md",
  "exists": true,
  "contributes": { "key": "value", ... } }
```

`contributes` holds **only what that file itself sets** — not inherited values. The `key` param filters to a single field; the API returns `{key: value}` or `{}` per node. Inheritance is implied by position — the UI never shows inherited values explicitly.

The `note` level (appended last, highest priority) is the currently open note's own frontmatter. Pass `?selector=accts:16` to include it. Note-level node uses the selector as its display name, not the raw path.

**Selector:** absolute path for config files. `/api/note` handles absolute-path selectors via `elif selector.startswith('/')` — dotfiles open normally in the preview pane.

**`_configParseQuery(raw, currentSelector)`** — parses the codeblock body:
- `field: .` → key=field, notebook+folder resolved from `NbMain.activeSelector()`
- `field: Notebook:folder/` → key=field, explicit target
- bare → key='', target='.', resolves from active selector

**`NbMain.activeSelector()`** — accessed as bare `NbMain` (not `window.NbMain`) since `const NbMain` in `main.js` is not a `window` property. #gotcha

**Rendering — table layout** (`_configRender`): four columns — marker, icon (depth-indented), path/selector, value. Value column always rendered; `—` in muted gray when a level doesn't set the queried key. True column alignment via `<table border-collapse: collapse>`, not flex.

**Effective marker** (`▶` amber): the last node in the array (highest priority) that contributes the queried key. When no key specified, the deepest existing node. `◉` blue when `currentSelector` matches a node exactly (viewing a config file that has its own `config` block).

**`access: guest` in `.nb.md`** — global floor set to `guest`. Every notebook and folder gates up from there; the `cfg` block makes the chain visible and shows where the effective value comes from. #invariant

---

## sysadmin block internals

User-facing syntax: [CODEBLOCKS](../CODEBLOCKS.md#sysadmin--admin-dashboard).

Three modes, dispatched by `_dispatchSysadminBlock(el)` on `el.dataset.mode`
(`'users'` → `_loadSysadminUsersBlock`, `'crontab'` → `_loadSysadminCrontabBlock`,
else → `_loadSysadminBlock`) — three separate loader functions, not one
parameterized call, since the three modes render structurally different UIs
(read-only dashboard vs. an editable table vs. a crontab listing).

**Bare mode — `GET /api/sysadmin`:** builds notebook inventory by iterating
`NB_DIR` directly (dotfile presence, `git remote get-url origin` /
`git rev-parse --abbrev-ref HEAD` for wired/remote/branch, `.checks/`
presence, `*.md` count via `rglob`), reads `nb-settings.json` for the plugin
list, and checks existence of a fixed set of key config file paths. All
filesystem/subprocess work, no caching — expect this to be slower than other
dashboard blocks on a large notebook tree.

**`config_files` selectors are absolute paths, not `notebook:file` selectors**
(fixed 2026-07-21 — they used to read `.nb:.manifest.md` etc., which never
resolved: no notebook is ever named `.nb`, and `/api/note`'s dotfolder-selector
handling rejects any filename containing `/` regardless, which ruled out
`.checks/check-index.md`-shaped paths outright even for a valid prefix). Now
`str(NB_DIR / '.manifest.md')` and friends, handled by `/api/note`'s
`elif selector.startswith('/')` branch. The one exception: **"Global dotfile"
keeps the literal `.nb:.nb.md` selector** — that exact string is special-cased
in `api_note()` with its own `admin`-level check, which the plain-absolute-path
branch doesn't have at all (no read-level gate on that branch, for any path).

**`users` mode — `GET /api/users` (not `/api/sysadmin`)**: a genuinely
different endpoint from the other two modes, and a write-capable one — level
change (`PUT /api/users/<username>`), delete (`DELETE /api/users/<username>`),
create (`POST /api/users`, requires username+password). `_SA_LEVELS` (JS) is
the fixed `['guest', 'user', 'office', 'admin', 'tech']` ladder used for the
level `<select>`.

**`crontab` mode — `GET /api/sysadmin/crontab`**: shells to `crontab -l` and
parses schedule/command/description (a contiguous run of `#`-comment lines
immediately above an entry becomes its description — same convention
`check-sweep`'s own crontab entry already follows). No crontab at all
(`crontab -l` exits 1) is treated as a normal empty state, not an error.

**Access — all three backend-enforced independently, not just note-level:**
`api_sysadmin()` and `api_sysadmin_crontab()` both do
`if not _level_gte(user.get('level', ''), 'tech'): return jsonify(error='forbidden'), 403`
directly; `/api/users`'s own endpoints enforce `admin`. **`sysadmin` is now in
`codeblock_access`** (`{read: tech}`, added 2026-07-21 to `~/.nb/.nb.md`) — so
it now gets the same frontend early-deny/silent-removal as `hl`/`chart`/etc.,
once the frontend gate itself is actually live (see "Settings" above — it
requires the `GET /api/nb-settings` fix from the same date). Before this,
a sub-`tech` user hitting the block would have gotten the loader's own inline
"requires X level" message instead of `_cbDenyRead`'s silent `el.remove()` —
never a real security gap, since `api_sysadmin()`'s own backend check was
always the actual lock, and every current instance of this block lives on a
note already gated `access: tech` regardless.

---

## test glob internals

User-facing syntax: [CODEBLOCKS](../CODEBLOCKS.md#test--embedded-assertions) § Form 4.

**Endpoint:** `GET /api/test/glob?prefix=nb-schem-`

Returns sorted list of `*.sh` filenames in `~/.nb/.checks/` matching `{prefix}*.sh`. Prefix must end with `-` (enforced server-side). Returns `[]` if `TEST_DIR` doesn't exist.

**JS resolution:** `_resolveTestGlob(prefix)` — async fetch, returns `[]` on any error. Called lazily at render time (not during `_collectAutoRunScripts`), so glob blocks don't block the batch pre-collection phase.

**Naming convention:** `{app}-{family}-{check}.sh` where:
- `{app}` = domain prefix (`nb-`, `hl-`, `tw-`, `note-`)
- `{family}` = sub-group (`config`, `schem`, `ref`, `struct`)
- `{check}` = specific check name
- Dangling dash `nb-schem-` globs the family; `nb-` globs the whole domain

**`_collectAutoRunScripts`** skips glob lines (ends with `-`) — they can't be pre-batched without a network round trip. Glob blocks resolve their script list lazily in `_loadTestBlock` instead.

---

## FM-mode — implementation

**Concept:** any registered codeblock lang can be promoted out of the note body into the `#nb-fm-blocks` strip by declaring it as a frontmatter key. The field value becomes the block query.

**HTML slot:** `<div id="nb-fm-blocks" hidden></div>` — sits between `#nb-toc-bar` and `#nb-preview-content` in `index.html`. Hidden whenever the toolbar is hidden (editor, spreadsheet, PDF).

**Sibling CSS hide rule:**
```css
#nb-preview-toolbar[hidden] ~ * ~ #nb-fm-blocks { display: none !important; }
```
`~` matches any later sibling; the two-step form is explicit about the structure (toc-bar is the intermediate sibling).

### Lazy render-on-demand #pattern

FM blocks load their content **on first expand only** — no API calls fire at note-load time for collapsed blocks. This keeps note switching fast when a note has many FM blocks.

**Flow:**

1. `_buildFmBlocks` calls `r.html(query)` for each FM key → skeleton `<div class="nb-{lang}-block">` in DOM.
2. If the renderer has `renderOne`, `NbWeb.fmUtils.buildFmSkeleton(block, lang)` replaces the spinner with a real barblock header (correct icon, `…` in meta) and sets `data-fm-lazy='1'`.
3. Block starts collapsed (unless `nb-fm:…` key says it was open last session).
4. First click to expand → `renderer.renderOne(block)` fires → loader runs, rebuilds header + body → FM tracking re-wired on the new real header.
5. Blocks that were open last session call `renderOne` immediately (async, parallel with any eager blocks).

**`renderOne(el)` — the per-block loader method** (added to each renderer in `codeblockRenderers`):

```javascript
// Simple loaders — just call the private loader directly:
renderOne: async el => _loadNavBlock(el),

// Loaders that need a requirements check:
renderOne: async el => {
    const w = await NbWeb.checkWhich('task');
    return w.found ? _loadTwBlock(el) : NbWeb.renderRequirementsCard(el, '...');
},
```

`renderOne` is only called from the FM lazy path — body codeblocks still use `render(container)` via `NbWeb.renderCodeblocks`. **Adding `renderOne` to a new renderer is required for it to participate in lazy FM loading.** Without it the block falls through to the eager path.

**`NbWeb.fmUtils.buildFmSkeleton(block, lang)`** — builds a proper barblock header (calls `_buildBarHeader` with the right `cls` alias for `cfg`, which emits `nb-config-*` CSS rather than `nb-cfg-*` to avoid conflict with the dotfile form) and sets `data-fm-lazy`. Lives in `nbweb-codeblocks.js`, exported via `NbWeb.fmUtils` so `main.js` can call it without coupling to plugin internals.

**Eager path** (renderers without `renderOne` — currently `tui`, `check`): `r.render(wrap)` is called directly per renderer, scoped to `#nb-fm-blocks`. These renderers' `querySelectorAll` calls are type-specific enough that they never accidentally pick up lazy blocks from other renderers.

**`nb-fm:${cls}:${id}` localStorage key** — tracks open/closed state per FM block. Value `'1'` = user has opened it; absent = start collapsed. Independent of the `nb-collapse:${cls}:${id}` key used by body blocks.

**`check:` is explicitly excluded** — config-chain directive, not a display block:

```javascript
if (key === 'check') continue;
```

**`toc:` is included** — `toc` now has a registered renderer (`renderOne: el => _loadTocBlock(el)`). `toc: true` adds a TOC barblock to the FM strip; `_buildToc` in `_finishRendered` sets heading IDs as a side effect but suppresses the sidebar `#nb-toc-bar` when the FM renderer is registered.

**`timedot:` FM aggregation** — when `timedot:` appears in frontmatter with no `timedot_file:` set, `_loadTimedotBlock` queries `#nb-preview-content .nb-timedot-block` (body blocks only — FM blocks live in `#nb-fm-blocks`) and concatenates their `data-src` into one aggregate. This is safe: body blocks have `data-src` populated from parse time, before FM blocks are built. The `+` add button is suppressed in this mode since there is no single write target.

---

## csv block + sheet-file editor internals

Two genuinely separate code paths render a jspreadsheet grid — don't conflate them:

| | Fenced ` ```csv ` block | Standalone `.csv` **file** |
|---|---|---|
| Trigger | A note body contains a `csv` fence | `classify()` maps `.csv` extension → `type: sheet` (`app.py`) |
| Renderer | `_renderCsvBlocks` / `_renderCsvTmplBlock` (`main.js`) | `_renderSheet` / `_sheetInitGrid` (`main.js`) |
| Header row | Always row 1, unconditionally (the template form's `contents` sentinel splits header/footer — see `#csv — Spreadsheet Table` above) | Manual toggle only, see below — never assumed |
| Host element | `.nb-csv-block` inline in `#nb-preview-content` | `#nb-sheet-host`, the note's *entire* preview content |

**Column width — `_csvColumnWidths(rows, headerRow = [])`** (shared by both paths): width
per column is the longest cell in that column (header included when present), clamped to
`[_CSV_MIN_PX=60, _CSV_MAX_PX=400]`, plus `wordWrap: true` on every column. Fixed 2026-07-21 —
previously every column was hardcoded to `width: 120` regardless of content, and the sheet-file
editor set no `columns` option at all (library default). `_csvAutoColumns(headerRow, dataRows)`
is the header-bearing wrapper around the same helper for the fenced-block path.

**Height — `.nb-toolbar-only` on `#nb-editor-wrap`.** The sheet-file editor reuses
`#nb-editor-wrap` (normally the *full* inline markdown editor — toolbar + textarea, `flex: 1`
sibling of `#nb-preview-content`) purely to show its Save/Cancel buttons, while leaving
`#nb-preview-content` visible too (unlike real edit mode, which hides it outright — see
`_setMode`-equivalent around `main.js:3752`). Two visible `flex: 1` siblings split the pane
50/50 regardless of content — this silently capped the grid at half the preview pane's height
for any file, no matter its row count, until fixed 2026-07-21. `_renderSheet` now adds
`nb-toolbar-only` when opening (CSS: `flex: 0 0 auto`, hides `#nb-editor-area`); the
navigate-away cleanup block in `renderPreview` (`note.type !== 'sheet' && _sheetInstance`)
removes it again.

**`minDimensions: [6, 8]` — empty-fallback only, never for real data.** Originally applied
unconditionally, padding *every* save with trailing empty cells for any file narrower than 6
columns or shorter than 8 rows — hit on every single save of a real 5-column bank-export file.
Now only passed when `dataRows.length` is 0 (a genuinely blank new `.csv`, where the padding
gives a workable empty grid to type into); real data gets no artificial minimum.

**"First row is header" toggle — manual, off by default, never persisted.** `.csv` files have
no frontmatter, so there's nowhere in the file itself to record "this file has a header" —
`_sheetHeaderMode` always starts `false` on every open, regardless of what a previous session
chose for that same file. Deliberately *not* auto-detected: the motivating real file
(`djp:accounting/csv/accountactivity.csv`, a raw bank export) has no header row at all, and a
wrong auto-guess would silently pull a real transaction row out of the data grid — worse,
`_saveSheet` would then write it back that way too, permanently losing that row's data on the
next save. Toggling reconstructs the full row set from the *live* grid via `ws.getData()` (not
by re-reading the original note content), so in-progress edits survive a toggle in either
direction; `_sheetHeaderRow` holds the header cell values while active so unchecking can
restore them as a normal data row rather than discarding them.

**Unsaved-edit navigation guard — `_sheetDirty`.** Sheet edits only ever live in the browser's
in-memory grid until Save is clicked; nothing auto-saves. `_sheetDirty` (set by real edits via
jspreadsheet's `onchange`/`oninsertrow`/`ondeleterow`/`onundo`/`onredo` callbacks) is checked by
`openNote()`'s existing navigation guard alongside `_editing`, so navigating away with unsaved
changes now prompts `confirm("Discard unsaved changes?")` the same way the markdown editor
already does. Cleared on a fresh note load and on successful save.

**Gotcha: these callbacks must be top-level siblings of `worksheets` in the `jspreadsheet()`
init call, not nested inside the worksheet config object.** Confirmed empirically 2026-07-21:
identical callbacks placed inside `worksheets[0]` show up fine if you inspect
`ws.options.onchange` afterward (it's genuinely set to your function) — but jspreadsheet-ce
only ever dispatches them from the top-level init object, so a worksheet-nested one is silently
never called, no error either way. Cost real debugging time (a wrapped-callback probe with a
call counter was what finally proved it) before landing on the top-level placement.

**Planned, not built:** persist `header_row` via the file's own annotation sidecar
(`.{filename}.annotations.md`) — not a new mechanism, this is the *existing* one:
`_merged_meta()` already treats a frontmatter-incapable file's (which `.csv` is) annotation
sidecar as its effective `meta`, already returned by `GET /api/note`. Scoped up into a
bigger idea 2026-07-21 (djp, thinking about the hledger CSV-import workflow `tutorial:`'s own
bundled lessons teach): the same sidecar could carry real import context — source, date
range, target journal, `.rules` file path, last-imported timestamp — not just the header
toggle. Full field convention and phased build plan:
`claude:csv_import_sidecar_hledger_plan_2026-07-21.md`.

### jspreadsheet-ce feature inventory (v5.0.4, `vendor/jspreadsheet.min.js`)

None of the below are currently wired up anywhere in nb-web — confirmed present in this exact
vendored build (`grep`'d the minified source directly, not just documented upstream) while
investigating the width/height fixes above, 2026-07-21. Reference for future spreadsheet-control
work rather than an implementation:

| Option | What it does |
|---|---|
| `wordWrap` | Per-column: wrap instead of clip. Now used by both csv paths above. |
| `columnResize` | User drag-to-resize column boundaries. Likely already on by default (library default, not explicitly set either way here) — verify in-browser before assuming it needs wiring. |
| `columnDrag` | User drag-to-reorder columns. |
| `columnSorting` | Click header to sort. |
| `tableOverflow` / `tableWidth` | Constrain the grid to a fixed width with its own horizontal scroll, instead of growing to fit all columns. |
| `freezeColumns` | Pin N leftmost columns while scrolling horizontally. |
| `filters` | Per-column filter dropdowns in the header row. |
| `search` | Built-in search box above the grid. |
| `pagination` | Row count per page, with page controls — relevant for something like the 787-row `accountactivity.csv`. |
| `toolbar` | A formatting/action toolbar above the grid (bold, colors, etc. depending on config). |
| `contextMenu` | Customize the right-click menu (currently library default — insert/delete row/col, copy/paste). |
| `allowExport` | Export-to-file button. |

---

## mkd-codeblocks

`NbWeb-codeblocks` is nb-web's implementation of the [mkd-codeblocks](https://github.com/linuxcaffe/mkd-codeblocks) project — a collection of independently distributable live-query widgets designed as self-contained drop-ins for any markdown note app.

The `hl` block is already released as a standalone package ([hledger-codeblock](https://github.com/linuxcaffe/hledger-codeblock)). The others (`tw`, `nb`, `git`, `t`, `nav`, `fm`, `test`) are planned for extraction as the project matures. The `cfg` block is nb-web-specific (config chain resolution) and is not planned for standalone release.

---

## `.lib/` block extras — help buttons and open protocol #implemented

`~/.nb/.lib/` holds two kinds of barblock extension files, auto-discovered at startup
via `/api/lib/block-extras` and stored in `_blockExtras` in the plugin.

### File naming

| Pattern | Effect |
|---------|--------|
| `help-block-{lang}-{access}.md` | Adds `?` button to that lang's barblock header |
| `help-type-{topic}.md` | Content served by `help: <topic>` FM key on specialty headers (no access suffix — `.lib` open access applies) |
| `open-block-{lang}-{access}.sh` | Wires title-click + `⎋` button to run the script |

For `help-block-*`: access level follows the standard five-point scale; the highest level
the current user meets wins. Scripts must be executable (`chmod +x`).

For `help-type-*`: no access suffix — file is served at `.lib` open level. Served by
`_showTypeHelp()` in `nbweb-specialty.js`, which calls `NbMain.renderMarkdown` +
`NbMain.enrichRendered(pop, d)` so the help file's own `xref:` FM key and any `note:`
links in the body are live in the popover.

### Open protocol — script stdout decides the action

The script prints exactly one line; `_dispatchLibOpen(out)` parses the prefix:

| Output line | Action |
|-------------|--------|
| `nb:<selector>` | `NbMain.openNote(selector)` — opens note in preview pane |
| `file:<path>` | `NbMain.openNote(path)` — same, for bare filesystem paths |
| `term:<cmd>` | `NbTerminal.run(cmd)` — runs command in the PTY terminal |
| `http://…` / `https://…` | `window.open(url, '_blank')` — new browser tab |

### Title-click routing

When `_blockExtras.open[lang]` is set, the barblock's clickable title routes through
`_execLibOpen` instead of its hardcoded default. Fallback chain:

```
title click
  → lib script exists?  yes → _execLibOpen → _dispatchLibOpen
                         no → block's hardcoded default (tw-web launch, hledger-web, etc.)
```

The `⎋` button and title click call the same `_execLibOpen` function — same action,
two entry points. When a lib script handles the title, the `⎋` button becomes redundant
(but is not hidden automatically).

### Example scripts

```bash
# open-block-hl-admin.sh — open hledger journal in nb-web preview
echo "nb:accts:hledger.journal"
```

```bash
# open-block-tw-admin.sh — launch tw-web (start if needed) and open it
NB_PORT="${NB_PORT:-5001}"
result=$(curl -sf -X POST "http://localhost:${NB_PORT}/api/tw/launch" 2>/dev/null)
url=$(python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('url',''))" <<< "$result" 2>/dev/null)
[ -n "$url" ] && echo "$url" || echo "http://localhost:5000"
```

### Loading state

- **Button trigger** (`⎋`): `disabled` during fetch
- **Title trigger** (span): `nb-lib-loading` class → `opacity: 0.45; pointer-events: none`

### Journal scoping — block carries its own resolution #invariant

`_execLibOpen(trigger, lang, { journal })` accepts an optional `journal` override.
For `hl` blocks, the title-click passes `el.dataset.hlJournalSel` directly:

```javascript
if (_blockExtras?.open?.hl) {
    _execLibOpen(nameEl, 'hl', { journal: el.dataset.hlJournalSel || '' });
    return;
}
```

`el.dataset.hlJournalSel` is set at block load time from the API response
(`d.journalSelector`). It is always the authoritative journal — the same one
the codeblock queried — regardless of which note or folder the block lives in.

**Why not derive from note FM?** A note in `Takeout:reports/` may have no
`journal:` FM but its hl block correctly queries the Takeout journal (via
the hledger config chain). Reading `effective_fm.journal` on the note would
miss this and fall through to the fallback, opening the wrong journal.

**Priority in `_execLibOpen`:**
```
journalOverride (from block dataset)   ← most specific, set by loader
  ?? effective_fm.journal               ← folder config propagation
  ?? meta.journal                       ← per-note FM override  
  ?? ''                                 ← script's own fallback logic
```

**Three-tier discovery in `open-block-hl-admin.sh`:**
```
NB_JOURNAL set    → echo "nb:$NB_JOURNAL"            (direct)
NB_NOTEBOOK set   → query /api/notes?type=journal     (discovery)
fallback          → echo "nb:accts:hledger.journal"   (hardcoded)
```

`type: journal` notes (`.md` files) are discoverable; raw `.journal` files
cannot carry YAML frontmatter. Companion portal notes (like `ledger.md` in
`Takeout/accounting/`) serve as the typed entry-point.

`journal:` in `_FM_BLOCK_KEYS` — propagates from folder config down to notes
via `effective_fm`. `journal` in `_FM_TYPES` — enables `type: journal` list
indicator (📒) and slim meta treatment.
