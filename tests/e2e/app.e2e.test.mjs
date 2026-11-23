// End-to-end tests in headless Chromium with every external service mocked.
// Run with: npm run test:e2e   (needs Playwright; see README)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { startServer } from './server.mjs';
import { mockOsm, mockGoogle, mockShare, blockExternal } from './mocks.mjs';

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const candidate of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
    try {
      return require(candidate);
    } catch {
      // try the next location
    }
  }
  throw new Error('Playwright not found. Install it with: npm i -D playwright');
}

// Newer Playwright routes a service worker's own requests through context.route()
// too, which turns the HTTP cache off for them: every request then carries
// "Pragma: no-cache", and the test server can no longer tell the worker's precache
// (cache: 'reload') from a page load. The worker tests need the browser's real
// requests, so leave the worker's network alone. (Read when the browser launches.)
process.env.PLAYWRIGHT_DISABLE_SERVICE_WORKER_NETWORK ??= '1';

const { chromium } = loadPlaywright();
const SHOTS = process.env.E2E_SCREENSHOTS || '';
const configJs = (key, shareApiUrl = '') => `window.APP_CONFIG = ${JSON.stringify({ googleMapsApiKey: key, googleMapId: '', shareApiUrl })};`;

let browser;
const servers = [];

before(async () => {
  const executablePath = fs.existsSync('/opt/pw-browsers/chromium') ? undefined : undefined;
  browser = await chromium.launch({ executablePath });
});

after(async () => {
  await browser?.close();
  await Promise.all(servers.map((s) => s.close()));
});

/**
 * `share`: the share service's options (see mockShare), which also turns it on
 * in the app's config.
 */
async function openApp({ key = '', google = null, osm = {}, share = null, viewport = { width: 1280, height: 900 }, query = '', contextOptions = {}, files = {}, clock = false } = {}) {
  const server = await startServer({ overrides: { '/config.js': configJs(key, share ? 'https://share.test' : ''), ...files } });
  servers.push(server);
  const context = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', ...contextOptions });
  // Registered first = lowest priority: anything not mocked below is blocked.
  await blockExternal(context, [server.url, 'data:']);
  const osmLog = await mockOsm(context, osm);
  const googleLog = google ? await mockGoogle(context, google) : null;
  const shareLog = share ? await mockShare(context, { ...share, origin: new URL(server.url).origin }) : null;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
  if (clock) await page.clock.install(); // time runs as usual, and tests can jump ahead
  await page.goto(server.url + query);
  return { page, context, osmLog, googleLog, shareLog, errors, server };
}

/** The search options are folded into one row: open it (as a person would) to reach them. */
async function openOptions(page) {
  if (!(await page.locator('#options').evaluate((d) => d.open))) await page.locator('#options summary').click();
}

/** What the folded options row says, with its no-break spaces read as spaces. */
async function optionsSummary(page) {
  return (await page.locator('#options-values').textContent()).replaceAll('\u00a0', ' ');
}

async function pickSuggestion(page, side, text) {
  const input = page.locator(`#input-${side}`);
  await input.fill(text);
  const option = page.locator(`#list-${side} [role="option"]`).first();
  await option.waitFor();
  await option.click();
}

async function search(page) {
  await page.locator('#submit').click();
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  // The list is shown before the map is ready; wait for the map's markers too.
  await page.locator('#map .pin-a').first().waitFor({ timeout: 20000 });
}

/**
 * Move the page's (installed) clock past `until`. Under load a jump now and then
 * doesn't reach the page, so check, and jump again if needed.
 */
async function jumpPast(page, until) {
  for (let i = 0; i < 3; i++) {
    const now = await page.evaluate(() => Date.now());
    if (now > until) return;
    await page.clock.fastForward(until - now + 60_000);
  }
  assert.fail('the page clock did not move');
}

/** The link the "share this search" button gives (copied, as there is no share sheet here). */
async function sharedLink(page) {
  await page.evaluate(() => {
    window.copied = null;
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    navigator.clipboard.writeText = async (text) => {
      window.copied = text;
    };
  });
  await page.locator('#share-search').click();
  await page.waitForFunction(() => window.copied !== null);
  return new URL((await page.evaluate(() => window.copied)).split('\n').pop());
}

/** How side `side` gets to the first place in the list (its icon shows only when the sides differ). */
const travelMode = (page, side) => page.locator(`#place-list .time-${side}`).first().getAttribute('data-mode');

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test('free mode: autocomplete, search, results and Leaflet map', async () => {
  const { page, osmLog, errors, context } = await openApp();
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);

  const cards = page.locator('#place-list .place-card');
  assert.ok((await cards.count()) >= 5);
  // Times from both sides are shown on every card.
  const firstTimes = await cards.first().locator('.time-value').allTextContents();
  assert.equal(firstTimes.length, 2);
  assert.ok(firstTimes.every((t) => /דק׳|שעה|שעתיים|שעות/.test(t)), firstTimes.join(' | '));
  assert.match(await page.locator('#results-summary').textContent(), /מצאנו/);
  // The progress message is gone once results are in.
  assert.equal(await page.locator('#status').isVisible(), false);
  // Leaflet map with A, B, midpoint and numbered places.
  assert.ok(await page.locator('#map.leaflet-container').count());
  assert.ok((await page.locator('#map .pin-place').count()) >= 5);
  assert.equal(await page.locator('#map .pin-a').count(), 1);
  // Footer names the free data sources.
  assert.match(await page.locator('#provider-note').textContent(), /OpenStreetMap/);
  // The share button gives a link to this search; the address bar stays the plain site.
  const url = await sharedLink(page);
  assert.equal(url.searchParams.get('a'), 'חיפה');
  assert.equal(url.searchParams.get('b'), 'תל אביב-יפו');
  assert.equal(new URL(page.url()).search, '');
  // The midpoint came from the route timeline: only one OSRM table call (for candidates).
  assert.equal(osmLog.osrmRoute.length, 1);
  assert.equal(osmLog.osrmTable.length, 1);
  assert.equal(osmLog.overpass.length, 1);

  // Waze navigates to the place; Google Maps only shows it (no directions).
  const first = cards.first();
  assert.match(await first.locator('.waze').getAttribute('href'), /navigate=yes/);
  assert.match(await first.locator('.gmaps').getAttribute('href'), /^https:\/\/www\.google\.com\/maps\/search\/[^/?]+\/@[\d.]+,[\d.]+,17z$/);

  // Selecting a card highlights its marker.
  await cards.nth(1).locator('.place-main').click();
  assert.equal(await page.locator('#map .pin-place.is-active').count(), 1);
  assert.ok(await cards.nth(1).evaluate((el) => el.classList.contains('is-active')));

  // Category filter chips narrow the list.
  const parkChip = page.locator('#result-filters .filter-chip', { hasText: 'פארקים' });
  await parkChip.click();
  const names = await page.locator('#place-list .place-name').allTextContents();
  assert.ok(names.length > 0 && names.every((n) => n.startsWith('פארק')), names.join(','));

  await shot(page, 'osm-desktop');
  assert.deepEqual(errors, []);
  await context.close();
});

