# Providers

A provider supplies everything that depends on a map/data service. The app ships two:

- `google.js` – Google Maps Platform (default when an API key is configured)
- `osm.js` – free OpenStreetMap-based services (fallback, and the mode used with no key)

`main.js` loads one lazily, and if Google throws `ProviderUnavailableError` (quota used
up, key rejected, SDK failed to load) it remembers that (see `core/availability.js`),
switches to the OSM provider and retries the same operation.

## Contract

```js
const provider = createXxxProvider(options);

provider.id               // 'google' | 'osm'
provider.supportsTransit  // boolean – can travelTimes() take mode 'transit'?
provider.attributionHtml  // footer attribution (trusted static HTML)
provider.suggestFooter    // short plain-text attribution under autocomplete suggestions

await provider.ready()    // load SDKs; throws ProviderUnavailableError if unusable

// Autocomplete while typing. Biased to Israel, Hebrew results.
await provider.suggest(query, { signal })
//   -> [{ title, subtitle?, resolve: () => Promise<{label, lat, lng} | null> }]

// Free text -> best match, or null when nothing matches.
await provider.geocode(text)            // -> {label, lat, lng} | null

// Driving route between two points, for drawing and for sampling the midpoint.
await provider.route(a, b, { departure })
//   -> { path: [{lat, lng}, ...], distanceMeters, durationSec } | null

// Travel-time matrix in seconds; null where there is no route.
await provider.travelTimes(origins, destinations, mode, { departure })
//   origins/destinations: [{lat, lng}], mode: 'car' | 'transit'
//   -> number|null [origins.length][destinations.length]
//   Chunk internally to respect the service's per-request limits.

// Meeting places around a point, for the category ids in core/categories.js.
await provider.searchPlaces(center, radiusMeters, categoryIds)
//   -> Place[], best-first within each category (popularity/quality)

// Map view (Google content must be shown on a Google map, per Google's terms).
// `overview`: the corner box for the small zoomed-out map (see MapView).
await provider.createMap(containerElement, { overview })   // -> MapView
```

`departure` is a `Date` or `null` (leave now).

### Place

```js
{
  id: string,             // stable and unique across categories
  name: string,
  lat: number, lng: number,
  category: string,       // one of core/categories.js ids
  typeLabel?: string,     // Hebrew type label, e.g. 'בית קפה'
  rating?: number,        // 1..5
  ratingCount?: number,
  openNow?: boolean|null, // null/undefined = unknown
  address?: string,
  photoUrl?: string,
  mapsUrl?: string,       // link to the place on Google Maps, if known
  source: 'google'|'osm',
}
```

### MapView

```js
view.kind                                  // 'google' | 'leaflet'
view.showSearch({ a, b, route, midpoint, radius })  // route: [{lat,lng}] | null
view.showPlaces(places, { numbering, onSelect })    // numbering: Map(placeId -> n)
view.highlight(placeId, { focus })   // focus: zoom in on the place
view.showAll()                       // zoom out to the whole search
view.resize()
view.destroy()
```

While the view is zoomed in past the whole search (the two points and the places),
it shows the `overview` box: a small map of the whole search with a frame around
what the big map shows. Tapping the box calls `showAll()`.

### Errors

- `ProviderUnavailableError(message, { reason })` — switch providers. `reason` is
  `'quota' | 'auth' | 'not-configured' | 'load-failed'`.
- `ProviderRequestError` — a failed request that switching wouldn't fix. Set
  `err.userMessage` (Hebrew) when there's something useful to tell the user.
- Abort errors from `signal` must propagate unchanged.
