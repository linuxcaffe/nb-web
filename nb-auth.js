// nb-auth.js — shared user/level awareness for all nb-web HTML pages.
// Fetches /api/me once per session (cached in sessionStorage).
// Exposes window.NbUser and window.NbAuth.

(async () => {
    const CACHE_KEY = 'nb-auth-user';
    const LEVELS    = ['guest', 'user', 'office', 'admin', 'tech'];

    let user = null;
    try {
        const cached = sessionStorage.getItem(CACHE_KEY);
        if (cached) {
            user = JSON.parse(cached);
        } else {
            const r = await fetch('/api/me');
            if (r.ok) {
                user = await r.json();
                sessionStorage.setItem(CACHE_KEY, JSON.stringify(user));
            } else if (r.status === 401) {
                location.href = '/login';
                return;
            }
        }
    } catch {}

    window.NbUser = user || {};

    window.NbAuth = {
        level:  () => window.NbUser.level || 'guest',
        is:     (lvl) => LEVELS.indexOf(window.NbUser.level) >= LEVELS.indexOf(lvl),
        bust:   () => sessionStorage.removeItem(CACHE_KEY),
        gate:   (lvl, html) => window.NbAuth.is(lvl) ? html : '',

        // Show elements marked data-min-level="admin" etc., hide others
        applyVisibility: () => {
            document.querySelectorAll('[data-min-level]').forEach(el => {
                el.hidden = !window.NbAuth.is(el.dataset.minLevel);
            });
        },
    };

    // Stamp body with level so CSS can gate whole classes of UI elements:
    //   .nb-action-write  — requires user+   (Edit, Delete, Add, Save, Rename…)
    //   .nb-action-office — requires office+
    //   .nb-action-admin  — requires admin+  (Configure, Settings, dotfile edit…)
    function _stampAndDispatch() {
        document.body.dataset.userLevel = window.NbAuth.level();
        document.dispatchEvent(new Event('nb-auth-ready'));
    }
    // On a sessionStorage cache hit, everything above runs with no `await`,
    // so this executes synchronously during initial script evaluation --
    // before the parser has reached <body> (this script tag sits in <head>).
    // document.body is null at that point on every page load but the very
    // first one in a session, throwing here and silently killing
    // nb-auth-ready for the rest of the page's life (confirmed real: every
    // data-min-level section simply never un-hides). The uncached/fetch
    // path already has plenty of time for <body> to exist by the time it
    // resolves, so this only ever takes the deferred branch on a cache hit.
    if (document.body) {
        _stampAndDispatch();
    } else {
        document.addEventListener('DOMContentLoaded', _stampAndDispatch);
    }
})();
