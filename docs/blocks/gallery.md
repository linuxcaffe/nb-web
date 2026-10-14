<!-- Generated from docs:blocks/gallery.md by .tools/readme-export.py. Edit the source, not this file. -->

# gallery — Image Gallery

## Summary

A `gallery` block renders a responsive grid of images from the nearest `images/` folder —
walking up from the note's own location unless told otherwise — with a full-screen lightbox on
click. It shares its size vocabulary and `images/` folder convention with the editor's own
image-embed button, so dropping a photo in while editing shows up here automatically.

## How it works

````markdown
```gallery
med
```
````

```gallery
thumb features:images/
```

| Body | Finds images in |
|---|---|
| *(size only, e.g. `med`)* | The nearest `images/` folder, walking up from the note |
| `med .` | Only this note's own folder's `images/` — vanishes silently if there's none |
| `large notebook:path/` | A specific folder, named directly |

**Sizes** — the first word sets the grid cell width: `thumb` 80px, `small` 140px, `med` 220px,
`large` 320px.

**Adding images while editing** — the 📷 button next to **mkd ref** (or `Ctrl+Shift+1`) opens a
small picker: an existing image from the note's own gallery folder, or **Browse…** for a new
file. The dedicated "📷 Camera" quick-button in that picker is still a disabled stub ("coming
soon") — but **Browse… already triggers your device's native photo/camera picker on a phone**,
since it's a plain file input with no source restriction; that's full camera capture today,
just not as a dedicated one-tap shortcut yet. A brand-new upload lets you rename it first
(handy for camera-roll names like `IMG_20260904_143201.jpg`); picking an existing image skips
straight to size. Either way the file lands in this gallery's own folder — no configuration
needed. See [Keyboard § Adding and editing](../KEYBOARD.md#adding-and-editing).

*The single-image embed picker shares this same size vocabulary, plus a "Full size" option —
but there it sets just that one image's own display width in the note body, a different
setting from the grid's cell size, not the same one.*

**Lightbox** — click any thumbnail to open; ← / → to navigate; Esc or click outside to close.

## Reference

- **No access gate of its own, client or server.** Any `read:`/`write:` lines in the fence body
  are parsed out like every other block, but have no effect here — this block never checks
  them. The backend (`/api/gallery`, `/api/file`) only enforces the account's `notebooks:`
  scope restriction, not the target notebook's own `access:` level — flagged for a dedicated
  security pass, not yet fixed.
- In frontmatter (`gallery: med .`) it shows in the note's header strip instead of the body.
- **FM-mode YAML quoting** — the value is always `size path`; a value with no space is parsed
  entirely as the size (the path is silently dropped, falling back to walk-up behaviour); a
  value starting with `.`/`/` or ending in `:` must be quoted (`"thumb .images:"`,
  `"med ~/.nb/.images"`) or YAML parsing breaks.

## For developers

Renderer: `_loadGalleryBlock` (`plugins/nbweb-codeblocks.js`), backed by `/api/gallery`
(`list_images`/`_nearest_image_dir` in `app.py`). Lightbox: `_galleryLightbox`. The editor's
image-embed modal (`_openImageEmbedModal`, `main.js`) is a separate feature sharing the same
`images/` convention and size scale. Already on the shared `_buildBarHeader`/
`_initCollapseToggle` header. Broader renderer architecture: [codeblocks](../dev/dev-codeblocks.md)
#REVIEW.
