<!-- Generated from docs:dev/dev-test-suite.md by .tools/readme-export.py. Edit the source, not this file. -->

# NB-WEB TEST SUITE — STRATEGY

> Developer documentation for nb-web. See [DEVELOPERS](../DEVELOPERS.md) for the full index.
> Status: #wip — Layers 1/2 original scope complete (140 pytest tests), Layer 4 (Playwright) grown from its first smoke test (2026-07-06) to 19 tests across 11 spec files (2026-07-07), tracking the `main.js` satellite extractions and a couple of standalone kernel bug fixes. Remaining work is growth (new areas as they're added, on both the pytest and Playwright sides) and the "Eventually"/"Multi-user" phases below, not a fixed P0–P2 list anymore.

---

## Philosophy

The test suite extends the existing `.checks/` script philosophy into a formal
automated layer, rather than replacing or duplicating it. Four layers, each with
a distinct job:

```
Layer 4 — Playwright browser smoke tests        real JS behaviour (live server, disposable fixture)
Layer 3 — .checks/ blocks in dashboard notes    production monitoring (live data)
Layer 2 — pytest invoking .checks/ scripts      script contract verification (synthetic data)
Layer 1 — pytest + Flask test client          backend logic (no server, no real data)
```

Layer 3 already existed and works. The suite added Layers 1 and 2 first (2026-07-05/06), then Layer 4 (2026-07-06) once the `main.js` split raised the cost of *not* having real JS coverage — see Layer 4 below for why the earlier "no headless browser" exclusion changed.

**Key principle:** tests are executable specifications. The dev docs describe what
`_can_access` promises and what `nb-check-front.sh` contracts. The test suite
makes those promises verifiable and regression-proof.

---

## Isolation

**Separate repo: `~/dev/nb-web-tests/`**

- Pins to nb-web via path (`sys.path.insert(0, '../nb-web')`) — no package needed
- Can test a specific nb-web commit without touching the running instance
- Tests are versioned independently — no test churn in the app repo
- CI-ready when the time comes, without touching the main repo
- Mirrors the undercarriage philosophy: test infrastructure travels separately

The repo is NOT a submodule. A simple path reference in `conftest.py` is enough.

---

## The Fixture Model

Every test gets a clean, synthetic nb world via a pytest fixture. No dependency
on `~/.nb/` real data — ever.

```
conftest.py
  tmp_nb(tmp_path) fixture:
    tmp_path/.nb/
      .nb.md              ← minimal global config (access: guest)
      .users/
        djp.md            ← level: tech
        guest.md          ← level: guest
        office.md         ← level: office
      home/
        .git/             ← bare init (enough for nb path resolution)
        .index            ← test-note.md
        test-note.md
      accts/
        .accts.md         ← access: office, checks: hl-entry-day
        .index            ← report.md
        report.md         ← type: note
        shots/
          .shots.md       ← default_type: shot, constraints: (alias required, etc.)
          .index           ← valid-shot.md, bad-shot.md
          valid-shot.md   ← type: shot, alias: 4f, scene: 1, seq: 1, title: Wide
          bad-shot.md     ← type: shot (missing alias, scene has "~req" not int)
```

**NB_DIR patching:** `conftest.py` sets `app.NB_DIR = tmp_path / '.nb'` via
`monkeypatch.setattr` before each test. All backend functions that read `NB_DIR`
see the synthetic world.

**Session patching:** tests that exercise access control inject a session user:
```python
with client.session_transaction() as sess:
    sess['user'] = {'username': 'djp', 'level': 'tech'}
```

---

## What's In Scope

The boundary is: **Flask backend logic that is non-trivial, recently changed,
or security-critical.** Everything else waits.

