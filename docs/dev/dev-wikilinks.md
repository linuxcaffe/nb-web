<!-- Generated from docs:dev/dev-wikilinks.md by .tools/readme-export.py. Edit the source, not this file. -->

# WIKILINKS (dev)

Developer reference for wikilink and term: link internals. For user-facing syntax see [WIKILINKS](../wikilinks.md).

---

## Resolution algorithm

`_resolveWikilinkSelector(sel)` — called on click and for `data-autolabel` spans:

1. If `sel` contains `:` or is a bare integer → used as-is (full nb selector, e.g. `preciousfinds.ca:2`, `42`)
2. Otherwise → search via `/api/list?q=<text>` — resolved with **title first, filename stem fallback**:
   - Exact title match (case-insensitive)
   - Filename stem match — `[[1b]]` resolves to `1b.md` even if its `title:` is `"1-1b — Wide shot"`

`_resolveWikilinks(container)` — called after rendering. For `data-autolabel` spans, resolves the selector then fetches the note title via `/api/note` to set as display text. Falls back to leaving the text as-is on failure.

Results are cached in `_wikilinkCache` with a `\x00` prefix key (separate from selector-keyed display-title entries). Cache is session-scoped — persists across note switches, cleared on page reload.

---

## Pre-processing

Wikilinks are converted to `<span>` placeholders before marked parses the body, so the markdown parser never sees them as plain text:

```javascript
.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) =>
    `<span class="nb-wiki-link" data-selector="${target}" ...>${label || target}</span>`)
```

Fenced code blocks and inline code are split out first — links inside backticks are left untouched.

---

## Display label resolution (`data-autolabel`)

When a wikilink has no pipe label (`[[filename-stem]]` not `[[target|label]]`),
the span gets `data-autolabel="1"`. After rendering, `_resolveWikilinks` fetches
the note via `/api/note` and sets the display text as:

```javascript
title = d.meta?.alias || d.title || d.filename || sel
```

**Priority: `alias:` frontmatter first.** This means `[[WH-captive-cu-4f]]`
displays as `4f` (from `alias: 4f`) with no pipe label needed. The `title:`
frontmatter appears as a tooltip via the `title` attribute on the rendered link.

**Convention (NbWeb-cine):** embed the stable filename stem in the script;
let `alias:` supply the compact inline label automatically. Never embed bare
aliases (`[[4f]]`) as wikilinks — they resolve by title or filename stem only,
not by `alias:` field value.

---

## Dotfile wikilinks

Config dotfiles (`.shots.md`, `.Takeout.md`, `.nb.md`) are not indexed by nb,
so `nb search` never finds them. Two mechanisms make wikilinks to dotfiles work
transparently:

### Search supplement — bare stem form

`_search_notes()` in `app.py` checks whether the query starts with `.`. If so,
it `rglob`s the notebook for matching filenames after the main nb search:

- `[[.shots]]` → globs for `.shots.md` → finds `shots/.shots.md` → selector `Takeout:shots/.shots.md`
- `[[.Takeout]]` → globs for `.Takeout.md` → finds `.Takeout.md` at notebook root

Accepts bare stem (`.shots`) or explicit name (`.shots.md`). The JS resolver
matches on filename stem as normal — `[[.shots]]` matches a result whose
`filename` is `.shots.md` because `.shots.md`.replace last extension = `.shots`.

### Direct filesystem fallback — explicit selector form

`GET /api/note` falls back to direct filesystem lookup when `nb show` fails.
For any `notebook:rel-path` selector, it tries `NB_DIR/notebook/rel-path`
directly (must resolve within `NB_DIR` — path traversal safe):

- `[[Takeout:.Takeout.md]]` → skips search (has `:`), `/api/note` hits fallback
- `[[Takeout:shots/.shots.md]]` → same path

**Recommended form:** `[[.shots]]` (bare stem) for same-notebook links — shorter,
and the search supplement handles it. Use `[[Notebook:.file.md]]` when linking
cross-notebook or when the stem is ambiguous.

**Display label:** `data-autolabel` fetches the note via `/api/note` and uses
`meta.alias || title || filename`. Config dotfiles typically have `config: shots`
in frontmatter; `title:` is usually absent. The `config:` field is not used as
autolabel — include a pipe label for a clean display: `[[.shots|shots config]]`.

---

## term: link implementation

`term:` links execute arbitrary shell commands in the built-in terminal pane. The click handler:

1. Extracts the URL from `href="term:..."` 
2. Decodes percent-encoding via `decodeURIComponent`
3. Substitutes `{variable}` placeholders with current-note context values
4. Sends the command to the terminal pane (opens pane if not already open)

**Placeholder substitution** happens at click time — not at render time. Values reflect the note that is open when the link is clicked, not when the page was rendered. This matters for templates: a `term:` link in a template is resolved fresh each time it's used.

**Percent-encoding requirement:** CommonMark disallows spaces in unquoted link URLs. Spaces and quotes in the href must be percent-encoded; the click handler decodes them before passing to the shell.

```markdown
[hledger register "Bank:"](term:hledger%20register%20%22Bank:%22)
```

Use `urllib.parse.quote` (Python) or `encodeURIComponent` (JS) when generating term: links programmatically. The `org-to-nb-notes.py` tool handles this for `$ hledger` lines in org tutorial files.

**Safety note:** `term:` links execute arbitrary shell commands. They are nb-web-only — Quartz does not evaluate the `term:` scheme and the raw link appears as literal text in static builds.

---

## Inline query implementation (`{{provider: query}}`)

Inline `{{...}}` patterns are detected in `_resolveInlineQueries` during `_enrichRendered`. Each span gets:

- `data-provider` — the provider name (`hledger`, `tw`, `nb`, `fm`, `date`, `inline`)
- `data-query` — the query string

Non-inline providers (`hledger`, `tw`, `nb`, `fm`, `date`) fire in parallel — they're cheap single-value lookups. `inline` includes are sequential (see [RENDER_PIPELINE](../RENDER_PIPELINE.md#1a)). `fm` (2026-08-04) is a thin wrapper — `count`-only, reuses the exact same `_run_front_query`/`_parse_fm_scope` the `fm` codeblock itself is built on; implementation details live with the codeblock's own notes: [codeblocks](dev-codeblocks.md#fm-block-implementation-notes).

`_iq_strip` — strips hledger report formatting (separators, commodity padding, column headers) down to a plain value suitable for inline text. Multiple result rows are joined with ` · `. This is why multi-row queries collapse into unreadable strings — use codeblocks for reports with more than one or two rows.

Patterns inside `` `code` `` or fenced blocks are never evaluated — code split happens before `_resolveInlineQueries`.

**Depth guard for `{{inline:}}`:** included notes never nest. `{{inline:}}` patterns in included content are silently dropped to prevent infinite recursion.
