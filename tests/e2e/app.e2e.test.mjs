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

async function openApp({ key = '', google = null, osm = {}, viewport = { width: 1280, height: 900 }, query = '' } = {}) {
  const server = await startServer({ overrides: { '/config.js': configJs(key) } });
  servers.push(server);
  const context = await browser.newContext({ viewport, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
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
