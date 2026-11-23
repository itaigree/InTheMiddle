// A search's free (OpenStreetMap) results, stored to be shared as they are: the
// recipient sees them without searching again. What goes into one, and a strict
// check of one that comes back. The share service (worker/share.js) checks with
// the same code before it stores anything.
//
// Only OpenStreetMap results are stored: Google's terms don't allow keeping its
// data (names, ratings, coordinates, travel times), so a Google search is shared
// as a link that searches again.

import { CATEGORY_IDS } from './categories.js';
import { MODES, PRIORITIES, PLACE_ID_RE, SNAPSHOT_ID_RE } from './state.js';
import { haversine, metersFrom } from './geo.js';

export const SNAPSHOT_VERSION = 1;
/** A snapshot's id: 12 random URL-safe characters (72 bits), made by the sender's browser. */
export { SNAPSHOT_ID_RE };
/** The most a stored snapshot may weigh (a usual one is around 10 KB). */
export const MAX_SNAPSHOT_BYTES = 64 * 1024;

/** The notices a snapshot passes on ('departure-past' was about the sender's own search). */
export const SNAPSHOT_NOTICES = [
  'transit-unsupported',
  'transit-no-service',
  'transit-error',
  'bypass',
  'bypass-failed',
  'widened',
  'green-line',
  'shabbat',
  'green-line-places-only',
  'shabbat-busy',
];

const MAX_PLACES = 100;
const MAX_ROUTE_POINTS = 4000;
/** How far the drawn route may stray from the real one (it's simplified to keep the snapshot small). */
const ROUTE_TOLERANCE_M = 10;
/** The route drawn from a sender's own position starts this far from it (their doorstep stays private). */
const PRIVATE_RADIUS_M = 300;

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** The secret a snapshot is stored with: 22 URL-safe characters (128 random bits). */
export const SNAPSHOT_KEY_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * A snapshot's id: the start of its key's SHA-256. The sender keeps the key and
 * shares the id, so a link's holder can't store anything under it (that would
 * take the key), and the service needn't look before it stores: a look leaves a
 * "not found" cached where the results are about to be read.
 */
export async function snapshotIdOf(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return base64url(new Uint8Array(digest)).slice(0, 12);
}

/** A new key and its id, from the browser's secure random numbers. */
export async function newSnapshotKey() {
  const key = base64url(crypto.getRandomValues(new Uint8Array(16)));
  return { key, id: await snapshotIdOf(key) };
}

const round5 = (x) => Math.round(x * 1e5) / 1e5;
const pointOut = (p) => ({ lat: round5(p.lat), lng: round5(p.lng) });

/**
 * The snapshot of results on screen, ready to store.
 * @param {object} o
 * @param {number} o.at  when the search was made (ms)
 * @param {{label: string, lat: number, lng: number, mode: string}[]} o.points  the starting
 *   points in order (א, ב, then the others), as a shared link shows them (see main.js forLink)
 * @param {{lat: number, lng: number}[]} [o.privatePoints]  exact positions the route must not lead to
 * @param {object} o.result  the result on screen (core/search.js or core/group.js), from OpenStreetMap
 * @param {object} o.query  its filters: categories, departure (Date|null), greenLine, shabbat, priority
 */
export function makeSnapshot({ at, points, privatePoints = [], result, query }) {
  const group = points.length > 2;
  return {
    v: SNAPSHOT_VERSION,
    at,
    points: points.map((p) => ({ label: p.label, ...pointOut(p), mode: p.mode })),
    categories: [...query.categories],
    departure: query.departure ? query.departure.toISOString() : null,
    greenLine: Boolean(query.greenLine),
    shabbat: Boolean(query.shabbat),
    priority: result.priority || query.priority || 'balanced',
    midpoint: pointOut(result.midpoint),
    radius: Math.round(result.radius),
    balance: {
      time: Number.isFinite(result.balance?.time) ? Math.round(result.balance.time) : null,
      reliable: Boolean(result.balance?.reliable),
    },
    route: group ? null : routeOut(result.route, privatePoints),
    notices: result.notices.filter((n) => SNAPSHOT_NOTICES.includes(n)),
    places: result.places.map((p) => ({
      id: p.id,
      name: p.name,
      ...pointOut(p),
      category: p.category,
      ...(p.typeLabel && { typeLabel: p.typeLabel }),
      ...(p.address && { address: p.address }),
      openNow: typeof p.openNow === 'boolean' ? p.openNow : null,
      closedOnShabbat: typeof p.closedOnShabbat === 'boolean' ? p.closedOnShabbat : null,
      times: (p.times || [p.timeA, p.timeB]).map((t) => Math.round(t)),
    })),
  };
}

