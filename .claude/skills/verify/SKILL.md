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
(`reference_nbweb_claude_login`) — check there first before assuming it's unusable. **This has
now gone stale twice** (2026-07-08→2026-08-02, memory file never actually got written despite
the original note claiming it would be; then again 2026-08-02→2026-08-07, real login failure
against the bare dev server mid-verification) — treat "stale credential" as the expected steady
state to check for, not a surprising one-off. Reset it the same way each time rather than
concluding there's no login at all: `generate_password_hash(new_pw)` (werkzeug), write the hash
into `.users/claude.md`'s `password_hash:` field, save the new plaintext to memory immediately.

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

**The bare dev server does not hot-reload (`use_reloader=False`) — an `app.py` edit needs the
process actually killed and restarted, not just re-launched over a still-running old one.**
Confirmed live 2026-08-08 building the `help:` list/selector extension: `pkill -f
"NB_WEB_PORT=5002"` (matching the launch command's own env-var prefix) silently killed nothing,
because a shell env-var assignment in front of a command isn't part of that process's own
`argv` — `pkill -f` matches against argv, not the shell line that spawned it. The new
`nohup ... &` looked like a normal restart (no error, new-looking log lines appended) but was
actually a second process failing to bind the already-held port, while the *original* stale
process kept serving requests underneath it with the old code in memory — cost real time
chasing what looked like a "list value got stringified" application bug that was actually just
stale bytecode. Kill by PID when in doubt: `ss -ltnp | grep <port>` → `kill -9 <pid>`, then
confirm the port was actually freed before relaunching. This is a bare-dev-server-only concern —
the real container (`systemctl --user restart container-nb-web.service`) doesn't have this
failure mode, it always tears down the old process cleanly.

**The app's own ambient per-note check system (`nbweb-codeblocks.js`/`main.js`) used to be a
separate, real performance cost, unrelated to whatever's being verified** — up to 25-30s added
to *every* note's first paint from up to 8 ambient glob families each firing their own sequential
`/api/check/run` calls, and blocking every other plugin's codeblocks on the same note behind it
in `NbWeb.renderCodeblocks`'s shared serial loop. **Fixed 2026-08-02** (`nb-web` CLAUDE.md
invariant 20, "Render pipeline" Stage 3): check now runs strictly last, deferred off the shared
loop, resolves every ambient family in parallel into one `/api/check/batch` call, and
consolidates into a single sticky badge (`.nb-check-notify-anchor`) in the note's own top margin
— typically ~2-5s total now, not 25-30s, and no longer blocks anything else. If a page load
during verification still shows a check-related burst of individual `/api/check/run` calls or
takes anywhere near the old 25-30s figure, that's now a real regression to investigate, not
expected background noise to route around.

**Diagnosing unexplained slowness or an unexpected request burst: instrument `window.fetch`
directly, don't guess from reading code.** Found two real, non-obvious bugs this way 2026-08-03
(`cine org` render time regression) that code review alone hadn't caught: two independently-
serialized background passes that were nonetheless running concurrently with each other, and a
cache-generator bug where most nodes never got a field set at all, so they silently bypassed the
cache regardless of freshness. `page.on('request', ...)` only gives you the URL and timing, not
*which code* issued it — for that, wrap `fetch` itself before navigation (Playwright's
`add_init_script`, so it's in place before any page JS runs) and capture a stack trace per call:

```javascript
// fetch_hook.js -- add via page.add_init_script(open('fetch_hook.js').read())
(() => {
    const orig = window.fetch;
    window.__fetchLog = [];
    window.fetch = function(url, ...rest) {
        if (typeof url === 'string' && url.includes('/api/')) {
            window.__fetchLog.push({
                url, t: performance.now(),
                stack: (new Error().stack || '').split('\n').slice(0, 6).join(' | '),
            });
        }
        return orig.call(this, url, ...rest);
    };
})();
```

Then `page.evaluate('window.__fetchLog')` after the action under test to get a real, ordered,
attributed timeline — each entry's stack trace names the exact function and file that issued it,
which is what actually distinguishes "my own new code" from "an unrelated ambient system" when a
burst of requests all land around the same time. Cheap, reusable, worth reaching for before
theorizing about *why* something is slow.

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

## Gotcha: a hash-URL `page.goto()` doesn't mean the note has finished rendering

Playwright's `page.goto(f"{BASE}/#{selector}")` right after login (matches `e2e/tests/helpers.js`'s
own `openNote()`) does trigger a real navigation and `init()` does run `openNote(deepLink)` — but
a flat `page.wait_for_timeout(2000)` afterward is not a reliable way to know rendering finished,
especially for a note whose previewRenderer kicks off its own async data fetch (e.g. any
`nbweb-cine` type with a `previewRenderers` entry — `_loadCineBlock`'s bundle fetch can outlast a
2s guess on the bare dev server). `helpers.js` already has this right: `wait_for_selector`
(`.nb-rendered` for a plain note; for a plugin-driven type, wait on that plugin's own rendered
root instead) rather than a fixed timeout. Confirmed live 2026-08-06 chasing the Lock/Unlock cache
bug below — several early repro attempts read "button never appears" as a real symptom when it
was actually a race: the button *was* being added, just after the fixed timeout had already given
up and checked.

