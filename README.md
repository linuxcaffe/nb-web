# nb-web
A lightweight PWA web interface for [nb](https://github.com/xwmx/nb) — the
plain-text, git-backed, CLI note-taking tool.

## Templates

nb-web supports nb's template system when adding notes. Templates are plain
Markdown files with `{{tag}}` placeholders that nb substitutes at note-creation
time.

### Template storage

| Location | Scope |
|---|---|
| `~/.nb/.templates/` | Global — available in all notebooks |
| `~/.nb/<notebook>/.templates/` | Local — that notebook only; overrides global templates of the same name |

nb-web merges both directories and shows them in the **Template** picker that
appears in the Add opts bar when the note type is *note* or *todo*.

### Template tags

| Tag | Substituted with |
|---|---|
| `{{title}}` | Note title (from the Title field) |
| `{{tags}}` | Hashtag list (from the Tags field) |
| `{{content}}` | Body text (from the Content field or piped input) |
| `{{date}}` | Full output of the system `date` command |
| `{{date +"%Y-%m-%d"}}` | ISO date — `YYYY-MM-DD` |
| `{{date +"%H:%M"}}` | Current time — `HH:MM` |
| `$(command)` | Any shell command substitution |

Templates are processed as Bash strings with `eval`, so arbitrary shell
expressions are valid — keep template files trusted.

### Starter template: `dated-note`

`~/.nb/.templates/dated-note.md` is included as a ready-to-use global template.
It produces a note headed with today's ISO date and a tags line, leaving the
body for your content:

```markdown
# {{title}}

**Date:** {{date +"%Y-%m-%d"}}
**Tags:** {{tags}}

---

{{content}}
```

### Saving a note as a template

Open any note, click **☰** (note menu) → **Save as template…**. A bar appears
below the toolbar where you can name the template and choose *Notebook* (local)
or *Global* scope. The note's raw content — including any existing template tags
— is saved as-is, so you can iterate on a template by editing the template file
itself and re-saving.

### Previewing a template before use

Selecting a template in the Add opts bar loads a read-only preview of the raw
template content in the preview pane, so you can confirm you have the right one
before creating a note.
