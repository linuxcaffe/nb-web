# nb-web — CLAUDE.md

Quick orientation for Claude Code sessions in this repo.

## What this is

Flask (`app.py`, port 5001) + vanilla JS (`main.js`, `nav.js`). No build step. Run with `python3 app.py`. Notes live in `~/.nb/` as plain Markdown files; nb-web never writes them directly — everything goes through nb CLI or git.

## Key files

| File | Role |
|------|------|
| `app.py` | Flask backend — all API endpoints, nb subprocess wrappers, git ops |
| `main.js` | Note rendering, editor, wikilinks, codeblocks, pre-close rules, annotations |
| `nav.js` | `NbNav` singleton — notebook/folder scope, breadcrumb, sync dialog, menu |
| `terminal.js` | `NbTerminal` singleton — pty terminal pane + settings-in-preview (extracted from main.js, tier-1 modularization) |
| `dialog.js` | `NbDialog` singleton — import/export/move/copy/rename + folder ops panel (extracted from main.js, tier-1 modularization) |
| `drag-handles.js` | `NbDragHandles` singleton — list-pane resize + annotation-split resize handles (extracted from main.js, tier-2a modularization) |
| `note-actions.js` | `NbNoteActions` singleton — Today/Journal view, Add-note form, note-creation API wrappers (extracted from main.js, tier-2b modularization) |
| `search.js` | `NbSearch` singleton — search-bar dispatch, tag-filter binding (extracted from main.js, tier-2c modularization) |
| `sync.js` | `NbSync` singleton — git wire/log commands, run-command dispatch (cal/daily/info/weather) (extracted from main.js, tier-2d modularization) |
| `styles.css` | All styling — no preprocessor |
| `nb-settings.json` | Runtime config — default_git_remote, git_repos aliases, plugin list |
| `plugins/` | Core plugins (nbweb-codeblocks, nbweb-contacts, nbweb-archive, nbweb-quartz) |

External plugins live in `~/dev/nbweb-*/` and are wired via `nb-settings.json`.

## Docs

- **User docs:** `~/.nb/docs/` — all files have `processed: true` frontmatter; open in nb-web
- **Dev docs:** `~/.nb/docs/dev/` — 11 files; index at `docs:DEVELOPERS.md`
- **AI meta-index:** `~/.claude/projects/-home-djp/memory/reference_nb_web_index.md` — "where is X?" for any topic

## Wikilink convention

**Embed filename stems, display alias.** The stable link target is always the filename stem:

```
[[WH-captive-cu-4f]]   ← in a script note
```

If `WH-captive-cu-4f.md` has `alias: 4f`, it renders inline as `4f` automatically
via `data-autolabel` → `meta.alias || title`. The `title:` frontmatter appears as tooltip.

Never embed bare aliases (`[[4f]]`) — the resolver matches title and filename stem only,
not `alias:` field values. See `dev-wikilinks.md` § Display label resolution.

**NbMain.saveNote** is exported — call it before navigating away from an editor in plugins.
**NbMain.activeNote()** returns the full current note object (meta, body, selector, etc.) — useful in plugin renderers that need FM values like `check_timeout`.

## Critical invariants — read before touching rendering or sync

