<!-- Generated from docs:blocks/cfg.md by .tools/readme-export.py. Edit the source, not this file. -->

# cfg — Config Inheritance Tree

## Summary

A `cfg` block shows how a setting is resolved: the chain from the global `~/.nb/.nb.md` down
through the notebook and folder configs to the current note, and which level sets the value
that wins. `access: .` traces one key here; a bare block lists every key; `tree` and `org` map
all the config files in a notebook. Click a node to open its config file, or create one where
none exists. Admin only by default.

## How it works

````markdown
```cfg
access: .
```
````

Visualises the configuration resolution chain from the global root (`~/.nb/.nb.md`) down to the current note's notebook and folder. Each level shows only what it **contributes** — inheritance is implied by indentation. Gated: `admin` read level.

**Syntax:**

| Form | Meaning |
|------|---------|
| `field: .` | Walk to current note's location; show `field` contributions |
| `field: Notebook:folder/` | Walk to a specific target |
| *(bare)* | Walk to current location; show all contributed keys |
| `tree` | Folder-tree walk mode — shows all config nodes in the notebook |
| `tree access nb:` | Tree walk, filtered to nodes that set `access`, scoped to `nb` notebook |

**FM-mode syntax rules:**

`field` must start with a word character (`a-z`, `0-9`, `_`). The parser splits on the first `:` after a valid field name. A value like `. access:` fails — the leading `.` is not a word character, so the whole string is treated as the target, not a field name.

```yaml
cfg: "access:"      # ✓ field=access, target=current note's notebook
cfg: "access: ."    # ✓ same — explicit current-context dot
cfg: "access: nb:"  # ✓ explicit notebook target
cfg: ". access:"    # ✗ parses as target='. access', not field=access
```

Values ending with `:` must be quoted in YAML.

**Output:**

```
● 🌐 ~/.nb/.nb.md                 codeblock_access, …
  ● 📒 Takeout/.Takeout.md        access, plugins, cine
    ● 📁 shots/.shots.md          default_type, sort, constraints
    ○ 📁 schedule/                (no config file)
```

`●` nodes are clickable — opens the config file in the preview pane for editing via **FM** or **Edit**. `○` nodes have no config file yet. With a key traced, `▶` marks the level whose value wins, and `◉` the config file you're looking at.

When a `field` is specified, only nodes that actually set that field show a value beside them:

````markdown
```cfg
access: .
```
````

Useful for tracing where `access:`, `default_type:`, or any other setting is actually coming from. Admin-only — does not appear for lower access levels.

**Config files** are identified by `type: dotfile` in frontmatter and their path convention (`~/.nb/notebook/folder/.folder.md`). Query them with `fm`:

````markdown
```fm
read: admin
type:dotfile | All config files
```
````

---

**Fenced body mode**

All `cfg` variants work equally in fenced codeblocks — the query goes in the **body**, not the info string. This is the recommended pattern for dotfile admin sections:

````markdown
```cfg
org -C 2 access, theme, check
```

```cfg
tree
```

```cfg
access: .
```
````

The FM form (`cfg: org` in frontmatter) propagates the block via the config chain — every note in scope sees it. The fenced form is local to the note body only, which makes it the right choice for the admin tools section of a dotfile: the FM frontmatter propagates policy, the body holds the sysadmin codeblocks. Two clear zones, one file.

---

## Org chart (`cfg: org`)

The `org` mode renders an interactive, zoomable SVG org chart of every config file in the current notebook — the fastest way to audit, navigate, and fix your configuration landscape.

````markdown
```cfg
org
```
````

Or with filter chips pre-loaded in frontmatter:

```yaml
cfg: org access, access:guest, access:office, check, xref
```

**Global scope**

When the `cfg: org` block lives inside `~/.nb/.nb.md` (the super-notebook config file), it renders the *entire installation* — all notebooks as branches off the `⊕ .nb` global root. Every notebook and its folders appear in one chart. This is the sysadmin bird's-eye view: zoom out to see the whole wiring picture, zoom in to read labels, hover for tooltips, click to open or create any config file.

**What you see**

- **Left-to-right tree** — global `⊕ .nb` root (or notebook root for per-notebook charts) on the left; folders fan right.
- **Left slot** — type icon from the config file's own `type:` field, or `●`/`○` fallback. `○` = no config file exists yet at this level.
- **BG tint** — appears only on nodes that *explicitly set* `access:`; inherited access shows in the tooltip but is not painted on every node. green=guest · amber=office · red=admin · purple=tech.
- **Border** — solid stroke = has a config file; dashed stroke = no config file yet.
- **Border glow** — brightens when a filter is active and this node *explicitly sets* the filtered key.
- **Right slot** — number of FM keys this config contributes, or `…` if the node's children are suppressed by `cfg_skip:` (see below).
- **Hover tooltip** — path on line one; key: value lines from the config file with grep-style context around the active filter (see `-C` below).

