<!-- Generated from docs:blocks/hl.md by .tools/readme-export.py. Edit the source, not this file. -->

# hl — Accounting

## Summary

An `hl` block runs an hledger report and shows the result in the note: balances, registers,
income statement, balance sheet, cash flow. The body is an hledger command line (`bal expenses
--monthly -3`); it reads the note's `journal:` when the line names no file. `+` adds a
transaction, ↻ re-runs the report, and the **hledger** label opens hledger itself.

## How it works

````markdown
```hl
bal expenses --monthly -3
```
````

The body is what you'd type after `hledger`. Balance, register and the sectioned reports
(`is`, `bs`, `bse`, `cf`) render as tables; other commands (`print`, `stats`, `files`, …) as
plain text. Amounts are coloured by sign.

| Command | Shows |
|---|---|
| `balance` · `bal` · `b` | account tree |
| `register` · `reg` · `r` | postings with a running balance |
| `incomestatement` · `is` | revenues and expenses |
| `balancesheet` · `bs` (`bse` with equity) | assets and liabilities |
| `cashflow` · `cf` | cash flow |

**Which journal.** A body starting with a path (`~/…` or `/…`) or containing `-f` uses that
file. Otherwise the note's `journal:` frontmatter (its own, or inherited from a folder or
notebook config) is put in front. Filters are hledger's own: `--period thisweek`, `--depth 2`,
`tag:name`, `--begin 2026-01-01`, `--end 2026-12-31`.

**Adding a transaction (`+`).** Opens a posting form under the header. If the query names an
account (`reg Assets:Bank`), the first account field starts with it; in a daily note named
`YYYYMMDD.md`, the date starts at that day instead of today. Account fields suggest names from
the journal.

**The hledger label.** Clicking it opens hledger: in the terminal or hledger-web, as set in
Settings → Codeblocks (until it's set, the click opens that setting). An admin script
`.lib/open-block-hl-<level>.sh` takes over the click when present.

**Special bodies**

| Body | Shows |
|---|---|
| `ui` (`~/x.journal ui \| label`) | hledger-ui in a terminal inside the note |
| `web` | a button that opens hledger-web |
| `regen .tools/<name>.py \| label` | a button that runs that script in the note's notebook (regenerating journals), then refreshes the note's other `hl` blocks |

A body of `source:` / `filter:` / `timeframe:` / `group:` lines queries entries kept in another
note's codeblocks instead of a journal file (a project diary's timedot and csv blocks); see
[CBQL](../dev/dev-cbql.md#cbql-read-path).

**Example entries.** Use a ` ```ledger ` block, not `hl`, for sample journal text in docs and
tutorials: it's shown highlighted and never run.

## Reference

- Needs `hledger` on the server's `$PATH` (`hledger-ui` / `hledger-web` for those bodies).
- Who can see blocks and who can add transactions: `codeblock_access: hl: {read:, write:}`
  (see [Access gates](../CODEBLOCKS.md#access-gates)).
- Also released on its own: [hledger-codeblock](https://github.com/linuxcaffe/hledger-codeblock).
- In frontmatter (`hl: bal -2`) it shows in the note's header strip instead of the body.

## For developers

Renderer: `_loadHledgerBlock` (`plugins/nbweb-codeblocks.js`), backed by `/api/hledger-query`;
the add form is `_showHledgerAddForm`. Accounting domain notes: the `hledger` skill and
[nbweb-hledger](https://github.com/linuxcaffe/nbweb-hledger).
