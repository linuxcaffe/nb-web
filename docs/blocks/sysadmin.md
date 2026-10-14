<!-- Generated from docs:blocks/sysadmin.md by .tools/readme-export.py. Edit the source, not this file. -->

# sysadmin — Admin Dashboard

## Summary

A `sysadmin` block is the installation's control panel, for the person who runs nb-web. Empty,
it lists every notebook (its config, whether it syncs, its plugins and checks, how many notes),
the installed plugins, and whether the key config files exist. `users` lists the accounts and
lets you add, remove and change their level; `crontab` shows the jobs scheduled on the server.
It's for `tech` accounts; anyone below doesn't see it at all.

## How it works

Three forms, one per thing you'd want to check on:

````markdown
```sysadmin
```

```sysadmin
users
```

```sysadmin
crontab
```
````

Each has the usual block header: **?** for this help, **↻** to refresh, and a click on the
header folds it away. Put them together in one note and you have an admin dashboard.

### The installation (empty block)

```sysadmin
```

**Notebooks**, one row each:

| Column | Means |
|---|---|
| name | click it to open the notebook's config (`.notebook.md`), if it has one |
| config | the notebook has a config file |
| wired | its git repository has a remote (`origin`), so Sync can push it |
| .checks | it has its own `.checks/` folder of check scripts |
| plugins | the plugins its config turns on (`plugins:`) |
| notes | how many notes it holds |

The header counts the notebooks and the check scripts in `~/.nb/.checks/`.

**Plugins** lists the plugins in `nb-settings.json`, grouped by kind; a disabled one is dimmed,
and hovering one shows where it comes from.

**Config files** ticks off the files an installation should have: the global config
(`~/.nb/.nb.md`), the manifest, the checks index, the guards rule, the tools index and
`nb-settings.json`. Click one to open it; a ✗ means it's missing.

### Accounts: `users`

````markdown
```sysadmin
users
```
````

A table of every account: its username, level, display name and the notebooks it's limited to
(`(all)` if none). In it you can:

- **change a level** with the dropdown, saved at once;
- **delete an account** with 🗑 (never your own);
- **add one** with **+ Add user**: username, display name, level and a first password.

You can only manage accounts below your own level, and only give out levels up to your own. A
`tech` account manages everyone, and is the only one that can open an account's file (click the
username) or limit it to some notebooks (its `notebooks:` line). People change their own name and
password on their [Account](../ACCOUNT.md) page; there's no way here to reset someone else's
password.

### Scheduled jobs: `crontab`

```sysadmin
crontab
```

The server's scheduled jobs (`crontab -l` for the account nb-web runs as): each job's schedule,
its command, and a description taken from the `#` comment line(s) just above it in the crontab.
It only shows them; edit the crontab in a terminal.

## Reference

- **Access:** `tech` (`codeblock_access: sysadmin:` in `~/.nb/.nb.md`). Each form's data is also
  checked on the server: the installation and crontab need `tech`, accounts need `admin`. Below
  the level, the block is simply not there.
- **Levels**, from least to most: guest, user, office, admin, tech. See
  [Access levels](../ACCOUNT.md#access-level).
- In a container, `crontab` shows the container's own (usually empty) crontab, not the host's.
- More admin tools (the config org chart, dotfile templates): [Sysadmin corner](../SYSADMIN.md).

## For developers

Renderer: `_dispatchSysadminBlock` (`plugins/nbweb-codeblocks.js`) picks the form;
`_loadSysadminBlock`, `_loadSysadminUsersBlock` and `_loadSysadminCrontabBlock` draw into
`_saFrame` (the shared header and a body). Backend: `/api/sysadmin`, `/api/sysadmin/crontab`, and
`/api/users` (GET/POST, PUT/DELETE `/api/users/<name>`), whose `_may_manage_user` keeps an admin
to accounts below its level (nb-web `CLAUDE.md` invariant 80). Codeblock architecture:
[codeblocks](../dev/dev-codeblocks.md) #REVIEW.
