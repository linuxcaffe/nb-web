## NbWeb-cine setup

NbWeb-cine activates for any notebook that contains a `.nb-cine.json` anchor file.

### 1. Create the anchor file

In your notebook's root directory, create `.nb-cine.json`:

```json
{
  "project": "My Film",
  "aka": "Working Title"
}
```

Both fields are optional — an empty `{}` is valid.

### 2. Create the folder structure

```
MyFilm/
├── .nb-cine.json
├── shots/          ← one .md file per shot (type: shot)
├── script/         ← scene files (type: scene)
├── storylines/     ← lane and story card files
├── actors/
├── locations/
└── resources/
```

Folders are scanned automatically — only the ones that exist are used.

### 3. Reload nb-web

After adding `.nb-cine.json`, reload the page. The plugin detects the new notebook and the stripboard toolbar button appears.

---

See the [NbWeb-cine README](https://github.com/linuxcaffe/nbweb-cine) for the full reference.
