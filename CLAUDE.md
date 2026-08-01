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
| `plugins-page.js` | `NbPluginsPage` singleton — Plugins settings page (NbWeb + nb CLI plugin list/detail, install/uninstall) (extracted from main.js, tier-2e modularization) |
| `notebooks-page.js` | `NbNotebooksPage` singleton — Notebooks settings view (list, sync, lock, config, type renderers, danger zone) (extracted from main.js, tier-2f modularization) |
| `templates.js` | `NbTemplates` singleton — Templates view (list, preview, edit/duplicate/delete) + Add-mode template picker (extracted from main.js, tier-2g modularization) |
| `ui-access.js` | `NbUiAccess` — client-side UI access gating, `can(el, group, mode)`; mirrors the codeblock plugin's `_cbAccess`/`_cbCan` pattern for non-codeblock UI (tier-4a modularization). Loads right after `nav.js`, zero dependencies. |
| `ui-chrome.js` | `NbUiChrome` singleton — panel menus (list/sort dropdowns), extras toggle, preview-toolbar menu + actions (pin, fullscreen, undo, history, save-as-template), multi-select, keyboard navigation (extracted from main.js, tier-4 modularization) |
| `styles.css` | All styling — no preprocessor |
| `nb-settings.json` | Runtime config — default_git_remote, git_repos aliases, plugin list |
| `plugins/` | Core plugins (nbweb-codeblocks, nbweb-contacts, nbweb-archive, nbweb-quartz) |

External plugins live in `~/dev/nbweb-*/` and are wired via `nb-settings.json`.

## Docs

- **User docs:** `~/.nb/docs/` — all files have `processed: true` frontmatter; open in nb-web
- **Dev docs:** `~/.nb/docs/dev/` — 11 files; index at `docs:DEVELOPERS.md`
- **AI meta-index:** `~/.claude/projects/-home-djp/memory/reference_nb_web_index.md` — "where is X?" for any topic

**Research order for "is X built / current / true" questions:** this file is a fast entry point and a place for hard-won invariants (see below) — it is not the source of truth for status claims. For those, check `docs:dev/` and cross-reference related `claude:` notes before trusting any single one, including this file. Confirmed live 2026-07-13: two `claude:` design notes disagreed about whether a feature already existed, and the wrong one was trusted first — the fix isn't reading this file less, it's never treating one document's claim as settled without checking its neighbors.

## Testing

The test suite lives in a **separate sibling repo**, not inside this one: `~/dev/nb-web-tests/`, path-pinned to this repo via `sys.path.insert` in its `conftest.py`. Don't go looking for `tests/` in here — it doesn't exist in `nb-web` itself.

| Layer | Location | Run |
|-------|----------|-----|
| pytest (backend logic, synthetic fixtures) | `~/dev/nb-web-tests/*.py` | `cd ~/dev/nb-web-tests && python3 -m pytest -q` |
| Playwright e2e (real browser, real `/login` form) | `~/dev/nb-web-tests/e2e/tests/*.spec.js` | `cd ~/dev/nb-web-tests/e2e && npx playwright test` |
| Pre-flight lint (cross-module reference/order check) | `.tools/check-module-refs.py` (in this repo) | `python3 .tools/check-module-refs.py` |

Run all three before considering any `main.js`-adjacent change (new satellite extraction, kernel accessor change, `index.html` script-order edit) done. Full strategy doc: `docs:dev/dev-test-suite.md`. Status/history: `reference_nb_web_index.md` in memory, or grep `claude:` notebook for `nb-web-tests`.

