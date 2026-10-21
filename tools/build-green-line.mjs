// Builds site/data/green-line.json: the areas beyond the Green Line (the 1949
// armistice lines), used by the "only inside the Green Line" filter.
//   West Bank, incl. East Jerusalem: UN OCHA's oPt boundaries (HDX, cod-ab-pse)
//   Gaza Strip and the Golan:        OpenStreetMap (relations 1473938, 11585174)
// Run: node tools/build-green-line.mjs   (needs network access and `unzip`)

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const UA = { 'User-Agent': 'InTheMiddle-data-build/1.0 (https://github.com/itaigree/InTheMiddle)' };
const OCHA_ZIP =
  'https://data.humdata.org/dataset/2caf8373-816f-458c-9913-71bddb9cab7c/resource/ca372385-4c79-4378-abf1-cb506fb98023/download/pse_admin_boundaries.geojson.zip';
const osmPolygon = (id) => `https://polygons.openstreetmap.fr/get_geojson.py?id=${id}&params=0`;
const TOLERANCE = 0.0003; // degrees, ~30 m
const OUT = new URL('../site/data/green-line.json', import.meta.url);

async function download(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const polygonsOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

// Douglas–Peucker on one ring (closed: first point = last point).
function simplify(ring, tol) {
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [x1, y1] = ring[s];
    const [x2, y2] = ring[e];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    let best = -1;
    let at = -1;
    for (let i = s + 1; i < e; i++) {
      const [x, y] = ring[i];
      const d = len ? Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / len : Math.hypot(x - x1, y - y1);
      if (d > best) [best, at] = [d, i];
    }
    if (best > tol) {
      keep[at] = 1;
      stack.push([s, at], [at, e]);
    }
  }
  const out = ring.filter((_, i) => keep[i]).map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);
  return out.length >= 4 ? out : null;
}

const simplifyPolygons = (polys) =>
  polys.map((rings) => rings.map((r) => simplify(r, TOLERANCE)).filter(Boolean)).filter((rings) => rings.length);

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygons = (pt, polys) => polys.some(([outer, ...holes]) => inRing(pt, outer) && !holes.some((h) => inRing(pt, h)));

// --- West Bank (incl. East Jerusalem) from OCHA
const dir = mkdtempSync(path.join(tmpdir(), 'ocha-'));
writeFileSync(path.join(dir, 'pse.zip'), await download(OCHA_ZIP));
execFileSync('unzip', ['-q', '-o', 'pse.zip'], { cwd: dir });
const files = readdirSync(dir, { recursive: true }).map(String);
console.log('OCHA files:', files.join(', '));
const adm1File = files.find((f) => /adm(in)?1\.geojson$/i.test(f));
const adm0File = files.find((f) => /adm(in)?0\.geojson$/i.test(f));
const pick = adm1File || adm0File;
const ocha = JSON.parse(readFileSync(path.join(dir, pick), 'utf8'));
console.log('using', pick);
for (const f of ocha.features) console.log('  feature', JSON.stringify(f.properties).slice(0, 300));
// adm1 holds "West Bank" and "Gaza Strip"; use the West Bank one (Gaza comes from OSM).
const isWestBank = (f) => /west\s*bank/i.test(JSON.stringify(f.properties));
const wbFeatures = adm1File ? ocha.features.filter(isWestBank) : ocha.features;
let westBank = wbFeatures.flatMap((f) => polygonsOf(f.geometry));
if (!adm1File) westBank = westBank.filter((p) => p[0].some(([x]) => x > 34.6)); // adm0: drop Gaza
const gaza = polygonsOf(JSON.parse((await download(osmPolygon(1473938))).toString()));
const golan = polygonsOf(JSON.parse((await download(osmPolygon(11585174))).toString()));

const areas = {
  westBank: simplifyPolygons(westBank),
  gaza: simplifyPolygons(gaza),
  golan: simplifyPolygons(golan),
};
for (const [k, v] of Object.entries(areas)) console.log(k, v.length, 'polygons', v.flat(1).reduce((n, r) => n + r.length, 0), 'points');

// Known places on both sides of the line.
const CHECK = {
  inside: {
    'Tel Aviv': [34.78, 32.08], 'Kfar Saba': [34.907, 32.175], 'Rosh HaAyin': [34.957, 32.095], Modiin: [35.01, 31.898],
    'Jaffa Rd, Jerusalem': [35.214, 31.7845], Knesset: [35.205, 31.7767], 'Malha mall': [35.187, 31.751],
    'Mevaseret Zion': [35.15, 31.8], 'Beit Shemesh': [34.99, 31.73], 'Tzur Hadassah': [35.1, 31.72],
    'Baka al-Gharbiyye': [35.04, 32.42], 'Umm al-Fahm': [35.15, 32.52], Metula: [35.5786, 33.278],
    'Kiryat Shmona': [35.57, 33.21], Tiberias: [35.53, 32.79], Degania: [35.575, 32.708], Maagan: [35.603, 32.711],
    'Ein Gedi': [35.39, 31.46], Arad: [35.21, 31.26], Sderot: [34.6, 31.525], Eilat: [34.95, 29.56], Hadera: [34.92, 32.44],
  },
  beyond: {
    Ariel: [35.17, 32.105], 'Modiin Illit': [35.044, 31.932], Elkana: [35.03, 32.11], Qalqilya: [34.97, 32.19],
    "Ma'ale Adumim": [35.3, 31.777], 'Old City': [35.2345, 31.7767], Ramot: [35.2, 31.82], Gilo: [35.18, 31.735],
    'Pisgat Zeev': [35.235, 31.825], Efrat: [35.15, 31.655], 'Beitar Illit': [35.12, 31.7], 'Kiryat Arba': [35.12, 31.53],
    'Gaza City': [34.46, 31.5], Katzrin: [35.69, 32.99], 'Majdal Shams': [35.77, 33.27], 'Kfar Haruv': [35.667, 32.75],
  },
};
const beyond = (pt) => Object.values(areas).some((polys) => inPolygons(pt, polys));
let wrong = 0;
for (const [expected, places] of Object.entries(CHECK)) {
  for (const [name, pt] of Object.entries(places)) {
    const got = beyond(pt) ? 'beyond' : 'inside';
    if (got !== expected) wrong++;
    console.log(`${got === expected ? 'ok   ' : 'WRONG'} ${name}: ${got}`);
  }
}

mkdirSync(new URL('.', OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({
    about:
      'Areas beyond the Green Line (1949 armistice lines). West Bank incl. East Jerusalem: UN OCHA oPt admin boundaries (HDX cod-ab-pse). ' +
      'Gaza Strip and Golan: OpenStreetMap contributors (ODbL). Simplified to ~30 m. Built by tools/build-green-line.mjs.',
    areas,
  }) + '\n',
);
console.log('wrote', OUT.pathname, readFileSync(OUT).length, 'bytes;', wrong, 'check(s) wrong');
if (wrong) process.exitCode = 1;
