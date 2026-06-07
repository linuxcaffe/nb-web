# NbWeb-quartz

Connects nb-web's editing UI to [nb-quartz](https://codeberg.org/linuxcaffe/nb-quartz) publishing pipelines.

## What it does

Activates for any notebook that has a `.nb-website.json` file with a `quartz_path` configured. Adds two buttons to the List panel toolbar:

- **🌐 Publish** — pushes the notebook to GitHub, pushes the Quartz config repo, triggers the GitHub Actions deploy workflow, and polls build status until complete.
- **↗ Open site** — opens the published site in a new tab.

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
