// Scoring candidate places by how fair and how close they are for both sides.

const isTime = (t) => typeof t === 'number' && Number.isFinite(t) && t >= 0;

/** Minutes of "travel" a great rating is worth; a poor rating costs the same. */
const RATING_WEIGHT_MIN = 6;
/**
 * What the user said matters more, as how much each minute of difference
 * between the sides counts against a place (on top of the average trip):
 * equal  – both sides travel about the same, even if both travel longer;
 * gap    – a bigger gap between the sides is fine, for a place nearer overall;
 * balanced – in between (the longer trip plus 1.2× the difference).
 */
export const PRIORITIES = { equal: 3.5, balanced: 1.7, gap: 0.2 };
/** Penalty (minutes) for a place known to be closed when leaving now. */
const CLOSED_PENALTY_MIN = 15;

/**
 * How much the trips of a group's others count (as a share of their average, in
 * minutes): a little, so that between two places equally fair to the two who
 * travel most, the one nearer everyone else comes first.
 */
const REST_WEIGHT = 0.1;

/**
 * The travel part of a score, in minutes. Two sides: their average trip plus
 * the difference between them, weighted by `priority`. A group is held to the
 * same by its two longest trips: those two should be about the same and short,
 * and everyone else travels less anyway (and counts only a little). Lower is better.
 */
export function travelScore(times, priority = 'balanced') {
  const [longest, second = longest, ...rest] = [...times].sort((x, y) => y - x);
  const meanMin = (longest + second) / 2 / 60;
  const gapMin = (longest - second) / 60;
  const restMin = rest.length ? rest.reduce((sum, t) => sum + t, 0) / rest.length / 60 : 0;
  return meanMin + (PRIORITIES[priority] ?? PRIORITIES.balanced) * gapMin + REST_WEIGHT * restMin;
}

/** The gap between the two longest trips (for two sides, the difference between them). */
export function topGap(times) {
  const [longest, second = longest] = [...times].sort((x, y) => y - x);
  return longest - second;
}

/**
 * Lower score is better: the average of the two trips plus the difference
 * between them (weighted by `priority`), adjusted by rating (weighted by how
 * many reviews back it up).
 */
export function scorePlace(place, timeA, timeB, options = {}) {
  return scoreTimes(place, [timeA, timeB], options);
}

/** scorePlace for any number of sides: `times` holds each side's trip (seconds). */
export function scoreTimes(place, times, { preferOpen = false, priority = 'balanced' } = {}) {
  let score = travelScore(times, priority);
  if (Number.isFinite(place.rating) && place.rating > 0) {
    const confidence = Math.min(1, Math.log10((place.ratingCount || 0) + 1) / 3);
    score -= (place.rating - 4) * RATING_WEIGHT_MIN * confidence;
  }
  if (preferOpen && place.openNow === false) score += CLOSED_PENALTY_MIN;
  return score;
}

/**
 * Attach travel times to each place and sort best-first. Places that either side
 * cannot reach are dropped.
 */
export function rankPlaces(places, timesA, timesB, options = {}) {
  return places
    .map((place, i) => ({ place, timeA: timesA[i], timeB: timesB[i] }))
    .filter(({ timeA, timeB }) => isTime(timeA) && isTime(timeB))
    .map(({ place, timeA, timeB }) => ({
      ...place,
      timeA,
      timeB,
      diff: Math.abs(timeA - timeB),
      score: scorePlace(place, timeA, timeB, options),
    }))
    .sort((x, y) => x.score - y.score);
}

/**
 * rankPlaces for a group: `timesBySide[side][place]`. Each ranked place carries
 * `times` (one per side, in the sides' order) and `diff`, the gap between the
 * two longest trips. Places that anyone cannot reach are dropped.
 */
export function rankGroupPlaces(places, timesBySide, options = {}) {
  return places
    .map((place, i) => ({ place, times: timesBySide.map((row) => row?.[i]) }))
    .filter(({ times }) => times.every(isTime))
    .map(({ place, times }) => ({
      ...place,
      times,
      diff: topGap(times),
      score: scoreTimes(place, times, options),
    }))
    .sort((x, y) => x.score - y.score);
}

/** `ranked` (from rankPlaces or rankGroupPlaces) scored again with other options, e.g. another priority. */
export function rerankPlaces(ranked, options = {}) {
  return ranked
    .map((p) => ({ ...p, score: p.times ? scoreTimes(p, p.times, options) : scorePlace(p, p.timeA, p.timeB, options) }))
    .sort((x, y) => x.score - y.score);
}

/**
 * The best `limit` places, with no category taking more than `perCategory` slots
 * so a mixed search doesn't come back as twenty cafés.
 */
export function pickTop(ranked, { limit = 20, perCategory = Infinity } = {}) {
  const counts = new Map();
  const picked = [];
  const overflow = [];
  for (const p of ranked) {
    const n = counts.get(p.category) || 0;
    if (n < perCategory) {
      counts.set(p.category, n + 1);
      picked.push(p);
    } else {
      overflow.push(p);
    }
    if (picked.length >= limit) break;
  }
  // If the cap left empty slots (few categories selected), fill them in order.
  for (const p of overflow) {
    if (picked.length >= limit) break;
    picked.push(p);
  }
  return picked.sort((x, y) => x.score - y.score);
}

/**
 * 'great' | 'good' | 'fair' — how evenly the trip is split between the sides:
 * fairnessLevel(timeA, timeB), or fairnessLevel([t1, t2, t3, ...]) for a group,
 * judged by its two longest trips.
 */
export function fairnessLevel(...args) {
  const times = Array.isArray(args[0]) ? args[0] : args;
  const longer = Math.max(...times, 1);
  const diff = topGap(times);
  if (diff <= 3 * 60 || diff / longer <= 0.08) return 'great';
  if (diff <= 8 * 60 || diff / longer <= 0.2) return 'good';
  return 'fair';
}

/** Collapse duplicates (same id, or same name within ~60 m) keeping the first. */
export function dedupePlaces(places) {
  const seenIds = new Set();
  const kept = [];
  for (const p of places) {
    if (seenIds.has(p.id)) continue;
    const near = kept.find(
      (k) =>
        k.name === p.name &&
        Math.abs(k.lat - p.lat) < 0.0006 &&
        Math.abs(k.lng - p.lng) < 0.0006,
    );
    if (near) continue;
    seenIds.add(p.id);
    kept.push(p);
  }
  return kept;
}
