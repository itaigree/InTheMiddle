import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOsmProvider } from '../../site/js/providers/osm.js';
import { findMiddle } from '../../site/js/core/search.js';

// Overpass busy or not, Photon's nearest places, sessionStorage and the clock, all faked.
function setup() {
  const store = new Map();
  globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const clock = { now: Date.parse('2026-10-21T12:00:00Z') };
  const realNow = Date.now;
  Date.now = () => clock.now;
  const calls = { overpass: 0, photon: [] };
  // elements: what Overpass answers when it's up (one café by default).
  const state = { overpassUp: false, photonFails: new Set(), elements: null };
  const realFetch = globalThis.fetch;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.host === 'overpass-api.de') {
      calls.overpass++;
      if (!state.overpassUp) return new Response('at capacity', { status: 502 });
      const tags = { amenity: 'cafe', name: 'קפה מ-Overpass', opening_hours: 'Su-Th 08:00-22:00; Fr 08:00-14:00' };
      return json({ elements: state.elements || [{ type: 'node', id: 1, lat: 32.44, lon: 34.92, tags }] });
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

// Overpass rests for 5 minutes after the busy answers in the tests above.
const LATER = 60 * MIN;

/** Cafés north of `at`, nearest first: the first `open` are open on Shabbat, the next `closed` close for it. */
function cafesNear(at, open, closed) {
  return Array.from({ length: open + closed }, (_, i) => ({
    type: 'node',
    id: 200 + i,
    lat: at.lat + (i + 1) * 0.0002,
    lon: at.lng,
    tags: { amenity: 'cafe', name: `קפה ${i + 1}`, opening_hours: i < open ? 'Mo-Su 07:00-23:00' : 'Su-Th 07:00-23:00; Fr 07:00-14:00; Sa off' },
  }));
}

const keepsShabbat = (p) => p.closedOnShabbat === true; // the "closed on Shabbat" filter, for cafés

test('Overpass: the filter runs before each category is cut to 15', async () => {
  const { clock, calls, state, restore } = setup();
  try {
    clock.now += LATER;
    state.overpassUp = true;
    const at = { lat: 32.44, lng: 34.92 };
    state.elements = cafesNear(at, 20, 5);
    const osm = createOsmProvider();
    // No filter: the 15 best, as before.
    const all = await osm.searchPlaces(at, 1500, ['cafe']);
    assert.deepEqual(all.map((p) => p.name), Array.from({ length: 15 }, (_, i) => `קפה ${i + 1}`));
    const kept = await osm.searchPlaces(at, 1500, ['cafe'], { keep: keepsShabbat });
    assert.deepEqual(kept.map((p) => p.name), ['קפה 21', 'קפה 22', 'קפה 23', 'קפה 24', 'קפה 25']);
    assert.equal(calls.overpass, 1); // the second from the cache, which keeps more than 15
  } finally {
    restore();
  }
});

test('A search with the Shabbat filter finds the cafés that close for it beyond the nearest 15', async () => {
  const { clock, calls, restore } = setup();
  try {
    clock.now += LATER;
    const overpassAndPhoton = globalThis.fetch;
    const json = (body) => new Response(JSON.stringify(body));
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.host === 'overpass-api.de') {
        // Around the middle searched: 20 cafés open on Shabbat, and 10 further out that close for it.
        const [lat, lng] = init.body.get('data').match(/around:\d+,([\d.]+),([\d.]+)/).slice(1).map(Number);
        calls.overpass++;
        return json({ elements: cafesNear({ lat, lng }, 20, 10) });
      }
      if (u.host === 'photon.komoot.io') return overpassAndPhoton(url, init);
      clock.now += 1000; // OSRM takes a request a second: keep to that on the fake clock
      if (u.pathname.includes('/route/')) {
        const [from, to] = u.pathname.split('/').pop().split(';').map((p) => p.split(',').map(Number));
        const coordinates = Array.from({ length: 21 }, (_, i) => from.map((v, k) => v + ((to[k] - v) * i) / 20));
        return json({ code: 'Ok', routes: [{ distance: 20000, duration: 1200, geometry: { coordinates }, legs: [{ annotation: { duration: Array(20).fill(60) } }] }] });
      }
      const [sources, targets] = ['sources', 'destinations'].map((k) => u.searchParams.get(k).split(';'));
      return json({ code: 'Ok', durations: sources.map(() => targets.map(() => 600)) });
    };
    const a = { label: 'א', lat: 32.08, lng: 34.7 };
    const b = { label: 'ב', lat: 32.08, lng: 34.9 };
    const query = { a, b, modeA: 'car', modeB: 'car', categories: ['cafe'], departure: null, placeFilter: keepsShabbat };
    const res = await findMiddle(query, createOsmProvider());
    assert.deepEqual(res.places.map((p) => p.name).sort(), Array.from({ length: 10 }, (_, i) => `קפה ${i + 21}`).sort());
    assert.equal(calls.overpass, 1); // found in the first circle, without widening
  } finally {
    restore();
  }
});

test('Overpass: a place whose hours have a line break costs no other place', async () => {
  const { clock, calls, state, restore } = setup();
  try {
    clock.now += LATER;
    state.overpassUp = true;
    const cafe = (id, hours) => ({ type: 'node', id, lat: 32.44 + id * 0.001, lon: 34.92, tags: { amenity: 'cafe', name: `קפה ${id}`, opening_hours: hours } });
    state.elements = [cafe(1, 'Su-Th 08:00-22:00; Fr 08:00-14:00'), cafe(2, 'Su-Th 08:00-22:00\nFr 08:00-14:00')];
    const osm = createOsmProvider();
    const at = { lat: 32.44, lng: 34.92 };
    const places = await osm.searchPlaces(at, 3000, ['cafe']);
    assert.deepEqual(places.map((p) => [p.name, p.closedOnShabbat]), [['קפה 1', true], ['קפה 2', null]]);
    assert.deepEqual(calls.photon, []);
    // Nor is Overpass made to rest: the next search asks it again.
    await osm.searchPlaces(at, 6000, ['cafe']);
    assert.equal(calls.overpass, 2);
  } finally {
    restore();
  }
});

test('Suggestions: asking again right after cancelling the same lookup gets an answer', async () => {
  const realFetch = globalThis.fetch;
  let requests = 0;
  // Photon answers after 20 ms, or fails at once when the request is cancelled.
  globalThis.fetch = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      requests++;
      const answer = { features: [{ geometry: { type: 'Point', coordinates: [34.98, 32.79] }, properties: { name: 'חיפה' } }] };
      const timer = setTimeout(() => resolve(new Response(JSON.stringify(answer))), 20);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      });
    });
  try {
    const osm = createOsmProvider();
    const first = new AbortController();
    const cancelled = osm.suggest('חיפה', { signal: first.signal });
    // The user typed a space: the lookup is cancelled, and the same one asked for at once.
    first.abort();
    const second = new AbortController();
    const again = osm.suggest('חיפה', { signal: second.signal });
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.deepEqual((await again).map((r) => r.title), ['חיפה']);
    assert.equal(requests, 2);
    // A lookup that finished is still kept, even when its caller cancels later.
    second.abort();
    await osm.suggest('חיפה', {});
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
