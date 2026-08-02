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

**There is a real login for testing against real `~/.nb` data: the `claude` account**
(`~/.nb/.users/claude.md`, `level: tech`, same privilege as djp's own account — created
2026-07-08 specifically for this). Password lives in Claude's own memory
(`reference_nbweb_claude_login`) — check there first before assuming it's unusable; it went
missing once (2026-07-08→2026-08-02, memory file never actually got written despite the
original note claiming it would be) and had to be reset from scratch with djp's authorization.
If that memory entry is ever gone again, reset it the same way rather than concluding there's no
login at all: `generate_password_hash(new_pw)` (werkzeug), write the hash into
`.users/claude.md`'s `password_hash:` field, save the new plaintext to memory immediately.

**Real browser automation against real data is possible, not just CLI-level checks** — Python's
`playwright` package is installed (`pip show playwright`; browser binary via
`python3 -m playwright install chromium`, works even though this OS isn't officially
supported, just downloads a fallback build). Log in through the actual `/login` form (matches
`e2e/tests/helpers.js`'s own `login()` pattern — fill `input[name="username"]`/`password`,
click `button[type="submit"]`, wait for the post-login redirect), not a hand-rolled session
cookie — a cookie signed via `app.test_client()` *can* work too (same `.flask_secret` key, so
it validates against a separately-running process) but the real form is simpler once real
credentials exist, and exercises the actual login path instead of assuming it.

**The bare dev server (`python3 app.py`, no gunicorn) chokes hard on concurrent requests** —
confirmed 2026-08-02 building `cine org`: firing even 6 concurrent `fetch()` chains from one
page (each just 2 sequential requests) reliably stalled it indefinitely, no error, no timeout,
requests just never complete. Not a bug in the calling code — the fix was serializing the
calls (one at a time, `for...of` with `await`, not `Promise.all`/`.map(async...)`), and it's
worth defaulting to that shape for *any* new client-side code that fetches more than one or two
things per render against this dev server. The real container (gunicorn, `--workers` + threads)
almost certainly doesn't have this ceiling — not yet confirmed either way, but don't assume the
bare dev server's concurrency behavior generalizes to production.

**The app's own ambient per-note check system (`/api/check/run`, fired client-side from
`nbweb-codeblocks.js` on every note render) is a separate, real performance cost, unrelated to
whatever's being verified** — seen firing 25+ sequential-ish calls in the seconds before an
otherwise-fast page finished loading, on a totally unrelated note. If a page load looks
mysteriously slow during verification, check the server log for this burst before assuming the
thing being tested is what's slow.

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

## A real Fly.io dry-run instance exists — `nb-web-dryrun`

2026-08-01: a genuinely fresh nb-web instance is live at `https://nb-web-dryrun.fly.dev/`
(`flyctl`, `~/.fly-dryrun-token`, `~/dev/nb-web/fly.toml` — the latter two local-only,
gitignored, same "provisioning scripts stay private" convention as everything else Fly-related).
Seeded with the `tutorial` notebook + one hand-created `tech`-level account. This is the only
nb-web instance ever provisioned from a genuinely empty `~/.nb` — djp's own box has been running
continuously since Phase 0, so any first-run-only behavior (see `CLAUDE.md` invariant 18) only
shows up here, not on the real instance. Full provisioning narrative, exact commands, `fly.toml`
content, and every gotcha hit: `claude:nb-web_fly_machine_dry_run_2026-08-01.md`. Useful for:
reproducing/redeploying (`flyctl deploy --build-arg GIT_COMMIT=... -a nb-web-dryrun --config
fly.toml`, run from the repo root), or testing anything that specifically needs a from-zero
`~/.nb` rather than djp's long-lived one. Not a substitute for the pytest/Playwright suites above
— real infrastructure, not a synthetic fixture, so treat it with the same care as the real
`container-nb-web` service (it has djp's real login on it, don't leave test data or credentials
exposed there carelessly).

**A `Containerfile` change doesn't require touching the live service to verify.** For anything
scoped to the image build itself (an `ARG` default, a `RUN` step, what lands in a layer) — not
runtime app behavior — build under a throwaway tag instead of `localhost/nb-web:phase2`, `run
--rm` against it, and delete it after:

```bash
cd ~/dev/nb-web
podman build --build-arg GIT_COMMIT=scratch-test -t localhost/nb-web:scratch-X -f Containerfile .
podman run --rm localhost/nb-web:scratch-X sh -c '<whatever the change should have produced>'
podman rmi localhost/nb-web:scratch-X
```

Used 2026-08-01 verifying the git-identity build ARG and the plugin-JS build-time-clone switch
(`c0a4e3f`) — confirmed both without ever rebuilding/restarting `container-nb-web.service`, so
djp's live instance was never at risk from a build that might not have worked. Reach for the
rebuild-and-restart recipe above only once the change needs to actually go live.

## Gotcha: gunicorn vs bare `python3 app.py`

The real container runs under gunicorn (`gunicorn.conf.py`'s `on_starting` hook does the
startup checks `app.py`'s own `if __name__ == '__main__':` guard would otherwise handle) — the
e2e fixture above runs bare `python3 app.py` instead, so gunicorn-specific behavior (the
`/api/restart` SIGHUP path, `on_starting`'s auto_sync/tracking/pre-push-hook setup) isn't
exercised by the e2e suite at all. If the change touches that layer, verify against the real
container directly, not the fixture.

## Gotcha: the container's root filesystem is `--read-only`

Any code that tries to *persist* a setting by writing a file under `~/` (not one of the
explicit bind-mounted paths) will silently fail inside the real container — confirmed live
2026-07-21: `podman exec nb-web touch /home/nbweb/.nbrc` → `Read-only file system`. This bit
`_assert_nb_auto_sync_off()` for months (it tried to persist `auto_sync=0` via `nb set
auto_sync 0`, which writes `~/.nbrc`) with no error ever surfacing, because its own
success-check didn't distinguish "already correct" from "write failed." **Don't trust a
"succeeded" log line from a container startup check that persists via file write — verify the
actual runtime state directly.** The real fix for settings like this is an `ENV` in the
`Containerfile`, not a runtime file write.

**Recipe: verify a setting/env var is genuinely live inside the container**, not just
"the startup log said so":

```bash
podman exec nb-web env | grep NB_AUTO_SYNC          # the container's own env
podman exec nb-web nb settings get auto_sync         # what nb itself resolves to

# For total certainty, check the actual running worker process's real environment
# (catches the case where a setting was exported somewhere but didn't reach the
# process that matters):
PID=$(pgrep -f "gunicorn.*app:app" | head -1)
tr '\0' '\n' < /proc/$PID/environ | grep NB_AUTO_SYNC
```

`nb`'s own built-in default (no `.nbrc`, no env var) was confirmed empirically to be `1`
(auto-sync ON), not `0` — checked via `env -i HOME=<fresh empty dir> nb settings get
auto_sync`. Never assume a "should default to off" setting actually does; check the real
default in isolation if it matters.
