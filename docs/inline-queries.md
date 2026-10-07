<!-- Generated from docs:inline-queries.md by .tools/readme-export.py. Edit the source, not this file. -->

# Inline live queries

## Summary

`{{provider: query}}` drops live data into a sentence and refreshes it every time the note is
shown: `Pending tasks: {{tw: count status:pending}}`. Providers cover accounts (`hledger`), tasks
(`tw`), note counts (`nb`, `fm`), dates (`date`, `day`, `mtime`) and `weather`. Use them for a
single value; anything that's really a report belongs in a codeblock.

## How it works

```
Current cash: {{hledger: bal Assets:Cash --no-total}}
Pending tasks: {{tw: count status:pending +work}}
Story cards: {{fm: count Takeout:storylines/film-school/ type:story}}
This note's tags: {{fm: tags}}
Date: {{date: %A, %B %d}}
Today: {{day: }}
Last edited: {{mtime: }}
Weather: {{weather: }}
```

Results appear as plain text in the sentence. While loading, a `⋯` placeholder shows; on error,
the raw `{{...}}` is shown dimmed with the error in a tooltip. Patterns inside `` `code` `` or
fenced blocks are never evaluated.

**Not the same as [template placeholders](TEMPLATES.md#how-it-works).** Those (`{{title}}`,
`{{day}}`, `{{weather}}`…) have no colon and are filled in once, when a note is created, then
saved into the file. The colon is what makes a query live. Some providers echo placeholder names
(`day`, `weather`) on purpose: they're the live version of the same idea.

**`fm` vs `nb`**: use `fm` when the count must respect a custom frontmatter `type:` (`story`,
`shot`, …) or be limited to a folder. `nb`'s `--type` only knows its built-in kinds (note,
bookmark, image…) and counts one folder level. `fm`'s folder scope is **recursive**.

The full [fm codeblock](CODEBLOCKS.md) filter grammar works in `{{fm: count ...}}`, since it's
the same query engine returning a number instead of a list:

```
Story cards: {{fm: count Takeout:storylines/film-school/ type:story}}
Not yet locked: {{fm: count Takeout:script/ -status:locked}}
Story or plotline: {{fm: count Takeout:storylines/ type:story,plotline}}
Touched this week: {{fm: count Takeout:storylines/ mtime:>2026-07-28}}
Budget still unset: {{fm: count Takeout:storylines/ type:story budget:""}}
```

Only `count` renders inline; `sum:`/`group:` return more than one value and need the codeblock.

**Scope**: a whole notebook is its bare name (`{{fm: count features topic:}}`); a folder is
`notebook:path/` with the trailing slash. `features:` with a colon and no slash is read as a
filter on a field called `features`, and counts 0.

### Inline or codeblock?

Inline queries suit **a single value or a short flat list**. Report-style output (headers,
separator lines, several account rows) gets squashed into a `·`-joined string that rarely reads
well.

| Use inline `{{...}}` | Use a fenced codeblock |
|----------------------|----------------------|
| `bal Assets --depth 1 --no-total` | `bs`, `is`, `activity` (report format) |
| `bal Income -p thismonth --no-total` | `bal` without `--depth` on a deep tree |
| `tw: count status:pending` | `bal Assets Liabilities` (two rows) |
| `fm: count notebook:folder/ type:x` | a browsable list of matches (the `fm` codeblock) |
| `date: %A, %B %d` | any query where the rows are the point |

The quick test: if `hledger <query>` in a terminal prints more than a line or two, use a codeblock.

> **`--depth 1` is almost always needed for inline `bal`.** A period flag (`-p thismonth`) doesn't
> reduce depth; without `--depth 1` you get one line per leaf account. Pair period filters with
> `--depth 1 --no-total`.

## Reference

| Provider | What it runs | Example |
|----------|-------------|---------|
| `hledger` | an hledger query against the notebook's journal | `{{hledger: bal Assets:Cash --depth 1}}` |
| `tw` | a Taskwarrior filter (a count by default) | `{{tw: count due:today}}` |
| `nb` | `nb` count/list, built-in types only | `{{nb: count home:}}` |
| `fm` | `count ...`: a frontmatter-filtered, folder-scoped count; or a single field name, read live from the **current note's** frontmatter | `{{fm: count Takeout:storylines/ type:story}}` / `{{fm: tags}}` |
| `date` | a strftime format | `{{date: %Y-%m-%d}}` |
| `day` | strftime, default `%A, %B %-d, %Y` | `{{day: }}` / `{{day: %A}}` |
| `mtime` | the current note's last-modified time, default `%Y-%m-%d %H:%M` | `{{mtime: }}` |
| `weather` | a wttr.in one-liner, cached 1 hour. Empty: the notebook's `weather_location:`, else a guess from the server. A cine location's `alias:` uses its `address:`; anything else is a place name | `{{weather: }}` / `{{weather: Toronto}}` |
| `inline` | another note's body, in place: see [Inline includes](inline-includes.md) | `{{inline: docs:wikilinks.md#Summary}}` |

Notebooks with an hledger `regen_script:` get a `↻` button on `hledger` results that reruns the
script and refreshes the value.

## For developers

- [Render pipeline](dev/dev-render-pipeline.md)
- [Codeblocks](dev/dev-codeblocks.md)
- [CBQL](dev/dev-cbql.md)

`api_inline_query` (`app.py`) handles every provider except `inline`; a new provider only needs
a branch there. `_resolveInlineQueries` (`main.js`) finds and fills the spans. Details in nb-web's
`CLAUDE.md`, "Inline queries".
