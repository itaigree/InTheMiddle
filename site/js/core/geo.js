// Geometry helpers. Points are plain {lat, lng} objects in degrees; distances are meters.

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing (degrees, 0 = north, clockwise) from a toward b. */
export function bearing(a, b) {
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Cumulative distance from the start of the path to each vertex. */
export function cumulativeDistances(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + haversine(path[i - 1], path[i]));
  }
  return cum;
}

export function pathLength(path) {
  if (!path || path.length < 2) return 0;
  const cum = cumulativeDistances(path);
  return cum[cum.length - 1];
}

function lerpPoint(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** Points at the given fractions (0..1) of the path's length. */
export function samplePath(path, fractions) {
  if (!path || path.length === 0) throw new Error('samplePath: empty path');
  if (path.length === 1) return fractions.map(() => ({ ...path[0] }));
  const cum = cumulativeDistances(path);
  const total = cum[cum.length - 1];
  if (total === 0) return fractions.map(() => ({ ...path[0] }));
  return fractions.map((f) => {
    const target = Math.min(1, Math.max(0, f)) * total;
    // Binary search for the segment that contains `target`.
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid;
      else hi = mid;
    }
    const segLen = cum[hi] - cum[lo];
    const t = segLen === 0 ? 0 : (target - cum[lo]) / segLen;
    return lerpPoint(path[lo], path[hi], t);
  });
}

export function pointAtFraction(path, fraction) {
  return samplePath(path, [fraction])[0];
}

/**
 * Interpolate a per-vertex value (e.g. seconds since the start of a route) at the
 * given fractions of the path's length.
 */
export function valuesAlongPath(path, values, fractions) {
  if (!path || path.length === 0 || values.length !== path.length) {
    throw new Error('valuesAlongPath: path and values must be non-empty and the same length');
  }
  const cum = cumulativeDistances(path);
  const total = cum[cum.length - 1];
  if (total === 0) return fractions.map(() => values[0]);
  return fractions.map((f) => {
    const target = Math.min(1, Math.max(0, f)) * total;
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid;
      else hi = mid;
    }
    const segLen = cum[hi] - cum[lo];
    const t = segLen === 0 ? 0 : (target - cum[lo]) / segLen;
    return values[lo] + (values[hi] - values[lo]) * t;
  });
}

/**
 * Build a vertex path with cumulative times from route steps that each have their
 * own vertices and a duration. Time within a step is spread by distance.
 * @param {Array<{path: Array<{lat:number,lng:number}>, durationSec: number}>} steps
 * @returns {{path: Array<{lat:number,lng:number}>, timeline: number[]}}
 */
export function timelineFromSteps(steps) {
  const path = [];
  const timeline = [];
  let elapsed = 0;
  for (const step of steps) {
    const pts = (step.path || []).filter(isValidLatLng);
    const duration = Number.isFinite(step.durationSec) && step.durationSec > 0 ? step.durationSec : 0;
    if (pts.length === 0) {
      elapsed += duration;
      continue;
    }
    const cum = cumulativeDistances(pts);
    const len = cum[cum.length - 1];
    pts.forEach((p, i) => {
      const t = elapsed + (len > 0 ? (cum[i] / len) * duration : i === pts.length - 1 ? duration : 0);
      const prev = path[path.length - 1];
      // Consecutive steps share their junction vertex; keep one copy.
      if (prev && prev.lat === p.lat && prev.lng === p.lng) {
        timeline[timeline.length - 1] = Math.max(timeline[timeline.length - 1], t);
      } else {
        path.push({ lat: p.lat, lng: p.lng });
        timeline.push(t);
      }
    });
    elapsed += duration;
  }
  return { path, timeline };
}

/** A straight two-point path, used when no road route is available. */
export function straightPath(a, b) {
  return [
    { lat: a.lat, lng: a.lng },
    { lat: b.lat, lng: b.lng },
  ];
}

export function boundsOf(points) {
  const valid = points.filter(Boolean);
  if (valid.length === 0) return null;
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const p of valid) {
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
  }
  return { south, west, north, east };
}

/** A bounding box of `radius` meters around `center`. */
export function bboxAround(center, radius) {
  const dLat = (radius / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = dLat / Math.max(0.01, Math.cos(toRad(center.lat)));
  return {
    south: center.lat - dLat,
    north: center.lat + dLat,
    west: center.lng - dLng,
    east: center.lng + dLng,
  };
}

export function isValidLatLng(p) {
  return (
    p != null &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}
