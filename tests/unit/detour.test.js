import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare, beyondGreenLine } from '../../site/js/core/green-line.js';
import { lengthBeyond, crossesLine, gateChain, insideAlong, hasUturn, GATES, CROSSING_TOLERANCE } from '../../site/js/core/detour.js';

const data = JSON.parse(fs.readFileSync(new URL('../../site/data/green-line.json', import.meta.url), 'utf8'));
const areas = prepare(Object.values(data.areas).flat());

const JERUSALEM = { lat: 31.7784, lng: 35.2066 };
const HEBRON = { lat: 31.5326, lng: 35.0998 };
const YERUHAM = { lat: 30.9877, lng: 34.9297 };
const HAIFA = { lat: 32.794, lng: 34.9896 };
const TEL_AVIV = { lat: 32.0853, lng: 34.7818 };
const ARIEL = { lat: 32.1047, lng: 35.1873 };

test('every gate is inside the line', () => {
  for (const gate of GATES) assert.equal(beyondGreenLine(areas, gate), false, gate.id);
});

test('lengthBeyond measures the stretch of a path beyond the line', () => {
  assert.equal(Math.round(lengthBeyond(areas, [HAIFA, TEL_AVIV])), 0);
  // Jerusalem to Hebron runs almost all the way through the West Bank (~29 km).
  const beyond = lengthBeyond(areas, [JERUSALEM, HEBRON]);
  assert.ok(beyond > 20000 && beyond < 30000, `${beyond}`);
  // Split into pieces, the same line measures the same.
  const mid = { lat: (JERUSALEM.lat + HEBRON.lat) / 2, lng: (JERUSALEM.lng + HEBRON.lng) / 2 };
  assert.ok(Math.abs(lengthBeyond(areas, [JERUSALEM, mid, HEBRON]) - beyond) < 1);
});

test('a short stretch beyond the line still counts as inside', () => {
  // About a kilometer into the West Bank by Modi'in Illit, and out again.
  const path = [
    { lat: 31.9, lng: 35.03 },
    { lat: 31.9, lng: 35.05 },
  ];
  const beyond = lengthBeyond(areas, path);
  assert.ok(beyond > 0 && beyond < CROSSING_TOLERANCE, `${beyond}`);
  assert.equal(crossesLine(areas, path), false);
  assert.equal(crossesLine(areas, [JERUSALEM, HEBRON]), true);
});

test('gateChain goes around the West Bank, and is empty when the way is clear', () => {
  assert.deepEqual(gateChain(areas, HAIFA, TEL_AVIV), []);
  const chain = gateChain(areas, JERUSALEM, YERUHAM);
  assert.ok(chain.length >= 1);
  // Straight legs through the gates stay (nearly) inside, unlike the straight way.
  const path = [JERUSALEM, ...chain, YERUHAM];
  assert.ok(lengthBeyond(areas, path) < CROSSING_TOLERANCE, `${lengthBeyond(areas, path)} m via ${chain.map((g) => g.id)}`);
  assert.ok(lengthBeyond(areas, [JERUSALEM, YERUHAM]) > 30000);
});

test('insideAlong finds the nearest point of a path inside the line', () => {
  const path = [JERUSALEM, HEBRON];
  assert.ok(beyondGreenLine(areas, { lat: 31.70, lng: 35.17 }));
  const found = insideAlong(areas, path, 0.5);
  assert.ok(found && found.fraction < 0.5);
  assert.equal(beyondGreenLine(areas, found.point), false);
  // A path entirely beyond the line has no such point.
  assert.equal(insideAlong(areas, [ARIEL, { lat: 32.1, lng: 35.25 }], 0.5), null);
});

test("the Latrun no-man's land (Route 3 from Modi'in, Route 1) doesn't count as beyond the line", () => {
  // Route 3 between Modi'in and Latrun, as OSRM draws it.
  const route3 = [[31.8547, 35.004], [31.8524, 34.9949], [31.845, 34.9916], [31.8428, 34.9922], [31.8387, 34.9863], [31.8377, 34.9857], [31.8309, 34.9891]].map(
    ([lat, lng]) => ({ lat, lng }),
  );
  assert.ok(route3.some((p) => beyondGreenLine(areas, p)));
  assert.equal(Math.round(lengthBeyond(areas, route3)), 0);
  // A segment that only starts there still counts beyond it: Route 443 is not exempt.
  const route443 = [{ lat: 31.8722, lng: 35.0408 }, { lat: 31.85, lng: 35.15 }];
  assert.ok(lengthBeyond(areas, route443) > 5000);
});

test('hasUturn: a route that goes on, comes back and goes on again; not a loop at the start', () => {
  const east = (km) => ({ lat: 31.5, lng: 34.8 + km / 95 }); // ~1 km per 1/95 of a degree here
  const straight = [0, 2, 4, 6, 8, 10].map(east);
  assert.equal(hasUturn(straight), false);
  // On to km 7, back to km 5 (a far-side via point), then on again.
  assert.equal(hasUturn([east(0), east(3), east(5), east(7), east(5), east(9), east(12)]), true);
  // A loop round the block in the first kilometer doesn't count.
  assert.equal(hasUturn([east(0), east(0.9), east(0.1), east(0.0004), east(4), east(8)]), false);
});
