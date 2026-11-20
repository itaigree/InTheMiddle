// The search for three or more people. (Two people use core/search.js, which finds
// the middle along the road between them.) The rule for a group: the two who are
// farthest apart travel about the same, and everyone else travels less.
//
//   1. Take the two who are farthest apart (as the crow flies) and find the point
//      on the road between them where their trips take the same time, the way
//      search.js does for two people.
//   2. Time everyone to it. If nobody else takes longer than those two, that's
//      the middle.
//   3. Otherwise (three or more about as far apart, like a triangle), look in the
//      area the group surrounds: start at the centre of the smallest circle
//      around everyone, time a ring of 7 points around it from every side, move
//      to the fairest one, and try a tighter ring of 6 around that.
//   4. Search for places around the middle and rank them by the two longest
//      trips, as for two people (ranking.js).
//
// Step 1 usually costs one route (driving times along it come with it), and step
// 2 one lookup per person; the rings in step 3 cost (people × points) lookups,
// which Google bills.

import { haversine, offsetMeters, metersFrom, samplePath, pointAtFraction, straightPath, valuesAlongPath } from './geo.js';
import { searchRadii, SAMPLE_FRACTIONS, findEqualTimeFraction } from './midpoint.js';
import { rankGroupPlaces, dedupePlaces, travelScore } from './ranking.js';
import { selectCandidates, routeInside, hasTimeline, MAX_CANDIDATES, MIN_PLACES, TIMELINE_FRACTIONS } from './search.js';
import { insideAlong } from './detour.js';
import { beyondGreenLine } from './green-line.js';
import { ProviderUnavailableError, isAbortError } from '../providers/errors.js';

/** The most starting points a search takes. */
export const MAX_POINTS = 5;
/** Points on each ring around the current best guess. */
const RING_POINTS = 6;
/** The first ring's radius, as a share of the enclosing circle's radius. */
const FIRST_RING = 0.4;
/** Rings never shrink below this (a group from one town still looks around it). */
const MIN_RING_M = 1500;
/** A straight line underestimates the road; scale it to a typical detour (as search.js does). */
const ROAD_FACTOR = 1.3;
/** How much longer than the farthest two someone else may take at their middle (seconds). */
const PAIR_SLACK_SEC = 60;

const isTime = (t) => typeof t === 'number' && Number.isFinite(t) && t >= 0;

/**
 * The smallest circle that holds all the points: {center: {lat, lng}, radius}
 * (meters). Brute force over every pair and triple, which is plenty for a
 * handful of points.
 */
export function enclosingCircle(points) {
  if (!points.length) throw new Error('enclosingCircle: no points');
  const origin = points[0];
  const xy = points.map((p) => toXY(origin, p));
  const circles = [];
  for (let i = 0; i < xy.length; i++) {
    circles.push({ x: xy[i].x, y: xy[i].y, r: 0 });
    for (let j = i + 1; j < xy.length; j++) {
      const p = xy[i];
      const q = xy[j];
      circles.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, r: Math.hypot(p.x - q.x, p.y - q.y) / 2 });
      for (let k = j + 1; k < xy.length; k++) {
        const c = circumcircle(p, q, xy[k]);
        if (c) circles.push(c);
      }
    }
  }
  // A meter of slack for rounding: every point is on or inside.
  const holdsAll = (c) => xy.every((p) => Math.hypot(p.x - c.x, p.y - c.y) <= c.r + 1);
  const best = circles.filter(holdsAll).sort((a, b) => a.r - b.r)[0];
  return { center: offsetMeters(origin, best.x, best.y), radius: best.r };
}

/** The indices of the two points farthest apart, as the crow flies. */
export function farthestPair(points) {
  let best = [0, 1];
  let bestDistance = -1;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = haversine(points[i], points[j]);
      if (d > bestDistance) {
        bestDistance = d;
        best = [i, j];
      }
    }
  }
  return best;
}

