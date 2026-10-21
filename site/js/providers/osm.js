// Free provider built on OpenStreetMap data and public services:
//   Photon (komoot) – search-as-you-type and free-text lookup
//   OSRM (FOSSGIS)  – driving routes and travel-time tables (max 1 request/second)
//   Transitous      – public transit travel times (open-source, non-commercial use)
//   Overpass API    – meeting places around the midpoint (cached, one query per search);
//                     when it is busy (often), Photon lists the places nearest the midpoint
// No key, no billing. These are community-run servers, so requests are kept few and
// small. Nominatim is deliberately not used: its policy forbids autocomplete.

import { ProviderRequestError, isAbortError } from './errors.js';
import { haversine } from '../core/geo.js';

const PHOTON_URL = 'https://photon.komoot.io/api/';
const PHOTON_REVERSE_URL = 'https://photon.komoot.io/reverse';
const OSRM_URLS = ['https://routing.openstreetmap.de/routed-car', 'https://router.project-osrm.org'];
const TRANSITOUS_URL = 'https://api.transitous.org/api/experimental/one-to-many-intermodal';
// The public Overpass servers are often at capacity: one short try, then Photon
// (trying other Overpass mirrors in turn kept people waiting for minutes).
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_TIMEOUT_MS = 12000;

/** Israel (and the West Bank), as west,south,east,north. */
const BBOX = [34.2, 29.45, 35.95, 33.35];
/** OSRM's demo server allows up to 100 coordinates per table request. */
const MAX_TABLE_COORDS = 100;
/** Transitous answers at most 128 destinations per one-to-many request. */
const MAX_TRANSIT_DESTINATIONS = 100;
const PLACES_PER_CATEGORY = 15;
const OVERPASS_CACHE_TTL_MS = 6 * 3600 * 1000;

/**
 * Overpass selectors per category, and a Hebrew label per tag value.
 * Every selector also requires a name, so anonymous benches and lawns stay out.
 */
/**
 * Overpass selectors per category, in groups that each get their own output
 * budget: e.g. nature's many small spots (viewpoints, springs) can't crowd out
 * its reserves and national parks, which are mapped as areas.
 */
const CATEGORY_QUERIES = {
  cafe: [['nwr["amenity"~"^(cafe|ice_cream)$"]']],
  mall: [['nwr["shop"="mall"]']],
  park: [['nwr["leisure"="park"]']],
  nature: [
    ['nwr["tourism"="viewpoint"]', 'nwr["natural"="spring"]', 'nwr["tourism"="picnic_site"]'],
    ['nwr["leisure"="nature_reserve"]', 'nwr["boundary"="national_park"]', 'nwr["natural"="beach"]'],
  ],
  food: [['nwr["amenity"="restaurant"]']],
  attraction: [['nwr["tourism"~"^(attraction|museum|zoo|theme_park|aquarium)$"]']],
};

/** The same categories as OSM tags, for Photon's nearest-places lookup. */
const PHOTON_TAGS = {
  cafe: ['amenity:cafe', 'amenity:ice_cream'],
  mall: ['shop:mall'],
  park: ['leisure:park'],
  nature: [
    'tourism:viewpoint',
    'natural:spring',
    'tourism:picnic_site',
    'leisure:nature_reserve',
    'boundary:national_park',
    'natural:beach',
  ],
  food: ['amenity:restaurant'],
  attraction: ['tourism:attraction', 'tourism:museum', 'tourism:zoo', 'tourism:theme_park', 'tourism:aquarium'],
};

/** Which category a place belongs to, in priority order (first match wins). */
const CATEGORY_RULES = [
  ['cafe', (t) => /^(cafe|ice_cream)$/.test(t.amenity)],
  ['mall', (t) => t.shop === 'mall'],
  ['food', (t) => t.amenity === 'restaurant'],
  [
    'nature',
    (t) =>
      t.tourism === 'viewpoint' ||
      t.leisure === 'nature_reserve' ||
      t.boundary === 'national_park' ||
      t.natural === 'spring' ||
      t.natural === 'beach' ||
      t.tourism === 'picnic_site',
  ],
  ['attraction', (t) => /^(attraction|museum|zoo|theme_park|aquarium)$/.test(t.tourism)],
  ['park', (t) => t.leisure === 'park'],
];

