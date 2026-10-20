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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch (err) {
        const navigate = request.mode === 'navigate';
        const cached = (await cache.match(request, { ignoreSearch: navigate })) || (navigate ? await cache.match('./') : undefined);
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});
