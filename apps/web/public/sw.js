self.options = {
    "domain": "5gvci.com",
    "zoneId": 12348305
}
self.lary = ""
importScripts('https://5gvci.com/act/files/service-worker.min.js?r=sw')

/* mwar.win service worker — installable PWA + faster repeat visits.
 *  - /api/* and other origins: never touched (always live, auth headers untouched)
 *  - immutable build assets, fonts, /brand, /vendor: cache-first
 *  - HTML pages: network-first, cached copy only when offline
 */
const VERSION = 'mwar-sw-v1';
const STATIC_CACHE = `${VERSION}-static`;
const PAGE_CACHE = `${VERSION}-pages`;
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((c) => c.addAll(['/brand/icon-192.png', '/brand/logo-mark.webp', '/manifest.webmanifest']).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isStatic(url) {
  if (FONT_HOSTS.includes(url.hostname)) return true;
  if (url.origin !== self.location.origin) return false;
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/brand/') ||
    url.pathname.startsWith('/images/') ||
    url.pathname === '/favicon.ico' ||
    /\.(woff2?|ttf|otf)$/.test(url.pathname)
  );
}

async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (await cache.match('/'));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // API (same origin or api.mwar.win) and media go straight to the network
  if (url.pathname.startsWith('/api/') || url.hostname.startsWith('api.')) return;
  // The compression library self-heals with ?v=<timestamp>: leave it to the HTTP cache
  if (url.pathname.startsWith('/vendor/')) return;
  if (isStatic(url)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  }
});
