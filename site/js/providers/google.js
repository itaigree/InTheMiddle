// Google Maps Platform provider: Places API (New), Routes API and Maps JavaScript API,
// all called from the browser through the Maps JS classes.
//
// Cost notes (free monthly allowance per SKU – see README):
// - Nearby Search is billed per call; asking for rating/opening hours makes it the
//   Enterprise SKU (1,000 free calls/month). One call per selected category.
// - Route Matrix is billed per origin×destination element (10,000 free/month), so
//   driving midpoints come from the route's own step durations and only the top
//   `maxCandidates` places get exact travel times.
// - Free-text lookup uses Text Search with only the place id (free) + Place Details
//   with Essentials fields; autocomplete sessions also end with Essentials fields.

import { ProviderUnavailableError, ProviderRequestError } from './errors.js';
import { timelineFromSteps } from '../core/geo.js';

const LANGUAGE = 'iw'; // Google's code for Hebrew
const REGION = 'il';
const ISRAEL_BOUNDS = { south: 29.45, west: 34.2, north: 33.35, east: 35.95 };
const LOAD_TIMEOUT_MS = 15000;

/** Place types (Table A) per category; requested as primary types unless noted. */
const CATEGORY_TYPES = {
  cafe: { primary: ['cafe', 'coffee_shop', 'bakery', 'ice_cream_shop', 'dessert_shop', 'tea_house'] },
  mall: { primary: ['shopping_mall'] },
  park: { primary: ['park', 'botanical_garden', 'garden', 'picnic_ground'] },
  nature: {
    primary: ['national_park', 'hiking_area', 'nature_preserve', 'scenic_spot', 'observation_deck', 'beach', 'lake', 'woods'],
  },
  // Restaurants have many specific primary types (italian_restaurant…), so match any type.
  food: { any: ['restaurant'] },
  attraction: { primary: ['tourist_attraction', 'museum', 'zoo', 'amusement_park', 'aquarium', 'wildlife_park'] },
};

/**
 * Types that have been in Table A for years. If Google rejects a request because a
 * newer type isn't recognised (INVALID_ARGUMENT), we retry with only these.
 */
const SAFE_TYPES = new Set([
  'cafe',
  'coffee_shop',
  'bakery',
  'ice_cream_shop',
  'restaurant',
  'shopping_mall',
  'park',
  'national_park',
  'hiking_area',
  'tourist_attraction',
  'museum',
  'zoo',
  'amusement_park',
  'aquarium',
]);

const PLACE_FIELDS = [
  'id',
  'displayName',
  'location',
  'primaryType',
  'primaryTypeDisplayName',
  'shortFormattedAddress',
  'googleMapsURI',
  'businessStatus',
  'photos',
  // Enterprise fields: what makes Google mode worth it.
  'rating',
  'userRatingCount',
  'regularOpeningHours',
];

// ------------------------------------------------------------------ loading

let loadPromise = null;
let authFailed = false;
const unavailableListeners = new Set();

function installAuthFailureHook() {
  const previous = window.gm_authFailure;
  window.gm_authFailure = () => {
    authFailed = true;
    window.__inthemiddleGoogleAuthFailed = true;
    const err = new ProviderUnavailableError('Google Maps rejected the API key', { reason: 'auth' });
    for (const fn of unavailableListeners) fn(err);
    if (typeof previous === 'function') previous();
  };
}

