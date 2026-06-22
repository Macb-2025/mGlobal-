// Service worker du mode hybride offline (PWA).
// - Enveloppe applicative mise en cache pour un démarrage instantané et hors-ligne.
// - Lectures API (GET) en « network-first » avec repli sur le cache → l'app reste
//   consultable sans réseau.
// - Les écritures hors-ligne sont mises en file (Outbox IndexedDB côté page) ; ce
//   worker relaie l'événement Background Sync à la page pour déclencher le rejeu.
const SHELL = 'mglobal-shell-v3';
const API = 'mglobal-api-v1';
const ASSETS = ['/', '/index.html', '/app.js', '/styles.css', '/logo.svg', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== SHELL && k !== API).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // les écritures sont gérées par l'Outbox côté page
  const url = new URL(req.url);

  if (url.pathname.startsWith('/api/')) {
    // Lectures API : réseau d'abord, on met à jour le cache, repli sur le cache hors-ligne.
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(API).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((r) => r ||
        new Response(JSON.stringify({ error: 'Hors-ligne : données indisponibles' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } })))
    );
    return;
  }

  // Reste (enveloppe applicative) : réseau d'abord, repli cache puis index.html.
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('/index.html')))
  );
});

// Background Sync : prévient les pages ouvertes de rejouer leur file d'attente.
self.addEventListener('sync', (e) => {
  if (e.tag === 'flush-outbox') {
    e.waitUntil(self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage('flush-outbox'))));
  }
});
