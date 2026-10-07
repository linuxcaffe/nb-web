<!-- Generated from docs:dev/dev-frontmatter-editor.md by .tools/readme-export.py. Edit the source, not this file. -->

# Frontmatter Editor (dev)

Universal guided frontmatter editing — a toolbar button on every note card (**FM**), plus an optional inline `fm edit` block. Both are "fm-edit" (called "Changes" until 2026-10-06). No raw YAML editing required. Body content is never touched.

---

## Architecture overview

Three components work together:

| Component | File | Role |
|-----------|------|------|
| `.constraints.md` | per-folder or notebook root | field → widget type mapping (legacy source) |
| `constraints:` in `.{foldername}.md` | folder config | same mapping, higher priority (migration path) — see below |
| `GET /api/note/constraints` | `app.py` | merges both sources, normalizes to widget-type strings, returns JSON |
| `GET /api/note/constraints-full` | `app.py` | folder-config `constraints:` only, keeps `required:` instead of dropping it — see "Required fields" below |
| FM button + panel (`#nb-fm-edit-btn`, labeled "FM") | `main.js` | toolbar button → `fmUtils.form` |
| `fm edit` block | `nbweb-codeblocks.js` | inline alternative → `fmUtils.form` |
| `NbWeb.fmUtils` | `nbweb-codeblocks.js` | shared form (`form`) and its parseFields/patch/widget helpers |

---

## .constraints.md

A dotfile (not indexed by nb) placed in a folder or notebook root. Standard YAML frontmatter — one line per field:

```yaml
---
category: select exec,creative,tech
dept:      select grip,camera,lighting,sound,makeup,wardrobe,sfx,transport,art
unit:      select day,hour,week,flat
lock:      bool
type:      select resource,character,cast,location,shot,scene,storyline,report
---
```

**Constraint string format:**

| Value | Widget rendered |
|-------|----------------|
| `select a,b,c` | `<select>` dropdown |
| `bool` | checkbox |
| `date` | `<input type=date>` |
| `area` | `<textarea>` |
| *(anything else or absent)* | `<input type=text>` |

**Scope and walk-up merge:**

```
~/.nb/Takeout/resources/.constraints.md   ← folder-scoped (wins)
~/.nb/Takeout/.constraints.md             ← notebook-wide (fallback)
```

Flask walks from the note's directory up to the notebook root, merging files (folder entries override notebook entries for the same key). Notes in folders without a `.constraints.md` get only the notebook-wide constraints.

---

## Folder-config `constraints:` — the current preferred path

`.constraints.md` above is the **legacy** source. `_load_constraints` (`app.py`) merges it with a `constraints:` section inside the folder's own config dotfile (`.{foldername}.md` — the same file that already carries `type: dotfile`, and for a notebook root, whatever else that root config holds), and **folder config always wins** over `.constraints.md` for the same key — this is the migration path, not a competing convention. New schemas should be written here, not as a separate `.constraints.md` file:

```yaml
# preciousfinds.ca:items/.items.md
---
type: dotfile
constraints:
  status:
    widget: select
    values: [available, sold]
    required: true
  price:
    widget: text
    required: true
  category:
    widget: text
---
```

**`values:` must be a real YAML list, not a bare comma-string.** `_normalize_constraint` does `','.join(str(v) for v in values)` — if `values` is written as `available,sold` (a plain YAML scalar string) rather than `[available, sold]`, that join iterates the string *character by character*, silently producing a garbled dropdown (`select a,v,a,i,l,a,b,l,e,...`). Caught live 2026-07-14 in exactly this shape — `_load_constraints` doesn't validate the type, it just iterates whatever it's given.

**`required:`** is the one sub-key `/api/note/constraints` cannot round-trip — see next section.

---

## API endpoint

```
GET /api/note/constraints?selector=Takeout:shots/2
```

Returns a flat JSON object:

```json
{
  "type":     "select resource,character,cast,location,shot",
  "category": "select exec,creative,tech",
  "unit":     "select day,hour,week,flat",
  "lock":     "bool"
}
```

**Backend helper:** `_load_constraints(note_path: Path) → dict` in `app.py`. Called by `api_note_constraints()`. Processes root-first so deeper entries win.

### `/api/note/constraints-full` — the `required:`-preserving sibling

