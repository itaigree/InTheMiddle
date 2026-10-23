import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMiddle, selectCandidates, MAX_CANDIDATES } from '../../site/js/core/search.js';
import { haversine } from '../../site/js/core/geo.js';
import { searchRadii } from '../../site/js/core/midpoint.js';
import { prepare, beyondGreenLine } from '../../site/js/core/green-line.js';
import { crossesLine } from '../../site/js/core/detour.js';
import fs from 'node:fs';
import { ProviderUnavailableError, ProviderRequestError } from '../../site/js/providers/errors.js';

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
  transitThrows = null, // 'always' | 'candidates'
  transitSpeed = null, // m/s for transit (default: the side's speed)
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
      if (mode === 'transit' && (transitThrows === 'always' || (transitThrows === 'candidates' && destinations.length !== 8))) {
        throw new ProviderRequestError('transit server down');
      }
      return origins.map((o) =>
        destinations.map((d) => {
          if (mode === 'transit' && !transitWorks) return null;
          const speed = mode === 'transit' && transitSpeed ? transitSpeed : o.lat === HAIFA.lat ? speedA : speedB;
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

test('too few places widens the search step by step, up to a limit, with a notice', async () => {
  const provider = fakeProvider({ placesPerCategory: 2 });
  const result = await findMiddle({ ...baseQuery, categories: ['cafe'] }, provider);
  const radii = provider.calls.searchPlaces.map((c) => c.radius);
  // Haifa–Tel Aviv: ~97 km of road → 6.8 km, doubled, then a quarter of the trip.
  assert.deepEqual(radii, searchRadii(result.routeMeters));
  assert.equal(radii.length, 3);
  assert.equal(result.radius, Math.round(result.routeMeters / 4));
  assert.ok(result.notices.includes('widened'));
  // The few places found are still shown, their times checked once.
  assert.equal(result.places.length, 2);
  assert.equal(provider.calls.travelTimes.length, 2);
});

test('the search stops widening once enough places turn up', async () => {
  const provider = fakeProvider({ placesPerCategory: 3 });
  // Nothing in the middle itself; plenty a little further out.
  const searchPlaces = provider.searchPlaces;
  provider.searchPlaces = async (center, radius, categories) => {
    const places = await searchPlaces.call(provider, center, radius, categories);
    return provider.calls.searchPlaces.length === 1 ? [] : places;
  };
  const result = await findMiddle(baseQuery, provider);
  assert.equal(provider.calls.searchPlaces.length, 2);
  assert.ok(result.notices.includes('widened'));
  assert.equal(result.places.length, 6);
});

test('places nobody can reach send the search further out, checking only new places', async () => {
  const provider = fakeProvider();
  const travelTimes = provider.travelTimes;
  // The places of the first search area can't be reached; the wider area's can.
  let first = true;
  provider.travelTimes = async (origins, dests, mode) => {
    const times = await travelTimes.call(provider, origins, dests, mode);
    if (dests.length === 8) return times; // the route samples
    const unreachable = first;
    first = false;
    return unreachable ? times.map((row) => row.map(() => null)) : times;
  };
  const searchPlaces = provider.searchPlaces;
  provider.searchPlaces = async (center, radius, categories) => {
    const places = await searchPlaces.call(provider, center, radius, categories);
    // The wider area also has places of its own.
    return provider.calls.searchPlaces.length > 1 ? [...places, ...places.map((p) => ({ ...p, id: `far-${p.id}`, name: `far ${p.name}`, lat: p.lat + 0.05 }))] : places;
  };
  const result = await findMiddle(baseQuery, provider);
  assert.equal(provider.calls.searchPlaces.length, 2);
  assert.ok(result.places.length > 0);
  assert.ok(result.places.every((p) => p.id.startsWith('far-')));
  // Places already checked weren't checked (billed) again.
  assert.deepEqual(provider.calls.travelTimes.map((c) => c.destinations), [8, 10, 10]);
});

test('what matters more changes the order, not the places', async () => {
  // A 3x faster side: the middle is off-center, so places differ in both total and balance.
  const results = {};
  for (const priority of ['equal', 'balanced', 'gap']) {
    results[priority] = await findMiddle({ ...baseQuery, priority }, fakeProvider({ speedA: 30, speedB: 10 }));
  }
  const ids = (r) => r.places.map((p) => p.id);
  assert.deepEqual(ids(results.equal).slice().sort(), ids(results.gap).slice().sort());
  assert.equal(results.gap.priority, 'gap');
  const meanOfTop = (r) => (r.places[0].timeA + r.places[0].timeB) / 2;
  assert.ok(results.equal.places[0].diff <= results.gap.places[0].diff);
  assert.ok(meanOfTop(results.gap) <= meanOfTop(results.equal));
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

test('a failing transit service makes that side drive, with its own notice', async () => {
  const provider = fakeProvider({ transitThrows: 'always' });
  const result = await findMiddle({ ...baseQuery, modeB: 'transit' }, provider);
  assert.equal(result.modeB, 'car');
  assert.deepEqual(result.notices, ['transit-error']);
  assert.ok(result.places.length > 0);
});

test('transit failing only for the candidates still produces results by car', async () => {
  const provider = fakeProvider({ transitThrows: 'candidates' });
  const result = await findMiddle({ ...baseQuery, modeA: 'transit' }, provider);
  assert.equal(result.modeA, 'car');
  assert.ok(result.notices.includes('transit-error'));
  assert.ok(result.places.length > 0);
  assert.ok(result.places.every((p) => Number.isFinite(p.timeA)));
});

test('provider unavailability during transit queries still propagates', async () => {
  const provider = fakeProvider();
  provider.travelTimes = async () => {
    throw new ProviderUnavailableError('quota', { reason: 'quota' });
  };
  await assert.rejects(findMiddle({ ...baseQuery, modeA: 'transit' }, provider), ProviderUnavailableError);
});

test('transit lost at the candidate stage re-balances the midpoint for driving', async () => {
  // B by slow transit pushes the transit-balanced midpoint toward B; when transit
  // then fails for the candidates, both sides drive at the same speed, so the
  // midpoint must move back to the middle and places be searched there.
  const provider = fakeProvider({ transitThrows: 'candidates', transitSpeed: 5 });
  const result = await findMiddle({ ...baseQuery, modeB: 'transit' }, provider);
  assert.equal(result.modeB, 'car');
  assert.ok(Math.abs(result.balance.fraction - 0.5) < 0.02, `fraction ${result.balance.fraction}`);
  assert.equal(provider.calls.searchPlaces.length, 2);
  const [first, second] = provider.calls.searchPlaces.map((c) => c.center.lat);
  assert.notEqual(first, second);
  assert.ok(result.places.length > 0);
});

test('when transit drops out, only that side is queried again', async () => {
  const provider = fakeProvider({ transitWorks: false });
  await findMiddle({ ...baseQuery, modeB: 'transit' }, provider);
  const sampling = provider.calls.travelTimes.filter((c) => c.destinations === 8);
  // A by car, B by transit (no service), then B again by car – A is not re-queried.
  assert.deepEqual(
    sampling.map((c) => `${c.mode}:${c.origins}`).sort(),
    ['car:1', 'car:1', 'transit:1'],
  );
});

test('transit lost at the candidate stage keeps the places when the midpoint barely moves', async () => {
  // Transit at the same speed as driving: re-balancing doesn't move the midpoint,
  // so no second place search and only the switched side is re-queried.
  const provider = fakeProvider({ transitThrows: 'candidates' });
  const result = await findMiddle({ ...baseQuery, modeB: 'transit' }, provider);
  assert.equal(result.modeB, 'car');
  assert.equal(provider.calls.searchPlaces.length, 1);
  const candidateCalls = provider.calls.travelTimes.filter((c) => c.destinations !== 8);
  assert.deepEqual(
    candidateCalls.map((c) => `${c.mode}:${c.origins}`).sort(),
    ['car:1', 'car:1', 'transit:1'],
  );
  assert.ok(result.places.length > 0);
});

test('a place filter drops places before travel times are asked for', async () => {
  const provider = fakeProvider();
  // The fake places alternate west/east of the midpoint by their index: keep the even ones.
  const result = await findMiddle({ ...baseQuery, placeFilter: (p) => Number(p.id.split('-')[1]) % 2 === 0 }, provider);
  assert.ok(result.places.length > 0);
  assert.ok(result.places.every((p) => Number(p.id.split('-')[1]) % 2 === 0));
  assert.equal(provider.calls.travelTimes.at(-1).destinations, result.places.length);
});

// ------------------------------------------------- the Green Line filter's route

const greenLine = prepare(
  Object.values(JSON.parse(fs.readFileSync(new URL('../../site/data/green-line.json', import.meta.url), 'utf8')).areas).flat(),
);
const JERUSALEM = { label: 'ירושלים', lat: 31.7784, lng: 35.2066 };
const BEERSHEBA = { label: 'באר שבע', lat: 31.2518, lng: 34.7913 };
const ARIEL = { label: 'אריאל', lat: 32.1047, lng: 35.1873 };

/** A route along straight lines through `points`, at 20 m/s, with its timeline. */
function straightRoute(points) {
  const timeline = [0];
  for (let i = 1; i < points.length; i++) timeline.push(timeline[i - 1] + haversine(points[i - 1], points[i]) / 20);
  const total = timeline[timeline.length - 1];
  return { path: points, timeline, distanceMeters: total * 20, durationSec: total };
}

/** The fake provider, with routes(): straight lines, through the via points if any. */
function routingProvider({ cleanAlternative = false } = {}) {
  const provider = fakeProvider();
  provider.calls.routes = [];
  provider.routes = async (a, b, { via = [], alternatives = false } = {}) => {
    provider.calls.routes.push({ via: via.length, alternatives });
    if (via.length) return [straightRoute([a, ...via, b])];
    const usual = straightRoute([a, b]);
    // A slower way round, west of the West Bank.
    const round = straightRoute([a, { lat: 31.81, lng: 35.02 }, { lat: 31.6, lng: 34.81 }, b]);
    return alternatives && cleanAlternative ? [usual, round] : [usual];
  };
  return provider;
}

const insideQuery = {
  ...baseQuery,
  a: JERUSALEM,
  b: BEERSHEBA,
  avoidAreas: greenLine,
  placeFilter: (p) => !beyondGreenLine(greenLine, p),
};

test('Green Line filter: a route through the West Bank gives way to one through gates, the middle inside', async () => {
  const provider = routingProvider();
  const result = await findMiddle(insideQuery, provider);
  assert.deepEqual(provider.calls.routes.map((c) => c.alternatives), [true, false]);
  assert.ok(provider.calls.routes[1].via >= 1);
  assert.equal(result.bypass, 'gates');
  assert.ok(result.notices.includes('bypass'));
  assert.equal(crossesLine(greenLine, result.route), false);
  assert.equal(beyondGreenLine(greenLine, result.midpoint), false);
  assert.ok(result.places.length > 0);
  // Places are timed from the route: from points along it near the middle.
  const candidateCalls = provider.calls.travelTimes.filter((c) => c.destinations !== 8 && c.destinations !== 49);
  assert.ok(candidateCalls.every((c) => c.origins === 3), JSON.stringify(provider.calls.travelTimes));
});

test('Green Line filter: a clean alternative is used without forcing gates', async () => {
  const provider = routingProvider({ cleanAlternative: true });
  const result = await findMiddle(insideQuery, provider);
  assert.equal(provider.calls.routes.length, 1);
  assert.equal(result.bypass, 'alternative');
  assert.equal(crossesLine(greenLine, result.route), false);
});

test('without the filter, or from beyond the line, the usual route is used', async () => {
  const provider = routingProvider();
  const plain = await findMiddle({ ...insideQuery, avoidAreas: undefined }, provider);
  assert.equal(plain.bypass, null);
  assert.equal(provider.calls.routes.length, 0);
  const fromAriel = await findMiddle({ ...insideQuery, a: ARIEL }, provider);
  assert.equal(fromAriel.bypass, null);
  assert.equal(provider.calls.routes.length, 0);
});
