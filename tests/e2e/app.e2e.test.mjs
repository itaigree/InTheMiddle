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

async function openApp({ key = '', google = null, osm = {}, viewport = { width: 1280, height: 900 }, query = '', contextOptions = {} } = {}) {
  const server = await startServer({ overrides: { '/config.js': configJs(key) } });
  servers.push(server);
  const context = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', ...contextOptions });
  // Registered first = lowest priority: anything not mocked below is blocked.
  await blockExternal(context, [server.url, 'data:']);
  const osmLog = await mockOsm(context, osm);
  const googleLog = google ? await mockGoogle(context, google) : null;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
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
  // The search is in the URL, ready to share.
  const url = new URL(page.url());
  assert.equal(url.searchParams.get('a'), 'חיפה');
  assert.equal(url.searchParams.get('b'), 'תל אביב-יפו');
  // The midpoint came from the route timeline: only one OSRM table call (for candidates).
  assert.equal(osmLog.osrmRoute.length, 1);
  assert.equal(osmLog.osrmTable.length, 1);
  assert.equal(osmLog.overpass.length, 1);

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

test('free mode: public transit through Transitous', async () => {
  const { page, context, osmLog, errors } = await openApp();
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'באר שבע');
  await page.locator('input[name="mode-b"][value="transit"]').check({ force: true });
  await search(page);
  // One Transitous call for sampling the route and one for the candidates, from B only.
  assert.equal(osmLog.transit.length, 2);
  assert.ok(osmLog.transit.every((q) => new URLSearchParams(q).get('one').startsWith('31.2518')));
  assert.match(await page.locator('#place-list .time-b .time-value').first().textContent(), /🚌/);
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
  assert.match(await page.locator('#place-list .time-b .time-value').first().textContent(), /🚗/);
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

test('Overpass outage shows a friendly error', async () => {
  const { page, context } = await openApp({ osm: { failOverpass: true } });
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
  const params = new URL(page.url()).searchParams;
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

test('Google mode: mixed modes query transit only for that side', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: {} });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await page.locator('input[name="mode-b"][value="transit"]').check({ force: true });
  await search(page);
  const matrices = (await page.evaluate(() => window.__fakeGoogleCalls)).filter((c) => c.startsWith('matrix:'));
  assert.deepEqual(matrices.slice(0, 1), ['matrix:TRANSIT:1x8']);
  assert.ok(matrices.includes(matrices.find((m) => m.startsWith('matrix:DRIVING:1x'))));
  const bTime = await page.locator('#place-list .time-b .time-value').first().textContent();
  assert.match(bTime, /🚌/);
  await context.close();
});

test('Google mode: no transit service (Shabbat) falls back to driving for that side', async () => {
  const { page, context } = await openApp({ key: 'TEST_KEY', google: { transitNoService: true } });
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await page.locator('input[name="mode-a"][value="transit"]').check({ force: true });
  await search(page);
  assert.match(await page.locator('#status').textContent(), /לא מצאנו תחבורה ציבורית/);
  assert.match(await page.locator('#place-list .time-a .time-value').first().textContent(), /🚗/);
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
  const params = new URL(page.url()).searchParams;
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

test('a failed search keeps the URL of the results on screen', async () => {
  const { page, context } = await openApp();
  await pickSuggestion(page, 'a', 'חיפה');
  await pickSuggestion(page, 'b', 'תל אביב');
  await search(page);
  const shownUrl = page.url();
  await page.locator('#input-b').fill('מקום שלא קיים');
  await page.locator('#submit').click();
  await page.locator('#status[data-kind="error"]').waitFor();
  assert.equal(page.url(), shownUrl);
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
