// Search state <-> URL query string, so a search can be shared as a link.

export const MODES = ['car', 'transit'];
/**
 * The link keys of the starting points after א and ב (ג, ד, ה: points 3 to 5),
 * each like `a`: `p3` the name, `p3ll` the coordinates, `p3m` the mode when it
 * isn't car. (Not `c`: that one is the kinds of places.)
 */
export const EXTRA_KEYS = ['p3', 'p4', 'p5'];
/** What matters more when no place is exactly in the middle (see core/ranking.js). */
export const PRIORITIES = ['equal', 'balanced', 'gap'];

function encodePoint(p) {
  return `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
}

function decodePoint(text) {
  if (!text) return null;
  // Number('') is 0: an empty part ("32.1," or ",") is a broken link, not the equator.
  const parts = text.split(',').map((part) => (part.trim() ? Number(part) : NaN));
  if (parts.length !== 2 || !parts.every(Number.isFinite)) return null;
  const [lat, lng] = parts;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

const DEPARTURE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * @param {object} state
 * @param {{label: string, lat?: number, lng?: number}|null} state.a
 * @param {{label: string, lat?: number, lng?: number}|null} state.b
 * @param {'car'|'transit'} state.modeA
 * @param {'car'|'transit'} state.modeB
 * @param {string[]} state.categories
 * @param {string|null} state.departure  local "YYYY-MM-DDTHH:MM", null = now
 * @param {boolean} [state.greenLine]  only places inside the Green Line
 * @param {boolean} [state.shabbat]  only cafes and restaurants closed on Shabbat
 * @param {'equal'|'balanced'|'gap'} [state.priority]  what matters more (balanced is left out)
 * @param {string|null} [state.provider]  forced provider id, normally null
 * @param {{label: string, lat?: number, lng?: number, mode?: 'car'|'transit'}[]} [state.extra]
 *   more starting points, after א and ב (up to EXTRA_KEYS.length)
 */
export function encodeState(state) {
  const params = new URLSearchParams();
  const extra = (state.extra || []).filter((p) => p?.label).slice(0, EXTRA_KEYS.length);
  for (const [key, loc, mode] of [
    ['a', state.a, state.modeA],
    ['b', state.b, state.modeB],
    ...extra.map((p, i) => [EXTRA_KEYS[i], p, p.mode]),
  ]) {
    if (!loc || !loc.label) continue;
    params.set(key, loc.label);
    if (Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) params.set(`${key}ll`, encodePoint(loc));
    if (mode && mode !== 'car') params.set(`${key}m`, mode);
  }
  if (state.categories && state.categories.length) params.set('c', state.categories.join(','));
  if (state.departure) params.set('t', state.departure);
  if (state.greenLine) params.set('g', '1');
  if (state.shabbat) params.set('s', '1');
  if (PRIORITIES.includes(state.priority) && state.priority !== 'balanced') params.set('f', state.priority);
  if (state.provider) params.set('p', state.provider);
  return params.toString();
}

/** Parse a query string; unknown or malformed values are dropped. */
export function decodeState(search, { knownCategories = null } = {}) {
  const params = new URLSearchParams(search);
  const result = {
    a: null,
    b: null,
    modeA: 'car',
    modeB: 'car',
    categories: null,
    departure: null,
    greenLine: false,
    shabbat: false,
    priority: 'balanced',
    provider: null,
    extra: [],
  };
  const pointAt = (key) => {
    const label = (params.get(key) || '').trim().slice(0, 200);
    if (!label) return null;
    const point = decodePoint(params.get(`${key}ll`));
    const mode = params.get(`${key}m`);
    return { loc: point ? { label, ...point } : { label }, mode: MODES.includes(mode) ? mode : 'car' };
  };
  for (const key of ['a', 'b']) {
    const found = pointAt(key);
    if (!found) continue;
    result[key] = found.loc;
    result[key === 'a' ? 'modeA' : 'modeB'] = found.mode;
  }
  // The points after א and ב, in order (a gap in the keys closes up).
  for (const key of EXTRA_KEYS) {
    const found = pointAt(key);
    if (found) result.extra.push({ ...found.loc, mode: found.mode });
  }
  const cats = params.get('c');
  if (cats) {
    const list = [...new Set(cats.split(',').map((s) => s.trim()).filter(Boolean))];
    const filtered = knownCategories ? list.filter((c) => knownCategories.includes(c)) : list;
    if (filtered.length) result.categories = filtered;
  }
  const t = params.get('t');
  if (t && DEPARTURE_RE.test(t) && !Number.isNaN(new Date(t).getTime())) result.departure = t;
  result.greenLine = params.get('g') === '1';
  result.shabbat = params.get('s') === '1';
  // 'short' was the first name of 'gap'.
  const f = params.get('f') === 'short' ? 'gap' : params.get('f');
  if (PRIORITIES.includes(f)) result.priority = f;
  const p = params.get('p');
  if (p === 'osm' || p === 'google') result.provider = p;
  return result;
}
