import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOsmProvider } from '../../site/js/providers/osm.js';

test('OSRM table: where each destination met the road comes back with the times', async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({
        code: 'Ok',
        durations: [[600, 900, 1200]],
        destinations: [
          { location: [34.9, 32.4], distance: 12 },
          { location: [34.8166, 32.2314], distance: 3400 }, // out at sea, met at the shore road
          { location: [35.1, 32.5] }, // no snap distance: unknown
        ],
      }),
    );
  };
  try {
    const m = await createOsmProvider().travelTimes(
      [{ lat: 32.08, lng: 34.78 }],
      [
        { lat: 32.4, lng: 34.9 },
        { lat: 32.2314, lng: 34.782 },
        { lat: 32.5, lng: 35.1 },
      ],
      'car',
    );
    assert.equal(urls.length, 1);
    assert.deepEqual([...m[0]], [600, 900, 1200]);
    assert.deepEqual(m.snapped, [{ lat: 32.4, lng: 34.9, distance: 12 }, { lat: 32.2314, lng: 34.8166, distance: 3400 }, null]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