`_normalize_constraint` flattens every rich dict shape down to a bare widget-type string — `required:` (and anything else beyond `widget`/`type`/`values`) is simply dropped. That's correct for `/api/note/constraints`'s one consumer (the FM panel only needs to know *how* to render a field it's already showing), but it means nothing can ask "which fields does this schema require?" through that endpoint.

`api_note_constraints_full()` answers that question — same `_normalize_constraint` widget-string values (can't drift from the FM panel's own rendering), paired with `required: bool` alongside each one:

```
GET /api/note/constraints-full?selector=preciousfinds.ca:items/gxx102.md
```
```json
{
  "status":   {"widget": "select available,sold", "required": true},
  "price":    {"widget": "text", "required": true},
  "category": {"widget": "text", "required": false}
}
```

**Deliberately reads only the note's own immediate folder's `.{foldername}.md`** — not the full `_folder_config` cascade `_load_constraints` uses. `constraints:` is dict-valued, and dict-valued keys merge key-by-key across every config level (`_merge_configs` recurses into dicts rather than replacing wholesale — see the "Cascading config" pattern doc if one exists, or `.rules/checks.md`'s note on why `_add`/`_skip` semantics aren't needed for dict keys). Tried against the full cascade, an unrelated notebook-or-global-level `constraints:` entry for a completely different schema (e.g. a service-pack `client:`/`billing_type:` block) leaked into an `items/` folder's result — both incorrectly marked `required: true` for every item note, regardless of type. A folder-specific schema should show exactly what that folder declares, nothing inherited. If a future consumer genuinely needs the cascading/legacy-`.constraints.md`-merged behavior with `required:` preserved, that's new work, not something this endpoint currently does.

Also carries the same absolute-path selector bypass `api_note()` has (`elif selector.startswith('/')`) — the original `/api/note/constraints` doesn't have this, which matters for testing: hitting it with a `notebook:path` selector shells out through `run_nb` to nb's own index, which won't know about files a test fixture wrote directly to a synthetic `tmp_nb`. Tests for this endpoint live in `nb-web-tests/test_constraints.py`.

---

## Three ways to fill in a note's fields

As of 2026-07-14 there are three, not two, and they cover genuinely different gaps:

1. **Direct Edit** — raw markdown/frontmatter editing. Always available, no schema needed.
2. **FM button / `fm edit` block** (this doc, above) — schema-typed widgets for the note's own fields, then (since 2026-10-06) a row for each field `/api/note/constraints-full` declares that the note doesn't have yet (italic label, `data-fm-new`), written only when given a value. Required fields get a `*`. Declared fields come from the note's own folder and its own `constraints:`/`constraints_add:`, never the full cascade (invariant 38); widget types still come from `/api/note/constraints`.
3. **A type-specific "fill in everything" modal** — shows every field a schema declares, required or optional, present or not, using `/api/note/constraints-full` to know what to show and which fields are required. First (and so far only) example: the item fields modal, `_itemFieldsModal` in `nbweb-hledger.js` — the "📝 Fields" button on the item specialty header (see `docs:dev/plugins/hledger/CLAUDE.md`). Reuses the exact same `NbWeb.fmUtils.widget`/`patch` helpers as the FM panel, so widget rendering and the save mechanism can't drift between the two UIs.

**(3) only works because of a `fmUtils.patch()` fix, not a new save path.** `patch()`'s original behavior only ever matched and updated a field that already existed in the frontmatter — a missing key's regex simply never matched anything, so the update for that key silently no-op'd. That's *why* (2) can't fill in blanks: even if you built a form row for a genuinely-missing field, saving it would go nowhere. Fixed by falling through to append the key when the regex doesn't match (existing-key update path unchanged):

```javascript
for (const [key, val] of Object.entries(updates)) {
    const re = new RegExp(`^([ \\t]*${escaped(key)}):[ \\t]*.*$`, 'm');
    if (re.test(head)) {
        head = head.replace(re, `$1: ${val}`);
    } else {
        head += `\n${key}: ${val}`;   // key didn't exist yet — append, don't drop
    }
}
```

This fixed the bug for **both** UIs — the FM panel could in principle now add a missing field too, if a future change ever built rows for schema fields it doesn't currently show.

---

## Config form save — nested object trap #gotcha

`_configFmToContent()` in `main.js` re-serialises the **entire** frontmatter on
every save — not just the fields the form renders. The form manages a small set
of scalar fields (access, pinned, prepend_date, check, tag_color). All other
fields pass through the serialiser unchanged.

**The trap:** any catch-all that uses a template literal on an unknown value will
coerce nested objects to `[object Object]`:

```javascript
lines.push(`${key}: ${v}`);  // v = {journal: '...', commodity: 'CAD'}
// → "hledger: [object Object]"  ← silent data loss
```

This destroyed the `hledger:`, `cine:`, `constraints:`, and `types:` blocks in
`.Takeout.md` when the user changed `access:` and saved (2026-06-21).

**Fix in place:** `emitYaml(key, v, indent)` — recursive, handles nested objects
as indented block YAML at any depth. Auto-quotes strings containing `:` or `#`.

**Deeper fix (not yet done):** fields the form never touches should be
round-tripped as raw YAML text from the original file, not re-serialised from
the parsed object. This preserves comments, quote style, and any YAML the parser
may not perfectly reconstruct.

## `emitYaml` — array element quoting #gotcha

Flow-sequence items must be individually quoted, not just joined:

```javascript
// wrong — element "festival, drama" becomes two items after round-trip
lines.push(`${key}: [${v.join(', ')}]`);

// right — quote elements that contain , : # or surrounding spaces
const items = v.map(item => needsQuote(item) ? `"${item}"` : item);
lines.push(`${key}: [${items.join(', ')}]`);
```

Low-probability but silent: the YAML parses without error, just with wrong
cardinality. Fixed 2026-06-21 (commit 681d136).

## Raw editor save — notebook config cache not busted #gotcha

`_saveNote()` (raw markdown editor) called `bustNoteCache()` but not
`bustNotebookConfigCache()`. Editing a config dotfile (`.{notebook}.md`,
`.nb.md`) via the raw editor left stale access levels, plugin detection, and
inherited form values cached until page reload.

The config form save (`_saveConfigForm`) already busted both caches correctly.
The gap was the raw editor path only.

**Fix:** `_saveNote()` now checks if the saved filename starts with `.` and calls
`bustNotebookConfigCache(NbNav.notebook)` when true. Fixed 2026-06-21 (commit 681d136).

---

## FM toolbar button (fm-edit)

Added to `#nb-preview-actions` in `index.html` — sits left of Edit in the grey toolbar bar, always visible regardless of note scroll depth.

**Visibility rules** (wired in `renderPreview` in `main.js`):
- Hidden if `note.meta` is empty (no frontmatter)
- Hidden if `note.locked` (folder lock) or the note's own `lock:` is set
- Resets panel state on every note navigation

**Flow:**

1. Click **FM** → `_toggleFmEditPanel(note, btn)` → `NbWeb.fmUtils.form(panel, selector, onDone)`
2. Parallel fetch: `GET /api/note` (`raw`) + `/api/note/constraints` (widgets) + `/api/note/constraints-full` (declared fields)
3. `parseFields(raw)` extracts the ordered field list (skips block scalars); declared fields the note lacks follow
4. `widget(key, value, constraint)` builds each input
5. Panel opens as `#nb-fm-edit-panel` — a static HTML div flush under the toolbar
6. **Save** → `patch(raw, updates)` → `PUT /api/note` → `NbMain.bustNoteCache` → reload note
7. **Cancel** → panel hides, no write

The `fm edit` block calls the same `form()` with its own inline panel, so the two can't drift.

---

## NbWeb.fmUtils

Exported from `nbweb-codeblocks.js` so `main.js` can reuse without duplication:

```javascript
NbWeb.fmUtils = {
    form(panel, selector, onDone), // the whole fm-edit form; onDone(saved) on save/cancel
    parseFields(raw),   // → [{key, value}] from frontmatter, block scalars excluded
    patch(raw, updates),// → new raw string, body preserved exactly
    widget(key, value, constraint), // → DOM input element with data-fm-key
}
```

**`parseFields`** — uses `indexOf('\n---', 3)` (not regex) to locate the FM boundary, so the body is never ambiguous. Skips lines whose value is `|` or `>` (block scalar headers).

**`patch`** — slices raw into `head` (opening `---` through FM content) and `tail` (`\n---` onward including body). Only patches `head`; concatenates `head + tail`. The body survives unchanged even if it contains `---` lines. Per-key: regex-replaces the line if the key already exists; **appends a new `key: value` line to `head` if it doesn't** (fixed 2026-07-14 — see "Three ways to fill in a note's fields" above; previously silently no-op'd for missing keys).

**`widget`** — returns a DOM element with `data-fm-key` set for Save to collect. Checkbox returns `String(checked)` (`'true'`/`'false'`).

---

## fm edit block (inline)

An alternative entry point — places the editor at a specific point in the note body, useful in long notes:

````markdown
```fm
edit |Edit Resource
```
````

The `fm` block dispatches to `_loadFmEdit(el)` when the body starts with `edit` (or the old `changes`). The label after `|` is optional (default `fm-edit`). Uses `NbWeb.fmUtils.form`. Renders a collapsed button that expands to the same form inline.

The toolbar FM button covers the universal case; the codeblock is optional.

---

## CSS classes

| Class | Purpose |
|-------|---------|
| `#nb-fm-edit-panel` | Static toolbar panel — flush under grey bar, `background: var(--bg2)` |
| `.nb-fm-edit` | Block wrapper |
| `.nb-fm-edit-inline-panel` | Inline block panel |
| `.nb-fm-edit-form` | Two-column grid (label + widget) |
| `.nb-fm-edit-row` | `display: contents` — one field row |
| `.nb-fm-edit-label` | Monospace field key (`.nb-fm-edit-new`: a declared field the note lacks) |
| `.nb-fm-edit-actions` | Save/Cancel button row |

---

## Adding constraints to a new notebook

**Preferred (folder config, current convention):**
1. Add a `constraints:` section to the folder's own `.{foldername}.md` (or the notebook root's `.{notebook}.md` for notebook-wide fields)
2. Mark genuinely required fields with `required: true` if you also want `/api/note/constraints-full` consumers (a fill-in-blanks modal, a check script) to know about them — see "Three ways to fill in a note's fields" above
3. `values:` must be a YAML list (`[a, b, c]`), not a bare comma-string — see the gotcha above
4. No restart needed — constraints are fetched live per note

**Legacy (still supported, lower priority):**
1. Create `~/.nb/<notebook>/.constraints.md` with relevant fields
2. Optionally add folder-scoped `.constraints.md` for subfolder-specific dropdowns
3. Folder-config `constraints:` for the same key will override this if both exist

## Access control

Server rejects `PUT /api/note` if the session user lacks write access. The button is hidden for locked notes (`note.locked`). No other client-side gating — server is the authority.
