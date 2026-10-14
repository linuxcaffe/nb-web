<!-- Generated from docs:blocks/git.md by .tools/readme-export.py. Edit the source, not this file. -->

# git — Git Log

## Summary

A `git` block shows the output of a read-only git command in the note: a log, a status, a diff.
The first word names the repository — a `.` for the current note's own notebook, or an alias an
admin has set in `nb-settings.json` — and the rest is the git command. It's for notes that live
next to code: a dev journal, a planning page, a release note.

## How it works

````markdown
```git
. log --oneline -10
```
````

The first word is the repo, the rest is the git command and its flags:

| First word | Repo |
|---|---|
| `.` | the notebook the open note is in (every notebook is its own git repo) |
| an alias | a path from `git_repos` in `nb-settings.json` |

Clicking the repo name in the header opens its `origin` remote in a browser, when it has one.

**Repo aliases.** An admin maps names to paths in `nb-settings.json`, so a note can read a repo
outside `~/.nb`:

```json
{
  "git_repos": {
    "nb-web":    "~/dev/nb-web",
    "myproject": "~/dev/myproject"
  }
}
```

Then `nb-web log --oneline -10` reads that repo.

## Reference

- **Read-only.** Only these subcommands run: `branch`, `describe`, `diff`, `log`, `ls-files`,
  `remote`, `shortlog`, `show`, `stash`, `status`, `tag`. A command that would change a repo is
  refused — no `--output` file, and `stash`, `branch` and `tag` only in their listing forms
  (`branch -a`, `tag -l 'v*'`, `stash list`), never to create, delete or stash.
- The repo must be `.` or a configured alias; an unknown name lists the ones that exist.
- An admin can gate it with `codeblock_access: git: {read:}` (see
  [Access gates](../CODEBLOCKS.md#access-gates)).
- In frontmatter (`git: . status`) it shows in the note's header strip instead of the body.

## For developers

Renderer: `_loadGitBlock` / `_buildGitOutput` (`plugins/nbweb-codeblocks.js`), backed by
`/api/nb/git`; the read-only screen is `_git_read_only` and the subcommand allowlist `_GIT_ALLOWED`
in `app.py`.
