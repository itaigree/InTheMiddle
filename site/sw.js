// Offline support for the app shell.
//
// Each deploy's worker precaches that deploy's files when it installs, and the
// cache is never updated at runtime, so it always holds one consistent version.
// A page is then served from ONE source: pages that load from the network fetch
// their files from the network (like without a worker); a page the network was
// too slow to open (or offline) is opened from the cache, and so are all of its
// files. Requests to other origins and non-GET requests are left alone.

const PREFIX = 'inthemiddle-'; // CacheStorage is shared by every <user>.github.io/<repo> site
const CACHE = `${PREFIX}__BUILD__`; // the deploy workflow stamps the commit id + config hash here

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
      // Take over right away, unless a page opened from an older deploy's cache is
      // still open: activating would delete the files it is still loading from.
      if (!(await pageOpenedFromOlderCache())) await self.skipWaiting();
    })(),
  );
});

async function pageOpenedFromOlderCache() {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const older = (await caches.keys()).filter((n) => n.startsWith(PREFIX) && n !== CACHE);
  for (const name of older) {
    const cache = await caches.open(name);
    for (const page of pages) if (await cache.match(clientMarker(page.id))) return true;
  }
  return false;
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      // A newer deploy's worker may be filling its cache right now (this one was
      // held back): leave the clean-up to it, it does the same when it activates.
      if (!self.registration.installing) {
        await Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
      }
      await self.clients.claim();
    })(),
  );
});

// Pages ask a held-back worker to check again when they load or come back into
// view: the page opened from an older cache may have been closed or reloaded since.
self.addEventListener('message', (event) => {
  if (event.data !== 'recheck') return;
  event.waitUntil(
    (async () => {
      if (!(await pageOpenedFromOlderCache())) await self.skipWaiting();
    })(),
  );
});

/** How long a page load waits for the network before opening from the cache. */
const NETWORK_TIMEOUT_MS = 4000;

/**
 * Pages (clients) that were opened from the cache. Kept in memory and in the
 * cache, since the browser stops idle workers and memory doesn't survive that.
 */
const cacheClients = new Set();
const clientMarker = (id) => new Request(`./__opened-from-cache/${encodeURIComponent(id)}`);

async function markOpenedFromCache(id) {
  if (!id) return;
  cacheClients.add(id);
  const cache = await caches.open(CACHE);
  await cache.put(clientMarker(id), new Response(''));
}

async function openedFromCache(id) {
  if (!id) return false;
  if (cacheClients.has(id)) return true;
  const hit = await (await caches.open(CACHE)).match(clientMarker(id));
  if (hit) cacheClients.add(id);
  return Boolean(hit);
}

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
  if (navigate && !isAppPage(request.url)) return; // other files opened as pages: just the network
  // Every search link (?a=…&b=…) is the same app page.
  const cacheKey = navigate ? new Request('./') : request;
  const fromCache = async () => (await caches.open(CACHE)).match(cacheKey);

  event.respondWith(
    (async () => {
      if (!navigate) {
        if (await openedFromCache(event.clientId)) return (await fromCache()) || fetch(request);
        try {
          // Revalidate like the page itself, so a fresh page never gets files from
          // the previous deploy out of the HTTP cache (GitHub Pages: max-age=600).
          return await fetch(request, { cache: 'no-cache' });
        } catch (err) {
          // Offline: the cached copy is the best we have.
          const cached = await fromCache();
          if (cached) return cached;
          throw err;
        }
      }
      // The app page: the network, unless it is too slow or unreachable.
      const network = fetch(request, { cache: 'no-cache' });
      network.catch(() => {}); // may fail after the cache already answered
      const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
      let response = null;
      try {
        response = await Promise.race([network, timeout]);
      } catch {
        response = null;
      }
      if (response) return response;
      const cached = await fromCache();
      if (!cached) return network;
      event.waitUntil(markOpenedFromCache(event.resultingClientId).catch(() => {}));
      return cached;
    })(),
  );
});
