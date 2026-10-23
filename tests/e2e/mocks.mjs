// Network mocks for end-to-end tests: OpenStreetMap services (Photon, OSRM,
// Overpass, tiles) and a fake Google Maps JavaScript API.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PLACES = {
  חיפה: { name: 'חיפה', lat: 32.794, lng: 34.9896, state: 'מחוז חיפה' },
  'תל אביב': { name: 'תל אביב-יפו', lat: 32.0853, lng: 34.7818, state: 'מחוז תל אביב' },
  'באר שבע': { name: 'באר שבע', lat: 31.2518, lng: 34.7913, state: 'מחוז הדרום' },
  ירושלים: { name: 'ירושלים', lat: 31.7784, lng: 35.2066, state: 'מחוז ירושלים' },
};

function haversine(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const SPEED = 20; // m/s

function lookup(q) {
  const key = Object.keys(PLACES).find((k) => q.includes(k) || k.includes(q));
  return key ? PLACES[key] : null;
}

const json = (body, status = 200) => ({
  status,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});

/** Points along the straight line a→b. */
function line(a, b, n = 20) {
  return Array.from({ length: n + 1 }, (_, i) => ({ lat: a.lat + ((b.lat - a.lat) * i) / n, lng: a.lng + ((b.lng - a.lng) * i) / n }));
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Install OSM mocks on a Playwright page/context. Returns a log of requests per service.
 * `failOverpass: true` makes every Overpass mirror answer 504; `failPhotonPlaces: true`
 * makes Photon's nearest-places lookup answer 503; `failTransit: true` makes
 * Transitous answer 500; `noTransitService: true` returns no connections;
 * `emptyWithin: meters` makes Overpass find nothing in searches up to that radius.
 */
export async function mockOsm(
  target,
  { failOverpass = false, failPhotonPlaces = false, failTransit = false, noTransitService = false, emptyWithin = 0 } = {},
) {
  const log = { photon: [], photonPlaces: [], osrmRoute: [], osrmTable: [], overpass: [], transit: [] };
  // OSM ids per tag, so places of different kinds never share an id (as in OSM).
  const tagIds = new Map();
  const idBase = (tag) => {
    if (!tagIds.has(tag)) tagIds.set(tag, 5000 + 100 * tagIds.size);
    return tagIds.get(tag);
  };

  await target.route('https://photon.komoot.io/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/reverse')) {
      // Nearest places of the asked OSM tags around lat/lon.
      const tags = url.searchParams.getAll('osm_tag');
      log.photonPlaces.push(tags.join(','));
      if (failPhotonPlaces) {
        route.fulfill(json({ message: 'unavailable' }, 503));
        return;
      }
      const lat = Number(url.searchParams.get('lat'));
      const lng = Number(url.searchParams.get('lon'));
      const features = tags.slice(0, 1).flatMap((tag, t) => {
        const [key, value] = tag.split(':');
        return [0, 1, 2].map((k) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng + (k - 1) * 0.003, lat + t * 0.002 + 0.001] },
          properties: { osm_type: 'N', osm_id: idBase(tag) + k, osm_key: key, osm_value: value, name: `${value} ${k + 1}` },
        }));
      });
      route.fulfill(json({ type: 'FeatureCollection', features }));
      return;
    }
    const q = url.searchParams.get('q') || '';
    log.photon.push(q);
    if (url.searchParams.get('lang') !== 'default') {
      route.fulfill(json({ message: 'test mock: expected lang=default' }, 400));
      return;
    }
    const hit = lookup(q);
    const features = hit
      ? [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [hit.lng, hit.lat] },
            properties: { name: hit.name, state: hit.state, country: 'ישראל', osm_key: 'place', osm_value: 'city' },
          },
        ]
      : [];
    route.fulfill(json({ type: 'FeatureCollection', features }));
  });

  const osrm = (route) => {
    const url = new URL(route.request().url());
    const coords = url.pathname
      .split('/')
      .pop()
      .split(';')
      .map((c) => {
        const [lng, lat] = c.split(',').map(Number);
        return { lat, lng };
      });
    if (url.pathname.includes('/route/')) {
      log.osrmRoute.push(url.pathname + url.search);
      // Straight lines through every point (the start, any via points, the end).
      const pts = coords.slice(1).flatMap((c, i) => line(coords[i], c).slice(i ? 1 : 0));
      const durations = pts.slice(1).map((p, i) => haversine(pts[i], p) / SPEED);
      const distance = durations.reduce((sum, d) => sum + d, 0) * SPEED;
      route.fulfill(
        json({
          code: 'Ok',
          routes: [
            {
              distance,
              duration: distance / SPEED,
              geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lng, p.lat]) },
              legs: [{ annotation: { duration: durations } }],
            },
          ],
        }),
      );
      return;
    }
    log.osrmTable.push(url.pathname);
    const sources = url.searchParams.get('sources').split(';').map(Number);
    const destinations = url.searchParams.get('destinations').split(';').map(Number);
    route.fulfill(
      json({
        code: 'Ok',
        durations: sources.map((s) => destinations.map((d) => haversine(coords[s], coords[d]) / SPEED)),
      }),
    );
  };
  await target.route('https://router.project-osrm.org/**', osrm);
  await target.route('https://routing.openstreetmap.de/**', osrm);

  const overpass = (route) => {
    const body = new URLSearchParams(route.request().postData() || '').get('data') || '';
    log.overpass.push(body);
    if (failOverpass) {
      route.fulfill({ status: 504, body: 'Gateway Timeout', headers: { 'access-control-allow-origin': '*' } });
      return;
    }
    const m = body.match(/around:(\d+),([\d.]+),([\d.]+)/);
    const center = { lat: Number(m[2]), lng: Number(m[3]) };
    const elements = [];
    const radius = Math.max(...[...body.matchAll(/around:(\d+)/g)].map((r) => Number(r[1])));
    if (radius <= emptyWithin) {
      route.fulfill(json({ version: 0.6, elements }));
      return;
    }
    const add = (tags, k) => {
      const i = elements.length;
      elements.push({
        type: 'node',
        id: 1000 + i,
        lat: center.lat + ((k % 3) - 1) * 0.004,
        lon: center.lng + (Math.floor(k / 3) - 1) * 0.004,
        tags,
      });
    };
    for (let k = 0; k < 5; k++) {
      // Cafes 1–2 close for Shabbat, cafe 3 is open on Saturday, cafes 4–5 have no hours.
      const hours = ['Su-Th 07:00-23:00; Fr 07:00-14:00; Sa off', 'Su-Th 08:00-22:00; Fr 08:00-15:00', 'Mo-Su 08:00-23:00'][k];
      if (body.includes('"amenity"~"^(cafe|ice_cream)$"')) add({ amenity: 'cafe', name: `קפה ${k + 1}`, ...(hours && { opening_hours: hours }) }, k);
      if (body.includes('"shop"="mall"') && k < 2) add({ shop: 'mall', name: `קניון ${k + 1}`, website: 'x' }, k + 3);
      if (body.includes('"leisure"="park"')) add({ leisure: 'park', name: `פארק ${k + 1}` }, k + 1);
      if (body.includes('"tourism"="viewpoint"') && k < 3) add({ tourism: 'viewpoint', name: `תצפית ${k + 1}` }, k + 2);
    }
    route.fulfill(json({ version: 0.6, elements }));
  };
  await target.route('https://overpass-api.de/**', overpass);
  await target.route('https://overpass.private.coffee/**', overpass);

  await target.route('https://api.transitous.org/**', (route) => {
    const url = new URL(route.request().url());
    log.transit.push(url.searchParams.toString());
    if (failTransit) {
      route.fulfill(json({ error: 'internal error' }, 500));
      return;
    }
    const [lat, lng] = url.searchParams.get('one').split(';').map(Number);
    const many = url.searchParams
      .get('many')
      .split(',')
      .map((p) => {
        const [mlat, mlng] = p.split(';').map(Number);
        return { lat: mlat, lng: mlng };
      });
    const TRANSIT_SPEED = 12;
    route.fulfill(
      json({
        street_durations: many.map(() => ({})),
        transit_durations: many.map((m) =>
          noTransitService ? [] : [{ duration: Math.round(haversine({ lat, lng }, m) / TRANSIT_SPEED / 60) * 60, transfers: 1 }],
        ),
      }),
    );
  });

  await target.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: TINY_PNG }),
  );
  return log;
}

/**
 * Serve a fake Google Maps JS API (tests/e2e/fake-google-maps.js) instead of the real one.
 * `options` are exposed to it as window.__fakeGoogleOptions.
 */
export async function mockGoogle(target, options = {}) {
  const source = await fs.readFile(path.join(HERE, 'fake-google-maps.js'), 'utf8');
  const log = { scripts: [] };
  await target.route('https://maps.googleapis.com/maps/api/js**', (route) => {
    log.scripts.push(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: `window.__fakeGoogleOptions = ${JSON.stringify(options)};\n${source}`,
    });
  });
  return log;
}

/** Abort every other external request so tests never depend on the network. */
export async function blockExternal(target, allowedOrigins) {
  await target.route(
    (url) => !allowedOrigins.some((o) => url.href.startsWith(o)),
    (route) => route.abort('blockedbyclient'),
  );
}
