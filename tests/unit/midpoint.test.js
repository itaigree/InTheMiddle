import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEqualTimeFraction, searchRadiusFor, SAMPLE_FRACTIONS } from '../../site/js/core/midpoint.js';

const near = (x, y, eps = 1e-6) => Math.abs(x - y) < eps;

test('symmetric linear times cross at the middle', () => {
  const fr = [0.25, 0.5, 0.75];
  const a = fr.map((f) => f * 3600);
  const b = fr.map((f) => (1 - f) * 3600);
  const r = findEqualTimeFraction(fr, a, b);
  assert.ok(r.reliable);
  assert.ok(near(r.fraction, 0.5));
  assert.ok(near(r.time, 1800));
});

test('asymmetric speeds move the balance point toward the slow side', () => {
  // A drives on a highway (fast), B on slow roads: equal time is closer to B.
  const fr = SAMPLE_FRACTIONS;
  const a = fr.map((f) => f * 2000);
  const b = fr.map((f) => (1 - f) * 6000);
  const r = findEqualTimeFraction(fr, a, b);
  assert.ok(r.reliable);
  assert.ok(near(r.fraction, 0.75), `fraction ${r.fraction}`);
  assert.ok(near(r.time, 1500), `time ${r.time}`);
});

test('unreachable samples are ignored', () => {
  const fr = [0.25, 0.5, 0.75];
  const r = findEqualTimeFraction(fr, [900, null, 2700], [2700, undefined, 900]);
  assert.ok(r.reliable);
  assert.ok(near(r.fraction, 0.5));
});

test('no reachable samples falls back to the middle', () => {
  const r = findEqualTimeFraction([0.25, 0.75], [null, null], [1, 2]);
  assert.deepEqual(r, { fraction: 0.5, time: null, reliable: false });
});

test('single reachable sample is used but marked unreliable', () => {
  const r = findEqualTimeFraction([0.25, 0.75], [null, 1000], [5, 800]);
  assert.equal(r.fraction, 0.75);
  assert.equal(r.time, 1000);
  assert.equal(r.reliable, false);
});

test('exact tie at a sample is a crossing', () => {
  const r = findEqualTimeFraction([0.3, 0.6], [1000, 1500], [1000, 400]);
  assert.ok(r.reliable);
  assert.equal(r.fraction, 0.3);
  const last = findEqualTimeFraction([0.3, 0.6], [100, 1500], [1000, 1500]);
  assert.equal(last.fraction, 0.6);
});

test('several crossings: picks the one with the shortest trips', () => {
  const fr = [0.1, 0.3, 0.5, 0.7, 0.9];
  // d = a - b: -, +, -, +, + → crossings in (0.1,0.3), (0.3,0.5), (0.5,0.7)
  const a = [100, 2000, 600, 1600, 2000];
  const b = [900, 1000, 1000, 800, 200];
  const r = findEqualTimeFraction(fr, a, b);
  assert.ok(r.reliable);
  // Crossing times: ~ (0.1-0.3): a goes 100→2000, d -800→1000, t=0.444 → 944;
  // (0.3-0.5): d 1000→-400, t=0.714 → a=2000-1400*0.714=1000; (0.5-0.7): d -400→800, t=1/3 → 933.
  assert.ok(r.fraction > 0.5 && r.fraction < 0.7, `fraction ${r.fraction}`);
});

test('A closer everywhere: extrapolates beyond the last sample toward B', () => {
  const fr = [0.2, 0.4, 0.6, 0.8];
  const a = fr.map((f) => f * 1000);
  const b = fr.map((f) => 2000 + (1 - f) * 1000); // B is far from everything sampled
  const r = findEqualTimeFraction(fr, a, b);
  assert.equal(r.reliable, false);
  assert.ok(r.fraction > 0.8 && r.fraction <= 0.97, `fraction ${r.fraction}`);
});

test('B closer everywhere: lands before the first sample, clamped inside the route', () => {
  const fr = [0.2, 0.4, 0.6, 0.8];
  const a = fr.map((f) => 5000 + f * 1000);
  const b = fr.map((f) => (1 - f) * 1000);
  const r = findEqualTimeFraction(fr, a, b);
  assert.equal(r.reliable, false);
  assert.ok(r.fraction >= 0.03 && r.fraction < 0.2, `fraction ${r.fraction}`);
});

test('gap growing toward the edge does not extrapolate backwards', () => {
  const fr = [0.2, 0.4, 0.6, 0.8];
  const a = [100, 200, 300, 350];
  const b = [1000, 1200, 1500, 2000]; // A always closer, gap widening
  const r = findEqualTimeFraction(fr, a, b);
  assert.ok(r.fraction >= 0.8, `fraction ${r.fraction}`);
});

test('unsorted fractions are handled', () => {
  const r = findEqualTimeFraction([0.75, 0.25], [2700, 900], [900, 2700]);
  assert.ok(near(r.fraction, 0.5));
});

test('searchRadiusFor scales with distance within bounds', () => {
  assert.equal(searchRadiusFor(5000), 1500);
  assert.equal(searchRadiusFor(100000), 7000);
  assert.equal(searchRadiusFor(1000000), 12000);
});
