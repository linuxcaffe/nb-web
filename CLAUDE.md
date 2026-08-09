# nb-web — CLAUDE.md

Quick orientation for Claude Code sessions in this repo.

## Are we actually working on nb-web? Check the session's real root.

If this session was started somewhere else (e.g. `~/.nb`) and just `cd`'d into `~/dev/nb-web`
via a tool call, **this repo's project-level `.claude/settings.json` hooks will not load** —
`cd` inside a Bash call doesn't change what Claude Code considers the project root; that's
fixed at session start. Confirmed live 2026-08-07: nb-web's `graphify` `PreToolUse` hook
(`graphify hook-guard`) sat silently unregistered for a month because of exactly this, not
because of workspace trust or `--dangerously-skip-permissions` (both ruled out first — see the
graphify section below for the full dead-end chain). If nb-web-specific tooling matters for the
work at hand, ask: **are we working on nb-web, and should this session be restarted rooted at
`~/dev/nb-web` instead?** — don't assume `cd` was enough.

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
14. **This app now has two live deployment modes that must both keep working: bare `python3 app.py` (dev, real `$HOME`) and a Podman container via `systemctl --user` (production, `HOME=/home/nbweb` — see `feature/phase2-docker-permissions`, `Containerfile`).** Any code assuming `Path.home()` resolves to djp's actual home breaks silently in the container specifically (wrong home; `is_relative_to()`-style checks reject it) while looking completely fine bare-metal. Confirmed repeatedly, 2026-07-18/19: hledger journal includes and `.taskrc` (fixed at the data layer — see `.rules/hledger.md` — always `~`-rooted, never `/home/<user>/...`), `/api/restart`'s `os.execv` self-re-exec (correct for bare-metal, crashes a gunicorn worker outright — `sys.argv` under gunicorn is gunicorn's own; detect via `SERVER_SOFTWARE` and send `SIGHUP` to the arbiter instead), and `plugins/{nbweb-cine,nbweb-claude,nbweb-hledger}.js` (committed as symlinks to sibling `~/dev/nbweb-*` repos for bare-metal dev — must stay **relative**, not absolute: an absolute host symlink target doesn't exist inside `nbweb`'s container home. **In the built image these three are no longer symlinks at all** — as of 2026-08-01 the Containerfile clones each from its own public GitHub repo at build time and copies the real `.js` file in, the same pattern already used for the `nb` CLI and `hledger` binary, replacing the earlier runtime-`~/dev`-bind-mount-plus-re-link approach. A tenant/beta Machine needs no `~/dev` mount for these three at all now; only djp's own dev workflow still uses the committed dev-checkout symlinks). `nbweb-specialty.js` is no longer in this category — folded into nb-web core 2026-07-19 (subtree merge, real vendored file now, see invariant 12's neighbors and `claude:nb_web.md`'s Phase 2 checklist). Full mount contract + reasoning per entry: `Containerfile`'s own header comment. Narrative: `claude:nb-web_phase2_docker_and_permissions_2026-07-18.md`. **This got violated for real, 2026-08-06**, despite being documented right here: a session re-symlinked `plugins/nbweb-specialty.js` to a sibling `~/dev/nbweb-specialty` checkout, reasoning from the cine/claude/hledger *pattern* rather than reading this invariant or the Containerfile's own comment above the git-clone `RUN` step. `podman build`'s `COPY . .` copies a symlink whose target is outside the build context as a dangling link — no build error, no warning — so it shipped clean and broke every specialty-header note type (project, report, dashboard, dotfile) the moment the container actually got rebuilt. Reverted; the GitHub repo was un-archived then re-archived in the process (it's meant to stay archived — that's not an oversight either). `sys-container-broken-symlinks` (`.checks/`) now catches this specific failure shape automatically, but the deeper lesson stands: check *this file* for a plugin's real status before assuming a sibling-repo pattern generalizes to it.
15. **A dotfile field only cascades to every note in that notebook if it's in `/api/note`'s explicit `effective_*` allowlist** (`api_note`, `app.py`: `effective_access`, `effective_claude`, `effective_checks`, `effective_check_add`, `effective_check_skip`, `effective_cfg_attr_add`, `effective_cfg_attr_skip`, `effective_xref`, `effective_fm`, `effective_ui_hide`, `effective_help` — nothing else). Any other dotfile field (`website:`, `tabs:`, `hledger:`, `tag_color:`) is read directly from `_notebook_config()` by whatever server code needs it and never reaches a note's cascade. Confirmed the hard way 2026-07-17: `check_add: [nb-sweep-]` was added to three notebook dotfiles intending a single ambient dashboard notification, but `check_add:` *is* on the allowlist (`effective_check_add`) — it silently broadcast onto every single note in those notebooks instead. Before adding a new dotfile field expecting it to (or not to) show up per-note, check this allowlist; don't assume from where in the file it's placed. `effective_help` (`_effective_help()`, added 2026-08-08 for the "Help Everywhere" plan, `claude:nb-web_help-system_design.md`) drives `#nb-help-btn`, the always-visible far-right button in `#nb-preview-actions` — moved there from `nbweb-specialty.js`'s specialty-header-only button the same day, so every note type gets a help popover now, not just project/report/dashboard/dotfile.
16. **`codeblock_access` lives in `~/.nb/.nb.md`'s frontmatter (via `_effective_setting`/`_global_config`), never in `nb-settings.json`/`_SETTINGS_SCHEMA`** — despite `GET /api/nb-settings` now also returning it (fixed 2026-07-21, merged in read-only so the frontend `_cbAccess` gate has real data; a `PATCH` naming the key still 400s as unknown). **And the `read:` side has no backend enforcement at all** — only `_cb_write_allowed()` exists; there is no `_cb_read_allowed()`. For any block type with a `read:` level and no independent per-endpoint check of its own (confirmed for `hl`, `chart`, `t`, `tw`, `git`, `check`, `fm` as of 2026-07-21 — `cfg` has *a* check, but it's the target notebook's own `access:` level, not `codeblock_access.cfg.read`), the configured floor is currently advisory only: any authenticated session, any level, can hit the underlying endpoint directly and get real data. `sysadmin` and `nb`/`nav` are the exceptions (own explicit backend checks). Full audit + fix plan: `claude:codeblock_access_backend_read_enforcement_plan_2026-07-21.md`. Don't add a new gated block type assuming `read:` is actually enforced anywhere but the UI.
17. **A new mutating/destructive endpoint needs both a `_level_gte` floor AND a `_can_access(user, {}, _notebook_config(notebook))` destination check — neither substitutes for the other, and the default assumption for any endpoint not yet audited should be that it's missing both.** Confirmed as a recurring shape, not a one-off: eight endpoints (`import`, `archive`, `wire-notebook`, `delete-notebook`, `git-wire`, `github-create`, `website-publish`, `/api/check/run`) were all found missing this over two audit passes (2026-07-28/29, 2026-08-01) — every one compiled, passed existing tests, and worked fine for its one real caller (djp); the gap only ever surfaced under deliberate audit. `_notebook_scope_check()` (invariant 13) does not substitute for either half: it only checks `notebooks:` account-scope membership, has no concept of a note/notebook's own `access:` field, and for an endpoint with no `notebook`/`selector` request key at all (`git-wire`, which sweeps every notebook on the instance) it never runs at all — that one's fix is a per-notebook `_can_access` filter *inside* the sweep, not a single up-front check. Floor precedent: `'user'` for routine content work on your own notebook (`archive`, `import`), `'admin'` for anything that creates/deletes/repoints a real external resource or uses forwarded credentials (`gh`, git push). `website-publish` also had no `_check_notebook()` call at all — a missing level gate and a missing name-validation call are two different bugs that can co-occur; see invariant on server-side path reads in `.rules/access.md`. Full case study: `claude:nb-web_isolation_hardening_design.md`.
18. **`nb notebooks --names` ignores `--names` and falls back to the full interactive splash the very first time it's asked to list notebooks when zero exist — and auto-creates a `home` notebook as a side effect, which is what un-sticks every call after.** Confirmed live 2026-08-01 provisioning a genuinely fresh `~/.nb` from zero (a Fly Machine dry run, not djp's own long-lived instance), then reproduced deterministically in an isolated scratch dir (two calls back to back: first returns the ASCII splash + creates `home`, second returns clean `home`). Originally mis-diagnosed in this same invariant as a generic "first-invocation-of-nb-ever" onboarding banner (same failure shape as the `$EDITOR`/`NB_AUTO_SYNC` gotchas above) — that theory was wrong, corrected after actually reading `nb`'s source instead of pattern-matching; the real trigger is specifically "zero notebooks exist," not "first invocation." `run_nb()` doesn't distinguish this splash from real output, so `app.py`'s very first `run_nb('notebooks', ...)` call against an empty volume gets parsed as data (`/api/notebooks` returns garbage). Lower-risk than it first looked: the state that fixes it (`home` actually existing) lives on the writable `~/.nb` mount, not the container's `--read-only` root filesystem, so it doesn't hit the same silent-failure trap that bit `NB_AUTO_SYNC`. **djp's call, 2026-08-01: the auto-created `home` notebook is acceptable/native, not a bug to route around** — burn this once at startup (a throwaway `nb notebooks --names --unarchived --global` call, gunicorn `on_starting` hook, same location as the `NB_AUTO_SYNC` fix) and let `home` get created; population (a short welcome note, not a heavy onboarding flow) is separate, deferred work — see `claude:nb-web_help-system_design.md`'s "`demo:` — third starter notebook" section for the fuller starter-notebook design this feeds into (`docs:` = locked reference, `demo:` = breakable scratchpad, `home` = light welcome text only). Full narrative: `claude:nb-web_fly_machine_dry_run_2026-08-01.md`.
19. **`svg.className = 'foo'` silently does nothing — SVG elements' `className` is an `SVGAnimatedString` object, not a plain string property, so assigning a string to it neither throws nor sets the class.** Use `svg.setAttribute('class', 'foo')` instead (works on any element, SVG or HTML). Confirmed 2026-08-02 building `cine org` (`nbweb-cine.js`, modeled on `cfg org`'s technique): copied `svg.className = 'nb-config-org-svg';` verbatim from `_configOrgRender` (`nbweb-codeblocks.js:2943`) — the class silently never applied there either, it's just that nothing in `.nb-config-org-*`'s own CSS actually depends on that specific class being present on the `<svg>` itself (only on child `<g>`/`<rect>` elements, which *are* set via `setAttribute('class', ...)` correctly), so the bug had sat live and unnoticed in core. Fixed there too, same day. Any new SVG-building code should use `setAttribute('class', ...)` from the start, not `.className =`.
20. **The check codeblock (`plugins/nbweb-codeblocks.js`) does not participate in `NbWeb.renderCodeblocks`'s shared serial loop at all** — its `lang` entry has no `render:` key by design (as of 2026-08-02). It runs strictly last, deferred via `_deferCheckBlocks` (`main.js`, called from `_fetchContainer`), which waits on `_StatusPill.whenIdle()` + a bounded structural retry (5×150ms) before firing `NbWeb.renderCheckBlocks`. This exists specifically so one slow/broken check pass (up to 8 ambient glob families, batched) can't block every other plugin's codeblocks on the same note behind it — confirmed live: it used to add 25-30s to *every* note's first paint. **Corollary, easy to break by "cleanup": `_maybeCaptureRenderCache`'s post-check capture attempt (`main.js`) must keep its own bounded retry, not a single attempt** — check's own rendered *output* can itself contain further-async nested widgets (e.g. an interactive hledger "add a receipt" nudge embedded in a failing check's result card), so the very instant `renderCheckBlocks` resolves is not guaranteed to be the instant everything visible has actually settled. Found live 2026-08-02: a one-shot capture attempt silently and permanently disabled the render-cache for any `cache: true` note whose checks happened to render one of these nested widgets. Also load-bearing: the check codeblock's `html:` placeholder must keep its `<span class="nb-spin">⟳</span>` — both the structural "still mid-flight" guards above *and* the ghost-spinner CSS suppression (`.nb-test-block:has(.nb-spin){display:none}`, `styles.css`) key off that exact class being present while pending.
21. **Merging/pushing to `main` puts nothing on the real container (`localhost:5001`) — a `nb-web-launch.sh` restart, `--clean` or otherwise, reuses whatever image is already built; only `.tools/rebuild-container.sh` picks up new commits.** `nb-web-launch.sh` now warns — and interactively offers a one-keypress rebuild (`_warn_if_stale`, default yes, falls back to a passive message when there's no TTY) — whenever the running container's baked-in `nb_web_commit` label doesn't match local HEAD, closing a gap that bit twice already (`.checks/sys-container-stale.sh`'s own header has the first incident; the 2026-08-02 check-notification redesign's own deploy was the second, `claude:check-notification-redesign_2026-08-02.md`'s epilogue has the full story). **`_warn_if_stale` is guarded to run at most once per script invocation** (`_STALE_CHECK_DONE`) — it's called from two places (`--clean`'s own pre-restart check, and the "start if not already running" fallback later in the script), and hitting both in one `--clean` run lands the second check in the narrow window between the container being stopped and the unit's `ExecStopPost` actually removing it, which produces an unreliable `podman inspect nb-web` read and can re-prompt for a rebuild that just completed. Don't remove the guard assuming "it's just a read, calling it twice is harmless" — confirmed live, it isn't. **Nothing prompts for a rebuild outside of actually running `nb-web-launch.sh`** — an ordinary note save through the app is a completely silent, no-signal event as far as staleness detection goes, even when that save's own server-side code path (see invariant 22) only exists in a newer image than what's currently running. Confirmed live 2026-08-03: djp edited `.cine-org.md` expecting the new auto-regen-on-save hook to fire; nothing happened, no error, no hint — the running container simply predated the commit that added the hook at all.

