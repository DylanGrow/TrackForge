const CACHE_APP = 'trackforge-v1';
const CACHE_TILES = 'trackforge-tiles';
const APP_FILES = ['./', './index.html', './styles.css', './app.js', './manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_APP).then(c => c.addAll(APP_FILES)));
});

self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => 
  Promise.all(keys.filter(k => ![CACHE_APP, CACHE_TILES].includes(k)).map(k => caches.delete(k)))
)));

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Map tiles: cache first, stale-while-revalidate
  if (url.includes('tile.openstreetmap.org')) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE_TILES).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => new Response('Offline', {status: 503}))));
    return;
  }
  // App shell
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
