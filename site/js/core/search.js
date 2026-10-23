// The search pipeline, independent of which map provider serves the data.
//
// Every provider implements:
//   id: string, supportsTransit: boolean, maxCandidates?: number
//   route(a, b, {departure}) -> {path: LatLng[], timeline?: number[], distanceMeters, durationSec} | null   (driving)
//   travelTimes(origins, destinations, mode, {departure}) -> (seconds|null)[][]  [origin][destination]
//   searchPlaces(center, radiusMeters, categoryIds) -> Place[]  (best-first within each category)
// See js/providers/README.md for the full contract.

import { SAMPLE_FRACTIONS, findEqualTimeFraction, searchRadii } from './midpoint.js';
import { samplePath, pointAtFraction, straightPath, pathLength, valuesAlongPath, haversine } from './geo.js';
import { rankPlaces, dedupePlaces } from './ranking.js';
import { crossesLine, gateChain, bypassGates, insideAlong, hasUturn } from './detour.js';
import { beyondGreenLine } from './green-line.js';
import { ProviderUnavailableError, isAbortError } from '../providers/errors.js';

/**
 * At most this many candidates get their travel times checked, unless the provider
 * sets a lower `maxCandidates` (Google bills every origin × destination pair).
 */
export const MAX_CANDIDATES = 40;
/** Fine sampling used when driving times come from the route itself (no API calls). */
const TIMELINE_FRACTIONS = Array.from({ length: 49 }, (_, i) => (i + 1) / 50);
/** Below this many places around the midpoint, the search area is widened (step by step). */
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
 * @param {'equal'|'balanced'|'gap'} [query.priority]  what matters more (see ranking.js)
 * @param {object[]} [query.avoidAreas]  the areas beyond the Green Line, to keep the route out of
 * @param {object} provider
 * @param {{onProgress?: (step: string) => void}} [hooks]
 */
