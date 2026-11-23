import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/share.js';
import { makeSnapshot, parseSnapshot, newSnapshotKey } from '../../site/js/core/snapshot.js';

const SITE = 'https://itaigree.github.io';

function fakeKv() {
  const data = new Map();
  const calls = [];
  return {
    data,
    calls,
    async get(key) {
      calls.push(`get:${key}`);
      return data.has(key) ? data.get(key).value : null;
    },
    async put(key, value, options) {
      calls.push(`put:${key}`);
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

const store = (e, id, key, snap, options) => call(e, 'POST', id, { ...options, body: JSON.stringify({ key, snapshot: snap }) });

test('share service: a snapshot is stored for 30 days under its key\'s id, and read back, from the site only', async () => {
  const e = env();
  const { key, id } = await newSnapshotKey();
  const stored = await store(e, id, key, snapshot());
  assert.equal(stored.status, 201);
  assert.equal(stored.headers.get('Access-Control-Allow-Origin'), SITE);
  assert.equal(e.SHARES.data.get(id).options.expirationTtl, 30 * 24 * 3600);
  // Nothing was read first (KV would keep that "not found" a minute, right where it's read next).
  assert.deepEqual(e.SHARES.calls, [`put:${id}`]);

  const got = await call(e, 'GET', id);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('Access-Control-Allow-Origin'), SITE);
  assert.equal(got.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.deepEqual(parseSnapshot(await got.json()), snapshot());

  // Someone holding the link (the id) but not the key can't store anything under it.
  const other = await newSnapshotKey();
  assert.equal((await store(e, id, other.key, { ...snapshot(), at: 5 })).status, 403);
  assert.equal(JSON.parse(e.SHARES.data.get(id).value).at, snapshot().at);

  // Another site's page can't store, and isn't let read (no CORS header).
  const fresh = await newSnapshotKey();
  assert.equal((await store(e, fresh.id, fresh.key, snapshot(), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await store(e, fresh.id, fresh.key, snapshot(), { origin: null })).status, 403);
  assert.equal((await call(e, 'GET', id, { origin: 'https://evil.example' })).headers.get('Access-Control-Allow-Origin'), null);
  // The local test server is allowed.
  assert.equal((await call(e, 'GET', id, { origin: 'http://localhost:8080' })).headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');
});

test('share service: what it refuses', async () => {
  const e = env();
  const { key, id } = await newSnapshotKey();
  assert.equal((await call(e, 'GET', id)).status, 404);
  assert.equal((await call(e, 'GET', 'short')).status, 404);
  assert.equal((await call(e, 'POST', id, { body: 'not json' })).status, 403);
  // A bare snapshot (no key), as the app sent before.
  assert.equal((await call(e, 'POST', id, { body: JSON.stringify(snapshot()) })).status, 403);
  assert.equal((await store(e, id, 'short-key', snapshot())).status, 403);
  assert.equal((await store(e, id, key, { v: 1 })).status, 400);
  const huge = { ...snapshot(), filler: 'x'.repeat(70 * 1024) };
  assert.equal((await store(e, id, key, huge)).status, 413);
  assert.equal((await call(e, 'DELETE', id)).status, 405);
  assert.equal(e.SHARES.data.size, 0);
  // Extras in an accepted snapshot are not stored.
  const withExtras = snapshot();
  withExtras.places[0].photoUrl = 'https://evil.example/x.png';
  assert.equal((await store(e, id, key, withExtras)).status, 201);
  assert.doesNotMatch(e.SHARES.data.get(id).value, /evil/);
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