**Found a bug? Write the failing test first — before the fix, not afterwards.** A one-off `python3 -c` snippet importing `app.py` to confirm a bug is real and confirm the fix worked is not the same thing and doesn't replace it — it verifies the moment, then evaporates; the codebase's actual regression coverage doesn't grow and the same bug class can recur silently. Add the case to `~/dev/nb-web-tests/`, watch it fail (red), then patch, then watch it pass (green). This applies even under time pressure mid-task — a pattern already established and confirmed working: design-check before fixing, red test before patch, always in that order.

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
8. **ServiceWorker cache (`sw.js`):** bump `CACHE = 'nb-web-vN'` whenever `main.js`, `nav.js`, `styles.css`, `nbweb.js`, `terminal.js`, `dialog.js`, `drag-handles.js`, `note-actions.js`, `search.js`, `sync.js`, `plugins-page.js`, `notebooks-page.js`, `templates.js`, `ui-access.js`, `ui-chrome.js`, `settings.html`, or any plugin file changes. Without a version bump, browsers serve stale cached assets and users see old behaviour. Commit `sw.js` in the same PR as the asset change. **Note:** `app.py`'s `/sw.js` route (`serve_sw()`) already rewrites `CACHE` to the current git short hash at serve time on every request, so this is belt-and-suspenders rather than strictly load-bearing — the manual bump is still good practice (keeps the repo file's literal readable/meaningful, and covers any deployment that serves `sw.js` as a static file instead of through this route), but don't panic if you forget it.
9. **`api_note` GET/PUT symmetry:** special-case selectors (e.g. `.nb:.nb.md`) handled in `api_note` (GET) must also be handled in `api_edit_note` (PUT) — omitting it causes silent save failure ("unknown error") since the PUT falls through to `run_nb show` which doesn't know the selector.
10. **`renderPreview`'s type-dispatch branches must include `_checkHtml`:** every branch that builds `html = ...` and falls through to the shared `content.innerHTML = ...; _finishRendered(...)` convergence point must splice in `_checkHtml +` at that assignment (see the existing image/audio/video/`_pluginHtml !== null`/bookmark/todo/fallback branches for the pattern). `_checkHtml` is computed once near the top of `renderPreview`, right after `_pluginHtml` is resolved — omitting it from a new branch silently drops `check:`/`check_add:` FM output for that note type with no error, exactly the bug fixed 2026-07-07 (see `claude:mainjs-check-cascade-fix.md`). Branches that legitimately don't need it (pdf, code/timedot, html, ebook/document, archive, sheet, encrypted, and the large-note `/api/render` path) `return` early before the convergence point and are exempt by construction.
11. **`settings.html`'s `data-min-level`-gated sections each need their own independent `document.addEventListener('nb-auth-ready', ...)` block** — don't nest a new section's gate check inside an existing section's listener. `sec-config-repo`'s block does `if (!NbAuth.is('admin')) return;` near the top; nesting a `tech`-gated section's code after that line works today only because `tech` implies `admin` in `LEVELS` — it would silently never run if that early return's level or position ever changed. Independent listeners (see `sec-repos`, added 2026-07-08) avoid the coupling entirely.
12. **`serve_sw()`'s cache-busting only covers this repo's own git hash — external plugin repos are invisible to it.** `nbweb-claude.js`/`nbweb-cine.js`/`nbweb-hledger.js` in `plugins/` are symlinks into separate standalone repos (`~/dev/nbweb-*`); a commit in one of those repos doesn't move `nb-web`'s own git hash, so the service worker keeps serving the old cached file even after a server restart. Confirmed twice, real debugging time lost both times (2026-07-10). A change to one of these files needs a manual hard-refresh in the browser, not just a restart — bumping this repo's `sw.js` `CACHE` string doesn't help either, since `serve_sw()` overwrites it with the git hash at serve time (invariant 8).
13. **A new endpoint must name its notebook via `notebook=` or `selector=` (query/form/JSON) — nothing else.** `_notebook_scope_check()` (`_check_auth`, `app.py`) is the single gate enforcing a user account's `notebooks:` access-scope restriction, and it only recognizes those two key names. It was made a single centralized chokepoint specifically because every existing call site (116, grepped, not assumed) already follows this convention with no URL-path-embedded notebook names anywhere — but that means a *future* endpoint that reads a notebook name some other way (a new path parameter, a differently-named key) silently bypasses scope enforcement with no error, no warning, nothing. If you add an endpoint that resolves a notebook any way other than `notebook=`/`selector=`, you must extend `_notebook_scope_check()` accordingly, not just trust the existing gate to already cover it.
14. **This app now has two live deployment modes that must both keep working: bare `python3 app.py` (dev, real `$HOME`) and a Podman container via `systemctl --user` (production, `HOME=/home/nbweb` — see `feature/phase2-docker-permissions`, `Containerfile`).** Any code assuming `Path.home()` resolves to djp's actual home breaks silently in the container specifically (wrong home; `is_relative_to()`-style checks reject it) while looking completely fine bare-metal. Confirmed repeatedly, 2026-07-18/19: hledger journal includes and `.taskrc` (fixed at the data layer — see `.rules/hledger.md` — always `~`-rooted, never `/home/<user>/...`), `/api/restart`'s `os.execv` self-re-exec (correct for bare-metal, crashes a gunicorn worker outright — `sys.argv` under gunicorn is gunicorn's own; detect via `SERVER_SOFTWARE` and send `SIGHUP` to the arbiter instead), and `plugins/{nbweb-cine,nbweb-claude,nbweb-hledger}.js` (committed as symlinks to sibling `~/dev/nbweb-*` repos for bare-metal dev — must stay **relative**, not absolute: an absolute host symlink target doesn't exist inside `nbweb`'s container home. **In the built image these three are no longer symlinks at all** — as of 2026-08-01 the Containerfile clones each from its own public GitHub repo at build time and copies the real `.js` file in, the same pattern already used for the `nb` CLI and `hledger` binary, replacing the earlier runtime-`~/dev`-bind-mount-plus-re-link approach. A tenant/beta Machine needs no `~/dev` mount for these three at all now; only djp's own dev workflow still uses the committed dev-checkout symlinks). `nbweb-specialty.js` is no longer in this category — folded into nb-web core 2026-07-19 (subtree merge, real vendored file now, see invariant 12's neighbors and `claude:nb_web.md`'s Phase 2 checklist). Full mount contract + reasoning per entry: `Containerfile`'s own header comment. Narrative: `claude:nb-web_phase2_docker_and_permissions_2026-07-18.md`.
15. **A dotfile field only cascades to every note in that notebook if it's in `/api/note`'s explicit `effective_*` allowlist** (`api_note`, `app.py`: `effective_access`, `effective_claude`, `effective_checks`, `effective_check_add`, `effective_check_skip`, `effective_xref`, `effective_fm`, `effective_ui_hide` — nothing else). Any other dotfile field (`website:`, `tabs:`, `hledger:`, `tag_color:`) is read directly from `_notebook_config()` by whatever server code needs it and never reaches a note's cascade. Confirmed the hard way 2026-07-17: `check_add: [nb-sweep-]` was added to three notebook dotfiles intending a single ambient dashboard notification, but `check_add:` *is* on the allowlist (`effective_check_add`) — it silently broadcast onto every single note in those notebooks instead. Before adding a new dotfile field expecting it to (or not to) show up per-note, check this allowlist; don't assume from where in the file it's placed.
16. **`codeblock_access` lives in `~/.nb/.nb.md`'s frontmatter (via `_effective_setting`/`_global_config`), never in `nb-settings.json`/`_SETTINGS_SCHEMA`** — despite `GET /api/nb-settings` now also returning it (fixed 2026-07-21, merged in read-only so the frontend `_cbAccess` gate has real data; a `PATCH` naming the key still 400s as unknown). **And the `read:` side has no backend enforcement at all** — only `_cb_write_allowed()` exists; there is no `_cb_read_allowed()`. For any block type with a `read:` level and no independent per-endpoint check of its own (confirmed for `hl`, `chart`, `t`, `tw`, `git`, `check`, `fm` as of 2026-07-21 — `cfg` has *a* check, but it's the target notebook's own `access:` level, not `codeblock_access.cfg.read`), the configured floor is currently advisory only: any authenticated session, any level, can hit the underlying endpoint directly and get real data. `sysadmin` and `nb`/`nav` are the exceptions (own explicit backend checks). Full audit + fix plan: `claude:codeblock_access_backend_read_enforcement_plan_2026-07-21.md`. Don't add a new gated block type assuming `read:` is actually enforced anywhere but the UI.
17. **A new mutating/destructive endpoint needs both a `_level_gte` floor AND a `_can_access(user, {}, _notebook_config(notebook))` destination check — neither substitutes for the other, and the default assumption for any endpoint not yet audited should be that it's missing both.** Confirmed as a recurring shape, not a one-off: eight endpoints (`import`, `archive`, `wire-notebook`, `delete-notebook`, `git-wire`, `github-create`, `website-publish`, `/api/check/run`) were all found missing this over two audit passes (2026-07-28/29, 2026-08-01) — every one compiled, passed existing tests, and worked fine for its one real caller (djp); the gap only ever surfaced under deliberate audit. `_notebook_scope_check()` (invariant 13) does not substitute for either half: it only checks `notebooks:` account-scope membership, has no concept of a note/notebook's own `access:` field, and for an endpoint with no `notebook`/`selector` request key at all (`git-wire`, which sweeps every notebook on the instance) it never runs at all — that one's fix is a per-notebook `_can_access` filter *inside* the sweep, not a single up-front check. Floor precedent: `'user'` for routine content work on your own notebook (`archive`, `import`), `'admin'` for anything that creates/deletes/repoints a real external resource or uses forwarded credentials (`gh`, git push). `website-publish` also had no `_check_notebook()` call at all — a missing level gate and a missing name-validation call are two different bugs that can co-occur; see invariant on server-side path reads in `.rules/access.md`. Full case study: `claude:nb-web_isolation_hardening_design.md`.
18. **`nb`'s own one-time first-run welcome banner can be captured as data by `run_nb()`, the same failure shape as the `$EDITOR`/`NB_AUTO_SYNC` gotchas above, just a different trigger.** Confirmed live 2026-08-01 provisioning a genuinely fresh `~/.nb` from zero (a Fly Machine dry run, not djp's own long-lived instance): `app.py`'s very first `run_nb('notebooks', ...)` call against the empty volume returned `nb`'s decorative ASCII welcome banner + help text instead of a clean names list — `run_nb()` doesn't distinguish "real output" from "nb's own onboarding text," so it got parsed as data (`/api/notebooks` returned garbage). The banner only prints once; a direct SSH invocation of the identical command immediately after returned clean output, because `nb` had already "seen" this `~/.nb` from the app's own (corrupted) first call. Self-heals after one call, so it's easy to miss in ad hoc testing — but a real from-zero provisioning flow (seed notebooks → first request) will hit this on literally every new tenant's first page load, not just once ever like this dry run did. Not fixed yet — candidate fix is burning the banner deterministically at container startup (a throwaway `nb` invocation in an entrypoint/startup hook), same pattern as the `NB_AUTO_SYNC` `ENV` fix, rather than leaving it to whatever real request happens to be first. Full narrative: `claude:nb-web_fly_machine_dry_run_2026-08-01.md`.

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

