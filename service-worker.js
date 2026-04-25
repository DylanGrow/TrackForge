const CACHE_VER = 'v3';
const APP_CACHE = `tf-app-${CACHE_VER}`;
const TILE_CACHE = `tf-tiles-${CACHE_VER}`;
const ASSETS = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('tf-') && k !== APP_CACHE && k !== TILE_CACHE).map(k => caches.delete(k))))
  ]));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname.includes('tile.openstreetmap.org')) {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request).then(res => {
        if (res.ok) { const c = res.clone(); caches.open(TILE_CACHE).then(cache => cache.put(e.request, c)); }
        return res;
      }).catch(() => new Response('Offline', {status:503})))
    );
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
