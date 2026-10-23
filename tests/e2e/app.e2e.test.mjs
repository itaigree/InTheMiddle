// End-to-end tests in headless Chromium with every external service mocked.
// Run with: npm run test:e2e   (needs Playwright; see README)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { startServer } from './server.mjs';
import { mockOsm, mockGoogle, blockExternal } from './mocks.mjs';

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

const { chromium } = loadPlaywright();
const SHOTS = process.env.E2E_SCREENSHOTS || '';
const configJs = (key) => `window.APP_CONFIG = ${JSON.stringify({ googleMapsApiKey: key, googleMapId: '' })};`;

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

async function openApp({ key = '', google = null, osm = {}, viewport = { width: 1280, height: 900 }, query = '', contextOptions = {}, files = {}, clock = false } = {}) {
  const server = await startServer({ overrides: { '/config.js': configJs(key), ...files } });
  servers.push(server);
  const context = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', ...contextOptions });
  // Registered first = lowest priority: anything not mocked below is blocked.
  await blockExternal(context, [server.url, 'data:']);
  const osmLog = await mockOsm(context, osm);
  const googleLog = google ? await mockGoogle(context, google) : null;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
  if (clock) await page.clock.install(); // time runs as usual, and tests can jump ahead
  await page.goto(server.url + query);
  return { page, context, osmLog, googleLog, errors, server };
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

/** How side `side` gets to the first place in the list, by its time's icon. */
const travelMode = (page, side) => page.locator(`#place-list .time-${side} .mode-icon`).first().getAttribute('data-mode');

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
  // Once the page has scrolled up: the map, and the card's links right under it.
  await page.waitForFunction(() => Math.abs(document.querySelector('.map-wrap').getBoundingClientRect().top) < 12);
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

test('submitting right after picking a suggestion uses the pick, not a new text lookup', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: { detailsDelayMs: 600 } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const calls = await page.evaluate(() => window.__fakeGoogleCalls);
  assert.equal(calls.filter((c) => c.startsWith('searchByText')).length, 0, calls.join(','));
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

test('phones, free mode: the first search scrolls to the map', async () => {
  const { page, context } = await openApp({ viewport: { width: 390, height: 844 } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  await page.waitForTimeout(900); // smooth scroll
  const top = await page.locator('.map-wrap').evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(top >= -1 && top < 100, `map top at ${top}px`);
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
  await page.locator('#only-green-line').check({ force: true });
  await page.locator('#only-shabbat-closed').check({ force: true });
  await page.reload();
  assert.equal(await page.locator('#only-green-line').isChecked(), true);
  assert.equal(await page.locator('#only-shabbat-closed').isChecked(), true);
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
