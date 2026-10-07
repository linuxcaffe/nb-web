<!-- Generated from docs:NOTEBOOKS.md by .tools/readme-export.py. Edit the source, not this file. -->

# Notebooks

## Summary

A notebook is a folder of notes under `~/.nb/` with its own git history: `home`, `work`,
`recipes`… Pick one from the notebook selector at the top left to list and add notes there, or
choose **all** to see every notebook at once. **Menu → Notebooks** shows each one's size and sync
state, and is where you set its defaults, connect it to a remote, or delete it.

## How it works

Each notebook is a plain directory under `~/.nb/`, its own git repo, with notes as Markdown files
and an `.index` file that keeps their order:

```
~/.nb/
  home/       ← default notebook
    .git/
    .index
    note1.md
  work/
    …
```

Notes are real files: open, copy, edit and script them from a terminal any time. Every edit, from
nb-web or the `nb` command line, is committed automatically (`[nb] Edit: filename.md`).

### Choosing a notebook

The notebook selector (top left; `n` focuses it) sets where the List, Add and Search commands
work, like `nb use <name>` on the command line. **all** lists and searches every notebook, each
note marked with its notebook's name.

### Creating a notebook

Admins see a **📒 Notebook** type in the **Add** bar: pick it, type a name (letters, numbers, `_` and
`-`; anything else becomes `_`) and press **Enter**. nb-web creates the notebook and two notes
from the global templates in `~/.nb/.templates/`, then opens the first:

| Created | From template | What it is |
|---|---|---|
| `{name}.md` | `.templates/dashboard.md` | the notebook's dashboard (`type: dashboard`) |
| `.{name}.md` | `.templates/dotfile.md` | its config dotfile (`type: dotfile`): access, defaults, constraints |

A missing template is simply skipped. From the command line: `nb notebooks add <name>`.

### The Notebooks page

**Menu → Notebooks** lists every notebook with its note count, how long since it changed, and a
sync badge: `synced`, `N unpushed`, `not wired` or `no git`. Click one for its details: path,
branch, remote, last commit and folders, plus **Wire remote** (no remote yet) or **Sync**. Plugins
can add sections here; the archive plugin adds **↓ Archive notebook**. **Use this notebook**
makes it the current one.

### Defaults

A notebook can open the list with its own **sort** and **type** filter:

- `sort:` in the notebook's own `.{name}.md` (`title`, `za`, `newest`, `oldest`) travels with the
  notebook to any machine.
- The Notebooks page's **Save defaults** stores sort and type for this machine only, and wins
  over the dotfile.

**Default template**: when a notebook's `.templates/` folder holds exactly one template, the Add
bar uses it automatically. A folder's own `.templates/` does the same for notes added there. See
[TEMPLATES](TEMPLATES.md).

## Reference

- **Sync and remotes**: one remote repository, one branch per notebook. Wiring, syncing and
  troubleshooting are in [SYNC](SYNC.md).
- **Danger Zone** (bottom of a notebook's details): **Delete local notebook** removes
  `~/.nb/<name>/` from this machine, not the remote; **Delete remote branch** removes the remote
  copy, not the local one. Both ask you to type the name and can't be undone; archive first
  ([IMPORT/EXPORT](import-export.md)) if you might want it back.
- **Access**: an `access:` line in `.{name}.md` sets who can see the notebook's notes.
- **After creating one**: wire a remote, set `access:`, add folders (📂 in the Add bar, each can
  have its own `.{folder}.md`), and shape the dashboard. See [FOLDER CONFIG](FOLDER-CONFIG.md) and
  [TYPED NOTES](TYPED-NOTES.md).

## For developers

- [Notebook config](dev/dev-notebook-config.md)
- [Sync](dev/dev-sync.md)
- [Storage](dev/dev-storage.md)

`api_notebooks`, `_effective_notebook_prefs` and the notebook creation in `api_create_note`
(`app.py`); the Notebooks page is `notebooks-page.js`.
