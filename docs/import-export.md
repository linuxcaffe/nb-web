<!-- Generated from docs:import-export.md by .tools/readme-export.py. Edit the source, not this file. -->

[Notebook Archive (.nbz)](#notebook-archive) · [Contact Import](#contact-import) · [Note Export](#note-export)

---

## Notebook Archive

nb-web treats the notebook as the unit of archive and transfer. The **NbWeb-archive** plugin handles creating, importing, and distributing notebooks as `.nbz` files.

### The .nbz format

A `.nbz` file is a standard ZIP archive with a notebook directory at its root and a metadata manifest at the top level.

```
notebook-name/
  note1.md
  note2.md
  .index
  .git/           ← optional, only when "Include git history" is checked
.nb_archive       ← JSON metadata manifest
```

**`.nb_archive` manifest fields:**

| Field | Description |
|-------|-------------|
| `name` | Original notebook name |
| `note_count` | Number of notes at archive time |
| `archived_at` | ISO 8601 timestamp |
| `nb_version` | nb version string |
| `includes_git` | Boolean — whether `.git` is included |
| `description` | Optional user-provided description |
| `imported_from` | Original name (added on import, if renamed) |
| `imported_at` | ISO 8601 timestamp (added on import) |

### Archiving a notebook

Open any notebook's settings panel and find the **Archive** section.

1. Optionally check **Include git history** to bundle the full `.git` directory — useful for preserving commit history across machines or before removing a notebook.
2. Optionally add a description.
3. Click **↓ Create archive** — the `.nbz` downloads immediately.

Files larger than 50 MB are skipped and listed in the status message. The filename is `notebook-YYYY-MM-DD.nbz`.

### Importing a notebook

Open the **Plugins** page and select **NbWeb-archive**. The import form is at the bottom of the page.

1. Drop a `.nbz` file onto the drop zone or click to pick one.
2. nb-web reads the manifest and shows a preview: name, note count, archive date, git history flag, description.
3. Edit the **Import as** name if needed. A conflict warning appears if the name is already in use.
4. Click **Import**.

On import, nb-web:
- Extracts the archive into `~/.nb/<name>/`
- Renames the root directory to match the chosen name
- Stamps `.nb_archive` with `imported_from` and `imported_at`
- Runs `nb index reconcile` so notes appear immediately
- Initialises a fresh git repo if the archive did not include git history

### Removing a notebook

Use the **Danger Zone** at the bottom of the notebook settings panel. Type the notebook name to confirm. nb-web calls `nb delete-notebook --local`, which removes the local directory without touching any remote.

If the notebook has unpushed commits the Danger Zone shows a warning — archive first if those commits matter.

### Distributing notebooks

`.nbz` files are self-contained and portable. Planned: a `docs.nbz` bundled with nb-web so new users can import the reference documentation as a local, searchable notebook.

---

## Contact Import

Contact data can be imported from `.vcf` (vCard) files via the **NbWeb-contacts** plugin. The 📇 toolbar button opens a contact browser that reads from the VCF source configured in `nb-settings.json`:

```json
{ "vcf_source": "~/Downloads/contacts.vcf" }
```

Browse and search the VCF, then use **Create Contact Note** to import individual contacts into the `contacts` notebook as structured Markdown notes.

See NbWeb-contacts for the full contact note format and field reference.

---

## Note Export

Individual notes are plain Markdown files in `~/.nb/<notebook>/` — they can be copied, synced, or opened directly in any editor at any time.

Planned: per-note download and multi-note export from the nb-web UI.