**Diagnosing a JS error mid-render**: `page.on('pageerror', ...)` (Python) gives a real stack
trace including the throwing function's name — more reliable than guessing from reading source in
isolation, which is exactly what mis-scoped a debug `console.log` during that same session (added
inside what looked like `openNote(selector, ...)` by line-proximity, actually inside a separate
`renderPreview(note)` — `selector` wasn't in scope there, `note.selector` was).

## Fixed 2026-08-08: `NbMain.openNote()` now updates `location.hash` — the gotcha below is history

Superseded by `nb-web` commit `081932a`. Kept below (struck through in spirit, not deleted) as a
still-useful example of the DOM-state-over-URL-assertion pattern, and because the *old* behavior
is exactly what you'll hit if you're checking out a commit from before this date. As of
`081932a`: `openNote()` calls `history.replaceState()` on every navigation, so `page.url`/
`location.hash` genuinely does reflect the current note now, and a `hashchange` listener means
`page.goto(f"{BASE}/#Other:note.md")` from an already-loaded page reliably navigates too
(confirmed live: title updates correctly, no `page.reload()` workaround needed anymore). Asserting
on `page.url` after a navigation is a valid signal again. The DOM-state signal below
(`#nb-preview-title`) is still the *faster* one (set synchronously at the top of `openNote()`,
before the hash update and before any async fetch) — prefer it when speed matters, but you're no
longer forced into it.

**Original gotcha (pre-`081932a`), for historical/pre-fix-commit reference:** the URL hash used to
be read exactly once, at initial page load (`init()`'s deep-link handling) — every subsequent
in-app navigation swapped `#nb-preview-content` in place and never touched `location.hash` again.
Confirmed live 2026-08-07/08 verifying the cine-org QUERY readiness feature: a test asserted
`'pitch-deck' in page.url` right after a click that should have navigated there, and it failed
every time even though the navigation had genuinely happened. The reliable signal was DOM state,
not the URL: `#nb-preview-title`'s `textContent`, via
`page.wait_for_function("document.getElementById('nb-preview-title').textContent.includes('...')")`.

## Gotcha: `page.inner_html()` proves markup exists, not that it's visible

Confirmed live 2026-08-12 chasing the annotation-frontmatter-rendering feature (CLAUDE.md
invariant 39's follow-on bug): a Playwright check that only calls `page.inner_html(selector)`
and greps the result for the expected markup will report success even when a CSS rule is
hiding that exact element (`display: none`) — `inner_html()` returns the DOM's serialized HTML
regardless of computed visibility, hidden elements included. This app has more than one
class-toggle suppression mechanism that can silently swallow new markup this way (`ui_hide:
fm`/`ui_hide: annotation` → `.nb-hide-fm`/`.nb-hide-annotation` on `#nb-preview-content`, the
extras-toggle button doing the same thing manually) — a first verification pass genuinely
passed (`.nb-ann-fm` was present in the captured HTML) while the real browser showed nothing,
because the note under test had `ui_hide: fm` configured and the new block reused
`.nb-fm-fallback` for styling, so it got caught by that suppression rule too.

**When a feature could plausibly be gated by a CSS class rather than being conditionally
rendered at all**, don't stop at `inner_html()` — confirm actual visibility:

```python
el = page.locator('.some-new-block')
print("visible:", el.is_visible())
print("display:", el.first.evaluate("e => getComputedStyle(e).display"))
```

`is_visible()` is the quick pass/fail; the `getComputedStyle` read is useful when you need to
know *which* rule is winning, not just whether something's hidden.

## Gotcha: verifying `:hover` styling with Playwright is flaky if you don't re-anchor

Confirmed live 2026-08-07 chasing an invisible-hover-text bug (CLAUDE.md invariant 28):
`locator.hover()` immediately followed by a separate `.evaluate()` call to read
`getComputedStyle` sometimes reported the *unhovered* state (background transparent) even
though the locator's own coordinates looked right — and a `bounding_box()` captured once and
reused across a `click()`-triggered re-render can silently point at stale coordinates once the
DOM has been replaced, landing the mouse somewhere else entirely (confirmed: one run moved to
`y≈251` instead of the real `y≈623`, because the page had re-rendered between the first
`bounding_box()` call and the move). A `getComputedStyle` read alone was also once misleading in
a way not fully root-caused — treat it as one signal, not proof, when it disagrees with the
pixels.

The pattern that worked reliably: wait for the click's re-render to actually settle
(`wait_for_selector` + a real timeout, not just the click), grab `bounding_box()` **fresh, right
before** the move, drive the pointer with `page.mouse.move(cx, cy, steps=10)` (not
`locator.hover()`), then confirm two ways that agree: `document.querySelectorAll(':hover')`
mapped to tag/class (proves the browser's own hover-match state, not just coordinates), *and* an
actual pixel sample from `page.screenshot()` cropped to the element's rect via PIL — the
computed-style read is useful to have but shouldn't be trusted alone if it disagrees with a
real screenshot.

## Recipe: real login + real data, verifying a UI action's actual effect (not just that it 200s)

Full working pattern, 2026-08-06 (chasing the `_noteCache` bug in invariant 25) — log in as
`claude` against the bare dev server with real `~/.nb` data, drive an actual button click, and
check the resulting DOM state, not just that the POST succeeded:

```python
from playwright.sync_api import sync_playwright

BASE = "http://localhost:5003"   # NB_WEB_PORT=5003 python3 app.py — pick an unused port
SEL  = "Takeout:storylines/film-school.md"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.on("pageerror", lambda exc: print("PAGEERROR:", exc.message))

    page.goto(f"{BASE}/login")
    page.fill('input[name="username"]', 'Claude')
    page.fill('input[name="password"]', '<see reference_nbweb_claude_login memory>')
    page.click('button[type="submit"]')
    page.wait_for_url('**/')

    page.goto(f"{BASE}/#{SEL}")
    page.wait_for_selector('.nb-rendered', timeout=10000)   # not a fixed sleep

    page.click('#nb-relock-btn')
    page.wait_for_timeout(1200)   # fine for settling after a click; not for initial render
    assert page.query_selector('#nb-unlock-btn') is not None
```

A real write's effect is verifiable two ways at once, and both should agree: the DOM state
(as above) and `git -C ~/.nb/<notebook> log --oneline -- <file>` (every `/api/cine/lock` call,
and most note mutations generally, commit for real — see `nb-web` skill's own note on
auto-commit). If they disagree, the bug is almost certainly a stale-render/cache issue on the
frontend, not a write failure — check `_noteCache` (invariant 25) before anything else.

**This recipe mutates real production data, not a disposable fixture** — `film-school.md`'s
`lock: yes` is real example content djp actually keeps, not a test fixture that resets itself.
Any verification pass that locks/unlocks it (or writes anything else real) needs its own
restore step at the end, back to the state found at the start — confirmed live 2026-08-06
verifying the storylines-board lock feature (unlock → inspect unlocked-state DOM → re-lock
before closing the browser). Don't leave real example data in a different state than you found
it just because the automated assertions all passed.

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

## Testing a `.checks/` script directly, without going through the app

`api_check_run`/`api_check_batch` (`app.py`) invoke a check script as `subprocess.run(['bash',
script_path], env={**os.environ, 'NB_DIR': ..., 'NB_APP_DIR': str(Path(__file__).parent),
'NB_NOTE_SELECTOR': ..., 'NB_NOTEBOOK': ..., 'NB_NOTE_PATH': ..., ...})` — reproduce that
env directly rather than launching the whole server just to exercise one script:

```bash
bash ~/.nb/.checks/some-check.sh --demo                              # Tier 2 spec self-test
NB_APP_DIR=/home/djp/dev/nb-web NB_DIR=/home/djp/.nb \
    bash ~/.nb/.checks/some-check.sh                                 # real run against real data
```

`NB_APP_DIR` matters specifically for any check that needs to know where the *running app's
own code* lives (not just notebook content under `NB_DIR`) — e.g. reading `$NB_APP_DIR/plugins/
*.js` to cross-check something in a plugin's source. It's tier-agnostic by construction: same
env var name resolves to `~/dev/nb-web` on the bare dev server and `/app` inside the container,
so a check written against it works on both without special-casing either. Confirmed live
2026-08-10 building `nb-config-renderer.sh` (flags a notebook's `types:*:renderer:` value that
doesn't match any real registered id) — this two-line manual-env recipe caught real, accurate
findings against live `~/.nb` data without ever needing 5001/5002 up at all.

## Recipe: screenshot a header/modal/popup instead of trusting computed-style checks alone

Built 2026-08-31 verifying the `add:org` `[+]` picker's create-modal and its dev-only "open
source" link. `is_visible()`/`getComputedStyle()` reported the link as genuinely
`display:block`, `opacity:1`, non-clipped — and it *was* technically visible — but djp still
couldn't spot it in real use (a `var(--text-muted)` token is 50%-alpha; combined with djp's own
`solarized` notebook theme it read as functionally invisible even though every automated
visibility check passed). Computed-style/bounding-box checks prove an element *isn't hidden*;
they don't prove a human will actually notice it — for a genuine "can I see this" question,
render it and look, the same lesson as the `inner_html()`-proves-markup-not-visibility gotcha
above but one level further (this one passed *even* the visibility check).

```python
from playwright.sync_api import sync_playwright

BASE = "http://localhost:5002"
SEL  = "<notebook>:<path-to-a-real-type-project-note>"   # any note with effective_add_org set

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    page.goto(f"{BASE}/login")
    page.fill('input[name="username"]', 'claude')
    page.fill('input[name="password"]', '<see reference_nbweb_claude_login memory>')
    page.click('button[type="submit"]')
    page.wait_for_url('**/')

    page.goto(f"{BASE}/#{SEL}")
    page.wait_for_selector('.nb-rendered', timeout=15000)

    page.locator('.nb-specialty-add').first.click()
    page.wait_for_selector('#nb-add-org-picker', timeout=5000)
    # Pick a branch/leaf node that actually collects fields (e.g. "Projects"),
    # not a zero-field leaf like "Today" -- those auto-execute and never show
    # a modal at all, so a screenshot of that path would show nothing to see.
    row = page.locator('#nb-add-org-picker .nb-add-org-picker-row.nb-add-org-picker-actionable',
                        has_text="Projects").first
    row.click()
    # Wait on the real form, not just the modal id -- the modal starts as a
    # bare spinner (.nb-org-action-panel) while _addOrgScanForm awaits its
    # own template fetches, and a fixed sleep here is exactly the kind of
    # flaky wait the "hash doesn't mean rendering finished" gotcha warns about.
    page.wait_for_selector('#nb-add-org-modal .nb-org-action-form', timeout=15000)
    page.wait_for_timeout(300)

    page.locator('.nb-invoice-panel').first.screenshot(path="/tmp/modal_panel.png")
    browser.close()
```

Then actually `Read` the PNG — don't just check `is_visible()`/`bounding_box()` and call it
done when the question is specifically about legibility/contrast, not presence.
