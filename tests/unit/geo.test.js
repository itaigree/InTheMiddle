import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversine,
  pathLength,
  samplePath,
  pointAtFraction,
  boundsOf,
  bboxAround,
  isValidLatLng,
  valuesAlongPath,
  timelineFromSteps,
} from '../../site/js/core/geo.js';

const TLV = { lat: 32.0853, lng: 34.7818 };
const HAIFA = { lat: 32.794, lng: 34.9896 };

test('haversine: Tel Aviv to Haifa is about 81 km', () => {
  const d = haversine(TLV, HAIFA);
  assert.ok(d > 79000 && d < 83000, `got ${d}`);
});

test('haversine: zero for identical points', () => {
  assert.equal(haversine(TLV, TLV), 0);
});

test('pathLength sums segments', () => {
  const mid = { lat: 32.4, lng: 34.9 };
  assert.ok(Math.abs(pathLength([TLV, mid, HAIFA]) - (haversine(TLV, mid) + haversine(mid, HAIFA))) < 1e-6);
  assert.equal(pathLength([TLV]), 0);
  assert.equal(pathLength([]), 0);
});

test('samplePath: endpoints and midpoint by distance', () => {
  const path = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 0, lng: 3 },
  ];
  const [start, mid, end] = samplePath(path, [0, 0.5, 1]);
  assert.deepEqual(start, { lat: 0, lng: 0 });
  assert.ok(Math.abs(mid.lng - 1.5) < 1e-9, `mid ${mid.lng}`);
  assert.ok(Math.abs(end.lng - 3) < 1e-9);
});

test('samplePath clamps fractions and handles degenerate paths', () => {
  const path = [TLV, HAIFA];
  assert.deepEqual(samplePath(path, [-1])[0], TLV);
  const end = samplePath(path, [2])[0];
  assert.ok(Math.abs(end.lat - HAIFA.lat) < 1e-9);
  assert.deepEqual(samplePath([TLV], [0.3]), [TLV]);
  assert.deepEqual(samplePath([TLV, TLV], [0.5]), [TLV]);
  assert.throws(() => samplePath([], [0.5]));
});

test('pointAtFraction on a path with duplicate vertices', () => {
  const p = pointAtFraction([TLV, TLV, HAIFA], 0.5);
  // Linear interpolation in degrees is within a few meters of the great-circle midpoint.
  assert.ok(Math.abs(haversine(TLV, p) - haversine(p, HAIFA)) < 50);
});

test('boundsOf and bboxAround', () => {
  assert.deepEqual(boundsOf([TLV, HAIFA, null]), {
    south: TLV.lat,
    north: HAIFA.lat,
    west: TLV.lng,
    east: HAIFA.lng,
  });
  assert.equal(boundsOf([]), null);
  const box = bboxAround(TLV, 1000);
  const north = { lat: box.north, lng: TLV.lng };
  const east = { lat: TLV.lat, lng: box.east };
  assert.ok(Math.abs(haversine(TLV, north) - 1000) < 1);
  assert.ok(Math.abs(haversine(TLV, east) - 1000) < 5);
});

test('isValidLatLng', () => {
  assert.ok(isValidLatLng(TLV));
  assert.ok(!isValidLatLng({ lat: NaN, lng: 1 }));
  assert.ok(!isValidLatLng({ lat: 91, lng: 1 }));
  assert.ok(!isValidLatLng(null));
});

test('valuesAlongPath interpolates by distance', () => {
  const path = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 0, lng: 3 },
  ];
  const v = valuesAlongPath(path, [0, 100, 400], [0, 1 / 3, 0.5, 1]);
  assert.ok(Math.abs(v[0]) < 1e-9);
  assert.ok(Math.abs(v[1] - 100) < 1e-6);
  assert.ok(Math.abs(v[2] - 175) < 1e-6);
  assert.ok(Math.abs(v[3] - 400) < 1e-9);
  assert.throws(() => valuesAlongPath(path, [0, 1], [0.5]));
  assert.deepEqual(valuesAlongPath([TLV, TLV], [5, 5], [0.5]), [5]);
});

test('timelineFromSteps merges junctions and spreads time by distance', () => {
  const { path, timeline } = timelineFromSteps([
    { path: [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 0, lng: 2 }], durationSec: 100 },
    { path: [{ lat: 0, lng: 2 }, { lat: 0, lng: 4 }], durationSec: 50 },
    { path: [], durationSec: 10 },
    { path: [{ lat: 0, lng: 4 }, { lat: 0, lng: 5 }], durationSec: 20 },
  ]);
  assert.deepEqual(
    path.map((p) => p.lng),
    [0, 1, 2, 4, 5],
  );
  assert.equal(timeline.length, path.length);
  assert.ok(Math.abs(timeline[1] - 50) < 1e-6);
  assert.ok(Math.abs(timeline[2] - 100) < 1e-9);
  // The empty step's 10 s is added at the junction between steps 2 and 4.
  assert.ok(Math.abs(timeline[3] - 160) < 1e-9);
  assert.ok(Math.abs(timeline[4] - 180) < 1e-9);
});
