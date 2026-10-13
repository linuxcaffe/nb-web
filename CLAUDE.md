# nb-web — CLAUDE.md

Short form: each rule, why it exists, and where to read more. The full text of every invariant
(incident stories, dates) and the subsystem notes (plugin architecture, renderer registry,
specialty headers, cine, render pipeline, inline queries, graphify) are in
**`docs:dev/dev-invariants.md`**, with the same numbering. When adding an invariant, put the rule
here in a few lines and its story there.

**Session root:** a session started elsewhere that `cd`s here doesn't load this repo's
`.claude/` settings or skills; restart rooted at `~/dev/nb-web` when that matters.

## What this is

Flask (`app.py`, port 5001) + vanilla JS, no build step. Run with `python3 app.py`. Notes live in
`~/.nb/` as Markdown; nb-web never writes them directly, everything goes through nb CLI or git.

## Key files

| File | Role |
|------|------|
| `app.py` | Flask backend: API endpoints, nb subprocess wrappers, git ops |
| `main.js` | `NbMain`: note rendering, editor, wikilinks, codeblocks, annotations |
| `nav.js` | `NbNav`: notebook/folder scope, breadcrumb, sync dialog, menu |
| `nbweb.js` | `NbWeb`: plugin/renderer registry, shared helpers (`formActions`, `formKeys`, `isoDate`) |
| `terminal.js`, `dialog.js`, `drag-handles.js`, `note-actions.js`, `search.js`, `sync.js`, `plugins-page.js`, `notebooks-page.js`, `templates.js`, `ui-chrome.js` | Satellites extracted from main.js (`NbTerminal`, `NbDialog`, …) |
| `ui-access.js` | `NbUiAccess.can(el, group, mode)`; loads right after `nav.js` |
| `dashboard_summary.py` | `{{inline: summary <dashboard>}}`, shared with `.tools/readme-export.py` |
| `starter/` | Files `/setup` copies into a fresh install |
| `styles.css` | All styling |
| `nb-settings.json` | Runtime config: git remotes, plugin list |
| `plugins/` | Core plugins; `nbweb-{cine,claude,hledger}.js` are relative symlinks to `~/dev/nbweb-*` |

## Docs

- **Example data:** the fictional cast in `docs:dev/dev-example-data.md` (Pat and Sam Smith, Acme,
  Jones, Kim Lee), never real names, paths or amounts; `.tools/readme-export.py` refuses a hit
  from `~/.nb/.rules/private-names.txt`.
- **User docs** `~/.nb/docs/`; **dev docs** `~/.nb/docs/dev/` (index `docs:DEVELOPERS.md`);
  AI meta-index `~/.claude/projects/-home-djp/memory/reference_nb_web_index.md`.
- **For "is X built / true" questions,** check `docs:dev/` and related `claude:` notes before
  trusting any one document, this one included.

## Testing

Tests live in the sibling repo `~/dev/nb-web-tests/` (no `tests/` here).

| Layer | Run |
|-------|-----|
| pytest (backend) | `cd ~/dev/nb-web-tests && python3 -m pytest -q [test_x.py]` |
| Playwright e2e | `cd ~/dev/nb-web-tests/e2e && npx playwright test <spec> [-g name]` |
| Module-reference lint | `python3 .tools/check-module-refs.py` (also a pre-commit hook) |

**Found a bug? Write the failing test first** (red, then patch, then green), not a throwaway
`python3 -c` check. **Keep verification lean** (djp, 2026-10-13): run the pytest files and the
one e2e spec the change touches. djp checks the UI by eye, so don't screenshot or drive a
browser just to confirm a look. Run the full e2e suite (~4 min) only for cross-module changes
(satellite extraction, script order, kernel accessors) or when asked. See the `verify` skill.

## Wikilinks

Link by filename stem (`[[WH-captive-cu-4f]]`); `alias:` only changes how it displays. Never
`[[alias]]`: the resolver matches title and stem only. `NbMain.saveNote` (save before navigating
away in a plugin) and `NbMain.activeNote()` (the current note object) are exported.

