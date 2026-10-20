// Finding the point along the route where both sides need the same travel time.

/** Fractions of the A→B route that are sampled to find the equal-time point. */
export const SAMPLE_FRACTIONS = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85];

const isTime = (t) => typeof t === 'number' && Number.isFinite(t) && t >= 0;

/**
 * Given travel times (seconds) from A and from B to points sampled at `fractions`
 * of the route, estimate the fraction where both times are equal.
 * Unreachable samples (null/undefined) are ignored.
 *
 * Returns {fraction, time, reliable}: `time` is the estimated travel time of each
 * side at that point (null if unknown); `reliable` is false when the answer was
 * extrapolated or guessed rather than interpolated between two real samples.
 */
export function findEqualTimeFraction(fractions, timesA, timesB) {
  const pts = fractions
    .map((f, i) => ({ f, a: timesA[i], b: timesB[i] }))
    .filter((p) => isTime(p.a) && isTime(p.b))
    .sort((p, q) => p.f - q.f);

  if (pts.length === 0) return { fraction: 0.5, time: null, reliable: false };
  if (pts.length === 1) {
    const [p] = pts;
    return { fraction: p.f, time: Math.max(p.a, p.b), reliable: false };
  }

  // A crossing is where (timeA - timeB) changes sign between two samples.
  // Travel times aren't always monotonic (highways, transit lines), so there may be
  // several crossings; prefer the one where both sides travel the least.
  const crossings = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const dp = p.a - p.b;
    const dq = q.a - q.b;
    if (dp === 0) crossings.push({ fraction: p.f, time: p.a });
    else if (dp * dq < 0) {
      const t = dp / (dp - dq);
      crossings.push({
        fraction: p.f + t * (q.f - p.f),
        time: p.a + t * (q.a - p.a),
      });
    }
  }
  const last = pts[pts.length - 1];
  if (last.a === last.b) crossings.push({ fraction: last.f, time: last.a });

  if (crossings.length > 0) {
    crossings.sort((x, y) => x.time - y.time);
    return { ...crossings[0], reliable: true };
  }

  // No sign change: one side is closer at every sample, so the balance point lies
  // beyond the outermost sample on the other side. Extrapolate linearly from the two
  // outermost samples when the gap is shrinking toward that edge; otherwise fall
  // back to near the edge. Either way, stay strictly inside the route.
  const allACloser = pts.every((p) => p.a < p.b);
  const [p, q] = allACloser ? pts.slice(-2) : pts.slice(0, 2);
  const edge = allACloser ? q : p;
  const dp = p.a - p.b;
  const dq = q.a - q.b;
  let fraction = allACloser ? 0.95 : 0.05;
  if (dp !== dq) {
    const extrapolated = p.f + (dp / (dp - dq)) * (q.f - p.f);
    const pointsOutward = allACloser ? extrapolated > edge.f : extrapolated < edge.f;
    if (pointsOutward) fraction = extrapolated;
  }
  fraction = Math.min(0.97, Math.max(0.03, fraction));
  return { fraction, time: Math.max(edge.a, edge.b), reliable: false };
}

/**
 * Search radius (meters) around the midpoint, scaled to how far apart A and B are:
 * a short trip needs a tight search, a cross-country trip can afford a wider one.
 */
export function searchRadiusFor(routeMeters) {
  const r = routeMeters * 0.07;
  return Math.round(Math.min(12000, Math.max(1500, r)));
}
