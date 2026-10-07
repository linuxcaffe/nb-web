<!-- Generated from docs:plugins/hledger/INVOICING.md by .tools/readme-export.py. Edit the source, not this file. -->

# Invoicing with NbWeb-hledger

A walkthrough from new project to PDF in the client's inbox.

---

## 1. Set up your sender info (once)

Before your first invoice, edit the template at `djp:.templates/invoice-cash.md`
(or `invoice-tm.md` for time-and-materials). Find the **From:** block and fill in
your details:

```markdown
**From:** Your Name  
555-123-4567 · you@example.com  
HST # 123456789 RT0001
```

This is the only thing you ever need to hardcode. Every invoice you generate
inherits it automatically.

---

## 2. Set up a client contact

Invoices pull the **To:** block from your `contacts:` notebook. Create a note
there for the client:

```yaml
---
name: Jane Smith
org: Acme Construction
address: "123 Main St, Anytown, ON"
phone: 555-987-6543
email: jane@acme.ca
---
```

Save it as e.g. `acme.md`. The filename stem is what you'll reference in the
project note.

---

## 3. Create the project folder structure

```
projects/
  acme/
    invoices/       ← create this folder; invoices land here
    painting/
      painting.md           ← project diary (you create)
      painting-reports.md   ← reports note (you create)
      journals/             ← auto-created on first timedot save
```

Create the client-level `invoices/` folder before generating your first invoice.

---

## 4. Set up the project diary

Create `painting.md` with `type: project` and the required FM keys:

```yaml
---
title: "Acme — Painting"
type: project
project: acme:painting
rate: 45
rate_unit: hour
billing_type: cash
client: "contacts:acme.md"
timedot_file: /home/YOU/.nb/djp/projects/acme/painting/journals/painting.timedot
journal: /home/YOU/.nb/djp/projects/acme/painting/journals/painting.journal
csv: [materials]
foldable: '\d{4}-\d{2}-\d{2}'
---
```

**Required keys:**

| Key | Purpose |
|-----|---------|
| `project:` | `client:project` — used as account prefix in journals |
| `rate:` | Rate in CAD — enables labour journal auto-gen. Lives **only** here, never duplicated on the reports note — see "Changing your rate mid-project" below |
| `rate_unit:` | `hour` (default) or `day` — what the bare number in `rate:` and any `> RATE:` marker means |
| `billing_type:` | `cash` or `t&m` (time & materials with HST) |
| `client:` | `contacts:filename.md` — drives the To: block on the invoice |
| `timedot_file:` | Absolute path — where timedot sync writes |
| `journal:` | Absolute path — master journal for hledger queries |

---

## 5. Track your time

Add dated sections to the diary as you work:

```markdown
## 2026-07-03

```timedot
2026-07-03
 acme:painting:prep  6  ; surface prep and primer
```

## 2026-07-04

```timedot
2026-07-04
 acme:painting:paint  8  ; two coats, all rooms
```
```

Every time you save a timedot block, nb-web automatically rebuilds:
- `journals/painting.timedot` — the full timedot file
- `journals/painting.labour.journal` — explicit CAD entries (`hours × rate`)

No scripts, no cron jobs.

### Changing your rate mid-project

If your rate changes partway through — an annual increase, a renegotiation — drop
a marker line into the diary at the point it takes effect:

```markdown
## 2026-07-10

```timedot
2026-07-10
 acme:painting:paint  4  ; second coat
```

> RATE: 50
```

Bare number only — no `$`, no `/hr`. The unit is already fixed by the project
note's own `rate_unit:`, so it doesn't need repeating on every marker. Every
entry from this point forward (including later that same day, if the marker
sits between two timedot blocks) bills at the new rate; everything before it
keeps the old one. Invoices spanning the change automatically split into
separate line items with a "rate change to $X" row between them — the same
thing you'd otherwise have to edit in by hand.

A `> RATE:` marker placed before the diary's first dated entry overrides the
project note's `rate:` outright, rather than the frontmatter value ever taking
effect.

---

## 6. Set up the reports note

Create `painting-reports.md` with `type: reports`:

```yaml
---
title: "Acme Painting — Reports"
type: reports
project: acme:painting
billing_type: cash
client: "contacts:acme.md"
journal: /home/YOU/.nb/djp/projects/acme/painting/journals/painting.journal
---
```

**No `rate:` here** — every rate-aware block (Time, Current phase — Labour,
Invoice/Quote) resolves rate from the *project* note, not this one. A copy on
the reports note is never read and only invites drift between the two.

This note is where you'll generate invoices from. Add `hl` codeblocks here for
live budget views if you want them.

---

## 7. Generate an invoice