## Critical invariants

Numbers match `docs:dev/dev-invariants.md`, where each has its full story.

1. Annotation foot calls `_enrichRendered`, never `_finishRendered` (infinite recursion).
2. previewRenderer plugins use `NbMain.renderMarkdown(body, selector)`, not `marked.parse`.
3. Sync push is `git push origin HEAD:<notebook-name>`; wiring needs `branch.master.merge`.
4. StatusPill: `?.add(n)` before work, `?.tick()` on success and error; spread NodeLists.
5. Template schema: change generator functions and seeded templates together.
6. `run_nb()` passes `input=''`, never `None` (Flask hangs on interactive prompts).
7. `renderPreview` must stay `async`; making it sync kills the whole NbMain IIFE.
8. Bump `sw.js` `CACHE` with asset changes. `serve_sw()` rewrites it to the git hash anyway.
9. `api_note` GET special-case selectors must also be handled in `api_edit_note` PUT.
10. Every `renderPreview` branch that reaches the shared `innerHTML` + `_finishRendered` must
    include `_checkHtml +`; early-return branches are exempt.
11. Each `data-min-level` section in `settings.html` gets its own `nb-auth-ready` listener.
12. External plugin repos don't move nb-web's git hash, so the service worker serves stale
    copies of them: hard-refresh.
13. An endpoint names its notebook only via `notebook=` or `selector=`; that's all
    `_notebook_scope_check()` sees. Any other key needs explicit scope checks.
14. Two deployments must both work: bare `python3 app.py` (real `$HOME`) and the Podman
    container (`HOME=/home/nbweb`, read-only root). Never assume `Path.home()` is djp's; journal
    paths `~`-rooted; under gunicorn `/api/restart` sends `SIGHUP`. Plugin symlinks stay
    relative; the image clones cine/claude/hledger from GitHub. `nbweb-specialty.js` is a real
    vendored file, never a symlink (`.checks/sys-container-broken-symlinks`).
15. A dotfile field cascades to notes only if it's in `/api/note`'s `effective_*` allowlist
    (`access`, `claude`, `checks`, `check_add`, `check_skip`, `cfg_attr_add/skip`, `xref`, `fm`,
    `ui_hide`, `help`, `help_header`). Everything else is read via `_notebook_config()`.
16. `codeblock_access` lives in `~/.nb/.nb.md`, not `nb-settings.json`. Its `read:` side is not
    enforced by the backend; only `_cb_write_allowed()` exists.
17. A mutating endpoint needs a `_level_gte` floor and a `_can_access(user, {}, _notebook_config(nb))`
    check; assume both are missing until audited. Floors: `user` for content, `admin` for
    external resources and credentials. `_notebook_scope_check` replaces neither.
18. `nb notebooks --names` prints a splash (and creates `home`) when no notebooks exist; startup
    burns one call (`_ensure_home_notebook()`, which needs a git identity, see 78).
19. SVG: `setAttribute('class', …)`, never `.className =`, which silently does nothing.
20. Check codeblocks run last, deferred (`_deferCheckBlocks`), outside the shared codeblock
    loop. `_maybeCaptureRenderCache` keeps its bounded retry. Only frontmatter/config checks
    (`data-check-ambient`) go to the badge; body checks render in place and fire
    `nb-checks-rendered`. A check's first output line should be a headline (`.rules/checks.md`).
    Keep the pending `<span class="nb-spin">`.
21. Merging to main doesn't update the container: only `.tools/rebuild-container.sh` does.
    `nb-web-launch.sh` offers a rebuild when stale (`_warn_if_stale`, guarded to run once).
22. `/api/regen` runs `.tools/*.py` regenerators (write-access gated); saving `.{name}-org.md`
    in the app auto-runs it. CLI edits bypass it.
23. A numeric id (`nb:5`) is per-folder, not unique. Store and link path selectors; creating
    in a folder must carry the folder into the target.
