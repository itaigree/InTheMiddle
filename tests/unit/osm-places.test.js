import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOsmProvider } from '../../site/js/providers/osm.js';
import { findMiddle } from '../../site/js/core/search.js';

// Overpass busy or not, Photon's nearest places, sessionStorage and the clock, all faked.
function setup() {
  const store = new Map();
  // Like a browser's: full past `quota` characters of keys and values.
  const storage = { store, quota: Infinity, used: () => [...store].reduce((n, [k, v]) => n + k.length + v.length, 0) };
  globalThis.sessionStorage = {
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      const after = storage.used() - (store.has(k) ? k.length + store.get(k).length : 0) + k.length + String(v).length;
      if (after > storage.quota) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
  };
  const clock = { now: Date.parse('2026-10-21T12:00:00Z') };
  const realNow = Date.now;
  Date.now = () => clock.now;
  const calls = { overpass: 0, photon: [] };
  // elements: what Overpass answers when it's up (one café by default); photonCount: places per Photon answer.
  const state = { overpassUp: false, photonFails: new Set(), elements: null, photonCount: 2 };
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
      features: Array.from({ length: state.photonCount }, (_, k) => ({
        geometry: { type: 'Point', coordinates: [34.92 + k * 0.001, 32.44] },
        properties: { osm_type: 'N', osm_id: 100 + k + 1000 * calls.photon.length, osm_key: key, osm_value: value, name: `${value} ${k + 1}` },
      })),
    });
  };
  const restore = () => {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    delete globalThis.sessionStorage;
  };
  return { clock, calls, state, storage, restore };
}

const MIN = 60 * 1000;

