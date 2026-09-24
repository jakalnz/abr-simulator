/* Offline support: the whole app is a handful of static files, cached on first visit.
 * Stale-while-revalidate: pages load from the cache (so the app works offline), and each file is refreshed from the
 * network in the background, so a new version is picked up on the next load without bumping anything by hand.
 * Bump CACHE only if the file list changes. */
const CACHE = 'abr-sim-v1';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'js/model.js', 'js/codec.js', 'js/defaultPatients.js',
  'favicon.svg', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    // share links (index.html?..#case=) and './' all map to the cached page
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const cached = await c.match(key, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => { if (res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
    if (cached) { e.waitUntil(fresh); return cached; }
    return (await fresh) || new Response('Offline and not cached yet', { status: 503, statusText: 'Offline' });
  }));
});
