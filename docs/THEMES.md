<!-- Generated from docs:THEMES.md by .tools/readme-export.py. Edit the source, not this file. -->

# Themes

nb-web supports full-colour themes defined as plain Markdown files with YAML frontmatter. Themes plug into the same config inheritance chain as `access:`, `check:`, and other config keys — so you can set a different look for each notebook, folder, or even individual note.

---

## Theme files

Themes live in `~/.nb/.themes/` as `{name}.md` files. The frontmatter defines two colour maps — `dark:` and `light:` — where each key maps directly to a CSS custom property name:

```yaml
---
type: theme
name: Groovy
dark:
  bg:           "#1a1612"
  bg2:          "#221e18"
  bg3:          "#2e2820"
  border:       "rgba(255,210,140,0.10)"
  text:         "#e8d5b0"
  accent:       "#d4955a"
  green:        "#8fbe6a"
  red:          "#e06c75"
  # … etc
light:
  bg:           "#fdf6ec"
  # … etc
---
```

The key `bg` becomes CSS var `--bg`; `text-muted` becomes `--text-muted`; and so on. Any key in the file is applied directly — add new vars to extend the system.

**Built-in themes:**

| Slug | Name | Character |
|------|------|-----------|
| `default` | Default | The original dark/light palette |
| `groovy` | Groovy | Warm amber and earth tones |
| `hi-contrast` | Hi-Contrast | Pure black/white backgrounds with saturated accents, for maximum legibility |
| `solarized` | Solarized | The classic Solarized palette, in both its dark and light forms |
---

## Setting a theme

`theme:` is a config chain key — set it anywhere in the hierarchy and it propagates downward:

```yaml
# ~/.nb/.nb.md — global default
theme: default

# ~/.nb/djp/.djp.md — notebook override
theme: groovy

# ~/.nb/djp/films/.films.md — folder override
theme: default

# A note's own frontmatter
theme: groovy
```

Resolution is first-match walking up the chain: note → folder config → notebook manifest → `.nb.md`. The innermost value wins.

**The global baseline** (`~/.nb/.nb.md`) is set to `theme: default` so every notebook that doesn't specify a theme gets the default palette automatically.

---

## The theme picker

Open any notebook **dashboard** and click the **🎨** button in the header bar. A popup appears with:

- One card per theme, showing five colour swatches (bg · bg2 · accent · green · red)
- The currently active theme highlighted with a coloured border
- A **☀ Light / ☾ Dark** mode toggle

Selecting a card:
1. Applies the theme immediately (live, no reload)
2. Saves `theme: <slug>` to that notebook's config file

The theme then activates automatically every time you open a note in that notebook.

---

## Light/dark toggle

The **☀/☾** button in the top navigation bar (always visible) switches between the dark and light maps of the current theme. The choice is remembered across sessions in `localStorage`.

Each theme defines its own light and dark palettes independently — switching mode within Groovy gives you warm amber on a parchment background; switching within Default gives you the original dark/light pair.

Switching mode also sets the browser's native `color-scheme` to match, so scrollbars, `<select>` dropdown popups, and date pickers follow along too — not just the page's own colours. You don't need to (and can't) set this per theme file; it's derived automatically from whichever mode is active.

---

## Auto-switching between notebooks

When you navigate to a note, nb-web reads `effective_fm.theme` and applies the resolved theme automatically. Switching from a Groovy notebook to a Default one snaps the colours back immediately — no manual toggle needed.

---

## Creating a custom theme

1. Copy an existing theme file as your starting point:

   ```
   cp ~/.nb/.themes/groovy.md ~/.nb/.themes/mytheme.md
   ```

2. Edit `name:` and the colour values. Hex (`"#rrggbb"`) and rgba (`"rgba(r,g,b,a)"`) both work. Quote all values — unquoted `#hex` is a YAML comment.

3. Open any dashboard and click 🎨 — your new theme appears in the picker immediately (Flask must be running; no restart needed after adding a file, but the theme list is cached per browser session — reload to see a new file).

4. Pick it to apply and save.

---

## CSS variables reference

| Key | CSS var | Used for |
|-----|---------|---------|
| `bg` | `--bg` | Page / pane background |
| `bg2` | `--bg2` | Card / panel background |
| `bg3` | `--bg3` | Hover / subtle fills |
| `border` | `--border` | All borders and dividers |
| `text` | `--text` | Primary text |
| `text-muted` | `--text-muted` | Secondary text |
| `text-dim` | `--text-dim` | Placeholder / disabled text |
| `accent` | `--accent` | Links, active states, highlights |
| `accent-dim` | `--accent-dim` | Accent background tints |
| `green` | `--green` | Success, done, positive |
| `red` | `--red` | Danger, error, delete |
| `yellow` | `--yellow` | Warning colour |
| `alert` | `--alert` | Alert text |
| `alert-bg` | `--alert-bg` | Alert background |
| `alert-border` | `--alert-border` | Alert border |

**Rules for code (nb-web and its plugins):**

- **Use only these keys for colour.** Pick by meaning: `red` for errors and danger, `yellow` for
  warnings and "in progress", `green` for success, `accent` for links, `text-muted` for secondary
  text, `bg3` for subtle fills, `border` for any line. Don't invent a name like `--link` or
  `--text-danger` that no theme defines.
- **No hex fallback** (`var(--red, #e74c3c)`): `styles.css` `:root` gives every key a default
  already, and a hard-coded fallback ignores the theme.
- **A genuinely new key** goes in all three places at once: this table, `:root`, and every theme
  file (both `dark:` and `light:`).
- nb-web-tests `test_theme_vars.py` fails on any CSS variable that nothing defines, in nb-web or
  in the plugins. Fixed 2026-10-04: ~20 such names had crept in.

Layout variables (font sizes, pane widths, spacing) and font choices are intentionally outside the theme system — they belong to personal preference settings, not colour themes.
