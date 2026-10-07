<!-- Generated from docs:CHECKS.md by .tools/readme-export.py. Edit the source, not this file. -->

# Checks

The checks system embeds live, script-driven diagnostics directly in notes. Scripts live in `~/.nb/.checks/` and run via the Flask server — no terminal needed. A passing check is completely invisible; a failing check surfaces its output inline.

**Four modes, one script fleet** — the same scripts work in all modes:

---

## Modes

| Mode | Syntax | Behaviour |
|------|--------|-----------|
| **Form 1** — on-demand | `` ```check`` + `script \| Label` | Renders a `▶ Label` button; runs on click |
| **Form 2** — auto-run | `` ```check`` + `script` (no label) | Runs at render time; silent on pass |
| **Form 3** — group | `` ```check`` + multiple scripts, one per line | All run in parallel; failure summary with per-script toggles |
| **Form 4** — list | `` ```check`` + `list` or `list prefix-` | Script browser barblock — starts collapsed; click icon for `--demo` |
| **Virtual** | `checks: prefix` in note FM / folder / notebook config | Injects Form 2 fences at render time; never fires on config files |

`check: list` cannot be set via the `checks:` FM key — YAML parses it as a config key/value, not a fenced block. **List mode is body-fenced only.**

---

## Exit codes

Scripts communicate severity through exit code:

| Code | Border | Meaning |
|------|--------|---------|
| `0` + no output | none | **Pass** — block vanishes entirely |
| `0` + output | none | Advisory render (amber banner pattern — see `note-approved`) |
| `1` | red | **Error** — action required |
| `2` | amber | **Warn** — advisory, non-urgent |

Output is rendered as full markdown — headings, tables, blockquotes, `{{hledger: query}}` inline expressions, `[[wikilinks]]`, `term:` links, and `note:` links all work.

---

## Script location and naming

All scripts live in `~/.nb/.checks/`. Scripts are resolved by name — `.sh` extension is optional.

### Namespace convention

Scripts follow a **left-to-right hierarchical namespace** using `-` as separator:

```
hl-                       all hledger scripts
hl-core-                  hledger core validity (journal, binary test)
hl-entry-                 posting cadence (day, week)
hl-reconcile-             bank reconciliation (month, gap, future)
hl-close-                 period close (year)
hl-tax-                   tax preparation
hl-opt-                   optional hledger checks (ordereddates, tags, payees…)
hl-budget-                budget integrity sub-group
nb-                       all nb scripts (dirty, orphan-annotations, sync-unwired…)
sys-                      system health (disk, process, version)
tw-                       Taskwarrior integration checks
note-                     per-note checks (approved, slow)
test-                     nb-web self-tests (access, syntax, settings…)
```

**The trailing-dash glob** — a `check` block body ending with `-` runs every script in that subgroup:

````markdown
```check
hl-entry-
```
````

fires `hl-entry-day.sh`, `hl-entry-week.sh`, etc.

**No bundler scripts** — grouping is name-driven only. A script that does nothing but call other scripts does not exist.

Browse and edit all scripts in place:

````markdown
```nav
~/.nb/.checks
```
````

---

## Context Variables

Every script receives these environment variables:

| Variable | Example value | Notes |
|---|---|---|
| `NB_DIR` | `/home/djp/.nb` | nb root directory |
| `NB_NOTE_SELECTOR` | `accts:guide/review.md` | Currently open note |
| `NB_NOTEBOOK` | `accts` | Notebook portion of selector |
| `NB_NOTE_PATH` | `/home/djp/.nb/accts/guide/review.md` | Absolute path to note file |

Scripts that touch hledger should resolve the journal explicitly — Flask's subprocess environment may not match a login shell:

```bash
journal="${HLEDGER_FILE:-$HOME/.hledger.journal}"
[ ! -f "$journal" ] && exit 0
hledger bal -f "$journal" ...
```

---

## `--demo` escape hatch

Every script must implement `--demo` — checked **before** the env guard, so it works from the CLI with no nb context:

```bash
if [[ "$1" == "--demo" ]]; then
    echo '**Problem name** — realistic consequence sentence.'
    echo ''
    echo '- `realistic-filename-or-item`'
    echo ''
    echo 'Specific action to fix it.'
    exit 1  # match the real failure exit code
fi

[ -z "$NB_NOTE_PATH" ] && exit 0   # env guard follows
```