/** Google's dynamic library import bootstrap (https://developers.google.com/maps/documentation/javascript/load-maps-js-api). */
function installBootstrap(params) {
  /* eslint-disable */
  // prettier-ignore
  (g=>{var h,a,k,p="The Google Maps JavaScript API",c="google",l="importLibrary",q="__ib__",m=document,b=window;b=b[c]||(b[c]={});var d=b.maps||(b.maps={}),r=new Set,e=new URLSearchParams,u=()=>h||(h=new Promise(async(f,n)=>{await (a=m.createElement("script"));e.set("libraries",[...r]+"");for(k in g)e.set(k.replace(/[A-Z]/g,t=>"_"+t[0].toLowerCase()),g[k]);e.set("callback",c+".maps."+q);a.src=`https://maps.${c}apis.com/maps/api/js?`+e;d[q]=f;a.onerror=()=>h=n(Error(p+" could not load."));a.nonce=m.querySelector("script[nonce]")?.nonce||"";m.head.append(a)}));d[l]?console.warn(p+" only loads once. Ignoring:",g):d[l]=(f,...n)=>r.add(f)&&u().then(()=>d[l](f,...n))})(params);
  /* eslint-enable */
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function loadGoogle(apiKey) {
  if (!loadPromise) {
    installAuthFailureHook();
    installBootstrap({ key: apiKey, v: 'weekly', language: LANGUAGE, region: 'IL' });
    loadPromise = withTimeout(
      Promise.all(['core', 'places', 'routes'].map((lib) => google.maps.importLibrary(lib))),
      LOAD_TIMEOUT_MS,
      'Google Maps load timed out',
    ).then(([core, places, routes]) => ({ core, places, routes }));
    loadPromise.catch(() => {
      // The bootstrap only loads once per page, so a failure is final for this page view.
    });
  }
  return loadPromise;
}

// ------------------------------------------------------------------- errors

/** Map any Google error to ProviderUnavailableError (switch to OSM) or ProviderRequestError. */
export function classifyGoogleError(err) {
  if (err instanceof ProviderUnavailableError || err instanceof ProviderRequestError) return err;
  if (authFailed) return new ProviderUnavailableError('Google Maps rejected the API key', { reason: 'auth', cause: err });
  const text = `${err?.code ?? ''} ${err?.message ?? err ?? ''}`;
  if (/RESOURCE_EXHAUSTED|OVER_QUERY_LIMIT|OVER_DAILY_LIMIT|quota|rate.?limit|\b429\b/i.test(text)) {
    return new ProviderUnavailableError('Google quota exhausted', { reason: 'quota', cause: err });
  }
  if (
    /PERMISSION_DENIED|REQUEST_DENIED|UNAUTHENTICATED|API.?key|not authorized|has not been used|is disabled|are blocked|billing|RefererNotAllowed|ApiNotActivated|InvalidKey|\b40[13]\b/i.test(
      text,
    )
  ) {
    return new ProviderUnavailableError('Google denied the request', { reason: 'auth', cause: err });
  }
  if (/INVALID_ARGUMENT|INVALID_REQUEST/.test(text)) {
    return new ProviderRequestError(`Google rejected the request: ${err?.message ?? err}`, { cause: err });
  }
  // Server errors, network failures, timeouts: Google is unreachable right now.
  return new ProviderUnavailableError('Google is unreachable', { reason: 'load-failed', cause: err });
}

/** Run a Google call, retrying once on transient failures, and classify errors. */
async function call(fn) {
  if (authFailed) throw new ProviderUnavailableError('Google Maps rejected the API key', { reason: 'auth' });
  try {
    return await fn();
  } catch (first) {
    const classified = classifyGoogleError(first);
    if (!(classified instanceof ProviderUnavailableError && classified.reason === 'load-failed')) throw classified;
    await new Promise((r) => setTimeout(r, 600));
    try {
      return await fn();
    } catch (second) {
      throw classifyGoogleError(second);
    }
  }
}

// ------------------------------------------------------------------ helpers

const toLatLng = (p) => ({ lat: typeof p.lat === 'function' ? p.lat() : p.lat, lng: typeof p.lng === 'function' ? p.lng() : p.lng });

/**
 * Is the place open at `date`, from its weekly opening periods? Uses the viewer's
 * clock, which is right for Israeli places viewed in Israel.
 * @returns {boolean|null} null when unknown
 */
export function isOpenAt(openingHours, date = new Date()) {
  const periods = openingHours?.periods;
  if (!periods?.length) return null;
  const WEEK = 7 * 1440;
  const minutes = (day, hour, minute) => day * 1440 + hour * 60 + minute;
  const now = minutes(date.getDay(), date.getHours(), date.getMinutes());
  return periods.some(({ open, close }) => {
    if (!open) return false;
    if (!close) return true; // open 24/7
    const start = minutes(open.day, open.hour, open.minute);
    let end = minutes(close.day, close.hour, close.minute);
    if (end <= start) end += WEEK;
    return (now >= start && now < end) || (now + WEEK >= start && now + WEEK < end);
  });
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ----------------------------------------------------------------- provider

/**
 * @param {{apiKey: string, mapId?: string, onUnavailable?: (err: ProviderUnavailableError) => void}} options
 */
export function createGoogleProvider({ apiKey, mapId, onUnavailable }) {
  if (!apiKey) throw new ProviderUnavailableError('No Google Maps API key configured', { reason: 'not-configured' });
  if (onUnavailable) unavailableListeners.add(onUnavailable);

  let libs = null;
  let sessionToken = null;

  async function ready() {
    try {
      libs = await loadGoogle(apiKey);
    } catch (err) {
      throw classifyGoogleError(err);
    }
    if (authFailed) throw new ProviderUnavailableError('Google Maps rejected the API key', { reason: 'auth' });
  }

  async function ensureReady() {
    if (!libs) await ready();
    return libs;
  }

  async function suggest(query, { signal } = {}) {
    const { places } = await ensureReady();
    if (!sessionToken) sessionToken = new places.AutocompleteSessionToken();
    const token = sessionToken;
    const { suggestions } = await call(() =>
      places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: query,
        sessionToken: token,
        language: LANGUAGE,
        region: REGION,
        includedRegionCodes: ['il', 'ps'],
        locationBias: ISRAEL_BOUNDS,
      }),
    );
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return suggestions
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .slice(0, 6)
      .map((prediction) => {
        const title = prediction.mainText?.text || prediction.text?.text || '';
        return {
          title,
          subtitle: prediction.secondaryText?.text || '',
          resolve: async () => {
            const place = prediction.toPlace();
            // Essentials-only fields end the session at the cheapest tier.
            await call(() => place.fetchFields({ fields: ['location'] }));
            sessionToken = null; // the next search starts a new session
            return place.location ? { label: title, ...toLatLng(place.location) } : null;
          },
        };
      });
  }

  async function geocode(text) {
    const { places } = await ensureReady();
    // Text Search asking only for ids is free; then fetch the location (Essentials).
    const { places: found } = await call(() =>
      places.Place.searchByText({
        textQuery: text,
        fields: ['id'],
        maxResultCount: 1,
        language: LANGUAGE,
        region: REGION,
        locationBias: ISRAEL_BOUNDS,
      }),
    );
    const place = found?.[0];
    if (!place) return null;
    await call(() => place.fetchFields({ fields: ['location'] }));
    return place.location ? { label: text, ...toLatLng(place.location) } : null;
  }

  async function route(a, b) {
    const { routes } = await ensureReady();
    const { routes: found } = await call(() =>
      routes.Route.computeRoutes({
        origin: { lat: a.lat, lng: a.lng },
        destination: { lat: b.lat, lng: b.lng },
        travelMode: 'DRIVING',
        routingPreference: 'TRAFFIC_UNAWARE',
        fields: ['path', 'legs', 'distanceMeters', 'durationMillis'],
        language: LANGUAGE,
        region: REGION,
      }),
    );
    const best = found?.[0];
    if (!best) return null;
    const steps = (best.legs || []).flatMap((leg) => leg.steps || []);
    const built = timelineFromSteps(
      steps.map((s) => ({
        path: (s.path || []).map(toLatLng),
        durationSec: (s.staticDurationMillis ?? 0) / 1000,
      })),
    );
    const path = built.path.length >= 2 ? built.path : (best.path || []).map(toLatLng);
    return {
      path,
      timeline: built.path.length >= 2 ? built.timeline : undefined,
      distanceMeters: best.distanceMeters,
      durationSec: (best.durationMillis ?? 0) / 1000,
    };
  }

  async function travelTimes(origins, destinations, mode, { departure } = {}) {
    const { routes } = await ensureReady();
    const result = origins.map(() => new Array(destinations.length).fill(null));
    if (!destinations.length) return result;
    const transit = mode === 'transit';
    // Per request: origins × destinations ≤ 625, or ≤ 100 for transit.
    const maxElements = transit ? 100 : 625;
    const perChunk = Math.max(1, Math.floor(maxElements / origins.length));
    let offset = 0;
    for (const dests of chunk(destinations, perChunk)) {
      const request = {
        origins: origins.map((o) => ({ lat: o.lat, lng: o.lng })),
        destinations: dests.map((d) => ({ lat: d.lat, lng: d.lng })),
        travelMode: transit ? 'TRANSIT' : 'DRIVING',
        fields: ['durationMillis', 'condition'],
        language: LANGUAGE,
        region: REGION,
      };
      if (transit) request.departureTime = departure || new Date();
      else request.routingPreference = 'TRAFFIC_UNAWARE';
      const { matrix } = await call(() => routes.RouteMatrix.computeRouteMatrix(request));
      matrix.rows.forEach((row, i) => {
        row.items.forEach((item, j) => {
          if (item?.condition === 'ROUTE_EXISTS' && Number.isFinite(item.durationMillis)) {
            result[i][offset + j] = item.durationMillis / 1000;
          }
        });
      });
      offset += dests.length;
    }
    return result;
  }

  async function nearby(center, radius, spec) {
    const { places } = await ensureReady();
    const run = (types) =>
      places.Place.searchNearby({
        fields: PLACE_FIELDS,
        locationRestriction: { center: { lat: center.lat, lng: center.lng }, radius: Math.min(radius, 50000) },
        ...(spec.any ? { includedTypes: types } : { includedPrimaryTypes: types }),
        maxResultCount: 20,
        rankPreference: 'POPULARITY',
        language: LANGUAGE,
        region: REGION,
      });
    const types = spec.any || spec.primary;
    try {
      return (await call(() => run(types))).places || [];
    } catch (err) {
      const safe = types.filter((t) => SAFE_TYPES.has(t));
      if (err instanceof ProviderRequestError && safe.length && safe.length < types.length) {
        console.warn('Retrying nearby search with long-standing place types only', err);
        return (await call(() => run(safe))).places || [];
      }
      throw err;
    }
  }

  async function searchPlaces(center, radius, categoryIds) {
    const now = new Date();
    const lists = await Promise.all(
      categoryIds.filter((id) => CATEGORY_TYPES[id]).map(async (category) => {
        const found = await nearby(center, radius, CATEGORY_TYPES[category]);
        return found
          .filter((p) => p.location && p.displayName && (!p.businessStatus || p.businessStatus === 'OPERATIONAL'))
          .map((p) => {
            const photo = p.photos?.[0];
            const credit = photo?.authorAttributions?.[0];
            return {
              id: p.id,
              name: p.displayName,
              ...toLatLng(p.location),
              category,
              typeLabel: p.primaryTypeDisplayName || undefined,
              rating: Number.isFinite(p.rating) ? p.rating : undefined,
              ratingCount: Number.isFinite(p.userRatingCount) ? p.userRatingCount : undefined,
              openNow: isOpenAt(p.regularOpeningHours, now),
              address: p.shortFormattedAddress || undefined,
              mapsUrl: p.googleMapsURI || undefined,
              // Each photo shown is billed (Place Photos), so the UI only shows a few.
              photoUrl: photo ? photo.getURI({ maxWidth: 200, maxHeight: 200 }) : undefined,
              photoCredit: credit ? { name: credit.displayName, uri: credit.uri } : undefined,
              source: 'google',
            };
          });
      }),
    );
    return lists.flat();
  }

  async function createMap(container) {
    await ensureReady();
    const { createGoogleMapView } = await import('../ui/map-google.js');
    try {
      return await createGoogleMapView(container, {
        mapId,
        onError: (reason) => {
          const err = new ProviderUnavailableError(`Google map failed (${reason})`, { reason });
          for (const fn of unavailableListeners) fn(err);
        },
      });
    } catch (err) {
      throw classifyGoogleError(err);
    }
  }

  return {
    id: 'google',
    supportsTransit: true,
    maxCandidates: 16,
    attributionHtml: 'נתוני מפה ומקומות: Google',
    suggestFooter: 'Google Maps',
    ready,
    suggest,
    geocode,
    route,
    travelTimes,
    searchPlaces,
    createMap,
  };
}
