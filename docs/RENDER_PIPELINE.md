<!-- Generated from docs:RENDER_PIPELINE.md by .tools/readme-export.py. Edit the source, not this file. -->

> Moved to [render-pipeline](dev/dev-render-pipeline.md) — this file is a redirect stub.

# Render Pipeline Redesign

**Status:** Tiers 1, 2, 3a, 3c complete — pipeline redesign done  
**Priority:** High — rendering is the primary UX bottleneck for books and complex notes  
**Tracking:** 3b (render cache) shelved; 3c shipped 2026-06-14

---

## Current Architecture

### The happy path (simple note)

```
openNote(selector)
  └── fetch /api/note
        └── renderPreview(note)
              └── content.innerHTML = rendered markdown
                    └── _finishRendered(content, note)
                          ├── _enrichRendered(content, note)
                          │     ├── _resolveInlineQueries   ← creates {{}} spans, fires ALL fetches
                          │     ├── _renderCsvBlocks
                          │     ├── NbWeb.renderCodeblocks  ← fires ALL check scripts
                          │     ├── Prism highlighting
                          │     ├── copy buttons
                          │     └── wikilink handlers + _resolveWikilinks
                          ├── _buildToc                     ← if toc:true or type:book
                          ├── _watchInlineTocRebuild        ← MO + nb-tests-settled
                          └── _appendAnnotation
```

### The book problem

A `type: book` with 8 chapters and 4 test blocks per chapter:

```
_resolveInlineQueries fires 8 × _resolveInlineInclude  ← 8 simultaneous fetches
NbWeb.renderCodeblocks fires 32 check scripts           ← 32 simultaneous API calls
_resolveWikilinks fires K title lookups                ← K simultaneous fetches

Total: 40+ simultaneous API calls, all racing
```

Each resolved include calls `_enrichRendered` on the chapter, which fires
another round of test blocks and wikilink lookups for that chapter's content.

---

## Identified Bottlenecks

### 1. Thundering herd

Everything async fires at the same instant. The server and the DOM receive a
burst of 40+ requests with no ordering or priority. Content lands in arbitrary
order — whatever the network returns first.

### 2. No concept of "done"

There is no signal for "all async rendering is complete." The `nb-tests-settled`
event fires per-container and may bubble, causing premature or duplicate
signals. The MO-based TOC rebuild watches a moving target and may trigger dozens
of times before quieting.

### 3. MutationObserver is too broad

`_watchInlineTocRebuild` uses `{childList:true, subtree:true}` on the entire
rendered div. Every test output, every wikilink label, every injected chapter
resets the 500 ms debounce. For a busy book the TOC never stabilises until
everything goes quiet — which may be many seconds after the first chapter
appears.

### 4. Static and async work are mixed

`_enrichRendered` interleaves synchronous work (event handler wiring, copy
buttons) with async work (inline fetches, check scripts). This makes it
impossible to reason about timing, creates race conditions, and means the
synchronous work runs multiple times (once per chapter enrichment).

### 5. Test blocks race inline includes

Test blocks and inline fetches are peers. A test block that depends on the
note being "rendered" (e.g. `note-slow`) may run before or after inline
content lands. There is no way for a test block to know what else is pending.

### 6. No progressive visibility

For books, the user sees a blank pane until ALL chapters have fetched and
rendered. Parallel fetches complete at similar times so the book "pops in" all
at once rather than appearing progressively.

---

## Redesign Plan

### Tier 1 — Low effort, high impact

These two changes fix the MO fragility, the race conditions, and perceived
render speed for books. They are the immediate implementation target.

#### 1a. Sequential inline includes (top-to-bottom)

**Problem:** All inline fetches fire simultaneously; content lands in random
order; the user waits for the slowest fetch before seeing anything.

**Solution:** `await` each `_resolveInlineInclude` before starting the next.
Chapters appear one at a time, top-to-bottom. Above-fold content is visible
within one round trip instead of N.

**Trade-off:** Total wall-clock time is similar or slightly longer, but
perceived time is dramatically better. The user reads chapter 1 while chapter 2
fetches.

