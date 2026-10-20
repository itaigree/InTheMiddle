import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMiddle, selectCandidates, MAX_CANDIDATES } from '../../site/js/core/search.js';
import { haversine } from '../../site/js/core/geo.js';
import { ProviderUnavailableError } from '../../site/js/providers/errors.js';

const HAIFA = { label: 'חיפה', lat: 32.794, lng: 34.9896 };
const TLV = { label: 'תל אביב', lat: 32.0853, lng: 34.7818 };

/**
 * A fake provider where travel time is straight-line distance over a speed, and
 * places sit on a grid around whatever center is searched.
 */
function fakeProvider({
  speedA = 20,
  speedB = 20,
  transit = true,
  transitWorks = true,
  failPlaces = false,
  placesPerCategory = 5,
  timeline = null,
  maxCandidates,
} = {}) {
  const calls = { route: 0, travelTimes: [], searchPlaces: [] };
  return {
    id: 'fake',
    supportsTransit: transit,
    maxCandidates,
    calls,
    async route(a, b) {
      calls.route++;
      const route = { path: [a, b], distanceMeters: haversine(a, b) * 1.2, durationSec: haversine(a, b) / 20 };
      if (timeline) {
        // A 3-vertex path whose first half (by distance) takes `timeline[1]` of `timeline[2]` seconds.
        route.path = [a, { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }, b];
        route.timeline = timeline;
      }
      return route;
    },
    async travelTimes(origins, destinations, mode) {
      calls.travelTimes.push({ origins: origins.length, destinations: destinations.length, mode });
      return origins.map((o) =>
        destinations.map((d) => {
          if (mode === 'transit' && !transitWorks) return null;
          const speed = o.lat === HAIFA.lat ? speedA : speedB;
          return haversine(o, d) / speed;
        }),
      );
    },
    async searchPlaces(center, radius, categories) {
      calls.searchPlaces.push({ center, radius, categories });
      if (failPlaces) throw new ProviderUnavailableError('quota', { reason: 'quota' });
      const out = [];
      for (const category of categories) {
        for (let i = 0; i < placesPerCategory; i++) {
          out.push({
            id: `${category}-${i}`,
            name: `${category} ${i}`,
            category,
            lat: center.lat + (i - 2) * 0.01,
            lng: center.lng + (i % 2 ? 0.01 : -0.01),
            source: 'fake',
          });
        }
      }
      return out;
    },
  };
}

const baseQuery = { a: HAIFA, b: TLV, modeA: 'car', modeB: 'car', categories: ['cafe', 'park'], departure: null };

test('equal speeds put the midpoint halfway and rank places by fairness', async () => {
  const provider = fakeProvider();
  const steps = [];
  const result = await findMiddle(baseQuery, provider, { onProgress: (s) => steps.push(s) });
  assert.deepEqual(steps, ['route', 'balance', 'places', 'times']);
  assert.ok(result.balance.reliable);
  assert.ok(Math.abs(result.balance.fraction - 0.5) < 0.01);
  assert.equal(result.places.length, 10);
  for (let i = 1; i < result.places.length; i++) {
    assert.ok(result.places[i - 1].score <= result.places[i].score);
  }
  // Same mode on both sides → one batched call per stage.
  assert.equal(provider.calls.travelTimes.length, 2);
  assert.equal(provider.calls.travelTimes[0].origins, 2);
});

test('a faster side gets the midpoint pushed toward the slower side', async () => {
  const result = await findMiddle(baseQuery, fakeProvider({ speedA: 30, speedB: 10 }));
  // A (Haifa) is 3x faster, so the meeting point is 3/4 of the way to Tel Aviv.
  assert.ok(Math.abs(result.balance.fraction - 0.75) < 0.02, `fraction ${result.balance.fraction}`);
});

test('mixed modes query each side separately', async () => {
  const provider = fakeProvider();
  const result = await findMiddle({ ...baseQuery, modeB: 'transit' }, provider);
  assert.equal(result.modeB, 'transit');
  const modes = provider.calls.travelTimes.map((c) => c.mode).sort();
  assert.deepEqual(modes, ['car', 'car', 'transit', 'transit']);
  assert.ok(provider.calls.travelTimes.every((c) => c.origins === 1));
});

