// Temporary diagnostic: can Photon list places near a point (a fallback for Overpass)?
const H = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/141 Mobile Safari/537.36', Referer: 'https://itaigree.github.io/' };
const at = { lat: 32.44, lon: 34.92 }; // Haifa–Tel Aviv midpoint area
const urls = [
  `https://photon.komoot.io/reverse?lat=${at.lat}&lon=${at.lon}&radius=6&limit=20&osm_tag=amenity:cafe`,
  `https://photon.komoot.io/reverse?lat=${at.lat}&lon=${at.lon}&radius=6&limit=20&osm_tag=leisure:park`,
  `https://photon.komoot.io/reverse?lat=${at.lat}&lon=${at.lon}&radius=6&limit=20&osm_tag=shop:mall`,
  `https://photon.komoot.io/api/?q=cafe&lat=${at.lat}&lon=${at.lon}&limit=20&osm_tag=amenity:cafe&location_bias_scale=0.1&zoom=14`,
  `https://photon.komoot.io/api/?q=%D7%A7%D7%A4%D7%94&lat=${at.lat}&lon=${at.lon}&limit=20&osm_tag=amenity:cafe&zoom=14`,
  `https://photon.komoot.io/api/?q=park&lat=${at.lat}&lon=${at.lon}&limit=20&osm_tag=leisure:park&zoom=14`,
  `https://overpass-api.de/api/status`,
];
for (const url of urls) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let info = text.slice(0, 300).replace(/\s+/g, ' ');
    try {
      const j = JSON.parse(text);
      const feats = j.features || [];
      const dist = (f) => {
        const [lon, lat] = f.geometry.coordinates;
        return Math.round(Math.hypot((lat - at.lat) * 111, (lon - at.lon) * 94) * 10) / 10;
      };
      info = `${feats.length} features: ` + feats.slice(0, 12).map((f) => `${f.properties.name}(${f.properties.osm_key}=${f.properties.osm_value},${dist(f)}km)`).join('; ');
    } catch {}
    console.log(`${res.status} ${Date.now() - t0}ms ${url}\n   ${info}`);
  } catch (e) {
    console.log(`ERR ${e.message} ${url}`);
  }
}