1. Open the reports note — you'll see the **📊 Reports** specialty header
2. Click **🧾 Invoice**
3. The preflight dialog appears showing:
   - Labour hours and total (per-day breakdown)
   - Materials if any
   - Suggested invoice number (`INV-2026-001` — sequential across all projects for this client)
4. Confirm or edit: Invoice #, Date, Due date, Notes
5. Click **Generate**

The invoice note is created at `projects/acme/invoices/INV-2026-001.md` and
opens automatically.

**Billing types:**

| Type | What happens |
|------|-------------|
| `cash` | Full amount invoiced, no HST collected. You handle HST at tax filing time. |
| `t&m` | HST (13%) added on top of subtotal. `Liabilities:HST:Collected` entry in ledger. |

---

## 8. The invoice note

The generated invoice (`type: invoice`) has its own specialty header:

- **Invoice #** · **Due date** · **Status** pills (🟡 due / 🟢 paid)
- **✅ Mark Paid** — records payment date in frontmatter (`status: paid`, `paid: YYYY-MM-DD`)
- **🖨️ Print** — opens a clean print window; use your browser's Print → Save as PDF

The `ledger` block at the bottom of the note contains the canonical hledger
accounting entries for your books. It's for your records — not printed on
the client-facing PDF.

---

## 9. Send the invoice

1. Click **🖨️ Print** on the invoice specialty header
2. A clean print window opens (no app chrome, no ledger block)
3. Browser → Print → Save as PDF → send to client

---

## 10. Progressive billing — invoicing a project in stages

When you generate an invoice, nb-web appends a marker to the project diary:

```
> INVOICED: INV-2026-001  2026-07-05  $630.00 cash
```

This renders in red monospace in the diary — clearly visible, clearly "this
period is closed." The next time you click Invoice, only work logged **after**
this marker is included.

**To regenerate the same invoice period:** delete the marker line from the
diary, then click Invoice again.

**To find all invoiced periods across projects:**
```bash
nb g "INVOICED"
```

---

## 11. Milestone-based billing — grouping by phase

If a project's diary uses `> MILESTONE: <label>` markers, quotes and invoices for it are broken
into per-milestone sections instead of one flat total.

**Where to put the marker**: same convention as `> INVOICED:` and `> CLOSED:` — drop it in
*after* the work it names, not before:

```markdown
## 2026-08-20

```timedot
acme:painting:trim  4  ; window trim, living room
```

> MILESTONE: 1. Living room
```

Everything since the previous `> MILESTONE:` marker (or the start of the diary, for the first
one) counts toward that milestone — you log the work, then drop the marker to stamp what you
just finished.

**What changes in the generated document:**

- Labour hours and materials are grouped and subtotaled per milestone, instead of one flat table.
- Materials appear itemized (one row per line item), not collapsed into a single line.
- Any `- [ ]`/`- [x]` checklist items written under that milestone's own diary section appear
  listed under it automatically.
- A milestone with nothing logged against it yet still appears — as a plain heading — rather
  than disappearing, or showing a fake $0.00.

**Scope options**, when generating a Quote or Invoice:

| Scope | Meaning |
|-------|---------|
| Since last invoice | Everything billed since the last `> INVOICED:` marker |
| Future | Everything not yet logged as of today (dates are hidden here — nothing's actually scheduled yet) |
| Whole job | Everything, start to finish |
| Up to a milestone | Bill/quote everything through a named milestone, inclusive — useful for billing one completed phase at a time, regardless of where in the file it currently sits |
| Since a milestone | Everything logged after a named milestone |

Invoice deliberately offers a narrower set of these (no Future/Whole-job) — those don't make
sense for a one-way billing action, so the dialog won't offer them there.

The preflight preview (what you see before clicking Generate) always matches what Generate will
actually produce — if it shows $0, that's really $0, not a preview bug.

---

## 12. Multiple projects, one client

All projects under a client share the `acme/invoices/` folder and one invoice
number sequence. `INV-2026-001` from the painting project and `INV-2026-002`
from a later electrical project are sequential — no duplicates, one folder
per client relationship.

---

## Troubleshooting

**Invoice shows $0.00**
- Check that `journal:` in the reports note points to the correct master journal
- Check that `Assets:AR:` is the account prefix (not `Assets:AccountsReceivable:`)
- Check that the labour journal has been generated (open the `journals/` folder)

**To: block shows raw contact ref instead of name**
- Check that `client: "contacts:acme.md"` matches the actual filename in your contacts notebook
- If the contact file doesn't exist, the project prefix is used as fallback (`acme`)

**Invoice counter proposes wrong number**
- The counter scans `projects/acme/invoices/` — make sure that folder exists at the client level, not inside the project folder

**Print opens a blank or broken window**
- Try Ctrl+Shift+R to clear the service worker cache, then try again
