// Scoring candidate places by how fair and how close they are for both sides.

const isTime = (t) => typeof t === 'number' && Number.isFinite(t) && t >= 0;

/** Minutes of "travel" a great rating is worth; a poor rating costs the same. */
const RATING_WEIGHT_MIN = 6;
/** How much each minute of imbalance between the sides counts against a place. */
const IMBALANCE_WEIGHT = 1.2;
/** Penalty (minutes) for a place known to be closed when leaving now. */
const CLOSED_PENALTY_MIN = 15;

/**
 * Lower score is better: the longer of the two trips, plus the imbalance between
 * them, adjusted by rating (weighted by how many reviews back it up).
 */
export function scorePlace(place, timeA, timeB, { preferOpen = false } = {}) {
  const maxMin = Math.max(timeA, timeB) / 60;
  const diffMin = Math.abs(timeA - timeB) / 60;
  let score = maxMin + IMBALANCE_WEIGHT * diffMin;
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

/** 'great' | 'good' | 'fair' — how evenly the trip is split between the sides. */
export function fairnessLevel(timeA, timeB) {
  const diff = Math.abs(timeA - timeB);
  const longer = Math.max(timeA, timeB, 1);
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
