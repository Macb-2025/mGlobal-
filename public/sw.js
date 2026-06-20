// Service worker minimal : permet l'installation de l'application (icône bureau /
// barre des tâches) et un démarrage rapide via un cache de l'enveloppe applicative.
const CACHE = 'mglobal-v1';
const ASSETS = ['/', '/index.html', '/app.js', '/styles.css', '/logo.svg', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Le réseau d'abord pour l'API (données fraîches), le cache en secours pour le reste.
  if (req.method !== 'GET' || req.url.includes('/api/')) return;
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('/index.html')))
  );
});