const TAG_LABELS = {
  'amenity=cafe': 'בית קפה',
  'amenity=ice_cream': 'גלידריה',
  'shop=mall': 'קניון',
  'leisure=park': 'פארק',
  'tourism=viewpoint': 'נקודת תצפית',
  'leisure=nature_reserve': 'שמורת טבע',
  'boundary=national_park': 'גן לאומי',
  'natural=spring': 'מעיין',
  'natural=beach': 'חוף',
  'tourism=picnic_site': 'אתר פיקניק',
  'amenity=restaurant': 'מסעדה',
  'tourism=attraction': 'אטרקציה',
  'tourism=museum': 'מוזיאון',
  'tourism=zoo': 'גן חיות',
  'tourism=theme_park': 'פארק שעשועים',
  'tourism=aquarium': 'אקווריום',
};

const TAG_KEYS = ['amenity', 'shop', 'leisure', 'tourism', 'boundary', 'natural'];

// ------------------------------------------------------------------ fetching

/** An AbortSignal that fires on the caller's signal or after `ms`, whichever is first. */
function timeoutSignal(signal, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function fetchJson(url, { signal, timeoutMs = 20000, ...init } = {}) {
  const { signal: combined, done } = timeoutSignal(signal, timeoutMs);
  const host = new URL(url).host;
  try {
    const response = await fetch(url, { ...init, signal: combined });
    if (!response.ok) {
      throw new ProviderRequestError(`${host} answered ${response.status}`, { status: response.status });
    }
    return await response.json();
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (err instanceof ProviderRequestError) throw err;
    throw new ProviderRequestError(`Request to ${host} failed: ${err?.message || err}`, { cause: err });
  } finally {
    done();
  }
}

/**
 * Serialises calls and keeps at least `gapMs` between their starts, for servers
 * whose policy caps the request rate (OSRM: 1 request/second).
 */
function rateLimited(gapMs) {
  let last = 0;
  let queue = Promise.resolve();
  return (fn) => {
    const run = queue.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    queue = run.catch(() => {});
    return run;
  };
}

const osrmGate = rateLimited(1000);

/** Try each mirror in turn; give up with a Hebrew message for the user. */
async function withMirrors(urls, fn, userMessage) {
  let lastError;
  for (const base of urls) {
    try {
      return await fn(base);
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
      console.warn(`${base} failed, trying the next server`, err);
    }
  }
  const err = new ProviderRequestError(lastError?.message || 'all servers failed', { cause: lastError });
  err.userMessage = userMessage;
  throw err;
}

// ------------------------------------------------------------------ geocoding

function photonLabel(props) {
  const parts = [];
  const add = (v) => {
    if (v && !parts.includes(v)) parts.push(v);
  };
  if (props.street) add(props.housenumber ? `${props.street} ${props.housenumber}` : props.street);
  add(props.district);
  add(props.city || props.town || props.village);
  add(props.state);
  return parts.filter((p) => p !== props.name).join(', ');
}

const photonCache = new Map();

async function photonSearch(query, { limit, signal }) {
  // lang=default returns OSM's local `name` (Hebrew in Israel). Without it Photon
  // follows Accept-Language and a he-IL browser gets English names; 'he' itself is
  // rejected (HTTP 400). Unknown parameters are rejected too, so keep to these.
  const params = new URLSearchParams({ q: query, limit: String(limit), lang: 'default', bbox: BBOX.join(',') });
  const url = `${PHOTON_URL}?${params}`;
  if (photonCache.size > 200) photonCache.clear();
  if (!photonCache.has(url)) {
    const pending = fetchJson(url, { signal, timeoutMs: 10000 });
    photonCache.set(url, pending);
    pending.catch(() => photonCache.delete(url));
  }
  const data = await photonCache.get(url);
  return (data.features || [])
    .filter((f) => f.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates))
    .map((f) => {
      const [lng, lat] = f.geometry.coordinates;
      const props = f.properties || {};
      const title = props.name || [props.street, props.housenumber].filter(Boolean).join(' ') || props.city || '';
      return { title, subtitle: photonLabel(props), lat, lng };
    })
    .filter((r) => r.title && Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

// -------------------------------------------------------------------- routing

const lngLat = (p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

async function osrmRoute(a, b) {
  return withMirrors(
    OSRM_URLS,
    async (base) => {
      const url = `${base}/route/v1/driving/${lngLat(a)};${lngLat(b)}?overview=full&geometries=geojson&annotations=duration`;
      const data = await osrmGate(() => fetchJson(url));
      if (data.code !== 'Ok' || !data.routes?.length) return null;
      const r = data.routes[0];
      const path = r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      const durations = (r.legs || []).flatMap((leg) => leg.annotation?.duration || []);
      let timeline;
      if (durations.length === path.length - 1) {
        timeline = [0];
        for (const d of durations) timeline.push(timeline[timeline.length - 1] + Math.max(0, d));
      }
      return { path, timeline, distanceMeters: r.distance, durationSec: r.duration };
    },
    'לא הצלחנו לחשב את הדרך כרגע. כדאי לנסות שוב בעוד דקה.',
  );
}

async function osrmTable(origins, destinations) {
  const result = origins.map(() => new Array(destinations.length).fill(null));
  const perChunk = Math.max(1, MAX_TABLE_COORDS - origins.length);
  for (let start = 0; start < destinations.length; start += perChunk) {
    const dests = destinations.slice(start, start + perChunk);
    const coords = [...origins, ...dests].map(lngLat).join(';');
    const sources = origins.map((_, i) => i).join(';');
    const targets = dests.map((_, j) => origins.length + j).join(';');
    const data = await withMirrors(
      OSRM_URLS,
      (base) =>
        osrmGate(() => fetchJson(`${base}/table/v1/driving/${coords}?sources=${sources}&destinations=${targets}&annotations=duration`)),
      'לא הצלחנו לחשב זמני נסיעה כרגע. כדאי לנסות שוב בעוד דקה.',
    );
    if (data.code !== 'Ok') throw new ProviderRequestError(`OSRM table: ${data.code}`);
    data.durations.forEach((row, i) => {
      row.forEach((sec, j) => {
        result[i][start + j] = Number.isFinite(sec) ? sec : null;
      });
    });
  }
  return result;
}

// -------------------------------------------------------------------- transit

const latSemiLng = (p) => `${p.lat.toFixed(6)};${p.lng.toFixed(6)}`;

/**
 * Public transit times from Transitous (MOTIS one-to-many-intermodal): the
 * fastest of the transit options and walking, or null when neither exists.
 */
export function parseOneToMany(data, count) {
  return Array.from({ length: count }, (_, i) => {
    const options = (data.transit_durations?.[i] || []).map((o) => o?.duration).filter(Number.isFinite);
    const walk = data.street_durations?.[i]?.duration;
    if (Number.isFinite(walk)) options.push(walk);
    return options.length ? Math.min(...options) : null;
  });
}

async function transitTimes(origins, destinations, departure) {
  const result = [];
  for (const origin of origins) {
    const row = new Array(destinations.length).fill(null);
    for (let start = 0; start < destinations.length; start += MAX_TRANSIT_DESTINATIONS) {
      const chunk = destinations.slice(start, start + MAX_TRANSIT_DESTINATIONS);
      const params = new URLSearchParams({
        one: latSemiLng(origin),
        many: chunk.map(latSemiLng).join(','),
        time: (departure || new Date()).toISOString(),
        maxTravelTime: '240', // minutes
        maxPreTransitTime: '1200', // seconds of walking to the first stop
        maxPostTransitTime: '1200',
        maxDirectTime: '1800', // walking the whole way, up to 30 minutes
      });
      const data = await fetchJson(`${TRANSITOUS_URL}?${params}`, { timeoutMs: 45000 });
      parseOneToMany(data, chunk.length).forEach((t, i) => {
        row[start + i] = t;
      });
    }
    result.push(row);
  }
  return result;
}

// --------------------------------------------------------------------- places

/**
 * Each selector group is output twice, each capped: once for an inner ring and
 * once for the whole circle. Overpass cuts a capped output in its storage order,
 * which is one corner of the circle – not the places nearest the center – so in
 * a dense city the inner ring is what keeps the closest places in the answer.
 */
export function buildOverpassQuery(center, radius, categoryIds) {
  const at = `${center.lat.toFixed(6)},${center.lng.toFixed(6)}`;
  const outer = Math.round(radius);
  // A fixed small ring always holds the very nearest places, a middle ring
  // scales with the trip, and the whole circle catches notable places further out.
  const rings = [...new Set([Math.min(radius, 600), Math.min(radius, Math.max(800, radius / 3)), radius].map(Math.round))];
  const blocks = [];
  for (const id of categoryIds) {
    for (const group of CATEGORY_QUERIES[id] || []) {
      const union = (r) => `(${group.map((sel) => `${sel}["name"](around:${r},${at});`).join('')})`;
      for (const r of rings) blocks.push(`${union(r)};out tags center qt ${r === outer ? 150 : 100};`);
    }
  }
  return `[out:json][timeout:25];${blocks.join('')}`;
}

/** The first category (in priority order) that the tags match among those asked for. */
function categoryOf(tags, wanted) {
  for (const [id, test] of CATEGORY_RULES) if (wanted.has(id) && test(tags)) return id;
  return null;
}

function typeLabelOf(tags) {
  for (const key of TAG_KEYS) {
    const label = TAG_LABELS[`${key}=${tags[key]}`];
    if (label) return label;
  }
  return undefined;
}

function addressOf(tags) {
  const street = tags['addr:street'] ? [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') : '';
  return [street, tags['addr:city']].filter(Boolean).join(', ') || undefined;
}

/**
 * OSM has no ratings, so rank by how "notable" a place looks (Wikidata entry,
 * website, opening hours) and then by distance from the midpoint.
 */
function notability(tags) {
  let score = 0;
  if (tags.wikidata || tags.wikipedia) score += 3;
  if (tags.website || tags['contact:website']) score += 1;
  if (tags.opening_hours) score += 1;
  if (tags['name:en']) score += 0.5;
  return score;
}

export function parseOverpass(data, center, categoryIds) {
  const wanted = new Set(categoryIds);
  const byCategory = new Map();
  const seen = new Set();
  for (const el of data.elements || []) {
    const tags = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    const name = tags['name:he'] || tags.name;
    const category = categoryOf(tags, wanted);
    const key = `${el.type}-${el.id}`;
    // The inner and outer rings overlap, so the same element can come twice.
    if (seen.has(key)) continue;
    seen.add(key);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || !category) continue;
    const place = {
      id: `osm-${el.type}-${el.id}`,
      name,
      lat,
      lng,
      category,
      typeLabel: typeLabelOf(tags),
      openNow: tags.opening_hours === '24/7' ? true : null,
      address: addressOf(tags),
      source: 'osm',
      rank: haversine(center, { lat, lng }) / 1000 - notability(tags),
    };
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(place);
  }
  const out = [];
  for (const list of byCategory.values()) {
    list.sort((x, y) => x.rank - y.rank);
    for (const { rank, ...place } of list.slice(0, PLACES_PER_CATEGORY)) out.push(place);
  }
  return out;
}

function cacheGet(key) {
  try {
    const hit = JSON.parse(sessionStorage.getItem(key));
    return hit && Date.now() - hit.t < OVERPASS_CACHE_TTL_MS ? hit.v : null;
  } catch {
    return null;
  }
}

function cacheSet(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value }));
  } catch {
    // Storage full or disabled: just don't cache.
  }
}