22. **`/api/regen` (generalized 2026-08-03 from the hledger-only `/api/hledger/regen`) is the one place to run a `.tools/*.py` script that regenerates a derived artifact — reach for it instead of a bespoke endpoint.** Gate is real notebook write access (`_level_gte(..., 'user')` + `_can_access`), not a plugin's own `codeblock_access`; `script` must resolve to a real `.tools/*.py` file (path-traversal-guarded on both `notebook` and `script`); optional `args` list passes through to the script as real argv, not a shell string. `api_edit_note` auto-calls it (via `_maybe_auto_regen_org_source`) whenever the saved note's filename matches `.{name}-org.md` — keyed off the filename pattern itself, no opt-in FM flag needed. **This auto-hook only fires for saves through this endpoint (the app's own edit UI)** — `nb edit`/CLI edits/direct file writes bypass it entirely, same limitation the pre-existing timedot auto-sync (`rate:`/`timedot_file:`) already has. A plugin adding its own `.{name}-suffix.md` auto-regen convention should call `_run_regen_script` directly rather than duplicating `/api/regen`'s own validation.

23. **A note's numeric `id` (`notebook:id`, e.g. `Takeout:5`) is not unique within a notebook — it's the note's 1-based position in *whichever folder's own* `.index` file it lives in** (`note_id = idx.index(fname) + 1` against `read_index(notebook, folder_rel)`, `api_note`/`api_notes` in `app.py`). A root-level note and a note three folders deep can both legitimately be "id 5". Two consequences to design around: (1) never build a `notebook:id`-only selector for anything meant to be pasted/stored/linked — always use the path-qualified `notebook:folder(s)/filename.ext` form (`main.js`'s preview-title copy handler used to prefer the id form and was fixed 2026-08-04 for exactly this); (2) when creating a note *inside* a folder, the request's target must carry that folder all the way through (`target = f"{notebook}:{folder}/"` if folder else `f"{notebook}:"`) — the todo branch of `api_create_note` used to build a folder-less target and instead concatenate the folder onto the title text, so a todo added while browsing a subfolder landed at notebook root with the folder name baked into its title (same 2026-08-04 fix; see the note/bookmark/folder branches in the same function for the pattern to follow).

24. **Any `os.walk`-based notebook content scan must exclude dot-prefixed filenames explicitly — `os.walk` does not do this for files the way the existing `dirnames[:] = sorted(d for d in dirnames if not d.startswith('.'))` idiom already does for directories.** `_run_front_query` (`app.py`, backing the `fm` codeblock and `{{fm: count ...}}`) walked every filename unconditionally until 2026-08-04; `.index` and `.<notebook>.md` (or any folder's own `.{folder}.md` config) have no `type:` field, so any filter permissive of a missing field — concretely, negation (`-type:cut`) or no filters at all — silently counted them as real query results. A positive `eq`/`>`/`<` filter happened to mask this by coincidence (dotfiles rarely share a real note's field value), which is exactly why it went unnoticed through Phases 1-3 of the fm query language work and only surfaced once Phase 4's negation made "missing field" a legitimate match. Filter `filenames` the same way `dirnames` already is in any new walk loop over notebook content; don't assume a downstream filter will always exclude bookkeeping files by accident.

25. **Any UI action that mutates a note's frontmatter must bust `_noteCache` (`main.js`) for that selector before re-opening it — the write succeeding is not enough.** `_noteCache` serves cached note data straight from memory for any `cache: true` note (`openNote`, `main.js:713-723`) with zero re-fetch, so `await openNote(selector)` right after a successful write silently re-renders the pre-write copy forever, on every subsequent open, until something else busts the cache (a hard page reload starts a fresh `_noteCache`, which is why this class of bug reads as "works in a fresh tab, broken in the one I'm using"). Found live 2026-08-06: the Lock/Unlock buttons (`renderPreview`'s Lock/Unlock UI section) POSTed to `/api/cine/lock` — which wrote correctly every time, confirmed via git history — then called `openNote(note.selector)` straight away with no cache bust, so the lock badge appeared to "bounce right back" no matter how many times it was clicked, on a note (`type: storyline`'s master track note) that had `cache: true` specifically because its own render is expensive. Seven other note-mutating call sites in the same file already call `_noteCache.delete(note.selector)` (or the exported `NbWeb.bustNoteCache`) before their own re-render — the two lock handlers were the only ones that didn't. Any new mutate-then-reopen code path should follow the same pattern from the start.

26. **`ARG` declarations in the `Containerfile` must sit as late as possible, immediately before the one instruction that actually needs them — never near the top, even if the value (like `GIT_COMMIT`) is conceptually "about the whole build."** The classic builder mixes every `ARG` *in scope* into a layer's cache key, whether or not that layer's own command text references it. `GIT_COMMIT` used to be declared right after `FROM`, invalidating the cache for every layer after it — apt-get/`nb`/`hledger` install (~205MB), `useradd`, git config, ssh config, `pip install`, the import smoke test — on every single rebuild, even though none of those layers' real inputs (`HLEDGER_VERSION`, `requirements.txt`, the commands themselves) had changed. `podman history --no-trunc` is what actually surfaces this (a layer's "CREATED" timestamp matching the current build, for a step that provably didn't need to re-run) — `podman images`/`podman system df`'s own size figures do not. Confirmed live 2026-08-06: real container storage (`podman unshare du -sh ~/.local/share/containers/storage` — **plain `du` without `podman unshare` silently under-reports this by three orders of magnitude**, since rootless Podman's actual layer content lives under a user-namespace-remapped `overlay/` directory a normal `du` gets `Permission denied` on and, if stderr is swallowed, just quietly omits from the total) had grown to ~20GB of genuinely non-deduplicated layer data across a handful of days' rebuilds, on a host that was down to ~5GB free. Fixed by moving `ARG GIT_COMMIT`/`LABEL nb_web_commit` to immediately before `COPY . .`. Any future `ARG` added near the top of this file for convenience should go through the same scrutiny.

27. **The CSS `color-scheme` property (native scrollbars, `<select>` popups, date pickers) is driven by `theme.js`'s `document.documentElement.style.colorScheme = mode`, not by any CSS selector.** `styles.css` still has a `[data-theme="light"] #nb-layout { color-scheme: light; ... }` block from an earlier theming approach — it is *not* what drives real app-wide mode switching: `theme.js`'s `apply()` (the actual multi-theme engine, `~/.nb/.themes/*.md` + `nb-theme-slug`/`nb-theme-mode` in `localStorage`) explicitly strips the `data-theme` attribute on every call ("CSS-fallback... JS vars now drive everything," `theme.js:46`), and `_applyVars()` only ever pushes `--custom-properties`, never `color-scheme` itself. Before 2026-08-07 this meant `color-scheme` stayed permanently pinned to `:root`'s hardcoded `dark`, so every native control rendered dark even in light mode — fixed by setting it directly from `mode` in both `theme.js:apply()` and `index.html`'s no-flash init script. Any component that hardcodes its own `color-scheme` (like `.nb-scope-select` used to) silently wins over the inherited value regardless of which is "more correct," same cascade trap as invariant 28 below — let it inherit. `settings.html`'s own "Appearance" panel (`#theme-dark`/`#theme-light`) had a *second*, separate Dark/Light toggle predating `NbTheme` entirely — it poked the parent's `data-theme` attribute and a disconnected `localStorage['nb-theme']` key that nothing else reads, so it was a complete no-op on the real app while appearing to work (its own self-contained iframe preview flipped). Fixed 2026-08-07 to call `window.parent.NbTheme.apply()` directly — see invariant 29 for the second bug that fix immediately hit.

28. **Anything rendered inside `#nb-preview-content .nb-rendered` (nb-web's shared prose wrapper) is fighting an unusually powerful opponent: its generic rules for bare `p`/`h1-h3`/`a` tags (`~styles.css:1743-1748`) carry an ID selector, so they beat almost anything a plugin sets on those same tags — whether by inheritance or by an explicit same-tag rule with lower specificity, including `:hover` states.** Two distinct failure shapes found live 2026-08-07, same root cause: (a) *inheritance lost* — `nbweb-cine`'s screenplay renderer (`.nb-script-page { color: #111 }`, a deliberate white "paper" look even in dark mode) had every body line (bare `<p>`s: action/char/dialogue/etc.) silently repainted to dark mode's pale `var(--text)`, because the generic rule matches the tag directly while `#111` was only ever inherited — fixed by scoping a local `--text: #111` override on `.nb-script-page` (custom properties resolve per-DOM-node, so descendant `var(--text)` reads pick it up regardless of which rule wrote it). (b) *specificity lost outright* — `.nb-specialty-link:hover { color: #fff }` (the dashboard "config"/"dashboard" chip) never applied at all, because `#nb-preview-content .nb-rendered a { color: var(--accent) }`'s 1 ID beats `.nb-specialty-link:hover`'s 0 IDs no matter how many classes/pseudo-classes it stacks — text pinned to `var(--accent)` forever, i.e. invisible accent-on-accent the instant the hover background (which *did* apply, unopposed) kicked in. Fixed with `!important` on just the contested `color`, following the one other precedent for this in the file (`.jcontextmenu li:hover`, `~styles.css:1622`). Any new plugin UI (chip, pill, button) rendered inside this wrapper needs one of these two techniques from the start if it uses a bare `p`/`h1-h3`/`a` tag and wants a color the generic rule doesn't already give it.

29. **A top-level `const`/`let` in a plain `<script>` (`theme.js`, `main.js`, `nbweb.js`, etc.) is reachable by bare name from any other classic script sharing that same top-level scope — but it is *not* a property of `window`, unlike `var` or a function declaration.** `window.NAME` and a same-name bare identifier are not the same lookup; only the latter works for a top-level `const`. This is invisible from within the app itself (every module reaches every other one — `NbTheme`, `NbMain`, `NbWeb` — by bare name, always has) and only bites a *different* JS realm reaching in from outside: a same-origin child `<iframe>` (`settings.html`, loaded by `terminal.js`) trying `window.parent.NbTheme` got `undefined` and silently fell through to a `catch` block, with no error surfaced anywhere — found live 2026-08-07 fixing invariant 27's settings-panel toggle. Fixed by adding `window.NbTheme = NbTheme;` after the IIFE in `theme.js`. Any future cross-frame or cross-window access to another top-level `const`-declared module in this codebase needs the same explicit `window.X = X` — don't assume reachability just because in-page code already reaches it fine.

30. **`location.hash` syncs with the current note in both directions as of 2026-08-08 (`main.js` commit `081932a`) — but only via `history.replaceState()`, deliberately never `pushState()`.** `openNote()` calls `replaceState()` on every navigation so the address bar reflects whatever note is open (copy-link/bookmark/refresh-able), and a `hashchange` listener (`init()`) calls `openNote()` back when the hash changes by any means other than the app's own navigation (manual address-bar edit, a hash-carrying link opened in an already-loaded tab, `page.goto()` to a hash-only-different URL in tests). The reason it's `replaceState` and not `pushState`: nb-web already has its own independent back/forward stack (`_history`/`_future`, `sessionStorage`-backed via `_persistNavHistory`) — `pushState` would create real browser-history entries alongside it, giving two different, unreconciled "back" mechanisms fighting over the same button. Don't "fix" this by switching to `pushState` for native browser back/forward support without first deciding how it reconciles with the existing stack; that's a bigger, separate design question, not a drop-in swap. Before this date, `location.hash` was read exactly once at boot and never written at all — see the (now-corrected) verify skill gotcha and `claude:nb-web_help-system_design.md`'s "Help Everywhere" section for the full narrative.

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
Stage 3 `_deferCheckBlocks` (2026-08-02): fires after Stage 2 settles (`_StatusPill.whenIdle()` +
bounded structural retry), not part of the shared codeblock loop — see invariant 20. Resolves
every Form-2 (ambient/glob) check source in parallel via one `/api/check/batch` call, consolidates
the result into a single sticky badge anchored in `#nb-preview-content`'s own top padding
(`.nb-check-notify-anchor`/`.nb-check-notify-open`, `styles.css`) instead of a normal-flow line —
zero page-bump at 0/1/N failing sources, only reclaims flow (pushing content down) once the user
unfolds it. Form-1 (labeled, click-to-run) blocks are unaffected, still built inline during Stage 2.

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

**Calibration, tested live 2026-08-07** (graph had gone stale — 2026-07-12, 142 commits behind — and this rule wasn't actually being followed; regenerated and the `graphifyy` pip package itself upgraded 0.9.13→0.9.35 in the same pass): `graphify explain "<symbol>"` for a specific name is reliably good — a tight caller list with exact file:line for each, no grep needed afterward. `graphify query "<question>"` for a broad question was noisy on both versions tested (137-138 nodes, mostly irrelevant) — 0.9.35 at least self-reports truncation honestly and gives real function-name community labels instead of opaque IDs, but still worth narrowing with `--budget`/`context_filter` rather than trusting the first dump. **Neither is exhaustive** — `explain "NbTheme"` missed `main.js`'s two real `NbTheme.apply()`/`.init()` call sites on both versions tested; treat graphify as a fast orientation pass, not a substitute for grep-verifying before acting on what it returns. Best fit found so far: "who else touches this before I change it" and "where's the real UI for X" (surfaced `nbweb-specialty.js`'s theme editor/picker as `NbTheme`'s actual caller, which the CSS-cascade/specificity bugs earlier in this session — invariants 27-29 — did not need and grep alone handled fine).

**#TODO (2026-08-07, deferred)**: evaluate `graphify extract --mode deep --backend <llm>` (semantic/LLM-assisted extraction — AST-only misses real call sites, e.g. `main.js`'s two `NbTheme.apply()`/`.init()` calls above) — needs an API key configured (none set as of this date: checked `GEMINI_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`DEEPSEEK`/`KIMI`, all unset) and costs real money per run, so this is a deliberate decision, not a default-on change. Also: the project's `PreToolUse` hook (`.claude/settings.json`, `graphify hook-guard search`/`read`, installed 2026-07-12) sat **not registered** (confirmed via `/hooks`) for a month. **Solved 2026-08-07**, and it was much simpler than it first looked: two dead ends were ruled out first (`--dangerously-skip-permissions` — docs confirm PreToolUse hooks fire in every permission mode, including that one; and a hook-specific workspace-trust gate — doesn't exist for `.claude/settings.json` hooks per official docs, `hasTrustDialogAccepted: false` was a real but unrelated red herring). The actual cause: the session's root working directory wasn't `~/dev/nb-web` at all — `cd`-ing into it via a Bash tool call doesn't change what Claude Code treats as the project root for loading `.claude/settings.json`, that's fixed at session start. Confirmed by checking every settings file in the hierarchy directly (`python3 -c "import json; ..."` on each) — the graphify `PreToolUse` entries exist in exactly one file, nb-web's own, nowhere else, and the session's actual root (`~/.nb`) has no `.claude/settings.json` at all. See the front-of-file callout above — fix is starting the next session rooted at `~/dev/nb-web` itself, not a workaround here.

**Coverage gap fixed 2026-08-07: `plugins/nbweb-cine.js`, `nbweb-claude.js`, `nbweb-hledger.js` are invisible to the graph by default** — they're symlinks into sibling repos (`~/dev/nbweb-cine/`, `~/dev/nbweb-claude/`, `~/dev/nbweb-hledger/`), outside `~/dev/nb-web`'s own scan root. Confirmed from graphify's own source: `follow_symlinks` defaults to `False`, and even forced on, `_resolves_under_root()` refuses to index a symlink target outside the scan root by design — the same "symlink invisible across the sibling-repo boundary" shape as invariant 14, hitting graphify's indexer instead of `podman build`. Fixed by running `graphify extract . --code-only --no-cluster` in each of the three sibling repos, then `graphify merge-graphs` into nb-web's own `graph.json`, then `graphify cluster-only . --no-label` to re-cluster without an LLM call — all $0, AST-only. 1104→1288 nodes. **This merge is manual and one-shot, not wired into any hook** — the three plugins' contribution to the graph will silently go stale the next time their own repos get real commits (same shape as invariant 21's container staleness, for the graph instead of the running app); re-run the sequence above after touching cine/claude/hledger plugin code. Full narrative + the extraction-warning investigation that came out of the same session: `claude:157` (`graphify_symlink_coverage_gap_2026-08-07.md`).