Plugin: `~/dev/nbweb-cine/nbweb-cine.js`. Activated by a `cine:` block in the
notebook's own `.{notebook}.md` dotfile (see `Takeout`'s config for a live
example) — same mechanism as hledger below. A standalone `.nb-cine.json` file
is still honored and takes precedence if one exists (legacy path,
`_notebook_config()`/the notebooks-inventory endpoint check it first), but as
of 2026-07-10 no notebook actually uses it — every notebook with cine active
is on the FM path.

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

**Wiring regen:** set `regen_script: .tools/gen-budget.py` under the `hledger:` block in the notebook's own `.{notebook}.md` dotfile (see `djp`'s config for a live example) — or, legacy path, `"regen_script": ".tools/gen-budget.py"` in a standalone `.nb-hledger.json`, which still takes precedence if present (`_hledger_config_for_notebook()` in `app.py`). The `api_inline_query` endpoint reads this and includes `regen` in the response only when both `regen_script` and `notebook` are present. Script must live in `.tools/` and be a `.py` file (enforced by `/api/hledger/regen`).

## Active claude: notes

Key reference: `claude:nb_plugin_development_—_hard-won_patterns.md` (nb plugin dev patterns).
Design doc: `claude:nbweb-hledger_plugin_design.md` (tagged `hledger-design` — do not archive).
Design doc: `claude:nbweb-claude — Plugin Design v2 (two-market rewrite, 2026-07-09)` (kept current; see its 2026-07-10 addendum). Architecture reference: `docs:dev/dev-claude-integration.md`.
ODC status: `claude:odc_nb-web_plan.md`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
