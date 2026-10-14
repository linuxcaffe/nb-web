<!-- Generated from docs:blocks/fm/aggregate.md by .tools/readme-export.py. Edit the source, not this file. -->

# fm group, count, sum — Totals

## Summary

Start an `fm` query with `group:field`, `count` or `sum:field` and it stops listing notes one by
one. `group:` splits the matches into one list per value of a field, biggest first; `count` shows
just how many matched; `sum:` adds up a number field across them. Everything else in the query
(where to look, filters, sorting, a label) works as in a plain [fm query](../fm.md).

## How it works

The word goes first, before where to look:

````markdown
```fm
group:status features:examples/jobs/ type:job | Jobs by status
```
````

```fm
group:status features:examples/jobs/ type:job | Jobs by status
```

**`group:field`** makes one list per value of the field, the biggest group first, with each
group's size beside its name. Notes without the field go in a `(none)` group, so you can see
what's missing:

```fm
group:client features:examples/jobs/ type:job | Jobs by client
```

A list field (`tags: [kitchen, acme]`) groups by the whole list, not by each item.

**`count`** shows only the number of matches, in the header:

````markdown
```fm
count features:examples/jobs/ type:job -status:done | Open jobs
```
````

```fm
count features:examples/jobs/ type:job -status:done | Open jobs
```

**`sum:field`** adds up a field across the matches. A note whose field is missing or not a number
is left out of the total rather than counted as 0, and the header says how many were counted,
as in `(4/6)`:

````markdown
```fm
sum:budget features:examples/jobs/ type:job | Booked
```
````

```fm
sum:budget features:examples/jobs/ type:job | Booked
```

Two of the six jobs have no number for `budget` (one says `TBD`, one has none), so the total
covers four. `sum:wordcount` adds up the words in every match, for instance across a book's
chapters.

**Sorting and `limit:`** apply before grouping, counting or adding: `sum:budget sort:-mtime
limit:5` totals the five most recently changed.

## Reference

- In a sentence, `{{fm: count …}}` gives the same count as the `count` block. See
  [Inline live queries](../../inline-queries.md).
- `group`, `count` and `sum` are only words when they come first. A field really called `count`
  still filters normally further on (`count:5`).
- `group:field` and `sum:field` need something after them, a place or a filter. Alone,
  `sum:budget` is read as a filter (notes whose `sum` is `budget`); `sum:budget .` totals the
  current notebook.
- Same access and the same 500-match limit as [fm](../fm.md).

## For developers

`_loadFrontBlock` (`plugins/nbweb-codeblocks.js`) spots the leading word and hands off to
`_frontRenderGrouped`, `_frontRenderCount` or `_frontRenderSum`; all three fetch the same
`/api/front-query` as the plain list and work on the result in the browser. Codeblock
architecture: [codeblocks](../../dev/dev-codeblocks.md) #REVIEW.
