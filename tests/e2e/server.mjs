// Minimal static file server for end-to-end tests (serves site/).

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../site');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * Starts the server on a free port. `overrides` maps URL paths to file contents,
 * e.g. {'/config.js': 'window.APP_CONFIG = {...}'}. `setOffline(true)` makes it
 * drop every connection, which (unlike Playwright's offline mode) also affects
 * requests made by a service worker.
 *
 * For service worker updates: `setVersion('v2')` stamps sw.js like a deploy and
 * tags every response with an x-version header; `delays` maps paths (or '*') to
 * how long to wait before answering. A worker precaching files is delayed by
 * 'precache:<path>' (or 'precache:*') instead, so a slow page load and a slow
 * install can be set apart.
 */
export async function startServer({ overrides = {} } = {}) {
  let offline = false;
  let version = null;
  const delays = {};
  const server = http.createServer(async (req, res) => {
    if (offline) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const servedVersion = version;
    // The worker precaches with cache: 'reload', which sends Pragma: no-cache.
    const kind = req.headers.pragma === 'no-cache' ? 'precache:' : '';
    const delay = delays[kind + pathname] ?? delays[`${kind}*`] ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (offline) {
      req.socket.destroy();
      return;
    }
    const headers = (type) => ({
      'content-type': type,
      ...(servedVersion && { 'x-version': servedVersion, 'access-control-expose-headers': 'x-version' }),
    });
    if (overrides[pathname] != null) {
      res.writeHead(200, headers(TYPES[path.extname(pathname)] || 'text/plain'));
      res.end(overrides[pathname]);
      return;
    }
    const file = path.join(ROOT, pathname);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    try {
      let body = await fs.readFile(file);
      if (servedVersion && pathname === '/sw.js') body = body.toString().replaceAll('__BUILD__', servedVersion);
      res.writeHead(200, headers(TYPES[path.extname(file)] || 'application/octet-stream'));
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((r) => server.close(r)),
    delays,
    setVersion(value) {
      version = value;
    },
    setOffline(value) {
      offline = value;
      if (value) server.closeAllConnections();
    },
  };
}