export async function findMiddle(query, provider, { onProgress = () => {} } = {}) {
  const { a, b, categories, departure } = query;
  // Optional: which places to keep (filters the user chose).
  const keep = query.placeFilter || (() => true);
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
  // With the "inside the Green Line" filter, the middle is found along a road
  // that stays inside (unless a side starts beyond the line: then none does).
  const avoid = query.avoidAreas && !beyondGreenLine(query.avoidAreas, a) && !beyondGreenLine(query.avoidAreas, b) ? query.avoidAreas : null;
  let route = null;
  let bypass = null;
  try {
    if (avoid) ({ route, bypass } = await routeInside(provider, a, b, avoid, opts));
    else route = await provider.route(a, b, opts);
  } catch (err) {
    if (err instanceof ProviderUnavailableError) throw err;
    console.warn('route failed, using a straight line', err);
  }
  if (bypass) notices.push(bypass === 'failed' ? 'bypass-failed' : 'bypass');
  const path = route?.path?.length >= 2 ? route.path : straightPath(a, b);
  const pathMeters = pathLength(path);
  // A straight line underestimates road distance; scale it to a typical detour.
  const routeMeters = route?.distanceMeters || pathMeters * 1.3;

  onProgress('balance');
  // Driving times along the route come for free from the route's own timeline
  // (A drives forward along it, B drives it in reverse). Only sides without a
  // timeline – transit, or a provider that gave none – need a travel-time query.
  const timeline = route && hasTimeline(path, route.timeline) ? route.timeline : null;
  const addNotice = (n) => {
    if (!notices.includes(n)) notices.push(n);
  };

  /**
   * Travel times (seconds) from each side to `dests`. Driving sides use
   * `fromTimeline` when given; sides listed in `keep` reuse earlier times for the
   * same destinations (they're billed). A transit query that fails outright (as
   * opposed to finding no service) yields nulls and is listed in `failed`.
   */
  async function timesTo(dests, fromTimeline = null, keep = {}) {
    const out = { a: null, b: null, failed: [] };
    const pending = [];
    for (const [key, origin, mode] of [
      ['a', a, modeA],
      ['b', b, modeB],
    ]) {
      if (mode === 'car' && fromTimeline) out[key] = fromTimeline[key];
      else if (keep[key]) out[key] = keep[key];
      else pending.push({ key, origin, mode });
    }
    // Same mode on both sides: one request with two origins.
    const groups = pending.length === 2 && pending[0].mode === pending[1].mode ? [pending] : pending.map((p) => [p]);
    await Promise.all(
      groups.map(async (group) => {
        const { mode } = group[0];
        try {
          const m = await provider.travelTimes(
            group.map((g) => g.origin),
            dests,
            mode,
            opts,
          );
          group.forEach((g, i) => {
            out[g.key] = m[i];
          });
        } catch (err) {
          if (mode !== 'transit' || err instanceof ProviderUnavailableError || isAbortError(err)) throw err;
          console.warn('transit routing failed; that side will drive', err);
          for (const g of group) {
            out[g.key] = dests.map(() => null);
            out.failed.push(g.key);
          }
        }
      }),
    );
    return out;
  }

  /**
   * Switch transit sides that failed or found no service at all (Shabbat, night)
   * to driving. Returns the sides that changed.
   */
  function dropUnusableTransit(times) {
    const changed = [];
    for (const key of ['a', 'b']) {
      if ((key === 'a' ? modeA : modeB) !== 'transit') continue;
      if (times.failed.includes(key)) addNotice('transit-error');
      else if (!times[key].some(isTime)) addNotice('transit-no-service');
      else continue;
      if (key === 'a') modeA = 'car';
      else modeB = 'car';
      changed.push(key);
    }
    return changed;
  }

  /** The other side's times, to reuse when only `changed` sides need new ones. */
  const unchanged = (times, changed) =>
    Object.fromEntries(['a', 'b'].filter((k) => !changed.includes(k)).map((k) => [k, times[k]]));

  const fractionsFor = () => (timeline && modeA === 'car' && modeB === 'car' ? TIMELINE_FRACTIONS : SAMPLE_FRACTIONS);
  const sampleTimes = (fractions, keep = {}) => {
    let fromTimeline = null;
    if (timeline) {
      const along = valuesAlongPath(path, timeline, fractions);
      const total = timeline[timeline.length - 1];
      fromTimeline = { a: along, b: along.map((t) => total - t) };
    }
    return timesTo(samplePath(path, fractions), fromTimeline, keep);
  };

  let fractions = fractionsFor();
  let times = await sampleTimes(fractions);
  const resampleAfterDrop = async (changed) => {
    const next = fractionsFor();
    const keep = next === fractions ? unchanged(times, changed) : {};
    fractions = next;
    times = await sampleTimes(fractions, keep);
  };
  const droppedWhileSampling = dropUnusableTransit(times);
  if (droppedWhileSampling.length) await resampleAfterDrop(droppedWhileSampling);

  let balance;
  let midpoint;
  let radius;
  let ranked = [];

  // On a route that goes around the West Bank, a side's fastest way to a place
  // near it may still cut through. So time the places from the route instead:
  // along it to a point near the middle, then the short drive from there.
  const fromRoute = bypass && bypass !== 'failed' && timeline;
  const anchoredTimes = new WeakMap();
  async function routeTimes(candidates) {
    if (!anchoredTimes.has(candidates)) {
      const spread = radius / Math.max(1, pathMeters);
      const fracs = [...new Set([balance.fraction - spread, balance.fraction, balance.fraction + spread].map((f) => Math.min(0.98, Math.max(0.02, f))))];
      const along = valuesAlongPath(path, timeline, fracs);
      const total = timeline[timeline.length - 1];
      const legs = await provider.travelTimes(samplePath(path, fracs), candidates, 'car', opts);
      const best = (atAnchor) =>
        candidates.map((_, j) => {
          const ts = legs.map((row, k) => (isTime(row[j]) ? atAnchor[k] + row[j] : Infinity));
          const t = Math.min(...ts);
          return Number.isFinite(t) ? t : null;
        });
      anchoredTimes.set(candidates, { a: best(along), b: best(along.map((t) => total - t)) });
    }
    return anchoredTimes.get(candidates);
  }
  const candidateTimes = async (candidates, keep = {}) =>
    timesTo(candidates, fromRoute && (modeA === 'car' || modeB === 'car') ? await routeTimes(candidates) : null, keep);

  const radii = searchRadii(routeMeters);
  const maxCandidates = Math.min(MAX_CANDIDATES, provider.maxCandidates || MAX_CANDIDATES);
  const rankOptions = { preferOpen: !departure, priority: query.priority };
  // Usually one pass. If transit turns out unusable for the candidates, the
  // midpoint was balanced for transit: re-balance for driving and search again.
  passes: for (let pass = 0; pass < 2; pass++) {
    balance = findEqualTimeFraction(fractions, times.a, times.b);
    midpoint = pointAtFraction(path, balance.fraction);
    // A middle that still lands beyond the line (e.g. at Latrun, which Route 1
    // passes) moves along the route to the nearest point inside.
    const inside = avoid && beyondGreenLine(avoid, midpoint) ? insideAlong(avoid, path, balance.fraction) : null;
    if (inside) {
      balance = { ...balance, fraction: inside.fraction, reliable: balance.reliable && Math.abs(inside.fraction - balance.fraction) <= 0.05 };
      midpoint = inside.point;
    }
    ranked = [];

    onProgress('places');
    // Too few places (or none either side can reach) around the middle: look
    // further out, step by step. Places found nearer the middle stay first in
    // line, and none has its (billed) travel times checked twice.
    const found = [];
    const checked = new Set();
    for (let step = 0; step < radii.length && !ranked.length; step++) {
      radius = radii[step];
      if (step) onProgress('wider');
      found.push(...(await provider.searchPlaces(midpoint, radius, categories)));
      const places = dedupePlaces(found).filter(keep);
      if (places.length < MIN_PLACES && step < radii.length - 1) continue;
      const candidates = selectCandidates(
        places.filter((p) => !checked.has(p.id)),
        maxCandidates,
      );
      if (!candidates.length) continue;
      for (const p of candidates) checked.add(p.id);

      onProgress('times');
      let placeTimes = await candidateTimes(candidates);
      const dropped = dropUnusableTransit(placeTimes);
      if (dropped.length && pass === 0) {
        await resampleAfterDrop(dropped);
        const nextBalance = findEqualTimeFraction(fractions, times.a, times.b);
        const nextMidpoint = pointAtFraction(path, nextBalance.fraction);
        if (haversine(midpoint, nextMidpoint) > Math.min(radius / 2, 1000)) continue passes;
        // The balance point barely moved: the same places still fit, so only the
        // side that switched to driving needs new (billed) travel times. The map
        // keeps showing the area that was actually searched (old midpoint).
        balance = nextBalance;
      }
      if (dropped.length) placeTimes = await candidateTimes(candidates, unchanged(placeTimes, dropped));
      ranked = rankPlaces(candidates, placeTimes.a, placeTimes.b, rankOptions);
    }
    break;
  }
  if (radius > radii[0]) notices.push('widened');

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
    bypass,
    priority: query.priority || 'balanced',
    places: ranked,
    notices,
  };
}

