// Routes around the areas beyond the Green Line, for the "only inside the Green
// Line" filter: a meeting point found along a road through the West Bank would
// sit among places the filter leaves out.

import { haversine, pointAtFraction } from './geo.js';
import { beyondGreenLine } from './green-line.js';

/** A route may run this far (m) beyond the line and still count as inside. */
export const CROSSING_TOLERANCE = 3000;

/**
 * The old no-man's land at Latrun, part of the area in the data, which Route 1
 * and Route 3 (Modi'in) pass through: no one's way into the West Bank, so a
 * route's stretch here doesn't count. (Places here are still left out.)
 */
const LATRUN = [34.93, 31.81, 35.045, 31.88];

/**
 * Jerusalem: the West Bank all round but for the corridor to the west, so a
 * route out of it that must stay inside leaves on Route 1, by Sha'ar HaGai.
 */
const JERUSALEM = [35.08, 31.70, 35.30, 31.87];
const JERUSALEM_EXIT = 'shaar-hagai';

/**
 * Gates joined by a main road inside the line. A chain that goes from gate to
 * gate along these only needs the first and the last: the road in between is
 * the way the router goes anyway, and every gate on a highway risks a U-turn.
 */
const CORRIDORS = [
  ['shaar-hagai', 'ben-shemen'], // Route 1
  ['ben-shemen', 'eyal'], // Route 6
  ['eyal', 'wadi-ara'],
  ['ben-shemen', 'kiryat-gat'],
  ['kiryat-gat', 'lehavim'],
  ['shaar-hagai', 'beit-shemesh'], // Route 38
  ['wadi-ara', 'megiddo'], // Route 65
  ['megiddo', 'yizreel'], // Routes 66 and 71
  ['yizreel', 'hashitta'],
  ['lehavim', 'shoket'], // Route 31
  ['shoket', 'tel-arad'],
  ['tel-arad', 'zohar'],
];
const corridor = new Set(CORRIDORS.flatMap(([x, y]) => [`${x}|${y}`, `${y}|${x}`]));

/**
 * Points on main roads inside the line that the ways around the West Bank pass
 * through. A route forced through the right ones stays inside.
 */
export const GATES = [
  // Around Jerusalem and the center: Route 1, Route 38, Route 6.
  { id: 'shaar-hagai', lat: 31.80992, lng: 35.01953 },
  { id: 'beit-shemesh', lat: 31.75585, lng: 34.98379 },
  { id: 'ben-shemen', lat: 31.95594, lng: 34.93643 },
  { id: 'eyal', lat: 32.20731, lng: 34.96433 },
  // South: Route 6 to Beersheba, Route 31 to Arad and the Dead Sea.
  { id: 'kiryat-gat', lat: 31.60435, lng: 34.81332 },
  { id: 'lehavim', lat: 31.37908, lng: 34.82068 },
  { id: 'shoket', lat: 31.3058, lng: 34.89028 },
  { id: 'tel-arad', lat: 31.2540, lng: 35.12461 },
  { id: 'zohar', lat: 31.14146, lng: 35.35992 },
  // North: Wadi Ara, the Jezreel Valley, Route 71 to Beit She'an.
  { id: 'wadi-ara', lat: 32.51434, lng: 35.12 }, // Me Ami junction, Route 65
  { id: 'megiddo', lat: 32.57287, lng: 35.1919 },
  { id: 'yizreel', lat: 32.55814, lng: 35.31813 },
  { id: 'hashitta', lat: 32.54306, lng: 35.43461 },
];

/**
 * A meter of straight line beyond the line (past the tolerance) costs this many
 * meters more, when choosing gates.
 */
const BEYOND_PENALTY = 4;
/** Each gate costs this much (m), so a chain uses no more gates than it needs. */
const GATE_COST = 3000;

/**
 * Where the straight segment p→q crosses the rings of `polygon`, as fractions
 * of the segment (0..1), sorted. Plane geometry in degrees: fine at this scale.
 */
