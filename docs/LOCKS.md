<!-- Generated from docs:LOCKS.md by .tools/readme-export.py. Edit the source, not this file. -->

# Locks

## Summary

A lock makes something read-only, for everyone. Lock a single note with `lock: yes` in its
frontmatter, or a whole folder or notebook from its menu; nothing inside can then be edited,
moved, renamed or deleted until it's unlocked, and a note's annotation is locked with it. Only an
admin can lock or unlock; others see a 🔒.

## How it works

**A note** is locked by `lock: yes` in its frontmatter. Its **Edit** and **Delete** buttons go and
an admin sees **🔒 Unlock** in their place (it clears `lock:` rather than deleting it, so a 🔒
button can lock it again).

**A folder or notebook** is locked by a small `.nb-lock` file inside it; whatever text it holds is
shown as the reason. Admins lock and unlock a folder from its **⋯** menu (**🔒 Lock** tab) and a
notebook from **Menu → Notebooks** (**🔒 Lock notebook**). A lock covers everything below it,
subfolders included; unlocking renames the file to `.nb-unlock`, so the reason is kept for next
time.

**What a lock stops:** saving, adding notes, deleting, renaming, moving notes in or out, copying
in, annotating, restoring an old version, and folder rename/move/copy. nb-web refuses these with
"locked", naming what's locked and why. Files nb-web regenerates from a locked note (its `-gen`
journals) aren't locked.

**Annotations** are locked with their note. An annotation can also be locked on its own, with
`lock: yes` in its frontmatter; an admin unlocks it by saving it without `lock:`.

Locks bind nb-web, not the files: `nb` in a terminal, or any editor, can still change them.

## Reference

| Locks | How | Unlock |
|-------|-----|--------|
| a note | `lock: yes` in its frontmatter | **🔒 Unlock** (admin) |
| an annotation | `lock: yes` in its frontmatter (or its note's lock) | save it without `lock:` (admin) |
| a folder | **⋯ → 🔒 Lock → Lock folder** (admin), or a `.nb-lock` file | the same tab |
| a notebook | **Menu → Notebooks → 🔒 Lock notebook** (admin) | the same button |

## For developers

- `_lock_reason` / `_locked` (`app.py`) check every write; a refused write answers 423 with the
  reason (CLAUDE.md invariant 76). Any new endpoint that writes a note or into a folder needs
  `_locked(...)`.
- Two unrelated locks with similar names: the folder `.nb-lock` (`note.locked` in `/api/note`) and
  the note's own `lock:` field (invariant 37). The Edit button's states: `_computeEditGate`
  (`main.js`, invariant 59).
