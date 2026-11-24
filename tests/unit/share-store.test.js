import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createShareStore, KEEP_DAYS } from '../../site/js/providers/share-store.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer fetch calls with `respond(url, init)`, and keep them. */
function fakeFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  return calls;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('the store: Firestore when configured, else the Cloudflare service, else none', () => {
  assert.equal(createShareStore({ firestore: { projectId: 'p', apiKey: 'k' }, shareApiUrl: 'https://x.workers.dev' }).kind, 'firestore');
  assert.equal(createShareStore({ firestore: null, shareApiUrl: 'https://x.workers.dev/' }).kind, 'worker');
  assert.equal(createShareStore({ firestore: { projectId: 'p' }, shareApiUrl: '' }), null);
  assert.equal(createShareStore({}), null);
});

test('Firestore: a share is created once under its id, with its data and when it expires', async () => {
  const store = createShareStore({ firestore: { projectId: 'inthemiddle-123', apiKey: 'AIza-test' } });
  const calls = fakeFetch(() => json(200, { name: 'x' }));
  const before = Date.now();
  await store.save('Ab3_-xYz0123', '{"v":1}', { key: 'ignored' });
  const [{ url, init }] = calls;
  assert.equal(
    url,
    'https://firestore.googleapis.com/v1/projects/inthemiddle-123/databases/(default)/documents/shares?documentId=Ab3_-xYz0123&key=AIza-test',
  );
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  const { fields } = JSON.parse(init.body);
  assert.deepEqual(Object.keys(fields).sort(), ['data', 'expireAt', 'v']);
  assert.deepEqual(fields.v, { integerValue: '1' });
  assert.deepEqual(fields.data, { stringValue: '{"v":1}' });
  const days = (Date.parse(fields.expireAt.timestampValue) - before) / (24 * 3600 * 1000);
  assert.ok(Math.abs(days - KEEP_DAYS) < 0.01, `${days} days`);

  // Refused (taken, or the rules said no): an error that says the answer.
  fakeFetch(() => json(409, { error: { code: 409, status: 'ALREADY_EXISTS' } }));
  await assert.rejects(store.save('Ab3_-xYz0123', '{}'), /share service: 409/);
});

test('Firestore: a share is read back by its id; none, or past its time, is null; out of reach throws', async () => {
  const store = createShareStore({ firestore: { projectId: 'p', apiKey: 'k' } });
  const later = new Date(Date.now() + 3600e3).toISOString();
  const calls = fakeFetch(() => json(200, { fields: { v: { integerValue: '1' }, data: { stringValue: '{"v":1,"at":5}' }, expireAt: { timestampValue: later } } }));
  assert.deepEqual(await store.load('Ab3_-xYz0123'), { v: 1, at: 5 });
  assert.equal(calls[0].url, 'https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/shares/Ab3_-xYz0123?key=k');

  fakeFetch(() => json(404, { error: { code: 404, status: 'NOT_FOUND' } }));
  assert.equal(await store.load('Ab3_-xYz0123'), null);

  // TTL deletes late: past expireAt it is gone already.
  const earlier = new Date(Date.now() - 1000).toISOString();
  fakeFetch(() => json(200, { fields: { data: { stringValue: '{}' }, expireAt: { timestampValue: earlier } } }));
  assert.equal(await store.load('Ab3_-xYz0123'), null);

  fakeFetch(() => json(403, { error: { code: 403 } }));
  await assert.rejects(store.load('Ab3_-xYz0123'), /share service: 403/);
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(store.load('Ab3_-xYz0123'), TypeError);
});

test('the Cloudflare service: as before, with its key and its log', async () => {
  const store = createShareStore({ shareApiUrl: 'https://s.workers.dev' });
  assert.equal(store.logUrl, 'https://s.workers.dev/log');
  const calls = fakeFetch((url, init) => (init.method === 'POST' ? new Response('{}', { status: 201 }) : json(200, { v: 1 })));
  await store.save('Ab3_-xYz0123', '{"v":1}', { key: 'K'.repeat(22) });
  assert.equal(calls[0].url, 'https://s.workers.dev/s/Ab3_-xYz0123');
  assert.deepEqual(JSON.parse(calls[0].init.body), { key: 'K'.repeat(22), snapshot: { v: 1 } });
  assert.deepEqual(await store.load('Ab3_-xYz0123'), { v: 1 });
});