**The demo block is a recipe.** It must be written with enough fidelity that it could be mistaken for real output — realistic filenames, plausible values, the actual error voice. If you can't write a convincing demo block, you don't yet understand the failure well enough to ship the script.

**Three purposes:**
1. **Testability** — `bash script.sh --demo` works immediately from any terminal
2. **List mode** — `check: list` icon click triggers `--demo` on the selected script (no real condition needed)
3. **Specification** — writing the demo block forces clarity about what the failure looks like

---

## Tier model

Scripts are graded by how completely they answer the three core questions (what / why / now what):

| Tier | Answers | State |
|------|---------|-------|
| 1 | What only | Draft / acknowledged debt |
| 2 | What + Why + Now what | Minimum for a shipped script |
| 3 | Tier 2 + automated `fix:` link | High-frequency, high-friction issues only |

The `#!` response package header on the first line of stdout attaches a fix link:

```bash
echo '#! fix:nb-sync-add-remote'
echo '**Notebook unwired** — no git remote, sync is disabled.'
exit 2
```

This appends `[→ run fix](subtest:nb-sync-add-remote)` to the output inline. Tier 3 is reserved for issues where running a fix script is genuinely faster than following a manual instruction.

---

## Shared libraries

Scripts should source from `~/.nb/.checks/lib/` rather than duplicating logic:

| Library | Provides |
|---------|----------|
| `hl-common.sh` | `hl_is_query_word()` — full hledger command dict; `hl_journal()` — active journal resolver |

Add to `lib/` when two or more scripts need the same logic.

---

## Writing Scripts

### Passing silently

Exit 0 with no output. The block disappears from the note entirely (Form 2).

```bash
#!/usr/bin/env bash
# Pass silently when disk is healthy
pct=$(df "$HOME" | awk 'NR==2 { gsub(/%/,""); print $5 }')
[ "${pct:-0}" -lt 80 ] && exit 0
echo "### ⚠ Disk ${pct}% full"
df -h "$HOME" | awk 'NR==1||NR==2'
```

### Markdown output

Scripts can output any markdown — headings, tables, blockquotes, inline code. The rendered output blends with note content.

```bash
echo "| Account | Balance |"
echo "|---|---:|"
hledger bal -f "$journal" --flat --depth 1 -O csv --no-total \
  | tail -n +2 \
  | while IFS=, read -r acct amt _; do
      echo "| \`${acct//\"/}\` | ${amt//\"/} |"
    done
echo ""
echo "> *as of $(date '+%Y-%m-%d')*"
```

### Amber banner output

For informational notices that aren't errors — approval status, configuration hints, soft warnings — output a `<div class="nb-alert-banner">` instead of a heading or blockquote. This renders in the app's amber alert palette (the same colour as the render progress bar) without the red left-border of a failure.

```bash
echo '<div class="nb-alert-banner">⚠ This note is pending approval.</div>'
```

Exit 0 with this output: the block renders the amber notice. Exit 0 with no output: the block vanishes silently (pass). The `.nb-alert-banner` class is defined in `styles.css` and available to any check script.

`note-approved` is the reference implementation — read it before writing a new amber-banner script.

### Scoped to current note

Use `NB_NOTEBOOK` to scope checks to the notebook the note lives in:

