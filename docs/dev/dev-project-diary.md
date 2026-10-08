<!-- Generated from docs:dev/dev-project-diary.md by .tools/readme-export.py. Edit the source, not this file. -->

# Project Diary — Journal Sync and CBQL Implementation

This document covers the concrete implementation of the project diary system: how time and expense data flows from inline blocks in a project note through to generated journal files and live CBQL reports. See [CBQL — Codeblock Query Language](dev-cbql.md) for the conceptual design and marker/event model.

---

## Mental model — the three-layer architecture

Get this wrong once and you'll spend two sessions rediscovering it.

**Layer 1 — The diary** (`jones.md`, `type: project`)
The only place humans write. Date headings, prose, timedot blocks, csv blocks, markers. Nothing is ever filtered or deleted from it. It accumulates forever.

**Layer 2 — The journals** (`journals/jones-gen.*.journal`, `journals/jones-gen.timedot`)
Derived artifacts. Rebuilt from the diary on every block save. They contain **all records, all time** — no timeframe filtering here. Never hand-edit these files; edits will be overwritten on the next save.

**Layer 3 — The reports** (`jones-reports.md`, `type: reports`)
A projection surface. CBQL blocks fetch from the journals and apply a timeframe filter at **query time**. The same journals serve every timeframe selection — only the hledger `date:FROM..TO` argument changes.

> **The architectural invariant**: journals = complete records; timeframe = query filter only.
> Filtering journal *content* by date is wrong. Filter the hledger *query*.

---

## File layout

```
projects/acme/jones/
  .jones.md                      ← folder dotfile: delivers project:, journal:, rate: etc
  jones.md                       ← project diary (source of truth)
  jones-reports.md               ← type: reports (projection surface)
  journals/
    jones.journal                ← stable manifest: P directive + include chain (NEVER rewritten)
    jones-gen.timedot            ← DO NOT HAND EDIT — rebuilt from all timedot blocks
    jones-gen.labour.journal     ← DO NOT HAND EDIT — rebuilt from timedot × rate
    jones-gen.materials.journal  ← DO NOT HAND EDIT — rebuilt from csv materials blocks
    jones-gen.tools.journal      ← DO NOT HAND EDIT — rebuilt from csv tools blocks
```

### The `-gen` suffix convention

Any file that is a **derived artifact** (generated from source blocks, rebuilt on every save) gets a `-gen` suffix before the extension:

```
jones-gen.timedot            ✓
jones-gen.labour.journal     ✓
jones.timedot                ✗  (old naming — no longer used)
jones.labour.journal         ✗  (old naming — no longer used)
```

This makes generated files trivially identifiable in file listings, enables tooling to distinguish hand-edited from generated, and prevents accidental hand-edits that would be silently overwritten.

### `jones.journal` — the stable manifest

This file is written once and never rewritten by the system. It holds:

1. The `P` price directive (commodity conversion rate)
2. `include` directives for all `-gen` sub-journals

```hl
; jones.journal — master project ledger
; All sub-journals are auto-synced from note blocks on save. Edit source blocks, not these files.

P 2026-06-01 h 30.00 CAD

include ./jones-gen.timedot
include ./jones-gen.labour.journal
include ./jones-gen.materials.journal
include ./jones-gen.tools.journal
```

**Why the `P` directive lives here and nowhere else**: hledger rejects `P` price directives in `.timedot` files with a parse error. The master `.journal` is the only valid home for it.

**Why it's never rewritten**: the sub-journals change on every save; the master's mtime would change too, breaking hledger's cache. More importantly, it can hold human-authored entries (opening balances, manual adjustments) that must not be overwritten.

---

## Folder dotfile — `.jones.md`

The folder dotfile delivers project-wide FM keys to every note in the folder via `effective_fm`. Notes don't need to repeat these values.

```yaml
---
journal: ~/.nb/work/projects/acme/jones/journals/jones.journal
project: acme:jones
rate: 30
rate_unit: hour
billing_type: cash
client: "contacts:jones.md"
---
```

