// nb-web service worker — minimal shell cache for PWA installability
// API calls always go to network; only app shell assets are cached.

const CACHE = 'nb-web-v307';
const SHELL = [
    '/', '/index.html', '/styles.css',
    '/main.js', '/nav.js', '/nbweb.js', '/theme.js', '/terminal.js', '/dialog.js', '/drag-handles.js', '/note-actions.js', '/search.js', '/sync.js', '/plugins-page.js', '/notebooks-page.js', '/templates.js', '/ui-access.js', '/ui-chrome.js',
    '/nb-logo.png',
    '/settings.html',
    '/vendor/marked.min.js',
    '/vendor/jsuites.min.css', '/vendor/jsuites.min.js',
    '/vendor/jspreadsheet.min.css', '/vendor/jspreadsheet.min.js', '/vendor/jspreadsheet-formula.min.js',
    '/vendor/xterm.js', '/vendor/xterm.css', '/vendor/xterm-addon-fit.js',
    '/manifest.json', '/logo-192.png', '/logo-512.png',
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    // API calls and WebSocket upgrades: always network, never cache.
    if (e.request.url.includes('/api/') || e.request.url.includes('/ws/')) return;

    // App shell: cache-first, network fallback
    e.respondWith(
        caches.match(e.request)
            .then(cached => cached || fetch(e.request))
            .catch(() => fetch(e.request))
    );
});