```bash
[ -z "$NB_NOTEBOOK" ] && exit 0
nb_path="$NB_DIR/$NB_NOTEBOOK"
[ ! -d "$nb_path/.git" ] && exit 0
status=$(git -C "$nb_path" status --short 2>/dev/null)
[ -z "$status" ] && exit 0
echo "### Uncommitted changes in \`$NB_NOTEBOOK\`"
echo '```'
echo "$status"
echo '```'
```

---

## Bundled Scripts

| Script | Form | Purpose |
|---|---|---|
| `hl-core-journal` | 2 | Silent when journal is clean; shows `hledger check` errors |
| `hl-core-test` | 2 | hledger binary self-test; silent when all pass; surfaces failing test names |
| `hl-mode-strict` | 2 | `hledger check --strict`; explains undeclared commodity errors |
| `hl-opt-ordereddates` | 2 | Transactions out of date order within a file |
| `hl-opt-recentassertions` | 2 | Balance assertions older than 7 days; guides reconciliation |
| `hl-opt-tags` | 2 | Undeclared tag names (opt-in strict check) |
| `hl-opt-payees` | 2 | Undeclared payees (opt-in strict check) |
| `hl-opt-uniqueleafnames` | 2 | Two accounts share a leaf name (opt-in strict check) |
| `hl-entry-day` | 2 | Silent if entries today; coaches when there's a gap |
| `hl-entry-week` | 2 | Silent if entries this week; flags a growing gap |
| `hl-reconcile-month` | 2 | Silent if past months cleared; flags unreconciled |
| `hl-close-year` | 2 | Silent if previous year fully cleared; guides year-end close |
| `hl-tax-ready` | 2 | Silent if prior year tax-ready; flags what's missing |
| `hl-budget-has-periodic` | 2 | Guides setup if no `~ monthly` rules found |
| `hl-budget-has-actuals` | 2 | Checks that actual transactions exist to compare against budget |
| `hl-budget-has-income` | 2 | Checks that income postings exist in the budget |
| `hl-budget-balanced` | 2 | Detects unbalanced budget transactions; computes fix amount |
| `hl-budget-include-check` | 2 | Verifies periodic journal is included in main journal |
| `hl-budget-runs` | 2 | Verifies `hledger bal --budget` runs without error |
| `nb-dirty` | 2 | Silent when committed; lists dirty files in current notebook |
| `nb-check-front` | 2 | Validates note frontmatter against folder `constraints:` |
| `sys-disk-warn` | 2 | Silent under 80% disk usage; warns above that |
| `tw-due` | 2 | Silent with no due tasks; lists overdue/today tasks |
| `note-approved` | 2 | Silent when `approved:` frontmatter has a value; amber banner when blank |
| `note-slow` | — | Retired; rendering notices now injected by main.js |
| `hl-disp-recent-txn` | 1 | `hl-disp-recent-txn \| Recent transactions` — last 14 days from journal |
| `hl-disp-balances` | 1 | `hl-disp-balances \| Account balances` — depth-1 balance table |
| `note-context` | 1 | `note-context \| Note context` — markdown table of all context vars |

Browse and edit them in-place:

````markdown
```nav
~/.nb/.checks
```
````

---

## `check: list` — script browser

A `list` query turns the `check` block into a **barblock** — a collapsible header-bar block that starts closed and lists all scripts (or a filtered subset):

````markdown
```check
list
```
````

Or scoped to a namespace prefix:

````markdown
```check
list hl-
```
````

The header shows the block name, script count, and prefix filter. On expand: one row per script with an icon button (left) and name button (right).

- **Icon click** — runs the script in `--demo` mode and shows the output inline. Click again to dismiss. This is a preview of what the failure looks like, not a live check.
- **Name click** — opens the script file in preview for reading/editing.
- **↻ refresh** — re-fetches the script list (picks up newly added scripts).

**FM restriction** — `check: list` cannot appear in a `checks:` FM config key. YAML would parse it as `{check: "list"}` — a key/value, not a fenced block trigger. Use list mode only in note body fences.

---

## Placement Patterns

**Health dashboard** — drop Form 2 checks at the top of a hub note. They're invisible when everything is fine; they surface when something needs attention:

````markdown
```check
hl-core-journal
```

```check
nb-dirty
```

```check
sys-disk-warn
```

```check
tw-due
```
````

**On-demand reference** — Form 1 in a journal note or guide section:

````markdown
```check
hl-disp-recent-txn | Recent transactions
```

```check
hl-disp-balances | Account balances
```
````

**Invisible guardrail** — embed a check in a setup or onboarding note. New users see the error; experienced users with everything configured see nothing:

````markdown
```check
hl-core-journal
```

## Your Journal
...
````

---

## Virtual checks — `checks:` config key

The `checks:` key in note FM, folder config, or notebook config injects Form 2 fences automatically at render time — no fenced block needed in the note body.

```yaml
# ~/.nb/.nb.md (global — fires on every note)
checks: nb-

# ~/.nb/accts/.accts.md (notebook — fires on every accts: note)
checks: hl-entry-day

# ~/.nb/accts/guide/.guide.md (folder — fires on every note in guide/)
checks: hl-

