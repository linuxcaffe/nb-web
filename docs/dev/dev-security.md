<!-- Generated from docs:dev/dev-security.md by .tools/readme-export.py. Edit the source, not this file. -->

# SECURITY

> Developer documentation for nb-web. See [DEVELOPERS](../DEVELOPERS.md) for the full index.

nb-web's security scheme is intentionally minimal: Flask sessions, Markdown user cards, and level-based guards on both Flask routes and JS UI. No external auth libraries, no database, no tokens.

```
Browser → /login (POST credentials)
        → Flask checks ~/.nb/.users/<username>.md
        → password_hash compared via werkzeug.security
        → session['user'] = {username, name, level, notebooks}
        → all subsequent requests checked by before_request
        → per-request: notebook config + note frontmatter determine visibility
```

---

## I. Server

Flask handles login at `/login` (self-contained HTML, no external assets), sets a signed session cookie via `.flask_secret`, and gates every request through `_check_auth()` — unauthenticated `/api/*` returns `401 JSON`, page requests redirect to `/login`. The `/api/me` endpoint exposes the current user's public fields for frontend use. Dotfolder virtual notebooks (`.users`, `.tools`, etc.) are served via direct filesystem I/O for `admin`/`tech` users. The `~/.nb/` root git repo (config repo) tracks dotfolders and global templates; `settings.html` provides a commit/sync UI for it. `nb-auth.js` is the shared frontend module — see [Frontend auth](#frontend-auth-nb-authjs).

> #stub #todo Full detail for this section is planned — login flow, `_check_auth()`, `/api/me`, dotfolder CRUD, config repo API, `nb-auth.js`.

---

## II. Access Control

### The scheme

Five levels. Plain Markdown files. No database, no LDAP, no OAuth. Yet the result is a genuinely granular multi-layer access control system expressed entirely in the tools already in use.

The key design principle is **silence**: inaccessible content simply isn't there. No "403 Forbidden", no lock icons (except in the one case where a note author deliberately surfaced a labeled button). A guest browsing the app sees a coherent, complete-looking interface — they're just seeing their tier of it. This works at every layer:

| Layer | Mechanism | Silence |
|-------|-----------|---------|
| Note | `access:` or `user:` frontmatter | Filtered from list, 403 → empty on inline |
| Notebook | `.<notebook>.md` config `access:` | Notebook absent from selector entirely |
| Dotfolders | `DOTFOLDERS` + admin gate | `.users`, `.rules` etc. invisible to regular users |
| Inline includes | `{{inline:}}` + `?inline=1` | Missing content renders as nothing |
| `.lib/` components | filename suffix (`-admin`) | Server returns empty body |
| Codeblocks | `codeblock_access` + `read:`/`write:` lines | Block removed from DOM; write buttons hidden |

Each layer is independent and composable. A note can open itself to `guest` inside an `office`-level notebook. A `.lib/` component stacks three tiers in one include. A codeblock can gate read at `office` and write at `admin`. All of these resolve through the same five-point scale — `guest < user < office < admin < tech` — checked by the same two-line `_level_gte()` function.

The user identity lives in `~/.nb/.users/<username>.md` — a plain Markdown file with a YAML frontmatter block, tracked in the `~/.nb/` config repo alongside the same dotfolders it controls access to. The whole security model can be inspected, edited, and version-controlled with the same tools used to write notes.

---

### Access levels

```
guest < user < office < admin < tech
```

| Level | Can do |
|-------|--------|
| `guest` | See only notes/notebooks with `access: guest` explicitly set |
| `user` | Read notes in their notebook list |
| `office` | Read + write notes in their notebook list |
| `admin` | Everything office can do + access dotfolder notebooks |
| `tech` | Full access; manages users and settings |

Checked by `_level_gte(have, need)` in `app.py` — compares index positions in `LEVELS = ['guest', 'user', 'office', 'admin', 'tech']`.

---

### User cards

Users are `.md` files in `~/.nb/.users/`. This is a **dotfolder** — not indexed by nb, not published by Quartz, not shown to regular users.

```
~/.nb/.users/
    djp.md
    lena.md
    guest.md
```

Each file is standard nb-web Markdown with YAML frontmatter:

