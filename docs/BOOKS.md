<!-- Generated from docs:BOOKS.md by .tools/readme-export.py. Edit the source, not this file. -->

# Books

## Summary

A book is a note with `type: book` whose chapters are other notes, pulled in with
`{{inline: notebook:chapter.md}}`, one per line. It reads as one long document, with a table of
contents across every chapter. Each chapter stays an ordinary note you can open and edit on its
own. A check block placed in a chapter warns right there, so a failing check shows up in the
book's contents beside the section it's about.

## How it works

```markdown
---
title: The Bookkeeper's Guide
type: book
---
# The Bookkeeper's Guide

{{inline: accts:guide/setup.md}}
{{inline: accts:guide/daily.md}}
{{inline: accts:guide/budget.md#Monthly budget}}
```

**Chapters.** Each `{{inline:}}` on a line of its own becomes a chapter; `#Heading` takes just
that section of a note. A chapter can include notes of its own, two levels deep. Chapters near
the top load straight away, the rest as you scroll to them. See
[Inline includes](inline-includes.md).

**Table of contents.** `type: book` turns it on; no `toc: true` needed. It lists the headings of every chapter, and updates as chapters load.

**Checks in chapters.** A check block written in a chapter runs where it is: nothing shows while
it passes; when it fails, its warning appears in place, and its heading (`### ⚠ No periodic
transactions`) joins the contents beside its section. Put a check just before the section that
needs it. Checks set in frontmatter (`check:`) are different: they go to the single badge at the
top. See [Checks](CHECKS.md).

**Speed.** A big book renders a lot. `cache: true` keeps the rendered book for the rest of the
session; editing one of its chapters clears it, so the book shows the change.

`accts:bookkeeper.md` is a working example: eight chapters with checks in them.

## Reference

| Key | Effect |
|-----|--------|
| `type: book` | turns the table of contents on; the 📚 icon |
| `cache: true` | keeps the rendered book for the session (cleared when a chapter changes) |
| `{{inline: nb:note.md}}` on its own line | a chapter |
| `{{inline: nb:note.md#Heading}}` | one section of a note as a chapter |

## For developers

- `type: book` sets `effective_fm.toc` in `/api/note` (`app.py`), so it takes the same path as
  an inherited `toc:`. Chapters: `_resolveInlineInclude`; contents: `_watchInlineTocRebuild`,
  rebuilt when chapters settle and when a body check warns (`nb-checks-rendered`).
- Body checks warn in place, frontmatter checks go to the badge: CLAUDE.md invariant 20.
  Cache clearing for books: `_bustCache` (`main.js`, invariant 25).
