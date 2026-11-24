// Where shared results (core/snapshot.js) are kept: Google Cloud Firestore,
// or else the Cloudflare share service (worker/share.js).
//
// Firestore comes first: its address, firestore.googleapis.com, is found by
// every DNS server, while some (Pelephone's, for one) answer "no such name"
// for *.workers.dev. It is used straight from the page through its REST API,
// with the project's public web API key; its security rules (README, "שיתוף
// התוצאות") let anyone create a share once and read one by its id, and nothing
// else. A TTL policy deletes them after KEEP_DAYS.

export const KEEP_DAYS = 30;
const FIRESTORE_API = 'https://firestore.googleapis.com/v1';

/**
 * The store the config names: {kind, origin, save(id, json, {key, signal}),
 * load(id, {signal})}, or null when there is none. load gives the parsed
 * snapshot, or null when there's none under that id (or it has expired), and
 * throws when the store can't be reached.
 */
export function createShareStore(config = {}) {
  const firestore = config.firestore;
  if (firestore?.projectId && firestore?.apiKey) return firestoreStore(firestore);
  const api = (config.shareApiUrl || '').replace(/\/+$/, '');
  if (api) return workerStore(api);
  return null;
}

function failure(response) {
  return new Error(`share service: ${response.status}`);
}

function firestoreStore({ projectId, apiKey }) {
  const shares = `${FIRESTORE_API}/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/shares`;
  const key = `key=${encodeURIComponent(apiKey)}`;
  return {
    kind: 'firestore',
    origin: 'https://firestore.googleapis.com',
    async save(id, json, { signal } = {}) {
      const expireAt = new Date(Date.now() + KEEP_DAYS * 24 * 3600 * 1000).toISOString();
      const response = await fetch(`${shares}?documentId=${encodeURIComponent(id)}&${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            v: { integerValue: '1' },
            data: { stringValue: json },
            expireAt: { timestampValue: expireAt },
          },
        }),
        signal,
      });
      if (!response.ok) throw failure(response);
    },
    async load(id, { signal } = {}) {
      const response = await fetch(`${shares}/${encodeURIComponent(id)}?${key}`, { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw failure(response);
      const fields = (await response.json())?.fields || {};
      // TTL deletes a while after the time: past it, the share is gone already.
      const expireAt = Date.parse(fields.expireAt?.timestampValue);
      if (Number.isFinite(expireAt) && expireAt < Date.now()) return null;
      const text = fields.data?.stringValue;
      return typeof text === 'string' ? JSON.parse(text) : null;
    },
  };
}

function workerStore(api) {
  return {
    kind: 'worker',
    origin: api,
    /** The worker's log takes the app's reports (a store that failed or was slow). */
    logUrl: `${api}/log`,
    async save(id, json, { key, signal } = {}) {
      // Plain text: a simple request, so no preflight.
      const response = await fetch(`${api}/s/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: `{"key":${JSON.stringify(key)},"snapshot":${json}}`,
        signal,
      });
      if (response.status !== 201) throw failure(response);
    },
    async load(id, { signal } = {}) {
      const response = await fetch(`${api}/s/${id}`, { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw failure(response);
      return response.json();
    },
  };
}
