"""gunicorn server hooks.

app.py's own startup checks (WEB_PLUGINS_DIR creation, NB_AUTO_SYNC-off,
notebook tracking config, pre-push hook install) live inside
`if __name__ == '__main__':` -- which only fires when app.py runs as a
script directly. Gunicorn imports app.py as a module instead (`app:app`),
so that guard never runs under gunicorn; this hook is gunicorn's own
equivalent one-time-at-boot mechanism.

Deliberately NOT moved into app.py's module scope: nb-web-tests/conftest.py
does `import app as nb_app` directly, once, before any test's NB_DIR
monkeypatching takes effect -- unconditional module-level execution would
make every test run silently write real pre-push hooks and touch real git
tracking config against whatever NB_DIR resolves to at import time.
"""


def on_starting(server):
    import app

    app.WEB_PLUGINS_DIR.mkdir(parents=True, exist_ok=True)
    app._assert_nb_auto_sync_off()
    app._assert_notebook_tracking()
    app._install_prepush_hooks()
