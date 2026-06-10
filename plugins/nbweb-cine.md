---
title: NbWeb-cine
caption: Film production scheduling — stripboard, call sheets, storylines, screenplay tools
---

# NbWeb-cine

Film production scheduling for nb notebooks. Shot files, scenes, actors, locations, and story cards all live as plain Markdown with YAML frontmatter. The plugin renders them as interactive production documents.

Activates automatically for any notebook that contains a `.nb-cine.json` anchor file.

---

## Setting up a project

Create `.nb-cine.json` in the notebook root:

```json
{
  "project": "My Film",
  "aka": "Working Title"
}
```

Recommended folder layout:

```
MyFilm/
├── .nb-cine.json
├── shots/          ← one .md file per shot
├── script/         ← scene files (type: scene)
├── storylines/     ← lane and story card files
├── actors/
├── locations/
└── resources/
```

---

## Key codeblock queries

Embed live cine views anywhere in a note using fenced ` ```cine ` blocks:

| Query | Result |
|-------|--------|
| `shots.strip` | Draggable master stripboard |
| `shots.strip \| day: 1` | Day 1 stripboard |
| `shots.sheet \| day: 1` | Day 1 call sheet |
| `scenes` | Scene index — colour-coded |
| `storylines` | 2D story structure board |
| `storylines.large` | Board with full card detail |
| `actor.phone: JD, AM` | Cast contact lookup |
| `shots \| day: ""` | Unscheduled shots |

---

## Note types

| Type | Folder | Icon |
|------|--------|------|
| `shot` | `shots/` | 🎬 |
| `scene` | `script/` | 📜 |
| `storyline` | `storylines/` | 🧵 |
| `story` | `storylines/` | 🃏 |
| actor | `actors/` | 🧑 |
| location | `locations/` | 📍 |

---

## Screenplay preview

Script files (`type: scene`) render as formatted screenplay pages — Courier font, Hollywood margins, slug line, dialogue. Toggle between screenplay view (🎬) and markdown view (📝) in the preview toolbar.

---

See the [NbWeb-cine README](https://github.com/linuxcaffe/nbweb-cine) for the full reference.
