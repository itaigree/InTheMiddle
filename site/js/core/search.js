// The search pipeline, independent of which map provider serves the data.
//
// Every provider implements:
//   id: string, supportsTransit: boolean, maxCandidates?: number
//   route(a, b, {departure}) -> {path: LatLng[], timeline?: number[], distanceMeters, durationSec} | null   (driving)
//   travelTimes(origins, destinations, mode, {departure}) -> (seconds|null)[][]  [origin][destination]
//   searchPlaces(center, radiusMeters, categoryIds) -> Place[]  (best-first within each category)
// See js/providers/README.md for the full contract.

import { SAMPLE_FRACTIONS, findEqualTimeFraction, searchRadiusFor } from './midpoint.js';
import { samplePath, pointAtFraction, straightPath, pathLength, valuesAlongPath } from './geo.js';
import { rankPlaces, dedupePlaces } from './ranking.js';
import { ProviderUnavailableError } from '../providers/errors.js';

/**
 * At most this many candidates get their travel times checked, unless the provider
 * sets a lower `maxCandidates` (Google bills every origin × destination pair).
 */
export const MAX_CANDIDATES = 40;
/** Fine sampling used when driving times come from the route itself (no API calls). */
const TIMELINE_FRACTIONS = Array.from({ length: 49 }, (_, i) => (i + 1) / 50);
/** Below this many places around the midpoint, the search area is widened once. */
const MIN_PLACES = 6;

const isTime = (t) => typeof t === 'number' && Number.isFinite(t) && t >= 0;

/**
 * @param {object} query
 * @param {{label: string, lat: number, lng: number}} query.a
 * @param {{label: string, lat: number, lng: number}} query.b
 * @param {'car'|'transit'} query.modeA
 * @param {'car'|'transit'} query.modeB
 * @param {string[]} query.categories
 * @param {Date|null} query.departure  null = leave now
 * @param {object} provider
 * @param {{onProgress?: (step: string) => void}} [hooks]
 */
export async function findMiddle(query, provider, { onProgress = () => {} } = {}) {
  const { a, b, categories, departure } = query;
  const notices = [];
  const opts = { departure };
  let modeA = query.modeA;
  let modeB = query.modeB;

  if (!provider.supportsTransit && (modeA === 'transit' || modeB === 'transit')) {
    modeA = 'car';
    modeB = 'car';
    notices.push('transit-unsupported');
  }

  onProgress('route');
  let route = null;
  try {
    route = await provider.route(a, b, opts);
  } catch (err) {
    if (err instanceof ProviderUnavailableError) throw err;
    console.warn('route failed, using a straight line', err);
  }
  const path = route?.path?.length >= 2 ? route.path : straightPath(a, b);
  // A straight line underestimates road distance; scale it to a typical detour.
  const routeMeters = route?.distanceMeters || pathLength(path) * 1.3;

  onProgress('balance');
  // Driving times along the route come for free from the route's own timeline
  // (A drives forward along it, B drives it in reverse). Only sides without a
  // timeline – transit, or a provider that gave none – need a travel-time query.
  const timeline = route && hasTimeline(path, route.timeline) ? route.timeline : null;
  const sampleTimes = async (fractions) => {
    const samples = samplePath(path, fractions);
    const along = timeline ? valuesAlongPath(path, timeline, fractions) : null;
    const total = timeline ? timeline[timeline.length - 1] : null;
    const fromTimeline = { a: along, b: along && along.map((t) => total - t) };
    const queries = [];
    for (const [key, origin, mode] of [
      ['a', a, modeA],
      ['b', b, modeB],
    ]) {
      if (mode !== 'car' || !timeline) queries.push({ key, origin, mode });
    }
    const out = { a: fromTimeline.a, b: fromTimeline.b };
    if (queries.length === 2 && queries[0].mode === queries[1].mode) {
      const m = await provider.travelTimes([a, b], samples, queries[0].mode, opts);
      out.a = m[0];
      out.b = m[1];
    } else {
      const results = await Promise.all(queries.map((q) => provider.travelTimes([q.origin], samples, q.mode, opts)));
      queries.forEach((q, i) => {
        out[q.key] = results[i][0];
      });
    }
    return out;
  };

  let fractions = timeline && modeA === 'car' && modeB === 'car' ? TIMELINE_FRACTIONS : SAMPLE_FRACTIONS;
  let times = await sampleTimes(fractions);

  // No transit at all (Shabbat, night, or no service): fall back to driving for that side.
  const noTransit = [];
  if (modeA === 'transit' && !times.a.some(isTime)) noTransit.push('a');
  if (modeB === 'transit' && !times.b.some(isTime)) noTransit.push('b');
  if (noTransit.length) {
    notices.push('transit-no-service');
    if (noTransit.includes('a')) modeA = 'car';
    if (noTransit.includes('b')) modeB = 'car';
    fractions = timeline && modeA === 'car' && modeB === 'car' ? TIMELINE_FRACTIONS : SAMPLE_FRACTIONS;
    times = await sampleTimes(fractions);
  }

  const balance = findEqualTimeFraction(fractions, times.a, times.b);
  const midpoint = pointAtFraction(path, balance.fraction);

  onProgress('places');
  let radius = searchRadiusFor(routeMeters);
  let places = dedupePlaces(await provider.searchPlaces(midpoint, radius, categories));
  if (places.length < MIN_PLACES) {
    radius *= 2;
    places = dedupePlaces(await provider.searchPlaces(midpoint, radius, categories));
  }
  const candidates = selectCandidates(places, Math.min(MAX_CANDIDATES, provider.maxCandidates || MAX_CANDIDATES));

  onProgress('times');
  let ranked = [];
  if (candidates.length) {
    const [placeTimesA, placeTimesB] = await timesFromBoth(provider, a, b, candidates, modeA, modeB, opts);
    ranked = rankPlaces(candidates, placeTimesA, placeTimesB, { preferOpen: !departure });
  }

  return {
    providerId: provider.id,
    a,
    b,
    modeA,
    modeB,
    categories,
    departure,
    route: route ? path : null,
    routeMeters,
    midpoint,
    radius,
    balance,
    places: ranked,
    notices,
  };
}

function hasTimeline(path, timeline) {
  return (
    Array.isArray(timeline) &&
    timeline.length === path.length &&
    timeline.every((t, i) => Number.isFinite(t) && (i === 0 || t >= timeline[i - 1])) &&
    timeline[timeline.length - 1] > 0
  );
}

/** Travel times from A and from B to each destination, batching when the modes match. */
async function timesFromBoth(provider, a, b, destinations, modeA, modeB, opts) {
  if (modeA === modeB) {
    const m = await provider.travelTimes([a, b], destinations, modeA, opts);
    return [m[0], m[1]];
  }
  const [ma, mb] = await Promise.all([
    provider.travelTimes([a], destinations, modeA, opts),
    provider.travelTimes([b], destinations, modeB, opts),
  ]);
  return [ma[0], mb[0]];
}

/**
 * Up to `max` places, taken round-robin across categories so every requested kind
 * of place gets checked. Within a category the provider's order (best-first) holds.
 */
export function selectCandidates(places, max) {
  const groups = new Map();
  for (const p of places) {
    if (!groups.has(p.category)) groups.set(p.category, []);
    groups.get(p.category).push(p);
  }
  const queues = [...groups.values()];
  const picked = [];
  for (let round = 0; picked.length < max; round++) {
    let any = false;
    for (const q of queues) {
      if (round < q.length) {
        any = true;
        picked.push(q[round]);
        if (picked.length >= max) break;
      }
    }
    if (!any) break;
  }
  return picked;
}
