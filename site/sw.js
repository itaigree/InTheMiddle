// Offline support for the app shell. Same-origin files are fetched network-first
// (revalidated past the HTTP cache, so a new deploy shows up right away) and served
// from the cache when offline. Requests to other origins (maps, places, routing,
// fonts) and non-GET requests are left alone.

const PREFIX = 'inthemiddle-'; // CacheStorage is shared by every <user>.github.io/<repo> site
const CACHE = `${PREFIX}__BUILD__`; // the deploy workflow stamps the commit id here

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'config.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'js/main.js',
  'js/core/availability.js',
  'js/core/categories.js',
  'js/core/format.js',
  'js/core/geo.js',
  'js/core/midpoint.js',
  'js/core/ranking.js',
  'js/core/search.js',
  'js/core/state.js',
  'js/providers/errors.js',
  'js/providers/google.js',
  'js/providers/osm.js',
  'js/ui/autocomplete.js',
  'js/ui/links.js',
  'js/ui/map-google.js',
  'js/ui/map-leaflet.js',
  'js/ui/results.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // cache: 'reload' skips the HTTP cache (GitHub Pages serves max-age=600).
      await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** How long a page load waits for the network before opening from the cache. */
const NETWORK_TIMEOUT_MS = 4000;

/**
 * Pages (clients) that were opened from the cache. Their files also come from
 * the cache, so one page never mixes files from two different deploys.
 */
const cacheClients = new Set();

/** Is this navigation the app itself (any ?query), as opposed to e.g. the manifest? */
function isAppPage(url) {
  const path = new URL(url).pathname;
  const scope = new URL(self.registration.scope).pathname;
  return path === scope || path === `${scope}index.html`;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  const navigate = request.mode === 'navigate';
  // Every search link (?a=…&b=…) is the same app page: cache it once.
  const shell = navigate && isAppPage(request.url);
  const cacheKey = shell ? new Request('./') : request;
  const fromCache = async () => (await caches.open(CACHE)).match(cacheKey);

  if (!navigate && cacheClients.has(event.clientId)) {
    event.respondWith((async () => (await fromCache()) || fetch(request))());
    return;
  }

  let stored = Promise.resolve();
  const network = fetch(request, { cache: 'no-cache' }).then((response) => {
    const html = (response.headers.get('content-type') || '').includes('text/html');
    // Clone before the page starts reading the body.
    if (response.ok && (!shell || html)) {
      const copy = response.clone();
      stored = caches.open(CACHE).then((cache) => cache.put(cacheKey, copy));
    }
    return response;
  });
  // Keep the worker alive until the cache is updated (registered synchronously).
  event.waitUntil(network.then(() => stored).catch(() => {}));

  event.respondWith(
    (async () => {
      try {
        if (!navigate) return await network;
        // A stalled connection (captive portal, tunnel) shouldn't hang the app:
        // after a few seconds open it from the cache, files and all.
        const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
        const first = await Promise.race([network, timeout]);
        if (first) return first;
        const cached = await fromCache();
        if (!cached) return await network;
        if (event.resultingClientId) cacheClients.add(event.resultingClientId);
        return cached;
      } catch (err) {
        const cached = await fromCache();
        if (!cached) throw err;
        if (navigate && event.resultingClientId) cacheClients.add(event.resultingClientId);
        return cached;
      }
    })(),
  );
});
