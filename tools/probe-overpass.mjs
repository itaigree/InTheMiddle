// Temporary diagnostic: send the app's Overpass query to each mirror and report.
import { buildOverpassQuery } from '../site/js/providers/osm.js';

const URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'he-IL,he;q=0.9',
  Origin: 'https://itaigree.github.io',
  Referer: 'https://itaigree.github.io/',
  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-Dest': 'empty',
};
const cases = process.env.ALL ? [
  { name: 'Haifa-TelAviv mid', c: { lat: 32.44, lng: 34.92 }, r: 6600 },
  { name: 'TelAviv-Jerusalem mid', c: { lat: 31.9, lng: 34.99 }, r: 4000 },
  { name: 'small city', c: { lat: 32.08, lng: 34.78 }, r: 1500 },
] : [{ name: 'Haifa-TelAviv mid', c: { lat: 32.44, lng: 34.92 }, r: 6600 }, { name: 'small city', c: { lat: 32.08, lng: 34.78 }, r: 1500 }];
// Also a minimal query, to tell query problems from server problems.
cases.push({ name: 'minimal', raw: '[out:json][timeout:10];node["amenity"="cafe"](around:500,32.08,34.78);out tags 5;' });
const cats = ['cafe', 'mall', 'park', 'nature'];
for (const k of cases) {
  const query = k.raw || buildOverpassQuery(k.c, k.r, cats);
  for (const url of URLS) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: BROWSER,
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
