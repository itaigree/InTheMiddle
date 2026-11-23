import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/share.js';
import { makeSnapshot, parseSnapshot } from '../../site/js/core/snapshot.js';

const SITE = 'https://itaigree.github.io';

function fakeKv() {
  const data = new Map();
  return {
    data,
    async get(key) {
      return data.has(key) ? data.get(key).value : null;
    },
    async put(key, value, options) {
      data.set(key, { value, options });
    },
  };
}

const env = () => ({ SHARES: fakeKv(), ALLOWED_ORIGINS: `${SITE}, http://localhost:8080`, TTL_DAYS: '30' });

const snapshot = () =>
  makeSnapshot({
    at: Date.parse('2026-11-23T12:30:00Z'),
    points: [
      { label: 'חיפה', lat: 32.794, lng: 34.9896, mode: 'car' },
      { label: 'תל אביב', lat: 32.0853, lng: 34.7818, mode: 'car' },
    ],
    result: {
      route: [
        { lat: 32.794, lng: 34.9896 },
        { lat: 32.0853, lng: 34.7818 },
      ],
      midpoint: { lat: 32.44, lng: 34.88 },
      radius: 5000,
      balance: { time: 2000, reliable: true },
      priority: 'balanced',
      notices: [],
      places: [{ id: 'osm-node-1', name: 'קפה 1', lat: 32.44, lng: 34.88, category: 'cafe', timeA: 2000, timeB: 2100 }],
    },
    query: { categories: ['cafe'], departure: null, greenLine: false, shabbat: false, priority: 'balanced' },
  });

const call = (e, method, id, { origin = SITE, body } = {}) =>
  worker.fetch(
    new Request(`https://inthemiddle-share.example.workers.dev/s/${id}`, {
      method,
      headers: { ...(origin && { Origin: origin }), ...(body !== undefined && { 'Content-Type': 'text/plain;charset=UTF-8' }) },
      body,
    }),
    e,
  );

test('share service: a snapshot is stored once for 30 days and read back, from the site only', async () => {
  const e = env();
  const id = 'Ab3_-xYz0123';
  const stored = await call(e, 'POST', id, { body: JSON.stringify(snapshot()) });
  assert.equal(stored.status, 201);
  assert.equal(stored.headers.get('Access-Control-Allow-Origin'), SITE);
  assert.equal(e.SHARES.data.get(id).options.expirationTtl, 30 * 24 * 3600);

  const got = await call(e, 'GET', id);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('Access-Control-Allow-Origin'), SITE);
  assert.equal(got.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.deepEqual(parseSnapshot(await got.json()), snapshot());

  // An id is never overwritten.
  const again = await call(e, 'POST', id, { body: JSON.stringify({ ...snapshot(), at: 5 }) });
  assert.equal(again.status, 409);
  assert.equal(JSON.parse(e.SHARES.data.get(id).value).at, snapshot().at);

  // Another site's page can't store, and isn't let read (no CORS header).
  assert.equal((await call(e, 'POST', 'zzzzzzzzzzzz', { origin: 'https://evil.example', body: JSON.stringify(snapshot()) })).status, 403);
  assert.equal((await call(e, 'POST', 'zzzzzzzzzzzz', { origin: null, body: JSON.stringify(snapshot()) })).status, 403);
  assert.equal((await call(e, 'GET', id, { origin: 'https://evil.example' })).headers.get('Access-Control-Allow-Origin'), null);
  // The local test server is allowed.
  assert.equal((await call(e, 'GET', id, { origin: 'http://localhost:8080' })).headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');
});

test('share service: what it refuses', async () => {
  const e = env();
  assert.equal((await call(e, 'GET', 'Ab3_-xYz0123')).status, 404);
  assert.equal((await call(e, 'GET', 'short')).status, 404);
  assert.equal((await call(e, 'POST', 'Ab3_-xYz0123', { body: 'not json' })).status, 400);
  assert.equal((await call(e, 'POST', 'Ab3_-xYz0123', { body: JSON.stringify({ v: 1 }) })).status, 400);
  const huge = { ...snapshot(), filler: 'x'.repeat(70 * 1024) };
  assert.equal((await call(e, 'POST', 'Ab3_-xYz0123', { body: JSON.stringify(huge) })).status, 413);
  assert.equal((await call(e, 'DELETE', 'Ab3_-xYz0123')).status, 405);
  assert.equal(e.SHARES.data.size, 0);
  // Extras in an accepted snapshot are not stored.
  const withExtras = snapshot();
  withExtras.places[0].photoUrl = 'https://evil.example/x.png';
  assert.equal((await call(e, 'POST', 'Ab3_-xYz0123', { body: JSON.stringify(withExtras) })).status, 201);
  assert.doesNotMatch(e.SHARES.data.get('Ab3_-xYz0123').value, /evil/);
});

test('share service: the browser\'s preflight is answered for the site', async () => {
  const e = env();
  const ok = await call(e, 'OPTIONS', 'Ab3_-xYz0123');
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), SITE);
  assert.match(ok.headers.get('Access-Control-Allow-Methods'), /POST/);
  assert.match(ok.headers.get('Access-Control-Allow-Headers'), /Content-Type/);
  assert.equal((await call(e, 'OPTIONS', 'Ab3_-xYz0123', { origin: 'https://evil.example' })).status, 403);
});
