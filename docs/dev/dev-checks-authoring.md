<!-- Generated from docs:dev/dev-checks-authoring.md by .tools/readme-export.py. Edit the source, not this file. -->

# Check Script Authoring Guide

> **The governing model is .rules/checks.md.** This guide is the implementation companion — how to write a script that conforms to that model.

A check script is a bash script that runs in the context of a note and reports on its health. This guide covers naming, output formatting, and the developer quality checklist.

---

## Naming convention

`domain-subgroup-specific`

The **subgroup prefix** is the glob target. Putting `hl-opt-` in a `check:` codeblock runs all `hl-opt-*.sh` scripts automatically.

```
hl-core-journal      domain: hl (hledger), subgroup: core
hl-opt-ordereddates  domain: hl,           subgroup: opt
nb-orphan-unindexed  domain: nb,           subgroup: orphan
note-approved        domain: note          (no subgroup needed)
```

Sub-sub-groups are allowed and encouraged when logic demands it (`hl-budget-has-periodic`). Group scripts (a script that just runs other scripts) do not exist — grouping is entirely name-driven.

---

## Invocation modes

Any script works in all three modes. The script doesn't know or care which mode it's in.

| Mode | Syntax | Behaviour |
|------|--------|-----------|
| Button | `` `script-name \| Label` `` | Renders a clickable button; runs on click |
| Auto-run | `` `script-name` `` | Runs immediately; silent on pass |
| Config | `checks: script-name` in FM / folder config | Injected at render time; same as auto-run |

---

## Exit codes

| Code | Severity | Border | Use when |
|------|----------|--------|----------|
| `0` | pass | none | All good — script produces no output |
| `1` | error | red | Action required; something is broken |
| `2` | warn | amber | Advisory; not urgent but worth knowing |

---

## Response package header (optional)

First line of stdout may be a `#!` metadata line. It is stripped before display.

```bash
echo '#! fix:my-fix-script severity:warn'
echo 'Human-readable message here.'
```

Supported keys:

| Key | Effect |
|-----|--------|
| `fix:script-name` | Appends `[→ run fix](subtest:script-name)` link to output |

The `severity:` key is reserved for future use; exit code governs colour now.

---

## Output formatting

Check output is rendered as markdown. Use it.

### Single finding
```bash
echo '**Problem name** — one-sentence consequence. Run `command` to fix.'
exit 2
```

### Multiple findings
```bash
echo '<div data-xref-heading="Problem name">'
echo ''
echo '**Problem name** — consequence:'
echo ''
for item in "${items[@]}"; do echo "- \`$item\`"; done
echo ''
echo '</div>'
exit 1
```

The `data-xref-heading` attribute registers the heading with the xref enrichment system without rendering as a visual `<h2>`. Backtick-quote filenames and commands so they render as code.

### Avoid
- Plain prose without a bold problem name
- Indented lists (`  item`) — use markdown bullets (`- item`)
- ALLCAPS or system-speak ("ERROR: CONDITION_FAILED")

---

## Domain icons

The renderer automatically prepends a domain icon before the first `**` in your output — you don't add it yourself.

| Prefix | Icon |
|--------|------|
| `hl-` | hledger logo (image) |
| `nb-`, `note-` | nb logo (image) |
| `tw-` | Taskwarrior logo (image) |
| `git-` | git logo (image) |
| `flask-` | `FLK` chip (until logo lands in `.images/`) |
| `sys-` | `SYS` chip |
| `test-` | `TST` chip |

**Placement** — the icon is injected by the renderer, not by the script:
- **Group result** — icon leads the script name on each toggle row (`[logo] nb-orphan-annotations`)
- **Single result** — icon appears as a small block above the content

The body text you write in the script is always icon-free. No duplication when multiple checks from the same domain fail.

To add a new domain icon: drop a PNG into `~/.nb/.images/` and add an entry to `_checkDomainIcon()` in `nbweb-codeblocks.js`.

---

## Voice guidelines

Checks speak to the user, not to a log file.

| Instead of | Say |
|------------|-----|
| `ERROR: git remote missing` | `Notebook **home** has no git remote — sync is disabled.` |
| `ORPHAN DETECTED` | `**Orphaned annotation sidecars** — parent note missing:` |
| `CHECK FAILED` | `**note-approved** check failed` (auto-fallback — add a real message) |

Always answer three questions in order:
1. **What** — name the problem (bold)
2. **Why** — one sentence of consequence
3. **Now what** — specific action to take

---

## Developer quality checklist

Before shipping a check script, tick these off:

- [ ] **Named correctly** — follows `domain-subgroup-specific` convention
- [ ] **Silent on pass** — exits 0 with no output when everything is healthy
- [ ] **Right severity** — exit 2 (warn) for advisory, exit 1 (error) for action-required
- [ ] **Answers "what"** — bold problem name on first output line
- [ ] **Answers "why"** — consequence sentence present
- [ ] **Answers "now what"** — specific action or command given
- [ ] **Markdown-formatted** — bullets for lists, backticks for filenames/commands
- [ ] **Guards NB_* vars** — graceful exit 0 if context vars are missing
- [ ] **Fast** — finishes in < 2s for single-note context; < 10s for notebook-wide scans
- [ ] **`check_timeout:` aware** — snooze is handled by the renderer, not the script

---

## Snooze (`check_timeout:`)

Set in the note's frontmatter:

```yaml
check_timeout: 10
```

When the user clicks the dismiss button on a check result, that check is suppressed for 10 minutes. Without `check_timeout:`, the button dismisses until the next render only. The script itself is unaware of snooze state — the renderer handles it.

---

## Tier reference

| Tier | Answers | Example |
|------|---------|---------|
| 1 — Minimum viable | What | `**Sync unwired** — no git remote.` |
| 2 — Helpful | What + Why + Now what | + "Add one: `git remote add origin <url>`" |
| 3 — Excellent | All of the above + fix link | + `#! fix:nb-sync-add-remote` → inline fix button |

Most checks should reach Tier 2. Tier 3 is reserved for high-frequency, high-friction issues where an automated fix makes sense.

---

## See also

- check-index — living catalogue of all scripts
- [testing](dev-checks.md) — renderer internals, API endpoints, test contracts
- [codeblock-authoring](dev-codeblock-authoring.md) — general codeblock authoring guide
