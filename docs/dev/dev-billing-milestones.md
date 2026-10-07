<!-- Generated from docs:dev/dev-billing-milestones.md by .tools/readme-export.py. Edit the source, not this file. -->

# Milestone & marker-based billing (dev)

`nb-web`'s own quote/invoice generation backend (`app.py`) can group a project's billed work by
`> MILESTONE:` diary markers instead of producing one flat total. This is core `nb-web`
functionality, not part of the `nbweb-hledger` plugin's own JS — but it's exposed entirely
through that plugin's Quote/Invoice dialogs and the `timeline` codeblock's `$` toggle.

For end-user usage (where to place a marker, what the generated document looks like, the scope
options available), see [INVOICING](../plugins/hledger/INVOICING.md) § "Milestone-based billing." This
page is the technical narrative behind it, condensed from `nb-web` CLAUDE.md invariants
41/45/47/48/49/51/54/55/56/57/58 — read those in the repo for exact confirmation dates and
commit-level detail; this page is the standing reference.

## The marker-grouping engine

`_marker_groups(body, scope, marker_type='MILESTONE', boundary=None)` is the one generalized
function behind every milestone/marker feature in this codebase.

- **Achievement-style attribution, not heading-style.** A marker's group is everything
  *backward* to the previous same-type marker, up to and including its own line — not forward to
  the next marker. This was gotten backwards in the original implementation (corrected
  2026-09-01): every real diary in this system logs work, *then* drops the marker to stamp what
  was just finished — the same convention `> INVOICED:`/`> CLOSED:` already use. The bug was a
  systematic off-by-one: every milestone's computed content matched the *previous* milestone's
  label instead of its own.
- **Generalized to any `marker_type`, not just MILESTONE.** Filtering to one type happens
  *before* segmenting, so a diary can carry more than one independent marker vocabulary (e.g.
  `> MILESTONE:` for construction phase alongside a hypothetical per-unit `> CABIN: 15` on a
  multi-unit job) with zero interaction between them. `_milestone_groups(body, scope)` remains as
  a thin MILESTONE-specific wrapper for its two existing billing call sites.
- **`boundary` param** (a `"TYPE: ref"` string, matching the Timeline codeblock dropdown's own
  option values directly — no separate identifier scheme) drives `since_marker`/`until_marker`
  scopes. `until_marker` includes the named marker's own group (achievement-style: its own work
  counts as "up to and including it"); `since_marker` excludes it, matching `since_invoice`'s
  "strictly after" semantics.
- Content before a type's *first* marker in scope is absorbed into that marker's group — for
  `scope=all`/reports this means real leading diary content counts toward the first milestone;
  for `scope=future` it's a non-issue since the `> TODAY:` boundary already excludes anything
  before it.
- A label's own text (`"10. Second Bedroom"`) is opaque and never parsed for ordering — sequencing
  is purely diary line position.

## Scope vocabulary

| Scope | Quote | Invoice | Meaning |
|-------|:-:|:-:|---------|
| `since_invoice` | ✓ | ✓ | Cuts off by the last `> INVOICED:`/`> CLOSED:` marker's **embedded date**, not line position |
| `future` | ✓ | — | Real business-logic error for invoice (billing not-yet-done work) |
| `all` | ✓ | — | Real business-logic error for invoice (re-billing already-invoiced work) |
| `since_marker` | ✓ | ✓ | Everything after a named marker |
| `until_marker` | ✓ | ✓ | Everything through a named marker, inclusive |

Invoice's scope set is deliberately narrower (`_VALID_INVOICE_SCOPES`, not the full
`_VALID_BILLING_SCOPES` quote accepts) — both endpoints reject `future`/`all` outright rather
than producing a technically-valid-but-nonsensical result.

**Why `since_invoice` is date-based, not position-based**: `api_t_invoice_generate` used to
append its own `> INVOICED:` marker to the diary file's literal end, but new diary content is
always inserted *before* `> TODAY:`, near the top (`NbMain.insertBeforeToday`). Under a
line-position cutoff, every invoice after the first would show $0.00 forever — new content was
always structurally "before" the marker. `_line_for_date_after(lines, cutoff_date)` finds the
first `## YYYY-MM-DD` heading dated strictly after the cutoff instead, scanning the whole body
rather than trusting the marker's own position. (The marker placement itself was also fixed
separately — see "Marker placement" below.)

**A marker-relative scope has no flat-path fallback.** `_scope_predicate` doesn't recognize
`since_marker`/`until_marker` at all — both the shared preflight helper and the generate
endpoints guard this explicitly and return an honest zero rather than silently computing an
unfiltered `since_invoice` if a marker name doesn't match anything.

## RATE marker persistence across scope boundaries

A `> RATE:` marker is forward-looking and has no expiry — once set, it stays in
effect until the next one, however far away that is, completely independent of
where a `since_invoice`/`since_marker` scope's own slice happens to start.

`_marker_group_totals` used to hand each milestone group's own bounded slice to
`_parse_timedot_slice` with the note's raw frontmatter `rate:` as `start_rate` —
correct only by accident, for as long as no RATE marker had ever fired earlier in
the diary, outside that slice. Found live 2026-09-09 on
`djp:projects/Seaman/nathan/nathan.md`: `> RATE: 35` set 2026-07-10, never
repeated; every invoice through INV-2026-016 (flat/journal path — no MILESTONE
marker existed in scope yet) correctly billed $35/hr, since that path reads
pre-baked amounts off the generated journal, which itself walks the whole diary
from the top. The moment a MILESTONE marker existed inside a `since_invoice`
scope, generation switched to the milestone-grouped path and silently reverted
to the note's base rate ($30) for any group whose own slice didn't happen to
still contain the RATE line.