**Implementation target:** `_resolveInlineQueries` (line ~1045 in main.js as of the 2026-07-06 modularization — line numbers drift with every extraction tier; grep for the function name rather than trusting this citation):

```javascript
// Current — fires all at once:
for (const span of spans) {
    if (provider === 'inline') {
        _resolveInlineInclude(span, query, note);   // no await
        continue;
    }
    ...
}

// Revised — sequential:
const inlineSpans = spans.filter(s => s.dataset.provider === 'inline');
const otherSpans  = spans.filter(s => s.dataset.provider !== 'inline');
// Fire non-inline queries in parallel (they're cheap single-value lookups)
for (const span of otherSpans) { /* existing fetch logic */ }
// Await each inline include in document order
(async () => {
    for (const span of inlineSpans) {
        await _resolveInlineInclude(span, span.dataset.query, note);
        // optional: _pendingInlines-- here for count-based TOC
    }
    _onAllInlinesResolved(container, note);
})();
```

#### 1b. Count-based completion — replace MutationObserver

**Problem:** The MO fires on every DOM mutation and must be debounced. It fires
too early, too often, and was the cause of a CPU loop bug.

**Solution:** Track a `pendingInlines` counter. Set it when inline spans are
created. Decrement on each `_resolveInlineInclude` completion (success or
error). When it reaches zero, rebuild the TOC exactly once.

```javascript
// Set in _resolveInlineQueries, stored on the container:
container._pendingInlines = inlineSpans.length;

// In _resolveInlineInclude finally block:
container._pendingInlines = Math.max(0, (container._pendingInlines || 1) - 1);
if (container._pendingInlines === 0) {
    container.dispatchEvent(new CustomEvent('nb-inlines-settled', {bubbles: false}));
}

// In _watchInlineTocRebuild — listen for both signals, rebuild once:
let rebuilt = false;
const rebuild = () => { if (rebuilt) return; rebuilt = true; _buildToc(...); };
container.addEventListener('nb-inlines-settled', rebuild, {once: true});
container.addEventListener('nb-tests-settled',   rebuild, {once: true});
```

With sequential includes (1a), `nb-inlines-settled` fires exactly when the
last chapter renders — no debounce needed.

The MO is removed entirely. `_watchInlineTocRebuild` becomes
`_watchForTocRebuild` with a simple event listener.

#### 1c. Synchronous rendering notice

**Problem:** `note-slow.sh` outputs the rendering notice as an async test
block result. By the time the notice appears, inline fetches have already
started or completed — the countdown is broken.

**Solution:** Inject the notice synchronously in `_enrichRendered`, immediately
after `_resolveInlineQueries` creates the span placeholders. The notice exists
before the first async call fires.

```javascript
function _enrichRendered(container, note) {
    _resolveInlineQueries(container, note);   // creates spans
    _injectRenderingNotice(container);        // sync, before any async
    _renderCsvBlocks(container);
    NbWeb.renderCodeblocks(container);
    ...
}

function _injectRenderingNotice(container) {
    const rendered = container.querySelector('.nb-rendered') ?? container;
    if (rendered.closest('.nb-inline-content')) return;  // skip chapters
    const n = rendered.querySelectorAll(
        '.nb-inline-query[data-provider="inline"]').length;
    if (n < 5) return;
    const el = document.createElement('div');
    el.className = 'nb-rendering-notice';
    el.dataset.remaining = n;
    el.innerHTML = `⏳ <span class="nb-rn-label">Rendering</span>` +
        `<span class="nb-rn-rest"> — ` +
        `<span class="nb-rn-count">${n}</span> includes to fetch</span>`;
    rendered.prepend(el);
}
```

The countdown in `_resolveInlineInclude.finally` counts actual remaining
spans (not a stored decrement) so it's always accurate:

