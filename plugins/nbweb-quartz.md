# NbWeb-quartz

Connects nb-web's editing UI to [nb-quartz](https://codeberg.org/linuxcaffe/nb-quartz) publishing pipelines.

## What it does

Activates for any notebook that has a `.nb-website.json` file with a `quartz_path` configured. Adds buttons to the notebook toolbar:

- **🌐 Publish** — pushes the notebook to GitHub, pushes the Quartz config repo, triggers the GitHub Actions deploy workflow, and polls build status until complete.
- **▶ Local preview** — runs `npx quartz build --serve` in the terminal pane for the configured Quartz site.
- **↗ Open site** — opens the published site in a new tab.

## Front-of-house / back-of-house

Every nb note has a **frontmatter** section and a **body**. For published notebooks, the body can serve as a private back-of-house workspace — internal notes, action links, codeblocks — that Quartz never renders.

### Suppress the entire body

Add `private_body: true` to any note's frontmatter:

```yaml
---
title: My Item
price: $40
status: available
private_body: true
---

Internal notes here — never published.
[Mark sold](term:nb edit {selector})
```

This is the default for shop item notes — the item template includes `private_body: true` automatically so the body is always a back-of-house workspace.

### Split a note mid-body

Use the `<!-- nb:private -->` sentinel to publish everything above the marker and suppress everything below:

```markdown
This paragraph is published.

More published content here.

<!-- nb:private -->

Everything from here down is back-of-house only.
Internal notes, term: links, codeblocks — Quartz never sees any of it.
```

This works in any note type — content pages, blog posts, index pages. Useful when you want a published introduction alongside private working notes in the same document.

### Back-of-house superpowers

Because the body is private, you can embed live widgets and action links freely:

```markdown
<!-- nb:private -->

Status: `available` → change to `sold` when purchased

[Mark as sold](term:nb edit {selector})
[Remove listing](term:nb delete {selector})

` `` `tw
+{title} status:pending
` `` `
```

The body becomes a per-item command centre: action links that run nb commands, live Taskwarrior queries scoped to this item, shipping notes, buyer correspondence — all invisible to the published site.

## Setup

Run `nb-website-setup.sh` to wire a notebook to a new Quartz site. The setup script creates `.nb-website.json` automatically.

To configure an existing notebook manually, create `.nb-website.json` in the notebook directory:

```json
{
  "name": "my-notebook",
  "url": "https://mysite.com",
  "quartz_path": "~/dev/quartz-my-notebook"
}
```

## Requirements

- `gh` CLI authenticated (`gh auth login`)
- Quartz config repo pushed to GitHub with a `deploy.yml` Actions workflow
- Notebook wired to a GitHub remote (`nb remote`)
- `PrivateBody` transformer in `quartz.config.ts` (included in nb-website setups)
