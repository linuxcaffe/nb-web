<!-- Generated from docs:foldable.md by .tools/readme-export.py. Edit the source, not this file. -->

# foldable — Collapsible Headings

`foldable:` is nb-web frontmatter that makes selected headings collapsible. A `▾`/`▸` toggle appears before each matching heading — click the toggle or the heading itself to collapse or expand the section beneath it. Fold state is remembered per note and heading in localStorage.

---

## Quick start

Add `foldable:` to any note's frontmatter with a list of patterns to match:

```yaml
---
foldable: [Notes, Ideas]
---
```

Any heading whose text contains "Notes" or "Ideas" (case-insensitive) becomes collapsible.

---

## Syntax

```yaml
foldable: pattern
foldable: [pattern, pattern, …]
```

A single pattern or a YAML list. Each pattern is treated as a **RegExp** tested against the raw heading line (including the `#` prefix), case-insensitive by default.

Plain strings work as literal substring matches and need no quoting:

```yaml
foldable: [Notes, Ideas, Shop, Todo]
```

Patterns containing regex special characters must be single-quoted (YAML requirement):

```yaml
foldable: ['\d{4}-\d{2}-\d{2}', Notes]
```

This matches any heading whose text contains a date (`2026-06-25`) alongside any heading containing "Notes".

---

## Matching against the raw heading line

Patterns are tested against the full raw heading, including the `#` prefix — `## Notes` not just `Notes`. This means heading level is available to the regex at no extra cost:

| Pattern | Matches |
|---------|---------|
| `Notes` | `# Notes`, `## Notes`, `### My Notes` — any level |
| `'^\# '` | H1 headings only |
| `'^\#\# '` | H2 headings only |
| `'\d{4}-\d{2}-\d{2}'` | Any heading containing an ISO date |
| `'^\# \d{4}'` | H1 headings starting with a 4-digit year |

---

## Regex options

All patterns run with the `i` (case-insensitive) flag. To force case-sensitive matching use the inline flag override:

```yaml
foldable: ['(?-i)ExactCase', Notes]
```

---

## Scope

`foldable:` can be declared at three levels — each inherits from the level above:

| Level | Where |
|-------|-------|
| Note | Note's own frontmatter |
| Notebook | `.notebook` config file |
| Global | Root `.notebook` config |

A note-level `foldable:` replaces (does not merge with) any inherited value.

---

## Fold behaviour

A fold collapses all content between the matching heading and the next heading of **equal or higher level**. Nested headings inside a folded section are hidden with their content.

Fold state is stored in localStorage as `nb-fold:<selector>:<raw-heading>`. It survives page reloads and navigation but is local to the browser.

---

## date_headers — auto-insert today's heading on Edit

When `foldable` contains a pattern that matches a date heading (e.g. `'\d{4}-\d{2}-\d{2}'`), nb-web automatically checks for today's `## YYYY-MM-DD` heading whenever you click **Edit**. If it isn't there, it's appended silently before the editor opens.

This means diary-style and project notes with date-foldable never need a manual date heading for today — just click Edit and start typing in the section that's already there.

For notes that want the same behaviour *without* date-foldable, add:

```yaml
date_headers: true
```

---

## Regex in frontmatter

`foldable:` is the first nb-web frontmatter field to interpret its values as RegExp patterns. Plain strings remain valid (they match as literal substrings); quoting is only required when the pattern contains YAML special characters. This convention is available to future FM fields where pattern matching is useful.
