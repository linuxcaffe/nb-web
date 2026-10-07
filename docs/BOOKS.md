<!-- Generated from docs:BOOKS.md by .tools/readme-export.py. Edit the source, not this file. -->

# Books

A **book** is a note that stitches multiple chapter notes into a single scrollable document, with a table of contents built from the fully-expanded content. It is declared with `type: book` in frontmatter.

```markdown
---
title: "The Complete Bookkeeper's Guide"
type: book
pinned: true
---

# The Bookkeeper's Guide

{{inline: accts:guide/setup.md}}
{{inline: accts:guide/daily.md}}
{{inline: accts:guide/budget.md}}
{{inline: accts:guide/close.md}}
```

`type: book` automatically enables TOC rendering — no `toc: true` required.

---

## How It Renders

Each `{{inline:}}` directive fetches the chapter note and expands its content in place. The result is a single continuous document with visible seams: horizontal rules and chapter-end navigation links (`← prev · next →`).

The TOC is built *after* all inline fetches complete — a MutationObserver watches for content to land and rebuilds from the fully expanded DOM. Headings from every chapter appear in the navigation.

---

## The Diagnostic TOC

This is where books become something more than a reading aid.

Each chapter note can carry **Form 2 test blocks** — script-driven checks that are completely invisible when they pass, and render a markdown warning (with a heading) when they fail:

````markdown
```check
hl-budget-has-periodic
```

## Periodic transactions
...
````

When `hl-budget-has-periodic` fails, it outputs:

```markdown
### ⚠ No periodic transactions found
...guidance...
```

That `###` heading gets picked up by the TOC rebuild. **The warning appears in the navigation panel, positioned exactly where the problem lives in the document.**

A healthy book shows a clean table of contents — chapter titles and section headings only. A book with failing checks shows those `⚠` entries inline with the navigation, each one a clickable jump to the problem.

No separate dashboard. No notification system. No polling. The diagnostic layer is woven into the document; the TOC surfaces it automatically.

---

## Designing Chapters for a Book

Each chapter is a standalone note that also reads well in isolation. The stitching adds nothing to chapters — they work fine opened directly.

**Test placement strategy:** put Form 2 checks immediately before the section that depends on what they test.

```markdown
```check
hl-budget-has-periodic          ← must pass before ## Periodic transactions makes sense
```

## Periodic transactions
...

```check
hl-budget-runs                  ← must pass before the bal --budget block is useful
```

```hl
bal --budget -p thismonth
```
```

Each check acts as a **precondition gate**: if the prerequisite isn't met, the section below is context-free instructions rather than live data. The check replaces silence with actionable guidance.

---

## The Bookkeeper's Guide — as a worked example

`accts:guide/bookkeeper.md` is a live instance of this pattern. Eight chapter notes, each with embedded diagnostics:

| Chapter | Tests |
|---------|-------|
| `setup.md` | journal accessible, accounts declared |
| `daily.md` | recent transactions exist |
| `budget.md` | periodic transactions, income tracked, actuals posted |
| `review.md` | no unbalanced transactions |

Open the book with no journal problems: a clean TOC with chapter and section headings. Start a fresh setup with an empty journal: `⚠` entries cascade through the TOC showing exactly what to configure first, in document order.

The chapters are self-contained — read `budget.md` directly when you want just the budget reference. Read `bookkeeper.md` when you want the complete picture, with health checks showing current state.

---

## Compared to Status Panels

A **status panel** (`{{inline: status.md}}`) runs checks at the top of any note, using a dedicated file of Form 2 blocks. It's horizontal: one status file, many host notes.

A **book** runs checks throughout a long document, per-chapter. It's vertical: one note, many checkpoints embedded in the natural reading flow.

Use a status panel when you want a health indicator at the start of a hub note. Use a book when you want a guided, self-diagnosing reference document where context and checks evolve together as you scroll.

| | Status panel | Book |
|---|---|---|
| Scope | Top of host note | Throughout chapters |
| Check placement | Grouped | Next to relevant section |
| TOC | N/A | Shows failures in navigation |
| Chapters standalone? | N/A | Yes — each readable on its own |

---

## Book vs Guide

`type: guide` is an earlier convention for navigable reference notes. It has no special rendering behaviour beyond what the note's own frontmatter specifies.

`type: book` is a stronger contract:
- TOC is always on (auto-set, no `toc: true` needed)
- Intended to use `{{inline:}}` for chapters
- The diagnostic TOC pattern is the primary use case

A guide might have a TOC and some inline includes. A book commits to the full pattern.

---

## Creating a Book

1. Create the book note with `type: book` frontmatter
2. Add `{{inline: notebook:chapter.md}}` directives for each chapter
3. Embed Form 2 test blocks in chapter notes at precondition points
4. Optionally: add `{{inline: notebook:status.md}}` at the top for notebook-level health

See [CHECKS](CHECKS.md) for writing check scripts, and [CODEBLOCKS](CODEBLOCKS.md#check--embedded-assertions) for the test block syntax.