**Keys delivered via `effective_fm`**: `journal`, `project`, `rate`, `billing_type`, `client`, `csv`, and anything in `_FM_BLOCK_KEYS`.

**The Python caveat**: the `/api/t/invoice/generate` endpoint reads raw frontmatter with `parse_frontmatter()` — it does NOT get `effective_fm`. It uses `_folder_config(notebook, note_path)` as the explicit fallback. Both `meta.get('key')` and `_fcfg.get('key')` must be checked for every project-scoped key (`project`, `rate`, `billing_type`, `client`, `journal`, `timedot_file`).

---

## Sync mechanism — blocks → generated files

### Timedot block save

When a timedot block is saved inline (via the block editor in nb-web), `api_t_timedot_write` fires:

1. Writes the updated timedot content to `jones-gen.timedot` (full rebuild, not append)
2. Calls `_ensure_journal_stubs(master_journal)` — creates any missing `-gen.*.journal` stub files
3. Calls `_nb_index_add(td)` — adds the timedot to the nb `.index` if not already present

The master journal path is derived by stripping `-gen` from the timedot stem:
```python
master_stem = td.stem.removesuffix('-gen')
_ensure_journal_stubs(td.parent / f'{master_stem}.journal')
```

### Labour journal rebuild

`_timedotExtractLabourJournal(raw, project, rate)` runs in the browser (JavaScript) whenever a timedot block is saved. It:

1. Walks every timedot block in the raw note body
2. Groups entries by date
3. Emits one double-entry hledger transaction per day:

```hl
2026-06-29 work
    Assets:AR:acme:jones        105.00 CAD
    Income:Services:Hourly:acme:jones
```

The labour journal is **a complete rebuild every time**. No deduplication needed — it's a derived artifact.

### Timedot block sync — how the write file is found

The sync code in `nbweb-codeblocks.js` no longer reads `meta.timedot_file` (that FM key was removed). Instead it derives the path:

```javascript
const _journalKey = _syncNote?.meta?.journal || _syncNote?.effective_fm?.journal || '';
const _syncFile   = _syncNote?.meta?.timedot_file
                 || _syncNote?.effective_fm?.timedot_file
                 || (_journalKey ? _journalKey.replace(/\.journal$/, '-gen.timedot') : '');
```

`effective_fm.journal` → strip `.journal` → append `-gen.timedot`. If neither is present, sync is silently skipped.

### Timeframe change as recalc trigger

`nb-timeframe-changed` (dispatched by the timeline block on every timeframe selection) also triggers `_recalcSourceJournals()` — which re-fetches the source note and rebuilds all journals. This is the **intended recalc trigger**. Saving a timedot block also triggers rebuild, but timeframe change is the natural moment the user expects fresh data.

---

## CBQL date range extraction

`_cbqlDateRange(body, timeframe)` extracts `{from, to}` dates from marker lines in the source note body.

### Marker lines used

```
> INVOICED: INV-2026-004  2026-06-27  $1275.00 cash   ← billing boundary
> CLOSED:   ...                                        ← billing boundary (also)
> TODAY:                                               ← end of "current" phase
```

Dates are extracted from marker labels with `/\b(\d{4}-\d{2}-\d{2})\b/`.

### Timeframe semantics

| Timeframe | `from` | `to` |
|-----------|--------|------|
| `all` | null | null |
| `current` | day after last INVOICED/CLOSED date | TODAY: date (or today) |
| `INVOICED: INV-2026-004` | day after previous billing marker | date of that marker |

`current` start = **day after** the last INVOICED or CLOSED date — not the date itself, because the invoiced day's work belongs to the previous phase.

If no billing markers exist, `current` starts from the beginning of the log.

### Date filter injection

`_loadHledgerCBQLBlock` appends the date range to the user-written hledger query:

```javascript
const query = baseQuery + (from ? ` date:${from}..` : '') + (to ? `..${to}` : '');
// e.g.: "bal Assets:AR:acme:jones date:2026-06-28..2026-07-03"
```

This is the **only** place timeframe filtering happens. Journals are never filtered.

---