| Priority | Area | Rationale |
|----------|------|-----------|
| P0 | Config chain (`_folder_config`, `_notebook_config`, `_merge_configs`) | Most complex new logic; subtle walk-up rules; central to everything |
| P0 | Access control (`_can_access`, `_effective_access`, username access) | Security-critical; tech bypass invariant must hold |
| P0 | Shell scripts as black boxes (`.checks/*.sh` via subprocess) | Hybrid layer; validates the script contract with synthetic fixtures |
| P1 | Constraints (`_load_constraints`, `_normalize_constraint`) | Drives Changes panel; two input formats; dot-notation skipping |
| P1 | Settings migration (`_effective_setting`) | Just implemented; `.nb.md` wins, no fallback — must stay true |
| P1 | CBQL (`api_hledger_cbql_query`) | Command allowlist + server-side path read of notebook data; destination-access boundary case — see .rules/access.md |
| P1 | `/api/list` — pinning, tag_color, prepend_date, access filtering | Core list behaviour; several new fields just added |
| P2 | `/api/note` — effective_access, effective_tests, effective_fm fields | Authoritative fields that frontend trusts |
| P2 | Note creation — filename generation, template resolution | prepend_date logic, slug generation |

## What's Out of Scope (for now)

- **Rendering pipeline** — changes frequently, fragile to test at unit level
- **Git operations** — slow, stateful, integration-only
- **Plugin renderers** — belong in each plugin's own repo
- **PTY / WebSocket** — separate concern, separate testing strategy
- **hledger / cine plugin logic** — plugin repos own those tests

**JS / frontend is no longer categorically out of scope** (was, until
2026-07-06). "No headless browser, too much setup for the value" stopped
being true the moment `main.js`'s upcoming split raised the stakes on
knowing JS behavior actually works, not just that it parses. See Layer 4
below — the value calculation flipped, not the difficulty.

---

## File Structure

```
~/dev/nb-web-tests/
  conftest.py                 ← NB_DIR patch, Flask client, tmp_nb fixture, user helpers  ✅
  test_config_chain.py        ← _folder_config walk-up, _notebook_config, _merge_configs  ✅
  test_access.py              ← _can_access, _effective_access, username, tech bypass     ✅
  test_constraints.py         ← _load_constraints, _normalize_constraint                  ✅
  test_settings.py            ← _effective_setting: .nb.md wins, correct defaults         ✅
  test_cbql.py                ← api_hledger_cbql_query: allowlist, NB_DIR boundary,
                                 destination-notebook access check                        ✅
  test_shell_scripts.py       ← nb-check-front.sh, nb-dirty.sh, note-approved.sh,
                                 note-context.sh via subprocess + env                      ✅
  test_api_list.py            ← _list_notes: pinning, tag_color, access filter, ids        ✅
  test_api_note.py            ← /api/note: effective_access, effective_checks,
                                 effective_check_add, effective_xref, effective_fm         ✅
  test_note_creation.py       ← prepend_date, slug, explicit filename, template vars,
                                 dotfile creation, notebook ("dotfolder") creation         ✅
```

(The `fixtures/` factory-module split sketched in an earlier draft of this doc
never happened — fixture content lives directly in `conftest.py` and inline in
each test file instead, which has worked fine at this scale.)

---

## Layer 1: pytest + Flask Test Client

```python
# conftest.py (sketch)
import pytest, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / 'nb-web'))
import app as nb_app

@pytest.fixture
def tmp_nb(tmp_path, monkeypatch):
    nb = tmp_path / '.nb'
    _build_fixture_world(nb)          # writes synthetic files
    monkeypatch.setattr(nb_app, 'NB_DIR', nb)
    return nb

@pytest.fixture
def client(tmp_nb):
    nb_app.app.config['TESTING'] = True
    with nb_app.app.test_client() as c:
        yield c

def as_user(client, level='tech', username='djp'):
    with client.session_transaction() as s:
        s['user'] = {'username': username, 'level': level}
```

