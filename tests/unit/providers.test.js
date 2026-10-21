import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOverpass, buildOverpassQuery } from '../../site/js/providers/osm.js';
import { isOpenAt, classifyGoogleError } from '../../site/js/providers/google.js';
import { ProviderUnavailableError, ProviderRequestError } from '../../site/js/providers/errors.js';

const CENTER = { lat: 32.4, lng: 34.9 };

test('buildOverpassQuery: one capped block per known category', () => {
  const q = buildOverpassQuery(CENTER, 2500.4, ['park', 'nope', 'mall']);
  assert.match(q, /^\[out:json\]\[timeout:25\];/);
  assert.equal(q.match(/out tags center qt 150;/g).length, 2);
  assert.match(q, /nwr\["leisure"="park"\]\["name"\]\(around:2500,32\.400000,34\.900000\);/);
  assert.match(q, /nwr\["shop"="mall"\]/);
});

test('parseOverpass: categories, Hebrew names, centers, ranking and filtering', () => {
  const data = {
    elements: [
      { type: 'node', id: 1, lat: 32.401, lon: 34.9, tags: { amenity: 'cafe', name: 'Cafe Far', 'name:he': 'קפה רחוק' } },
      { type: 'node', id: 2, lat: 32.4001, lon: 34.9, tags: { amenity: 'cafe', name: 'קפה קרוב' } },
      {
        type: 'node',
        id: 3,
        lat: 32.41,
        lon: 34.9,
        tags: { amenity: 'cafe', name: 'קפה מפורסם', wikidata: 'Q1', website: 'x', opening_hours: '24/7' },
      },
      { type: 'way', id: 4, center: { lat: 32.405, lon: 34.905 }, tags: { leisure: 'park', name: 'פארק', 'addr:city': 'נתניה' } },
      { type: 'relation', id: 5, center: { lat: 32.39, lon: 34.91 }, tags: { boundary: 'national_park', name: 'גן לאומי' } },
      { type: 'node', id: 6, lat: 32.4, lon: 34.9, tags: { amenity: 'cafe' } }, // no name
      { type: 'node', id: 7, lat: 32.4, lon: 34.9, tags: { amenity: 'restaurant', name: 'מסעדה' } }, // not requested
      { type: 'way', id: 8, tags: { shop: 'mall', name: 'no center' } },
    ],
  };
  const places = parseOverpass(data, CENTER, ['cafe', 'park', 'nature', 'mall']);
  const byId = Object.fromEntries(places.map((p) => [p.id, p]));
  assert.deepEqual(Object.keys(byId).sort(), ['osm-node-1', 'osm-node-2', 'osm-node-3', 'osm-relation-5', 'osm-way-4']);
  assert.equal(byId['osm-node-1'].name, 'קפה רחוק');
  assert.equal(byId['osm-way-4'].lat, 32.405);
  assert.equal(byId['osm-way-4'].address, 'נתניה');
  assert.equal(byId['osm-relation-5'].category, 'nature');
  assert.equal(byId['osm-relation-5'].typeLabel, 'גן לאומי');
  assert.equal(byId['osm-node-3'].openNow, true);
  assert.equal(byId['osm-node-2'].openNow, null);
  // Within cafés: the notable one (Wikidata etc.) beats a closer plain one, which beats a farther one.
  const cafes = places.filter((p) => p.category === 'cafe').map((p) => p.id);
  assert.deepEqual(cafes, ['osm-node-3', 'osm-node-2', 'osm-node-1']);
  assert.ok(places.every((p) => !('rank' in p)));
});

test('parseOverpass caps each category', () => {
  const elements = Array.from({ length: 30 }, (_, i) => ({
    type: 'node',
    id: i,
    lat: 32.4 + i * 0.001,
    lon: 34.9,
    tags: { leisure: 'park', name: `פארק ${i}` },
  }));
  assert.equal(parseOverpass({ elements }, CENTER, ['park']).length, 15);
  assert.deepEqual(parseOverpass({}, CENTER, ['park']), []);
});

test('isOpenAt handles normal, overnight and 24/7 schedules', () => {
  // Sunday=0. Open Sun 08:00–22:00.
  const daytime = { periods: [{ open: { day: 0, hour: 8, minute: 0 }, close: { day: 0, hour: 22, minute: 0 } }] };
  assert.equal(isOpenAt(daytime, new Date(2026, 9, 18, 12, 0)), true); // Sun 18 Oct 2026, 12:00
  assert.equal(isOpenAt(daytime, new Date(2026, 9, 18, 23, 0)), false);
  // Sat 20:00 → Sun 02:00 (wraps the week).
  const overnight = { periods: [{ open: { day: 6, hour: 20, minute: 0 }, close: { day: 0, hour: 2, minute: 0 } }] };
  assert.equal(isOpenAt(overnight, new Date(2026, 9, 18, 1, 0)), true); // Sunday 01:00
  assert.equal(isOpenAt(overnight, new Date(2026, 9, 17, 21, 0)), true); // Saturday 21:00
  assert.equal(isOpenAt(overnight, new Date(2026, 9, 17, 19, 0)), false);
  assert.equal(isOpenAt({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] }), true);
  assert.equal(isOpenAt(null), null);
  assert.equal(isOpenAt({ periods: [] }), null);
});