```yaml
---
name: djp
level: tech
password_hash: scrypt:32768:8:1$...(werkzeug hash)...
notebooks: [home, docs, accts, hledger, work, friends]
---
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Display name shown in UI |
| `level` | yes | Access level — one of `guest`, `user`, `office`, `admin`, `tech` |
| `password_hash` | yes | werkzeug `generate_password_hash()` output |
| `notebooks` | no | List of notebooks this user may access (empty = all) |

**Creating a user:**

```python
from werkzeug.security import generate_password_hash
print(generate_password_hash('password'))
```

Paste the output into the `password_hash:` field. The username is the filename stem (e.g. `djp.md` → username `djp`).

---

### Access control resolution

Visibility of a note is determined by resolving an **effective access level** and comparing it to the current user's level. Most specific wins:

```
note frontmatter access:  → overrides everything (explicit)
note frontmatter user:    → inherits that user's level from their card
folder config access:     → .{folder}.md walk-up (innermost folder wins)
notebook config access:   → default for all notes in the notebook
global config access:     → ~/.nb/.nb.md
system default:           → 'user'  (guests see nothing unless explicitly granted)
```

Implemented in `_effective_access(note_meta, nb_meta)`:

```python
def _effective_access(note_meta, nb_meta):
    if note_meta.get('access'):
        return str(note_meta['access'])
    if note_meta.get('user'):
        card = _load_user(str(note_meta['user']))
        if card:
            return card.get('level', 'user')
    return str(nb_meta.get('access') or 'user')
```

`access:` is a **floor** — `access: guest` means guest-and-above can see it; `access: admin` means admin/tech only. It is typically used as a downgrade (opening notes to lower levels) but can also restrict upward. #invariant

**`user:` shorthand** — instead of knowing or typing a level string, declare ownership: `user: djp` makes the note as private as djp's user card level. If djp is `tech`, the note requires tech. Useful for personal notes in shared notebooks. `access:` always wins if both are present; unknown `user:` values fall through gracefully to the notebook/system default.

Also a search field: `nb g "user: djp"` finds every note you've claimed.

**`access: <username>` — person-specific private notes** #pattern

If `access:` is set to a value that is not a recognised level string (`guest`/`user`/`office`/`admin`/`tech`), it is treated as a username. Only the user whose username matches exactly can see the note:

```yaml
---
title: My private scratchpad
access: djp
---
```

This is a personal lock, not a level gate — even an `admin` logging in as a different user cannot see it. It silently disappears from the list and returns an empty body on inline fetch, exactly like any other inaccessible note.

**Tech recovery bypass** #invariant — `tech` level overrides username-specific locks. Since notes are plain text files, a `tech` user can always recover content that would otherwise be unreachable through the web interface. This makes `access: username` safe to use without fear of permanent lockout:

```
access: djp    →  djp sees it   |  tech sees it   |  everyone else: invisible
access: admin  →  admin/tech    |  below admin: invisible
```

Implemented in `_can_access(user, note_meta, nb_meta)` which wraps `_effective_access`:

```python
def _can_access(user, note_meta, nb_meta):
    access = _effective_access(note_meta, nb_meta)
    if access not in LEVELS:
        return user.get('level') == 'tech' or user.get('username') == access
    return _level_gte(user.get('level', ''), access)
