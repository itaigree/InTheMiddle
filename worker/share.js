// The share service: keeps a search's free (OpenStreetMap) results for a while,
// so a shared link shows them as they were instead of searching again.
// A Cloudflare Worker with one KV namespace (SHARES), deployed by
// .github/workflows/deploy.yml. See the README, "שיתוף התוצאות".
//
//   POST /s/<id>  store a snapshot (site/js/core/snapshot.js) under an id the
//                 sender's browser drew; an id is never overwritten. Sent as
//                 text/plain, a simple request: no preflight to wait for.
//   GET /s/<id>   read it back (404 once it has expired)
//
// The sender's browser draws the id so it can share the link at once, while the
// tap still allows it, and store the results alongside. Every snapshot is checked
// with the app's own code and stored as rebuilt from what passed.

import { parseSnapshot, SNAPSHOT_ID_RE, MAX_SNAPSHOT_BYTES } from '../site/js/core/snapshot.js';

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
      let snapshot;
      try {
        snapshot = parseSnapshot(JSON.parse(text));
      } catch {
        snapshot = null;
      }
      if (!snapshot) return respond(400, { error: 'not a snapshot' }, { origin });
      // Ids are drawn at random, so one that exists is someone else's: keep it.
      if ((await env.SHARES.get(id)) !== null) return respond(409, { error: 'exists' }, { origin });
      const days = Math.min(365, Math.max(1, Number(env.TTL_DAYS) || 30));
      await env.SHARES.put(id, JSON.stringify(snapshot), { expirationTtl: days * DAY_SECONDS });
      return respond(201, { id, days }, { origin });
    }

    return respond(405, { error: 'method not allowed' }, { origin, extra: { Allow: 'GET, POST, OPTIONS' } });
  },
};
