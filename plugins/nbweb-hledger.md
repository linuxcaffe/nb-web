# NbWeb-hledger

Plain-text accounting for nb-web — Canadian domain knowledge, chart of accounts wizard, and inline journal entry on top of [hledger](https://hledger.org/).

---

## Activation

Create a `.nb-hledger.json` anchor file in any nb notebook directory to activate the plugin for that notebook:

```json
{
  "journal": "/path/to/your.journal",
  "province": "BC",
  "commodity": "CAD",
  "entity": "personal"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `journal` | yes | Path to your main journal file |
| `province` | yes | Two-letter province code — drives tax account structure |
| `commodity` | no | Default commodity symbol (default: `CAD`) |
| `entity` | no | `personal`, `smallbiz`, or `production` |

After creating the anchor file, the notebook will show the hledger icon and activate the plugin panel.

---

## Province codes

| Code | Province | Tax regime |
|------|----------|------------|
| `AB` | Alberta | GST only |
| `BC` | British Columbia | GST + PST |
| `MB` | Manitoba | GST + PST |
| `NB` | New Brunswick | HST |
| `NL` | Newfoundland & Labrador | HST |
| `NS` | Nova Scotia | HST |
| `NT` | Northwest Territories | GST only |
| `NU` | Nunavut | GST only |
| `ON` | Ontario | HST |
| `PE` | Prince Edward Island | HST |
| `QC` | Québec | GST + QST |
| `SK` | Saskatchewan | GST + PST |
| `YT` | Yukon | GST only |

---

## Note types

| Type | Frontmatter | Purpose |
|------|-------------|---------|
| `account` | `hledger_account`, `cra_label`, `cra_line_t1`, `cra_line_t2125` | One note per leaf account — docs, tax mapping, opening balance |
| `template` | `hledger_template` | Recurring transaction templates (mortgage, payroll, etc.) |
| `period` | `hledger_period` | Month-end or year-end checklist |
| `report` | `hledger_report` | Curated hledger report queries |

### Account note frontmatter

```yaml
---
title: Chequing Account
type: account
hledger_account: Assets:Cash:Chequing
cra_label: Bank accounts
cra_line_t1: ""
---
```

---

## Chart of Accounts wizard

The plugin panel includes a **Chart of Accounts** wizard that generates a complete `accounts.journal` from scratch.

1. Choose a **domain** — personal (Canada), small business (Canada)
2. Choose your **province** — drives which tax accounts are created
3. Select **options** (RRSP, TFSA, FHSA for personal; payroll, HST for small biz)
4. Click **Preview** to see the account list before writing
5. Click **Generate** to write `accounts.journal` to your notebook

If your main journal already exists, you'll get an `include` directive to paste in.

The wizard creates one `account` note per leaf account — each note is a stub with frontmatter and a one-line description. Fill in the details as you use the accounts.

---

## Journal file preview

`.journal`, `.ledger`, and `.hledger` files open with syntax highlighting in the preview pane:

| Token | Highlighted as |
|-------|---------------|
| Transaction dates (`2024/01/01`) | constant |
| Account names (indented postings) | string |
| Amounts | variable |
| Comments (`;`) | muted |
| Directives (`account`, `payee`, `include`, …) | keyword |
| Tags (`:tagname:`) | tag |

### Clickable `include` links

`include` directives in a journal file are rendered as clickable links — click the path to open that file directly in the preview pane.

```
include accounts.journal        ← click to open
include ./subdir/payees.journal ← click to open
```

Links are resolved relative to the current journal file's location. A dotted underline means the file is found in the notebook; a strikethrough means it couldn't be resolved (e.g. an absolute path outside the notebook tree).

This makes it easy to browse a multi-file journal — follow the include chain without leaving the app.

---

## Inline journal entry

In any hledger codeblock, click **[+ Add]** to open the inline entry form:

- **Date** — defaults to today
- **Description** — payee / narration
- **Postings** — account (with autocomplete from your chart), amount, optional comment
- **[Cancel] [Save]** — Save appends the transaction to the journal

Account autocomplete is sourced from `hledger accounts --flat` against your configured journal — it respects your full include chain.

---

## Queries (list panel)

| List type | Shows |
|-----------|-------|
| `account` | All `type: account` notes, hierarchically sorted |
| `template` | Transaction templates |
| `period` | Checklists (month-end, year-end) |
| `report` | Saved report views |

Default list opens on `account` type with hierarchy sort.

---

## CRA tax mapping

Account notes support CRA line number fields for tax return prep:

| Field | Return | Example |
|-------|--------|---------|
| `cra_line_t1` | T1 personal | `line_15000` |
| `cra_line_t2125` | T2125 self-employment | `line_8860` |

These fields are populated by the CoA wizard based on the domain pack's built-in mappings. You can edit them directly in the note frontmatter.

When accounts have `cra_line_t1` values, the **T1 report** (under Reports) groups balances by return line — useful for tax prep without a bookkeeper.

---

## Chart codeblocks

Add a `` ```chart ``` `` fence anywhere in a note to render an interactive financial chart:

````markdown
```chart
cashflow thisyear
```
````

The fence body is `<report> [period] [depth:N]`.

### Report types

| Report | Default view | Description |
|--------|-------------|-------------|
| `cashflow` | bar + line | Monthly income vs expenses with cumulative net change |
| `networth` | line | Assets, liabilities, and net worth over time |
| `expenses` | stacked bar | Monthly expense breakdown by category |
| `expenses-pie` | doughnut | Expense share by category for the period |
| `assets-pie` | doughnut | Asset allocation snapshot |
| `income-pie` | doughnut | Income sources for the period |

### Options

- **Period** — any hledger period expression: `thismonth`, `thisyear`, `lastyear`, `last6months`, `2025`, `2025-01..2025-06`, …
- **`depth:N`** — account depth for category breakdown (default `2`). Higher values show more granular sub-categories.
- **`-p period`** — alternative flag syntax, e.g. `cashflow -p lastyear`

### Header controls

Every chart block has an interactive header:

- **▾ / ▸** — click the toggle or the report name to collapse/expand the chart body
- **mo / yr / prev** — quick period switcher; reloads data from hledger
- **◕ / ▦** — toggle between doughnut and bar views (`*-pie` and `expenses` only); redraws without re-fetching
- **↺** — force reload from hledger

### Examples

````markdown
```chart
networth last2years
```

```chart
expenses-pie thismonth depth:3
```

```chart
expenses lastyear depth:2
```
````

---

## hledger docs

Full hledger documentation: <https://hledger.org/docs.html>

Key references:
- [Journal format](https://hledger.org/1.34/hledger.html#journal-format)
- [Account names](https://hledger.org/1.34/hledger.html#account-names)
- [include directive](https://hledger.org/1.34/hledger.html#including-other-files)
- [hledger commands](https://hledger.org/1.34/hledger.html#commands)
