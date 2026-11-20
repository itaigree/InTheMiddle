// The search for three or more people. (Two people use core/search.js, which finds
// the middle along the road between them.) A group has no one road between it, so
// the middle is looked for in the area the group surrounds:
//
//   1. Start at the centre of the smallest circle around everyone: the point whose
//      farthest person is nearest, as the crow flies.
//   2. Time a ring of points around it from every side, and move to the one whose
//      longest trip is shortest: the same aim by road, and what the summary
//      reports. It can never pick a point worse for everyone, and it doesn't
//      depend on the priority, so changing that later re-sorts without searching
//      again.
//   3. Try a tighter ring around that point.
//   4. Search for places around the winner and rank them as for two people, with
//      the gap between the longest and the shortest trip in place of the
//      difference between the two.
//
// The rings cost (people × points) travel-time lookups, which Google bills, so
// they are kept small: 7 points, then 6.

import { haversine, offsetMeters, metersFrom } from './geo.js';
import { searchRadii } from './midpoint.js';
import { rankGroupPlaces, dedupePlaces } from './ranking.js';
import { selectCandidates, MAX_CANDIDATES, MIN_PLACES } from './search.js';
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

/** `count` points evenly around `center`, `radius` meters away, the first `rotation` degrees east of north. */
export function ringAround(center, radius, count = RING_POINTS, rotation = 0) {
  return Array.from({ length: count }, (_, i) => {
    const angle = ((rotation + (i * 360) / count) * Math.PI) / 180;
    return offsetMeters(center, radius * Math.sin(angle), radius * Math.cos(angle));
  });
}

/**
 * Which of the sampled points is fairest for the group: among the points everyone
 * can reach, the index of the one whose longest trip is shortest (on a tie, the
 * shorter trips on average), or -1. `rows[side][point]` are travel times in seconds.
 *
 * The longest trip is what the enclosing circle approximates and what the summary
 * reports, and a point worse for everyone can never win by it. The measure places
 * are ranked by rewards a smaller gap, so it could: with one person between the
 * others, it moved the middle off to the side, where everyone travels further.
 * The middle doesn't depend on the priority, so changing it still only re-sorts.
 */
export function fairestPoint(rows, count) {
  let best = -1;
  let bestLongest = Infinity;
  let bestMean = Infinity;
  for (let j = 0; j < count; j++) {
    const times = rows.map((row) => row[j]);
    if (!times.every(isTime)) continue;
    const longest = Math.max(...times);
    const mean = times.reduce((sum, t) => sum + t, 0) / times.length;
    if (longest < bestLongest || (longest === bestLongest && mean < bestMean)) {
      bestLongest = longest;
      bestMean = mean;
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

  /**
   * Travel times (seconds) from each side to `dests`, as rows[side][dest]: one
   * request per mode. Sides in `reuse` (side -> row) keep the row they have. A
   * transit request that fails outright (as opposed to finding no service)
   * yields nulls and lists its sides in `failed`.
   */
  async function timesFrom(dests, reuse = {}) {
    const rows = points.map((_, i) => reuse[i] || null);
    const failed = [];
    const byMode = new Map();
    rows.forEach((row, i) => {
      if (row) return;
      if (!byMode.has(modes[i])) byMode.set(modes[i], []);
      byMode.get(modes[i]).push(i);
    });
    await Promise.all(
      [...byMode].map(async ([mode, sides]) => {
        try {
          // People starting from the same place are timed once (Google bills each origin).
          const origins = [];
          const at = sides.map((i) => {
            const k = origins.findIndex((o) => o.lat === points[i].lat && o.lng === points[i].lng);
            return k >= 0 ? k : origins.push(points[i]) - 1;
          });
          const m = await provider.travelTimes(origins, dests, mode, opts);
          // A copy each: sample() later pushes onto every side's row.
          sides.forEach((i, k) => {
            rows[i] = m[at[k]] ? [...m[at[k]]] : dests.map(() => null);
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

  /** Rows to reuse: every side's but `changed`. */
  const reuseExcept = (rows, changed) => Object.fromEntries(rows.map((row, i) => [i, row]).filter(([i]) => !changed.includes(i)));

  /**
   * timesFrom, but a transit side that failed or found no service at all
   * (Shabbat, night) switches to driving and is timed again. Returns the rows
   * and the sides that switched.
   */
  async function timesTo(dests) {
    const { rows, failed } = await timesFrom(dests);
    const changed = [];
    rows.forEach((row, i) => {
      if (modes[i] !== 'transit') return;
      if (failed.includes(i)) addNotice('transit-error');
      else if (!row.some(isTime)) addNotice('transit-no-service');
      else return;
      modes[i] = 'car';
      changed.push(i);
    });
    if (!changed.length) return { rows, changed };
    return { rows: (await timesFrom(dests, reuseExcept(rows, changed))).rows, changed };
  }

  onProgress('balance');
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
      const redo = await timesFrom(samples, reuseExcept(sampleRows, changed));
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

  let midpoint;
  let balance;
  if (best >= 0) {
    midpoint = samples[best];
    balance = { time: Math.max(...sampleRows.map((row) => row[best])), reliable: true };
  } else {
    // Nowhere everyone can reach (or nothing inside the line): the plain centre.
    midpoint = samples[0] || circle.center;
    balance = { time: null, reliable: false };
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
  // But someone who reaches none of the points the others reach is cut off from
  // them (no road between): no place could have everyone's times, so don't pay
  // for looking.
  const cutOff = best < 0 && sampleRows.some((row) => !row.some(isTime)) && sampleRows.some((row) => row.some(isTime));
  let ranked = [];
  let radius = radii[0];
  const found = [];
  const checked = new Set();
  for (let step = 0; step < radii.length && !ranked.length && !cutOff; step++) {
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
