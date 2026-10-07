<!-- Generated from docs:PROJECT-REPORTS.md by .tools/readme-export.py. Edit the source, not this file. -->

# Project Diaries and Reports

> **Stub (2026-10-02).** The outline below is the planned shape of this doc. Each section
> lists what it will cover and where the details already live. Fill in a section at a time.

A project is two notes. The **diary** (`type: project`) is where you write what happened: dated
headings, prose, checklists, time and materials. The **reports** note (`type: reports`) is a live
view of that diary: totals, timelines and money, scoped to whichever billing phase you pick.
When it's time to bill, quotes and invoices are generated from the diary, and the invoice
writes a marker back into the diary as its own receipt.

This doc is the workflow, start to finish. For what each codeblock does on its own, see
[CODEBLOCKS](CODEBLOCKS.md). For how it works inside, see [Project Diary — Journal Sync and CBQL Implementation](dev/dev-project-diary.md) and
[billing milestones](dev/dev-billing-milestones.md).

## Starting a project

- The `[+]` button on a project header, and the `add:org` wizard behind it: what it creates
  (folder, diary, reports note, folder config), and how to change which wizard a type uses.
- Folder layout of a finished project: diary, reports, `journals/`, `quotes/`, `invoices/`.

## The diary

- Dated headings (`## YYYY-MM-DD`), newest work inserted before `> TODAY:`. Opening the editor
  adds today's heading for you.
- Checklists (`- [ ]` / `- [x]`): the one piece of prose that quotes and invoices pick up.
- Nothing is filtered or deleted from the diary. It only grows.

## Time and materials

- `timedot` blocks for labour, `csv` blocks for materials. See [CODEBLOCKS](CODEBLOCKS.md) (timedot, t).
- Sub-accounts, and rates (`> RATE:`).
- Saving a block regenerates the project's journals automatically. The `-gen` journal files
  are generated: never edit them by hand.

## Markers

- `> TODAY:` — the pivot between done and planned work.
- `> MILESTONE:` — groups planned work into phases; quotes and invoices are organized by them.
- `> INVOICED:` / `> CLOSED:` — billing boundaries, written for you when an invoice is generated.
- Where each marker belongs, and why placement matters.

## The reports note

- The timeframe selector: `all`, `current` (since the last invoice), or a single past
  invoice period. Every block on the page re-scopes to the chosen window.
- Which blocks a reports note usually carries (timeline, time totals, labour, materials) and
  how to add your own `hl` queries. See [CODEBLOCKS](CODEBLOCKS.md) (hl, timeline).

## Quotes

- Generating a quote: what's included, scopes (`future`, `all`, since/until a marker).
- How milestones, checklists and other markers appear in the quote.

## Invoices

- Generating an invoice: the preview dialog, numbering, the narrower scope choices (no
  `future` or `all`, to avoid billing undone or already-billed work).
- The marker cycle: the `> INVOICED:` line the invoice writes back, and how it starts the
  next billing phase.
- Re-doing an invoice: delete its `> INVOICED:` line and generate again.

## Printing and PDF

- Print view, page breaks that keep milestones and checklists together.

## Troubleshooting

- "Data file was not found": the project's master journal doesn't exist yet. Saving any
  timedot block creates it.
- Totals look stale after changing the timeframe or a block.
- An invoice shows $0.00.
