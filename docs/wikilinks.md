<!-- Generated from docs:wikilinks.md by .tools/readme-export.py. Edit the source, not this file. -->

# Wikilinks

## Summary

Write `[[Note Title]]` in a note to link to another note; click it to open the target. Links
find notes by title or filename, in the current notebook or another one (`[[docs:THEMES.md]]`),
and can jump straight to a heading (`[[Page#Heading]]`). The label shown is the target's `alias:`,
then its `title:`, so renaming a note's display never breaks a link.

## How it works

### Resolution order

For a plain `[[text]]` wikilink, nb-web tries, in order:

1. **Title match**: a note whose `title:` frontmatter (or inferred title) equals the text
2. **Filename stem match**: a note whose filename without extension equals the text

Plain-text wikilinks resolve within the current notebook, case-insensitively: `[[shop]]` and
`[[Shop]]` both find a note titled "Shop".

The filename-stem fallback means you can set a descriptive `title:` on a note without breaking
links that use its short filename. If `1b.md` has `title: 1-1b — Wide establishing shot`, the link
`[[1b]]` still resolves.

### Display label

Once a wikilink resolves, its label is chosen in this order:

1. **`alias:`** frontmatter: a short, changeable label (scene number, version code, etc.)
2. **`title:`** frontmatter (or inferred title)
3. **Filename stem**

`alias:` is for content whose short identifier changes over time while the filename stays fixed.
Change `alias: 4` to `alias: 7` and every `[[filename]]` link in the notebook shows `7`, with no
link edits. Labels are cached for the session; Ctrl+R picks up alias changes.

**Shrinking long titles**: a short `alias:` overrides the label wherever space is tight (tabs,
wikilinks, list badges), while the full title stays as the heading and tooltip:

```yaml
---
title: A very long title about Project XYZ that wraps in tabs
alias: XYZ
---
```

### Anchor links

Append `#Heading Text` to jump to a section:

| Syntax | Effect |
|--------|--------|
| `[[Page#Heading]]` | Open the note and scroll to that heading |
| `[[Page#Heading\|label]]` | Same, with custom display text |
| `[[#Heading]]` | Scroll to a heading in the **current** note (no reload) |

Heading matching is case-insensitive and compares the heading words, not a slug:

```
[[#Contact Import]]   ✓  exact words, any case
[[#contact import]]   ✓  lowercase also works
[[#contact-import]]   ✗  slug/hyphen form does not match
```

### Config dotfiles

Config dotfiles (`.shots.md`, `.Takeout.md`, `.nb.md`) are hidden from the note list, but
wikilinks to them resolve normally. Use the bare stem, with the leading dot and no extension:

| Link | Resolves to |
|------|-------------|
| `[[.shots]]` | `shots/.shots.md` in the current notebook |
| `[[.Takeout]]` | `.Takeout.md` at the notebook root |
| `[[Takeout:.Takeout.md]]` | explicit cross-notebook form |

Dotfiles rarely have a `title:`, so add a pipe label: `[[.shots|shots config]]`.

### Folder links

A link ending in `/` points at a folder: `[[features:basics/|Basics]]` opens the `basics` folder
in the list and shows its dashboard, `basics/basics.md`, if there is one; otherwise the folder's
first note, as when you click a folder in the list.

### Backlinks

An `nb` codeblock with `backlinks` lists every note that links to the current note's title:

````markdown
```nb
backlinks
```
````

Results come from ripgrep and are capped at 20; pass a number to raise it (`backlinks 50`). See
[CODEBLOCKS](CODEBLOCKS.md) for the full `nb` block reference.

## Reference

### Syntax

| Syntax | Effect |
|--------|--------|
| `[[Note Title]]` | Link by title or filename stem; label resolved automatically |
| `[[Note Title\|display text]]` | Link with custom display text |
| `[[notebook:path/file.md]]` | Link by explicit selector, e.g. `[[docs:THEMES.md]]` |
| `[[42]]` | Link by bare note id within the current notebook |
| `[[notebook:folder/\|label]]` | Open that folder in the list, and its own `folder/<folder>.md` (its dashboard) if it has one |
| `[[Page#Heading]]`, `[[#Heading]]` | Anchor links (above) |

A bare id is a position in a folder's `.index`, so it isn't unique across folders; prefer the
`notebook:path/file.md` form for anything you'll keep.

### Quartz compatibility

`[[Note Title]]` is the recommended syntax for notes that may be published with the Quartz
plugin, which resolves it natively by title.

| Syntax | nb-web | Quartz |
|--------|--------|--------|
| `[[Note Title]]` | ✓ title → filename stem fallback | ✓ native |
| `[[Note Title\|label]]` | ✓ | ✓ |
| `[[filename-stem]]` | ✓ filename stem match (nb-web only) | ✗ |
| `[[notebook:selector]]` | ✓ direct nb selector | ✗ |
| `[[42]]` | ✓ bare id | ✗ |

See NbWeb-quartz for the publishing workflow.

### Related

[Terminal links](terminal-links.md) · [Inline includes](inline-includes.md) ·
[Tab strip](tabs.md) · [xref](xref.md) · [Inline live queries](inline-queries.md)

## For developers

- [Wikilinks internals](dev/dev-wikilinks.md)
- [Markdown rendering pipeline](dev/dev-architecture.md#markdown-rendering-pipeline)