24. `os.walk` scans must drop dot-prefixed files as well as directories.
25. After mutating a note, bust `_noteCache` (`_bustCache`) before reopening it.
26. `Containerfile` `ARG`s go immediately before the step that uses them, or every layer
    rebuilds. Podman size figures on this host are unreliable; trust `df -h`. Podman 3.4.4
    leaks layers (`.checks/sys-podman-leak.sh`); the fix is `podman system reset` + rebuild.
27. `color-scheme` comes from `theme.js` (`documentElement.style.colorScheme`), not CSS
    selectors. Components must inherit it, not hardcode it.
28. Inside `#nb-preview-content .nb-rendered`, ID-specificity rules color bare `p`/`h1-3`/`a`:
    override via a local `--text`, or `!important` on the contested property.
29. A top-level `const` isn't on `window`; anything reached across frames needs `window.X = X`.
30. `location.hash` follows the open note via `replaceState` only, never `pushState` (nb-web
    has its own back/forward stack). A URL naming another notebook switches the list to it
    (`followHashNotebook`); a folder wikilink opens the folder.
31. Auto help: `.lib/help-type-<type>.md` must match the literal `type:` value.
    `help-<subject>.md` is for non-type topics.
32. A bare `help:` topic tries `help-type-<t>.md`, then `help-<t>.md` (frontend only). Grep for
    the bare word before renaming a help file.
33. A note's own `help:` blocks the cascade (nearest wins); remove stale `help: <type>` lines.
34. `.lib` is fm-queryable, but `.lib` access is a filename suffix: always gate with
    `_lib_file_accessible`. Don't loosen `_safe_notebook`.
35. `classify()`: the first matching rule wins; grep for the extension before adding one.
    `.svg` stays `code` (the rendered view is a frontend toggle).
36. A new `type:` needs `_FM_TYPES` (and `INDICATORS`, main.js icons). Quick test: compare
    `/api/note`'s `type` with the frontmatter.
37. A note's `lock:` frontmatter and `note.locked` (a folder `.nb-lock`) are different locks.
38. `/api/note/constraints-full` reads only the immediate folder config, plus the note's own
    `constraints:` / `constraints_add:`. Don't widen it to the full cascade.
39. `/api/note`'s `meta` merges annotation frontmatter into gaps. Renderers that must not show
    annotation data read the note's own frontmatter (`_ownMeta`).
40. `add:org` (the `.{name}-org.md` wizard, `KIND/TEMPLATE/AT/IF`) is a separate org source.
    Sanitise substituted values, not the whole path; pass an explicit `filename`;
    `nb folders add` isn't idempotent (pre-check); exclude dotfiles from the navigation target.
41. `> MILESTONE:` markers group billing in quotes and invoices
    (`docs:dev/dev-billing-milestones.md`).
42. `NbMain.insertBeforeToday(body, content)` is the one place to insert relative to
    `> TODAY:`; pass `note.body`, not `raw`.
43. The `[+]` picker's org source: the note's `add_org:`, then `types.<type>.add_org`, then
    `.{type}-org.md`, plus the cascading `add_org_add:`.
44. Creating a new folder on disk: reconcile the parent's `.index` too (`_nb_index_reconcile`
    on the parent) and commit it.
45. Marker groups attribute backward to the previous marker (achievement style), for any
    marker type.
46. `nb` colours output whatever `NO_COLOR` says: `strip_ansi()` any `run_nb()` output parsed
    as data. `ANSI_RE` matches every CSI sequence.
47. `GET /api/t/marker-groups` is the JSON sibling of quote/invoice generation (both gates).
48. Quote and invoice share `_render_milestone_sections`; they differ only by parameters.
49. Quote/invoice entry is the reports note: go through `_resolve_diary_source()`.
50. A project's master journal is created only by `_ensure_journal_stubs`, which never edits an
    existing one.
51. Milestone checklists feed quotes (fence-aware); no synthesized `$0.00` rows.
52. The print popup (`_doPrint`, ui-chrome.js) has its own inline `<style>`; print CSS goes
    there. To test it, use `context.expect_page()` + `popup.pdf()`.
