<!-- Generated from docs:blocks/t.md by .tools/readme-export.py. Edit the source, not this file. -->

# t — Timeclock

## Summary

A `t` block is a live time clock in the note: it shows whether you're clocked in and a report of
the hours logged this period, side by side, with buttons to clock in and out. It reads your
Taskwarrior timeclock file through the `t` CLI; a toggle flips it to show timedot hours instead,
and when both have entries for the period it shows a combined total.

## How it works

````markdown
```t
today
```
````

The body is the report period:

| Body | Report covers |
|---|---|
| `today` *(default)* | since midnight |
| `thisweek` | since Monday |
| `lastweek` | the previous Monday–Sunday |
| `thismonth` | since the 1st |
| `lastmonth` | the previous calendar month |

**The header.** The left shows status — clocked in (with a running timer), out, or no entries —
and the right has the controls:

| Button | Does |
|---|---|
| `⏱ In` | opens a form (account picker + description) and clocks in |
| `◼ Out` | clocks out of the current entry |
| `.` / `tc` | toggles between timeclock and timedot view |
| `↻` | refresh |

**Timedot view (`.`).** Flips the header to your last timedot entry and the report to timedot
hours. Use it when you log some work by the clock and some as [timedot](timedot.md)
dots.

**Combined total.** When the period has both clocked and timedot hours, a row at the foot adds
them: `1h15m tc + 2.5h td → 3.8h`.

**Which files.** By default the clock is your global timeclock file (`timelog.file` in
`~/.task/config/timelog.rc`). Point a note or a whole notebook at project files with
`timelog_file:` / `timedot_file:` in frontmatter — see [[docs:blocks/timedot.md#Reference|File
scoping]]. Every button then reads and writes those files.

## Reference

- Needs the `t` timeclock CLI (part of the Taskwarrior timewarrior/timeclock setup) and a
  readable timeclock file.
- `⏱ In` / `◼ Out` write to the timeclock file, so they need at least a `user`-level account; a
  `file:` outside your notebooks needs tech (invariant 77).
- In frontmatter (`t: thisweek`) it shows in the note's header strip instead of the body.

## For developers

Renderer: `_loadTBlock` / `_buildTBlock` (`plugins/nbweb-codeblocks.js`), backed by `/api/t/status`,
`/api/t/report`, `/api/t/in`, `/api/t/out` and the `/api/t/timedot/*` reads. Period bounds:
`_t_period_bounds` in `app.py`; every `file=` goes through `@_time_file_gate` /
`_time_file_refusal`. Billing on top of this data: `docs:dev/dev-billing-milestones.md`. #REVIEW
