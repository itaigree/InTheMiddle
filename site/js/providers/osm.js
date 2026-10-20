// Free provider built on OpenStreetMap data and public services:
//   Photon (komoot) – search-as-you-type and free-text lookup
//   OSRM            – driving routes and travel-time tables
//   Overpass API    – meeting places around the midpoint
// No key, no billing. These are community-run servers, so requests are kept small.

import { ProviderRequestError, isAbortError } from './errors.js';
import { haversine } from '../core/geo.js';

const PHOTON_URL = 'https://photon.komoot.io/api/';
const OSRM_URLS = ['https://router.project-osrm.org', 'https://routing.openstreetmap.de/routed-car'];
const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

/** Israel (and the West Bank), as west,south,east,north. */
const BBOX = [34.2, 29.45, 35.95, 33.35];
const CENTER = { lat: 31.8, lng: 35.0 };
/** OSRM's demo server allows up to 100 coordinates per table request. */
const MAX_TABLE_COORDS = 100;
const PLACES_PER_CATEGORY = 15;

/**
 * Overpass selectors per category, and a Hebrew label per tag value.
 * Every selector also requires a name, so anonymous benches and lawns stay out.
 */
const CATEGORY_QUERIES = {
  cafe: ['nwr["amenity"~"^(cafe|ice_cream)$"]'],
  mall: ['nwr["shop"="mall"]'],
  park: ['nwr["leisure"="park"]'],
  nature: [
    'nwr["tourism"="viewpoint"]',
    'nwr["leisure"="nature_reserve"]',
    'nwr["boundary"="national_park"]',
    'nwr["natural"="spring"]',
    'nwr["natural"="beach"]',
    'nwr["tourism"="picnic_site"]',
  ],
  food: ['nwr["amenity"="restaurant"]'],
  attraction: ['nwr["tourism"~"^(attraction|museum|zoo|theme_park|aquarium)$"]'],
};

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

async function photonSearch(query, { limit, signal }) {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    lat: String(CENTER.lat),
    lon: String(CENTER.lng),
    bbox: BBOX.join(','),
  });
  const data = await fetchJson(`${PHOTON_URL}?${params}`, { signal, timeoutMs: 10000 });
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
      const data = await fetchJson(url);
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
      (base) => fetchJson(`${base}/table/v1/driving/${coords}?sources=${sources}&destinations=${targets}&annotations=duration`),
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

// --------------------------------------------------------------------- places

/**
 * One output block per category, each capped, so a city center full of cafés
 * can't crowd the parks and viewpoints out of the response.
 */
export function buildOverpassQuery(center, radius, categoryIds) {
  const around = `(around:${Math.round(radius)},${center.lat.toFixed(6)},${center.lng.toFixed(6)})`;
  const blocks = categoryIds
    .filter((id) => CATEGORY_QUERIES[id])
    .map((id) => `(${CATEGORY_QUERIES[id].map((sel) => `${sel}["name"]${around};`).join('')});out tags center 150;`);
  return `[out:json][timeout:25];${blocks.join('')}`;
}

function categoryOf(tags) {
  const v = (k) => tags[k];
  if (/^(cafe|ice_cream)$/.test(v('amenity'))) return 'cafe';
  if (v('shop') === 'mall') return 'mall';
  if (v('amenity') === 'restaurant') return 'food';
  if (
    v('tourism') === 'viewpoint' ||
    v('leisure') === 'nature_reserve' ||
    v('boundary') === 'national_park' ||
    v('natural') === 'spring' ||
    v('natural') === 'beach' ||
    v('tourism') === 'picnic_site'
  ) {
    return 'nature';
  }
  if (/^(attraction|museum|zoo|theme_park|aquarium)$/.test(v('tourism'))) return 'attraction';
  if (v('leisure') === 'park') return 'park';
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
  for (const el of data.elements || []) {
    const tags = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    const name = tags['name:he'] || tags.name;
    const category = categoryOf(tags);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || !category || !wanted.has(category)) continue;
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

async function overpassPlaces(center, radius, categoryIds) {
  const query = buildOverpassQuery(center, radius, categoryIds);
  const data = await withMirrors(
    OVERPASS_URLS,
    (url) =>
      fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ data: query }).toString(),
        timeoutMs: 35000,
      }),
    'שרת המקומות החינמי עמוס כרגע. כדאי לנסות שוב בעוד דקה.',
  );
  return parseOverpass(data, center, categoryIds);
}

// ------------------------------------------------------------------- provider

export function createOsmProvider() {
  return {
    id: 'osm',
    supportsTransit: false,
    maxCandidates: 40,
    attributionHtml:
      '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · ' +
      'חיפוש: <a href="https://photon.komoot.io" target="_blank" rel="noopener">Photon</a> · ' +
      'ניתוב: <a href="https://project-osrm.org" target="_blank" rel="noopener">OSRM</a> · ' +
      'מקומות: <a href="https://overpass-api.de" target="_blank" rel="noopener">Overpass API</a>',
    suggestFooter: '© OpenStreetMap',

    async ready() {},

    async suggest(query, { signal } = {}) {
      const results = await photonSearch(query, { limit: 6, signal });
      return results.map((r) => ({
        title: r.title,
        subtitle: r.subtitle,
        resolve: async () => ({ label: r.title, lat: r.lat, lng: r.lng }),
      }));
    },

    async geocode(text) {
      try {
        const [first] = await photonSearch(text, { limit: 1 });
        return first ? { label: text, lat: first.lat, lng: first.lng } : null;
      } catch (err) {
        err.userMessage = 'שירות החיפוש החינמי לא זמין כרגע. כדאי לנסות שוב בעוד דקה.';
        throw err;
      }
    },

    route: (a, b) => osrmRoute(a, b),

    async travelTimes(origins, destinations, mode) {
      if (mode !== 'car') throw new ProviderRequestError('The OpenStreetMap provider has no transit routing');
      return osrmTable(origins, destinations);
    },

    searchPlaces: (center, radius, categoryIds) => overpassPlaces(center, radius, categoryIds),

    async createMap(container) {
      const { createLeafletMap } = await import('../ui/map-leaflet.js');
      return createLeafletMap(container);
    },
  };
}
