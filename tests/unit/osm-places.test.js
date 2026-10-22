import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOsmProvider } from '../../site/js/providers/osm.js';

// Overpass busy or not, Photon's nearest places, sessionStorage and the clock, all faked.
function setup() {
  const store = new Map();
  globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const clock = { now: Date.parse('2026-10-21T12:00:00Z') };
  const realNow = Date.now;
  Date.now = () => clock.now;
  const calls = { overpass: 0, photon: [] };
  const state = { overpassUp: false, photonFails: new Set() };
  const realFetch = globalThis.fetch;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.host === 'overpass-api.de') {
      calls.overpass++;
      if (!state.overpassUp) return new Response('at capacity', { status: 502 });
      const tags = { amenity: 'cafe', name: 'קפה מ-Overpass', opening_hours: 'Su-Th 08:00-22:00; Fr 08:00-14:00' };
      return json({ elements: [{ type: 'node', id: 1, lat: 32.44, lon: 34.92, tags }] });
    }
    const tags = u.searchParams.getAll('osm_tag');
    calls.photon.push(tags.join('+'));
    if (tags.some((t) => state.photonFails.has(t))) return json({ message: 'busy' }, 503);
    const [key, value] = tags[0].split(':');
    return json({
      features: [0, 1].map((k) => ({
        geometry: { type: 'Point', coordinates: [34.92 + k * 0.001, 32.44] },
        properties: { osm_type: 'N', osm_id: 100 + k + 10 * calls.photon.length, osm_key: key, osm_value: value, name: `${value} ${k + 1}` },
      })),
    });
  };
  const restore = () => {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    delete globalThis.sessionStorage;
  };
  return { clock, calls, state, restore };
}

const MIN = 60 * 1000;

test('Overpass busy: Photon answers, is kept 5 minutes, and Overpass rests as long', async () => {
  const { clock, calls, state, restore } = setup();
  try {
    const osm = createOsmProvider();
    const at = { lat: 32.44, lng: 34.92 };
    let places = await osm.searchPlaces(at, 3000, ['cafe']);
    assert.deepEqual(places.map((p) => p.name), ['cafe 1', 'cafe 2']);
    assert.ok(places.every((p) => p.hoursUnknown && p.closedOnShabbat === null));
    assert.equal(calls.overpass, 1);

    state.overpassUp = true;
    clock.now += 1 * MIN;
    places = await osm.searchPlaces(at, 3000, ['cafe']); // the same search: kept
    assert.equal(places[0].name, 'cafe 1');
    await osm.searchPlaces(at, 6000, ['cafe']); // another one: Overpass is resting
    assert.equal(calls.overpass, 1);

    clock.now += 5 * MIN;
    places = await osm.searchPlaces(at, 3000, ['cafe']); // later: Overpass again, with hours
    assert.equal(calls.overpass, 2);
    assert.deepEqual(places.map((p) => [p.name, p.closedOnShabbat]), [['קפה מ-Overpass', true]]);
  } finally {
    restore();
  }
});

test('Photon: one failed group keeps the others, and the partial answer is not kept', async () => {
  const { calls, state, restore } = setup();
  try {
    state.photonFails.add('leisure:park');
    const osm = createOsmProvider();
    const at = { lat: 31.9, lng: 35.0 };
    const places = await osm.searchPlaces(at, 3000, ['cafe', 'park', 'nature']);
    const kinds = new Set(places.map((p) => p.category));
    assert.ok(kinds.has('cafe') && kinds.has('nature') && !kinds.has('park'));
    // Both nature groups were asked for, and their places alternate.
    const nature = places.filter((p) => p.category === 'nature').map((p) => p.name);
    assert.deepEqual(nature.map((n) => n.split(' ')[0]), ['viewpoint', 'nature_reserve', 'viewpoint', 'nature_reserve']);
    const asked = calls.photon.length;
    await osm.searchPlaces(at, 3000, ['cafe', 'park', 'nature']);
    assert.ok(calls.photon.length > asked); // not served from the cache
  } finally {
    restore();
  }
});
