<!-- Generated from docs:dev/dev-codeblock-authoring.md by .tools/readme-export.py. Edit the source, not this file. -->

# Codeblock Authoring

Guide for writing `codeblockRenderers` entries in nb-web plugins. See [CODEBLOCKS](../CODEBLOCKS.md) for the user-facing reference and [DEVELOPERS](../DEVELOPERS.md) for the broader plugin API.

---

## Anatomy of a renderer

Each entry in `codeblockRenderers` has three fields:

```javascript
{
    lang:   'myblock',
    html:   text => `<div class="nb-my-block" data-query="..."></div>`,
    render: async container => { /* fetch, build, tick */ },
}
```

| Field | Purpose |
|---|---|
| `lang` | Fence language tag — ` ```myblock ` triggers this renderer |
| `html` | Synchronous: raw fence text → placeholder HTML injected into the note |
| `render` | Async: called once per container with all blocks of this type |

---

## Required: status pill wiring

Every renderer **must** call `NbWeb.statusPill` so the toolbar counter tracks its work:

```javascript
render: async container => {
    const blocks = [...container.querySelectorAll('.nb-my-block')];
    if (!blocks.length) return;
    NbWeb.statusPill?.add(blocks.length);          // register N pending items
    await Promise.all(blocks.map(async el => {
        await _loadMyBlock(el);
        NbWeb.statusPill?.tick();                  // one tick per completion
    }));
},
```

**`?.` (optional chaining)** — the pill is injected by `main.js`; `?.` keeps renderers safe in contexts where the pill isn't present.

**Spread to `[...]`** — `querySelectorAll` returns a live NodeList; freezing it before async work starts prevents mutations during rendering from affecting iteration.

**Sequential instead of parallel** — use a `for...of` loop when blocks share initialisation state (e.g. `chart`, which touches a shared canvas library):

```javascript
for (const el of blocks) {
    await _loadMyBlock(el);
    NbWeb.statusPill?.tick();
}
```

---

## html() — the placeholder

```javascript
html: text => `<div class="nb-my-block" data-query="${text.trim().replace(/"/g, '&quot;')}"></div>`,
```

- Store the raw fence text in `data-*` for `render()` to read back
- Escape `"` → `&quot;` — the value lands inside an HTML attribute
- Add `<span class="nb-spin">⟳</span>` for visually large blocks; omit for invisible ones (e.g. `test` Form 2 blocks that vanish on pass)

---

## Header conventions

Every block with a visible header follows the same layout:

```
[icon]  [block-name]  [count]  [filter/query]     [actions: ? ↻]
```

- **Left — icon**: app/block-type image or glyph. Always visible — in both collapsed and expanded states. Identifies the block type at a glance. Each block type owns its own icon.
- **Left — meta span**: block-name label + optional count + optional filter code
- **Right — actions span**: action buttons, always ending with ↻ refresh. `?` help popover is standard for blocks with non-obvious query syntax.

The block-name label is **clickable** — it opens the external app, or Settings if the app isn't configured. This gives the block a single obvious "launch" affordance without a dedicated button.

```javascript
const hdr  = document.createElement('div');
hdr.className = 'nb-my-header';

// Left: name (clickable) + count + filter
hdr.innerHTML =
    `<span class="nb-my-meta">` +
        `<span class="nb-my-name" title="Open in myapp">myblock</span>` +
        `<span class="nb-my-count">${items.length}</span>` +
        (q ? ` <code>${_esc(q)}</code>` : '') +
    `</span>`;

hdr.querySelector('.nb-my-name').addEventListener('click', () => {
    // open external app, or fall through to Settings
    NbTerminal.openSettings('sec-codeblocks');
});

// Right: action buttons
const acts = document.createElement('span');
acts.className = 'nb-my-actions';

const refBtn = document.createElement('button');
refBtn.className = 'nb-tw-btn';
refBtn.title = 'Refresh'; refBtn.textContent = '↻';
refBtn.addEventListener('click', () => _loadMyBlock(el));
acts.appendChild(refBtn);

hdr.appendChild(acts);
el.appendChild(hdr);
_initCollapseToggle(el);
```

**Rules:**
- Count is omitted when not meaningful (e.g. a single-result block)
- Filter/query only shown when the block has a non-empty query
- ↻ refresh is **always** the last action button
- Use `nb-tw-btn` for all action buttons — it's the shared codeblock button style
- `_initCollapseToggle(el)` is called once, after the header is appended

---

## Collapse toggle

The **whole header bar** is the collapse toggle — not a button inside it. Clicking anywhere on the header (except action buttons, which `stopPropagation`) collapses or expands the block. This is essential for mobile where small tap targets fail.