```python
# test_config_chain.py (sketch)
def test_folder_config_walk_up(tmp_nb):
    """Inner folder config wins over notebook config over global."""
    note = tmp_nb / 'accts/shots/valid-shot.md'
    cfg = nb_app._folder_config('accts', note)
    assert cfg['access'] == 'office'        # from .accts.md
    assert 'alias' in cfg['constraints']    # from .shots.md

def test_prepend_date_false_suppresses_timestamp(client, tmp_nb):
    as_user(client)
    r = client.post('/api/notes', json={'notebook': 'home', 'title': 'My Note'})
    assert r.json['selector'].split(':')[1] == 'my_note.md'  # no timestamp

def test_prepend_date_default_adds_timestamp(client, tmp_nb):
    # home notebook has no prepend_date: false in config
    as_user(client)
    r = client.post('/api/notes', json={'notebook': 'home', 'title': 'My Note'})
    import re
    assert re.match(r'\d{14}_', r.json['selector'].split(':')[1])
```

---

## Layer 2: Shell Scripts as Black Boxes

The hybrid layer. pytest sets up synthetic fixtures, invokes `.checks/*.sh` via
subprocess, and asserts on exit code and stdout patterns.

```python
# test_shell_scripts.py (sketch)
import subprocess, os

SCRIPTS = pathlib.Path.home() / '.nb/.test'

def run_script(name, note_path, nb_dir):
    env = {**os.environ,
           'NB_NOTE_PATH': str(note_path),
           'NB_DIR':       str(nb_dir),
           'NB_NOTEBOOK':  note_path.parts[-3],
           'NO_COLOR':     '1'}
    return subprocess.run(['bash', str(SCRIPTS / name)],
                          capture_output=True, text=True, env=env)

def test_check_front_clean_folder(tmp_nb):
    """Valid shots → silent pass."""
    r = run_script('nb-check-front.sh',
                   tmp_nb / 'accts/shots/valid-shot.md', tmp_nb)
    assert r.returncode == 0
    assert r.stdout == ''

def test_check_front_violation_detected(tmp_nb):
    """bad-shot.md missing alias, invalid scene → exit 1, named fields."""
    r = run_script('nb-check-front.sh',
                   tmp_nb / 'accts/shots/bad-shot.md', tmp_nb)
    assert r.returncode == 1
    assert 'missing **alias**' in r.stdout
    assert 'not an integer' in r.stdout

def test_check_front_no_default_type(tmp_nb):
    """Folder with no default_type → nothing to check, silent exit 0."""
    r = run_script('nb-check-front.sh',
                   tmp_nb / 'home/test-note.md', tmp_nb)
    assert r.returncode == 0
```

---

## Layer 4: Playwright Browser Smoke Tests

Lives in `~/dev/nb-web-tests/e2e/` (Node/Playwright, sibling to the Python
suite in the same repo — same "test infra travels separately from the app"
philosophy, different language runtime). Added 2026-07-06.

**Why this layer exists when it explicitly didn't before:** Layers 1–3
verify backend logic and script contracts; none of them can tell you
whether `main.js` actually does the right thing in a real browser —
`node --check` proves syntax, not behaviour. That gap was accepted as a
reasonable tradeoff ("too much setup for the value") until the `main.js`
split raised the stakes: refactoring an 8850-line file with zero behavioural
safety net for the language it's written in is a different risk profile
than refactoring around a well-tested backend. The setup cost didn't drop —
the cost of *not* paying it went up.

**How it stays isolated from real data:** `app.py` already reads `NB_DIR`
and `NB_WEB_PORT` from the environment (`os.environ.get(...)`, no code
changes needed). `playwright.config.js`'s `webServer` option builds a
disposable synthetic `.nb/` fixture (`e2e/fixtures/build_fixture.py`, same
shape as `conftest.py`'s but with a real `werkzeug` `password_hash` — e2e
tests log in through the actual `/login` HTML form, not a session-injection
shortcut, so the test user needs a real checkable password) in `/tmp`,
launches `app.py` against it on a dedicated test port, and tears both down
after the run. Zero contact with a real `~/.nb/` or a real dev server
running on the default port.