```

All list/fetch/notebook-filter call sites use `_can_access`; `_effective_access` is internal.

The full chain is computed by `_folder_config(notebook, note_path)` which walks from the note's directory up to the notebook root merging `.{folder}.md` configs (innermost wins), then merges over `_notebook_config()` (which itself merges over `_global_config()`).

**Where filtering is applied:**

| Location | Behaviour |
|----------|-----------|
| `_list_notes()` | Notebook config read once; each note meta checked; inaccessible notes silently skipped. Folder rows checked against their own `.{folder}.md`. |
| `GET /api/note` | Uses `_folder_config()` for the full walk-up; 403 / empty body on failure. Returns `effective_access` field — the resolved value for the badge and other UI. |
| `GET /api/notebooks` | Notebooks filtered by config access before being returned |
| `GET /api/nb/notebooks` | Same |

---

### Notebook config file

Each notebook can have a hidden config file at its root:

```
~/.nb/home/.home.md
~/.nb/docs/.docs.md
~/.nb/accts/.accts.md
```

The naming convention is `.<notebook-name>.md`. The file is a dotfile so nb does not index or publish it. Edit it in nb-web via Menu → Notebooks → ⚙ Configure notebook.

**Example** — open a notebook to guest access:

```yaml
---
access: guest
---
```

**Example** — restrict a notebook to admin and above:

```yaml
---
access: admin
---
```

Without a config file (or without an `access:` field), the notebook defaults to `user` level — guests cannot see it.

Implemented in `_notebook_config(notebook)` which reads and parses frontmatter from the config file, returning `{}` if it doesn't exist.

> The notebook config file is set to become the home for much more than access control — themes, icons, list defaults, plugin config, UI flags. See [notebook config](dev-notebook-config.md).

---

### Per-note `access:` frontmatter

Any note can declare its own access level, overriding the notebook default:

```yaml
---
title: Public announcement
access: guest
---
```

```yaml
---
title: Payroll records
access: admin
---
```

The note-level field always wins over the notebook config. This lets you open individual notes to guests within a `user`-level notebook, or lock down sensitive notes in an otherwise open one.

---

### Guest access pattern

A typical guest setup:

1. Create `~/.nb/.users/guest.md` with `level: guest` and a shared password
2. Create `~/.nb/home/.home.md` with `access: guest` to open the whole home notebook, **or**
3. Add `access: guest` to individual notes that guests should see

Guests logging in see only what's explicitly granted. Notebooks without a config file, and notes without `access:` frontmatter, are invisible to them.

---

## Frontend auth (`nb-auth.js`)

`nb-auth.js` is a shared module that gives every HTML page in nb-web user and level awareness without repeating auth logic. Load it once; use the `NbAuth` API and `data-min-level` attributes everywhere.

### How it works

The module is an async IIFE that runs immediately on load:

```
page load → <script src="/nb-auth.js">
           → IIFE runs
           → check sessionStorage for cached user
           → if not cached: fetch /api/me
               → 200 OK: cache user in sessionStorage, continue
               → 401:    redirect to /login immediately
           → window.NbUser  = { username, name, level, notebooks }
           → window.NbAuth  = { level, is, bust, applyVisibility }
           → document.dispatchEvent('nb-auth-ready')
```

The `nb-auth-ready` event fires when the API is ready. All page-specific code that needs auth should listen for it rather than running inline:

```javascript
document.addEventListener('nb-auth-ready', () => {
    NbAuth.applyVisibility();
    if (!NbAuth.is('admin')) return;
    // wire up admin-only UI...
});
```

### sessionStorage caching

`/api/me` is called **once per browser session**. The result is stored under the key `nb-auth-user` in `sessionStorage`. Subsequent page loads within the same tab session skip the network call entirely.

The cache is automatically invalidated when:
- The tab is closed (sessionStorage is per-tab)
- `NbAuth.bust()` is called (e.g. after a logout or user-level change)

### `window.NbUser`

The raw user object from `/api/me`:

```javascript
window.NbUser = {
    username:  'djp',
    name:      'djp',
    level:     'tech',
    notebooks: ['home', 'docs', 'accts']
}
```

If the fetch failed (network error, but not 401), `NbUser` is `{}` — level falls back to `'guest'`.

### `window.NbAuth` API

| Method | Returns | Description |
|--------|---------|-------------|
| `NbAuth.level()` | string | Current user's level, or `'guest'` if unknown |
| `NbAuth.is(lvl)` | boolean | True if current user's level ≥ `lvl` |
| `NbAuth.bust()` | void | Clears the sessionStorage cache |
| `NbAuth.gate(lvl, html)` | string | Returns `html` if user ≥ `lvl`, else `''` |
| `NbAuth.applyVisibility()` | void | Shows/hides `[data-min-level]` elements |

`NbAuth.is()` uses index comparison against `['guest', 'user', 'office', 'admin', 'tech']` — same logic as `_level_gte()` on the backend.

---

### `data-min-level` pattern

Any HTML element can declare its minimum required access level:

```html
<section id="sec-config-repo" data-min-level="admin">
  <!-- only shown to admin and tech users -->
</section>

<button id="btn-user-mgmt" data-min-level="tech">
  Manage users
