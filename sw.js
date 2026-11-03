// nb-web service worker — minimal shell cache for PWA installability
// API calls always go to network; only app shell assets are cached.

const CACHE = 'nb-web-v328';
const SHELL = [
    '/', '/index.html', '/styles.css',
    '/main.js', '/nav.js', '/nbweb.js', '/theme.js', '/terminal.js', '/dialog.js', '/drag-handles.js', '/note-actions.js', '/search.js', '/sync.js', '/plugins-page.js', '/notebooks-page.js', '/templates.js', '/ui-access.js', '/ui-chrome.js', '/tw-add.js',
    '/nb-logo.png', '/nw-logo.svg', '/nb-web-logo.svg',
    '/settings.html',
    '/vendor/marked.min.js',
    '/vendor/jsuites.min.css', '/vendor/jsuites.min.js',
    '/vendor/jspreadsheet.min.css', '/vendor/jspreadsheet.min.js', '/vendor/jspreadsheet-formula.min.js',
    '/vendor/xterm.js', '/vendor/xterm.css', '/vendor/xterm-addon-fit.js',
    '/manifest.json', '/logo-192.png', '/logo-512.png', '/logo-maskable-512.png',
];
const SHELL_PATHS = new Set(SHELL);

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            // Only our own old caches: behind a proxy that puts tw-web on this origin (tw-nb-interop
            // M7), the cache storage is shared, and tw-web's caches aren't ours to delete.
            .then(keys => Promise.all(keys.filter(k => k.startsWith('nb-web-') && k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    // Only our own shell, from our own cache. Everything else (API calls, WebSocket upgrades,
    // plugins, notes' files, and anything of tw-web's behind a shared-origin proxy, which this
    // worker's scope / also covers) goes to the network untouched.
    const url = new URL(e.request.url);
    if (e.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL_PATHS.has(url.pathname)) return;

    // App shell: cache-first, network fallback
    e.respondWith(
        caches.open(CACHE)
            .then(c => c.match(e.request))
            .then(cached => cached || fetch(e.request))
            .catch(() => fetch(e.request))
    );
});
