// Service worker Comet — coque hors-ligne SANS risque d'écran blanc.
// Stratégie :
//   - navigations (HTML)  → network-first, repli sur la dernière coque en cache (hors-ligne)
//   - /assets/* (hachés)  → cache-first (immuables, le nom change à chaque build)
//   - /api, /ws           → JAMAIS interceptés (toujours le réseau)
const CACHE = 'comet-shell-v2';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.add('/')).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  // Navigations : réseau d'abord, repli coque en cache.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => { caches.open(CACHE).then((c) => c.put('/', res.clone())).catch(() => {}); return res; })
        .catch(() => caches.match('/').then((r) => r || caches.match(request)))
    );
    return;
  }

  // Assets hachés : cache d'abord, puis réseau (et on met en cache au passage).
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      }))
    );
    return;
  }

  // Reste : réseau, repli cache.
  e.respondWith(fetch(request).catch(() => caches.match(request)));
});

// ── NOTIFICATIONS BUREAU (Web Push) ─────────────────────────────────────────
//  C'est ce bloc qui rend la notification possible APPLICATION FERMÉE : le service
//  de push du navigateur réveille ce worker, même sans onglet Comet ouvert.
//
//  🔐 La charge ne contient NI expéditeur NI objet : Comet est chiffré de bout en
//  bout, le serveur ne peut pas les lire — et le service de push qui relaie ce
//  message (Google, Mozilla, Apple) n'a rien à y apprendre. C'est voulu.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  const title = d.title || 'Comet';
  const opts = {
    body: d.body || 'Nouveau message.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // tag : une seule notification empilée pour le courrier, pas une par message —
    // dix mails d'affilée ne doivent pas noyer le bureau.
    tag: d.tag || 'comet',
    renotify: true,
    data: { url: d.url || '/' },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

//  Clic : on RÉUTILISE un onglet Comet déjà ouvert plutôt que d'en empiler un
//  nouveau à chaque notification.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.location.origin)) { await c.focus(); return; }
    }
    await self.clients.openWindow(url);
  })());
});