test('Overpass busy: Photon answers, is kept 5 minutes, and Overpass rests as long', async () => {
  const { clock, calls, state, restore } = setup();
  try {
    const osm = createOsmProvider();
    const at = { lat: 32.44, lng: 34.92 };
    let places = await osm.searchPlaces(at, 3000, ['cafe']);
    assert.deepEqual(places.map((p) => p.name), ['cafe 1', 'cafe 2']);
    assert.ok(places.every((p) => p.hoursUnknown && p.closedOnShabbat === null && p.openNow === null));
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
    assert.equal(places[0].openNow, true); // Wednesday afternoon
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

test('Overpass: places come from the cache open or closed as of the search, not as of the first one', async () => {
  const { clock, calls, state, restore } = setup();
  try {
    clock.now = Date.parse('2026-10-21T18:30:00Z'); // a Wednesday, 21:30 in Israel
    state.overpassUp = true;
    const at = { lat: 32.47, lng: 34.95 };
    const osm = createOsmProvider();
    assert.equal((await osm.searchPlaces(at, 1500, ['cafe']))[0].openNow, true);
    clock.now += 60 * MIN; // 22:30: closed (Su-Th 08:00-22:00)
    assert.equal((await osm.searchPlaces(at, 1500, ['cafe']))[0].openNow, false);
    assert.equal(calls.overpass, 1); // the second from the cache
  } finally {
    restore();
  }
});

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

test('Overpass busy: the filter runs before Photon places are cut to 15 too', async () => {
  const { calls, state, restore } = setup();
  try {
    // Overpass busy or resting. Photon answers 30 cafés, nearest first; the filter
    // (say, the Green Line) leaves out the 15 nearest.
    state.photonCount = 30;
    const at = { lat: 32.44, lng: 34.92 };
    const beyondNearest15 = (p) => p.lng > at.lng + 14.5 * 0.001;
    const osm = createOsmProvider();
    const kept = await osm.searchPlaces(at, 3000, ['cafe'], { keep: beyondNearest15 });
    assert.deepEqual(kept.map((p) => p.name), Array.from({ length: 15 }, (_, i) => `cafe ${i + 16}`));
    // No filter: the 15 nearest, as before, from the same answer.
    const all = await osm.searchPlaces(at, 3000, ['cafe']);
    assert.deepEqual(all.map((p) => p.name), Array.from({ length: 15 }, (_, i) => `cafe ${i + 1}`));
    assert.equal(calls.photon.length, 1);
  } finally {
    restore();
  }
});

test('The filter only sees the places looked at before each category is full', async () => {
  const { clock, state, restore } = setup();
  try {
    clock.now += LATER;
    state.overpassUp = true;
    const at = { lat: 32.44, lng: 34.92 };
    state.elements = cafesNear(at, 21, 0);
    const osm = createOsmProvider();
    // The app's filter notes what it left out, for a notice: a place that could
    // never be shown (ranked past 15) must not count.
    const seen = [];
    const keep = (p) => {
      seen.push(p.name);
      return true;
    };
    await osm.searchPlaces(at, 1500, ['cafe'], { keep });
    assert.deepEqual(seen, Array.from({ length: 15 }, (_, i) => `קפה ${i + 1}`));
    // One left out: the 16th is looked at in its place, and no further.
    seen.length = 0;
    const places = await osm.searchPlaces(at, 1500, ['cafe'], { keep: (p) => keep(p) && p.name !== 'קפה 3' });
    assert.equal(places.length, 15);
    assert.deepEqual(seen, Array.from({ length: 16 }, (_, i) => `קפה ${i + 1}`));
  } finally {
    restore();
  }
});

test('Places cache: expired places and those of another version are dropped when places are kept', async () => {
  const { clock, state, storage, restore } = setup();
  try {
    clock.now += LATER;
    state.overpassUp = true;
    const now = clock.now;
    const entry = (t, ttl) => JSON.stringify({ t, ttl, v: [{ id: 'osm-node-9', name: 'ישן', lat: 32, lng: 35, category: 'cafe' }] });
    const current = 'inthemiddle.overpass.v4:';
    sessionStorage.setItem('inthemiddle.overpass.v3:old query', entry(now - MIN));
    sessionStorage.setItem(`${current}expired`, entry(now - 7 * 60 * MIN, 6 * 60 * MIN));
    sessionStorage.setItem(`${current}expired photon`, entry(now - 6 * MIN, 5 * MIN));
    sessionStorage.setItem(`${current}fresh`, entry(now - MIN, 6 * 60 * MIN));
    sessionStorage.setItem(`${current}unreadable`, '{');
    sessionStorage.setItem('inthemiddle.filters', '{"greenLine":true}');
    const osm = createOsmProvider();
    await osm.searchPlaces({ lat: 32.44, lng: 34.92 }, 3000, ['cafe']);
    const keys = [...storage.store.keys()];
    assert.deepEqual(keys.filter((k) => !k.startsWith(`${current}[out:json]`)), [`${current}fresh`, 'inthemiddle.filters']);
    assert.equal(keys.length, 3); // and the search just made
  } finally {
    restore();
  }
});

test('Places cache: when storage is full, the oldest places make room for the new', async () => {
  const { clock, calls, state, storage, restore } = setup();
  try {
    clock.now += LATER;
    state.overpassUp = true;
    const osm = createOsmProvider();
    const search = (lat) => osm.searchPlaces({ lat, lng: 34.92 }, 3000, ['cafe']);
    await search(32.401);
    storage.quota = Math.floor(storage.used() * 2.5); // room for two searches
    clock.now += MIN;
    await search(32.402);
    clock.now += MIN;
    await search(32.403); // full: the first search goes
    assert.equal(calls.overpass, 3);
    await search(32.403);
    await search(32.402);
    assert.equal(calls.overpass, 3); // both kept
    await search(32.401);
    assert.equal(calls.overpass, 4);
  } finally {
    restore();
  }
});

test('Places cache: storage that throws costs no places', async () => {
  const { clock, calls, state, restore } = setup();
  try {
    clock.now += LATER;
    state.overpassUp = true;
    const osm = createOsmProvider();
    const at = { lat: 32.44, lng: 34.92 };
    const fail = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    const failing = (works = {}) => ({ getItem: fail, setItem: fail, key: fail, removeItem: fail, ...works, get length() { return fail(); } });
    // Storage that can't be listed (or have items removed) still keeps the places.
    const { getItem, setItem } = globalThis.sessionStorage;
    globalThis.sessionStorage = failing({ getItem, setItem });
    assert.equal((await osm.searchPlaces(at, 3000, ['cafe'])).length, 1);
    assert.equal((await osm.searchPlaces(at, 3000, ['cafe'])).length, 1);
    assert.equal(calls.overpass, 1);
    // Storage that fails at everything: the places are found, just not kept.
    globalThis.sessionStorage = failing();
    assert.equal((await osm.searchPlaces(at, 6000, ['cafe'])).length, 1);
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
