<!-- Generated from docs:blocks/csv/files.md by .tools/readme-export.py. Edit the source, not this file. -->

# csv files — Spreadsheet Files

## Summary

A `.csv` file in a notebook (a bank export, an estimates sheet) opens as a spreadsheet that fills
the preview pane: no fence, no note around it. Edit cells, then **Save**, or **Cancel** to drop
the changes. Tick **First row is header** to pin the first row as column titles.

## How it works

Open Pat's estimates to see one.

- Column widths fit the content, as in a `csv` block.
- **First row is header** (beside Save and Cancel) is off every time the file opens, and never
  guessed: an export often has no header row, and taking a real row for titles would hide it.
  Tick it to pin row 1 as the column titles; untick to put it back in the grid. Your edits are
  kept either way.
- **Save** writes the file; **Cancel** reloads it.

## Reference

- The whole file is the table; there's no frontmatter. Notes about the file go in its annotation
  (the box below it).
- Inside a note, use a [csv block](../csv.md) instead.

## For developers

`classify()` (`app.py`) makes `.csv` the `sheet` type; `renderPreview` (`main.js`) draws it into
`#nb-sheet-host` with the same Jspreadsheet grid and the header toggle (`#nb-sheet-header-toggle`).
