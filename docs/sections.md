<!-- Generated from docs:sections.md by .tools/readme-export.py. Edit the source, not this file. -->

# Sections

## Summary

A section is the header note of a folder of pages: `type: section` on `<folder>/<folder>.md`.
Its `## Summary` says what the pages are for and what to know before you start, then
`{{inline: contents}}` lists the pages, built from the folder's own order, so it never goes
stale. Its header links to the sections before and after it, and up to their parent. Every
category of the features tour is a section, and the README shows each one's Summary.

## How it works

````markdown
---
title: Live blocks
type: section
caption: Notes that do things
---
# Live blocks

## Summary

What the pages are for, in a few sentences.

**Before you start.** What applies to every page: tools to install, access levels.

{{inline: contents}}

## Navigation

{{inline: features:live-blocks/nav.md}}
````

Everything after the Summary (the pages themselves, "Try it" links, a reset link) is for reading
in nb-web; the Summary is what a section shows elsewhere.

### The contents list

- **Order** is the folder's `.index`, the same order as the note list. Edit it by hand.
- **Each page** (a note with `type: feature`) is a line: its title, linked, and its `caption:`, or
  its topic's caption if it has none. Other notes, and folders of example data, are left out.
- **Nested:** if a page's topic note `X.md` has topics of its own in `X/` (`blocks/fm.md` and
  `blocks/fm/`), they're listed under the page, in `X/.index` order, each labelled by its title up
  to the ` — `. A sub-folder that is itself a section lists its pages under it.
- **Groups:** `group: Navigation` in a page's frontmatter starts a labelled group wherever the
  group changes, in `.index` order.
- Pages and topics you can't open are left out.
- In nb-web the entries link to the pages; in the README, to their docs topics.

### Neighbours

The header shows `← previous · ↑ up · next →`. The neighbours are the other sections in the
parent folder's `.index` order; up is the parent folder's own note (`<notebook>.md` at the top of
a notebook; in the tour, the Features home). Sections you can't open are skipped. The README ends
each section with the same line, in the README's own order.

### What the README shows

The section's title, caption and Summary: up to the next heading or a `---` rule, without HTML
comments, with the contents list linking the docs topics. Link docs, not `features:` notes, inside
a Summary: GitHub has no tour, so a `features:` link becomes plain text there. A section with no
`## Summary` is shown the old dashboard way, its intro and then each page's topic Summary.

## Reference

- A section behaves like a dashboard: the same header (file and folder counts, the `config`
  chip to its folder config), and with `help_for:` it is a help category.
- `{{inline: contents}}` lists the current note's section;
  `{{inline: contents features:basics/basics.md}}` names another.
- The README export reads the tour at its `pristine` tag: move the tag after changing a section.

## For developers

`contents()` and `dashboard_summary()` in `dashboard_summary.py` (shared by the app and
`.tools/readme-export.py`); `/api/contents` and `/api/section/nav` in `app.py`; the header chips in
`_renderDashboardNote` (`plugins/nbweb-specialty.js`); the README nav line is `section_nav()` in
the exporter. Tests: `test_section_type.py`, `test_section_contents.py`, `test_readme_export.py`,
e2e `section-contents.spec.js`.