Fixed by `_rate_in_effect(lines, before_line, fallback_rate)` — scans the full
diary from line 0 (not just the group's own slice) for the last RATE marker
before the group's `line_start`, and that becomes the group's `start_rate`.
`_parse_timedot_slice` already correctly tracks a RATE marker that occurs *inside*
a slice; this only fixes the slice's *starting* rate. Regression test:
`test_quote_milestone_sections.py::test_rate_marker_before_scope_start_still_applies`.

## Quote vs. invoice presentation differences

Both share `_render_milestone_sections` — these are parameter differences, not separate code
paths:

1. **Materials are itemized per csv row** (description/qty/unit cost/total), not collapsed into
   one summary line — `_csv_token_items` extracts the rows. Since this lives in the shared
   renderer, invoice gets the same itemization for free, not just quote.
2. **A `scope=future` quote drops the Date column** on its labour table (`show_date` param) — a
   future entry's "date" is really just whichever diary heading it happened to sit under at
   authoring time, not a committed schedule; showing it next to a dollar amount implied a
   precision that doesn't exist yet. `scope=all` and invoice's own `since_invoice` (real,
   already-logged work) keep dates.
3. **Quote (only) interleaves checklist items with every other marker type** as childless
   headings, in true diary document order (`_slice_annotations_in_order`,
   `include_other_markers=True`) — invoice stays default-off, since an unrelated
   `> TODAY:`/`> INVOICED:` landmark inline would read as ambiguous scope on a one-way billing
   document. Get the ordering right by scanning the slice once, position-ordered — an earlier
   version built two separate lists (checklist, then markers) and concatenated them in a fixed
   bucket order, which put `> TODAY:` at the bottom of a section when it actually belonged at the
   top.
4. **A milestone with zero real cost data renders as a bare heading** (+ checklist items, if
   any) — no fabricated `$0.00` labour row. `_checklist_items_in_text` scans a milestone's
   backward-attributed slice for `- [ ]`/`- [x]` lines, explicitly skipping fenced code blocks so
   a materials/timedot block's own content is never mistaken for a real item. Quote must still
   list every milestone, even empty ones — just never with numbers that don't exist yet.

## The reports-vs-diary resolution gotcha

The real-world entry point for Quote/Invoice generation is always the **reports** note — that's
where the button lives — never the diary/project note directly. A `type: reports` note's own
body has no `> MILESTONE:` markers or timedot/csv blocks at all; those live only in the diary
note it reports on, referenced via the reports note's own `source:` field.

`_resolve_diary_source(note_path, meta, body)` returns `(diary_path, diary_body, effective_meta)`
— resolves `source:` when the selected note is `type: reports`, merging the diary note's meta in
as a fallback layer *under* whatever the originally-selected note already has. **Any
body- or frontmatter-dependent computation in `api_t_quote_generate`/`api_t_invoice_generate`
must go through this, never read `note_path`/`meta`/`body` directly.** This was a real, silent
integration gap for weeks: the marker-grouping engine was fully correct from the day it shipped,
but every real Generate-Quote click (always from the reports note in practice) silently fell
through to the older flat/journal-based path instead — masked because that fallback re-derives
its rate from real historical journal amounts and happened to still produce a plausible total
regardless of which note in the folder was selected.

## Preflight/generate parity

The preflight dialog's live preview must go through the **exact same computation** as the real
Generate action — a separate "close enough" approximation will eventually visibly disagree.
`_billing_summary_for_scope()`, shared by both preflight endpoints, makes the identical
milestone-groups-preferred decision generate already makes. Before this existed, preflight
always computed via the flat/journal-based path (filtering `future` by real wall-clock date)
while generate preferred the marker-grouped computation (filtering `future` by line position
relative to `> TODAY:`) — for a project with real milestone markers, preflight's `future` scope
could report `$0.00`/empty while generating that exact scope produced a real total. The dialog
was actively lying about what clicking Generate would do.

## Marker placement

`> INVOICED:` is inserted immediately before the literal `> TODAY:` line
(`_insert_before_today`), never appended to the file's end — new diary content is always
inserted near the top, so an end-of-file marker would land structurally after all future work,
backwards for a marker whose whole job is to define a billing cutoff. The same helper backs
`/api/project/write-marker`'s `position='before_today'` option (used by the Timeline's own
`> DELIVERED:` button), so both marker-writing code paths now agree.

## Known limitation, not yet built

Extending the `timeline` codeblock itself to render this same grouped/subtotaled view live in a
`*-reports.md` page — currently `_marker_groups` is wired into the two billing endpoints and the
read-only `GET /api/t/marker-groups` JSON endpoint (which itself only feeds the timeline's own
`$` toggle, MILESTONE-specific by default though the endpoint itself accepts any `marker_type`).

## Related

- `GET /api/t/marker-groups` — read-only JSON sibling of the markdown generators
  (`selector`/`marker_type`/`scope` → `{groups, grand_total, btype}`), no note written, no
  billing event.
- End-user walkthrough: [INVOICING](../plugins/hledger/INVOICING.md)
- Original design doc: `claude:nbweb-hledger_plugin_design.md`
- `nb-web` CLAUDE.md invariants 41, 45, 47, 48, 49, 51, 54, 55, 56, 57, 58 — condensed pointers to
  this page as of 2026-09-08.
