// "Only inside the Green Line": the areas beyond it (the West Bank without
// Jerusalem, and the Gaza Strip) are in data/green-line.json, built by
// tools/build-green-line.mjs. Loaded only when the filter is used.

let pending = null;

/** The areas beyond the line, as polygons ([outer, ...holes] rings of [lng, lat]) with bounding boxes. */
export function loadGreenLine() {
  if (pending) return pending;
  // A stalled request mustn't hold the search up (the other services have timeouts too).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  pending = fetch(new URL('../../data/green-line.json', import.meta.url), { signal: controller.signal })
    .then((res) => {
      if (!res.ok) throw new Error(`green-line.json: HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => prepare(Object.values(data.areas).flat()))
    .finally(() => clearTimeout(timer));
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

export function prepare(polygons) {
  return polygons.map((rings) => {
    const xs = rings[0].map((p) => p[0]);
    const ys = rings[0].map((p) => p[1]);
    return { rings, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is the point in one of the areas beyond the Green Line? */
export function beyondGreenLine(areas, { lat, lng }) {
  return areas.some(({ rings: [outer, ...holes], box: [w, s, e, n] }) => {
    if (lng < w || lng > e || lat < s || lat > n) return false;
    return inRing(lng, lat, outer) && !holes.some((h) => inRing(lng, lat, h));
  });
}
