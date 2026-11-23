// The share service: keeps a search's free (OpenStreetMap) results for a while,
// so a shared link shows them as they were instead of searching again.
// A Cloudflare Worker with one KV namespace (SHARES), deployed by
// .github/workflows/deploy.yml. See the README, "שיתוף התוצאות".
//
//   POST /s/<id>  store a snapshot (site/js/core/snapshot.js): the body is
//                 {key, snapshot}, and <id> must be the start of the key's
//                 SHA-256, so only the one who drew the key stores under it.
//                 Sent as text/plain, a simple request: no preflight to wait for.
//   GET /s/<id>   read it back (404 once it has expired)
//   GET /log      the latest entries of a short technical log (kept 2 days):
//                 each read and store, with its answer and time, the kind of
//                 browser and the Cloudflare location, never what was shared
//   POST /log     the app's own report of a store that failed or was slow
//
// Every snapshot is checked with the app's own code and stored as rebuilt from
// what passed. Nothing is read before it is stored: KV would keep that "not
// found" for a minute where the results are about to be read.

import { parseSnapshot, snapshotIdOf, SNAPSHOT_ID_RE, SNAPSHOT_KEY_RE, MAX_SNAPSHOT_BYTES } from '../site/js/core/snapshot.js';

const DAY_SECONDS = 24 * 3600;

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function respond(status, body, { origin = null, extra = {} } = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
    ...extra,
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

const LOG_DAYS = 2;
const MAX_REPORT_BYTES = 4096;

/** A few technical facts about a request, for the log (no address, nothing shared). */
function describe(request) {
  const ua = request.headers.get('User-Agent') || '';
  return {
    browser: /; wv\)/.test(ua)
      ? 'android-webview'
      : /Android/.test(ua)
        ? 'android'
        : /iPhone|iPad/.test(ua)
          ? 'ios'
          : /Mobile/.test(ua)
            ? 'mobile'
            : 'desktop',
    chrome: ua.match(/Chrome\/(\d+)/)?.[1] ?? null,
    colo: request.cf?.colo ?? null,
    country: request.cf?.country ?? null,
    http: request.cf?.httpProtocol ?? null,
  };
}

/** Orders entries of the same millisecond (within one isolate). */
let logSeq = 0;

async function writeLog(env, entry) {
  try {
    const key = `log:${entry.at}:${String(logSeq++ % 1e6).padStart(6, '0')}${crypto.randomUUID().slice(0, 4)}`;
    await env.SHARES.put(key, JSON.stringify(entry), { expirationTtl: LOG_DAYS * DAY_SECONDS });
  } catch {
    // The log never gets in the way.
  }
}

/** The latest log entries, oldest first. */
async function readLog(env, count = 60) {
  const names = [];
  let cursor;
  do {
    const page = await env.SHARES.list({ prefix: 'log:', cursor });
    names.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && names.length < 2000);
  const latest = names.sort().slice(-count);
  const entries = await Promise.all(latest.map(async (name) => JSON.parse((await env.SHARES.get(name)) || 'null')));
  return entries.filter(Boolean);
}

/** The app's report of a store that failed or was slow: only these fields, short. */
function reportOf(text) {
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const short = (x, max) => (typeof x === 'string' ? x.slice(0, max) : null);
  return {
    kind: short(body.kind, 30),
    problem: short(body.problem, 200),
    ms: Number.isFinite(body.ms) ? Math.round(body.ms) : null,
    bytes: Number.isFinite(body.bytes) ? Math.round(body.bytes) : null,
    version: short(body.version, 20),
    details: short(body.details, 1500),
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const started = Date.now();
    const later = (promise) => (ctx?.waitUntil ? ctx.waitUntil(promise) : promise);
    if (url.pathname === '/log') {
      if (request.method === 'GET') {
        return new Response(JSON.stringify(await readLog(env), null, 1), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
        });
      }
      const requestOrigin = request.headers.get('Origin');
      if (request.method !== 'POST' || !requestOrigin || !allowedOrigins(env).includes(requestOrigin)) return respond(403, null);
      const text = await request.text();
      const report = text.length <= MAX_REPORT_BYTES ? reportOf(text) : null;
      if (!report) return respond(400, null, { origin: requestOrigin });
      await later(writeLog(env, { at: new Date(started).toISOString(), method: 'REPORT', ...report, ...describe(request) }));
      return respond(204, null, { origin: requestOrigin });
    }
    const response = await handle(request, env, url);
    if (url.pathname.startsWith('/s/') && (request.method === 'GET' || request.method === 'POST')) {
      await later(
        writeLog(env, {
          at: new Date(started).toISOString(),
          method: request.method,
          status: response.status,
          ms: Date.now() - started,
          bytes: Number(request.headers.get('Content-Length')) || null,
          ...describe(request),
        }),
      );
    }
    return response;
  },
};

/** The answer to a request for a snapshot (/s/<id>). */
async function handle(request, env, url) {
  const match = url.pathname.match(/^\/s\/([^/]+)$/);
  const requestOrigin = request.headers.get('Origin');
  // Only the app's own pages may use the service from a browser.
  const origin = requestOrigin && allowedOrigins(env).includes(requestOrigin) ? requestOrigin : null;
  if (!match || !SNAPSHOT_ID_RE.test(match[1])) return respond(404, { error: 'not found' }, { origin });
  const id = match[1];

  if (request.method === 'OPTIONS') {
    if (!origin) return respond(403, null);
    return respond(204, null, {
      origin,
      extra: {
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (request.method === 'GET') {
    const stored = await env.SHARES.get(id);
    if (stored === null) return respond(404, { error: 'not found' }, { origin });
    return new Response(stored, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600',
        Vary: 'Origin',
        ...(origin && { 'Access-Control-Allow-Origin': origin }),
      },
    });
  }

  if (request.method === 'POST') {
    if (!origin) return respond(403, { error: 'origin not allowed' });
    const declared = Number(request.headers.get('Content-Length'));
    if (declared > MAX_SNAPSHOT_BYTES) return respond(413, { error: 'too large' }, { origin });
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_SNAPSHOT_BYTES) return respond(413, { error: 'too large' }, { origin });
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    const key = body?.key;
    if (typeof key !== 'string' || !SNAPSHOT_KEY_RE.test(key) || (await snapshotIdOf(key)) !== id) {
      return respond(403, { error: 'not this id\'s key' }, { origin });
    }
    const snapshot = parseSnapshot(body.snapshot);
    if (!snapshot) return respond(400, { error: 'not a snapshot' }, { origin });
    const days = Math.min(365, Math.max(1, Number(env.TTL_DAYS) || 30));
    await env.SHARES.put(id, JSON.stringify(snapshot), { expirationTtl: days * DAY_SECONDS });
    return respond(201, { id, days }, { origin });
  }

  return respond(405, { error: 'method not allowed' }, { origin, extra: { Allow: 'GET, POST, OPTIONS' } });
}
