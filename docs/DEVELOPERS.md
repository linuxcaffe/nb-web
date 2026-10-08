<!-- Generated from docs:DEVELOPERS.md by .tools/readme-export.py. Edit the source, not this file. -->

# DEVELOPERS

Developer documentation for nb-web, organised by feature area. Each section below links to a dedicated file in `dev/`.

nb-web is a Flask + vanilla JS web interface for [nb](https://github.com/xwmx/nb) — a plain-text, git-backed note-taking CLI. The architecture bets on simplicity: no ORM, no frontend framework, no build step. Notes are Markdown files on disk; git is the database; the browser is a thin client. What makes it interesting is what gets layered on top of that simplicity — a config walk-up chain (note → folder → notebook → global) that resolves access, constraints, display settings, and test coverage per-folder; a hybrid test layer that pairs pytest with the same shell scripts used for live monitoring; a plugin system that lets external repos register renderers without touching the core; and a branch-per-notebook git topology that gives each notebook its own history, its own sync cadence, and its own remote branch — all on a single Codeberg repo. The design rewards reading: almost everything is in `app.py` and `main.js`, both of which stay deliberately legible rather than clever.

---

## Index

| File | Scope |
|------|-------|
| [architecture](dev/dev-architecture.md) | Rendering stages, frontmatter keys, images, UUIDs, hashtags — non-feature-specific internals |
| [render-pipeline](dev/dev-render-pipeline.md) | Rendering architecture — pipeline stages, bottlenecks, redesign plan |
| [codeblocks](dev/dev-codeblocks.md) | Writing, registering, and testing live codeblock widgets |
| [codeblock-authoring](dev/dev-codeblock-authoring.md) | Full authoring guide — anatomy, statusPill, headers, error handling, checklist |
| [plugins](dev/dev-plugins.md) | Plugin system — writing plugins, dispatch, `listItemIcon`, toolbar hooks |
| [wikilinks](dev/dev-wikilinks.md) | Wikilink resolution algorithm, `_wikilinkCache`, `term:` link handling |
| [templates](dev/dev-templates.md) | `_resolve_template_vars`, placeholder API, annotation templates |
| [sync](dev/dev-sync.md) | Pull-then-push flow, `git-wire` internals, status API |
| [storage](dev/dev-storage.md) | Git topology: undercarriage repo, branch-per-notebook, restore sequence |
| [testing](dev/dev-checks.md) | Writing and running nb-web check scripts via the `check` codeblock |
| [Check sweep](dev/dev-check-sweep.md) | `check-sweep.py` — bulk check triage across notebooks, cron-driven ambient sweeping, execution dedup |
| [test suite](dev/dev-test-suite.md) | Automated test suite strategy: hybrid pytest + `.checks/` scripts, synthetic fixtures, isolated repo |
| [contributing](dev/dev-contributing.md) | Reporting issues, submitting changes, running from source |
| [Example data — the cast](dev/dev-example-data.md) | The example cast (Pat and Sam Smith, client Acme, project Jones) and the private-names safety net |
| [xref](dev/dev-xref.md) | Stemming algorithm, prefix matching, `/api/xref` reference, `forceAll()` book behavior |
| [security](dev/dev-security.md) | Auth scheme — session login, user cards, dotfolder notebooks, level-based access |
| [notebook config](dev/dev-notebook-config.md) | `.<notebook>.md` config file — themes, icon, colour, plugin config, UI flags, vision doc |
| [claude integration](dev/dev-claude-integration.md) | nbweb-claude internals — MCP tool wrapper, tier gating, barblock rendering, session/token tracking |
