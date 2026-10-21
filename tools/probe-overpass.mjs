// Temporary diagnostic: why did Photon's reverse answer 503?
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Mobile Safari/537.36';
const base = 'https://photon.komoot.io/reverse?lat=32.44&lon=34.92&radius=7&limit=30&osm_tag=amenity:cafe&osm_tag=amenity:ice_cream';
const variants = [
  ['node UA, lang=default', base + '&lang=default', {}],
  ['browser UA, lang=default', base + '&lang=default', { 'User-Agent': UA }],
  ['browser UA, no lang', base, { 'User-Agent': UA }],
  ['browser UA, lang=he', base + '&lang=he', { 'User-Agent': UA }],
  ['browser UA + Referer, lang=default', base + '&lang=default', { 'User-Agent': UA, Referer: 'https://itaigree.github.io/' }],
];
const show = async (label, url, headers) => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let info = text.slice(0, 160).replace(/\s+/g, ' ');
    try { const j = JSON.parse(text); if (j.features) info = `${j.features.length} features: ` + j.features.slice(0, 4).map((f) => f.properties.name).join(' | '); } catch {}
    console.log(`${label}: ${r.status} ${Date.now() - t0}ms ${info}`);
  } catch (e) { console.log(`${label}: ERR ${e.message}`); }
};
for (const [label, url, headers] of variants) await show(label, url, headers);
console.log('--- 4 at once, browser UA, lang=default');
const tags = [['amenity:cafe'], ['shop:mall'], ['leisure:park'], ['tourism:viewpoint', 'natural:beach']];
await Promise.all(tags.map((t) => show(t.join('+'), `https://photon.komoot.io/reverse?lat=32.44&lon=34.92&radius=7&limit=30&lang=default&${t.map((x) => 'osm_tag=' + x).join('&')}`, { 'User-Agent': UA })));