/** Zoom levels of the map tiles the page asks for from now on. */
function tileZooms(page) {
  const zooms = [];
  page.on('request', (req) => {
    const m = req.url().match(/^https:\/\/tile\.openstreetmap\.org\/(\d+)\//);
    if (m) zooms.push(Number(m[1]));
  });
  return zooms;
}

/** Whether `inner`'s box lies within `outer`'s. */
async function within(inner, outer) {
  const [a, b] = [await inner.boundingBox(), await outer.boundingBox()];
  return a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;
}

test('free mode: a place picked in the list is zoomed in on, with the whole search in a corner map', async () => {
  const { page, errors, context } = await openApp();
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const overview = page.locator('#overview');
  // The map shows the whole search: no corner map yet.
  assert.equal(await overview.isVisible(), false);

  const zooms = tileZooms(page);
  await page.locator('#place-list .place-card').nth(1).locator('.place-main').click();
  await overview.waitFor({ state: 'visible' });
  // Street level, with the place on the map and its name up.
  await page.waitForFunction(() => document.querySelector('#map .leaflet-popup'));
  assert.ok(Math.max(...zooms) >= 15, zooms.join(','));
  assert.ok(await within(page.locator('#map .pin-place.is-active'), page.locator('#map')));
  // The corner map: both sides, the middle, the places (the picked one marked), the route and a frame.
  assert.ok(await page.locator('#overview .overview-map.leaflet-container').count());
  assert.equal(await page.locator('#overview .dot-a').count(), 1);
  assert.equal(await page.locator('#overview .dot-b').count(), 1);
  assert.equal(await page.locator('#overview .dot-mid').count(), 1);
  assert.equal(await page.locator('#overview .dot-place.is-active').count(), 1);
  assert.ok((await page.locator('#overview .dot-place').count()) >= 5);
  assert.equal(await page.locator('#overview .leaflet-overlay-pane path').count(), 2);
  // Nothing in it takes focus; the button over it does.
  assert.equal(await page.locator('#overview .overview-map').evaluate((el) => el.inert), true);

  // Tapping it zooms back out to the whole search, and it goes away.
  await page.locator('#overview .overview-button').click();
  await overview.waitFor({ state: 'hidden' });
  assert.ok(await within(page.locator('#map .pin-a'), page.locator('#map')));
  assert.ok(await within(page.locator('#map .pin-b'), page.locator('#map')));

  // A place picked on the map leaves the map where it is.
  await page.waitForTimeout(800); // the zoom out has ended
  await page.locator('#map .leaflet-marker-icon:has(.pin-place:not(.is-active))').first().dispatchEvent('click');
  await page.waitForTimeout(800);
  assert.equal(await overview.isVisible(), false);
  assert.equal(await page.locator('#place-list .place-card.is-active').count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('free mode, phone, reduced motion: the zoomed-in place and its name stay clear of the corner map', async () => {
  const { page, errors, context } = await openApp({ viewport: { width: 390, height: 844 }, contextOptions: { reducedMotion: 'reduce' } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  await page.locator('#place-list .place-card').nth(2).locator('.place-main').click();
  await page.locator('#overview').waitFor({ state: 'visible' });
  // Measured together: the page may still be scrolling to the map.
  const [bubbleTop, cornerBottom] = await page.evaluate(() => [
    document.querySelector('#map .leaflet-popup-content-wrapper').getBoundingClientRect().top,
    document.querySelector('#overview').getBoundingClientRect().bottom,
  ]);
  assert.ok(bubbleTop >= cornerBottom, `bubble top ${bubbleTop}, corner map bottom ${cornerBottom}`);
  assert.ok(await within(page.locator('#map .pin-place.is-active'), page.locator('#map')));
  await shot(page, 'osm-phone-zoomed');
  assert.deepEqual(errors, []);
  await context.close();
});

test('free mode: nothing in the middle itself → the search widens until it finds places; the priority re-sorts them', async () => {
  const { page, osmLog, errors, context } = await openApp({ osm: { emptyWithin: 10000 } });
  // The usual priority is the balanced one.
  assert.equal(await page.locator('input[name="priority"]:checked').getAttribute('value'), 'balanced');
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  assert.equal(osmLog.overpass.length, 2);
  assert.ok((await page.locator('#place-list .place-card').count()) >= 5);
  assert.match(await page.locator('#status').textContent(), /הרחבנו את החיפוש עד \d+ ק״מ מנקודת האמצע/);

  // "Flexible gap": the same places in a new order, right away, without asking any server again.
  const requests = osmLog.overpass.length + osmLog.osrmTable.length + osmLog.osrmRoute.length;
  await openOptions(page);
  await page.locator('input[name="priority"][value="gap"]').check({ force: true });
  assert.match(await page.locator('#priority-hint').textContent(), /פער גדול יותר/);
  assert.match(await page.locator('#results-summary').textContent(), /גם אם יש פער בין הצדדים/);
  assert.equal(osmLog.overpass.length + osmLog.osrmTable.length + osmLog.osrmRoute.length, requests);
  // The link to this search keeps the choice.
  assert.equal((await sharedLink(page)).searchParams.get('f'), 'gap');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a search link with a priority opens with it chosen', async () => {
  const { page, errors, context } = await openApp({ query: '?a=%D7%97%D7%99%D7%A4%D7%94&b=%D7%AA%D7%9C%20%D7%90%D7%91%D7%99%D7%91&f=equal' });
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator('input[name="priority"]:checked').getAttribute('value'), 'equal');
  assert.match(await page.locator('#results-summary').textContent(), /זמן הנסיעה שווה/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('phone: a place picked in the list comes up under the map, with its links, both on screen', async () => {
  const { page, errors, context } = await openApp({ viewport: { width: 390, height: 844 } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const picked = page.locator('#picked');
  assert.equal(await picked.isVisible(), false);
  const card = page.locator('#place-list .place-card').nth(4);
  const name = await card.locator('.place-name').textContent();
  await card.locator('.place-main').click();
  await picked.waitFor({ state: 'visible' });
  assert.equal(await picked.locator('.place-name').textContent(), name);
  assert.match(await picked.locator('.waze').getAttribute('href'), /navigate=yes/);
  // Once the page has scrolled: the pinned header, the result chips right under it,
  // then the map, and the card's links under the map, all on one screen.
  await page.waitForFunction(() => {
    const header = document.querySelector('.app-header').getBoundingClientRect();
    const chips = document.querySelector('#result-filters').getBoundingClientRect();
    return Math.abs(header.top) < 1 && Math.abs(chips.top - header.bottom) < 24;
  });
  const [mapBottom, linksBottom] = await page.evaluate(() => [
    document.querySelector('.map-wrap').getBoundingClientRect().bottom,
    document.querySelector('#picked .waze').getBoundingClientRect().bottom,
  ]);
  assert.ok(linksBottom > mapBottom && linksBottom <= 844, `map ends at ${mapBottom}, links at ${linksBottom}`);
  // Sharing from it works like from the list.
  await page.evaluate(() => {
    window.copied = null;
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    navigator.clipboard.writeText = async (text) => {
      window.copied = text;
    };
  });
  await picked.locator('.share-place').click();
  await page.waitForFunction(() => window.copied !== null);
  // A pin tapped on the map shows its place there too.
  await page.locator('#map .leaflet-marker-icon:has(.pin-place:not(.is-active))').first().dispatchEvent('click');
  assert.notEqual(await picked.locator('.place-name').textContent(), name);
  await shot(page, 'osm-phone-picked');
  // A new filter of the list clears it.
  await page.locator('#result-filters .filter-chip', { hasText: 'פארקים' }).click();
  assert.equal(await picked.isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

const isPhoneViewport = (page) => page.viewportSize().width < 960;

/** What a place's share button hands the share sheet, once the place is picked in the list. */
async function sharedPlace(page, card) {
  await page.evaluate(() => {
    window.shared = null;
    Object.defineProperty(navigator, 'share', { value: async (data) => (window.shared = data), configurable: true });
  });
  await card.locator('.place-main').click();
  // On phones the picked place's card, with its links, comes up under the map.
  const picked = page.locator('#picked');
  await (isPhoneViewport(page) ? picked : card).locator('.share-place').click();
  await page.waitForFunction(() => window.shared !== null);
  return page.evaluate(() => window.shared);
}

test('phone: a shared place opens the app on that place, with the rest of the list, as its sender saw it', async () => {
  const sender = await openApp({ viewport: { width: 390, height: 844 } });
  await pickSuggestion(sender.page, 'a', 'חיפה');
  await pickSuggestion(sender.page, 'b', 'תל אביב');
  await search(sender.page);
  const card = sender.page.locator('#place-list .place-card').nth(4);
  const name = await card.locator('.place-name').textContent();
  const id = await card.getAttribute('data-place-id');
  const names = await sender.page.locator('#place-list .place-name').allTextContents();
  const shared = await sharedPlace(sender.page, card);
  assert.match(shared.text, new RegExp(`מה דעתך על ${name}`));
  // A link to the app itself, on this search, with this place.
  const url = new URL(shared.url);
  assert.equal(url.origin, new URL(sender.page.url()).origin);
  assert.equal(url.pathname, new URL(sender.page.url()).pathname);
  assert.equal(url.searchParams.get('a'), 'חיפה');
  assert.equal(url.searchParams.get('b'), 'תל אביב-יפו');
  assert.equal(url.searchParams.get('pl'), id);
  // The search's own link stays a link to the search.
  assert.equal((await sharedLink(sender.page)).searchParams.get('pl'), null);
  assert.deepEqual(sender.errors, []);
  await sender.context.close();

  // The recipient: the same list, that place picked, its card under the map.
  const { page, errors, context } = await openApp({ viewport: { width: 390, height: 844 }, query: url.search });
  const picked = page.locator('#picked');
  await picked.waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(await picked.locator('.place-name').textContent(), name);
  assert.deepEqual(await page.locator('#place-list .place-name').allTextContents(), names);
  assert.equal(await page.locator('#place-list .place-card.is-active').getAttribute('data-place-id'), id);
  // The map zooms in on it, with its name up and the whole search in the corner.
  await page.locator('#overview').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#map .leaflet-popup'));
  assert.match(await page.locator('#map .leaflet-popup').textContent(), new RegExp(name));
  // Scrolled as for a place picked in the list: the map, and the card's links under it, on one screen.
  await page.waitForFunction(() => {
    const header = document.querySelector('.app-header').getBoundingClientRect();
    const chips = document.querySelector('#result-filters').getBoundingClientRect();
    return Math.abs(header.top) < 1 && Math.abs(chips.top - header.bottom) < 24;
  });
  const [mapBottom, linksBottom] = await page.evaluate(() => [
    document.querySelector('.map-wrap').getBoundingClientRect().bottom,
    document.querySelector('#picked .waze').getBoundingClientRect().bottom,
  ]);
  assert.ok(linksBottom > mapBottom && linksBottom <= 844, `map ends at ${mapBottom}, links at ${linksBottom}`);
  assert.ok(await within(page.locator('#map .pin-place.is-active'), page.locator('#map')));
  // The address bar went back to the plain site.
  assert.equal(new URL(page.url()).search, '');
  await shot(page, 'osm-phone-shared-place');

  // A reload comes back to the same place.
  await page.reload();
  await picked.waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(await picked.locator('.place-name').textContent(), name);
  assert.deepEqual(errors, []);
  await context.close();
});

test('desktop: a shared place opens with its card in view and the map zoomed in on it', async () => {
  const sender = await openApp();
  await pickSuggestion(sender.page, 'a', 'חיפה');
  await pickSuggestion(sender.page, 'b', 'תל אביב');
  await search(sender.page);
  // The last place in the list, which a 900px window doesn't show at first.
  const card = sender.page.locator('#place-list .place-card').last();
  const id = await card.getAttribute('data-place-id');
  const url = new URL((await sharedPlace(sender.page, card)).url);
  await sender.context.close();

  const { page, errors, context } = await openApp({ query: url.search });
  const zooms = tileZooms(page);
  const active = page.locator('#place-list .place-card.is-active');
  await active.waitFor({ timeout: 20000 });
  assert.equal(await active.getAttribute('data-place-id'), id);
  await page.locator('#overview').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#map .leaflet-popup'));
  await page.waitForFunction(() => {
    const box = document.querySelector('#place-list .place-card.is-active').getBoundingClientRect();
    return box.top >= -1 && box.bottom <= window.innerHeight + 1;
  });
  assert.ok(Math.max(...zooms) >= 15, zooms.join(','));
  assert.ok(await within(page.locator('#map .pin-place.is-active'), page.locator('#map')));
  // Nothing under the map: that's for phones.
  assert.equal(await page.locator('#picked').isVisible(), false);
  await shot(page, 'osm-desktop-shared-place');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Google mode: a shared place carries Google\'s place id, not its coordinates, and opens on it', async () => {
  const sender = await openApp({ key: 'TEST_KEY', google: {} });
  await pickSuggestion(sender.page, 'a', 'חיפה');
  await pickSuggestion(sender.page, 'b', 'תל אביב');
  await search(sender.page);
  const card = sender.page.locator('#place-list .place-card').nth(2);
  const id = await card.getAttribute('data-place-id');
  const url = new URL((await sharedPlace(sender.page, card)).url);
  assert.equal(url.searchParams.get('pl'), id);
  assert.equal(url.searchParams.get('all'), null);
  assert.equal(url.searchParams.get('bll'), null);
  await sender.context.close();

  const { page, errors, context } = await openApp({ key: 'TEST_KEY', google: {}, query: url.search });
  const active = page.locator('#place-list .place-card.is-active');
  await active.waitFor({ timeout: 20000 });
  assert.equal(await active.getAttribute('data-place-id'), id);
  await page.locator('#overview').waitFor({ state: 'visible' });
  assert.ok((await page.evaluate(() => window.__fakeGoogleCalls)).includes('camera:15'));
  assert.equal(await page.locator('#overview .dot-place.is-active').count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a shared place this search doesn\'t find: the whole list, and a notice that says so', async () => {
  const query = '?a=%D7%97%D7%99%D7%A4%D7%94&all=32.79400,34.98960&b=%D7%AA%D7%9C+%D7%90%D7%91%D7%99%D7%91&bll=32.08530,34.78180&pl=ChIJgone';
  const { page, errors, context } = await openApp({ viewport: { width: 390, height: 844 }, query });
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.match(await page.locator('#status').textContent(), /המקום ששותף בקישור לא נמצא הפעם/);
  assert.equal(await page.locator('#place-list .place-card.is-active').count(), 0);
  assert.equal(await page.locator('#picked').isVisible(), false);
  assert.equal(await page.locator('#result-filters .filter-chip[aria-pressed="true"]').getAttribute('data-filter'), 'all');
  assert.deepEqual(errors, []);
  await context.close();
});

/** Wait until the share service holds `id` (it's stored alongside the share). */
async function storedSnapshot(store, id) {
  for (let i = 0; i < 100 && !store.has(id); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(store.has(id), `snapshot ${id} was not stored`);
  return JSON.parse(store.get(id));
}

/** How many requests went to the free map services. */
const freeRequests = (osmLog) => osmLog.overpass.length + osmLog.osrmTable.length + osmLog.osrmRoute.length + osmLog.photon.length;

test('free results travel as they are: a shared place opens them without searching, on that place (phone)', async () => {
  const store = new Map();
  const phone = { width: 390, height: 844 };
  const sender = await openApp({ viewport: phone, share: { store } });
  await pickSuggestion(sender.page, 'a', 'חיפה');
  await pickSuggestion(sender.page, 'b', 'תל אביב');
  await search(sender.page);
  const card = sender.page.locator('#place-list .place-card').nth(4);
  const name = await card.locator('.place-name').textContent();
  const id = await card.getAttribute('data-place-id');
  const names = await sender.page.locator('#place-list .place-name').allTextContents();
  const times = await sender.page.locator('#place-list .time-value').allTextContents();
  const url = new URL((await sharedPlace(sender.page, card)).url);
  // A short link: the stored results (which hold the search) and the place.
  const snapshotId = url.searchParams.get('r');
  assert.match(snapshotId, /^[A-Za-z0-9_-]{12}$/);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['pl', 'r']);
  assert.equal(url.searchParams.get('pl'), id);
  assert.ok(url.href.length < 100, url.href);
  const stored = await storedSnapshot(store, snapshotId);
  assert.equal(stored.points[0].label, 'חיפה');
  assert.ok(stored.places.some((p) => p.id === id));
  assert.ok(stored.route.length >= 2);
  // Shared again (the whole search this time): the same stored results.
  const searchUrl = await sharedLink(sender.page);
  assert.equal(searchUrl.searchParams.get('r'), snapshotId);
  assert.deepEqual([...searchUrl.searchParams.keys()], ['r']);
  assert.equal(sender.shareLog.stored.length, 1);
  assert.deepEqual(sender.errors, []);
  await sender.context.close();

  const { page, osmLog, shareLog, errors, context } = await openApp({ viewport: phone, share: { store }, query: url.search });
  const picked = page.locator('#picked');
  await picked.waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(await picked.locator('.place-name').textContent(), name);
  // The same list, the same times, and not a single search.
  assert.deepEqual(await page.locator('#place-list .place-name').allTextContents(), names);
  assert.deepEqual(await page.locator('#place-list .time-value').allTextContents(), times);
  assert.equal(freeRequests(osmLog), 0);
  assert.equal(shareLog.read.length, 1);
  // It says whose results these are, and from when.
  assert.match(await page.locator('#status').textContent(), /אלה התוצאות ששותפו איתך, כמו שנמצאו ב-\d{1,2}\.\d{1,2} בשעה \d{2}:\d{2}/);
  // On the map: both sides, the route, and the place zoomed in on.
  await page.locator('#overview').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#map .pin-a').count(), 1);
  assert.equal(await page.locator('#map .pin-b').count(), 1);
  assert.match(await page.locator('#map .leaflet-popup').textContent(), new RegExp(name));
  assert.equal(await page.locator('#trip-b').textContent(), 'תל אביב-יפו');
  // Their search is in the form, to search again or change.
  assert.equal(await page.locator('#input-a').inputValue(), 'חיפה');
  assert.equal(await page.locator('#input-b').inputValue(), 'תל אביב-יפו');
  await shot(page, 'osm-phone-stored-results');
  // A reload shows them again, still without searching.
  await page.reload();
  await picked.waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(await picked.locator('.place-name').textContent(), name);
  assert.equal(freeRequests(osmLog), 0);
  // A search of one's own runs as usual.
  await page.locator('#submit').click();
  await page.waitForFunction(() => !/ששותפו איתך/.test(document.getElementById('status').textContent));
  await page.locator('#place-list .place-card').first().waitFor();
  assert.ok(osmLog.overpass.length > 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('free results of a group travel as they are too', async () => {
  const store = new Map();
  const sender = await openApp({ share: { store } });
  await pickSuggestion(sender.page, 'a', 'חיפה');
  await pickSuggestion(sender.page, 'b', 'תל אביב');
  await sender.page.locator('#add-point').click();
  const third = sender.page.locator('#extra-endpoints .endpoint-extra').first().locator('input[role="combobox"]');
  await third.fill('באר שבע');
  await sender.page.locator(`#${await third.getAttribute('aria-controls')} [role="option"]`).first().click();
  await search(sender.page);
  const names = await sender.page.locator('#place-list .place-name').allTextContents();
  const url = await sharedLink(sender.page);
  assert.deepEqual([...url.searchParams.keys()], ['r']);
  await storedSnapshot(store, url.searchParams.get('r'));
  await sender.context.close();

  const { page, osmLog, errors, context } = await openApp({ share: { store }, query: url.search });
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.deepEqual(await page.locator('#place-list .place-name').allTextContents(), names);
  assert.equal(await page.locator('#trip-more-count').textContent(), '+1');
  // All three starting points in the form.
  assert.equal(await page.locator('#extra-endpoints .endpoint-extra').count(), 1);
  assert.equal(await page.locator('#extra-endpoints .endpoint-extra input[role="combobox"]').inputValue(), 'באר שבע');
  // Everyone's time on each card.
  assert.equal(await page.locator('#place-list .place-card').first().locator('.group-time').count(), 3);
  assert.equal(freeRequests(osmLog), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('stored results that are gone: the link searches again, and says so', async () => {
  const query = '?a=%D7%97%D7%99%D7%A4%D7%94&all=32.79400,34.98960&b=%D7%AA%D7%9C+%D7%90%D7%91%D7%99%D7%91&bll=32.08530,34.78180&r=AAAAAAAAAAAA';
  const { page, osmLog, errors, context } = await openApp({ share: { store: new Map() }, query });
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.match(await page.locator('#status').textContent(), /התוצאות ששותפו כבר לא שמורות/);
  assert.ok(osmLog.overpass.length > 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the footer says which version the page runs', async () => {
  const { page, context } = await openApp({ files: { '/config.js': `${configJs('')}\nwindow.APP_CONFIG.build = 'abcdef123456';` } });
  assert.equal(await page.locator('#app-version').textContent(), '· גרסה abcdef1');
  await context.close();
  // Without a build (a local copy), nothing.
  const local = await openApp();
  assert.equal(await local.page.locator('#app-version').isVisible(), false);
  await local.context.close();
});

test('a short link whose results are gone: it says so, and searches nothing', async () => {
  const { page, osmLog, errors, context } = await openApp({ share: { store: new Map() }, query: '?r=AAAAAAAAAAAA' });
  await page.locator('#status', { hasText: 'הקישור הזה כבר לא פעיל' }).waitFor({ timeout: 20000 });
  assert.equal(freeRequests(osmLog), 0);
  assert.equal(await page.locator('#input-a').inputValue(), '');
  assert.equal(new URL(page.url()).search, '');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Google results are not stored: their link searches again', async () => {
  const store = new Map();
  const { page, shareLog, errors, context } = await openApp({ key: 'TEST_KEY', google: {}, share: { store } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const url = new URL((await sharedPlace(page, page.locator('#place-list .place-card').nth(1))).url);
  assert.equal(url.searchParams.get('r'), null);
  assert.ok(url.searchParams.get('pl'));
  assert.equal((await sharedLink(page)).searchParams.get('r'), null);
  assert.equal(shareLog.stored.length, 0);
  assert.equal(store.size, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('storing the results fails: the link carries the search instead, and the next share tries again', async () => {
  const { page, shareLog, context } = await openApp({ share: { failStore: true } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const first = await sharedLink(page);
  assert.equal(first.searchParams.get('r'), null);
  assert.equal(first.searchParams.get('a'), 'חיפה');
  // The sender is told why the link is the long one.
  await page.locator('#toast', { hasText: 'לא הצלחנו לשמור את התוצאות (שירות השיתוף ענה 500)' }).waitFor();
  const second = await sharedLink(page);
  assert.equal(second.searchParams.get('a'), 'חיפה');
  assert.equal(shareLog.stored.length, 2);
  await context.close();
});

test('storing that is slow: the link carries the search too, and opens the results once they are stored', async () => {
  const store = new Map();
  const sender = await openApp({ share: { store, storeDelayMs: 4500 } });
  await pickSuggestion(sender.page, 'a', 'חיפה');
  await pickSuggestion(sender.page, 'b', 'תל אביב');
  await search(sender.page);
  const names = await sender.page.locator('#place-list .place-name').allTextContents();
  // The share sheet doesn't wait for long: not stored yet, so not the short link.
  const url = await sharedLink(sender.page);
  assert.ok(url.searchParams.get('r'));
  assert.equal(url.searchParams.get('a'), 'חיפה');
  await storedSnapshot(store, url.searchParams.get('r'));
  await sender.context.close();

  const { page, osmLog, errors, context } = await openApp({ share: { store }, query: url.search });
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.deepEqual(await page.locator('#place-list .place-name').allTextContents(), names);
  assert.equal(freeRequests(osmLog), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('opening stored results: the button and the fields say they are loading, and the names come first', async () => {
  const store = new Map();
  const sender = await openApp({ share: { store } });
  await pickSuggestion(sender.page, 'a', 'חיפה');
  await pickSuggestion(sender.page, 'b', 'תל אביב');
  await search(sender.page);
  const url = await sharedLink(sender.page);
  await storedSnapshot(store, url.searchParams.get('r'));
  await sender.context.close();

  const { page, errors, context } = await openApp({ share: { store, readDelayMs: 1500 }, query: url.search });
  await page.waitForFunction(() => document.getElementById('submit').textContent === 'טוענים את התוצאות…');
  assert.equal(await page.locator('#submit').isDisabled(), true);
  assert.equal(await page.locator('#input-a').getAttribute('placeholder'), 'טוענים…');
  assert.equal(await page.locator('#input-b').getAttribute('placeholder'), 'טוענים…');
  // Then the names, and the results.
  await page.waitForFunction(() => document.getElementById('input-a').value === 'חיפה');
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#input-a').getAttribute('placeholder'), 'למשל: חיפה');
  assert.equal(await page.locator('#submit').textContent(), 'מצאו לנו מקום באמצע');
  assert.deepEqual(errors, []);
  await context.close();
});

test('stored results out of reach: it says to check the connection, and the fields are as they were', async () => {
  const { page, osmLog, errors, context } = await openApp({ share: { failRead: true }, query: '?r=AAAAAAAAAAAA' });
  await page.locator('#status', { hasText: 'לא הצלחנו לפתוח את התוצאות ששותפו' }).waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#input-a').getAttribute('placeholder'), 'למשל: חיפה');
  assert.equal(await page.locator('#submit').textContent(), 'מצאו לנו מקום באמצע');
  assert.equal(freeRequests(osmLog), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('"my location" in stored results: a neutral name, rounded, and no route to the door', async () => {
  const store = new Map();
  const { page, context } = await openApp({
    share: { store },
    contextOptions: { geolocation: { latitude: 32.794123, longitude: 34.989654 }, permissions: ['geolocation'] },
  });
  await page.locator('.locate[data-side="a"]').click();
  await page.waitForFunction(() => document.getElementById('input-a').value === 'המיקום שלי');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const stored = await storedSnapshot(store, (await sharedLink(page)).searchParams.get('r'));
  assert.deepEqual(stored.points[0], { label: 'נקודת יציאה ששותפה', lat: 32.794, lng: 34.99, mode: 'car' });
  const [lat, lng] = stored.route[0];
  const meters = Math.hypot((lat - 32.794123) * 111000, (lng - 34.989654) * 94000);
  assert.ok(meters >= 300, `the route starts ${Math.round(meters)} m from the sender`);
  await context.close();
});

test('free mode: public transit through Transitous', async () => {
  const { page, context, osmLog, errors } = await openApp();
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'באר שבע');
  await page.locator('input[name="mode-b"][value="transit"]').check({ force: true });
  await search(page);
  // One Transitous call for sampling the route and one for the candidates, from B only.
  assert.equal(osmLog.transit.length, 2);
  assert.ok(osmLog.transit.every((q) => new URLSearchParams(q).get('one').startsWith('31.2518')));
  assert.equal(await travelMode(page, 'b'), 'transit');
  assert.equal(await page.locator('#status').isVisible(), false);
  assert.match(await page.locator('#attribution').innerHTML(), /transitous\.org\/sources/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a search link\'s departure is Israel time on a phone set to another zone', async () => {
  // A week from now, at 15:00 in Israel.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(Date.now() + 7 * 86_400_000);
  const query =
    '?a=%D7%97%D7%99%D7%A4%D7%94&all=32.79400,34.98960&b=%D7%AA%D7%9C+%D7%90%D7%91%D7%99%D7%91&bll=32.08530,34.78180' +
    `&bm=transit&t=${day}T15:00`;
  const { page, context, osmLog, errors } = await openApp({ query, contextOptions: { timezoneId: 'America/New_York' } });
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  // Transitous is asked for 15:00 in Israel (not 15:00 in New York, 22:00 in Israel).
  const israelTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' });
  assert.ok(osmLog.transit.length > 0);
  for (const q of osmLog.transit) assert.equal(israelTime.format(new Date(new URLSearchParams(q).get('time'))), `${day} 15:00`);
  assert.match(await optionsSummary(page), / ב-15:00 /);
  // Shared on, the link keeps the same time.
  assert.equal((await sharedLink(page)).searchParams.get('t'), `${day}T15:00`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the departure field is in Israel time on a phone set to another zone: the default, the earliest, today and tomorrow', async () => {
  const { page, context } = await openApp({ contextOptions: { timezoneId: 'America/New_York' }, clock: true });
  // Friday 4 December 2026, 02:00 in Israel: still Thursday evening in New York.
  await page.clock.setFixedTime(new Date('2026-12-04T00:00:00Z'));
  await openOptions(page);
  await page.locator('#departure-choice').selectOption('later');
  // An hour from now, and nothing earlier than now.
  assert.equal(await page.locator('#departure').inputValue(), '2026-12-04T03:00');
  assert.equal(await page.locator('#departure').getAttribute('min'), '2026-12-04T02:00');
  await page.locator('#departure').fill('2026-12-04T15:00');
  assert.equal(await optionsSummary(page), 'מאוזן · יוצאים היום ב-15:00 · בלי סינון');
  await page.locator('#departure').fill('2026-12-05T09:00');
  assert.equal(await optionsSummary(page), 'מאוזן · יוצאים מחר ב-09:00 · בלי סינון');
  await context.close();
});

test('free mode: Transitous down → that side drives, with a notice', async () => {
  const { page, context } = await openApp({ osm: { failTransit: true } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'באר שבע');
  await page.locator('input[name="mode-b"][value="transit"]').check({ force: true });
  await search(page);
  assert.match(await page.locator('#status').textContent(), /לא הצלחנו לחשב כרגע זמני תחבורה ציבורית/);
  assert.equal(await travelMode(page, 'b'), 'car');
  await context.close();
});

test('free mode: no transit service (Shabbat) → that side drives, with a notice', async () => {
  const { page, context } = await openApp({ osm: { noTransitService: true } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'באר שבע');
  await page.locator('input[name="mode-a"][value="transit"]').check({ force: true });
  await search(page);
  assert.match(await page.locator('#status').textContent(), /לא מצאנו תחבורה ציבורית/);
  await context.close();
});

test('shared link runs the search on load (mobile layout)', async () => {
  const query = '?a=%D7%97%D7%99%D7%A4%D7%94&all=32.79400,34.98960&b=%D7%AA%D7%9C+%D7%90%D7%91%D7%99%D7%91&bll=32.08530,34.78180&c=cafe,park';
  const { page, osmLog, context, errors } = await openApp({ viewport: { width: 390, height: 844 }, query });
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#input-a').inputValue(), 'חיפה');
  // Coordinates came from the link, so nothing was geocoded.
  assert.equal(osmLog.photon.length, 0);
  // Only the categories in the link were searched.
  assert.ok(!osmLog.overpass[0].includes('shop'));
  const chips = await page.locator('#category-chips input:checked').evaluateAll((els) => els.map((e) => e.value));
  assert.deepEqual(chips, ['cafe', 'park']);
  // The address bar went back to the plain site (sharing the page shares the app).
  assert.equal(new URL(page.url()).search, '');
  // No horizontal scrolling on a phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
  await shot(page, 'osm-mobile');
  assert.deepEqual(errors, []);
  await context.close();
});

test('typing without picking a suggestion still works (free-text lookup)', async () => {
  const { page, context } = await openApp();
  await page.locator('#input-a').fill('חיפה');
  await page.locator('#input-b').fill('תל אביב');
  await search(page);
  assert.ok((await page.locator('#place-list .place-card').count()) > 0);
  await context.close();
});

test('unknown place shows a helpful error', async () => {
  const { page, context } = await openApp();
  await page.locator('#input-a').fill('חיפה');
  await page.locator('#input-b').fill('מקום שלא קיים');
  await page.locator('#submit').click();
  await page.locator('#status[data-kind="error"]').waitFor();
  assert.match(await page.locator('#status').textContent(), /לא הצלחנו למצוא את „מקום שלא קיים”/);
  assert.equal(await page.locator('#input-b').getAttribute('aria-invalid'), 'true');
  await context.close();
});

test('empty form shows validation errors', async () => {
  const { page, context } = await openApp();
  // Before any search, only the form is visible.
  assert.equal(await page.locator('#results').isVisible(), false);
  assert.equal(await page.locator('#status').isVisible(), false);
  assert.equal(await page.locator('#departure').isVisible(), false);
  await page.locator('#submit').click();
  await page.locator('#status[data-kind="error"]').waitFor();
  assert.match(await page.locator('#status').textContent(), /חסרה נקודת יציאה א׳/);
  await context.close();
});

test('"בזמן אחר…" moves focus to a departure time field that has a name', async () => {
  const { page, context } = await openApp();
  await openOptions(page);
  await page.locator('#departure-choice').selectOption('later');
  const field = page.getByRole('textbox', { name: 'תאריך ושעת יציאה' });
  assert.equal(await field.evaluate((el) => el.id, null, { timeout: 2000 }), 'departure');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'departure');
  await context.close();
});

test('Overpass busy: the places come from Photon instead', async () => {
  const { page, context, osmLog } = await openApp({ osm: { failOverpass: true } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  assert.ok(osmLog.photonPlaces.length >= 1);
  assert.ok((await page.locator('#place-list .place-card').count()) > 0);
  const list = await page.locator('#place-list').textContent();
  assert.match(list, /cafe 1/);
  assert.match(list, /park 1/);
  // Nature's reserves are asked for apart from its small spots, so both show.
  assert.match(list, /viewpoint 1/);
  assert.match(list, /nature_reserve 1/);
  await context.close();
});

test('Overpass busy with "closed on Shabbat": the notice says the hours are unknown for now', async () => {
  const { page, context, osmLog } = await openApp({ osm: { failOverpass: true } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await openOptions(page);
  await page.locator('#only-shabbat-closed').check({ force: true });
  await search(page);
  // Overpass is asked once, not again for the widened search.
  assert.equal(osmLog.overpass.length, 1);
  const list = await page.locator('#place-list').textContent();
  assert.doesNotMatch(list, /cafe 1/);
  assert.match(list, /park 1/);
  assert.match(await page.locator('#status').textContent(), /עמוס/);
  await context.close();
});

test('Overpass and Photon both down shows a friendly error', async () => {
  const { page, context } = await openApp({ osm: { failOverpass: true, failPhotonPlaces: true } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await page.locator('#submit').click();
  await page.locator('#status[data-kind="error"]').waitFor({ timeout: 20000 });
  assert.match(await page.locator('#status').textContent(), /שרת המקומות החינמי עמוס/);
  await context.close();
});

test('Google mode: Google data on a Google map, with ratings and photos', async () => {
  const { page, context, osmLog, errors } = await openApp({ key: 'TEST_KEY', google: {} });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const calls = await page.evaluate(() => window.__fakeGoogleCalls);
  // Autocomplete sessions end with the cheap Essentials field only.
  assert.ok(calls.includes('fetchFields:location'));
  // Driving both ways: midpoint from the route steps, one matrix call for candidates only.
  const matrices = calls.filter((c) => c.startsWith('matrix:'));
  assert.equal(matrices.length, 1, matrices.join(','));
  const [, candidates] = matrices[0].match(/^matrix:DRIVING:2x(\d+)$/);
  assert.ok(Number(candidates) <= 16, `${candidates} candidates`);
  // Nothing went to the free services.
  assert.equal(osmLog.overpass.length + osmLog.osrmTable.length + osmLog.photon.length, 0);
  // Google map, ratings, photos (only on the first 3 cards) with credits; closed places dropped.
  assert.ok(await page.locator('#map .fake-google-map').count());
  assert.ok((await page.locator('#place-list .rating').count()) > 0);
  assert.equal(await page.locator('#place-list .place-photo img').count(), 3);
  assert.equal(await page.locator('#place-list .photo-credit').count(), 3);
  assert.match(await page.locator('#provider-note').textContent(), /Google Maps/);
  const gmapsHref = await page.locator('#place-list .gmaps').first().getAttribute('href');
  assert.match(gmapsHref, /^https:\/\/maps\.google\.com\/\?cid=/);
  // Google-derived coordinates are not put in the shared link; labels are.
  const params = (await sharedLink(page)).searchParams;
  assert.equal(params.get('a'), 'חיפה');
  assert.equal(params.get('all'), null);
  assert.equal(params.get('bll'), null);
  // Clicking a marker highlights the matching card.
  await page.locator('#map .fake-marker:has(.pin-place)').first().dispatchEvent('click');
  assert.equal(await page.locator('#place-list .place-card.is-active').count(), 1);
  await shot(page, 'google-desktop');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Google mode, phones: a photo that fails to load leaves no broken picture or credit, in the list or under the map', async () => {
  const { page, context, errors } = await openApp({ key: 'TEST_KEY', google: { brokenPhotos: true }, viewport: { width: 390, height: 844 } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  await page.locator('#place-list .place-card').first().locator('.place-main').click();
  await page.locator('#picked').waitFor({ state: 'visible' });
  // The photo request fails (as when the day's Place Photos quota is used up): the box hides, and its credit goes.
  await page.waitForFunction(
    () => !document.querySelector('#place-list .place-card.is-active .place-photo img') && !document.querySelector('#picked .place-photo img'),
    null,
    { timeout: 5000 },
  );
  assert.equal(await page.locator('#picked .photo-credit').count(), 0);
  assert.equal(await page.locator('#place-list .place-card.is-active .photo-credit').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Google mode: a place picked in the list is zoomed in on; the corner map is one more Google map, made once', async () => {
  const { page, context, errors } = await openApp({ key: 'TEST_KEY', google: {} });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const calls = () => page.evaluate(() => window.__fakeGoogleCalls);
  const overview = page.locator('#overview');
  await page.waitForTimeout(100); // the map settles after fitting
  assert.equal(await overview.isVisible(), false);
  // A search that's never zoomed in loads no second map.
  assert.equal((await calls()).filter((c) => c.startsWith('overview-map:')).length, 0);

  const cards = page.locator('#place-list .place-card');
  await cards.nth(1).locator('.place-main').click();
  await overview.waitFor({ state: 'visible' });
  assert.ok((await calls()).includes('camera:15'));
  assert.equal(await page.locator('#overview .fake-google-map .dot-place.is-active').count(), 1);
  assert.equal(await page.locator('#overview .dot-a').count(), 1);

  await page.locator('#overview .overview-button').click();
  await overview.waitFor({ state: 'hidden' });
  await cards.nth(3).locator('.place-main').click();
  await overview.waitFor({ state: 'visible' });
  const loads = (await calls()).filter((c) => /^(overview-)?map:/.test(c));
  assert.deepEqual(loads, ['map:DEMO_MAP_ID', 'overview-map:DEMO_MAP_ID']);
  assert.equal(await page.locator('#overview .dot-place.is-active').count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Google mode: mixed modes query transit only for that side', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: {} });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await page.locator('input[name="mode-b"][value="transit"]').check({ force: true });
  await search(page);
  const matrices = (await page.evaluate(() => window.__fakeGoogleCalls)).filter((c) => c.startsWith('matrix:'));
  assert.deepEqual(matrices.slice(0, 1), ['matrix:TRANSIT:1x8']);
  assert.ok(matrices.includes(matrices.find((m) => m.startsWith('matrix:DRIVING:1x'))));
  assert.equal(await travelMode(page, 'b'), 'transit');
  await context.close();
});

test('Google mode: no transit service (Shabbat) falls back to driving for that side', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: { transitNoService: true } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await page.locator('input[name="mode-a"][value="transit"]').check({ force: true });
  await search(page);
  assert.match(await page.locator('#status').textContent(), /לא מצאנו תחבורה ציבורית/);
  assert.equal(await travelMode(page, 'a'), 'car');
  await context.close();
});

test('Google quota exhausted mid-search: switches to OpenStreetMap and remembers it', async () => {
  const { page, context, osmLog, errors } = await openApp({ key: 'TEST_KEY', google: { quota: 'nearby' } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  assert.match(await page.locator('#status').textContent(), /המכסה החינמית היומית של Google נגמרה/);
  assert.ok(await page.locator('#map.leaflet-container').count());
  assert.equal(osmLog.overpass.length, 1);
  // Start points picked from Google were looked up again on OpenStreetMap.
  assert.deepEqual(osmLog.photon, ['חיפה', 'תל אביב-יפו']);
  assert.match(await page.locator('#provider-note').textContent(), /OpenStreetMap/);
  const block = await page.evaluate(() => JSON.parse(localStorage.getItem('inthemiddle.googleBlocked')));
  assert.equal(block.reason, 'quota');
  // A reload stays on the free maps without touching Google.
  await page.reload();
  await pickSuggestion(page, 'a', 'חיפה');
  assert.ok(osmLog.photon.length >= 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Google key rejected (gm_authFailure): falls back to OpenStreetMap', async () => {
  const { page, context, osmLog } = await openApp({ key: 'BAD_KEY', google: { authFail: true } });
  await page.locator('#input-a').focus();
  await page.waitForFunction(() => window.__inthemiddleGoogleAuthFailed === true);
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  assert.ok(osmLog.photon.length >= 2);
  assert.ok(await page.locator('#map.leaflet-container').count());
  assert.match(await page.locator('#status').textContent(), /בעיה בהגדרות המפתח של Google/);
  await context.close();
});

test('?p=osm forces the free maps even with a key', async () => {
  const { page, context, googleLog } = await openApp({ key: 'TEST_KEY', google: {}, query: '?p=osm' });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  assert.equal(googleLog.scripts.length, 0);
  assert.ok(new URL(page.url()).searchParams.get('p') === 'osm');
  await context.close();
});

// Talks to the real maps.googleapis.com with an invalid key; opt in with E2E_REAL_GOOGLE=1.
test('real Google SDK with an invalid key falls back to OpenStreetMap', { skip: !process.env.E2E_REAL_GOOGLE }, async () => {
  const server = await startServer({ overrides: { '/config.js': configJs('AIzaSyD-invalid-key-for-testing-000000000') } });
  servers.push(server);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'he-IL' });
  await blockExternal(context, [server.url, 'data:', 'https://maps.googleapis.com', 'https://maps.gstatic.com', 'https://places.googleapis.com', 'https://routes.googleapis.com']);
  const osmLog = await mockOsm(context);
  const page = await context.newPage();
  await page.goto(server.url);
  await page.locator('#input-a').fill('חיפה');
  await page.locator('#input-b').fill('תל אביב');
  await search(page);
  assert.ok(await page.locator('#map.leaflet-container').count());
  assert.ok(osmLog.overpass.length >= 1);
  assert.match(await page.locator('#status').textContent(), /בעיה בהגדרות המפתח של Google/);
  const block = await page.evaluate(() => JSON.parse(localStorage.getItem('inthemiddle.googleBlocked')));
  assert.equal(block.reason, 'auth');
  await context.close();
});

// ------------------------------------------------------- regressions from review

test('Leaflet draws the route and the search circle (overlay SVG is not shrunk)', async () => {
  const { page, context } = await openApp();
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const box = await page.locator('#map .leaflet-overlay-pane svg').boundingBox();
  assert.ok(box && box.width > 100 && box.height > 100, JSON.stringify(box));
  const pathBox = await page.locator('#map .leaflet-overlay-pane path').first().boundingBox();
  assert.ok(pathBox && Math.max(pathBox.width, pathBox.height) > 20, JSON.stringify(pathBox));
  await context.close();
});

test('touch: tapping a suggestion picks it without hitting the control underneath; a press alone does not', async () => {
  const { page, context } = await openApp({
    viewport: { width: 390, height: 844 },
    contextOptions: { hasTouch: true, isMobile: true },
  });
  await page.locator('#input-a').fill('חיפה');
  const option = page.locator('#list-a [role="option"]').first();
  await option.waitFor();
  // A finger landing on an option (e.g. to start scrolling the list) must not choose it.
  await option.dispatchEvent('pointerdown', { pointerType: 'touch' });
  assert.equal(await page.locator('#list-a').isVisible(), true);
  // A real tap chooses it, and the tap doesn't fall through to the mode buttons below.
  const box = await option.boundingBox();
  await page.touchscreen.tap(box.x + box.width * 0.15, box.y + box.height / 2);
  assert.equal(await page.locator('#input-a').inputValue(), 'חיפה');
  assert.equal(await page.locator('input[name="mode-a"]:checked').getAttribute('value'), 'car');
  await context.close();
});

test('Enter ("Next") in field A moves to field B instead of submitting', async () => {
  const { page, context } = await openApp();
  await page.locator('#input-a').fill('חיפה');
  await page.locator('#input-a').press('Escape');
  await page.locator('#input-a').press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'input-b');
  assert.equal(await page.locator('#status').isVisible(), false);
  await context.close();
});

test('phones: searching from the keyboard puts the keyboard away, unless a field is still missing', async () => {
  const { page, context, errors } = await openApp({
    viewport: { width: 390, height: 844 },
    contextOptions: { hasTouch: true, isMobile: true },
  });
  const focused = () => page.evaluate(() => document.activeElement?.id);
  await pickSuggestion(page, 'a', 'חיפה');
  await page.locator('#input-b').fill('תל אביב');
  await page.locator('#input-b').press('Escape');
  await page.locator('#input-b').press('Enter');
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  // No field keeps focus, so the phone's keyboard doesn't cover the results scrolled to.
  assert.notEqual(await focused(), 'input-b');
  await page.waitForFunction(() => !document.getElementById('submit').disabled, null, { timeout: 20000 });
  // A field is missing: the keyboard stays up for typing it.
  await page.locator('#input-a').fill('');
  await page.locator('#input-b').focus();
  await page.locator('#input-b').press('Enter');
  await page.locator('#status[data-kind="error"]').waitFor();
  assert.equal(await focused(), 'input-b');
  assert.deepEqual(errors, []);
  await context.close();

  // On a desktop the keyboard focus stays where it was.
  const desktop = await openApp();
  await pickSuggestion(desktop.page, 'a', 'חיפה');
  await desktop.page.locator('#input-b').fill('תל אביב');
  await desktop.page.locator('#input-b').press('Escape');
  await desktop.page.locator('#input-b').press('Enter');
  await desktop.page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.equal(await desktop.page.evaluate(() => document.activeElement?.id), 'input-b');
  await desktop.context.close();
});

test('a narrow desktop window (no touch): searching from the keyboard keeps the focus in the field', async () => {
  // A window snapped to half the screen, or zoomed to 200%: the phone layout, but a
  // hardware keyboard and a mouse, so there is no on-screen keyboard to put away.
  const { page, context, errors } = await openApp({
    viewport: { width: 640, height: 450 },
    contextOptions: { hasTouch: false, isMobile: false },
  });
  assert.ok(await page.evaluate(() => matchMedia('(max-width: 959px)').matches));
  await pickSuggestion(page, 'a', 'חיפה');
  await page.locator('#input-b').fill('תל אביב');
  await page.locator('#input-b').press('Escape');
  await page.locator('#input-b').press('Enter');
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'input-b');
  assert.deepEqual(errors, []);
  await context.close();
});

test('filter chips: photos stay limited to 3 per search, and chips all fit on desktop', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: {} });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const photoSrcs = new Set(await page.locator('#place-list .place-photo img').evaluateAll((imgs) => imgs.map((i) => i.src)));
  const chips = page.locator('#result-filters .filter-chip');
  const count = await chips.count();
  for (let i = 1; i < count; i++) {
    // Every chip is reachable without horizontal scrolling.
    const box = await chips.nth(i).boundingBox();
    const row = await page.locator('#result-filters').boundingBox();
    assert.ok(box.x >= row.x - 1 && box.x + box.width <= row.x + row.width + 1, `chip ${i} outside the row`);
    await chips.nth(i).click();
    for (const src of await page.locator('#place-list .place-photo img').evaluateAll((imgs) => imgs.map((im) => im.src))) {
      photoSrcs.add(src);
    }
    // Keyboard focus stays on the chip that was pressed.
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('filter-chip')), true);
  }
  assert.ok(photoSrcs.size <= 3, `${photoSrcs.size} distinct photos loaded`);
  await context.close();
});

test('a Google key rejected when the map loads is caught before any billed place search', async () => {
  const { page, context, osmLog } = await openApp({ key: 'BAD_KEY', google: { authFail: 'map' } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const calls = await page.evaluate(() => window.__fakeGoogleCalls);
  assert.equal(calls.filter((c) => c.startsWith('searchNearby')).length, 0, calls.join(','));
  assert.ok(await page.locator('#map.leaflet-container').count());
  assert.ok(osmLog.overpass.length >= 1);
  await context.close();
});

test('a group search moving from OpenStreetMap results to Google waits for the map before any billed travel times', async () => {
  const { page, context, server } = await openApp({ key: 'BAD_KEY', google: { authFail: 'map' } });
  // Google is blocked for a few seconds, so the link's search shows OpenStreetMap results on a Leaflet map.
  await page.evaluate(() =>
    localStorage.setItem('inthemiddle.googleBlocked', JSON.stringify({ reason: 'rate', until: new Date(Date.now() + 3000).toISOString() })),
  );
  await page.goto(server.url + GROUP_LINK);
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.ok(await page.locator('#map.leaflet-container').count());
  await page.waitForTimeout(3500); // Google is back
  // This search starts on Google, whose map then rejects the key.
  await page.locator('#submit').click();
  await page.waitForFunction(() => (window.__fakeGoogleCalls || []).some((c) => c.startsWith('map:')), null, { timeout: 20000 });
  await page.locator('#map.leaflet-container .pin-a').first().waitFor({ timeout: 20000 });
  const calls = await page.evaluate(() => window.__fakeGoogleCalls);
  assert.equal(calls.filter((c) => c.startsWith('matrix') || c.startsWith('searchNearby')).length, 0, calls.join(','));
  await context.close();
});

test('submitting right after picking a suggestion uses the pick, not a new text lookup', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: { detailsDelayMs: 600 } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const calls = await page.evaluate(() => window.__fakeGoogleCalls);
  assert.equal(calls.filter((c) => c.startsWith('searchByText')).length, 0, calls.join(','));
  await context.close();
});

test('a point added while a picked suggestion resolves is checked before searching', async () => {
  const { page, context, errors } = await openApp({ key: 'TEST_KEY', google: { detailsDelayMs: 600 } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await page.locator('#add-point').click();
  const third = page.locator('#extra-endpoints .endpoint-extra input[role="combobox"]').first();
  await third.fill('באר שבע');
  await page.locator(`#${await third.getAttribute('aria-controls')} [role="option"]`).first().click();
  // The search waits for ג's pick to resolve; ד is added meanwhile (here at once, so it surely is).
  await page.evaluate(() => {
    document.getElementById('submit').click();
    document.getElementById('add-point').click();
  });
  await page.waitForFunction(() => !document.getElementById('submit').disabled, null, { timeout: 20000 });
  assert.match(await page.locator('#status').textContent(), /חסרה נקודת יציאה ד׳/);
  const fourth = page.locator('#extra-endpoints .endpoint-extra input[role="combobox"]').nth(1);
  assert.equal(await fourth.getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#place-list .place-card').count(), 0);
  // The empty point was never looked up.
  const calls = await page.evaluate(() => window.__fakeGoogleCalls);
  assert.equal(calls.filter((c) => c.startsWith('searchByText')).length, 0, calls.join(','));
  assert.deepEqual(errors, []);
  await context.close();
});

test('"my location" is shared with a neutral label and rounded coordinates', async () => {
  const { page, context } = await openApp({
    contextOptions: { geolocation: { latitude: 32.794123, longitude: 34.989654 }, permissions: ['geolocation'] },
  });
  await page.locator('.locate[data-side="a"]').click();
  await page.waitForFunction(() => document.getElementById('input-a').value === 'המיקום שלי');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const params = (await sharedLink(page)).searchParams;
  assert.equal(params.get('a'), 'נקודת יציאה ששותפה');
  assert.equal(params.get('all'), '32.79400,34.99000');
  // On the user's own screen it is still "my location": the header and the cards.
  assert.equal(await page.locator('#trip-a').textContent(), 'המיקום שלי');
  assert.equal(await page.locator('#place-list .place-card .time-a .time-from').first().textContent(), 'מהמיקום שלי');
  assert.equal(await page.locator('#place-list .time-from', { hasText: 'ששותפה' }).count(), 0);
  assert.equal(await page.locator('#place-list .fairness', { hasText: 'ששותפה' }).count(), 0);
  await context.close();
});

test('"my location" leaves the notice about the results on screen, and clears only its own error', async () => {
  const { page, context, errors } = await openApp({ osm: { failTransit: true } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'באר שבע');
  await page.locator('input[name="mode-b"][value="transit"]').check({ force: true });
  await search(page);
  const notice = /לא הצלחנו לחשב כרגע זמני תחבורה ציבורית/;
  assert.match(await page.locator('#status').textContent(), notice);
  // "My location" for the next search: the notice still explains the results on screen.
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 32.794, longitude: 34.9896 });
  await page.locator('.locate[data-side="a"]').click();
  await page.waitForFunction(() => document.getElementById('input-a').value === 'המיקום שלי');
  assert.equal(await page.locator('#status').isVisible(), true);
  assert.match(await page.locator('#status').textContent(), notice);
  // Its own error is still cleared once the location comes through.
  await context.clearPermissions();
  await page.locator('.locate[data-side="b"]').click();
  await page.locator('#status', { hasText: 'לא הצלחנו לקבל את המיקום שלך' }).waitFor();
  await context.grantPermissions(['geolocation']);
  await page.locator('.locate[data-side="b"]').click();
  await page.waitForFunction(() => document.getElementById('input-b').value === 'המיקום שלי');
  assert.equal(await page.locator('#status').isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('swapping the two points clears a "missing" mark, which was about the text that moved', async () => {
  const { page, context } = await openApp();
  await page.locator('#input-b').fill('תל אביב');
  await page.locator('#submit').click();
  await page.locator('#status[data-kind="error"]').waitFor();
  assert.equal(await page.locator('#input-a').getAttribute('aria-invalid'), 'true');
  await page.locator('#swap').click();
  assert.equal(await page.locator('#input-a').inputValue(), 'תל אביב');
  assert.equal(await page.locator('#input-a').getAttribute('aria-invalid'), null);
  assert.equal(await page.locator('#input-b').getAttribute('aria-invalid'), null);
  await context.close();
});

test('phones: a transit fallback notice is scrolled into view, not hidden above the map', async () => {
  const { page, context } = await openApp({ viewport: { width: 360, height: 740 }, osm: { failTransit: true } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'באר שבע');
  await page.locator('input[name="mode-b"][value="transit"]').check({ force: true });
  await search(page);
  await page.waitForTimeout(800); // smooth scroll
  const box = await page.locator('#status').boundingBox();
  assert.ok(box.y >= -1 && box.y < 740, `status at y=${box.y}`);
  await context.close();
});

test('a failed search keeps the share link of the results on screen', async () => {
  const { page, context } = await openApp();
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const shown = (await sharedLink(page)).href;
  await page.locator('#input-b').fill('מקום שלא קיים');
  await page.locator('#submit').click();
  await page.locator('#status[data-kind="error"]').waitFor();
  assert.equal((await sharedLink(page)).href, shown);
  await context.close();
});

test('service worker: works offline, and search links share one cached app shell', async () => {
  const server = await startServer({ overrides: { '/config.js': configJs('') } });
  servers.push(server);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await blockExternal(context, [server.url, 'data:']);
  const page = await context.newPage();
  await page.goto(server.url);
  // main.js registers the worker only on https; 127.0.0.1 is a secure context too.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.goto(`${server.url}?a=x&b=y&c=cafe`);
  await page.goto(`${server.url}?a=z&b=w&c=park`);
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names.find((n) => n.startsWith('inthemiddle-')));
    return (await cache.keys()).map((r) => r.url);
  });
  assert.equal(cached.filter((u) => u.includes('?')).length, 0, cached.join('\n'));
  // Opening another file of the site as a page must not replace the cached app.
  await page.goto(`${server.url}manifest.webmanifest`);
  // Offline at the server (Playwright's offline mode doesn't reach the worker's own requests).
  server.setOffline(true);
  await page.goto(`${server.url}?a=q&b=r`);
  assert.equal(await page.locator('h1').textContent(), 'מקום באמצע');
  // The app works offline: its modules, including ones loaded later, come from the cache.
  assert.equal(await page.locator('#category-chips input').count(), 6);
  const lazy = await page.evaluate(async () => {
    const mod = await import('./js/ui/map-leaflet.js');
    return typeof mod.createLeafletMap;
  });
  assert.equal(lazy, 'function');
  await context.close();
});

test('Google error screen appearing late in a search: the search is redone on OpenStreetMap', async () => {
  const { page, context, osmLog } = await openApp({ key: 'TEST_KEY', google: { lateOverlayMs: 800, matrixDelayMs: 2500 } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await page.locator('#submit').click();
  await page.locator('#map.leaflet-container').waitFor({ timeout: 20000 });
  await page.locator('#map .pin-a').first().waitFor();
  assert.ok(osmLog.overpass.length >= 1);
  assert.match(await page.locator('#provider-note').textContent(), /OpenStreetMap/);
  assert.equal(await page.locator('#place-list .rating').count(), 0);
  await context.close();
});

test('phones, free mode: the first search scrolls to the results, under the pinned header', async () => {
  const { page, context } = await openApp({ viewport: { width: 390, height: 844 } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  await page.waitForTimeout(900); // smooth scroll
  const [headerTop, headerBottom, chipsTop, mapTop] = await page.evaluate(() =>
    ['.app-header', '#result-filters', '.map-wrap'].flatMap((s, i) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return i === 0 ? [r.top, r.bottom] : [r.top];
    }),
  );
  assert.ok(Math.abs(headerTop) < 1, `header top at ${headerTop}px`);
  assert.ok(Math.abs(chipsTop - headerBottom) < 24, `chips at ${chipsTop}px, header ends at ${headerBottom}px`);
  assert.ok(mapTop > chipsTop && mapTop < 250, `map top at ${mapTop}px`);
  await context.close();
});

test('a Google block recorded by another tab: this tab switches to OpenStreetMap once, no search loop', async () => {
  const { page, context, osmLog } = await openApp({ key: 'TEST_KEY', google: { matrixDelayMs: 300 } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page); // a Google search; this tab now has Google loaded
  const before = (await page.evaluate(() => window.__fakeGoogleCalls)).length;
  // Another tab of the site records a block (shared localStorage).
  const other = await context.newPage();
  await other.goto(page.url().split('?')[0]);
  await other.evaluate(() =>
    localStorage.setItem('inthemiddle.googleBlocked', JSON.stringify({ reason: 'quota', until: new Date(Date.now() + 3600e3).toISOString() })),
  );
  await other.close();
  await page.locator('#submit').click();
  await page.locator('#map.leaflet-container').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('submit').disabled === false);
  const after = (await page.evaluate(() => window.__fakeGoogleCalls)).length;
  assert.ok(after - before <= 2, `${after - before} more Google calls`);
  assert.ok(osmLog.overpass.length >= 1);
  assert.match(await page.locator('#status').textContent(), /המכסה החינמית היומית של Google נגמרה/);
  await context.close();
});

test('a block recorded by another tab during a search does not throw away this tab\'s Google results', async () => {
  const { page, context, osmLog } = await openApp({ key: 'TEST_KEY', google: { matrixDelayMs: 1500 } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await page.locator('#submit').click();
  await page.waitForTimeout(500);
  const other = await context.newPage();
  await other.goto(page.url().split('?')[0]);
  await other.evaluate(() =>
    localStorage.setItem('inthemiddle.googleBlocked', JSON.stringify({ reason: 'rate', until: new Date(Date.now() + 120e3).toISOString() })),
  );
  await other.close();
  await page.locator('#map .pin-a').first().waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('submit').disabled === false);
  // The Google search that was already running is shown; nothing was redone.
  assert.ok(await page.locator('#map .fake-google-map').count());
  assert.ok((await page.locator('#place-list .rating').count()) > 0);
  assert.equal(osmLog.overpass.length, 0);
  await context.close();
});

test('a Google map that breaks after another tab blocked Google: its results move to OpenStreetMap', async () => {
  const { page, context, osmLog } = await openApp({ key: 'TEST_KEY', google: { matrixDelayMs: 200, lateOverlayMs: 4000 } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  assert.ok(await page.locator('#map .fake-google-map').count());
  const other = await context.newPage();
  await other.goto(page.url().split('?')[0]);
  await other.evaluate(() =>
    localStorage.setItem('inthemiddle.googleBlocked', JSON.stringify({ reason: 'rate', until: new Date(Date.now() + 120e3).toISOString() })),
  );
  await other.close();
  // Typing asks for suggestions, so this tab now uses OpenStreetMap; then the Google map shows its error screen.
  await page.locator('#input-a').focus();
  await page.keyboard.type('בא');
  await page.locator('#map.leaflet-container').waitFor({ timeout: 20000 });
  await page.locator('#map .pin-a').first().waitFor();
  assert.ok(osmLog.overpass.length >= 1);
  assert.match(await page.locator('#provider-note').textContent(), /OpenStreetMap/);
  assert.equal(await page.locator('#place-list .rating').count(), 0);
  await context.close();
});

// Service worker updates: the test server stamps sw.js with a version, like a deploy.
async function swInstall({ inBrowser = browser } = {}) {
  const server = await startServer({ overrides: { '/config.js': configJs('') } });
  servers.push(server);
  server.setVersion('v1');
  const context = await inBrowser.newContext({ viewport: { width: 1000, height: 800 } });
  await blockExternal(context, [server.url, 'data:']);
  const page = await context.newPage();
  await page.goto(server.url);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  return { server, context, page };
}

/** Open the app while the network is too slow (over 4 s): it opens from the cache. */
async function openFromCache(context, server) {
  server.delays['/index.html'] = 6000;
  const page = await context.newPage();
  await page.goto(server.url);
  delete server.delays['/index.html'];
  return page;
}

const swState = (page) =>
  page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { waiting: Boolean(reg?.waiting), installing: Boolean(reg?.installing), active: reg?.active?.state, caches: (await caches.keys()).sort() };
  });

async function swUntil(page, fn, timeout = 15000) {
  const end = Date.now() + timeout;
  let state;
  while (Date.now() < end) {
    state = await swState(page);
    if (fn(state)) return state;
    await page.waitForTimeout(100);
  }
  assert.fail(`timed out: ${JSON.stringify(state)}`);
}

/**
 * A browser stops an idle worker after about 30 s, and a new version waiting to
 * take over may wait for that. Workers attached to DevTools (as here) are never
 * stopped, so do it.
 */
async function stopIdleWorkers(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
}

const swUpdate = (page) => page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update().catch(() => {}));
const swUpdated = (s) => !s.waiting && !s.installing && s.active === 'activated' && s.caches.includes('inthemiddle-v2');
const fileVersion = (page, file) => page.evaluate(async (f) => (await fetch(f)).headers.get('x-version'), file);

test('service worker: a page opened from the cache keeps its version\'s files when a new version takes over', async () => {
  const { server, context, page } = await swInstall();
  const cachePage = await openFromCache(context, server);
  server.setVersion('v2');
  await swUpdate(page);
  const state = await swUntil(page, swUpdated);
  assert.deepEqual(state.caches, ['inthemiddle-v1', 'inthemiddle-v2']);
  // The page opened from v1's copy keeps loading from it, online and offline; other pages get v2.
  assert.equal(await fileVersion(cachePage, 'js/ui/map-leaflet.js'), 'v1');
  assert.equal(await fileVersion(page, 'js/ui/map-leaflet.js'), 'v2');
  server.setOffline(true);
  assert.equal(await fileVersion(cachePage, 'js/providers/osm.js'), 'v1');
  server.setOffline(false);
  // Once that page is closed, the next version deletes the old copy.
  await cachePage.close();
  await page.waitForTimeout(10500); // a page that has just opened counts as open for 10 s
  await page.reload();
  assert.deepEqual((await swState(page)).caches, ['inthemiddle-v1', 'inthemiddle-v2']);
  server.setVersion('v3');
  await swUpdate(page);
  await swUntil(page, (s) => s.caches.join() === 'inthemiddle-v3');
  await context.close();
});

test('service worker: a page back from the back/forward cache still has its version\'s files', async () => {
  // Playwright turns the back/forward cache off; this browser has it on.
  const bfBrowser = await chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  try {
    const { server, context, page } = await swInstall({ inBrowser: bfBrowser });
    const cachePage = await openFromCache(context, server);
    await cachePage.evaluate(() => {
      window.sameDocument = true;
    });
    server.setVersion('v2');
    await swUpdate(page);
    await swUntil(page, swUpdated);
    // The page opened from v1's copy is left for another page, then another tab loads the app.
    await cachePage.goto(`${server.url}icons/icon.svg`);
    await page.waitForTimeout(10500);
    await page.goto(`${server.url}?x=1`);
    await page.waitForTimeout(500);
    await cachePage.goBack({ waitUntil: 'commit' });
    await cachePage.waitForFunction(() => document.readyState === 'complete');
    if (await cachePage.evaluate(() => window.sameDocument === true)) {
      assert.equal(await fileVersion(cachePage, 'js/ui/map-leaflet.js'), 'v1');
      server.setOffline(true);
      assert.equal(await fileVersion(cachePage, 'js/providers/osm.js'), 'v1');
    } else {
      assert.fail('the page was not restored from the back/forward cache, so this test checks nothing');
    }
  } finally {
    await bfBrowser.close();
  }
});

test('service worker: with its cache gone, a slow page load just waits for the network', async () => {
  const { server, context, page } = await swInstall();
  await page.evaluate(() => caches.delete('inthemiddle-v1'));
  const slow = await openFromCache(context, server);
  assert.equal(await slow.locator('h1').textContent(), 'מקום באמצע');
  // Nothing was marked as opened from (or put back into) the missing cache.
  assert.deepEqual((await swState(slow)).caches, []);
  await context.close();
});

test('service worker: a page opening from the cache just as a new version takes over keeps its version\'s files', async () => {
  const { server, context, page } = await swInstall();
  server.delays['/index.html'] = 6000;
  const opening = await context.newPage();
  const loaded = opening.goto(server.url);
  // v2 installs while v1 is still waiting for the network on that page.
  await page.waitForTimeout(3000);
  server.setVersion('v2');
  await swUpdate(page);
  await loaded;
  delete server.delays['/index.html'];
  await page.waitForTimeout(1000);
  if ((await swState(page)).waiting) await stopIdleWorkers(context, page);
  await swUntil(page, swUpdated);
  assert.equal(await fileVersion(opening, 'js/main.js'), 'v1');
  assert.equal(await fileVersion(opening, 'js/ui/map-leaflet.js'), 'v1');
  assert.ok((await swState(page)).caches.includes('inthemiddle-v1'));
  await context.close();
});

test('service worker: a page load while the next version installs leaves its cache alone', async () => {
  const { server, context, page } = await swInstall();
  server.setVersion('v2');
  server.delays['precache:/vendor/leaflet/leaflet.js'] = 3000; // a slow install
  swUpdate(page).catch(() => {});
  await swUntil(page, (s) => s.installing && s.caches.includes('inthemiddle-v2'), 8000);
  // v1 handles this page load, and deletes old copies meanwhile (but not v2's).
  await page.reload();
  assert.ok((await swState(page)).installing);
  const state = await swUntil(page, swUpdated, 20000);
  assert.deepEqual(state.caches, ['inthemiddle-v2']);
  server.setOffline(true);
  await page.goto(`${server.url}?a=q&b=r`);
  assert.equal(await page.locator('h1').textContent(), 'מקום באמצע');
  await context.close();
});

// Google results on screen, then another tab blocks Google and this tab's Google map breaks.
async function blockGoogleInOtherTab(context, page) {
  const other = await context.newPage();
  await other.goto(page.url().split('?')[0]);
  await other.evaluate(() =>
    localStorage.setItem('inthemiddle.googleBlocked', JSON.stringify({ reason: 'rate', until: new Date(Date.now() + 120e3).toISOString() })),
  );
  await other.close();
}

const breakGoogleMap = (page) =>
  page.evaluate(() => {
    const err = document.createElement('div');
    err.className = 'gm-err-container';
    document.querySelector('#map .fake-google-map').append(err);
  });

async function slowOverpass(context, ms) {
  const slow = async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.fallback();
  };
  await context.route('https://overpass-api.de/**', slow);
  await context.route('https://overpass.private.coffee/**', slow);
}

test('a re-run after the Google map broke does not block the search the user is starting', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: { matrixDelayMs: 100 } });
  await slowOverpass(context, 2500);
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  await blockGoogleInOtherTab(context, page);
  // The user types a new place (the suggestions now come from OpenStreetMap)…
  await page.locator('#input-a').fill('באר שבע');
  const option = page.locator('#list-a [role="option"]').first();
  await option.waitFor();
  // …the Google map shows its error screen, and the results are redone on OpenStreetMap…
  await breakGoogleMap(page);
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#submit').isDisabled(), false);
  // …and the user's own search still runs, and wins.
  await option.click();
  await page.locator('#submit').click();
  await page.waitForFunction(() => !document.getElementById('submit').disabled, null, { timeout: 20000 });
  await page.locator('#map.leaflet-container .pin-a').first().waitFor();
  assert.equal((await sharedLink(page)).searchParams.get('a'), 'באר שבע');
  await context.close();
});

test('phones: a re-run after the Google map broke shows the results on screen again, without scrolling or marking fields', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: { matrixDelayMs: 100 }, viewport: { width: 390, height: 800 } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  // A later search that fails leaves these results on screen.
  await page.locator('#input-b').fill('מקום שלא קיים');
  await page.locator('#submit').click();
  await page.locator('#status[data-kind="error"]').waitFor();
  await blockGoogleInOtherTab(context, page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600); // smooth scroll
  await page.locator('#input-b').fill('בא');
  await breakGoogleMap(page);
  await page.locator('#map.leaflet-container .pin-a').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(900); // a smooth scroll, if any
  assert.ok((await page.locator('#place-list .place-card').count()) > 0);
  assert.equal(await page.locator('#place-list .rating').count(), 0);
  assert.notEqual(await page.locator('#input-b').getAttribute('aria-invalid'), 'true');
  // The header names the search on screen, not what is being typed for the next one.
  assert.match(await page.locator('#trip-b').textContent(), /^תל אביב/);
  const top = await page.locator('#input-b').evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(top >= 0 && top < 800, `field B at ${top}px`);
  await context.close();
});

test('a search that replaced the re-run and failed: the re-run still moves the results, and the error stays', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: { matrixDelayMs: 100 } });
  await slowOverpass(context, 2500);
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  await blockGoogleInOtherTab(context, page);
  await page.locator('#input-b').fill('מקום שלא קיים');
  await breakGoogleMap(page);
  await page.locator('#submit').click();
  await page.locator('#status[data-kind="error"]').waitFor({ timeout: 20000 });
  await page.locator('#map.leaflet-container .pin-a').first().waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('submit').textContent.includes('מצאו'));
  assert.equal(await page.locator('#place-list .rating').count(), 0);
  assert.match(await page.locator('#status').textContent(), /לא הצלחנו למצוא/);
  await context.close();
});

test('an invalid search while a re-run is going: the re-run leaves its message on screen', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: { matrixDelayMs: 100 } });
  await slowOverpass(context, 2500);
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  await blockGoogleInOtherTab(context, page);
  await page.locator('#input-a').fill('בא');
  await page.locator('#list-a [role="option"]').first().waitFor();
  await breakGoogleMap(page);
  await page.locator('#input-a').fill('');
  await page.locator('#submit').click();
  await page.locator('#map.leaflet-container .pin-a').first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#status').getAttribute('data-kind'), 'error');
  assert.match(await page.locator('#status').textContent(), /נקודת יציאה/);
  await context.close();
});

test('phones: a Google map that breaks a while after the search: its notice is scrolled into view with the moved results', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: { lateOverlayMs: 3000 }, viewport: { width: 390, height: 800 } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  await page.locator('#map.leaflet-container .pin-a').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(900); // smooth scroll
  const box = await page.locator('#status').boundingBox();
  assert.ok(box && box.y >= -1 && box.y < 800, `notice at ${box?.y}px`);
  await context.close();
});

test('a Google search that fails leaves the OpenStreetMap results on screen on their own map', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: { matrixDelayMs: 100 } });
  // Google is blocked for a few seconds (e.g. a rate limit), so the first search is on OpenStreetMap.
  await page.evaluate(() =>
    localStorage.setItem('inthemiddle.googleBlocked', JSON.stringify({ reason: 'rate', until: new Date(Date.now() + 4000).toISOString() })),
  );
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  assert.ok(await page.locator('#map.leaflet-container').count());
  await page.waitForTimeout(4500);
  // The block is over: the next search is on Google, and it fails.
  await page.locator('#input-b').fill('מקום שלא קיים');
  await page.locator('#submit').click();
  await page.locator('#status[data-kind="error"]').waitFor({ timeout: 20000 });
  await page.locator('#map.leaflet-container .pin-a').first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#map .fake-google-map').count(), 0);
  await context.close();
});

test('Green Line filter: places beyond the line are left out, and the link keeps the filter', async () => {
  const { page, context } = await openApp();
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await openOptions(page);
  await page.locator('#only-green-line').check({ force: true });
  await search(page);
  // Hadera, the midpoint, is well inside the line: all places stay, no notice.
  assert.ok((await page.locator('#place-list .place-card').count()) >= 5);
  assert.equal(await page.locator('#status').isVisible(), false);
  const link = await sharedLink(page);
  assert.equal(link.searchParams.get('g'), '1');
  await context.close();

  // The same link, with the whole middle of the way beyond the line (test data)
  // and no way around it: the middle moves along the route to the nearest point
  // inside, and the notice says so.
  const square = [[34.5, 32.2], [35.3, 32.2], [35.3, 32.7], [34.5, 32.7], [34.5, 32.2]];
  const opened = await openApp({
    query: link.search,
    files: { '/data/green-line.json': JSON.stringify({ areas: { test: [[square]] } }) },
    osm: {},
  });
  await opened.page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.equal(await opened.page.locator('#only-green-line').isChecked(), true);
  assert.match(await opened.page.locator('#status').textContent(), /לא מצאנו דרך שעוקפת/);
  const [, lat] = opened.osmLog.overpass.at(-1).match(/around:\d+,([\d.]+),/);
  assert.ok(Number(lat) <= 32.2 || Number(lat) >= 32.7, `middle at ${lat}`);
  await opened.context.close();
});

const greenLineAreas = (() => {
  const data = JSON.parse(fs.readFileSync(new URL('../../site/data/green-line.json', import.meta.url), 'utf8'));
  return Object.values(data.areas).flat();
})();
/** Whether a point is beyond the Green Line (the app's own test, run here). */
async function beyondLine(point) {
  const { prepare, beyondGreenLine } = await import('../../site/js/core/green-line.js');
  return beyondGreenLine(prepare(greenLineAreas), point);
}

test('Green Line filter, free mode: Jerusalem–Be\'er Sheva goes around the West Bank, the middle inside', async () => {
  const { page, osmLog, errors, context } = await openApp();
  await pickSuggestion(page, 'a', 'ירושלים');
  await pickSuggestion(page, 'b', 'באר שבע');
  await openOptions(page);
  await page.locator('#only-green-line').check({ force: true });
  await search(page);
  // The straight way (the mock's route) crosses; the next try goes through gates.
  assert.equal(osmLog.osrmRoute.length, 2, osmLog.osrmRoute.join('\n'));
  assert.match(osmLog.osrmRoute[0], /alternatives=3/);
  assert.match(osmLog.osrmRoute[1], /bearings=/);
  assert.match(await page.locator('#status').textContent(), /הדרך המהירה ביותר שעוקפת אותם/);
  const [, lat, lng] = osmLog.overpass.at(-1).match(/around:\d+,([\d.]+),([\d.]+)/);
  assert.equal(await beyondLine({ lat: Number(lat), lng: Number(lng) }), false);
  assert.ok((await page.locator('#place-list .place-card').count()) >= 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Green Line filter, Google mode: the same way round, and places timed from it', async () => {
  const { page, errors, context } = await openApp({ key: 'TEST_KEY', google: {} });
  await pickSuggestion(page, 'a', 'ירושלים');
  await pickSuggestion(page, 'b', 'באר שבע');
  await openOptions(page);
  await page.locator('#only-green-line').check({ force: true });
  await search(page);
  const calls = await page.evaluate(() => window.__fakeGoogleCalls);
  const routes = calls.filter((c) => c.startsWith('route:'));
  assert.deepEqual(routes.length, 2, calls.join(','));
  assert.equal(routes[0], 'route:alternatives');
  assert.match(routes[1], /^route:via\d+$/);
  // From three points along the route near the middle, not from Jerusalem and Be'er Sheva.
  assert.ok(calls.some((c) => /^matrix:DRIVING:3x\d+$/.test(c)), calls.join(','));
  assert.match(await page.locator('#status').textContent(), /עוקפת אותם/);
  assert.ok((await page.locator('#place-list .place-card').count()) >= 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the Green Line and Shabbat filters are remembered from visit to visit, but a shared link brings its own', async () => {
  const { page, context, server } = await openApp();
  assert.equal(await page.locator('#only-green-line').isChecked(), false);
  // The options row starts folded, and says no filter is on.
  assert.equal(await page.locator('#options').evaluate((d) => d.open), false);
  assert.match(await optionsSummary(page), /בלי סינון/);
  await openOptions(page);
  await page.locator('#only-green-line').check({ force: true });
  await page.locator('#only-shabbat-closed').check({ force: true });
  assert.equal(await optionsSummary(page), 'מאוזן · יוצאים עכשיו · בתוך הקו הירוק · סגור בשבת');
  await page.reload();
  assert.equal(await page.locator('#only-green-line').isChecked(), true);
  assert.equal(await page.locator('#only-shabbat-closed').isChecked(), true);
  // Folded again after the reload, but the row still says which filters are on.
  assert.match(await optionsSummary(page), /בתוך הקו הירוק · סגור בשבת/);
  await openOptions(page);
  await page.locator('#only-shabbat-closed').uncheck({ force: true });
  // A link to a search without the filters: shown without them...
  const linked = await context.newPage();
  await linked.goto(`${server.url}?a=${encodeURIComponent('חיפה')}&b=${encodeURIComponent('תל אביב')}`);
  await linked.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.equal(await linked.locator('#only-green-line').isChecked(), false);
  // ...but that doesn't change what's remembered.
  const later = await context.newPage();
  await later.goto(server.url);
  assert.equal(await later.locator('#only-green-line').isChecked(), true);
  assert.equal(await later.locator('#only-shabbat-closed').isChecked(), false);
  await context.close();
});

test('closed on Shabbat: only cafes whose hours show it, other kinds of places untouched', async () => {
  const { page, context } = await openApp();
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await openOptions(page);
  await page.locator('#only-shabbat-closed').check({ force: true });
  await search(page);
  const names = await page.locator('#place-list .place-name').allTextContents();
  const cafes = names.filter((n) => n.startsWith('קפה')).sort();
  assert.deepEqual(cafes, ['קפה 1', 'קפה 2']);
  assert.ok(names.some((n) => n.startsWith('פארק')));
  assert.equal(await page.locator('#place-list .shabbat').count(), 2);
  assert.equal((await sharedLink(page)).searchParams.get('s'), '1');
  // Few cafes and restaurants left: a notice says why.
  assert.match(await page.locator('#status').textContent(), /סגורים בשבת/);
  await context.close();
});

test('Google mode, closed on Shabbat: from Google opening hours', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: {} });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await openOptions(page);
  await page.locator('#only-shabbat-closed').check({ force: true });
  await search(page);
  const names = await page.locator('#place-list .place-name').allTextContents();
  assert.deepEqual(names.filter((n) => n.startsWith('בית קפה')), ['בית קפה 1']);
  assert.ok(names.some((n) => n.startsWith('פארק')));
  await context.close();
});

test('a Google map that showed its error screen is not reused once Google is back', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: { matrixDelayMs: 100 }, clock: true });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  // The free place services are down, so the re-run on OpenStreetMap fails and the broken map stays.
  let down = true;
  const fail = (route) => (down ? route.fulfill({ status: 503, body: 'down', headers: { 'access-control-allow-origin': '*' } }) : route.fallback());
  await context.route('https://overpass-api.de/**', fail);
  await context.route('https://photon.komoot.io/reverse**', fail);
  await breakGoogleMap(page);
  await page.locator('#status[data-kind="error"]').waitFor({ timeout: 30000 });
  down = false;
  // The quota block ends (the next Pacific midnight); the next search is on Google again.
  const until = await page.evaluate(() => new Date(JSON.parse(localStorage.getItem('inthemiddle.googleBlocked')).until).getTime());
  await jumpPast(page, until);
  await page.locator('#submit').click();
  // A second Google map is made (the broken one, still on screen until then, isn't reused)…
  await page.waitForFunction(() => window.__fakeGoogleCalls.filter((c) => c.startsWith('map:')).length >= 2, null, {
    timeout: 20000,
    polling: 250,
  });
  // …and the results are drawn on it.
  await page.waitForFunction(() => !document.getElementById('submit').disabled, null, { timeout: 20000, polling: 250 });
  await page.locator('#map .fake-google-map .pin-a').first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#map .gm-err-container').count(), 0);
  await context.close();
});

test('a reload after opening a search link shows that search again, and the address bar stays plain', async () => {
  const query = '?a=%D7%97%D7%99%D7%A4%D7%94&all=32.79400,34.98960&b=%D7%AA%D7%9C+%D7%90%D7%91%D7%99%D7%91&bll=32.08530,34.78180&c=cafe,park&g=1';
  const { page, context } = await openApp({ query });
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  await page.reload();
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#input-a').inputValue(), 'חיפה');
  assert.equal(await page.locator('#only-green-line').isChecked(), true);
  assert.equal(new URL(page.url()).search, '');
  await context.close();
});

test('"my location" stays "my location" after a reload, and is still shared rounded', async () => {
  const { page, context } = await openApp({
    contextOptions: { geolocation: { latitude: 32.794123, longitude: 34.989654 }, permissions: ['geolocation'] },
  });
  await page.locator('.locate[data-side="a"]').click();
  await page.waitForFunction(() => document.getElementById('input-a').value === 'המיקום שלי');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  await page.reload();
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#input-a').inputValue(), 'המיקום שלי');
  const params = (await sharedLink(page)).searchParams;
  assert.equal(params.get('a'), 'נקודת יציאה ששותפה');
  assert.equal(params.get('all'), '32.79400,34.99000');
  await context.close();
});

test('a failed search while OpenStreetMap results are on screen loads no Google map', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: { matrixDelayMs: 100 } });
  await page.evaluate(() =>
    localStorage.setItem('inthemiddle.googleBlocked', JSON.stringify({ reason: 'rate', until: new Date(Date.now() + 3000).toISOString() })),
  );
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  await page.waitForTimeout(3500); // Google is back
  for (let i = 0; i < 2; i++) {
    await page.locator('#input-b').fill('מקום שלא קיים');
    await page.locator('#submit').click();
    await page.locator('#status[data-kind="error"]').waitFor({ timeout: 20000 });
    await page.waitForFunction(() => !document.getElementById('submit').disabled);
  }
  assert.equal((await page.evaluate(() => window.__fakeGoogleCalls || [])).filter((c) => c.startsWith('map:')).length, 0);
  assert.ok(await page.locator('#map.leaflet-container').count());
  await context.close();
});

test('back on Google after the free maps: the map boxes keep nothing of Leaflet (no extra tab stop)', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: {}, clock: true });
  const until = await page.evaluate(() => {
    const t = Date.now() + 60_000;
    localStorage.setItem('inthemiddle.googleBlocked', JSON.stringify({ reason: 'rate', until: new Date(t).toISOString() }));
    return t;
  });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  assert.ok(await page.locator('#map.leaflet-container').count());
  // A place picked: the corner map is made too.
  await page.locator('#place-list .place-card').nth(1).locator('.place-main').click();
  await page.locator('#overview').waitFor({ state: 'visible' });
  // The block ends; the next search is on Google, in the same two boxes.
  await jumpPast(page, until);
  await page.locator('#submit').click();
  await page.locator('#map .fake-google-map .pin-a').first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#map').getAttribute('class'), 'map');
  assert.equal(await page.locator('#map').getAttribute('tabindex'), null);
  assert.equal(await page.locator('#overview .overview-map').getAttribute('class'), 'overview-map');
  await context.close();
});

test('service worker: a version that goes live while the previous one installs: no copy mixing the two', async () => {
  const { server, context, page } = await swInstall();
  server.setVersion('v2');
  server.delays['precache:*'] = 1500; // a slow connection: the first files arrive as v2…
  swUpdate(page).catch(() => {});
  await swUntil(page, (s) => s.installing, 8000);
  await page.waitForTimeout(500);
  server.setVersion('v3'); // …and the next deploy goes live meanwhile
  delete server.delays['precache:*'];
  await swUntil(page, (s) => !s.installing && !s.waiting, 20000);
  // Whatever is active now has one version's files throughout.
  server.setOffline(true);
  const versions = await Promise.all(['styles.css', 'js/main.js', 'data/green-line.json'].map((f) => fileVersion(page, f)));
  assert.equal(new Set(versions).size, 1, versions.join(' '));
  server.setOffline(false);
  // The next update check installs the new version whole.
  await swUpdate(page);
  await swUntil(page, (s) => !s.installing && !s.waiting && s.caches.includes('inthemiddle-v3'));
  server.setOffline(true);
  const after = await Promise.all(['styles.css', 'js/main.js', 'data/green-line.json'].map((f) => fileVersion(page, f)));
  assert.deepEqual(after, ['v3', 'v3', 'v3']);
  await context.close();
});

// ------------------------------------------------- more starting points

/** The extra starting points' letters and fields, in order. */
const extraRows = (page) => page.locator('#extra-endpoints .endpoint-extra');
const extraLetters = (page) => page.locator('#extra-endpoints .side-badge').allTextContents();

test('more starting points: added under ב up to five in all, removed and relabelled', async () => {
  const { page, context, errors } = await openApp({ viewport: { width: 390, height: 844 } });
  // Two points are the app: no extra rows until asked for.
  assert.equal(await page.locator('#extra-endpoints').isVisible(), false);
  await page.locator('#add-point').click();
  assert.deepEqual(await extraLetters(page), ['ג']);
  // The new field is ready to type in.
  assert.ok(await extraRows(page).first().locator('input[role="combobox"]').evaluate((el) => el === document.activeElement));
  await page.locator('#add-point').click();
  await page.locator('#add-point').click();
  assert.deepEqual(await extraLetters(page), ['ג', 'ד', 'ה']);
  // Five in all: no room for more.
  assert.equal(await page.locator('#add-point').isVisible(), false);
  // Removing ג: ד and ה move up to ג and ד, and there's room again.
  await extraRows(page).first().locator('input[role="combobox"]').fill('זה ילך');
  await extraRows(page).nth(1).locator('input[role="combobox"]').fill('נשאר');
  await extraRows(page).first().locator('.remove-point').click();
  assert.deepEqual(await extraLetters(page), ['ג', 'ד']);
  assert.equal(await extraRows(page).first().locator('input[role="combobox"]').inputValue(), 'נשאר');
  assert.equal(await extraRows(page).first().locator('.remove-point').getAttribute('aria-label'), 'הסרת נקודה ג׳');
  assert.ok(await page.locator('#add-point').isVisible());
  assert.ok(await page.locator('#add-point').evaluate((el) => el === document.activeElement));
  // Each row has its own car/transit choice.
  await extraRows(page).nth(1).locator('input[value="transit"]').check({ force: true });
  assert.equal(await extraRows(page).first().locator('input[value="car"]').isChecked(), true);
  // No horizontal scrolling on a phone with the extra rows.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
  await shot(page, 'more-points-form');
  assert.deepEqual(errors, []);
  await context.close();
});

test('more starting points: an empty one is pointed out; filled in, the group search runs and its link carries them', async () => {
  const { page, context, osmLog, errors } = await openApp();
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await page.locator('#add-point').click();
  await page.locator('#add-point').click();
  const third = extraRows(page).first().locator('input[role="combobox"]');
  await third.fill('באר שבע');
  await page.locator(`#${await third.getAttribute('aria-controls')} [role="option"]`).first().click();
  // ד was left empty: the search says so, and says it can go.
  await page.locator('#submit').click();
  assert.match(await page.locator('#status').textContent(), /חסרה נקודת יציאה ד׳ \(או שאפשר להסיר אותה\)/);
  assert.equal(await extraRows(page).nth(1).locator('input[role="combobox"]').getAttribute('aria-invalid'), 'true');
  assert.equal(osmLog.overpass.length, 0);
  await extraRows(page).nth(1).locator('.remove-point').click();

  await page.locator('#submit').click();
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  // A group has no road between it: no route, and travel times for two rings of
  // points (7, then 6) and the places, everyone in one request each.
  assert.equal(osmLog.osrmRoute.length, 0);
  assert.equal(osmLog.osrmTable.length, 3);
  const coords = (i) => osmLog.osrmTable[i].split('/').pop().split(';').length;
  assert.deepEqual([coords(0), coords(1)], [3 + 7, 3 + 6]);

  const url = await sharedLink(page);
  assert.equal(url.searchParams.get('a'), 'חיפה');
  assert.equal(url.searchParams.get('p3'), 'באר שבע');
  assert.ok(url.searchParams.get('p3ll'));
  assert.equal(url.searchParams.get('p4'), null);
  assert.deepEqual(errors, []);
  await context.close();

  // The link opens with the same three points, and runs their search.
  const opened = await openApp({ query: url.search });
  await opened.page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.deepEqual(await extraLetters(opened.page), ['ג']);
  assert.equal(await extraRows(opened.page).first().locator('input[role="combobox"]').inputValue(), 'באר שבע');
  assert.equal(opened.osmLog.osrmRoute.length, 0);
  // Coordinates came from the link: nothing was looked up by name.
  assert.equal(opened.osmLog.photon.length, 0);
  assert.deepEqual(opened.errors, []);
  await opened.context.close();
});

test('more starting points: a reload brings back the group search, transit choice included', async () => {
  const { page, context, osmLog } = await openApp();
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'ירושלים');
  await page.locator('#add-point').click();
  const third = extraRows(page).first().locator('input[role="combobox"]');
  await third.fill('באר שבע');
  await page.locator(`#${await third.getAttribute('aria-controls')} [role="option"]`).first().click();
  await extraRows(page).first().locator('input[value="transit"]').check({ force: true });
  await page.locator('#submit').click();
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.ok(osmLog.transit.length > 0);
  await page.reload();
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  assert.deepEqual(await extraLetters(page), ['ג']);
  assert.equal(await extraRows(page).first().locator('input[role="combobox"]').inputValue(), 'באר שבע');
  assert.equal(await extraRows(page).first().locator('input[value="transit"]').isChecked(), true);
  assert.equal(new URL(page.url()).search, '');
  await context.close();
});

/** Haifa, Tel Aviv and (on public transport) Jerusalem, from a link: a group search. */
const GROUP_LINK =
  '?a=%D7%97%D7%99%D7%A4%D7%94&all=32.79400,34.98960&b=%D7%AA%D7%9C+%D7%90%D7%91%D7%99%D7%91&bll=32.08530,34.78180' +
  '&p3=%D7%99%D7%A8%D7%95%D7%A9%D7%9C%D7%99%D7%9D&p3ll=31.77840,35.20660&p3m=transit&c=cafe,park';

test('more starting points: sharing the search works without Array.prototype.at (Safari 15.0–15.3, old WebViews)', async () => {
  const { page, context, server, errors } = await openApp();
  await context.addInitScript(() => {
    delete Array.prototype.at;
  });
  await page.goto(server.url + GROUP_LINK);
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  await page.evaluate(() => {
    window.copied = null;
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    navigator.clipboard.writeText = async (text) => {
      window.copied = text;
    };
  });
  await page.locator('#share-search').click();
  await page.waitForFunction(() => window.copied !== null, null, { timeout: 5000 });
  assert.match(await page.evaluate(() => window.copied), /^מקומות באמצע בין חיפה, תל אביב וירושלים\n/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('more starting points: the results show everyone\'s time, everyone on the map, and +1 in the header', async () => {
  const { page, context, errors } = await openApp({ viewport: { width: 390, height: 844 }, query: GROUP_LINK });
  const cards = page.locator('#place-list .place-card');
  await cards.first().waitFor({ timeout: 20000 });
  await page.locator('#map .pin-extra').first().waitFor({ timeout: 20000 });
  // Each card: three times, after א, ב and ג; no א–ב line.
  const first = cards.first();
  assert.deepEqual(await first.locator('.group-time .side-badge').allTextContents(), ['א', 'ב', 'ג']);
  const times = await first.locator('.group-time .time-value').allTextContents();
  assert.ok(times.every((t) => /דק׳|שעה|שעתיים|שעות/.test(t)), times.join(' | '));
  assert.equal(await first.locator('.place-line').count(), 0);
  // ג came by public transport, the others drove: the modes show.
  assert.equal(await first.locator('.group-time').nth(2).getAttribute('data-mode'), 'transit');
  // The summary speaks of the longest trip, and the order of everyone.
  assert.match(await page.locator('#results-summary').textContent(), /הנסיעה הארוכה ביותר לנקודת האמצע: בערך .+ לכולם\./);
  // One pin per starting point.
  assert.equal(await page.locator('#map .pin-a').count(), 1);
  assert.equal(await page.locator('#map .pin-b').count(), 1);
  assert.equal(await page.locator('#map .pin-extra').count(), 1);
  // The header keeps its א–ב trip, with how many more there are.
  assert.equal(await page.locator('#trip-a').textContent(), 'חיפה');
  assert.equal(await page.locator('#trip-more-count').textContent(), '+1');
  assert.equal(await page.locator('#trip-more-text').textContent(), 'ועוד נקודת יציאה אחת');

  // The picked place: everyone's time with where from, the gap, and a leg from everyone.
  await cards.nth(1).locator('.place-main').click();
  const picked = page.locator('#picked .place-card');
  await picked.waitFor();
  assert.deepEqual(await picked.locator('.time-from').allTextContents(), ['מחיפה', 'מתל אביב', 'מירושלים']);
  assert.match(await picked.locator('.fairness').textContent(), /^(אותו זמן נסיעה לכולם|פער של .+ בין הנסיעות · הכי ארוכה מ(חיפה|תל אביב|ירושלים))$/);
  assert.equal(await page.locator('#map path[stroke-dasharray="1 9"]').count(), 3);

  // Sharing the place says everyone's time.
  await page.evaluate(() => {
    window.shared = null;
    Object.defineProperty(navigator, 'share', { value: async (data) => (window.shared = data), configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  });
  await picked.locator('.share-place').click();
  await page.waitForFunction(() => window.shared !== null);
  const text = await page.evaluate(() => window.shared.text);
  assert.match(text, /מחיפה · .+ מתל אביב · .+ מירושלים$/);
  await shot(page, 'group-picked-phone');
  assert.deepEqual(errors, []);
  await context.close();
});

test('more starting points, 320px phone: the "+1" in the header leaves ב\'s place readable', async () => {
  const { page, context } = await openApp({ viewport: { width: 320, height: 700 }, query: GROUP_LINK });
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  const m = await page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const name = (id) => ({ w: document.getElementById(id).clientWidth, sw: document.getElementById(id).scrollWidth });
    return {
      a: name('trip-a'),
      b: name('trip-b'),
      badgeB: box(document.querySelector('#trip .side-b')),
      more: box(document.getElementById('trip-more')),
      edit: box(document.querySelector('#trip .trip-edit')),
      pageWidth: document.documentElement.scrollWidth,
    };
  });
  // "תל אביב" fits whole, as it does with two people (it was cut to "ת…").
  assert.ok(m.b.sw <= m.b.w + 1, `ב's name ${m.b.w}px of ${m.b.sw}px`);
  assert.ok(m.a.sw <= m.a.w + 1, `א's name ${m.a.w}px of ${m.a.sw}px`);
  // One row: ב's badge, then "+1", then the pencil, right to left.
  assert.ok(m.more.width > 0);
  assert.ok(m.more.right <= m.badgeB.left && m.edit.right <= m.more.left, JSON.stringify(m));
  assert.ok(Math.abs(m.more.top + m.more.height / 2 - (m.badgeB.top + m.badgeB.height / 2)) < 2, JSON.stringify(m));
  assert.ok(m.pageWidth <= 320);
  await context.close();
});

test('more starting points: the header stays one row without :has() (Safari 15.0–15.3, old WebViews)', async () => {
  const { page, context, errors } = await openApp({ viewport: { width: 320, height: 700 }, query: GROUP_LINK });
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  // Where each part of the trip sits, from the trip's own corner.
  const measure = () =>
    page.evaluate(() => {
      const trip = document.getElementById('trip');
      const t = trip.getBoundingClientRect();
      const box = (sel) => {
        const b = trip.querySelector(sel).getBoundingClientRect();
        return { x: Math.round(b.left - t.left), y: Math.round(b.top - t.top), w: Math.round(b.width), h: Math.round(b.height) };
      };
      return {
        height: Math.round(t.height),
        badgeA: box('.side-a'),
        line: box('.trip-line'),
        badgeB: box('.side-b'),
        more: box('#trip-more'),
        edit: box('.trip-edit'),
      };
    });
  const withHas = await measure();
  // These browsers drop every rule whose selector has :has(), so drop them all here.
  const dropped = await page.evaluate(() => {
    let n = 0;
    const strip = (owner) => {
      for (let i = owner.cssRules.length - 1; i >= 0; i--) {
        const rule = owner.cssRules[i];
        if (rule.selectorText?.includes(':has(')) {
          owner.deleteRule(i);
          n++;
        } else if (rule.cssRules) strip(rule);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        strip(sheet);
      } catch {
        // a sheet from another origin: not ours
      }
    }
    return n;
  });
  assert.ok(dropped > 0, 'no :has() rules found to drop');
  const without = await measure();
  // The same header as in a browser with :has(): one row, the pencil last, after "+1".
  assert.deepEqual(without, withHas);
  const middle = (b) => b.y + b.h / 2;
  for (const part of ['line', 'badgeB', 'more', 'edit']) {
    assert.ok(Math.abs(middle(without[part]) - middle(without.badgeA)) < 2, `${part}: ${JSON.stringify(without)}`);
  }
  assert.ok(without.edit.x + without.edit.w <= without.more.x, JSON.stringify(without));
  assert.deepEqual(errors, []);
  await context.close();
});

test('more starting points: sharing the search names everyone', async () => {
  const { page, context } = await openApp({ query: GROUP_LINK });
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  await page.evaluate(() => {
    window.copied = null;
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    navigator.clipboard.writeText = async (text) => {
      window.copied = text;
    };
  });
  await page.locator('#share-search').click();
  await page.waitForFunction(() => window.copied !== null);
  assert.match(await page.evaluate(() => window.copied), /^מקומות באמצע בין חיפה, תל אביב וירושלים\n/);
  await context.close();
});

test('Google mode, more starting points: one matrix request per mode and stage, a Google pin for everyone', async () => {
  const { page, context, osmLog, errors } = await openApp({ key: 'TEST_KEY', google: {}, query: GROUP_LINK.replace(/&p3m=transit/, '') });
  await page.locator('#place-list .place-card').first().waitFor({ timeout: 20000 });
  await page.locator('#map .fake-marker .pin-extra').first().waitFor({ timeout: 20000 });
  const matrices = (await page.evaluate(() => window.__fakeGoogleCalls)).filter((c) => c.startsWith('matrix:'));
  // The two rings (7 and 6 points), then the places: everyone in one request each.
  assert.deepEqual(matrices.slice(0, 2), ['matrix:DRIVING:3x7', 'matrix:DRIVING:3x6']);
  assert.match(matrices[2], /^matrix:DRIVING:3x\d+$/);
  assert.equal(matrices.length, 3);
  assert.equal(osmLog.overpass.length + osmLog.osrmTable.length, 0);
  assert.deepEqual(await page.locator('#place-list .place-card').first().locator('.group-time .side-badge').allTextContents(), ['א', 'ב', 'ג']);
  assert.deepEqual(errors, []);
  await context.close();
});