53. Never `selector.split(':')[0] if ':' in selector else 'home'`: use `_notebook_for_path()`.
    Still unfixed in `api_check_run`, `api_check_batch`, `_stream_claude_ask`.
54. `since_invoice` cuts off by the marker's date, not its line position.
55. Billing preflight must use `_billing_summary_for_scope()`, the same computation as
    generate.
56. `since_marker`/`until_marker` scopes have no flat-path fallback; an invoice's scopes are
    narrower than a quote's.
57. Quotes interleave other markers in document order (`_slice_annotations_in_order`);
    invoices don't.
58. `> INVOICED:` goes before `> TODAY:` (`_insert_before_today()`), never at the end.
59. `_computeEditGate` is the single source for the Edit button: unsupported > dir-locked >
    content-locked > in-use > editable. `in-use` (`_active_edits`, 90 s TTL) is advisory, and
    in-process only.
60. A JS modal appended to `body` must take focus when it opens, and its Escape handler must
    `stopPropagation()` (ui-chrome's global Escape clicks any "Cancel").
61. A standalone raw `<img>` line swallows following lines (CommonMark HTML block);
    `_renderMarkdown` inserts a blank line after it. Splicing block HTML needs the same.
62. Annotation access is its own: the sidecar's `access:`, then cascading
    `annotation_access:`, then the note's. Writes need `user`. `/api/note` redacts (no merge)
    when it's denied. The `BINARY_TYPES` branch still lacks a note-level `_can_access`.
63. The check sweep never runs `nb`. `_note_check_tokens` (py) and `_virtualTestPrefix` (js)
    are twins: change both (`test_check_resolution.py`). Config errors are reported once, at
    their source; `sys-` checks stay out of notebook sweeps (`docs:dev/dev-check-sweep.md`).
64. Colours come only from the 15 theme keys, with no hex fallbacks (`test_theme_vars.py`). A
    new key goes in `THEMES.md`, `:root` and every theme.
65. Single-file bind mounts (`nb-settings.json`, `.flask_secret`, `.api_token`) can't be
    replaced by rename; fall back to an in-place write (`_save_settings`).
66. Help: `help_for:` contexts (`file:`, `type:`, `block:`, `key:`, `notebook:`, `page:`) list
    topic notes in `effective_help`. Topic/feature pairs use the `nb-pair-chip`. Categories are
    dashboards with `help_for:`. Pages use `NbMain.showPageHelp`.
67. A selector's path must stay inside its notebook, checked lexically (`_selector_disk_path`,
    `_confined_to_selector`, refuse `..`). Never build `NB_DIR / nb / rel` by hand.
68. `parse_frontmatter` caches YAML and returns deep copies; keep the copies.
69. A superseded `openNote` never draws (abort signal); the list's auto-select doesn't trample
    a pending hash (`_hashWeWrote`).
70. Frontmatter pins sort first, menu pins (localStorage) after. Unpin blanks `pinned:`.
71. `nb <nb>:<name>` runs an nb subcommand when `<name>` is one (`archive`, `todo`, …).
    Folders are created by `_create_folder`, not nb.
72. Never two `nb` processes at once: every `nb` call goes through `_nb_lock()` (flock), or
    `.index` can be emptied. Hand-run git in `~/.nb` holds the same lock.
73. API dates are ISO via `_JSONProvider`; don't reassign `app.json`.
74. Template endpoints touch only template files (`_template_path_ok`).
75. "Today" is local: `NbWeb.isoDate()`, never `toISOString().slice(0,10)` (`// utc-ok` to
    exempt); the container runs with `-e TZ`.
76. Locks are server-enforced (`_locked`, 423): folder `.nb-lock`, note `lock:`, the
    annotation's own `lock:`. Changing a lock needs `lock_level:` (`_may_lock`). Every new
    writing endpoint needs `_locked(...)`.
77. A request's `file=` goes through `_time_file_refusal` / `@_time_file_gate`; folders and
    destinations through `_place_refusal`. The terminal (`/ws/pty`) is tech-only.
