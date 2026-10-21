import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare, beyondGreenLine } from '../../site/js/core/green-line.js';

const square = (x, y, d) => [
  [x - d, y - d],
  [x + d, y - d],
  [x + d, y + d],
  [x - d, y + d],
  [x - d, y - d],
];

test('beyondGreenLine: inside an area, outside it, and in a hole', () => {
  const areas = prepare([[square(35.2, 31.8, 0.1), square(35.2, 31.8, 0.01)]]);
  assert.equal(beyondGreenLine(areas, { lat: 31.85, lng: 35.25 }), true);
  assert.equal(beyondGreenLine(areas, { lat: 31.8, lng: 35.2 }), false); // the hole
  assert.equal(beyondGreenLine(areas, { lat: 32.08, lng: 34.78 }), false);
});

test('the real data leaves out the West Bank and Gaza, not Jerusalem or the Golan', () => {
  const data = JSON.parse(fs.readFileSync(new URL('../../site/data/green-line.json', import.meta.url)));
  const areas = prepare(Object.values(data.areas).flat());
  const inside = {
    'Tel Aviv': [32.08, 34.78], 'Kfar Saba': [32.175, 34.907], Modiin: [31.898, 35.01], Knesset: [31.7767, 35.205],
    'Old City': [31.7767, 35.2345], Gilo: [31.735, 35.18], Katzrin: [32.99, 35.69], Metula: [33.278, 35.5786], Eilat: [29.56, 34.95],
  };
  const beyond = {
    Ariel: [32.105, 35.17], 'Modiin Illit': [31.932, 35.044], "Ma'ale Adumim": [31.777, 35.3], Ramallah: [31.9, 35.2],
    Hebron: [31.53, 35.1], 'Gaza City': [31.5, 34.46],
  };
  for (const [name, [lat, lng]] of Object.entries(inside)) assert.equal(beyondGreenLine(areas, { lat, lng }), false, name);
  for (const [name, [lat, lng]] of Object.entries(beyond)) assert.equal(beyondGreenLine(areas, { lat, lng }), true, name);
});