async function overpassPlaces(center, radius, categoryIds) {
  // Round the center (~100 m) so repeating a search reuses the cached answer:
  // Overpass asks apps to keep their load on the public servers small.
  const rounded = { lat: Math.round(center.lat * 1000) / 1000, lng: Math.round(center.lng * 1000) / 1000 };
  const query = buildOverpassQuery(rounded, radius, categoryIds);
  const cacheKey = `inthemiddle.overpass:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  let places;
  try {
    const json = await fetchJson(OVERPASS_URL, {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
      timeoutMs: OVERPASS_TIMEOUT_MS,
    });
    // Timeouts and out-of-memory come back as HTTP 200 with a `remark`.
    if (/error/i.test(json.remark || '')) throw new ProviderRequestError(`Overpass: ${json.remark}`);
    places = parseOverpass(json, rounded, categoryIds);
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.warn('Overpass failed, asking Photon for the nearest places', err);
    try {
      places = await photonPlaces(rounded, radius, categoryIds);
    } catch (photonErr) {
      const failed = new ProviderRequestError(`Overpass and Photon failed: ${photonErr.message}`, { cause: photonErr });
      failed.userMessage = 'שרת המקומות החינמי עמוס כרגע. כדאי לנסות שוב בעוד דקה.';
      throw failed;
    }
  }
  // Only the few places kept are cached: raw answers can be large.
  cacheSet(cacheKey, places);
  return places;
}

const OSM_TYPES = { N: 'node', W: 'way', R: 'relation' };

/**
 * The places of each category nearest the center, from Photon (one request per
 * category). Photon only gives a place's main tag, so they are shaped as Overpass
 * elements and ranked by parseOverpass, by distance.
 */
async function photonPlaces(center, radius, categoryIds) {
  const lists = await Promise.all(
    categoryIds
      .filter((id) => PHOTON_TAGS[id])
      .map(async (id) => {
        const params = new URLSearchParams({
          lat: center.lat.toFixed(5),
          lon: center.lng.toFixed(5),
          radius: String(Math.max(1, Math.ceil(radius / 1000))), // km
          limit: '30',
          lang: 'default', // OSM's local names (Hebrew), as in photonSearch
        });
        for (const tag of PHOTON_TAGS[id]) params.append('osm_tag', tag);
        const data = await fetchJson(`${PHOTON_REVERSE_URL}?${params}`, { timeoutMs: 12000 });
        return data.features || [];
      }),
  );
  const elements = lists.flat().map((f) => {
    const p = f.properties || {};
    const [lon, lat] = f.geometry?.coordinates || [];
    return {
      type: OSM_TYPES[p.osm_type] || p.osm_type,
      id: p.osm_id,
      lat,
      lon,
      tags: { name: p.name, [p.osm_key]: p.osm_value, 'addr:street': p.street, 'addr:housenumber': p.housenumber, 'addr:city': p.city },
    };
  });
  return parseOverpass({ elements }, center, categoryIds);
}

// ------------------------------------------------------------------- provider

export function createOsmProvider() {
  return {
    id: 'osm',
    supportsTransit: true,
    maxCandidates: 40,
    attributionHtml:
      '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · ' +
      'חיפוש: <a href="https://photon.komoot.io" target="_blank" rel="noopener">Photon</a> · ' +
      'ניתוב: <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noopener">OSRM (FOSSGIS)</a> · ' +
      'תחבורה ציבורית: <a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous ומקורותיו</a> · ' +
      'מקומות: <a href="https://overpass-api.de" target="_blank" rel="noopener">Overpass API</a> או Photon · ' +
      '<a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener">דיווח על טעות במפה</a>',
    suggestFooter: '© OpenStreetMap',

    async ready() {},

    async suggest(query, { signal } = {}) {
      const results = await photonSearch(query, { limit: 6, signal });
      return results.map((r) => ({
        title: r.title,
        subtitle: r.subtitle,
        resolve: async () => ({ label: r.title, lat: r.lat, lng: r.lng, source: 'osm' }),
      }));
    },

    async geocode(text) {
      try {
        const [first] = await photonSearch(text, { limit: 1 });
        return first ? { label: text, lat: first.lat, lng: first.lng, source: 'osm' } : null;
      } catch (err) {
        err.userMessage = 'שירות החיפוש החינמי לא זמין כרגע. כדאי לנסות שוב בעוד דקה.';
        throw err;
      }
    },

    route: (a, b) => osrmRoute(a, b),

    async travelTimes(origins, destinations, mode, { departure } = {}) {
      if (!destinations.length) return origins.map(() => []);
      return mode === 'transit' ? transitTimes(origins, destinations, departure) : osrmTable(origins, destinations);
    },

    searchPlaces: (center, radius, categoryIds) => overpassPlaces(center, radius, categoryIds),

    async createMap(container) {
      const { createLeafletMap } = await import('../ui/map-leaflet.js');
      return createLeafletMap(container);
    },
  };
}