</button>
```

`NbAuth.applyVisibility()` queries all `[data-min-level]` elements and sets `el.hidden = !NbAuth.is(el.dataset.minLevel)`. Elements are hidden by default in HTML (`hidden` attribute); `applyVisibility()` unhides the ones the current user can see.

### UI gating patterns #invariant

**The rule:** access restriction = element not rendered. Not grayed out, not replaced with an error message, not shown with a lock icon. To a user below the required level, the restricted element simply doesn't exist.

Two patterns depending on whether the HTML is static or dynamically generated:

**Pattern 1 — static HTML** (`data-min-level` + `applyVisibility`):
```html
<!-- Element starts hidden; applyVisibility() reveals it if level permits -->
<button id="btn-user-mgmt" hidden data-min-level="tech">Manage users</button>
```
```javascript
document.addEventListener('nb-auth-ready', () => NbAuth.applyVisibility());
```
Use for HTML written directly into page templates or `settings.html`.

**Pattern 2 — dynamic JS render** (`NbAuth.is()` or `NbAuth.gate()`):
```javascript
// Conditional inline — element never enters the DOM for lower-level users
const html = `
    <div class="nb-plugin-actions">
        ${NbAuth?.is('admin') ? `<button id="nbplug-toggle">Disable</button>` : ''}
        ${NbAuth?.gate('tech', `<button id="nbplug-remove" style="color:var(--red)">Remove</button>`)}
    </div>`;
```
Use for UI built with template literals in JS renderers. `NbAuth.gate(lvl, html)` is the one-liner shorthand for `NbAuth.is(lvl) ? html : ''`.

**Never** use `data-min-level` on dynamically injected elements — `applyVisibility()` runs once at page load. Elements injected later are invisible to it. #gotcha

### Adding auth awareness to a new HTML page

Two steps:

**1. Load the module in `<head>`:**

```html
<script src="/nb-auth.js"></script>
```

**2. Gate your UI on `nb-auth-ready`:**

```html
<script>
document.addEventListener('nb-auth-ready', () => {
    NbAuth.applyVisibility();           // handles data-min-level attributes
    if (!NbAuth.is('office')) return;   // optional: bail early by level
    initMyPageUI();
});
</script>
```

Mark sections with `data-min-level` and add the initial `hidden` attribute:

```html
<section hidden data-min-level="admin">...</section>
```

---

## Config repo

All nb notebooks (`home`, `docs`, etc.) are separate git repos inside `~/.nb/`. The **dotfolders** and **global templates** are tracked by the `~/.nb/` root repo instead.

### What's tracked

```
~/.nb/
├── .git/                     ← the config repo
├── .gitignore                ← excludes notebook dirs
├── .users/
├── .tools/
├── .changes/
├── .images/
├── .rules/
└── .templates/
```

### `.gitignore` strategy

```gitignore
/[a-zA-Z]*/        ← all notebook dirs (each is its own repo)
/.cache/
/.current
/copy
/.plugins/
/.checks/
/.web/
/.export.template.html
```

Push to a **private** remote — user cards contain password hashes. Configure via Settings → Config repo.

### API endpoints (admin+ only)

| Endpoint | Method | What it does |
|----------|--------|-------------|
| `/api/nb-config/status` | GET | Uncommitted files, remote, last commit, unpushed count |
| `/api/nb-config/commit` | POST | Stage dotfolders + templates, commit with message |
| `/api/nb-config/sync` | POST | `git pull --no-edit` then `git push origin HEAD:master` | #todo hardcoded `master` — config repo is on branch `nb-config`; sync endpoint needs updating |
| `/api/nb-config/remote` | GET/POST | Read or set the origin URL |
| `/api/nb-config/log` | GET | Last 20 commits (`git log --oneline -20`) |

No auto-commit on dotfolder writes — commit from Settings → Config repo when ready.

---

## Inline access control

`{{inline:}}` silently enforces access — inaccessible content returns an empty body rather than a 403. The note renders normally for lower-level users; the included content simply isn't there.

Two mechanisms, same silent-empty result:

### Markdown notes — `access:` frontmatter

Any note with `access:` (or `user:`) frontmatter self-censors when included via `{{inline:}}`. The frontend passes `?inline=1` on all inline fetches; the backend returns `{'body': ''}` instead of 403 when access fails.

```yaml
---
title: Staff roster
access: office
---
```

```markdown
{{inline: docs:staff-roster.md}}
```

Guest and user-level readers: empty render. Office and above: full content.

### `.lib/` files — filename level suffix

Non-markdown files (HTML, etc.) can't carry frontmatter. They declare their required level in the filename stem: `-guest`, `-user`, `-office`, `-admin`, `-tech`.

```
.lib/dashboard-user.html     → user+
.lib/dashboard-office.html   → office+
.lib/dashboard-admin.html    → admin+
```

Backend extracts the suffix from the stem, checks `_level_gte()`, returns empty body if insufficient. No JS, no `data-min-level`, purely server-side.

The suffix convention also works for markdown files — useful when the filename should be self-documenting without opening it.

### Rule (`.rules/access.md`)

| File type | Preferred method | Also works |
|-----------|----------------|------------|
| `.html`, `.sh`, non-markdown | filename suffix | — |
| `.md` | `access:` frontmatter | filename suffix |
| no declaration | readable by all authenticated users | |

### `.lib/` — reusable self-censoring components

`~/.nb/.lib/` holds three kinds of files — all access-gated by filename suffix:

**Inline components** (`.html` or `.md`) — designed for `{{inline: .lib:…}}` inclusion.
Additive tier pattern:

```markdown
{{inline: .lib:user-mgmt-user.html}}
{{inline: .lib:user-mgmt-office.html}}
{{inline: .lib:user-mgmt-admin.md}}
```

(`user-mgmt-admin.md` is markdown now — a `nav` codeblock listing `~/.nb/.users` — not the
original static HTML button; the other two tiers are still plain `.html`.)

One note, all users, each sees exactly their tier's content accumulated. No conditionals
in the note, no JS level-checking — the server handles it all.

**Snips** (`snip-<cat>-<snipname>.ext`, added 2026-08-09) — general-purpose, typically
ungated content fragments (nav lists, decorative elements) — distinct from the
access-suffixed components above. `<cat>` is an organizational grouping only, not an
access declaration; a snip needing real gating uses `access:` frontmatter instead of a
filename suffix. No shorthand include — always the full selector,
`{{inline: .lib:snip-nav-acctlinks.md}}`. See `.lib:lib.md`'s own Conventions section.

**Help docs** (`help-block-{lang}-{access}.md`) — adds a `?` button to a barblock header.

**Open scripts** (`open-block-{lang}-{access}.sh`) — wires the barblock title-click and
`⎋` button to run a shell script. Script stdout is a dispatch line:
`nb:<selector>` / `file:<path>` / `term:<cmd>` / `https://…`
See `dev-codeblocks.md` § `.lib/ block extras` for full protocol.

