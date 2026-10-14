<!-- Generated from docs:blocks/toc.md by .tools/readme-export.py. Edit the source, not this file. -->

# toc — Table of Contents

## Summary

`toc: true` in frontmatter adds a collapsible table of contents to the note's FM strip: the
header shows the note's path and heading count, and expanding it lists every heading, indented
by level, each a clickable link that scrolls smoothly to it.

## How it works

```yaml
---
toc: true
---
```

Headings `h1`–`h6` are all included, indented by level. A heading with no `id` gets one
auto-assigned from its text (`# My Section` → `my-section`); clicking a list entry scrolls the
heading into view.

**It starts collapsed every time you open the note** — like most FM-mode blocks (see
[FM-mode](../CODEBLOCKS.md#fm-mode)), expanding it is a per-visit convenience, not a
remembered preference; it does not stay open across a reload.

**`toc_min:`** — an integer frontmatter key that suppresses the TOC entirely on notes with
fewer headings than that count, so a short note doesn't carry a near-empty TOC block. It
cascades through the config chain the same way `toc:` itself does (folder → notebook → note).

## Reference

- No fenced body form is documented, and there's no reason to reach for one — `toc` is
  FM-mode only by design (`toc: true` in frontmatter). The generic renderer pipeline doesn't
  technically forbid a ` ```toc``` ` fence in a note's body, but the block ignores whatever text
  is inside it, so a body fence would render the exact same (notebook-wide) TOC with no
  advantage over the frontmatter form.
- **Books get a free diagnostic TOC**: when `test`/`check` blocks inside a `type: book`'s
  chapters fail, their `### ⚠ Heading` output surfaces inline in this same list — see
  [Books: the diagnostic TOC](../CODEBLOCKS.md#books--the-diagnostic-toc).

## For developers

Renderer: `_loadTocBlock` (`plugins/nbweb-codeblocks.js`) — reads headings live from
`#nb-preview-content`, not from parsed markdown, so it reflects whatever `{{inline:}}` chapters
have actually landed in the DOM. Already on the shared `_buildBarHeader`/`_initCollapseToggle`
header. Broader renderer architecture: [codeblocks](../dev/dev-codeblocks.md) #REVIEW.
