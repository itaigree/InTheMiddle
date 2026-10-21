// Temporary diagnostic: the app's own place search (Overpass, then Photon) against the real servers.
import { createOsmProvider } from '../site/js/providers/osm.js';

const osm = createOsmProvider();
const cases = [
  ['Hadera (Haifa–Tel Aviv)', { lat: 32.44, lng: 34.92 }, 6600],
  ['Tel Aviv center', { lat: 32.08, lng: 34.78 }, 1500],
  ['Modiin (Tel Aviv–Jerusalem)', { lat: 31.9, lng: 35.0 }, 4000],
];
for (const [name, center, radius] of cases) {
  const t0 = Date.now();
  try {
    const places = await osm.searchPlaces(center, radius, ['cafe', 'mall', 'park', 'nature']);
    const by = {};
    for (const p of places) (by[p.category] ||= []).push(p.name);
    console.log(`${name}: ${places.length} places in ${Date.now() - t0} ms`);
    for (const [c, names] of Object.entries(by)) console.log(`   ${c}: ${names.slice(0, 6).join(' | ')}`);
  } catch (e) {
    console.log(`${name}: FAILED in ${Date.now() - t0} ms: ${e.message}`);
  }
}