```javascript
// playwright.config.js (sketch)
webServer: {
    command: [
        `rm -rf ${NB_TEST_DIR}`,
        `python3 fixtures/build_fixture.py ${NB_TEST_DIR}`,
        `NB_DIR=${NB_TEST_DIR} NB_WEB_PORT=${NB_TEST_PORT} python3 ${NB_WEB_APP}/app.py`,
    ].join(' && '),
    url: `http://127.0.0.1:${NB_TEST_PORT}/login`,
},
```

```javascript
// tests/check-skip.spec.js (first real test, not a sketch)
test('check_skip subtracts sys- while nb- survives', async ({ page }) => {
    await login(page);
    await openNote(page, 'home:check-skip-demo.md');
    await expect(page.locator('.nb-test-block[data-query="nb-"]')).toHaveCount(1);
    await expect(page.locator('.nb-test-block[data-query="sys-"]')).toHaveCount(0);
});
```

Deliberately targeted at `_virtualTestPrefix`'s `check`/`check_add`/
`check_skip` resolution — the exact piece of JS logic added the same day
this layer was, with zero prior coverage. Verified real behaviour, not
just DOM shape: the server log during a passing run shows exactly one
`/api/check/glob?prefix=nb-` request and none for the skipped `sys-`
family, confirming the browser genuinely only resolved the surviving
family rather than the test happening to pass by coincidence.

**Run:** `cd ~/dev/nb-web-tests/e2e && npm test`

**Growth, 2026-07-06/07:** grew from the one `check-skip.spec.js` smoke test
to 11 spec files / 19 tests, one per `main.js` satellite extraction as the
modularization split landed (`drag-handles`, `note-actions`, `search`,
`sync`, `plugins-page`, `notebooks-page`, `templates`), plus
`check-cascade.spec.js` for a standalone kernel bug fix (see
`claude:mainjs-check-cascade-fix.md`) — proof the harness generalizes past
its original single-purpose motivation. Each new spec drives the exact
piece of JS wiring the paired commit touched, asserting on real rendered
output (not just DOM presence), per the established rule: a test meant to
catch "this cross-module wiring broke" must assert on the wiring's actual
effect.

**Critical fixture-isolation gotcha, found 2026-07-07:** the *pytest*
side's `tmp_nb` fixture (`conftest.py`) only patches `app.NB_DIR` and
derivatives — a Python-level `monkeypatch.setattr` that redirects the
Flask app's own direct filesystem reads. It does **not** touch
`os.environ`. Any code path that shells out to the real `nb` CLI binary
(`run_nb()`, used for every write — add-note, notebook creation,
filename-collision handling) inherits `os.environ` unchanged, and the real
`nb` binary defaults `NB_DIR` to `$HOME/.nb` when the env var isn't set.
Result: `test_note_creation.py`'s write-path tests were silently appending
to files in the real `~/.nb/home` on every single pytest run, for as long
as those tests existed — confirmed via ~50 accumulated stray files
(`my_note.md` with dozens of repeated headings, etc.) in a real user's
notebook. Fixed with one line: `monkeypatch.setenv('NB_DIR', str(nb))` in
the same fixture. **Lesson for any future fixture that redirects state for
code wrapping an external subprocess: patching Python globals is not
sufficient in itself — the subprocess only sees `os.environ`, so the
isolation variable needs an explicit `monkeypatch.setenv` too, verified by
checking file counts in the real target before/after a test run, not
assumed from the Python-level patch alone.** The Playwright/Layer-4 side
was never affected — `playwright.config.js`'s `webServer` sets `NB_DIR` as
a real OS-level environment variable before `app.py` even starts, so it
correctly reaches every subprocess `app.py` spawns.

**Growth path going forward:** same incremental model — next candidates
are whatever JS logic is about to be touched (tier-3/tier-4 of the
`main.js` split, see `claude:nb-web_mainjs-split-plan.md`), not a
comprehensive up-front sweep.

This is the bridge: the script's documented contract becomes an assertion.
When `nb-check-front.sh` changes, the test catches regressions. When a new
`.checks/` script is added, a corresponding test block is added here.

---

## Access Control Test Matrix

Access control has enough edge cases to deserve explicit parametrization:

```python
@pytest.mark.parametrize('user_level,note_access,nb_access,expected', [
    ('guest',  None,     'guest',  True),   # guest note in guest notebook
    ('guest',  None,     'user',   False),  # guest can't read user notebook
    ('user',   None,     'user',   True),
    ('user',   'office', 'user',   False),  # note raises floor
    ('office', 'office', 'user',   True),
    ('tech',   'admin',  'admin',  True),   # tech bypasses everything
    ('guest',  'djp',    'guest',  False),  # username lock, wrong user
    ('user',   'djp',    'guest',  False),  # username lock, wrong user
    # djp with username match:
    # (requires patching session username to 'djp')
])
def test_can_access(user_level, note_access, nb_access, expected, ...):
    ...
