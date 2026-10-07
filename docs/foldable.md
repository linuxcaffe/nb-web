<!-- Generated from docs:foldable.md by .tools/readme-export.py. Edit the source, not this file. -->

# Foldable headings

## Summary

`foldable: [Notes, Ideas]` in a note's frontmatter puts a ▾ before every heading containing
"Notes" or "Ideas"; click the heading (or the ▾) to fold away the section under it, and again to
open it. Each heading remembers whether it's folded. Set `foldable:` in a folder's config and
every note in the folder gets it, which suits long diaries: fold every past day with a date
pattern.

## How it works

```yaml
foldable: [Notes, Ideas]          # any heading containing Notes or Ideas, any case
foldable: '\d{4}-\d{2}-\d{2}'     # any heading with a date in it
```

Each entry is a pattern (a regular expression; a plain word just means "contains this word"),
tested against the whole heading line including its `#`s, so it can pick a level too:
`'^## '` matches only second-level headings. Matching ignores case; start a pattern with
`(?-i)` to make case count. Put patterns with symbols in quotes.

Folding hides everything up to the next heading of the same or a higher level, subheadings
included. Whether a heading is folded is remembered in this browser, per note and heading.

The note's own `foldable:` replaces one from its folder or notebook config; it doesn't add to it.

**Today's heading.** With `date_headers: true`, or a `foldable:` pattern that matches dates,
clicking **Edit** first adds today's `## 2026-10-07` heading if the note hasn't got one (before
a `> TODAY:` line if there is one, otherwise at the end), so a diary never needs one typed.

## Reference

| Pattern | Matches |
|---------|---------|
| `Notes` | `# Notes`, `## My notes`, any level, any case |
| `'(?-i)Notes'` | `## Notes` but not `## notes` |
| `'^## '` | every second-level heading |
| `'\d{4}-\d{2}-\d{2}'` | headings with a date in them |
| `'^# \d{4}'` | first-level headings that start with a year |

| Key | Where | Effect |
|-----|-------|--------|
| `foldable:` | note, or a folder or notebook config | which headings fold |
| `date_headers: true` | note | **Edit** adds today's date heading |

## For developers

- `_applyFoldableHeadings` and `_foldPatterns` (`main.js`); fold state in `localStorage` as
  `nb-fold:<selector>:<heading line>`.
- `foldable` reaches notes through `effective_fm` (it's in `_FM_BLOCK_KEYS`, `app.py`).
- Today's heading: `_ensureTodayHeading` / `_insertBeforeToday` (`main.js`, CLAUDE.md
  invariant 42), using the local date (`_localDate`).
