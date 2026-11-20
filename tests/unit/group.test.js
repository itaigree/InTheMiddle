import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGroupMiddle, enclosingCircle, ringAround, fairestPoint, MAX_POINTS } from '../../site/js/core/group.js';
import { haversine, offsetMeters, metersFrom } from '../../site/js/core/geo.js';
import { rerankPlaces } from '../../site/js/core/ranking.js';
import { prepare, beyondGreenLine } from '../../site/js/core/green-line.js';
import { ProviderUnavailableError, ProviderRequestError } from '../../site/js/providers/errors.js';

const CENTRE = { lat: 32.4, lng: 35.0 };
/** Three people 30 km from CENTRE, evenly around it. */
const TRIANGLE = ringAround(CENTRE, 30000, 3).map((p, i) => ({ label: `נקודה ${i + 1}`, ...p }));
const TLV = { label: 'תל אביב', lat: 32.0853, lng: 34.7818 };
const RAMAT_GAN = { label: 'רמת גן', lat: 32.0823, lng: 34.8106 };
const BEER_SHEVA = { label: 'באר שבע', lat: 31.2518, lng: 34.7913 };
const HAIFA = { label: 'חיפה', lat: 32.794, lng: 34.9896 };

const key = (p) => `${p.lat},${p.lng}`;

/**
 * Travel time is straight-line distance over a speed (m/s, per starting point),
 * and places sit on a grid around whatever center is searched.
 */