78. Fresh install: `/setup` (one-time code) → git identity → `home` → `starter/` →
    `home:welcome.md`. nb does nothing without a git user.name and user.email.
79. Every scan across notes filters by account scope (`_notebook_in_scope`) and
    `_can_access` per note, including folder-config `access:`.
80. Below tech there must be no path to tech: `_dot_level` (`.users` is tech to read and write;
    `.checks`/`.lib`/`.tools` tech to write) and `_may_manage_user`.
81. In-note forms use `NbWeb.formActions()` + `NbWeb.formKeys(root, save, cancel)`
    (Ctrl+Enter saves, Escape cancels, stopped at the form). Save stays dim (`nb-clean`) until
    an input/change; `NbWeb.formDirty(root)` marks it dirty for other edits; csv uses
    `_csvDirtyHooks`, and `_csvDirty` makes `openNote` ask before leaving. Block-header actions use `nb-block-act`. The editor's own Save is
    separate.

## nb notebook layout

`~/.nb/`: one git repo per notebook (`home`, `docs`, `claude`, `accts`, `contacts`, `djp`,
`features`, …). Root dot-folders `.users`, `.tools`, `.changes`, `.images`, `.rules`, `.lib`,
`.checks` are global and not indexed by nb.

## Plugins (summary; details in `docs:dev/dev-plugins.md` and `dev-invariants.md`)

- `NbWeb.registerModule(id, { detect, label, codeblockRenderers, previewRenderer(s),
  previewTypes, listButtons, notebookSection, listDefaults, sortOptions, navButtons })`, IIFE,
  loaded from `nb-settings.json`.
- A codeblock renderer is `{lang, html(text), renderOne(el), render(container)}`. `html` +
  `renderOne` are needed for frontmatter (FM strip) participation. Langs: `tw nb git hl fm cfg
  add nav gallery t toc test chart cine`.
- `_FM_BLOCK_KEYS` (app.py) lists langs whose config keys propagate via `effective_fm`.
- `.lib/help-block-{lang}-{access}.md` adds a `?` to a block header;
  `open-block-{lang}-{access}.sh` handles the title click (output `nb:`/`file:`/`term:`/URL).
- Renderer registry: `registerRenderer`, `getRenderers(type)`, `getPreviewRenderers(nb, note)`
  (a notebook's `types.<type>.renderer` goes first); `loadNotebookConfig` /
  `bustNotebookConfigCache`.
- Specialty headers (`plugins/nbweb-specialty.js`): **four separate builders** (generic,
  dashboard, reports, dotfile); cross-cutting header UI must go into all four. Pair chips
  (`.nb-pair-chip[data-open]`) share one delegated handler. Trailing UI goes last, with
  `margin-left: auto`. The `[+]` engine (`openAddOrgPicker`) is in `nbweb-codeblocks.js`.
- Cine (`~/dev/nbweb-cine`): filename stem / `alias:` / `title:`; characters → actors via
  `alias:`; see `docs:dev/dev-cine-fountain.md`.

## Render pipeline (details in `docs:dev/dev-render-pipeline.md`)

`_renderMarkdown` (wikilinks, codeblocks) → `marked.parse` → `_enrichRendered` →
`_resolveInlineQueries` → `_finishRendered` (+ annotation) → `_deferCheckBlocks`.
`{{provider: query}}` resolves via `/api/inline-query`; providers with a default go in
`_QUERY_OPTIONAL`. `{{inline: path[#Heading]}}` and `{{inline: card path}}` are client-side
includes: two levels deep, headings shifted under their host heading, a standalone line becomes
a `<div>` placeholder before marked.

## Tooling

**graphify: don't use it unless djp asks** (2026-10-13). The hook is removed, and broad queries
were noisy.

Design notes: `claude:nb_plugin_development_—_hard-won_patterns.md`,
`claude:nbweb-hledger_plugin_design.md`, `docs:dev/dev-claude-integration.md`,
`claude:odc_nb-web_plan.md`.
