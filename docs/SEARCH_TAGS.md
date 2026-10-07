<!-- Generated from docs:SEARCH_TAGS.md by .tools/readme-export.py. Edit the source, not this file. -->

# Search and Tags

## Summary

Type in the **search** bar (or start search with `/`) to narrow the list to notes containing those words, or in the **tags** field (use `#yourtag` to jump there) to show only notes with those tags. Both work together and update the list as you type. Put `-` before a tag to leave notes with it out (`recipes -tested`), and switch the notebook selector to **all** to search every notebook.

## How it works

### Search

The search bar filters the list by note text as you type. `/` or `s` jumps to it. The query shows
as a token in the command bar under the toolbar; click its `×` to clear it.

Search covers the current notebook; choose **all** in the notebook selector to search every
notebook, each result marked with its notebook.

### Tags

The tags field filters by tags; `#` jumps to it. Type bare tag names, no `#` needed. Tags come
from a note's frontmatter `tags:` list and from `#hashtags` in its text.

- **Several tags** must all be present: `friend local` shows notes tagged both.
- **`-tag`** leaves notes with that tag out: `recipes -tested` shows untested recipes; `-draft` on
  its own shows everything except drafts.

The tag query shows as a `--tags` token in the command bar; its `×` clears it.

### Together

Search, tags and the type chips above the list all apply at once: a note has to match the search,
carry the tags and be of the chosen type. For example, todos tagged `#project` that mention
"deploy".

## Reference

| Key | Does |
|---|---|
| `/` or `s` | jump to the search bar |
| `#` | jump to the tags field |
| `Escape` | leave the field |
| `Ctrl+F` | the browser's own find, for text within the open note |

**Tip:** `/` and a word is the fastest way to find any note; switch the notebook to **all** first
if you're not sure where it lives.

## For developers

- [Architecture: hashtags](dev/dev-architecture.md#hashtags)

`search.js` (`NbSearch`) sends the query; the list request in `main.js` carries `q` and `tags` to
`/api/notes`.