function fakeProvider({
  speeds = new Map(), // key(point) -> m/s; default 20
  transitSpeed = null, // m/s for transit (default: the side's speed)
  transit = true,
  transitWorks = true,
  transitThrows = null, // 'always', or a number: transit calls from this one on throw
  unreachableFrom = null, // a point nobody can drive from
  placesPerCategory = 5,
  maxCandidates,
  failPlaces = false,
} = {}) {
  const calls = { travelTimes: [], searchPlaces: [] };
  let transitCalls = 0;
  return {
    id: 'fake',
    supportsTransit: transit,
    maxCandidates,
    calls,
    async route() {
      throw new Error('a group search does not ask for a route');
    },
    async travelTimes(origins, destinations, mode) {
      calls.travelTimes.push({ origins: origins.length, destinations: destinations.length, mode });
      if (mode === 'transit') {
        transitCalls++;
        if (transitThrows === 'always' || (typeof transitThrows === 'number' && transitCalls >= transitThrows)) {
          throw new ProviderRequestError('transit server down');
        }
      }
      return origins.map((o) =>
        destinations.map((d) => {
          if (mode === 'transit' && !transitWorks) return null;
          if (unreachableFrom && key(o) === key(unreachableFrom)) return null;
          const speed = mode === 'transit' && transitSpeed ? transitSpeed : speeds.get(key(o)) || 20;
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

const baseQuery = { points: TRIANGLE, categories: ['cafe', 'park'], departure: null };

/** A square of the "beyond the Green Line" kind, `half` meters each way from `center`. */
function squareAround(center, half) {
  const sw = offsetMeters(center, -half, -half);
  const ne = offsetMeters(center, half, half);
  return prepare([
    [
      [
        [sw.lng, sw.lat],
        [ne.lng, sw.lat],
        [ne.lng, ne.lat],
        [sw.lng, ne.lat],
        [sw.lng, sw.lat],
      ],
    ],
  ]);
}

// ---------------------------------------------------------------- geometry

test('offsetMeters and metersFrom undo each other', () => {
  const p = offsetMeters(CENTRE, 12345, -6789);
  const back = metersFrom(CENTRE, p);
  assert.ok(Math.abs(back.east - 12345) < 1e-6);
  assert.ok(Math.abs(back.north + 6789) < 1e-6);
  assert.ok(Math.abs(haversine(CENTRE, p) - Math.hypot(12345, 6789)) < 30);
});

test('ringAround spreads points evenly at the radius', () => {
  const ring = ringAround(CENTRE, 10000, 6);
  assert.equal(ring.length, 6);
  for (const p of ring) assert.ok(Math.abs(haversine(CENTRE, p) - 10000) < 30);
  // The first point is due north.
  assert.ok(ring[0].lat > CENTRE.lat && Math.abs(ring[0].lng - CENTRE.lng) < 1e-9);
});

test('enclosingCircle: two points give the circle across them', () => {
  const { center, radius } = enclosingCircle([TLV, BEER_SHEVA]);
  assert.ok(Math.abs(haversine(center, TLV) - haversine(center, BEER_SHEVA)) < 50);
  assert.ok(Math.abs(radius - haversine(TLV, BEER_SHEVA) / 2) < 100);
});

test('enclosingCircle: three points around a centre give that centre', () => {
  const { center, radius } = enclosingCircle(TRIANGLE);
  assert.ok(haversine(center, CENTRE) < 100, `${haversine(center, CENTRE)} m off`);
  assert.ok(Math.abs(radius - 30000) < 100);
});

test('enclosingCircle: a point inside the widest pair does not move the circle', () => {
  // Tel Aviv and Ramat Gan are close together; the circle spans them to Be'er Sheva.
  const { center, radius } = enclosingCircle([TLV, RAMAT_GAN, BEER_SHEVA]);
  for (const p of [TLV, RAMAT_GAN, BEER_SHEVA]) assert.ok(haversine(center, p) <= radius + 50);
  // The middle of the circle is about halfway down, not a third of the way like the average point.
  const half = haversine(TLV, BEER_SHEVA) / 2;
  assert.ok(Math.abs(haversine(center, BEER_SHEVA) - half) < 2000);
});

test('enclosingCircle: everyone in one place is a circle of no size there', () => {
  const { center, radius } = enclosingCircle([TLV, TLV, TLV]);
  assert.ok(haversine(center, TLV) < 1);
  assert.ok(radius < 1);
});

test('fairestPoint picks the fairest point everyone can reach', () => {
  const rows = [
    [600, 1200, 900, 300],
    [600, 1200, 900, null],
    [2400, 1200, 900, 300],
  ];
  // Point 0 has a big gap, point 3 is out of reach for side 2: 1 and 2 are even, 2 is shorter.
  assert.equal(fairestPoint(rows, 4), 2);
  assert.equal(fairestPoint([[null], [600]], 1), -1);
});

test('fairestPoint never picks a point where everyone travels longer', () => {
  // Point 1 has the smaller gap, but all three trips there are longer than at point 0.
  const rows = [
    [72 * 60, 77 * 60],
    [10 * 60, 41 * 60],
    [72 * 60, 80 * 60],
  ];
  assert.equal(fairestPoint(rows, 2), 0);
  // The same longest trip: the one where the others travel less wins.
  assert.equal(fairestPoint([[600, 600], [600, 300]], 2), 1);
});

// ------------------------------------------------------------- the search

test('people around a point meet at that point, and places carry everyone\'s times', async () => {
  const provider = fakeProvider();
  const steps = [];
  const result = await findGroupMiddle(baseQuery, provider, { onProgress: (s) => steps.push(s) });
  assert.deepEqual(steps, ['balance', 'places', 'times']);
  assert.equal(result.group, true);
  assert.equal(result.route, null);
  assert.ok(result.balance.reliable);
  assert.ok(haversine(result.midpoint, CENTRE) < 100, `${haversine(result.midpoint, CENTRE)} m off`);
  assert.ok(Math.abs(result.balance.time - 30000 / 20) < 5);
  assert.equal(result.places.length, 10);
  for (const p of result.places) {
    assert.equal(p.times.length, 3);
    assert.equal(p.diff, Math.max(...p.times) - Math.min(...p.times));
  }
  for (let i = 1; i < result.places.length; i++) assert.ok(result.places[i - 1].score <= result.places[i].score);
  // No route: never asked for.
  assert.deepEqual(result.modes, ['car', 'car', 'car']);
});

test('a pair close together and one far away meet about halfway, not at the average point', async () => {
  const result = await findGroupMiddle({ ...baseQuery, points: [TLV, RAMAT_GAN, BEER_SHEVA] }, fakeProvider());
  const toTlv = haversine(result.midpoint, TLV);
  const toBeerSheva = haversine(result.midpoint, BEER_SHEVA);
  assert.ok(Math.abs(toTlv - toBeerSheva) < 0.1 * (toTlv + toBeerSheva), `${toTlv} vs ${toBeerSheva}`);
});

test('one person between the others: the middle does not move to where everyone travels further', async () => {
  // Tel Aviv between Haifa and Be'er Sheva: away from the circle's centre, Tel Aviv's
  // trip grows faster than the others', which a "smaller gap" measure would reward.
  const points = [HAIFA, TLV, BEER_SHEVA];
  const result = await findGroupMiddle({ ...baseQuery, points }, fakeProvider());
  const { center } = enclosingCircle(points);
  const toMiddle = points.map((p) => haversine(p, result.midpoint));
  const toCentre = points.map((p) => haversine(p, center));
  assert.ok(!toMiddle.every((d, i) => d > toCentre[i]), `${toMiddle} vs ${toCentre}`);
  // The centre was timed too: the longest trip is no longer than there.
  assert.ok(Math.max(...toMiddle) <= Math.max(...toCentre) + 1, `${Math.max(...toMiddle)} vs ${Math.max(...toCentre)}`);
});

test('a slower side pulls the middle toward it', async () => {
  const slow = TRIANGLE[0];
  const result = await findGroupMiddle(baseQuery, fakeProvider({ speeds: new Map([[key(slow), 10]]) }));
  // Half the speed: the trips even out about 11.5 km from the centre toward the slow side.
  const toSlow = haversine(result.midpoint, slow);
  assert.ok(toSlow < 22000, `${toSlow} m from the slow side`);
  for (const other of TRIANGLE.slice(1)) assert.ok(toSlow < haversine(result.midpoint, other) - 10000);
  // At the plain centre the slow side would take 25 minutes longer; here, minutes at most.
  const times = TRIANGLE.map((p, i) => haversine(p, result.midpoint) / (i === 0 ? 10 : 20));
  assert.ok(Math.max(...times) - Math.min(...times) < 300);
});

test('everyone driving: one travel-time request per stage, all sides together', async () => {
  const provider = fakeProvider();
  await findGroupMiddle(baseQuery, provider);
  assert.deepEqual(
    provider.calls.travelTimes.map((c) => [c.origins, c.destinations, c.mode]),
    [
      [3, 7, 'car'], // the centre and the first ring
      [3, 6, 'car'], // the tighter ring
      [3, 10, 'car'], // the places
    ],
  );
});

test('mixed modes: one request per mode', async () => {
  const provider = fakeProvider();
  const result = await findGroupMiddle({ ...baseQuery, modes: ['car', 'transit', 'car'] }, provider);
  assert.deepEqual(result.modes, ['car', 'transit', 'car']);
  const first = provider.calls.travelTimes.filter((c) => c.destinations === 7);
  assert.deepEqual(first.map((c) => [c.mode, c.origins]).sort(), [
    ['car', 2],
    ['transit', 1],
  ]);
});

test('providers without transit make everyone drive, with a notice', async () => {
  const result = await findGroupMiddle({ ...baseQuery, modes: ['transit', 'car', 'transit'] }, fakeProvider({ transit: false }));
  assert.deepEqual(result.modes, ['car', 'car', 'car']);
  assert.ok(result.notices.includes('transit-unsupported'));
});

test('no transit service (e.g. Shabbat) switches that side to driving', async () => {
  const provider = fakeProvider({ transitWorks: false });
  const result = await findGroupMiddle({ ...baseQuery, modes: ['car', 'transit', 'car'] }, provider);
  assert.deepEqual(result.modes, ['car', 'car', 'car']);
  assert.ok(result.notices.includes('transit-no-service'));
  assert.ok(result.places.length > 0);
  assert.ok(haversine(result.midpoint, CENTRE) < 100);
});

test('a failing transit service makes that side drive, with its own notice', async () => {
  const result = await findGroupMiddle({ ...baseQuery, modes: ['transit', 'car', 'car'] }, fakeProvider({ transitThrows: 'always' }));
  assert.deepEqual(result.modes, ['car', 'car', 'car']);
  assert.ok(result.notices.includes('transit-error'));
  assert.ok(result.places.length > 0);
});

test('transit failing after the first ring re-times that side\'s earlier points by car', async () => {
  // A slow transit side: the first ring pulls the middle toward it. When transit
  // fails on the second ring, the first ring must be timed again by car, or the
  // middle would be chosen from transit times for some points and driving for others.
  const provider = fakeProvider({ transitThrows: 2, transitSpeed: 8 });
  const result = await findGroupMiddle({ ...baseQuery, modes: ['transit', 'car', 'car'] }, provider);
  assert.deepEqual(result.modes, ['car', 'car', 'car']);
  const carOnly = provider.calls.travelTimes.filter((c) => c.mode === 'car' && c.origins === 1);
  assert.deepEqual(
    carOnly.map((c) => c.destinations),
    [6, 7], // the second ring by car, then the first ring again
  );
  // Everyone drives at the same speed, so the middle ends up near the centre again.
  assert.ok(haversine(result.midpoint, CENTRE) < 8000, `${haversine(result.midpoint, CENTRE)} m off`);
});

test('people starting from the same place are timed once, and each gets the times', async () => {
  // Google bills every origin, and a twin's row would only repeat the first one's.
  const provider = fakeProvider();
  const twin = { ...TRIANGLE[0], label: 'עוד מאותו מקום' };
  const result = await findGroupMiddle({ ...baseQuery, points: [...TRIANGLE, twin], modes: ['transit', 'car', 'car', 'transit'] }, provider);
  assert.ok(provider.calls.travelTimes.every((c) => c.origins === (c.mode === 'transit' ? 1 : 2)), JSON.stringify(provider.calls.travelTimes));
  assert.ok(result.places.length > 0);
  for (const p of result.places) assert.equal(p.times[3], p.times[0]);
});

test('same place, transit giving out after the first ring: both re-timed by car, once', async () => {
  const provider = fakeProvider({ transitThrows: 2, transitSpeed: 8 });
  const twin = { ...TRIANGLE[0], label: 'עוד מאותו מקום' };
  const result = await findGroupMiddle({ ...baseQuery, points: [...TRIANGLE, twin], modes: ['transit', 'car', 'car', 'transit'] }, provider);
  assert.deepEqual(result.modes, ['car', 'car', 'car', 'car']);
  assert.ok(provider.calls.travelTimes.every((c) => c.origins <= 3), JSON.stringify(provider.calls.travelTimes));
  assert.ok(result.places.length > 0);
  for (const p of result.places) assert.equal(p.times[3], p.times[0]);
  assert.ok(haversine(result.midpoint, CENTRE) < 12000, `${haversine(result.midpoint, CENTRE)} m off`);
});

test('too few places widens the search step by step, with a notice', async () => {
  const provider = fakeProvider({ placesPerCategory: 1 });
  const result = await findGroupMiddle(baseQuery, provider);
  const radii = provider.calls.searchPlaces.map((c) => c.radius);
  assert.ok(radii.length > 1);
  for (let i = 1; i < radii.length; i++) assert.ok(radii[i] > radii[i - 1]);
  assert.ok(result.notices.includes('widened'));
  assert.equal(result.radius, radii[radii.length - 1]);
});

test('provider maxCandidates limits the places that get timed', async () => {
  const provider = fakeProvider({ maxCandidates: 4 });
  const result = await findGroupMiddle(baseQuery, provider);
  assert.equal(result.places.length, 4);
  assert.equal(provider.calls.travelTimes.at(-1).destinations, 4);
});

test('a place filter drops places before they are timed', async () => {
  const provider = fakeProvider();
  const result = await findGroupMiddle({ ...baseQuery, placeFilter: (p) => p.category === 'park' }, provider);
  assert.ok(result.places.every((p) => p.category === 'park'));
  assert.equal(provider.calls.travelTimes.at(-1).destinations, 5);
});

test('nowhere everyone can reach: the plain centre, marked unreliable', async () => {
  const result = await findGroupMiddle(baseQuery, fakeProvider({ unreachableFrom: TRIANGLE[1] }));
  assert.equal(result.balance.reliable, false);
  assert.equal(result.balance.time, null);
  assert.ok(haversine(result.midpoint, CENTRE) < 100);
  assert.deepEqual(result.places, []);
});

test('Green Line filter: the middle stays out of the areas, with a notice', async () => {
  const areas = squareAround(CENTRE, 5000);
  const provider = fakeProvider();
  const result = await findGroupMiddle({ ...baseQuery, avoidAreas: areas }, provider);
  assert.ok(!beyondGreenLine(areas, result.midpoint));
  assert.ok(result.notices.includes('green-line-places-only'));
  // The centre itself was never timed: only the six ring points.
  assert.equal(provider.calls.travelTimes[0].destinations, 6);
});

test('Green Line filter: the whole first ring beyond the line looks further out', async () => {
  const areas = squareAround(CENTRE, 18000); // the first ring is 12 km out
  const provider = fakeProvider();
  const result = await findGroupMiddle({ ...baseQuery, avoidAreas: areas }, provider);
  assert.ok(!beyondGreenLine(areas, result.midpoint));
  assert.ok(result.balance.reliable);
  // Nothing timed in the first ring; the wider one (24 km out) is all outside the square.
  assert.equal(provider.calls.travelTimes[0].destinations, 6);
  assert.ok(haversine(result.midpoint, CENTRE) > 18000);
});

test('Green Line filter: someone starting beyond the line turns it off for the middle', async () => {
  const areas = squareAround(TRIANGLE[0], 2000);
  const result = await findGroupMiddle({ ...baseQuery, avoidAreas: areas }, fakeProvider());
  assert.ok(!result.notices.includes('green-line-places-only'));
  assert.ok(haversine(result.midpoint, CENTRE) < 100);
});

test('provider unavailability propagates so the app can switch providers', async () => {
  await assert.rejects(findGroupMiddle(baseQuery, fakeProvider({ failPlaces: true })), ProviderUnavailableError);
});

test('what matters more changes the order, not the places', async () => {
  const result = await findGroupMiddle({ ...baseQuery, priority: 'equal' }, fakeProvider());
  const again = rerankPlaces(result.places, { priority: 'gap' });
  assert.deepEqual(
    again.map((p) => p.id).sort(),
    result.places.map((p) => p.id).sort(),
  );
  for (let i = 1; i < again.length; i++) assert.ok(again[i - 1].score <= again[i].score);
  assert.deepEqual(again[0].times, result.places.find((p) => p.id === again[0].id).times);
});

test('takes 2 to MAX_POINTS starting points', async () => {
  const provider = fakeProvider();
  await assert.rejects(findGroupMiddle({ ...baseQuery, points: [TLV] }, provider), RangeError);
  const many = ringAround(CENTRE, 20000, MAX_POINTS + 1).map((p) => ({ label: 'x', ...p }));
  await assert.rejects(findGroupMiddle({ ...baseQuery, points: many }, provider), RangeError);
  const five = await findGroupMiddle({ ...baseQuery, points: many.slice(0, MAX_POINTS) }, provider);
  assert.ok(five.places.every((p) => p.times.length === MAX_POINTS));
});