**Zoom and pan**

The chart is fully interactive at any depth.

| Input | Action |
|-------|--------|
| `Ctrl` + scroll wheel | Zoom in / out at cursor |
| Pinch (touchpad) | Zoom in / out |
| Click and drag | Pan |
| `f` (mouse over chart) | Fit the whole tree into view |
| `+` / `-` | Zoom in / out by fixed step |
| `0` | Reset zoom to 100% |

The initial view centres the root node and scales to show as much of the tree as fits. Large installations may open zoomed in to the root — scroll back or press `f` to see the full picture.

**Filter bar**

Always visible above the chart. Three ways to filter:

| Control | What it does |
|---------|-------------|
| Freeform input | Type any `key` or `key:value`; live-filtered at 180 ms debounce; Esc resets |
| `[all]` chip | Remove filter — show full tree |
| `[access]` chip | Highlight nodes that *explicitly set* `access` (any value) |
| `[access:office]` chip | Highlight nodes that *explicitly set* `access: office` |

Chips are declared in the codeblock query as a comma-separated list after `org`. Key-only and `key:value` chips can be mixed freely:

```yaml
cfg: org access, access:guest, access:user, access:office, access:admin, check, xref
```

The chips control *client-side* display only — all nodes are always fetched. Dimmed nodes still exist; they just don't match the active filter.

**Extending the chip list without restating it (`cfg_attr_add:`/`cfg_attr_skip:`)**

The chip list above is set once, wherever the FM `cfg: org ...` block lives (usually the notebook root or global `.nb.md`) — every note in scope inherits that exact list. A deeper folder wanting one extra chip had to copy the whole comma-separated list into its own `.{folder}.md` just to add one token. `cfg_attr_add:`/`cfg_attr_skip:` avoid that: set on any config file in the walk-up chain (global → notebook → folder), they union additional chips in / remove chips from the inherited list, same accumulate pattern as `check_add:`/`check_skip:`:

```yaml
# home/.home.md — add a `hledger` chip on top of whatever .nb.md already declares
cfg_attr_add: hledger
```

```yaml
# accts/.accts.md — this notebook doesn't want the xref chip cluttering its chart
cfg_attr_skip: xref
```

Only affects `cfg: org`/`cfg: tree` values (the only `cfg:` shapes with a chip list) — plain `cfg: access:` target-form queries are untouched. Not the same key as `cfg_skip:` below, which is unrelated (per-node chart pruning, not a chip-list edit).

**Depth limit (`-D N`)**

Cap how many folder levels the walk descends. Useful for large notebooks where you only need to see the top-level folder layer:

```yaml
cfg: org -D 2 access, check
```

`-D 0` (the default) is unlimited. `-D 1` shows only the notebook root; `-D 2` adds one folder layer; and so on. Can be combined with `-C`:

```yaml
cfg: org -D 3 -C 4 access, check
```

**Tooltip context (`-C N`)**

Each hover tooltip shows the matched key plus N lines of context above and below (grep-style `-C`). Default is 2:

```yaml
cfg: org -C 4 access, check
```

No filter active → first C keys + overflow hint. Filter active → C lines before ▶ matched key, C lines after, with `⋯ N above/below` hints when there's more.

**Pruning noisy branches (`cfg_skip:`)**

Add `cfg_skip: true` to any config file (`.{notebook}.md` or `.{folder}.md`) to suppress that node's children from the org chart. The node itself stays visible with a `…` indicator in the right slot; clicking it still opens or creates the config file.

This is useful for reference notebooks or large folder collections where subfolders have no config files and don't need to appear in the chart. Example — add to `tutorial:.tutorial.md`:

```yaml
---
cfg_skip: true
---
```

After a chart refresh, the `tutorial` notebook shows as a single leaf node instead of 19 branches.

**Clicking nodes**

- `●` node (solid border) — opens the config file directly in the preview pane.
- `○` node (dashed border) — creates the config file from the global template and opens it immediately.

**The sysadmin loop**

Zoom out → read the coloured outlines to understand wiring at a glance → hover any node for specifics → zoom in on a gap → click to open or create → fix → refresh. The chart is the live, always-current map of your configuration landscape.

## For developers

Parser: `_loadConfigBlock` (`plugins/nbweb-codeblocks.js`); org chart: `_configOrgRender`; backend `/api/config-tree`. Chain resolution: [Folder config](../FOLDER-CONFIG.md).