/** `count` points evenly around `center`, `radius` meters away, the first `rotation` degrees east of north. */
export function ringAround(center, radius, count = RING_POINTS, rotation = 0) {
  return Array.from({ length: count }, (_, i) => {
    const angle = ((rotation + (i * 360) / count) * Math.PI) / 180;
    return offsetMeters(center, radius * Math.sin(angle), radius * Math.cos(angle));
  });
}

/**
 * Which of the sampled points is fairest for the group: the index of the lowest
 * travelScore (default priority) among the points everyone can reach, or -1.
 * `rows[side][point]` are travel times in seconds.
 */
export function fairestPoint(rows, count) {
  let best = -1;
  let bestScore = Infinity;
  for (let j = 0; j < count; j++) {
    const times = rows.map((row) => row[j]);
    if (!times.every(isTime)) continue;
    const score = travelScore(times);
    if (score < bestScore) {
      bestScore = score;
      best = j;
    }
  }
  return best;
}

/**
 * @param {object} query
 * @param {{label: string, lat: number, lng: number}[]} query.points  2..MAX_POINTS starting points
 * @param {('car'|'transit')[]} [query.modes]  one per point (default: car)
 * @param {string[]} query.categories
 * @param {Date|null} query.departure  null = leave now
 * @param {'equal'|'balanced'|'gap'} [query.priority]  what matters more (see ranking.js)
 * @param {object[]} [query.avoidAreas]  the areas beyond the Green Line, to keep the middle out of
 * @param {(place: object) => boolean} [query.placeFilter]  which places to keep
 * @param {object} provider  see js/providers/README.md (route() is not used)
 * @param {{onProgress?: (step: string) => void}} [hooks]
 */