function crossings(p, q, rings) {
  const ts = [];
  const dx = q.lng - p.lng;
  const dy = q.lat - p.lat;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j];
      const [x2, y2] = ring[i];
      const ex = x2 - x1;
      const ey = y2 - y1;
      const denom = dx * ey - dy * ex;
      if (denom === 0) continue; // parallel
      const t = ((x1 - p.lng) * ey - (y1 - p.lat) * ex) / denom;
      const u = ((x1 - p.lng) * dy - (y1 - p.lat) * dx) / denom;
      if (t > 0 && t < 1 && u >= 0 && u < 1) ts.push(t);
    }
  }
  return ts.sort((x, y) => x - y);
}

const inBox = ([w, s, e, n], p) => p.lng >= w && p.lng <= e && p.lat >= s && p.lat <= n;

/** The part of segment p→q inside box [w, s, e, n], or null (Liang–Barsky). */
function clip([w, s, e, n], p, q) {
  let t0 = 0;
  let t1 = 1;
  const dx = q.lng - p.lng;
  const dy = q.lat - p.lat;
  for (const [edge, delta] of [
    [p.lng - w, -dx],
    [e - p.lng, dx],
    [p.lat - s, -dy],
    [n - p.lat, dy],
  ]) {
    if (delta === 0) {
      if (edge < 0) return null;
    } else {
      const t = edge / delta;
      if (delta < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  if (t0 >= t1) return null;
  const at = (t) => ({ lat: p.lat + dy * t, lng: p.lng + dx * t });
  return [at(t0), at(t1)];
}

/** Meters of the straight segment p→q beyond the line, not counting the Latrun no-man's land. */
function segmentBeyond(areas, p, q) {
  const latrun = clip(LATRUN, p, q);
  return rawBeyond(areas, p, q) - (latrun ? rawBeyond(areas, ...latrun) : 0);
}

/** Meters of the straight segment p→q that lie beyond the line. */
function rawBeyond(areas, p, q) {
  const w = Math.min(p.lng, q.lng);
  const e = Math.max(p.lng, q.lng);
  const s = Math.min(p.lat, q.lat);
  const n = Math.max(p.lat, q.lat);
  let fraction = 0;
  for (const area of areas) {
    const [aw, as, ae, an] = area.box;
    if (e < aw || w > ae || n < as || s > an) continue;
    const ts = crossings(p, q, area.rings);
    // Inside and outside alternate at each crossing (holes included).
    let inside = beyondGreenLine([area], p);
    let from = 0;
    for (const t of [...ts, 1]) {
      if (inside) fraction += t - from;
      inside = !inside;
      from = t;
    }
  }
  return fraction * haversine(p, q);
}

/** Meters of `path` ([{lat, lng}]) beyond the line. */
export function lengthBeyond(areas, path) {
  let meters = 0;
  for (let i = 1; i < path.length; i++) meters += segmentBeyond(areas, path[i - 1], path[i]);
  return meters;
}

/** Whether a route along `path` goes through the areas beyond the line. */
export const crossesLine = (areas, path) => lengthBeyond(areas, path) > CROSSING_TOLERANCE;

/**
 * Whether `path` turns back on itself: it returns within 40 m of a point after
 * going on for more than 1.5 km (a via point snapped to the far carriageway).
 * Not in its first and last 2 km, where a loop round the block is just the way
 * out of a one-way street.
 */
export function hasUturn(path) {
  const along = [0];
  for (let i = 1; i < path.length; i++) along.push(along[i - 1] + haversine(path[i - 1], path[i]));
  const total = along[along.length - 1];
  for (let i = 0; i < path.length; i++) {
    if (along[i] < 2000 || along[i] > total - 2000) continue;
    let d = 0;
    for (let j = i + 1; j < path.length && d <= 15000; j++) {
      d += haversine(path[j - 1], path[j]);
      if (d > 1500 && haversine(path[i], path[j]) < 40) return true;
    }
  }
  return false;
}

/**
 * Gates to take a route around the stretches of `path` beyond the line: for
 * each stretch longer than the tolerance, the gate chain from the last point
 * inside before it to the first point inside after it. Only where the route
 * really crosses: a straight line from the start can cross where roads don't.
 */
export function bypassGates(areas, path, gates = GATES) {
  const chain = [];
  let start = -1;
  for (let i = 0; i <= path.length; i++) {
    const beyond = i < path.length && beyondGreenLine(areas, path[i]);
    if (beyond && start === -1) start = i;
    if (beyond || start === -1) continue;
    // path[start..i-1] is beyond the line; path[start-1] and path[i] (if any) aren't.
    const from = path[Math.max(0, start - 1)];
    const to = path[Math.min(path.length - 1, i)];
    if (lengthBeyond(areas, path.slice(Math.max(0, start - 1), i + 1)) > CROSSING_TOLERANCE) {
      for (const gate of gateChain(areas, from, to, gates)) if (chain[chain.length - 1] !== gate) chain.push(gate);
    }
    start = -1;
  }
  return chain;
}

/**
 * The nearest point of `path` to `fraction` (of its length) that is inside the
 * line, looking both ways: {fraction, point}, or null if there is none.
 */
export function insideAlong(areas, path, fraction, step = 0.005) {
  for (let d = step; d <= 1; d += step) {
    for (const f of [fraction - d, fraction + d]) {
      if (f <= 0 || f >= 1) continue;
      const point = pointAtFraction(path, f);
      if (!beyondGreenLine(areas, point)) return { fraction: f, point };
    }
  }
  return null;
}

/**
 * The gates a route from a to b should be forced through, in order, to stay
 * inside the line: the cheapest chain where a straight leg costs its length
 * plus a heavy penalty for every meter of it beyond the line. Empty when the
 * straight way is the cheapest.
 */
export function gateChain(areas, a, b, gates = GATES) {
  const nodes = [a, ...gates, b];
  const end = nodes.length - 1;
  const cost = new Map();
  // Out of (or into) Jerusalem only by its exit gate, unless both ends are there.
  const exit = nodes.findIndex((n) => n.id === JERUSALEM_EXIT);
  const walled = (i) => (i === 0 || i === end) && inBox(JERUSALEM, nodes[i]) && !(inBox(JERUSALEM, a) && inBox(JERUSALEM, b));
  const legCost = (i, j) => {
    if (exit > 0 && ((walled(i) && j !== exit) || (walled(j) && i !== exit))) return Infinity;
    const key = i < j ? `${i}-${j}` : `${j}-${i}`;
    if (!cost.has(key)) {
      const beyond = Math.max(0, segmentBeyond(areas, nodes[i], nodes[j]) - CROSSING_TOLERANCE);
      cost.set(key, haversine(nodes[i], nodes[j]) + BEYOND_PENALTY * beyond);
    }
    return cost.get(key) + (j === end ? 0 : GATE_COST);
  };
  // Dijkstra on the complete graph (a dozen nodes).
  const dist = nodes.map(() => Infinity);
  const prev = nodes.map(() => -1);
  const done = new Set();
  dist[0] = 0;
  while (done.size < nodes.length) {
    let i = -1;
    for (let k = 0; k < nodes.length; k++) if (!done.has(k) && (i === -1 || dist[k] < dist[i])) i = k;
    if (i === end || dist[i] === Infinity) break;
    done.add(i);
    for (let j = 1; j < nodes.length; j++) {
      if (done.has(j)) continue;
      const d = dist[i] + legCost(i, j);
      if (d < dist[j]) {
        dist[j] = d;
        prev[j] = i;
      }
    }
  }
  const chain = [];
  for (let k = prev[end]; k > 0; k = prev[k]) chain.unshift(nodes[k]);
  return collapse(chain);
}

/** Keep only the first and the last gate of each run along a corridor. */
function collapse(chain) {
  return chain.filter((g, i) => {
    const prev = chain[i - 1];
    const next = chain[i + 1];
    return !(prev && next && corridor.has(`${prev.id}|${g.id}`) && corridor.has(`${g.id}|${next.id}`));
  });
}