## CBQL block types — hledger

### `hl` block with `source:`

```markdown
```hl
source: jones.md
bal Assets:AR:acme:jones
```
```

- `source:` — source note selector (relative to current note's folder if no notebook prefix)
- Body — hledger command + arguments; date filter appended automatically
- `journalFile` sent to `/api/hledger/cbql-query` — backend runs hledger directly against the real journal file

### Critical: scope your account

A bare `bal` on `jones.journal` shows **all accounts from all included files** — both CAD entries from `jones-gen.labour.journal` AND raw hour amounts from `jones-gen.timedot`. Always scope to the account you want:

```
bal Assets:AR:acme:jones           ← shows receivable (positive CAD) ✓
bal Income:Services:Hourly:acme:jones  ← shows income (negative CAD — hledger convention) ✓
bal                                 ← shows mixed CAD + raw hours ✗
```

### `hl` block without `source:` (unchanged)

```markdown
```hl
reg Income:Services:Hourly:acme:jones
```
```

No `source:` = no CBQL path. Queries the note's journal directly (from `effective_fm.journal`). Unaffected by timeframe selection. Use for all-time views.

### `/api/hledger/cbql-query` endpoint

Accepts `{ journalFile, query }`. Runs `hledger -f <journalFile> <query>` directly. Returns stdout.

`journalFile` is the absolute path to the real journal (e.g. the master `jones.journal`). No temp files needed — the master journal already includes all sub-journals via `include` directives.

---

## Sub-accounts in timedot

In the project diary, timedot entries use a shorthand sub-account notation:

```timedot
2026-06-29
 :flooring  3.5  ; Radio room floor
 :trim      2.0  ; selected boards
```

The leading ` :` is expanded by `_timedotRewrite(text, project)` to the full account path:

```
 acme:jones:flooring  3.5
 acme:jones:trim      2.0
```

**Invariant: the leading space is mandatory.** In hledger timedot format, an unindented line is interpreted as a date. `acme:jones:flooring` (no leading space) will cause a parse error or silent misparse. The generator (`_timedotRewrite`) does NOT normalize missing spaces — it preserves whatever indentation the source has. If `:flooring` in the diary has no leading space, the generated file will too.

**Rule**: all timedot account lines must be indented by at least one space. ` :flooring` not `:flooring`.

---

## Invoice generation — key details

### Flow

1. User clicks **Invoice** on the reports specialty bar
2. Preflight: `GET /api/t/invoice/preflight` — reads `_invoice_journal_totals(journal_key)`, scans `invoices/` for next invoice number
3. Dialog: user confirms invoice number, date, due date, notes
4. Generate: `POST /api/t/invoice/generate` — writes `invoices/INV-YYYY-NNN.md`, writes back `> INVOICED:` marker to the diary

### Progressive billing — the marker cycle

On successful generate, the system writes one line to the project diary:

```
> INVOICED: INV-2026-005  2026-07-03  $270.00 cash
```

This marker becomes the new phase boundary. The next `current` timeframe starts from the day after this date.

**To regenerate the same invoice**: delete the `INVOICED:` marker line from the diary and click Invoice again. The system is fully re-entrant — the diary is the only state that needs to change.

### Sub-accounts on the `Re:` line

`_timedot_categories(timedot_path, project)` reads `jones-gen.timedot` and extracts unique sub-accounts, stripping the project prefix:

```
acme:jones:flooring  →  flooring
acme:jones:paint     →  paint
```

Result: `Re: project: jones (flooring, paint, trim)`

The timedot path is derived from `journal_key` when not in FM:
```python
timedot_key = str(meta.get('timedot_file') or _fcfg.get('timedot_file') or '').strip()
if not timedot_key and journal_key:
    timedot_key = journal_key.replace('.journal', '-gen.timedot')
```

### Invoice file location

Invoices land at the **client level**, not the project level:

```
projects/acme/
  invoices/
    INV-2026-004.md    ← shared across all acme projects
    INV-2026-005.md
  jones/
    jones.md
    jones-reports.md
```

Invoice number sequence is per-client, naturally avoiding duplicates across projects under the same client.

---

## `_nb_index_add` — indexing generated files

Files written directly to a notebook directory (not via `nb add`) are invisible to nb until indexed. `_nb_index_add(file_path)` walks up the directory tree to find the notebook's `.index` file and appends the relative path if not already present:

```python
def _nb_index_add(file_path: Path):
    p = Path(file_path).resolve()
    candidate = p.parent
    while candidate != candidate.parent:
        idx = candidate / '.index'
        if idx.exists():
            rel = str(p.relative_to(candidate))
            lines = idx.read_text(errors='replace').splitlines()
            if rel not in lines:
                with open(idx, 'a') as f:
                    f.write(rel + '\n')
            return
        candidate = candidate.parent
```

Called after every generated file write. Idempotent.

---

## Caveats and gotchas

### `P` directive invalid in `.timedot` files

hledger rejects `P` price directives in `.timedot` files with a parse error. The directive must live in a `.journal` file. The stable manifest `jones.journal` is the right home.

### bare `bal` mixes commodities

The master journal includes both the labour journal (CAD) and the timedot (raw hours). `bal` without an account scope shows all of them together — confusing, not an error. Always scope `hl` CBQL blocks to a specific account.

### Timedot sub-account indent

`:flooring` without a leading space generates `acme:jones:flooring` at column 0 — hledger misparses it as a date. The generator does not auto-correct this. Fix it in the source block.

### `effective_fm` doesn't reach the invoice endpoint

`/api/t/invoice/generate` reads raw frontmatter directly. It uses `_folder_config()` as the fallback — not the API's `effective_fm`. All project-scoped keys must be checked in both `meta` and `_fcfg`.

### Timeframe change is the recalc trigger, not Save

Save on a timedot block triggers journal rebuild for that block. But the intended recalc trigger for reports is **timeframe change** — the `nb-timeframe-changed` event also fires `_recalcSourceJournals()`. If journals seem stale, change timeframe to current and back.

### hledger cache invalidation

The hledger cache in `app.py` keys on journal file mtime. When sub-journals change (timedot or labour rebuild), the master `jones.journal` mtime doesn't change — so the cache doesn't invalidate. `api_t_timedot_write` and `api_t_journal_from_csv` both call `_hledger_cache.clear()` explicitly.

---

## Unfinished business

| Item | Notes |
|------|-------|
| Materials CBQL block in reports | `bal Expenses:Materials:acme:jones` — needs timeframe filter wired |
| Tools / transport CBQL blocks | Same pattern as materials |
| `billing_type: t&m` invoice template | `invoice-tm.md` template; HST calculation on subtotal |
| Invoice ledger block → post to journal | On generate: write AR/income entry to journal for payment tracking |
| HST remittance | `Liabilities:HST:Collected` account + remittance check script |
| Note templates | Seeded `project` and `reports` templates with correct FM fields pre-filled |
| Date bug in generated invoices | Electrical entry shows 06-23 in INV-2026-002 but timedot has 06-24 — `_parse_labour_entries` date handling under investigation |
| `foldable:` via effective_fm | Pattern propagation not yet in `_FM_BLOCK_KEYS` |

---

## Reports page reference layout

```markdown
---
title: "Project Jones — Reports"
type: reports
source: jones.md
project: acme:jones        ← or inherited from .jones.md folder dotfile
client: "contacts:jones.md"
billing_type: cash
rate: 30
rate_unit: hour
---

## Timeline
```timeline
source: jones.md
```

## Time
```timedot
source: jones.md
timeframe: current
```

## Current phase — Labour
```hl
source: jones.md
bal Assets:AR:acme:jones
```

## All labour
```hl
reg Income:Services:Hourly:acme:jones
```

## Materials
```hl
reg Expenses:Materials:acme:jones
```
```

The `timedot` and `hl` CBQL blocks share the same `source:`, the same marker timeline, and respond to the same `nb-timeframe-changed` event. The `reg` blocks (no `source:`) are all-time views, unaffected by timeframe selection.

#wip