export async function findGroupMiddle(query, provider, { onProgress = () => {} } = {}) {
  const { points, categories, departure } = query;
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_POINTS) {
    throw new RangeError(`findGroupMiddle: 2 to ${MAX_POINTS} points`);
  }
  const keep = query.placeFilter || (() => true);
  const notices = [];
  const addNotice = (n) => {
    if (!notices.includes(n)) notices.push(n);
  };
  const opts = { departure };
  const modes = points.map((_, i) => (query.modes?.[i] === 'transit' ? 'transit' : 'car'));
  if (!provider.supportsTransit && modes.includes('transit')) {
    modes.fill('car');
    notices.push('transit-unsupported');
  }

  // With the Green Line filter, the middle stays inside the line (unless someone
  // starts beyond it: then, as for two people, nothing is kept out). Unlike two
  // people, there's no one road to keep inside, so the ways there aren't checked.
  const avoid = query.avoidAreas && !points.some((p) => beyondGreenLine(query.avoidAreas, p)) ? query.avoidAreas : null;
  if (avoid) notices.push('green-line-places-only');
  const allowed = (p) => !avoid || !beyondGreenLine(avoid, p);

  const everyone = points.map((_, i) => i);

  /**
   * Travel times (seconds) from `sides` (default: everyone) to `dests`, as
   * rows[side][dest] (null for the sides not asked): one request per mode. A
   * transit request that fails outright (as opposed to finding no service)
   * yields nulls and lists its sides in `failed`.
   */
  async function timesFrom(dests, sides = everyone) {
    const rows = points.map(() => null);
    const failed = [];
    const byMode = new Map();
    for (const i of sides) {
      if (!byMode.has(modes[i])) byMode.set(modes[i], []);
      byMode.get(modes[i]).push(i);
    }
    await Promise.all(
      [...byMode].map(async ([mode, sides]) => {
        try {
          const m = await provider.travelTimes(
            sides.map((i) => points[i]),
            dests,
            mode,
            opts,
          );
          sides.forEach((i, k) => {
            rows[i] = m[k] || dests.map(() => null);
          });
        } catch (err) {
          if (mode !== 'transit' || err instanceof ProviderUnavailableError || isAbortError(err)) throw err;
          console.warn('transit routing failed; those sides will drive', err);
          for (const i of sides) {
            rows[i] = dests.map(() => null);
            failed.push(i);
          }
        }
      }),
    );
    return { rows, failed };
  }

  /**
   * timesFrom, but a transit side that failed or found no service at all
   * (Shabbat, night) switches to driving and is timed again. Returns the rows
   * and the sides that switched.
   */
  async function timesTo(dests, sides = everyone) {
    const { rows, failed } = await timesFrom(dests, sides);
    const changed = [];
    for (const i of sides) {
      if (modes[i] !== 'transit') continue;
      if (failed.includes(i)) addNotice('transit-error');
      else if (!rows[i].some(isTime)) addNotice('transit-no-service');
      else continue;
      modes[i] = 'car';
      changed.push(i);
    }
    if (changed.length) {
      const redo = await timesFrom(dests, changed);
      for (const i of changed) rows[i] = redo.rows[i];
    }
    return { rows, changed };
  }

  /**
   * Sides i and j's middle: the point on the road between them where their trips
   * take the same time, found as search.js finds it for two people (driving
   * times along the route come with it). With the Green Line filter, along a
   * road that stays inside. {midpoint, reliable, bypass}
   */
  async function pairMiddle(i, j) {
    const [a, b] = [points[i], points[j]];
    let route = null;
    let bypass = null;
    try {
      if (avoid) ({ route, bypass } = await routeInside(provider, a, b, avoid, opts));
      else route = await provider.route(a, b, opts);
    } catch (err) {
      if (err instanceof ProviderUnavailableError || isAbortError(err)) throw err;
      console.warn('route failed, using a straight line', err);
    }
    const path = route?.path?.length >= 2 ? route.path : straightPath(a, b);
    const timeline = route && hasTimeline(path, route.timeline) ? route.timeline : null;
    const timeAlong = async () => {
      const fractions = timeline && modes[i] === 'car' && modes[j] === 'car' ? TIMELINE_FRACTIONS : SAMPLE_FRACTIONS;
      const rows = points.map(() => null);
      if (timeline) {
        // i drives the route forward, j in reverse.
        const along = valuesAlongPath(path, timeline, fractions);
        const total = timeline[timeline.length - 1];
        if (modes[i] === 'car') rows[i] = along;
        if (modes[j] === 'car') rows[j] = along.map((t) => total - t);
      }
      const pending = [i, j].filter((k) => !rows[k]);
      if (pending.length) {
        const timed = await timesTo(samplePath(path, fractions), pending);
        // A side switched to driving: with a route, its times come with it.
        if (timed.changed.length && timeline) return timeAlong();
        for (const k of pending) rows[k] = timed.rows[k];
      }
      return { fractions, rows };
    };
    const { fractions, rows } = await timeAlong();
    let balance = findEqualTimeFraction(fractions, rows[i], rows[j]);
    let midpoint = pointAtFraction(path, balance.fraction);
    // A middle that lands beyond the line moves along the road to the nearest point inside.
    const inside = avoid && beyondGreenLine(avoid, midpoint) ? insideAlong(avoid, path, balance.fraction) : null;
    if (inside) {
      balance = { ...balance, reliable: balance.reliable && Math.abs(inside.fraction - balance.fraction) <= 0.05 };
      midpoint = inside.point;
    }
    return { midpoint, reliable: balance.reliable, bypass };
  }

  onProgress('balance');
  let midpoint = null;
  let balance = null;
  // The two farthest apart meet halfway in time; if nobody else then takes
  // longer than they do, that's the group's middle.
  const [far1, far2] = farthestPair(points);
  const pair = await pairMiddle(far1, far2);
  if (allowed(pair.midpoint)) {
    const { rows } = await timesTo([pair.midpoint]);
    const at = rows.map((row) => row[0]);
    const pairLonger = Math.max(at[far1], at[far2]);
    if (at.every(isTime) && at.every((t, k) => k === far1 || k === far2 || t <= pairLonger + PAIR_SLACK_SEC)) {
      midpoint = pair.midpoint;
      balance = { time: Math.max(...at), reliable: pair.reliable };
      if (pair.bypass) notices.push(pair.bypass === 'failed' ? 'bypass-failed' : 'bypass');
    }
  }
  if (!midpoint) ({ midpoint, balance } = await areaMiddle());

  /**
   * Someone else would take longer than the farthest two (three or more about as
   * far apart): the fairest point in the area the group surrounds.
   */
  async function areaMiddle() {
    const circle = enclosingCircle(points);
    const ring = Math.max(MIN_RING_M, circle.radius * FIRST_RING);
    const samples = [];
    const sampleRows = points.map(() => []);
    /** Time the allowed ones of `candidates` and add them to the samples. */
    async function sample(candidates) {
      const fresh = candidates.filter(allowed);
      if (!fresh.length) return;
      const { rows, changed } = await timesTo(fresh);
      // A side that switched to driving: its earlier samples were by transit.
      if (changed.length && samples.length) {
        const redo = await timesFrom(samples, changed);
        for (const i of changed) sampleRows[i] = redo.rows[i];
      }
      samples.push(...fresh);
      rows.forEach((row, i) => sampleRows[i].push(...row));
    }

    await sample([circle.center, ...ringAround(circle.center, ring)]);
    // All of it beyond the Green Line: look further out for somewhere inside.
    if (!samples.length) await sample(ringAround(circle.center, ring * 2, RING_POINTS, 30));
    let best = fairestPoint(sampleRows, samples.length);
    if (best >= 0) {
      await sample(ringAround(samples[best], ring / 2, RING_POINTS, 30));
      best = fairestPoint(sampleRows, samples.length);
    }

    if (best >= 0) {
      return { midpoint: samples[best], balance: { time: Math.max(...sampleRows.map((row) => row[best])), reliable: true } };
    }
    // Nowhere everyone can reach (or nothing inside the line): the plain centre.
    return { midpoint: samples[0] || circle.center, balance: { time: null, reliable: false } };
  }

  // How far the group travels, in the terms search.js sizes its search area by:
  // the length of a route through the middle.
  const meanMeters = points.reduce((sum, p) => sum + haversine(midpoint, p), 0) / points.length;
  const spanMeters = 2 * meanMeters * ROAD_FACTOR;
  const radii = searchRadii(spanMeters);
  const maxCandidates = Math.min(MAX_CANDIDATES, provider.maxCandidates || MAX_CANDIDATES);
  const rankOptions = { preferOpen: !departure, priority: query.priority };

  onProgress('places');
  // As for two people: too few places (or none everyone can reach) around the
  // middle widens the search step by step; no place is timed twice.
  let ranked = [];
  let radius;
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
    // A side whose transit gives out only now drives to the places; the middle
    // isn't moved for it (its samples had service, so this is rare).
    const { rows } = await timesTo(candidates);
    ranked = rankGroupPlaces(candidates, rows, rankOptions);
  }
  if (radius > radii[0]) notices.push('widened');

  return {
    providerId: provider.id,
    group: true,
    points,
    modes,
    categories,
    departure,
    route: null,
    routeMeters: spanMeters,
    midpoint,
    radius,
    balance,
    priority: query.priority || 'balanced',
    places: ranked,
    notices,
  };
}

// Flat x/y meters around `origin`, for the circle geometry (offsetMeters undoes it).
function toXY(origin, p) {
  const { east, north } = metersFrom(origin, p);
  return { x: east, y: north };
}

function circumcircle(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null; // in a line: a pair's circle covers it
  const a2 = a.x ** 2 + a.y ** 2;
  const b2 = b.x ** 2 + b.y ** 2;
  const c2 = c.x ** 2 + c.y ** 2;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x, y, r: Math.hypot(a.x - x, a.y - y) };
}
