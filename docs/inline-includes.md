<!-- Generated from docs:inline-includes.md by .tools/readme-export.py. Edit the source, not this file. -->

# Inline includes

## Summary

`{{inline: notebook:path/note.md}}` on its own line shows another note's body right there, as if
it were part of this note. Add `#Heading` to include just one section
(`{{inline: docs:wikilinks.md#Summary}}`), or `card` to show the note's card instead of its text.
Several includes plus `toc: true` make one long, navigable document out of separate notes.

## How it works

```markdown
{{inline: ../shared/header.md}}
{{inline: accts:tutorial/06_credit_card_transactions.md}}
{{inline: docs:wikilinks.md#Summary}}
{{inline: card Takeout:cast/jim_dandy.md}}
```

The path is relative to the current note (`../` steps up a folder), or a full selector with a
notebook name (`accts:`) for another notebook. Frontmatter is left out; only the body renders.

Included content sits in a bordered block (a left rule with a slight tint) so it's clearly not
part of the surrounding text. Everything inside stays live: wikilinks, terminal links, inline
queries and codeblocks all work.

Includes near the top load straight away, in order; ones further down load as you scroll to them.

### One section: `#Heading`

`{{inline: note.md#Heading}}` includes only the text under that heading, up to the next heading
of the same or higher level. The heading itself is left out, so the section reads as part of the
host note. Matching is case-insensitive, as with `[[Page#Heading]]`. A heading that doesn't exist
shows as a dimmed `[inline: ...]`, with the reason in its tooltip.

This is how the `features:` pages show each topic's Summary without copying it.

### Cards: `card`

`{{inline: card path}}` shows the target's card (an actor, location, contact, production…) when
its type has one, and its plain body otherwise. Only the card is shown, not the note's text below
it, and the whole card is a link: click it to open the source note.

### Stitched documents

Includes and `toc: true` together build one navigable document from separate notes:

```markdown
---
title: The Complete Guide
type: dashboard
toc: true
---

# The Complete Guide

{{inline: accts:guide/setup.md}}

{{inline: accts:guide/daily.md}}

{{inline: accts:guide/review.md}}
```

The table of contents lists the headings of the included chapters, and updates as later chapters
load. Each chapter is still a normal note you can open on its own. Use full selectors
(`accts:guide/setup.md`) rather than relative paths, so the hub works from anywhere.

Exporting as HTML captures the page after every include has loaded, so the file is one
self-contained document.

## Reference

- **Use a colon for `.lib` files**: `{{inline: .lib:help-nb.md}}` works; `{{inline: .lib/help-nb.md}}`
  is read as a path relative to the current note and fails. The same goes for wikilinks.
- **Two levels deep**: an included note's own includes work (so a book's chapter can pull in a
  section), but includes three levels down are dropped, which also prevents loops.
- **Write the `.md`**: `docs:wikilinks.md#Summary` works; `docs:wikilinks#Summary` doesn't find
  the note.
- **Not published**: Quartz shows `{{inline:}}` as literal text.

## For developers

- [Wikilinks internals](dev/dev-wikilinks.md)
- [Render pipeline](dev/dev-render-pipeline.md)

`_resolveInlineInclude` and `_sliceSection` in `main.js`; the render pipeline is in
[wikilinks](dev/dev-wikilinks.md) and nb-web's `CLAUDE.md` ("Inline queries").
