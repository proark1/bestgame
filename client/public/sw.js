// Hive Wars service worker.
//
// Strategy:
//  * `/api/*`  → network-only, no cache. Game state has to be fresh.
//  * HTML      → network-first with a cache fallback, so the next load
//                after an update shows the new shell instantly but the
//                user still gets the game while offline.
//  * everything else (JS / CSS / assets / icons) → cache-first. The
//                Vite build fingerprints filenames, so a new deploy
//                ships new filenames and these cache entries only
//                grow; purge them when the SW version bumps.
//
// Bump `SW_VERSION` to invalidate all caches on the next visit. Old
// caches are nuked in `activate`.

const SW_VERSION = 'v1';
const STATIC_CACHE = `hive-static-${SW_VERSION}`;
const HTML_CACHE = `hive-html-${SW_VERSION}`;

self.addEventListener('install', (event) => {
  // Skip the "wait for all tabs to close" step — we want new SWs
  // active on the next navigation, not a week later.
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      cache.addAll([
        '/',
        '/manifest.webmanifest',
        '/icons/icon.svg',
        '/icons/icon-192.png',
        '/icons/icon-512.png',
      ]).catch(() => {
        // Missing files shouldn't block install — just log and move on.
      }),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== HTML_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Only control same-origin requests. Skip cross-origin (CDN images,
  // analytics beacons) — passing them through untouched avoids CORS
  // weirdness and lets the browser do what it'd do by default.
  if (url.origin !== self.location.origin) return;

  // API — never cache. Game state has to be the source of truth.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin/')) {
    return;
  }

  // HTML navigations — network-first; cache is the offline fallback.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(HTML_CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then(
            (cached) =>
              cached ??
              caches.match('/').then((root) => root ?? Response.error()),
          ),
        ),
    );
    return;
  }

  // Static assets — cache-first, fall back to network on miss. Vite
  // fingerprints filenames, so refreshing after a deploy pulls new
  // bundles without us needing to bust this cache manually.
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ??
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const clone = res.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        }),
    ),
  );
});
