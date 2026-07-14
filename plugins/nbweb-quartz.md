# NbWeb-quartz

Connects nb-web's editing UI to [nb-quartz](https://codeberg.org/linuxcaffe/nb-quartz) publishing pipelines.

## What it does

Activates for any notebook that has a `.nb-website.json` file with a `quartz_path` configured. Adds buttons to the notebook toolbar:

- **🌐 Publish** — pushes the notebook to GitHub, pushes the Quartz config repo, triggers the GitHub Actions deploy workflow, and polls build status until complete.
- **▶ Local preview** — runs `npx quartz build --serve` in the terminal pane for the configured Quartz site.
- **↗ Open site** — opens the published site in a new tab.

## Front-of-house / back-of-house

Every shop item is two files:

| File | Published? | Purpose |
|------|-----------|---------|
| `items/gxx102.md` | ✅ Yes | Frontmatter only — title, price, status, images, tags |
| `items/.gxx102.md.annotations.md` | ❌ No | Private workspace — internal notes, action links, term: commands, **and cost/sale ledger blocks** (see below) |

The annotation sidecar is a hidden dotfile that Quartz never sees — not because of an access rule that could be misconfigured, but because Quartz's own content-glob (`globby()`, default `dot: false`) never enumerates dotfiles in the first place. There's no leak path to get wrong.

Create an annotation with the **+ Add annotation** button in the item preview, or via the nb-web `term:` link pattern:

```markdown
[Open annotation](term:nb edit preciousfinds.ca:.gxx102.md.annotations.md)
```

**Cost and sale price belong in the annotation, never the item note.** Only the public asking `price:` stays in frontmatter, published as normal — what you *paid* for an item, what it actually *sold for*, and any platform fees go in the annotation as `​```ledger​```` blocks instead. See `nbweb-hledger`'s help for the exact format and the Sold/Summary/Fields buttons that appear on an item's header once it's `type: item` in a Sales-domain notebook.

## Item type registration

`items/` notes are `type: item` and get a specialty header (status/platform pills, action bar, nav popup) embedded directly into the item card — registered here, in `nbweb-quartz.js`, since shop items are this plugin's domain (the money-tracking action buttons themselves belong to `nbweb-hledger`, a separate plugin — see its docs). This is the first note type detected two ways at once: by path (`items/` folder, this plugin) *and* by `type: item` (frontmatter, the specialty-header system) — both agree, and the header is embedded into this plugin's own card rendering rather than appearing as a second, separately-toggled view. Dev detail: `docs:dev/dev-plugins.md`'s `NbSpecialty` section.

**`items/.items.md`** (a folder config, same shape as any other `.{foldername}.md`) declares which fields a shop item note has and which are required:

```yaml
---
type: dotfile
constraints:
  status:
    widget: select
    values: [available, sold]
    required: true
  price:
    widget: text
    required: true
  image:
    widget: text
    required: true
  category:
    widget: text
---
```

A `quartz-shop-item-missing.sh` check (in `.checks/`) flags any item note with a blank required field. The **📝 Fields** button on an item's header (see `nbweb-hledger`'s docs) is the fastest way to fix one — it shows every field this schema declares, required or optional, whether the item currently has it or not.

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