test('providers without transit fall back to driving with a notice', async () => {
  const result = await findMiddle({ ...baseQuery, modeA: 'transit' }, fakeProvider({ transit: false }));
  assert.equal(result.modeA, 'car');
  assert.ok(result.notices.includes('transit-unsupported'));
});

test('no transit service (e.g. Shabbat) switches that side to driving', async () => {
  const result = await findMiddle({ ...baseQuery, modeB: 'transit' }, fakeProvider({ transitWorks: false }));
  assert.equal(result.modeB, 'car');
  assert.ok(result.notices.includes('transit-no-service'));
  assert.ok(result.places.length > 0);
});

test('too few places widens the search once', async () => {
  const provider = fakeProvider({ placesPerCategory: 2 });
  const result = await findMiddle({ ...baseQuery, categories: ['cafe'] }, provider);
  assert.equal(provider.calls.searchPlaces.length, 2);
  assert.equal(provider.calls.searchPlaces[1].radius, provider.calls.searchPlaces[0].radius * 2);
  assert.equal(result.radius, provider.calls.searchPlaces[1].radius);
});

test('provider unavailability propagates so the app can switch providers', async () => {
  await assert.rejects(findMiddle(baseQuery, fakeProvider({ failPlaces: true })), ProviderUnavailableError);
});

test('route failure falls back to a straight line', async () => {
  const provider = fakeProvider();
  provider.route = async () => {
    throw new Error('boom');
  };
  const result = await findMiddle(baseQuery, provider);
  assert.equal(result.route, null);
  assert.ok(result.places.length > 0);
});

test('selectCandidates takes categories round-robin up to the cap', () => {
  const places = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, category: 'cafe' })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, category: 'park' })),
  ];
  const picked = selectCandidates(places, 6);
  assert.deepEqual(
    picked.map((p) => p.id),
    ['c0', 'p0', 'c1', 'p1', 'c2', 'p2'],
  );
  assert.equal(selectCandidates(places, MAX_CANDIDATES).length, 33);
  assert.deepEqual(selectCandidates([], 5), []);
});

test('driving on both sides uses the route timeline and no matrix calls for sampling', async () => {
  // The first half of the route takes 3000 s, the second half 1000 s: equal time is
  // at 2000 s, i.e. 1/3 of the way through the first half (fraction 1/3 by distance).
  const provider = fakeProvider({ timeline: [0, 3000, 4000] });
  const result = await findMiddle(baseQuery, provider);
  assert.ok(result.balance.reliable);
  assert.ok(Math.abs(result.balance.fraction - 1 / 3) < 0.01, `fraction ${result.balance.fraction}`);
  assert.ok(Math.abs(result.balance.time - 2000) < 1);
  // Only the candidates' travel times were queried.
  assert.equal(provider.calls.travelTimes.length, 1);
});

test('mixed modes with a timeline query only the transit side for sampling', async () => {
  const provider = fakeProvider({ timeline: [0, 2000, 4000] });
  await findMiddle({ ...baseQuery, modeB: 'transit' }, provider);
  const sampling = provider.calls.travelTimes.slice(0, 1);
  assert.deepEqual(sampling, [{ origins: 1, destinations: 8, mode: 'transit' }]);
});

test('an invalid timeline is ignored', async () => {
  const provider = fakeProvider({ timeline: [0, 5000, 4000] });
  const result = await findMiddle(baseQuery, provider);
  assert.ok(Math.abs(result.balance.fraction - 0.5) < 0.02);
  assert.equal(provider.calls.travelTimes.length, 2);
});

test('provider maxCandidates limits the travel-time query', async () => {
  const provider = fakeProvider({ maxCandidates: 6, placesPerCategory: 10 });
  const result = await findMiddle(baseQuery, provider);
  assert.equal(result.places.length, 6);
  assert.equal(provider.calls.travelTimes.at(-1).destinations, 6);
});
