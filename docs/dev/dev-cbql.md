<!-- Generated from docs:dev/dev-cbql.md by .tools/readme-export.py. Edit the source, not this file. -->

# CBQL — Codeblock Query Language

[Philosophy](#philosophy) · [Event Ledger](#the-event-ledger-model) · [Markers](#markers) · [Write-back](#write-back--action--marker) · [Full Loop](#the-full-loop) · [CBQL Read Path](#cbql-read-path) · [Reports Page](#reports-page) · [Pub/Sub](#pubsub-extension) · [Codeblock Types](#codeblock-types) · [Build Order](#build-order) · [Checks](#check-scripts) · [Open Questions](#open-questions)

---

## Philosophy

Most project management software makes you work for it — Gantt charts, requirement hierarchies, status meetings encoded as checkboxes. This model works the other way: you do the work in plain text, and the system reads it.

The project note is a **diary**. You write dated entries, record decisions, log time, note blockers. The system extracts structure from that prose — not the other way around. When you need a report, it assembles one from what's already there. When you invoice, it writes one line back into the diary as a receipt. Nothing is locked, nothing is mandatory, nothing is irreversible. Plain text throughout.

The goal is project management that feels like a pair of jeans — unobtrusive, comfortable, adapts to how you actually work.

---

## The Event Ledger Model

A project note is an **event log**. Two kinds of events accumulate in it over time:

**Typed codeblocks** — structured data records embedded in dated sections. Time entries, expenses, decisions, tasks, risks — whatever the project warrants. Each block is timestamped by the dated section heading it lives under.

**Markers** — plain-text state transitions (`> INVOICED: #001`, `> MILESTONE: Alpha`). They appear at the exact moment the event occurred. Position in the file is the timestamp.

Both kinds of events are written by two kinds of authors:

| Author | Examples |
|--------|---------|
| Human | Typed decisions, observations, hand-written `> MILESTONE:` |
| System | `> INVOICED:` written by the Invoice button, future webhook markers |

CBQL makes no distinction between the two. A marker written by a button click and one typed by hand are the same event in the log.

The **reports page** (`name-reports.md`) is a **projection** — a materialized view assembled by reading from the project note. It doesn't store data; it displays it. Change the source, the projection updates.

---

## Markers

Markers are plain-text lines recording state transitions. They live in the project note body at the exact point in the timeline where the event occurred.

### Syntax

```
> MARKER: REF - optional details
```

- `>` — standard markdown blockquote prefix (no new syntax)
- `MARKER` — ALL CAPS; determines color and meaning
- `: REF` — short reference (invoice number, milestone name, version, commit hash, etc.)
- `- details` — optional free text

### Vocabulary

| Marker | Color | Written by | Meaning |
|--------|-------|------------|---------|
| `APPROVED` | blue | human / action | Scope locked, work authorized |
| `MILESTONE` | green | human / action / CI | Phase or deliverable complete |
| `INVOICED` | red | Invoice button | Billing boundary — period closed |
| `DELIVERED` | purple | human / action | Work handed to client/user |
| `PAUSED` | amber | human / action | Work suspended |
| `RESUMED` | teal | human / action | Work restarted after pause |
| `CLOSED` | grey | human / action | Project terminal, filed |
| `TODAY` | gold | human (once, at setup) | Insertion cursor — see below |

Any ALL-CAPS word followed by `:` is a valid marker — the vocabulary above is the standard set, not an exhaustive list. Unknown marker types render in a neutral default color.

### TODAY — the insertion cursor

`> TODAY:` is a **positional marker**, not a state transition. It is a fixed stake planted once at project setup, between the living log and the planned future. It never moves.

The `+ Today` button inserts a new `## YYYY-MM-DD` heading immediately above `> TODAY:`, opens the editor, and positions the cursor on the blank line just below the new heading — ready to write. No hunting.

```
## 2026-07-02                  ← new heading inserted here by + Today
                               ← cursor lands here
> TODAY:                       ← fixed stake — stays put forever

> MILESTONE: internal-rc
- [ ] register nb-web.ca

> MILESTONE: self-hosted
```

**The natural multi-day flow** — the log grows upward toward the marker, the marker never moves:

```
## 2026-07-01
notes, timedot              ← day 1 done; CBQL counts this
## 2026-07-02
notes, timedot              ← day 2 done; CBQL counts this
## 2026-07-03
                            ← working here
> TODAY:                    ← boundary: above = done, below = future
milestones
```

CBQL `current` = everything **before** `> TODAY:` — all logged work is automatically in scope. Markers planned in the future (milestones) are automatically excluded.

**Rules:**
- Place `> TODAY:` once when setting up the project
- The marker stays put — it is a cursor, not a timestamp
- `+ Today` inserts above `> TODAY:` if it exists; falls back to before the first `> MILESTONE:`; falls back to end-of-file
- `+ Today` is idempotent within a day — today's heading already present means only the editor opens (cursor still positioned at the heading)

`TODAY` renders in gold (`#d4ac0d`) — distinct from state-change markers, visually marking the active zone boundary.

A bare `> TODAY:` (no ref) auto-fills with the current date and time on render — useful as a live "last opened" indicator.

### Phases

Markers divide the work log into **phases** — the space between two consecutive markers. The timeframe selector on the reports page navigates these phases. The project note accumulates phases over its lifetime; the reports page can show any one of them or all of them.

### Status

**Shipped 2026-07-01**: marker coloring generalized from INVOICED-only to any `> ALLCAPS:` pattern. `nbweb-specialty.js` regex + `styles.css` attribute selectors. `INVOICED` keeps its existing red color; all other markers now colored by type.

---

## Write-back — Action → Marker

This is the **inverse of CBQL**. CBQL reads from the project note to build projections. Write-back writes a marker *back* to the project note as the receipt of an action.

### Pattern

1. User triggers an action (button click, scheduled task, external webhook)
2. Action executes (invoice generated, email sent, deploy triggered, payment received)
3. On success: `writeMarker(source, type, ref, details)` appends one line to the project note in today's dated section
4. The marker is now part of the immutable event log

**Actions are ephemeral. Markers are the record.**

### Reversibility

Because the marker is just a line of text in a plain file, reversing an action is: delete the line. No database rollback, no status flags, no undo queue. The project note is the only durable state. Delete the marker, the action never happened as far as the system is concerned.

This is a feature. It makes experimentation safe. You can generate an invoice, look at it, decide it's not ready, and delete both the PDF and the marker line with zero consequence.

### writeMarker API

**Shipped 2026-07-03.** `POST /api/project/write-marker` — generic endpoint available to all plugins.

```
Body: { selector, marker, ref, position }
  selector  — note to write into (e.g. "Takeout:nb_web.md")
  marker    — ALLCAPS name; validated against ^[A-Z]{2,20}$
  ref       — optional reason/label appended after the colon
  position  — 'before_today' (default) | 'today_section' | 'end'
```

**Position modes:**

| Mode | Behaviour | Fallback |
|------|-----------|----------|
| `before_today` | Inserts line immediately before `> TODAY:` | Appends to end |
| `today_section` | Appends to today's `## YYYY-MM-DD` section; creates it if absent | Falls back to before_today insertion |
| `end` | Appends at end of file | — |

PAUSED/CLOSED use `before_today` (they belong in the living log, adjacent to the cursor). DELIVERED uses `today_section` (milestone closure is a dated event).

Plugin action buttons call this on success. The marker type is the plugin's to choose — hledger owns `INVOICED`, specialty owns `PAUSED`/`CLOSED`, codeblocks owns `DELIVERED`.

### External Write-back

Markers don't have to originate from a button in the UI. Any system that can write to a file can append a marker:

- CI/CD pipeline: `> MILESTONE: v2.1-deployed 2026-07-01` on successful deploy
- Payment processor webhook: `> PAID: INV-001 2026-07-01` on payment received
- Scheduled script: `> MILESTONE: monthly-backup 2026-07-01`

The project note becomes a single source of truth for everything that happened, regardless of whether a human or a system recorded it.

---

## The Full Loop

```
Human types codeblocks + markers
        ↓
System writes markers (Invoice btn, webhooks, CI)
        ↓
Project note accumulates events (plain text, git-versioned)
        ↓
Reports page fetches source on load
        ↓
Reports bar scans for markers → builds timeframe dropdown
        ↓
User selects timeframe → bar broadcasts context
        ↓
CBQL blocks re-render through selected timeframe lens
        ↓
Hand-written narrative interprets the generated data
```

One format (plain text markdown), one file (the project note), complete audit trail. The reports page is a window onto the event log, not a separate data store.

---

## CBQL Read Path

CBQL is the declarative read layer. Any codeblock type gains a **query mode** when `source:` is present: fetch matching events from source, filter by type and timeframe, render the result. Without `source:`, the block renders its inline content normally — backwards compatible.

### Syntax

````
```csv
source: name.md
filter: type=expense
timeframe: current
```
````

Parameters are YAML-style key/value pairs inside the fenced block. The renderer strips them before processing; they are never rendered as-is.

### Parameters

| Parameter | Description |
|-----------|-------------|
| `source:` | Where to read events from. Single note selector, or query expression (see [CBQL — Codeblock Query Language](#pubsub-extension)) |
| `filter:` | Which block types to include. Matches the fenced block info string (`decision`, `expense`, `timedot`, etc.) |
| `timeframe:` | Which phase of the event stream. See below |

### Timeframe Values

| Value | Meaning |
|-------|---------|
| `current` | From the last marker of any kind to now |
| `all` | Entire project history |
| `[marker-ref]` | The phase ending at that marker (`INVOICED: #002`) |

`current` is the default when `timeframe:` is omitted and `source:` is present. No markers found → `current` = `all`, silently.

**Phase semantics**: `INVOICED: #002` means "everything between the previous marker and the `#002` line" — the period that invoice covers. `current` means "everything since the last marker of any kind."

Explicit date ranges also valid:
```
timeframe: 2026-Q2
timeframe: 2026-01-01..2026-03-31
```

### Variable Resolution

`timeframe:` and `filter:` can be late-bound from the note's own FM:

```yaml
---
type: reports
source: name.md
period: current
---
```

````
```table
source: ${source}
timeframe: ${period}
filter: milestone
```
````

The renderer resolves `${key}` against the containing note's FM before executing the query. Declare `period:` once in FM; every CBQL block on the page inherits it. Changing `period:` regenerates all blocks.

### Renderer Behaviour

1. Parse block content for CBQL parameters — strip before rendering
2. Resolve `${variables}` from containing note's FM
3. If `source:` present: fetch source note(s) raw markdown via `/api/note`
4. Scan fenced blocks for info string matching `filter:`
5. Locate marker lines; restrict to `timeframe:` window
6. Pass collected records to the block's normal renderer as inline content
7. Render output

No matches → render empty state, not an error. Source unavailable → same.

---

## Reports Page

`name-reports.md` (`type: reports`, `source: name.md` in FM) is the projection surface.

### Context Provider / Consumer

The **reports specialty bar** is the context provider. CBQL blocks are consumers.

On load: the bar fetches source, scans for `> MARKER:` lines, builds the timeframe dropdown. CBQL blocks fetch source independently and hold their full dataset.

On timeframe change: the bar broadcasts a document-level `timeframe-changed` event. Every CBQL block on the page re-renders its held data through the new lens. **No re-fetch — instant.**

`source:` in the note's FM is shared by both bar and blocks — one declaration, one data pipe.

### Timeframe Dropdown

```
Current                         ← always first
────────────────────────────
INVOICED: #003   2026-05-01
MILESTONE: Alpha 2026-03-20
INVOICED: #002   2026-02-14
INVOICED: #001   2026-01-10
────────────────────────────
All                             ← always last
```

Markers in reverse chronological order. Each entry = the phase ending there. **Degenerate form**: one marker → Current / [marker] / All — equivalent to the existing 3-state toggle.

### Content Types

A reports page assembles three kinds of content:

| Content | Source | Mechanism |
|---------|--------|-----------|
| Phase timeline | Markers in project note | `timeline` CBQL block |
| Time totals | timedot blocks in project note | `hl` CBQL block |
| Task snapshot | tw: blocks or tw filter | `tw:` CBQL block |
| Deliverables list | Define section in project note | `{{inline: name.md#Deliverables}}` |
| Financials | hledger journal files | Existing `hl` blocks (unchanged) |
| Executive summary | Hand-written | Narrative prose |
| Decisions log | Hand-written | Narrative prose |

The ratio of generated to hand-written shifts by project type. A billing report is mostly generated; a retrospective is mostly narrative.

### Wikilinks vs Inline: which to use

Two mechanisms bring related content into a note. They serve different purposes:

| Mechanism | Syntax | Role |
|-----------|--------|------|
| Wikilink | `[[notebook:filename.md\|label]]` | Reference — navigate to, cite, acknowledge |
| Inline query | `{{inline: selector}}` | Participate — content is read, aggregated, computed |

**Use `[[wikilinks]]` for:**
- Plans, spec docs, design docs — things a reader should navigate to
- Related projects — cross-references without data dependency
- External references — links that provide context but don't affect numbers

**Use `{{inline:}}` for:**
- Timesheets that roll up into the current note's totals (e.g. `{{inline: accts:jim-timesheets.md}}`)
- Deliverable lists from a sub-contractor that feed the `checklist` CBQL block
- Any content that must be *included in a computation*, not just browsed

A reports page typically has both: wikilinks in the header/resources section (navigation), inline queries in the body (aggregation). The pattern is "link to the document, inline the data."

### Backwards Compatibility

Existing `hl` blocks querying hledger directly: **unaffected**. They have no `source:` param and no `timeframe:` param — they render exactly as before. The timeframe dropdown appears on the bar regardless but doesn't affect blocks that aren't listening. Opt-in only.

---

## Pub/Sub Extension

`source:` can be a query expression rather than a single note:

```
source: notebook:hansen          ← all notes in notebook
source: filter:client=Hansen     ← FM query across all notes
source: type:project             ← all project-typed notes
```

A subscriber aggregating blocks from multiple sources gets cross-project views without explicit links:

- Client dashboard: all `milestone` blocks from every project tagged `client: Hansen`
- Portfolio risk register: all `risk` blocks with `status: open` across all active projects
- Business expense roll-up: all `expense` blocks across all work notebooks

Publishers (project notes) declare nothing — typed codeblocks are naturally discoverable. The subscriber is the only active participant.

**Index requirement**: scanning codeblock content across many notes needs a maintained index (notes are already indexed by FM; codeblock content index is additive). Build before volume demands it, not after.

**Longer term** — this is the event sourcing / materialized view pattern at portfolio scale. Out of scope until single-project CBQL is solid.

---

## Codeblock Types

Which existing block types are natural CBQL participants:

| Type | Role | Readiness |
|------|------|-----------|
| `timedot` | Producer: time entries scattered in project log | Ready — needs timeframe wiring |
| `hl` | Consumer: aggregates timedot, shows totals | Ready — needs marker-based timeframe |
| `tw` | Both: tasks added in project, completion snapshot in reports | Ready — needs source/filter |
| `checklist` | Consumer: surfaces unchecked `- [ ]` deliverables from source project | New type needed |
| `query` | Consumer: already aggregates FM across notes; extend to codeblock content | Close |
| `timeline` | Consumer: renders markers from source as visual phase history | New type needed |

**Build order within types**: `timedot`/`hl` pair first (already in real use, lowest risk). `tw` snapshot second. `timeline` third (highest value for reports page opener). `checklist` is low-effort once the CBQL read path exists. `query` extension is the pub/sub on-ramp.

### Work item layers

Three systems handle work items in nb-web. They don't conflict — each occupies a different granularity and namespace:

| Layer | Syntax | File | System | Interactivity |
|-------|--------|------|--------|---------------|
| Deliverables | `- [ ] framing done` | `type: project` body | Markdown GFM | Static; read by `checklist` CBQL block |
| Todos | `# [ ] Note title` | `.todo.md` | nb native | Interactive toggles via `/api/todo` |
| Tasks | — | `~/.task` DB | Taskwarrior | `tw` codeblock; full TW integration future |

The discriminator between deliverables and nb todos is the **leading character**: `- [ ]` vs `# [ ]`. The `.todo.md` extension is the file-level signal; the `# [ ]` H1 is the open/closed state. Inside a `.todo.md`, sub-tasks use `- [ ]` under a `## Tasks` heading, wired to toggles in nb-web.

`- [ ]` in a project body is **not** an nb todo and **not** a TW task. It is a deliverable checkpoint — hand-managed, static, safe to aggregate via the `checklist` CBQL block. The `tw` codeblock reads Taskwarrior directly; markdown checkboxes are invisible to it and there is no conflict.

The `* [ ]` discriminator (used in taskwiki to namespace TW tasks in vim buffers) is not used here — our layers are already separated by file type and leading character.

---

## Build Order

| Step | What | Status |
|------|------|--------|
| 1 | Marker coloring — generic `> ALLCAPS:` regex, color by type | ✅ Shipped 2026-07-01 |
| 2 | `INVOICED` write-back via Invoice button | ✅ Existing (hledger plugin) |
| 3 | `project` + `project-reports` global templates; check: wiring | ✅ Shipped 2026-07-01 |
| 4 | Create-on-demand UX — pair chip pre-flight, popup, source: patch | ✅ Shipped 2026-07-01 |
| 5 | `POST /api/project/write-marker` — generic 3-mode write-back endpoint | ✅ Shipped 2026-07-03 |
| 6 | Timeframe dropdown on `type: reports` specialty bar | ✅ Shipped 2026-07-01 |
| 6a | `TODAY` marker + `+ Today` smart insertion (never crosses MILESTONE) | ✅ Shipped 2026-07-01 |
| 7 | CBQL read path — `timedot`/`hl` with marker-based timeframe | ✅ Shipped 2026-07-01 |
| 8 | `timeline` block type — renders markers from source | ✅ Shipped 2026-07-01 |
| 9 | `tw` CBQL source/filter support | ✅ Shipped 2026-07-01 |
| 10 | `checklist` block type — surfaces `- [ ]` deliverables from source | ✅ Shipped 2026-07-01 |
| 10a | `group: milestones` mode — deliverables grouped by event-log `> MILESTONE:` markers | ✅ Shipped 2026-07-01 |
| 11 | PAUSED/CLOSED buttons on reports specialty bar; DELIVERED on timeline milestone rows | ✅ Shipped 2026-07-03 |
| 12 | `timedot` blocks in project note as additional hledger source for `hl` CBQL blocks | ✅ Shipped 2026-07-03 — see [Project Diary — Journal Sync and CBQL Implementation](dev-project-diary.md) |
| 13 | Pub/sub multi-source `source:` queries | 📋 Long term |

Steps 3 and 4 are independent and can be built in parallel. Step 5 requires 4. Step 6 requires 4. Steps 3 and 8 are a natural pair.

### Step 11 design notes — Shipped 2026-07-03

**PAUSED / CLOSED** buttons live on the reports specialty bar (`nbweb-specialty.js`), visible when `status !== 'closed'`. Prompts for reason → POSTs to `/api/project/write-marker` with `position: 'before_today'`. On CLOSED: buttons disappear from the bar.

**DELIVERED** button appears on each MILESTONE row in the `timeline` block (`nbweb-codeblocks.js`). Prompts for a note → writes `> DELIVERED: milestone-ref` via `position: 'today_section'`.

Both use `data-source-sel` threaded down from the block's container `el.dataset.sourceSel` (set in `_loadTimelineCBQLBlock`), so the write target is always the source project note, not the reports page.

Action buttons warn (not block) if open deliverables exist under that milestone — not yet implemented; deferred to a future polish pass.

### Step 12 design notes — timedot-in-project as hledger source ✅ Shipped 2026-07-03

See [Project Diary — Journal Sync and CBQL Implementation](dev-project-diary.md) for the full implementation reference: file layout, sync mechanism, CBQL date range extraction, caveats, and unfinished business.



The **project note is the canonical session diary** — timedot blocks live inline under dated headings, not in a separate timelog file. The goal: an `hl` CBQL block in the reports note should aggregate those timedot blocks directly via `source:`, without requiring a separate `.journal` import.

**PoC contract** (to be defined):

```yaml
# In the hl: block on the reports page
source: nb_web.md
filter: timedot
timeframe: current
```

The `hl` renderer would: (1) fetch the source note raw, (2) extract all fenced `timedot` blocks in the current timeframe window, (3) concatenate them into a temporary timedot string, (4) pipe that to `hledger` with `-f timeclock:-` (or timedot format flag), (5) render the balance/register output.

**Open questions for Step 12:**
- hledger timedot input mode: does `hledger -f timedot:-` accept piped concatenated blocks?
- Timeframe slicing: does the marker-boundary logic run before or after fetching blocks?
- Interaction with existing `hl` journal config in `.Takeout.md` — additional source should be additive, not replace the primary journal.

---

## Check Scripts

Checks are the validation layer that makes CBQL trustworthy. CBQL assumes the project note is well-formed; checks guarantee it is. They also serve as the format documentation — a user who types `> invoiced:` (lowercase) gets a check failure explaining the correct form. The check IS the spec, enforced at review time.

Failure modes fall into five categories:

### Format violations

Things the marker regex silently ignores rather than errors on:

- `> invoiced:` — lowercase; not matched by `> [A-Z]{2,}:` regex; invisible in timeline and dropdown
- `> INVOICED #001` — missing `:` after marker name; won't parse
- `## 2026-7-1` — non-padded date heading; breaks chronological sorting and phase boundary detection

### Sequence errors

- Date headings out of order (pasted section, typo'd year)
- `> RESUMED:` with no preceding `> PAUSED:`
- `> CLOSED:` before `> DELIVERED:` — logically impossible ordering

### FM ↔ marker inconsistency

- `status: active` in FM but `> CLOSED:` marker in body
- `status: active` but `> PAUSED:` present with no subsequent `> RESUMED:`

### Pairing and reference integrity

- `source:` in reports FM points to a note that doesn't exist (renamed, moved)
- Reports note exists but no project pair, or vice versa
- CBQL `timeframe: INVOICED: #005` but source only has markers up to `#003` — silent empty result

### Missing structure

- Project note has no define sections (scope, deliverables, etc.) — blank page nudge
- Reports note missing `source:` FM — CBQL blocks have nowhere to read from

### Check scripts — ✅ All shipped

All 9 scripts live in `~/.nb/.checks/` and are wired into `docs:sysadmin.md` via `project-` and `report-` prefix selectors. Each is silent on pass, silent on non-matching note types.

| Script | What it catches |
|--------|----------------|
| `project-date-sequence.sh` | `## YYYY-MM-DD` headings out of chronological order or non-zero-padded |
| `project-marker-format.sh` | Marker lines missing colon or REF — invisible to timeframe dropdown |
| `project-marker-sequence.sh` | `RESUMED` without prior `PAUSED`; `CLOSED` not last; orphaned transitions |
| `project-status-marker-sync.sh` | FM `status:` disagrees with most recent marker in body |
| `project-reports-pair.sh` | `type: project` note missing its `-reports.md` partner |
| `report-source-exists.sh` | `source:` FM points to a note that doesn't exist (renamed/moved) |
| `report-source-is-project.sh` | `source:` FM resolves to a non-project note |
| `report-timeframe-refs.sh` | CBQL `timeframe: MARKER: ref` but that ref doesn't exist in source |
| `report-project-pair.sh` | Reports note has no corresponding project partner |

Naming follows existing `.checks/` prefix conventions.

---

## Open Questions

- `filter:` syntax — fenced block info string exact match only, or glob? (`filter: timedot` vs `filter: time*`)
- `${variable}` resolution scope — note FM only, or also walk up to notebook dotfile config?
- CBQL block caching — hold full dataset in memory after first fetch, or re-fetch when source note is saved?
- `timeline` block: render markers only, or also surfaced dated section headings as minor events?
- `write_marker()` position — **Resolved:** 3 explicit modes (`before_today` / `today_section` / `end`). Callers choose; no implicit logic needed.
- Multi-marker phases: `current` = since last marker of *any* type, or since last marker of a *specific* type? **Resolved:** `current` = everything before `> TODAY:` (the insertion cursor IS the phase boundary). Fallback: since last `INVOICED`/`CLOSED` marker. Final fallback: full body. MILESTONE markers are goals, not phase boundaries.
- External write-back authentication — webhook endpoint needs a token; scope for later

---

#wip