```

---

## Running the Suite

```bash
cd ~/dev/nb-web-tests
pytest                          # all tests (Layers 1-2)
pytest test_config_chain.py     # one file
pytest -k 'access'              # keyword filter
pytest -v --tb=short            # verbose, short tracebacks
pytest test_shell_scripts.py    # hybrid layer only

cd e2e && npm test              # Layer 4 — Playwright, starts + tears down its own server
```

No server running (Layers 1-2). Layer 4 starts and tears down its own isolated
server on a dedicated test port. No real `~/.nb/` data touched by any layer.
Clean run every time.

---

## Growth Path

| Phase | What gets added | Status |
|-------|----------------|--------|
| Done | conftest.py + test_config_chain + test_access + test_shell_scripts | ✅ 2026-06-20ish |
| Done | test_constraints + test_settings + test_cbql | ✅ 2026-07-05 (91 tests passing) |
| Done | test_api_list + test_api_note | ✅ 2026-07-06 (123 tests passing) |
| Done | test_note_creation (+ dotfile/notebook creation) | ✅ 2026-07-06 (138 tests passing — original scope complete) |
| Done | Layer 4 — Playwright e2e harness + first smoke test (check_skip resolution) | ✅ 2026-07-06 |
| Done | Layer 4 grows to 11 spec files / 19 tests — one per `main.js` satellite extraction + `check-cascade.spec.js` | ✅ 2026-07-07 |
| Done | Critical fix: `tmp_nb` fixture wasn't isolating subprocess writes from the real `~/.nb` (see Layer 4 gotcha above) | ✅ 2026-07-07 |
| Eventually | CI via Codeberg Actions on push to nb-web main (now needs to run both pytest AND Playwright) | 📋 |
| Multi-user | Session/auth tests, per-user fixture variants | 📋 |
| Growing | More Layer 4 smoke tests, prioritised by what the `main.js` split touches next (tier-3/tier-4) | 📋 ongoing, not a fixed list |

The suite grows with the project. P0 tests land first — the riskiest logic gets
coverage before the easy paths. The hybrid layer grows in step with `.checks/`: every
new shell script gets a corresponding test block in `test_shell_scripts.py`.

---

## What This Gives Us

- **Config chain regressions caught immediately** — the walk-up logic is complex enough to break silently
- **Security invariants enforced** — tech bypass, username lock, access floor — all specified as assertions
- **Shell script contracts formalised** — `nb-check-front.sh` behaviour is specified, not just described
- **Confidence to refactor** — `_folder_config` and `_effective_setting` can be changed knowing the tests will catch breaks
- **Living specification** — the tests ARE the spec; the dev docs describe intent, the tests verify it

---

> The suite isn't trying to test everything. It's trying to make the riskiest,
> most recently-changed, and hardest-to-eyeball logic verifiable with one command.