1. **Annotation foot:** calls `_enrichRendered` directly, never `_finishRendered` → infinite recursion
2. **previewRenderer plugins:** `NbMain.renderMarkdown(body, selector)` not `marked.parse(body)` → live blocks silently break
3. **Sync push:** `git push origin HEAD:<notebook-name>` not `HEAD:master`; wire needs `branch.master.merge` config
4. **StatusPill:** `?.add(n)` before work, `?.tick()` in success AND error paths; spread NodeList to `[...]` first
5. **Template schema:** change generator functions AND seeded templates together — one without the other breaks notes
6. **nb subprocess stdin:** `input=''` not `input=None` in `run_nb()` — prevents Flask hangs on interactive prompts
7. **`renderPreview` must be `async`:** it calls `await NbWeb.loadNotebookConfig(...)`. Making it non-async is a parse-time SyntaxError that kills the entire NbMain IIFE — nothing displays, nothing is clickable. Check `async function renderPreview` before editing near it.
8. **ServiceWorker cache (`sw.js`):** bump `CACHE = 'nb-web-vN'` whenever `main.js`, `nav.js`, `styles.css`, `nbweb.js`, `terminal.js`, `dialog.js`, `drag-handles.js`, `note-actions.js`, `search.js`, `sync.js`, or any plugin file changes. Without a version bump, browsers serve stale cached assets and users see old behaviour. Commit `sw.js` in the same PR as the asset change. **Note:** `app.py`'s `/sw.js` route (`serve_sw()`) already rewrites `CACHE` to the current git short hash at serve time on every request, so this is belt-and-suspenders rather than strictly load-bearing — the manual bump is still good practice (keeps the repo file's literal readable/meaningful, and covers any deployment that serves `sw.js` as a static file instead of through this route), but don't panic if you forget it.
9. **`api_note` GET/PUT symmetry:** special-case selectors (e.g. `.nb:.nb.md`) handled in `api_note` (GET) must also be handled in `api_edit_note` (PUT) — omitting it causes silent save failure ("unknown error") since the PUT falls through to `run_nb show` which doesn't know the selector.

## nb notebook layout

`~/.nb/` — one subdirectory per notebook, each its own git repo. Key notebooks: `home`, `docs`, `claude`, `accts`, `contacts`, `pfinds`, `Takeout`, `hledger`, `tw`, `tasks`, `work`, `friends`, `exp`, `bkmk`, `openfilmmaker`, `preciousfinds.ca`, `tutorial`, `nb`.

Hidden files at `~/.nb/` root: `.users`, `.tools`, `.changes`, `.images`, `.rules`, `.lib` — global stubs (not indexed by nb).

## Plugin architecture

`NbWeb.registerModule(id, { detect, label, codeblockRenderers, previewRenderer, listButtons, notebookSection, listDefaults, sortOptions, navButtons })` — IIFE pattern, loaded from plugin list in `nb-settings.json`. Core plugins in `plugins/`; external in `~/dev/nbweb-*/`.

**`codeblockRenderers` entry shape:**
```javascript
{
    lang:      'tw',                    // fenced language tag AND fm frontmatter key
    html:      text => '<div ...>',     // synchronous; emits skeleton div with spinner
    renderOne: async el => loader(el),  // per-block lazy loader — REQUIRED for FM lazy loading
    render:    async container => { … } // batch renderer for body codeblocks
}
```
`renderOne` is called by `_buildFmBlocks` on first expand of a collapsed FM block. Without it the block falls to the eager path (`render(wrap)` called immediately). `html()` + `renderOne()` is the contract for FM participation; `render()` handles body blocks and the eager fallback.

**`_FM_BLOCK_KEYS`** (`app.py`) — frozenset of lang IDs (and companion config keys) that participate in FM-mode and propagate via `effective_fm`: `{'nav', 'toc', 'toc_min', 'fm', 'tw', 'hl', 'git', 'gallery', 'cfg', 't', 'nb', 'tabs'}`. When a notebook or folder config declares one of these keys, the note API response includes `effective_fm: {key: value}` for any key not already set in the note's own frontmatter. `_buildFmBlocks` merges `effective_fm` into the source before building the FM strip. Add a new lang to this set whenever a renderer should support config-chain propagation.

**Codeblock lang IDs (current):** `tw`, `nb`, `git`, `hl` (accounting), `fm` (frontmatter filter), `cfg` (config tree), `nav`, `gallery`, `t`, `toc`, `test`, `chart`, `cine`. The `hl`/`fm`/`cfg` abbreviations match their barblock badge labels — the former long names (`hledger`, `front`, `config`) are retired.

