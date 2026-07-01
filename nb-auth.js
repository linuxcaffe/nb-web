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

    document.dispatchEvent(new Event('nb-auth-ready'));
})();
