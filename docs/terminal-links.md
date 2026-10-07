<!-- Generated from docs:terminal-links.md by .tools/readme-export.py. Edit the source, not this file. -->

# Terminal links

## Summary

A Markdown link whose URL starts with `term:` runs a shell command in nb-web's terminal pane
when clicked: `[Today's tasks](term:task%20due:today)`. Write spaces in the command as `%20`.
Commands can name the current note with `{file}`, `{dir}`, `{notebook}` and friends, so one link
in a template gives every note a "run this" button.

## How it works

```markdown
[label](term:command)
```

Terminal links render with a `▶` prefix in monospace yellow, so they stand apart from navigation
links. If the terminal pane is open, the command goes to the running session; if not, the pane
opens first and then runs it.

**Spaces must be written as `%20`.** A Markdown link's URL can't contain a plain space, so
`[Sync](term:nb sync)` is shown as literal text, not a link. Write `[Sync](term:nb%20sync)`; the
command is decoded before it runs.

### File variables

Commands can refer to the **current note** with `{variable}` placeholders, filled in at click time:

| Variable | Resolves to |
|----------|-------------|
| `{file}` | Full path to the note file: `/home/you/.nb/home/note.md` |
| `{dir}` | Directory containing the note: `/home/you/.nb/home` |
| `{name}` | Filename without extension: `note` |
| `{selector}` | nb selector: `home:note.md` |
| `{notebook}` | Notebook name: `home` |
| `{title}` | Note title from frontmatter |

```markdown
[Open in vim](term:vim%20{file})
[Run as script](term:bash%20{file})
[→ PDF](term:pandoc%20{file}%20-o%20{dir}/{name}.pdf)
[Git history](term:git%20-C%20{dir}%20log%20--oneline%20--%20{file})
[Spellcheck](term:aspell%20check%20{file})
```

Variables are most useful in **templates**: a `[Run](term:bash%20{file})` link in a notebook's
template gives every note made from it a run button.

### Creating a note from a template

`nb add` has a `--template <name>` flag (it looks up `.templates/<name>.md`), so a terminal link
can create a new, properly indexed note on the spot, unlike a raw `cp`/`touch` into the notebook
folder, which leaves the file unindexed:

```markdown
[Create a new project](term:nb%20add%20{notebook}:new-project.md%20--template%20project)
```

`{notebook}` makes the link work wherever it's clicked; write a notebook name instead
(`accts:new-project.md`) to fix it to one place.

## Reference

| Example | What it does |
|---------|-------------|
| `[Preview site](term:cd%20~/dev/mysite%20&&%20npx%20quartz%20build%20--serve)` | Starts a local Quartz preview server |
| `[Today's tasks](term:task%20due:today)` | Opens Taskwarrior filtered to today |
| `[Open task UI](term:task)` | Launches the Taskwarrior TUI |

- Terminal links work anywhere Markdown renders: note bodies, templates, included notes.
- They are **not** published by Quartz (`term:` means nothing on a static site).

## For developers

- [Wikilinks internals](dev/dev-wikilinks.md)
- [Markdown rendering pipeline](dev/dev-architecture.md#markdown-rendering-pipeline)

[wikilinks](dev/dev-wikilinks.md) covers link rendering; the click handler is in `main.js`
(`href.startsWith('term:')`).