Call `_initCollapseToggle(el)` after the header is appended. It wires the header click, persists state in `localStorage`, and applies the stored state on load. Requires a `[class*="-header"]` child inside the block — the CSS selector `[class*="-header"]` automatically gives all headers `cursor: pointer; user-select: none`.

Action buttons inside the header **must** call `e.stopPropagation()` to avoid triggering the toggle.

```javascript
const refBtn = document.createElement('button');
refBtn.addEventListener('click', e => { e.stopPropagation(); _loadMyBlock(el); });

// After all DOM is built:
_initCollapseToggle(el);
```

No `▼/▶` indicator button — the block's **icon** (left side of header) is always visible and identifies the type in both collapsed and expanded states. Design an icon for your block type.

---

## Error handling

Always catch fetch errors and replace the spinner with a visible message — never leave it spinning silently:

```javascript
try {
    const d = await fetch(`/api/my-endpoint?q=...`).then(r => r.json());
    if (d.error) { el.innerHTML = `<span class="nb-my-error">⚠ ${_esc(d.error)}</span>`; return; }
    _buildMyBlock(el, d);
} catch (e) {
    el.innerHTML = `<span class="nb-my-error">⚠ ${_esc(e.message)}</span>`;
}
```

`_esc()` is defined at the top of `nbweb-codeblocks.js` — copy it into your plugin:

```javascript
const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
```

---

## Refresh button

Every block that fetches live data should have a refresh button:

```javascript
const refBtn = document.createElement('button');
refBtn.className = 'nb-tw-btn';
refBtn.title = 'Refresh';
refBtn.textContent = '↻';
refBtn.addEventListener('click', () => _loadMyBlock(el));
```

`nb-tw-btn` is the shared small-button style used across all codeblocks.

---

## NbWeb API available to plugins

| Call | Purpose |
|---|---|
| `NbWeb.statusPill?.add(n)` | Register n pending items in the toolbar counter |
| `NbWeb.statusPill?.tick()` | Mark one item complete |
| `NbWeb.checkWhich(bin)` | Check if a binary is on PATH; returns `{found, path}` |
| `NbWeb.renderRequirementsCard(el, mdPath)` | Replace el with a "not installed" card |
| `NbMain.openNote(selector)` | Navigate to a note |
| `NbMain.activeSelector()` | Selector of the currently open note |
| `NbNav.notebook` | Current notebook name |
| `NbTerminal.run(cmd)` | Open terminal pane and run a command |
| `NbTerminal.openSettings(sectionId)` | Open Settings scrolled to a section |

---

## previewRenderer plugins: use NbMain.renderMarkdown

If your plugin registers a `previewRenderer`, **never call `marked.parse(body)` directly** on note body content. Use `NbMain.renderMarkdown(body, note.selector)` instead.

`marked.parse()` runs the bare markdown parser. `NbMain.renderMarkdown()` runs the nb-web-augmented version that:
- Converts fenced code blocks to live widget divs (`<div class="nb-chart-block">` etc.) so `NbWeb.renderCodeblocks` can find and render them
- Pre-processes `[[docs:wikilinks]]` into clickable spans
- Rewrites relative image paths to `/api/file?selector=…`

Calling `marked.parse()` directly means any `chart`, `hledger`, `tw`, or other live blocks in the note body silently render as static code, and the StatusPill never fires for them.

```javascript
// Wrong — bypasses codeblock renderers and wikilinks
const bodyHtml = marked.parse(body);

// Right
const bodyHtml = NbMain.renderMarkdown(body, note.selector || '');
```

The only safe use of `marked.parse()` directly is for content you own entirely (e.g. synthesised strings with no user-authored fenced blocks or wikilinks).

---

## Checklist

- [ ] `NbWeb.statusPill?.add(blocks.length)` called before work begins
- [ ] `NbWeb.statusPill?.tick()` called once per block — success **and** error paths
- [ ] Early return if `!blocks.length`
- [ ] Errors replace the spinner with a visible message
- [ ] Refresh button wired to re-run the load function; calls `e.stopPropagation()`
- [ ] All header action buttons call `e.stopPropagation()`
- [ ] `_initCollapseToggle` called after header is appended (if block has a header)
- [ ] Block has an icon in the header left — visible when collapsed to identify type
- [ ] `html()` escapes `"` → `&quot;` in data attributes
- [ ] `querySelectorAll` result spread to `[...]` before async work begins
- [ ] `previewRenderer` uses `NbMain.renderMarkdown()`, not `marked.parse()`