# In any individual note's frontmatter (per-note override)
checks: hl-entry-week
```

Resolution: note FM wins → folder config walk-up (innermost first) → notebook config → global.

**Suppression** — set `checks:` (bare null) in a child config to silence inherited checks for that scope. Prefer bare `checks:` over `checks: ""` — the manual YAML fallback parser reads `""` as the literal string `'""'` and tries to run it as a script name.

Virtual checks are always **Form 2** (auto-run, silent on pass). If you need a labeled button (Form 1), put the fenced block explicitly in the note body. Config files (`type: dotfile`) are exempt — the system never injects checks into its own config sources.

---

## Snooze — `check_timeout:` FM key

When a note has `check_timeout: 10` in its frontmatter, the dismiss button becomes a snooze button — clicking it suppresses that check for 10 minutes (stored in `localStorage`). Auto-runs silently skip snoozed checks; button-triggered runs (Form 1) always fire. The script is unaware of snooze state.

---

## Status Panels

The most powerful pattern: a dedicated `status.md` note containing only Form 2 test blocks, included at the top of any note via `{{inline:}}`.

```markdown
{{inline: accts:status.md}}

# My Note
...
```

`status.md` has **zero visual footprint** when everything is healthy — the inline renders nothing, and the note appears exactly as if the line wasn't there. The moment any test fails, its output surfaces right at the top of whatever note you happen to be reading.

Because `{{inline:}}` runs the full rendering pipeline on included content, test blocks in `status.md` receive the **host note's context** — `NB_NOTEBOOK` reflects the notebook you're currently in, so `nb-dirty` reports on the right notebook automatically.

### Creating a status file

A status file is just a note with tightly-packed Form 2 blocks and nothing else:

````markdown
```check
hl-core-journal
```
```check
nb-dirty
```
```check
sys-disk-warn
```
````

No headings, no prose — the file should be entirely invisible when healthy. Give it a name that makes its scope clear: `status.md`, `accts:status.md`, `home:status.md`.

### Scoped status files

Different notebooks have different concerns. Include the right status file in each context:

```markdown
{{inline: accts:status.md}}     ← hledger journal health, uncommitted accts changes
{{inline: home:status.md}}      ← disk space, overdue tasks, nb-dirty for home
```

Or include multiple in a master hub note to get a unified view across all concerns.

### The key insight

You would never know a note had a status panel until errors started appearing. The diagnostic layer is woven into the note invisibly — no separate dashboard to remember to check, no polling, no notification system. The note itself becomes aware of problems in its context.

---

## Good Test Output

A well-written Form 2 script is invisible when everything is fine and informative when it isn't. These conventions make failure output consistent, readable, and actionable.

### Anatomy of a good error block

**`hl-budget-has-periodic.sh`** is the reference example — read it before writing a new script.

````markdown
### ⚠ Short description of the problem

One sentence: what is wrong and why it matters. No preamble, no "note that".

**Fix** — what to do, named specifically:

```ledger
~ monthly from 2025-01-01
    Expenses:Food   CAD 800
    [Budget]
```

If a second fix exists, name it **Fix 2** with a concrete example.

An embedded block lets the user verify the fix without leaving the note:

```check
hl-budget-include-check
```

[Open actual-filename.journal](note:/absolute/path/to/file)
````

### Rules

**Heading** — always `### ⚠` (H3, warning sign, space, short phrase). This is what appears in book TOCs.

**First line of body** — one sentence of context. Why does this matter? What breaks if you ignore it? No "Note:" or "Warning:".

**Fix blocks** — `**Fix**` or `**Fix 1**` / `**Fix 2**` for alternatives. Always include a concrete code block. `ledger` fence for journal snippets; `bash` for shell commands.

**Verify block** — if there is a cheaper test that confirms the fix worked, embed it as a `test` block right after the fix. The user sees it pass (and vanish) in the same note.

**Open link — last line** — always end with `[Open actual-filename.ext](note:/absolute/path)`. Use `$(basename "$journal")` to show the real filename, not a generic label like "journal". The link lets the user jump directly to the file they need to edit.

**Related files at the bottom** — when a note documents this design, link to the scripts themselves so the reader can read the reference implementation.

### What to avoid

