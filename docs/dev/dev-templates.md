<!-- Generated from docs:dev/dev-templates.md by .tools/readme-export.py. Edit the source, not this file. -->

# TEMPLATES (dev)

Developer reference for the template system. For user-facing template docs see [TEMPLATES](../TEMPLATES.md).

---

## Three template types

| Type | Storage | Purpose |
|------|---------|---------|
| Regular | `.templates/*.md` in notebook or global `~/.nb/.templates/` | Note scaffolds — shown in Add picker |
| Annotation | `.template-annotation.md` anywhere in notebook tree (per-folder) | Pre-fills the annotation editor when "Add annotation" is clicked |
| Export HTML | (internal) | Controls HTML export layout |

Regular templates use notebook-local scope first, then fall back to global. Both scopes appear in the Add picker and Templates menu.

---

## Placeholder resolution — `_resolve_template_vars()`

`_resolve_template_vars(content, title, tags, body)` in `app.py` — called at note creation time, not at template edit time. Placeholders are resolved once and written into the note file.

| Placeholder | Resolution |
|-------------|-----------|
| `{{title}}` | Note title from the Add form |
| `{{name}}` | Alias for `{{title}}` — same dict value, used by some notebook-scoped templates |
| `{{input}}` | Alias for `{{title}}` — same dict value, named for "whatever the user typed" |
| `{{tags}}` | Space-separated `#tag` list from the Add form |
| `{{content}}` | Body text from the Add form |
| `{{date}}` | `YYYY-MM-DD` via `datetime.now()` |
| `{{day}}` | `Saturday, May 9, 2026` via `strftime` |
| `{{time}}` | `HH:MM` via `strftime` |
| `{{weather}}` | wttr.in one-liner — fetched lazily, only if `{{weather}}` appears in template text |

Resolution is a fixed Python `dict` of literal strings (`subs`), applied with plain
`text.replace(k, v)` per entry — **not** a shell/`eval` step, and there is no
`$(command)` substitution of any kind. This table is the complete set; a
`{{placeholder}}` not in it passes through to the note untouched. The preview shown
in the Template picker shows **raw placeholders** — resolution only happens on
"Create note".

---

## `_fetch_weather()`

Module-level cache in `app.py`:

```python
_weather_cache = {'value': None, 'ts': 0}
```

`_fetch_weather()` checks `_weather_cache['ts']` — if less than 3600 seconds old, returns the cached value. Otherwise hits:

```
https://wttr.in/?format=%c+%C,+%t+(feels+%f),+%h+humidity,+%w&m
```

5-second timeout. Returns `(weather unavailable)` on any error. The fetch is only triggered if `{{weather}}` appears in the template text — templates without it never hit the network.

---

## Annotation templates — `.template-annotation.md`

A `.template-annotation.md` file anywhere in a notebook tree is applied when "Add annotation" is clicked for a note in that folder. Resolution walks **up** from the note's directory to the notebook root, using the nearest match.

**API:** `GET /api/note/annotation-template?selector=` — finds and resolves the annotation template for a note's directory. Returns the resolved content (placeholders substituted) or `null` if no template found.

**Creation:** ☰ → "Save as template" → type Annotation → notebook/folder picker. Writes to `<folder>/.template-annotation.md`.

**Scope:** unlike regular templates (global or notebook-level), annotation templates are folder-scoped. A template in `items/` only applies to notes in `items/`, not to notes at the notebook root.

---

## Generator functions and seeded templates — sync requirement

**Critical:** when a plugin defines a template with a `content` function (generator), AND that template is seeded to disk as a `.templates/` file, **both must be updated together** when the schema changes. The seeded file is used for auto-selection; the generator is used for fresh creation via the plugin page. If they diverge, new notes get one schema and auto-selected notes get another.

Pattern: keep the canonical schema in one place (e.g. a `_SHOT_TEMPLATE` const), then both the `content` generator and the `+ Seed` write path reference it.

See [PLUGINS](../PLUGINS.md#templates) for the seeding mechanic.

---

## Template preview rendering — `_parseMarkdownStatic`

Template previews (Add-note picker, Templates menu, version-history diff, plugin help panels) must **not** run live codeblock renderers. `marked.use()` in `main.js` patches the global renderer so every `marked.parse()` call produces spinner skeletons for registered langs (`cfg`, `tw`, `hl`, etc.). Calling `marked.parse(body)` directly in a preview therefore spins forever.

**The fix — `_parseMarkdownStatic(body)` (main.js ~line 3245):**

```javascript
function _parseMarkdownStatic(body) {
    const r = new marked.Renderer();
    r.code = ({ text, lang }) => {
        const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const src = (lang ? `\`\`\`${lang}\n${text}\n\`\`\`` : `\`\`\`\n${text}\n\`\`\``);
        return `<pre><code>${esc(src)}</code></pre>\n`;
    };
    return marked.parse(body, { renderer: r });
}
```

Key decisions:
- **`new marked.Renderer()` not a plain object.** A plain `{ code: fn }` only defines `code` — when the body has paragraphs or headings, marked calls `obj.paragraph()` etc. which are `undefined` → throws → catch block shows "Could not load template". `new marked.Renderer()` has all methods on its prototype; only `code` is overridden on the instance.
- **Per-call renderer wins over `marked.use()`.** The instance-level method override takes priority over the global extension, so the spinner-producing path is bypassed.
- **Shows full fence notation.** The `code` renderer emits `` ```lang\ncontent\n``` `` as the `<pre>` body, not just the content. This lets template authors see the language tag without opening the editor.

**#gotcha** `marked.use({ renderer: { code } })` is a **global, permanent patch** — it applies to every `marked.parse()` call in the session. Never call bare `marked.parse(body)` for static display contexts; always use `_parseMarkdownStatic` or pass an explicit `renderer`.

**Call sites:** `_previewTemplate`, `_previewVirtualTemplate`, `_openTemplate.showPreview`, version-history diff view, plugin help panel.

---

## Frontmatter section in DEVELOPERS.md

The special frontmatter keys recognised by nb-web (`pinned:`, `toc:`, `lock:`, `processed:`, `toolbar:`, `xref:`, `draft:`, `caption:`, `alias:`) are documented in the pending-migration `## Frontmatter` section of [DEVELOPERS](../DEVELOPERS.md). That content will move to [architecture](dev-architecture.md) during the ODC pass.
