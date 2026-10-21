// Offline support for the app shell.
//
// Each deploy's worker precaches that deploy's files when it installs, and the
// cache is never updated at runtime, so it always holds one consistent version.
// A page is then served from ONE source: pages that load from the network fetch
// their files from the network (like without a worker); a page the network was
// too slow to open (or offline) is opened from the cache, and so are all of its
// files, from that same cache even after a newer deploy's worker takes over.
// Requests to other origins and non-GET requests are left alone.

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
      // Take over right away: a page opened from an older deploy's cache keeps
      // loading from that cache, which is kept while the page is open.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await deleteOlderCaches();
      await self.clients.claim();
    })(),
  );
});

/** How long a page load waits for the network before opening from the cache. */
const NETWORK_TIMEOUT_MS = 4000;

/**
 * Pages (clients) opened from a cache, and which cache: a marker in that cache,
 * and in memory, since the browser stops idle workers and memory doesn't survive
 * that. The marker holds the time it was written.
 */
const MARKERS = '__opened-from-cache/';
const clientMarker = (id) => new Request(`./${MARKERS}${encodeURIComponent(id)}`);
const cacheClients = new Map(); // client id -> cache name
/** A page that has just opened may not be listed among the open pages yet. */
const NEW_PAGE_GRACE_MS = 10000;

async function markOpenedFromCache(id) {
  if (!id) return;
  cacheClients.set(id, CACHE);
  const cache = await caches.open(CACHE);
  await cache.put(clientMarker(id), new Response(String(Date.now())));
}

const olderCacheNames = async () => (await caches.keys()).filter((n) => n.startsWith(PREFIX) && n !== CACHE);

/** The cache this page was opened from (this deploy's or an older one), or null. */
async function openedFromCache(id) {
  if (!id) return null;
  if (cacheClients.has(id)) return cacheClients.get(id);
  for (const cacheName of [CACHE, ...(await olderCacheNames())]) {
    if (await caches.match(clientMarker(id), { cacheName })) {
      cacheClients.set(id, cacheName);
      return cacheName;
    }
  }
  return null;
}

/**
 * Delete older deploys' caches, except ones an open page was opened from. Not
 * while a newer deploy's worker installs or waits: its cache isn't this one either.
 * On a page load, a cache any page was opened from stays until the next deploy
 * activates: a page in the back/forward cache isn't listed among the open pages,
 * and only an activation evicts it from there.
 */
async function deleteOlderCaches({ pageLoad = false } = {}) {
  const names = await olderCacheNames();
  if (!names.length) return;
  const pages = new Set((await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).map((c) => c.id));
  const unused = [];
  for (const name of names) {
    const cache = await caches.open(name);
    let used = false;
    for (const request of await cache.keys()) {
      const at = request.url.indexOf(MARKERS);
      if (at < 0) continue;
      const id = decodeURIComponent(request.url.slice(at + MARKERS.length));
      const written = Number(await (await cache.match(request))?.text());
      if (pageLoad || pages.has(id) || Date.now() - written < NEW_PAGE_GRACE_MS) {
        used = true;
        break;
      }
    }
    if (!used) unused.push(name);
  }
  if (self.registration.installing || self.registration.waiting) return;
  await Promise.all(unused.map((name) => caches.delete(name)));
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
  const fromCache = (cacheName = CACHE) => caches.match(cacheKey, { cacheName });
  // Clean up what an activation had to leave (a newer version was installing) or a failed install left.
  if (navigate) event.waitUntil(deleteOlderCaches({ pageLoad: true }).catch(() => {}));

  event.respondWith(
    (async () => {
      if (!navigate) {
        const cacheName = await openedFromCache(event.clientId);
        if (cacheName) return (await fromCache(cacheName)) || fetch(request);
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
      // Before answering: from then on, a newer deploy's worker keeps this cache.
      await markOpenedFromCache(event.resultingClientId).catch(() => {});
      return cached;
    })(),
  );
});
