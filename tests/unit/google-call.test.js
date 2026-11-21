import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// google.js in Node, against a stubbed google.maps (already "loaded", so the
// bootstrap leaves it alone).
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
let searchNearby = async () => ({ places: [] });
const places = { Place: { searchNearby: (request) => searchNearby(request) } };
globalThis.google = { maps: { importLibrary: async (lib) => ({ core: {}, places, routes: {} })[lib] } };
const { createGoogleProvider } = await import('../../site/js/providers/google.js');
const { ProviderUnavailableError } = await import('../../site/js/providers/errors.js');

test('a Google call that times out is not sent again: the first one may still be answered, and billed', async () => {
  const provider = createGoogleProvider({ apiKey: 'K' });
  mock.method(console, 'warn', () => {}); // the bootstrap notes that google.maps is already there
  await provider.ready();
  mock.restoreAll();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let sent = 0;
    searchNearby = () => {
      sent++;
      return new Promise(() => {}); // Google answers after the app has given up
    };
    const search = provider.searchPlaces({ lat: 32, lng: 34.8 }, 3000, ['mall']);
    search.catch(() => {});
    // 50 s, a second at a time: past the timeout, and past a retry's own timeout.
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(1000);
    }
    await assert.rejects(search, (err) => err instanceof ProviderUnavailableError && err.reason === 'load-failed');
    assert.equal(sent, 1);
  } finally {
    mock.timers.reset();
  }
});

test('a Google call that fails on the network is still tried once more', async () => {
  const provider = createGoogleProvider({ apiKey: 'K' });
  await provider.ready();
  let sent = 0;
  searchNearby = async () => {
    sent++;
    if (sent === 1) throw new TypeError('Failed to fetch');
    return { places: [] };
  };
  assert.deepEqual(await provider.searchPlaces({ lat: 32, lng: 34.8 }, 3000, ['mall']), []);
  assert.equal(sent, 2);
});

test('searchPlaces: a place closed all of the coming week is not "open now" by its usual hours', async () => {
  const provider = createGoogleProvider({ apiKey: 'K' });
  await provider.ready();
  const always = { periods: [{ open: { day: 0, hour: 0, minute: 0 } }] };
  const place = (id, hours) => ({ id, displayName: id, location: { lat: 32, lng: 34.8 }, regularOpeningHours: always, ...hours });
  searchNearby = async () => ({
    places: [
      // Google leaves the days a place is closed out of `periods`: none are left this week.
      place('week-closed', { currentOpeningHours: { periods: [] } }),
      place('usual-hours', {}),
    ],
  });
  const found = await provider.searchPlaces({ lat: 32, lng: 34.8 }, 3000, ['mall']);
  const openNow = Object.fromEntries(found.map((p) => [p.id, p.openNow]));
  assert.deepEqual(openNow, { 'week-closed': false, 'usual-hours': true });
});