/** The route to draw: simplified, rounded, and kept away from the sender's own position. */
function routeOut(route, privatePoints) {
  if (!Array.isArray(route) || route.length < 2) return null;
  // Cut first, on the full route, then simplify what's left.
  const near = (p) => privatePoints.some((q) => haversine(p, q) < PRIVATE_RADIUS_M);
  let start = 0;
  let end = route.length;
  while (start < end && near(route[start])) start++;
  while (end > start && near(route[end - 1])) end--;
  const path = simplify(route.slice(start, end), ROUTE_TOLERANCE_M);
  return path.length >= 2 ? path.map((p) => [round5(p.lat), round5(p.lng)]) : null;
}

/** Douglas–Peucker, in meters on a flat patch around the first point (no recursion: routes are long). */
export function simplify(path, tolerance) {
  if (path.length < 3) return path.slice();
  const origin = path[0];
  const xy = path.map((p) => {
    const { east, north } = metersFrom(origin, p);
    return [east, north];
  });
  const keep = new Uint8Array(path.length);
  keep[0] = keep[path.length - 1] = 1;
  const stack = [[0, path.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop();
    const [ax, ay] = xy[from];
    const [bx, by] = xy[to];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstDist = tolerance;
    for (let i = from + 1; i < to; i++) {
      const [px, py] = xy[i];
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (dist > worstDist) {
        worstDist = dist;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([from, worst], [worst, to]);
  }
  return path.filter((_, i) => keep[i]);
}

// ------------------------------------------------------------------ checking

const isText = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const isCoord = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const isLatLng = (p) => p !== null && typeof p === 'object' && isCoord(p.lat, p.lng);
const isSeconds = (t) => Number.isFinite(t) && t >= 0 && t <= 7 * 24 * 3600;
const isTriState = (x) => x === true || x === false || x === null || x === undefined;

/**
 * A snapshot that came from elsewhere (the share service, so anyone may have
 * written it), checked field by field and rebuilt from what passed: anything
 * missing, malformed or unknown means null. Nothing beyond these fields is kept,
 * so no link, picture or markup can come through.
 */
export function parseSnapshot(value) {
  const s = value;
  if (!s || typeof s !== 'object' || s.v !== SNAPSHOT_VERSION) return null;
  if (!Number.isFinite(s.at) || s.at <= 0) return null;
  if (!Array.isArray(s.points) || s.points.length < 2 || s.points.length > 5) return null;
  if (!s.points.every((p) => isLatLng(p) && isText(p.label, 200) && MODES.includes(p.mode))) return null;
  const n = s.points.length;
  if (!Array.isArray(s.categories) || !s.categories.length || !s.categories.every((c) => CATEGORY_IDS.includes(c))) return null;
  if (new Set(s.categories).size !== s.categories.length) return null;
  if (s.departure !== null && !(typeof s.departure === 'string' && s.departure.length <= 40 && Number.isFinite(Date.parse(s.departure)))) {
    return null;
  }
  if (typeof s.greenLine !== 'boolean' || typeof s.shabbat !== 'boolean' || !PRIORITIES.includes(s.priority)) return null;
  if (!isLatLng(s.midpoint) || !Number.isFinite(s.radius) || s.radius <= 0 || s.radius > 200000) return null;
  const balance = s.balance;
  if (!balance || typeof balance !== 'object' || typeof balance.reliable !== 'boolean') return null;
  if (balance.time !== null && !isSeconds(balance.time)) return null;
  if (s.route !== null) {
    if (n > 2 || !Array.isArray(s.route) || s.route.length < 2 || s.route.length > MAX_ROUTE_POINTS) return null;
    if (!s.route.every((p) => Array.isArray(p) && p.length === 2 && isCoord(p[0], p[1]))) return null;
  }
  if (!Array.isArray(s.notices) || !s.notices.every((x) => SNAPSHOT_NOTICES.includes(x))) return null;
  if (!Array.isArray(s.places) || s.places.length > MAX_PLACES) return null;
  const places = [];
  const ids = new Set();
  for (const p of s.places) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !PLACE_ID_RE.test(p.id) || ids.has(p.id)) return null;
    if (!isText(p.name, 200) || !isLatLng(p) || !CATEGORY_IDS.includes(p.category)) return null;
    if (p.typeLabel !== undefined && !isText(p.typeLabel, 100)) return null;
    if (p.address !== undefined && !isText(p.address, 300)) return null;
    if (!isTriState(p.openNow) || !isTriState(p.closedOnShabbat)) return null;
    if (!Array.isArray(p.times) || p.times.length !== n || !p.times.every(isSeconds)) return null;
    ids.add(p.id);
    places.push({
      id: p.id,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      category: p.category,
      ...(p.typeLabel !== undefined && { typeLabel: p.typeLabel }),
      ...(p.address !== undefined && { address: p.address }),
      openNow: p.openNow ?? null,
      closedOnShabbat: p.closedOnShabbat ?? null,
      times: [...p.times],
    });
  }
  return {
    v: SNAPSHOT_VERSION,
    at: s.at,
    points: s.points.map((p) => ({ label: p.label.trim(), lat: p.lat, lng: p.lng, mode: p.mode })),
    categories: [...s.categories],
    departure: s.departure,
    greenLine: s.greenLine,
    shabbat: s.shabbat,
    priority: s.priority,
    midpoint: { lat: s.midpoint.lat, lng: s.midpoint.lng },
    radius: s.radius,
    balance: { time: balance.time, reliable: balance.reliable },
    route: s.route ? s.route.map(([lat, lng]) => [lat, lng]) : null,
    notices: [...new Set(s.notices)],
    places,
  };
}

/**
 * A checked snapshot as the app's own search and result (as core/search.js and
 * core/group.js make them), to show without searching. The places keep their
 * order; the caller scores them (core/ranking.js) for the list.
 */
export function snapshotToSearch(s) {
  const departure = s.departure ? new Date(s.departure) : null;
  const points = s.points.map(({ label, lat, lng }) => ({ label, lat, lng, source: 'link' }));
  const modes = s.points.map((p) => p.mode);
  const [a, b, ...extra] = points;
  const query = {
    a,
    b,
    extra: extra.map((p, i) => ({ ...p, mode: modes[i + 2] })),
    modeA: modes[0],
    modeB: modes[1],
    categories: [...s.categories],
    departure,
    greenLine: s.greenLine,
    shabbat: s.shabbat,
    priority: s.priority,
  };
  const group = points.length > 2;
  const common = {
    providerId: 'osm',
    categories: [...s.categories],
    departure,
    midpoint: s.midpoint,
    radius: s.radius,
    balance: s.balance,
    priority: s.priority,
    notices: [...s.notices],
    sharedAt: new Date(s.at),
  };
  const result = group
    ? {
        ...common,
        group: true,
        points: points.map(({ lat, lng }) => ({ lat, lng })),
        modes,
        route: null,
        places: s.places.map(({ times, ...p }) => ({ ...p, times, diff: Math.max(...times) - Math.min(...times) })),
      }
    : {
        ...common,
        a: { lat: a.lat, lng: a.lng },
        b: { lat: b.lat, lng: b.lng },
        modeA: modes[0],
        modeB: modes[1],
        route: s.route ? s.route.map(([lat, lng]) => ({ lat, lng })) : null,
        places: s.places.map(({ times: [timeA, timeB], ...p }) => ({ ...p, timeA, timeB, diff: Math.abs(timeA - timeB) })),
      };
  return { query, result };
}