**`.lib/` block extras** — `~/.nb/.lib/` scripts extend barblocks at runtime:
- `help-block-{lang}-{access}.md` → `?` button on that lang's header
- `open-block-{lang}-{access}.sh` → title-click + `⎋` button routed through `_execLibOpen`

Script stdout is parsed by `_dispatchLibOpen(out)` — one line, one action:
```
nb:<selector>   → NbMain.openNote()     file:<path>  → NbMain.openNote()
term:<cmd>      → NbTerminal.run()      https://…    → window.open()
```
Title-click is lib-first: if `_blockExtras.open[lang]` exists, lib wins; otherwise falls back to the block's hardcoded default. `_blockExtras` is fetched once at plugin load from `/api/lib/block-extras`.

### Renderer registry

Flat registry populated at load time by `registerRenderer(id, spec)`. `registerModule()` auto-populates it from `previewRenderers[]` and the single `previewRenderer` + `previewTypes` shorthand.

**Registry shape** (`id → spec`):
```
{ id, label, icon, types, detect, render, pluginName }
  types:   string[] — note type values this renderer handles; null for detect-only renderers
  detect:  note → bool — runtime predicate kept for backward compat; not used by getRenderers()
```

**Declaring types** — add `types: ['shot']` to a renderer spec, or `previewTypes: ['contact']` on the module spec (for single-renderer modules). This makes the type association statically queryable without running `detect()`.

**API (`NbWeb.*`):**

| Function | Description |
|----------|-------------|
| `registerRenderer(id, spec)` | Explicit registration; duplicate IDs silently skipped |
| `getRenderers(type?)` | All renderers, or filtered by `types[]` — detect-only (types:null) excluded from typed queries |
| `getRendererTypes()` | Sorted list of all type strings declared across all renderers |
| `loadNotebookConfig(notebook)` | Async: fetch + cache per-notebook config from `.notebook` frontmatter |
| `bustNotebookConfigCache(notebook)` | Delete notebook from cache — call after saving Types config |
| `getPreviewRenderers(notebook, note)` | Active module's renderers filtered by `detect()`; preferred renderer promoted to first |

**Notebook config cache** — `_notebookTypeConfigs: Map<notebook, meta>`. Primed by `await NbWeb.loadNotebookConfig()` once per render; cache hit is synchronous. Bust with `bustNotebookConfigCache()` after any Types save. On fetch failure, caches `{}` (silent fallback).

**`getPreviewRenderers` promotion** — if the notebook's `types[note.type].renderer` preference is set, that renderer is moved to index 0 (becomes the toggle default) without removing the others. The user can still switch per-session via toolbar toggle.

### Configure Notebook — Types tab

Located in the Notebooks panel (Configure Notebook dialog), "Type renderers & access" tab.

**Data flow:**
1. Panel open → `GET /api/nb/notebook-config?notebook=<name>` → `d.meta.types`
2. `_renderTypesTable(typeCfg)` — calls `NbWeb.getRendererTypes()` for the row list; `NbWeb.getRenderers(type)` for each type's renderer dropdown
3. Save → read existing `.notebook` content → `_mergeTypesIntoConfig(content, typesObj)` → `PUT /api/nb/notebook-config` → `NbWeb.bustNotebookConfigCache(name)`

**YAML round-trip** (`_mergeTypesIntoConfig`): strips existing `types:` block (by indentation), appends new `types:` block, preserves all other frontmatter. Result is written to `.notebook` config file.

**Config YAML format** (written to `.notebook` frontmatter):
```yaml
types:
  shot:
    renderer: cine-shot-card
    access: user
  scene:
    renderer: cine-screenplay
```

Access levels: `guest` / `user` / `office` / `admin` / empty (inherit notebook default).

FM types recognised by `app.py` (`_FM_TYPES`): `strip`, `shot`, `scene`, `storyline`, `plotline`, `story`, `milestone`, `actor`, `location`, `character` (cine); add new types here + `INDICATORS` dict.

