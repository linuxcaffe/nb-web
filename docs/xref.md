<!-- Generated from docs:xref.md by .tools/readme-export.py. Edit the source, not this file. -->

# xref — Cross-Reference Enrichment

## Summary

`xref: hledger:` in a note's frontmatter matches the words in its headings against the note titles
in another notebook (or folder). Each match gets a small `[1]`, `[2]`… superscript that opens the
matching note. Set it once in a notebook or folder config and every note there gets it: a guide in
`accts:` can point at deep reference notes in `hledger:` with no wikilinks typed by hand.

## How it works

Add `xref:` to a note's frontmatter:

```yaml
---
title: "Review"
xref: hledger:
---
```

Every significant word in every heading is matched against note titles in the `hledger` notebook.
Matching words get a superscript, muted until you hover; click it to open the matched note.
Numbering runs through the note in heading order, across all targets.

### Targets

```yaml
xref: hledger:                    # a whole notebook (its top-level notes)
xref: accts:tutorial/             # one folder only
xref: [hledger:, accts:tutorial/] # several; fetched in parallel, numbered in one sequence
```

`hledger:` (trailing colon) inside a YAML list is read by some tools as a mapping key; nb-web
unwraps it, so the syntax above works as written, no quotes needed.

### Set it once for a whole notebook or folder

Instead of adding `xref:` to every note, put it in a notebook or folder config; it then applies to
every note in that scope:

```yaml
# ~/.nb/nb/.nb.md
xref: docs:           # nb-web docs for every nb: note

# ~/.nb/accts/.accts.md
xref: docs:hledger/   # hledger reference for every accts: note
```

A folder or note can switch it off with a bare `xref:` (no value). `xref: ""` also works.

### Annotation vocabulary

If a target note's **annotation** contains free text, those words count too. Say `hledger:check.md`
is titled "hledger check": the heading "Verify integrity" matches neither word. If its annotation
contains

```
verify integrity validate structural soundness journal errors
```

then "Verify" and "integrity" both match. Annotations are never published, so they let you tune
matching without touching published text.

### Config forms

In a config note (`.nb.md`, a folder's `.{folder}.md`), the config form's field labels (`access`,
`pinned`, `check`, `tag_color`…) take part like headings. If the notebook's `xref:` points at docs
with matching sections, those labels link to them: contextual help for free, only on fields that
have docs.

## Reference

- **`xref-ignore:`** lists words that shouldn't match in this note
  (`xref-ignore: ["journal", "account"]`). Common English words ("the", "use", "file", "note"…)
  are always ignored.
- **Books**: in a note made of `{{inline:}}` chapters, xref scans every chapter's headings, and
  loads all chapters up front to do it. For very long books, put `xref:` on the chapters instead.
- **Top-level only**: a folder target scans that one folder, not its subfolders.
- **Titles and annotations only**: the target notes' bodies aren't indexed.
- **Headings and labelled elements only**: superscripts go on `<h1>`–`<h6>` and elements marked
  `data-xref-heading` (config labels); paragraphs and codeblocks are untouched.
- **Cache follows file times**: adding or editing a note in the target refreshes it automatically.

See also: [Wikilinks](wikilinks.md) for links typed by hand, and bookkeeper for xref in
real use.

## For developers

- [xref internals](dev/dev-xref.md)
