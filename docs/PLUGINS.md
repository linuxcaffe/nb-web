<!-- Generated from docs:PLUGINS.md by .tools/readme-export.py. Edit the source, not this file. -->

# PLUGINS

nb-web has a plugin system — `NbWeb` — that lets external JavaScript modules extend the UI without touching core files.

---

## Enabling and disabling plugins

Plugins are listed in `nb-settings.json` in your nb-web directory:

```json
{
  "plugins": [
    { "url": "/plugins/nbweb-codeblocks.js" },
    { "url": "/plugins/nbweb-quartz.js" },
    { "url": "/plugins/nbweb-shop.js", "enabled": false }
  ]
}
```

Each plugin can be individually enabled or disabled from **Menu → Plugins** without editing the file manually.

---

## Core plugins

Four plugins ship with nb-web:

| Plugin | What it does |
|--------|-------------|
| `nbweb-codeblocks` | Live interactive widgets for `tw`, `hledger`, `nb`, `git`, `t`, `cine` fenced code blocks. Enabled by default; disabling reverts all fences to plain static code. |
| `nbweb-quartz` | Publish button and notebook section for Quartz static site integration. Activates for notebooks wired to a Quartz site. |
| `nbweb-contacts` | Contact card renderer, last-name sort, and VCF import for the contacts notebook. |
| `nbweb-archive` | Archive support. |

---

## External plugins

These plugins have their own repositories and installation steps:

| Plugin | Repo | What it does |
|--------|------|-------------|
| NbWeb-hledger | `~/dev/nbweb-hledger` | Plain-text accounting — Canadian tax domain packs, Chart of Accounts wizard, inline journal entry |
| NbWeb-cine | `~/dev/nbweb-cine` | Film production scheduling — stripboard, call sheets, storylines board |
| NbWeb-claude | `~/dev/nbweb-claude` | Ask Claude — a 💬 badge for documentation/reference help, right inside a note. See [ASK-CLAUDE](ASK-CLAUDE.md) |
| nb-quartz | `~/dev/nb-quartz` | CLI tool to turn any nb notebook into a Quartz static site (separate from the `nbweb-quartz` plugin) |

---

## The Plugins panel

**Menu → Plugins** lists all registered plugins with status, active notebooks, and enable/disable toggle. Each entry shows the plugin's description and, where provided, a full help page rendered from a Markdown file.

For developer documentation on writing plugins, see [plugins](dev/dev-plugins.md).
