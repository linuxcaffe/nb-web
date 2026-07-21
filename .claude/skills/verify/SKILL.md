---
name: verify
description: Project verify skill for nb-web — how to actually build/launch/drive this app for verification, and what test infrastructure already exists. Read before improvising ad-hoc verification (curl smoke tests, stub harnesses, import-and-call).
---

Written 2026-07-20 after a session verified a real fix (piecewise `> RATE:` marker billing)
using inline Node/Python stub harnesses and curl smoke tests, unaware `nb-web-tests/e2e/` had
a full Playwright suite with a working test login sitting right there. Persisted per the
built-in `verify` skill's own instructions, so the next session doesn't cold-start this again.

## What actually exists

**`~/dev/nb-web-tests/`** — a separate repo, two independent layers:

1. **pytest suite** (repo root) — imports `app.py` directly (`import app as nb_app`, see
   `conftest.py`), with `NB_DIR` monkeypatched to a synthetic tmp fixture before each test —
   no real server, no real `~/.nb`. Run: `cd ~/dev/nb-web-tests && pytest`. This is the layer
   for endpoint logic, security/access-control behavior, config resolution — anything
   reachable without a browser. See `test_cbql.py` for the style (docstring states the
   invariants being tested up front, including known-red security tests that are supposed to
   fail until a real bug is fixed — don't "fix" those by weakening the assertion).

2. **Playwright e2e suite** (`e2e/` subfolder, own `package.json`) — real browser automation
   against a real, but *synthetic and disposable*, server instance. `playwright.config.js`
   spins up its own fixture (`fixtures/build_fixture.py` → `/tmp/nb-web-e2e-fixture` by
   default, overridable via `NB_E2E_DIR`) and runs bare `python3 app.py` against it on its own
   port (5099 by default, `NB_E2E_PORT`) — **not** the real `container-nb-web` service on 5001,
   not real `~/.nb` data. Run: `cd ~/dev/nb-web-tests/e2e && npx playwright test`.
   - **Login**: `e2etester` / `e2e-test-password` — created fresh by `build_fixture.py` for
     each run (`.users/e2etester.md` with a real `password_hash`), not a persistent account.
     `helpers.js`'s `login(page)` drives the real `/login` form, not an API shortcut.
   - `helpers.js`'s `openNote(page, selector)` — the same hash-deep-link (`/#notebook:file.md`)
     the app itself uses; waits for `.nb-rendered`, not a fixed timeout.
   - This is the layer for anything a description like "click X, see Y happen" actually needs
     — real DOM, real JS, real render pipeline. The pytest suite deliberately doesn't cover
     this (see its own package.json description: "closes the JS/frontend gap the pytest suite
     deliberately leaves uncovered").

**No known login for the real, live `container-nb-web` service** (port 5001, real `~/.nb`) —
if verification needs to happen against real data rather than a synthetic fixture, that's CLI
level (`curl`, `podman exec`, direct hledger/git commands), not browser-driven. Don't assume a
real-site login exists without checking first.

## Build/launch the real container (not the test fixtures)

What actually shipped a real fix live, 2026-07-20 (see `nb-web/Containerfile`'s own header
comment for the full annotated version):

```bash
cd ~/dev/nb-web
podman build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
    -t localhost/nb-web:phase2-vN -f Containerfile .        # bump vN from `podman images`
podman tag localhost/nb-web:phase2-vN localhost/nb-web:phase2
systemctl --user restart container-nb-web.service
# Confirm the fix is actually live, not just committed:
podman exec nb-web md5sum /app/app.py
md5sum ~/dev/nb-web/app.py                                   # must match
```

**Gotcha**: `~/.nb` and `~/dev` are live bind-mounts into the container (edits there apply
immediately, no rebuild needed) — but `/app` (the actual running code) is baked into the image
at build time. A code change is *not* live until rebuild + restart, even though the container
itself never stopped running. Diff the md5s above before believing a fix is live.

## Gotcha: gunicorn vs bare `python3 app.py`

The real container runs under gunicorn (`gunicorn.conf.py`'s `on_starting` hook does the
startup checks `app.py`'s own `if __name__ == '__main__':` guard would otherwise handle) — the
e2e fixture above runs bare `python3 app.py` instead, so gunicorn-specific behavior (the
`/api/restart` SIGHUP path, `on_starting`'s auto_sync/tracking/pre-push-hook setup) isn't
exercised by the e2e suite at all. If the change touches that layer, verify against the real
container directly, not the fixture.