```javascript
} finally {
    const notice = rendered?.querySelector('.nb-rendering-notice');
    if (notice) {
        const rem = rendered.querySelectorAll(
            '.nb-inline-query[data-provider="inline"]').length;
        const cntEl = notice.querySelector('.nb-rn-count');
        if (cntEl) cntEl.textContent = rem;
        if (rem === 0) notice.remove();
    }
}
```

`note-slow.sh` is retired — the JS handles detection. The amber CSS stays.

#### 1d. _StatusPill — generic render progress indicator ✅ (commit 92dd2cf, 2026-06-13)

A type-blind async-work counter pill in the preview toolbar (`.nb-toolbar-left`,
right of ☰ and ◉). Shows `⟳ N` while any render work is pending, flashes `✓`
on completion. **Clicking the pill force-loads all pending lazy spans immediately.**

**API:** `NbWeb.statusPill` — shared reference, safe to call from any plugin.
- `NbWeb.statusPill.add(n)` — register n units of pending work
- `NbWeb.statusPill.tick()` — one unit complete
- `NbWeb.statusPill.registerForce(fn)` — register a lazy-span force-load callback

**Coverage** (every async render path is wired):
- Inline includes (eager + lazy) — per span
- Non-inline `{{date:}}` / `{{weather:}}` queries — per span
- All codeblock renderers: `tw`, `hledger`, `nav`, `front`, `t`, `nb`, `git`, `test` — per block

**Design principle:** the pill knows nothing about render types. Any new async
render path (future plugins, new block types) wires in with two lines:
`NbWeb.statusPill?.add(blocks.length)` before the batch and
`NbWeb.statusPill?.tick()` per completion.

**Also fixed in this commit:**
- Bug: `nb-tests-settled` listener in `_finishRendered` removed notice prematurely
  (now retired — bar + pill replace the in-content notice entirely)
- Bug: TOC only showed eager chapters — `_scheduleTocRebuild` (debounced 400ms)
  replaces the `rebuilt` flag; each lazy chapter load triggers a debounced rebuild
- `_watchInlineTocRebuild` listens for `nb-inlines-settled` or `nb-tests-settled`
  and calls `_scheduleTocRebuild` (not a one-shot rebuild); lazy chapters each call
  it directly from `_deferInlineInclude`

**Also shipped:** `_RenderBar` — thin amber stripe across top of content for eager
inlines. Settings: Auto (n≥5) / Always / Never (Appearance section of settings.html).

---

### Tier 2 — Medium effort, durable improvements

#### 2a. IntersectionObserver for below-fold content

Inline includes and test blocks below the viewport are deferred until the user
scrolls near them. Above-fold chapters render eagerly; the rest use
`IntersectionObserver` with a generous rootMargin (e.g. 300px) to pre-fetch
just before they enter the viewport.

Implementation: in `_resolveInlineQueries`, instead of immediately dispatching
an inline fetch for every span, attach an IntersectionObserver. When the span
enters the extended viewport, fire `_resolveInlineInclude`.

This is especially powerful for long books. Chapters 1-2 appear immediately;
chapters 7-12 never fetch if the user navigates away.

#### 2b. Separate static from async enrichment

Split `_enrichRendered` into two functions:

- `_wireContainer(container, note)` — synchronous only: event handlers,
  copy buttons, wikilink click wiring, Prism on already-present code blocks.
  Safe to call multiple times.

- `_fetchContainer(container, note)` — async only: inline includes, test
  scripts, wikilink label resolution.

This eliminates the class of bugs where static wiring depends on async timing,
and makes it possible to re-wire without re-fetching (needed for the book
render cache).

#### 2c. nb-tests-settled scoping

Audit whether `nb-tests-settled` is dispatched with `bubbles: true`. If it
is, chapter-level events are reaching the main container, causing premature
dismissal of the rendering notice and premature TOC rebuilds.

Fix: dispatch with `bubbles: false`, or check `e.target === container` in all
listeners.

---

### Tier 3 — Larger refactor, high payoff

#### 3a. Test block batching

Replace M individual `/api/run?script=X` calls with a single:

```
POST /api/test-blocks
{ scripts: ["hl-core-journal", "nb-dirty", "sys-disk-warn"],
  context: { NB_NOTE_PATH: "...", NB_NOTEBOOK: "...", ... } }
→ [{ script: "hl-core-journal", exit: 0, output: "" }, ...]
```

For a book with 32 test blocks, this is 1 round trip instead of 32. Server
runs them in parallel (bash scripts are cheap). The client gets all results in
one response and injects them into the DOM.

This requires a new Flask endpoint and a change to `NbWeb.renderCodeblocks`
to accumulate scripts and fire one batched call rather than individual calls.

#### 3b. Book render cache

**Status: shelved** — pipeline is fast enough; previous auto-cache attempt reverted as too brittle.

**If revisited:** opt-in via frontmatter `cache: true` rather than automatic.
This limits caching to notes the author explicitly marks as stable (books,
reference docs, CoA pages). Notes with live data (daily notes, bookkeeper.md,
any note with `tw`/`hledger` codeblocks) are never cached — the author simply
omits `cache: true`.

Cache key: `selector:mtime`. Snapshot the settled DOM after `nb-inlines-settled`
+ `nb-tests-settled` both fire. Second visit restores the snapshot and skips
the full render pipeline.

Depends on: 1a (sequential) + 1b (count-based completion, defines "settled").

#### 3c. Phased render pipeline

Define explicit render phases with gates:

```
Phase 0 (sync):    markdown render, static HTML
Phase 1 (async):   above-fold inline includes
Phase 2 (async):   remaining inline includes (or IntersectionObserver)
Phase 3 (async):   test blocks (or batched — see 3a)
Phase 4 (async):   wikilink label resolution
Phase 5 (once):    TOC build, annotation append
```

Each phase completes before the next begins. The completion signal after Phase
2+3 is `nb-inlines-settled` AND `nb-tests-settled` (both, not race).

This replaces the current "fire everything, hope it converges" model with a
predictable, debuggable pipeline. It's the end state — Tiers 1 and 2 are
incremental steps toward it.

---

## Implementation Order

| Step | Tier | Depends on | Expected impact |
|------|------|------------|-----------------|
| Sequential inline includes | 1a | — | Perceived speed, top-to-bottom UX |
| Count-based TOC, remove MO | 1b | 1a | Stable TOC, kills debounce fragility |
| Sync rendering notice | 1c | 1a | note-slow actually works |
| Retire note-slow.sh | 1c | 1c | Clean up script |
| IntersectionObserver | 2a | 1a | Long books, deferred fetch |
| Static/async split | 2b | 1b | Race conditions, re-wire safety |
| nb-tests-settled audit | 2c | — | Premature cleanup bug |
| Test block batching | 3a | 2b | API call reduction |
| Book render cache | 3b | 1a, 1b | Second visit speed |
| Phased pipeline | 3c | 2b, 3a | Full redesign, end state |

---

## CSS Alert Colors

The amber/gold palette introduced for `note-slow` (rendering notice) is
now a standard "alert" color — informational warnings that are not errors.

```css
/* In styles.css: */
--alert:        #c69026;                    /* amber text / icon */
--alert-bg:     rgba(198, 144, 38, 0.12);  /* subtle amber fill */
--alert-border: rgba(198, 144, 38, 0.38);  /* amber stroke */
```

Use for: rendering notices, slow-render badges, in-progress indicators,
non-critical warnings that don't warrant the red error treatment.

Do not use for: errors, validation failures, destructive actions (those stay red).

---

## Files

- `~/dev/nb-web/main.js` — all rendering logic: `_enrichRendered`,
  `_resolveInlineQueries`, `_resolveInlineInclude`, `_finishRendered`,
  `_watchInlineTocRebuild`, `renderPreview`
- `~/dev/nb-web/styles.css` — `.nb-rendering-notice` and alert color palette
- `~/dev/nb-web/app.py` — Flask endpoints including future `/api/test-blocks`
- `~/.nb/.checks/` — check scripts; `note-slow.sh` to be retired in Tier 1

---

Developer internals: [render-pipeline](dev/dev-render-pipeline.md)
