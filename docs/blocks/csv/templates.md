<!-- Generated from docs:blocks/csv/templates.md by .tools/readme-export.py. Edit the source, not this file. -->

# csv templates — Columns, Totals, Price Lists

## Summary

Write a name after `csv` (`csv materials`) and the block takes its columns and a totals row from
the template `~/.nb/.lib/materials.csv`, so the note holds only the data rows. Its **CSV** badge
opens a pick-list built from a price list note (`type: materials`), to fill the table by ticking
items. In frontmatter, `csv: materials` shows that price list as a compact summary instead. In a
project with a `journal:`, saving a template table also writes its hledger journal.

## How it works

````markdown
```csv materials
Maple cabinet box,ea,180.00,Anytown Lumber,1080.00
Butcher block counter 8',ea,420.00,Anytown Lumber,420.00
Cabinet hinge,ea,4.50,Main St Hardware,54.00
```
````

The materials for Pat's Jones kitchen, live (from the job note; open it to try the pick-list):

```csv materials
Maple cabinet box,ea,180.00,Anytown Lumber,1080.00
Butcher block counter 8',ea,420.00,Anytown Lumber,420.00
Cabinet hinge,ea,4.50,Main St Hardware,54.00
```

### The template file

`~/.nb/.lib/<name>.csv`: the first row is the column headers, then a row reading `contents`,
then any footer rows, such as totals:

```
Description,Unit,Unit Cost,Supplier,Total
contents
TOTAL,,,,=SUM(E1:E1)
```

The headers and footer come from the template every time; only the rows between them live in the
note and are saved back. Click the template's name in the block header to open the file (admin).

**Footer formulas fit the data.** Write a range's last row as `1` (`=SUM(E1:E1)`): before the grid
is drawn, the last row of every range in the footer is set to the number of data rows, so the same
template totals one row or a hundred, and the total never includes itself.

A template saved from a spreadsheet program is fine: trailing commas (`contents,,,,`) and empty
`,,,,` rows are ignored. A template with only a header row is fine too.

### The pick-list

Click the **CSV** badge on a template table's header. It finds the nearest note with
`type: <name>` (here `type: materials`), looking in the note's folder and then each folder above
it, and lists that note's items: each heading in it is a group, each `csv` table under a heading
is the group's items. Items already in your table are ticked. Tick and untick, then **Save** (or `Ctrl+Enter`; `Escape` closes it): the
ticked items become the table's rows, saved at once. The price list itself isn't changed.

Pat's price list is Materials.

### The summary in frontmatter

```yaml
csv: materials
csv: materials 12
```

In a note's frontmatter (or in the body as a one-line block, ` ```csv materials``` `), this shows
the price list compactly in the header strip: each group's heading, then each item's description
on the left and its cost on the right. The number is how many rows show before it scrolls (8 if
left out); several names (`csv: materials tools`) show several lists. Click a group's heading to
open the price list.

### Accounts

If the note or its folder config sets `journal:` (a project's hledger journal), saving a template
table also writes `<journal>-gen.<name>.journal` beside it, generated and never edited by hand,
so a job's materials show up in its accounts. Without `journal:` nothing else is written. See
[Project diaries and reports](../../PROJECT-REPORTS.md).

## Reference

- Template names are letters, digits, `_` and `-`; the file must exist in `~/.nb/.lib/`.
- The price list's columns: the description is the first column whose header has `desc`, `name`
  or `item`, the cost the first with `cost` or `price`.
- The pick-list matches the items already in your table by their first column.

## For developers

`_renderMarkdown` turns ` ```csv <name>` into a `.nb-csv-tmpl-pending` placeholder;
`_renderCsvTmplBlock` (`main.js`) loads `/api/lib/csv-template?name=` and builds the grid;
`_openCsvChecklist` finds the price list with `/api/csv/source` and parses it with
`_parseCatalogFull`. The summary is `_loadCsvCatalogBlock`/`_csvRenderCompact`
(`plugins/nbweb-codeblocks.js`). Saving calls `/api/t/journal/from-csv` per name. Codeblock
architecture: [codeblocks](../../dev/dev-codeblocks.md) #REVIEW.
