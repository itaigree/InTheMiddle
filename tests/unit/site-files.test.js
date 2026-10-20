import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../site');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [path.relative(SITE, full).split(path.sep).join('/')];
  });
}

test('service worker precache list matches the site files', () => {
  const sw = fs.readFileSync(path.join(SITE, 'sw.js'), 'utf8');
  const shell = [...sw.matchAll(/^ {2}'([^']+)',$/gm)].map((m) => m[1]);
  // Every precached file exists (cache.addAll fails the whole install otherwise)…
  for (const file of shell.filter((f) => f !== './')) {
    assert.ok(fs.existsSync(path.join(SITE, file)), `sw.js precaches missing file ${file}`);
  }
  // …and every app module is precached, so the app works offline.
  for (const file of walk(path.join(SITE, 'js')).map((f) => f).filter((f) => f.endsWith('.js'))) {
    assert.ok(shell.includes(file), `${file} is not in the sw.js precache list`);
  }
  assert.match(sw, /__BUILD__/, 'deploy workflow stamps __BUILD__ into sw.js');
});

test('manifest is valid and subpath-safe', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SITE, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.ok(!('id' in manifest) || manifest.id.startsWith('/InTheMiddle/'), 'a relative id resolves to the origin root');
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(SITE, icon.src)), icon.src);
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
});

test('index.html references only files that exist', () => {
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 3);
  for (const ref of refs) assert.ok(fs.existsSync(path.join(SITE, ref)), `index.html references missing ${ref}`);
});