---

## Codeblock gates

Live codeblocks support per-type `read` and `write` level gates. Defaults live in `nb-settings.json` under `codeblock_access`; per-block overrides go in the fence body.

### Global defaults (`nb-settings.json`)

```json
"codeblock_access": {
  "hledger": {"read": "office", "write": "admin"},
  "chart":   {"read": "office", "write": null},
  "tw":      {"read": "user",   "write": "user"},
  "git":     {"read": "user",   "write": null},
  "test":    {"read": "user",   "write": null},
  "nb":      {"read": "user",   "write": null},
  "t":       {"read": "user",   "write": null},
  "nav":     {"read": "user",   "write": null},
  "front":   {"read": "user",   "write": null},
  "tui":     {"read": "user",   "write": null}
}
```

`write: null` means no write controls exist (read-only block type). Level strings follow the standard `guest < user < office < admin < tech` hierarchy.

### Per-block override

Add `read:` or `write:` lines anywhere in the fence body — they're stripped before the query reaches the renderer:

````markdown
```hl
read: office
write: tech
bal expenses --monthly
```
````

### What's enforced

**Frontend** (via `NbAuth.is()` in `nbweb-codeblocks.js`):
- **Read gate** — block removed from DOM entirely. No data fetched.
- **Write gate** — `+` (add transaction/task) and `✎` (edit journal) buttons hidden entirely.

**Backend** (via `_cb_write_allowed(block_type)` in `app.py`):
- `/api/hledger-add` — enforces `hledger.write`; returns 403 if insufficient
- `/api/task-add` and `/api/task-action` — enforce `tw.write`; return 403 if insufficient

Backend enforcement is the safety net — the frontend gate is UX, not security. #invariant

### `nb-auth.js` in `index.html`

`nb-auth.js` is now loaded in the main app's `<head>`, making `window.NbAuth` available to `nbweb-codeblocks.js`. The `_cbCan(el, blockType, mode)` call uses `window.NbAuth?.is(level) ?? true` — fails open (allows) if auth module not ready.

---

## Planned

- `/setup` first-run route
- #planned Backend notebook ACL enforcement for `notebooks:` user card field (currently frontend-only)
- #planned User management UI in Settings menu (admin/tech only)
- #planned CSRF token middleware
- #planned Per-notebook write locks (separate from the existing `.nb-lock` read-only lock)
- #planned Settings UI for `codeblock_access` defaults (currently JSON-only)
- #planned `access:` enforcement on note write endpoints (PUT/POST/DELETE note content) — #gotcha currently unguarded beyond level
- #todo Expand Section I (Server) with full Flask session, login flow, dotfolder CRUD detail
