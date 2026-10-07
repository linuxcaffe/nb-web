<!-- Generated from docs:LOCKS.md by .tools/readme-export.py. Edit the source, not this file. -->

# Locks

## Summary

A lock makes something read-only, for everyone. Lock a single note with `lock: yes` in its
frontmatter, or a whole folder or notebook from its menu; nothing inside can then be edited,
moved, renamed or deleted until it's unlocked, and a note's annotation is locked with it. Who may
lock and unlock is up to each notebook or folder (`lock_level:`, admins by default); others see a
🔒.

## How it works

**Who locks.** `lock_level:` in a folder or notebook config (or `~/.nb/.nb.md`) says who may
lock and unlock there: `admin` unless set, never lower than `user`. The features tour sets
`lock_level: user`, so anyone can try it. Everyone else sees the 🔒 but no control.

**A note** is locked by `lock: yes` in its frontmatter. Its **Edit** and **Delete** buttons go and
whoever may lock there sees **🔒 Unlock** in their place (it clears `lock:` rather than deleting it, so a 🔒
button can lock it again).

**A folder or notebook** is locked by a small `.nb-lock` file inside it; whatever text it holds is
shown as the reason. A folder is locked and unlocked from its **⋯** menu (**🔒 Lock** tab), a
notebook from **Menu → Notebooks** (**🔒 Lock notebook**). A lock covers everything below it,
subfolders included; unlocking renames the file to `.nb-unlock`, so the reason is kept for next
time.

**What a lock stops:** saving, adding notes, deleting, renaming, moving notes in or out, copying
in, annotating, restoring an old version, and folder rename/move/copy. nb-web refuses these with
"locked", naming what's locked and why. Files nb-web regenerates from a locked note (its `-gen`
journals) aren't locked.

**Annotations** are locked with their note. An annotation can also be locked on its own, with
`lock: yes` in its frontmatter; whoever may lock there unlocks it by saving it without `lock:`.

Locks bind nb-web, not the files: `nb` in a terminal, or any editor, can still change them.

## Reference

| Locks | How | Unlock |
|-------|-----|--------|
| a note | `lock: yes` in its frontmatter | **🔒 Unlock** |
| an annotation | `lock: yes` in its frontmatter (or its note's lock) | save it without `lock:` |
| a folder | **⋯ → 🔒 Lock → Lock folder**, or a `.nb-lock` file | the same tab |
| a notebook | **Menu → Notebooks → 🔒 Lock notebook** | the same button |

| Key | Where | Effect |
|-----|-------|--------|
| `lock_level:` | folder, notebook or global config | who may lock and unlock there: `user`, `office`, `admin` (default), `tech` |

## For developers

- `_lock_reason` / `_locked` (`app.py`) check every write; `_may_lock` decides who locks (the
  `can_lock` field in `/api/note` and the lock info drive the buttons); a refused write answers 423 with the
  reason (CLAUDE.md invariant 76). Any new endpoint that writes a note or into a folder needs
  `_locked(...)`.
- Two unrelated locks with similar names: the folder `.nb-lock` (`note.locked` in `/api/note`) and
  the note's own `lock:` field (invariant 37). The Edit button's states: `_computeEditGate`
  (`main.js`, invariant 59).
