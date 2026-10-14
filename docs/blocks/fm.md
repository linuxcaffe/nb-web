<!-- Generated from docs:blocks/fm.md by .tools/readme-export.py. Edit the source, not this file. -->

# fm — Frontmatter Filter

## Summary

An `fm` block lists the notes whose frontmatter matches a query: `status:active` finds every
note with that status, in every notebook you can open. Put notebook or folder names first to
narrow where it looks, add more `field:value` filters to narrow what it finds, and sort or cap
the list. Click a result to open it; hover it to see all its fields. The same block can also
count, total or group the matches, list every key in a notebook, or show an edit form.

## How it works

````markdown
```fm
features:examples/jobs/ type:job status:active | Active jobs
```
````

A query has three parts, in this order, separated by spaces:

1. **Where to look** (optional). A bare word is a notebook: `features`. `notebook:folder/` is a
   folder and everything under it (the trailing `/` is required). `.` is the current note's
   notebook. Give several to search several places. With none, it searches every notebook you
   can open.
2. **Filters** (optional), all of which must match: `field:value`, as in the table below.
3. **A label** (optional): ` | Label` at the end shows in the block's header.

The live examples on this page query the made-up jobs in
features:examples/jobs/: six renovation jobs, each with `client`,
`status`, `budget`, `due` and `tags`.

```fm
features:examples/jobs/ type:job status:active | Active jobs
```

### Filters

| Filter | Matches notes where |
|---|---|
| `field:value` | the field equals the value (upper/lower case doesn't matter) |
| `field:"two words"` | the same, for a value with spaces |
| `field:a,b` | the field equals any of the values |
| `field:` | the field is there, with any value |
| `field:""` | the field is missing or empty |
| `field:>value` / `field:<value` | the field is greater / less than the value |
| `-field:…` | the opposite of any of the above |

A note without the field never matches a filter, except a negated one: `-status:done` also finds
notes with no `status` at all.

**Lists.** A field that holds a list, like `tags: [kitchen, acme]`, matches if any item does:
`tags:kitchen` finds it, and `-tags:acme` leaves it out.

**Greater and less than.** A number compares as a number, so `budget:>5000` finds 9000 and
12000, and leaves out a budget of `TBD`. Anything else compares as text, which works for dates
written `YYYY-MM-DD`: `due:<2026-12-31` is due before the new year.

````markdown
```fm
features:examples/jobs/ type:job -status:done due:<2026-12-31 | Open, due this year
```
````

```fm
features:examples/jobs/ type:job -status:done due:<2026-12-31 | Open, due this year
```

**Fields every note has.** `mtime` (the day the file last changed, `YYYY-MM-DD`), `wordcount`
and `linecount` (of the body, frontmatter left out) are worked out for each note, and filter
like any other field: `wordcount:>500`, `mtime:>2026-10-01`. They win over a real frontmatter
field of the same name.

### Sorting and a limit

`sort:field` puts the list in order of that field; `sort:-field` reverses it. Numbers sort as
numbers, then come text values, and notes without the field always come last. `limit:N` keeps
the first N, after sorting. Both can go anywhere among the filters.

````markdown
```fm
features:examples/jobs/ type:job sort:-budget limit:3 | Three biggest jobs
```
````

```fm
features:examples/jobs/ type:job sort:-budget limit:3 | Three biggest jobs
```

### The list

The header shows how many notes matched, which notebook they're from (or how many notebooks),
and the label. When the results come from more than one notebook, each row also shows its
notebook. Click a row to open the note; hover it to see all its fields, `mtime`, `wordcount` and
`linecount` included.

**In the header strip.** As frontmatter, the same query shows above the note instead of in it:
`fm: features:examples/jobs/ type:job status:active`.

## Reference

- **Other forms of the block:** [group, count and sum](fm/aggregate.md),
  [the key browser](fm/list.md) (`list`), [the edit form](fm/edit.md)
  (`edit`).
- **In a sentence:** `{{fm: count …}}` takes the same query and shows just the number, and
  `{{fm: tags}}` shows one field of the current note. See [Inline live queries](../inline-queries.md).
- **Access:** `admin` by default (`codeblock_access: fm:` in `~/.nb/.nb.md`, or `read:` in the
  block). Whatever the level, the results only ever include notes you can open, from notebooks
  your account may use.
- **Limit:** a query stops at 500 matches. An empty block lists every note it can find, up to
  that.
- Config files inside notebooks (`.notebook.md`, folder configs) and dot-folders are never
  results. With no notebook named, admins also search the global config files at the top of
  `~/.nb` (`.nb.md`).

## For developers

Renderer: `_loadFrontBlock` (`plugins/nbweb-codeblocks.js`) parses the query with
`_frontParseQuery` and draws the list with `_frontRender`; `_fmSortLimit` sorts and limits in the
browser. Backend: `/api/front-query` → `_run_front_query` (`app.py`), which walks the notebooks
and filters with `_front_matches`/`_fm_eval_one`. `_parse_fm_scope` is the Python twin of the
parser, for `{{fm: count}}`; change both together. Codeblock architecture:
[codeblocks](../dev/dev-codeblocks.md) #REVIEW.