## NbWeb-cine plugin

Plugin: `~/dev/nbweb-cine/nbweb-cine.js`. Activated when notebook has `.nb-cine.json`.

**Three-identifier scheme** — every production note type carries:
- `filename stem` — stable wikilink anchor, never changes
- `alias:` — compact display code (stripboard cell, list label)
- `title:` — human-readable name (tooltip, full display)

Display order: `alias → title → filename`. List title format: `alias — title` (shots: `scene.alias — title`). Linking: always `[[filename-stem]]`, never `[[alias]]`.

**Folder layout:**

| Folder | Type | `alias:` meaning |
|--------|------|-----------------|
| `script/` | `scene` | scene number (`2`) |
| `shots/` | `shot` | shot code (`4f`) |
| `characters/` | `character` | actor filename stem (`jim_dandy`) — the casting link |
| `cast/` | `actor` | callsheet code (`JD`) |
| `locations/` | `location` | location code (`LG`) |

**CHARACTER/actor resolution chain:**
```
shot cast.actors: BILL
  → characters/BILL.md  alias: jim_dandy  title: Bill — Head Waiter
    → cast/jim_dandy.md  alias: JD  title: Jim Dandy
```
Shots list CHARACTER codes (ALLCAPS filename stems). Recasting = change `alias:` on one character file. Zero shot files touched.

**`api_cine_data` response shape:**
- `shots` — list, sorted by day+seq
- `characters` — dict keyed by stem (`BILL`, `AMY`…)
- `cast` — dict keyed by stem (`jim_dandy`, `alice_ming`…)
- `locations` — dict keyed by `alias:` field (`LG`, `AL`…)
- `scenes`, `lanes`, `stories`, `orphan_scenes`, `config`

**`_scan_dir(subdir, code_field=None)`** — `code_field=None` keys by filename stem; otherwise by that frontmatter field.

**Scene detection:** `type: scene` only — `scene_no:` field removed (was redundant with `alias:`).

**Ctrl+[** in scene editor: dialog → `[[filename]]` inserted → scene saved → shot created → shot opened. Shot inherits scene meta (`loc`, `day_night`, `int_ext`, `scene`).

## Render pipeline (main.js)

Stage 1 `_renderMarkdown`: wikilinks→spans, codeblocks→divs, before marked.
→ `marked.parse()`
→ DOM insert
Stage 2 `_enrichRendered`: wire links, resolve wikilinks, UUID detect, hydrate codeblocks.
→ `_resolveInlineQueries`: {{provider: query}} spans.
→ `_finishRendered` = `_enrichRendered` + `_appendAnnotation` (main note only).

### Inline queries — `{{provider: query}}`

Text spans matching `{{provider: query}}` are replaced with `.nb-inline-query` spans during `_resolveInlineQueries`. Non-`inline` providers (hledger, tw, nb, date) resolve in parallel via `/api/inline-query`.

**Regen button:** when `/api/inline-query` returns a `regen: {notebook, script}` field, the span gets a `↻` button (`.nb-iq-refresh`) appended. On click: POSTs `{notebook, script}` to `/api/hledger/regen` (runs the script, clears hledger cache), then re-fetches the inline query and updates the result in place.

**Wiring regen:** set `"regen_script": ".tools/gen-budget.py"` in the notebook's `.nb-hledger.json`. The `api_inline_query` endpoint reads this and includes `regen` in the response only when both `regen_script` and `notebook` are present. Script must live in `.tools/` and be a `.py` file (enforced by `/api/hledger/regen`).

## Active claude: notes

Key reference: `claude:nb_plugin_development_—_hard-won_patterns.md` (nb plugin dev patterns).
Design doc: `claude:nbweb-hledger_plugin_design.md` (tagged `hledger-design` — do not archive).
ODC status: `claude:odc_nb-web_plan.md`.