/**
 * The fastest driving route from a to b that stays inside the Green Line (see
 * core/detour.js): the usual one if it does, else a faster-first alternative
 * that does, else one forced through gates around the West Bank. Returns
 * {route, bypass}: bypass is null (the usual route), 'alternative', 'gates',
 * or 'failed' (no way around was found; the usual route).
 */
export async function routeInside(provider, a, b, areas, opts = {}) {
  const routesWith = async (options) =>
    (provider.routes ? await provider.routes(a, b, { ...opts, ...options }) : [await provider.route(a, b, opts)]).filter(
      (r) => r?.path?.length >= 2,
    );
  const found = await routesWith({ alternatives: true });
  if (!found.length) return { route: null, bypass: null };
  if (!crossesLine(areas, found[0].path)) return { route: found[0], bypass: null };
  const clean = found.filter((r) => !crossesLine(areas, r.path)).sort((x, y) => x.durationSec - y.durationSec);
  if (clean.length) return { route: clean[0], bypass: 'alternative' };
  if (provider.routes) {
    // Gates around just the stretches the usual route crosses; failing that
    // (or if that one turns back on itself somewhere), gates for the whole way.
    const tried = new Set();
    let turning = null;
    for (const gates of [bypassGates(areas, found[0].path), gateChain(areas, a, b)]) {
      const key = gates.map((g) => g.id).join();
      if (!gates.length || tried.has(key)) continue;
      tried.add(key);
      try {
        const [forced] = await routesWith({ via: gates });
        if (!forced || crossesLine(areas, forced.path)) continue;
        if (!hasUturn(forced.path)) return { route: forced, bypass: 'gates' };
        turning = turning || forced;
      } catch (err) {
        if (err instanceof ProviderUnavailableError || isAbortError(err)) throw err;
        console.warn('route around the West Bank failed', err);
      }
    }
    if (turning) return { route: turning, bypass: 'gates' };
  }
  return { route: found[0], bypass: 'failed' };
}

function hasTimeline(path, timeline) {
  return (
    Array.isArray(timeline) &&
    timeline.length === path.length &&
    timeline.every((t, i) => Number.isFinite(t) && (i === 0 || t >= timeline[i - 1])) &&
    timeline[timeline.length - 1] > 0
  );
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
