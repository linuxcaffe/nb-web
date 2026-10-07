<!-- Generated from docs:dev/dev-xref.md by .tools/readme-export.py. Edit the source, not this file. -->

# XREF internals

Developer reference for the `xref:` cross-reference feature. User docs: [xref — Cross-Reference Enrichment](../xref.md).

---

## How matching works

### The stem index

When an xref-enabled note opens, nb-web calls `/api/xref` with:
- `target=hledger:` (or folder-scoped)
- `stems=reconcili,anomali,period,balance,...` — stemmed words extracted from headings

On the server, every target note is indexed once (cached until its directory mtime changes). The index maps **word stems → note entries**. A note's title and its annotation sidecar text are both indexed.

### Stemming rules

Both Python (server) and JavaScript (client) apply the same suffix-stripping rules, in order:

| Suffix removed | Replacement |
|---|---|
| `ations`, `ation` | (none) |
| `ings`, `ing` | (none) |
| `ions`, `ion` | (none) |
| `ments`, `ment` | (none) |
| `ness` | (none) |
| `ities`, `ity` | (none) |
| `ies` | `y` |
| `ves` | `f` |
| `ed`, `ly`, `er` | (none) |
| `es`, `s` | (none) |

Each word must be at least 4 characters before stemming; the resulting stem must be at least 3 characters.

### Prefix matching

After stemming, a heading word stem matches an index stem if:
- **Exact match** — always matches, regardless of length
- **Prefix match** — either stem starts with the other, and the shared prefix is ≥ 5 characters

This handles plurals, conjugations, and compound forms without a full morphological analyser.

---

## Books and forceAll()

`type: book` notes use `{{inline:}}` to pull in chapters lazily (viewport-driven). xref needs all headings before it can inject references, so it hooks into the inline loading sequence:

1. **Eager inlines** (chapters near the viewport) load sequentially; `nb-inlines-settled` fires when done.
2. xref checks whether deferred chapters remain; if so calls `forceAll()` — triggers every outstanding inline fetch immediately rather than waiting for the user to scroll.
3. `nb-inlines-complete` fires when the last chapter resolves.
4. xref scans all headings across all chapters.

Side effect: opening a book with `xref:` front-loads all chapter fetches. On a local server this is imperceptible; the status pill counts them all down at once up front. For very long books, add `xref:` to individual chapter notes instead of the book root to avoid forcing all fetches eagerly.

---

## API reference

```
GET /api/xref?target=<target>&stems=<stem1>,<stem2>,...
```

| Parameter | Description |
|---|---|
| `target` | `notebook:` or `notebook:folder/` |
| `stems` | Comma-separated list of already-stemmed words to look up |

Returns a JSON object keyed by stem, each value an array of `{selector, title}` entries:

```json
{
  "reconcili": [
    {"selector": "hledger:reconciliation.md", "title": "hledger reconciliation"}
  ],
  "anomali": [
    {"selector": "hledger:check.md", "title": "hledger check"}
  ]
}
```

The cache is per-target-string and invalidated by directory mtime. No auth required (nb-web is a local tool).

---

## Config-chain inheritance

`xref:` is resolved via `effective_xref` in the `api_note` response alongside `effective_access` and `effective_checks`:

```python
'effective_xref': (nb_meta['xref'] or '') if 'xref' in nb_meta else None,
```

- Key **present** with any value (including bare `xref:` → Python `None`) → normalize to `""` (suppress)
- Key **absent** from config chain → return `None` → JS falls through to note's own `meta.xref`

This means `null` (JSON) = "not set in chain, check note FM" and `""` = "explicitly suppressed at this level." The `??` operator in JS correctly distinguishes them because `??` only falls through on `null`/`undefined`, not `""`.

In `main.js`, both the guard and `xrefRaw` use `effective_xref ?? meta.xref`:

```javascript
if (note?.effective_xref ?? note?.meta?.xref) _enrichXref(container, note);
// ...
const xrefRaw = note.effective_xref ?? note.meta?.xref;
```

---

## `data-xref-heading` — extending xref beyond headings

The xref scanner queries:

```javascript
rendered.querySelectorAll('h1,h2,h3,h4,h5,h6,[data-xref-heading]')
```

Any element with `data-xref-heading` participates in xref exactly like a real heading. The stemmer reads `.textContent` from each element; the attribute value is ignored (the text is the signal).

**Two sites currently emit `data-xref-heading`:**

| Site | Element | When |
|------|---------|------|
| `_buildConfigForm` (`main.js`) | `.nb-cfg-label` spans in the dotfile config dialog | Always — one per config field (`access`, `pinned`, `check`, …) |
| `_configRender` (`nbweb-codeblocks.js`) | `<span>` key names in the "all keys" value cell | Config codeblock in show-all-keys mode |
| `_configRender` (`nbweb-codeblocks.js`) | `.nb-config-key-label` div | Config codeblock in single-key mode |

**Adding `data-xref-heading` to a new element** is the extension point for any renderer that wants its labels to participate in xref — no changes to the xref scanner needed.