test('classifyGoogleError maps quota, auth, bad requests and outages', () => {
  const quota = classifyGoogleError(Object.assign(new Error('PLACES_NEARBY_SEARCH: RESOURCE_EXHAUSTED: Quota exceeded'), { code: 'RESOURCE_EXHAUSTED' }));
  assert.ok(quota instanceof ProviderUnavailableError);
  assert.equal(quota.reason, 'quota');

  const routesQuota = classifyGoogleError(new Error('Quota exceeded for quota metric ComputeRouteMatrix'));
  assert.equal(routesQuota.reason, 'quota');

  const denied = classifyGoogleError(Object.assign(new Error('x'), { code: 'PERMISSION_DENIED' }));
  assert.equal(denied.reason, 'auth');
  assert.equal(classifyGoogleError(new Error('Routes API has not been used in project 123')).reason, 'auth');

  const bad = classifyGoogleError(new Error('PLACES_NEARBY_SEARCH: INVALID_ARGUMENT: Unsupported types: woods'));
  assert.ok(bad instanceof ProviderRequestError);

  const outage = classifyGoogleError(new TypeError('Failed to fetch'));
  assert.ok(outage instanceof ProviderUnavailableError);
  assert.equal(outage.reason, 'load-failed');

  // Autocomplete reports gRPC numbers on an RpcError, e.g. invalid key / quota.
  const rpc = (code, message) => Object.assign(new Error(message), { name: 'RpcError', code });
  assert.equal(classifyGoogleError(rpc(3, 'API key not valid. Please pass a valid API key.')).reason, 'auth');
  assert.equal(classifyGoogleError(rpc(8, 'Too many requests')).reason, 'quota');
  assert.equal(classifyGoogleError(rpc(7, 'denied')).reason, 'auth');
  assert.ok(classifyGoogleError(rpc(3, 'Invalid included_primary_types')) instanceof ProviderRequestError);
  // The real invalid-key error from Places/Routes uses INVALID_ARGUMENT, but it's a key problem.
  const invalidKey = Object.assign(
    new Error('ROUTES_COMPUTE_ROUTE_MATRIX: INVALID_ARGUMENT: API key not valid. Please pass a valid API key.'),
    { code: 'INVALID_ARGUMENT', endpoint: 'ROUTES_COMPUTE_ROUTE_MATRIX' },
  );
  assert.equal(classifyGoogleError(invalidKey).reason, 'auth');

  const already = new ProviderRequestError('x');
  assert.equal(classifyGoogleError(already), already);
});

test('parseOneToMany takes the fastest of transit options and walking', async () => {
  const { parseOneToMany } = await import('../../site/js/providers/osm.js');
  const data = {
    transit_durations: [[{ duration: 1800, transfers: 0 }, { duration: 1500, transfers: 2 }], [], []],
    street_durations: [{ duration: 4000 }, { duration: 600 }, {}],
  };
  assert.deepEqual(parseOneToMany(data, 3), [1500, 600, null]);
  assert.deepEqual(parseOneToMany({}, 2), [null, null]);
});

test('buildOverpassQuery adds a capped inner ring and splits nature into points and areas', () => {
  const q = buildOverpassQuery(CENTER, 6000, ['nature']);
  // Two groups (points, areas) × three rings (600 m, 2 km, 6 km).
  assert.equal(q.match(/out tags center qt 100;/g).length, 4);
  assert.equal(q.match(/out tags center qt 150;/g).length, 2);
  assert.match(q, /around:600,/);
  assert.match(q, /around:2000,/);
  // Rings that coincide are not repeated.
  const small = buildOverpassQuery(CENTER, 500, ['cafe']);
  assert.equal((small.match(/out tags center qt/g) || []).length, 1);
  const mid = buildOverpassQuery(CENTER, 800, ['cafe']);
  assert.equal((mid.match(/out tags center qt/g) || []).length, 2);
});

test('parseOverpass: inner/outer duplicates once; categories follow the selection', () => {
  const park = { type: 'way', id: 9, center: { lat: 32.4, lon: 34.9 }, tags: { leisure: 'park', tourism: 'attraction', name: 'פארק הירקון' } };
  const data = { elements: [park, park] };
  // 'attraction' not selected: the park still counts as a park.
  const parks = parseOverpass(data, CENTER, ['park']);
  assert.deepEqual(parks.map((p) => [p.id, p.category]), [['osm-way-9', 'park']]);
  // Both selected: the higher-priority category wins, once.
  const both = parseOverpass(data, CENTER, ['park', 'attraction']);
  assert.deepEqual(both.map((p) => p.category), ['attraction']);
});
