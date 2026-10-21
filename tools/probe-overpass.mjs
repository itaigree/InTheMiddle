// Temporary diagnostic: send the app's Overpass query to each mirror and report.
import { buildOverpassQuery } from '../site/js/providers/osm.js';

const URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const cases = [
  { name: 'Haifa-TelAviv mid', c: { lat: 32.44, lng: 34.92 }, r: 6600 },
  { name: 'TelAviv-Jerusalem mid', c: { lat: 31.9, lng: 34.99 }, r: 4000 },
  { name: 'small city', c: { lat: 32.08, lng: 34.78 }, r: 1500 },
];
const cats = ['cafe', 'mall', 'park', 'nature'];
for (const k of cases) {
  const query = buildOverpassQuery(k.c, k.r, cats);
  for (const url of URLS) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: { Origin: 'https://itaigree.github.io' },
        signal: AbortSignal.timeout(40000),
      });
      const text = await res.text();
      let info;
      try {
        const j = JSON.parse(text);
        info = `elements=${j.elements?.length} remark=${j.remark || '-'}`;
      } catch {
        info = 'non-JSON: ' + text.slice(0, 400).replace(/\s+/g, ' ');
      }
      console.log(`${k.name} | ${new URL(url).host} | ${res.status} | ${Date.now() - t0} ms | ACAO=${res.headers.get('access-control-allow-origin')} | ${info}`);
    } catch (e) {
      console.log(`${k.name} | ${new URL(url).host} | ERROR ${e.name}: ${e.message} | ${Date.now() - t0} ms`);
    }
  }
}