- Long preambles or repeated context before the fix
- Generic `[Open journal](note:...)` — use the actual filename
- Skipping the verify block when a quick check exists
- Output on exit 0 (causes the block to render instead of disappear)

---

## Test Script Files

Browse and edit all scripts in place:

````markdown
```nav
~/.nb/.checks
```
````

Key scripts — read these for reference before writing new ones:

- [hl-core-journal.sh](note:/home/djp/.nb/.checks/hl-core-journal.sh) — simplest Form 2: silent pass, one check, raw error fallback
- [hl-core-test.sh](note:/home/djp/.nb/.checks/hl-core-test.sh) — "is the tool intact?" check; complements hl-core-journal which checks data, not binary
- [hl-mode-strict.sh](note:/home/djp/.nb/.checks/hl-mode-strict.sh) — multiple fix options (A/B/C), handles bare-number commodity `""`
- [hl-opt-ordereddates.sh](note:/home/djp/.nb/.checks/hl-opt-ordereddates.sh) — out-of-order date check; explains secondary-date workaround
- [hl-opt-recentassertions.sh](note:/home/djp/.nb/.checks/hl-opt-recentassertions.sh) — stale assertion check; shows `hledger close --assert` workflow
- [hl-opt-tags.sh](note:/home/djp/.nb/.checks/hl-opt-tags.sh) — undeclared tags; warns about accidental tags in comments
- [hl-opt-payees.sh](note:/home/djp/.nb/.checks/hl-opt-payees.sh) — undeclared payees; links to `payees` command for discovery
- [hl-opt-uniqueleafnames.sh](note:/home/djp/.nb/.checks/hl-opt-uniqueleafnames.sh) — duplicate leaf names; shows grep to find all affected postings
- [hl-budget-has-periodic.sh](note:/home/djp/.nb/.checks/hl-budget-has-periodic.sh) — gold standard: heading, context, fix block, embedded verify, open link
- [hl-budget-balanced.sh](note:/home/djp/.nb/.checks/hl-budget-balanced.sh) — computes fix amount, shows mtime so user knows if edit landed
- [hl-budget-include-check.sh](note:/home/djp/.nb/.checks/hl-budget-include-check.sh) — used as an embedded verify block inside hl-budget-has-periodic
- [nb-dirty.sh](note:/home/djp/.nb/.checks/nb-dirty.sh) — uses `NB_NOTEBOOK` context var; scoped to current notebook
- [sys-disk-warn.sh](note:/home/djp/.nb/.checks/sys-disk-warn.sh) — minimal Form 2 shown in the Writing Scripts section above
- [note-approved.sh](note:/home/djp/.nb/.checks/note-approved.sh) — reference implementation for amber `.nb-alert-banner` output; reads frontmatter with awk
- [hl-disp-recent-txn.sh](note:/home/djp/.nb/.checks/hl-disp-recent-txn.sh) — Form 1 (label, on-demand); markdown table output
- [hl-disp-balances.sh](note:/home/djp/.nb/.checks/hl-disp-balances.sh) — Form 1 with table and blockquote timestamp

---

## Books — the diagnostic TOC

When Form 2 test blocks are embedded in chapter notes inside a `type: book`, something remarkable happens: failing checks produce `### ⚠ Heading` output that gets picked up by the book's TOC rebuild. The table of contents becomes simultaneously a chapter navigator and a live health dashboard — diagnostic entries appear in the navigation, positioned exactly where the problem lives in the document.

A healthy book shows a clean TOC. A book with configuration problems shows `⚠` entries inline with chapter headings. No separate dashboard, no extra code — it's an emergent property of the test + inline + TOC pipeline.

See [BOOKS](BOOKS.md) for the full pattern, design guidance, and The Bookkeeper's Guide as a worked example.

---

## See also

- [CODEBLOCKS](CODEBLOCKS.md#test--embedded-assertions) — codeblock syntax reference; access gates; fenced Forms 1–3
- [testing](dev/dev-checks.md) — renderer internals, virtual check wiring, API endpoints, batch fetch
- [Check Script Authoring Guide](dev/dev-checks-authoring.md) — detailed authoring guide; output conventions; developer checklist
- .rules/checks.md — normative laws (Laws 1–8); tier model contract; shared library convention
