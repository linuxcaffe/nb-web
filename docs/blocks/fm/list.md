<!-- Generated from docs:blocks/fm/list.md by .tools/readme-export.py. Edit the source, not this file. -->

# fm list — Key Browser

## Summary

`list` in an `fm` block shows a table of every frontmatter key used in the current notebook:
how many notes have it and a few of its values. Click a key to see the notes that have it, and
**← list** to come back. Use it to learn a notebook's fields before you query them, or with
`list-empty` to find fields left blank.

## How it works

````markdown
```fm
list
```
````

The table is about the notebook of the note the block is in, and has three columns: **Key**,
**# notes**, and up to four sample values. The most used keys come first. Clicking a key turns
the block into a plain [fm query](../fm.md) for that key in that notebook
(`notebook key:`); **← list** goes back.

```fm
list 6
```

A number after the word sets how many rows show before the table scrolls (8 if you leave it out).

**Narrower lists:**

| Block | Keys shown |
|---|---|
| `list` | every key |
| `list-empty` | keys that some notes have but left empty: a cleanup list |
| `list-core` | nb-web's own keys: `title`, `type`, `status`, `tags`, `access`, `alias`, `date`, `due`, `started`, `completed`, `project`, `draft`, `pinned`, `color`, `icon`, `template`, `renderer`, `related`, `description` |
| `list-<plugin>` | the keys a plugin declares, e.g. `list-cine` (scene, shot, loc, cast, day_night…) |

A plugin name that declares no keys shows **Unknown scope** instead of a table.

## Reference

- Only notes you can open are counted, and only in notebooks your account may use.
- Config files (`.notebook.md`, folder configs) aren't counted: their keys are settings, not
  note fields.
- As frontmatter: `fm: list-core 10` puts the table in the header strip.
- Same access as [fm](../fm.md) (`admin` by default).

## For developers

`_loadFmListBlock` (`plugins/nbweb-codeblocks.js`) fetches `/api/fm/keys?notebook=` (`api_fm_keys`,
`app.py`), filtered with `keys=` for a scope. Scopes come from `NbWeb.getFmKeysForScope`
(`nbweb.js`): `core` is built in, and a plugin adds its own with `fmKeys: [...]` in
`registerModule`. Codeblock architecture: [codeblocks](../../dev/dev-codeblocks.md) #REVIEW.
