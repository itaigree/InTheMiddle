// "בדיקת שיתוף": a few requests to the share service from this very phone (or
// the Android app), each with its answer and time, and the last real share's
// fate, on screen and in the service's log. For when shares come out long and
// nothing reaches the service.

import { makeSnapshot, newSnapshotKey } from '../core/snapshot.js';

const LAST_SHARE_KEY = 'inthemiddle.lastShare';
const CHECK_TIMEOUT_MS = 15000;

/** Note what became of a share (merged into what's noted for the same id). */
export function rememberShareAttempt(id, patch) {
  try {
    const last = JSON.parse(localStorage.getItem(LAST_SHARE_KEY) || 'null');
    const next = last && last.id === id ? { ...last, ...patch } : { id, ...patch };
    localStorage.setItem(LAST_SHARE_KEY, JSON.stringify(next));
  } catch {
    // Storage off: the check just can't say.
  }
}

function lastShareAttempt() {
  try {
    return JSON.parse(localStorage.getItem(LAST_SHARE_KEY) || 'null');
  } catch {
    return null;
  }
}

/** A request with a time limit, timed: {ok, status, ms, error}. */
async function timed(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  const started = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, ms: Math.round(performance.now() - started), text };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    return { error: err?.name === 'AbortError' ? `no answer in ${CHECK_TIMEOUT_MS / 1000} s` : `${err?.name}: ${err?.message}`, ms };
  } finally {
    clearTimeout(timer);
  }
}

const shown = (r) => (r.error ? `${r.error} · ${r.ms} ms` : `${r.status} · ${r.ms} ms`);

/** A tiny but valid snapshot, to store and read back. */
function testSnapshot() {
  return makeSnapshot({
    at: Date.now(),
    points: [
      { label: 'בדיקת שיתוף א', lat: 31.7789, lng: 35.2258, mode: 'car' },
      { label: 'בדיקת שיתוף ב', lat: 32.0853, lng: 34.7818, mode: 'car' },
    ],
    result: {
      route: null,
      midpoint: { lat: 31.93, lng: 35.0 },
      radius: 5000,
      balance: { time: 1800, reliable: true },
      priority: 'balanced',
      notices: [],
      places: [{ id: 'osm-node-1', name: 'בדיקה', lat: 31.93, lng: 35.0, category: 'cafe', timeA: 1800, timeB: 1800 }],
    },
    query: { categories: ['cafe'], departure: null, greenLine: false, shabbat: false, priority: 'balanced' },
  });
}

/**
 * Run the check into `list` (an <ol>), one line per step as it ends. Returns the
 * whole result as text (to copy, and for the service's log).
 */
export async function runShareCheck({ shareApi, build, list }) {
  list.replaceChildren();
  const lines = [];
  const add = (ok, title, detail) => {
    const line = `${ok === true ? '✓' : ok === false ? '✗' : '·'} ${title}: ${detail}`;
    lines.push(line);
    const li = document.createElement('li');
    li.textContent = line;
    list.append(li);
  };

  const ua = navigator.userAgent;
  add(null, 'גרסה', `${build ? String(build).slice(0, 7) : 'מקומית'}${/InTheMiddleApp\//.test(ua) ? ' · באפליקציה' : ' · בדפדפן'}`);
  add(null, 'דפדפן', ua.replace(/\s*\(KHTML, like Gecko\)/, '').slice(0, 160));
  const connection = navigator.connection;
  add(
    null,
    'רשת',
    `${navigator.onLine ? 'מחובר' : 'לא מחובר'}${connection?.type ? ` · ${connection.type}` : ''}${connection?.effectiveType ? ` · ${connection.effectiveType}` : ''}${connection?.rtt ? ` · rtt ${connection.rtt} ms` : ''}`,
  );
  add(null, 'יכולות', `crypto.subtle ${crypto?.subtle ? 'יש' : 'אין'} · navigator.share ${navigator.share ? 'יש' : 'אין'} · service worker ${navigator.serviceWorker?.controller ? 'פעיל' : 'לא פעיל'}`);

  const last = lastShareAttempt();
  add(
    last ? last.ok !== false : null,
    'השיתוף האחרון',
    last
      ? `${last.at || ''} · ${last.id || ''} · קישור ${last.link || '?'} · ${last.ok === true ? `נשמר אחרי ${last.ms} ms` : last.ok === false ? `לא נשמר (${last.problem || '?'}) אחרי ${last.ms} ms` : 'עוד לא ידוע אם נשמר'}`
      : 'אין',
  );

  // The site itself: the control (the app does reach it).
  const site = await timed(`config.js?check=${Date.now()}`, { cache: 'no-store' });
  add(site.status === 200, 'האתר עצמו', shown(site));

  if (!shareApi) {
    add(false, 'שירות השיתוף', 'לא מוגדר באתר');
    return lines.join('\n');
  }
  const read = await timed(`${shareApi}/s/AAAAAAAAAAAA`);
  add(read.status === 404, 'שירות השיתוף, קריאה', shown(read));

  let storedId = null;
  try {
    const { key, id } = await newSnapshotKey();
    const store = await timed(`${shareApi}/s/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ key, snapshot: testSnapshot() }),
    });
    add(store.status === 201, 'שירות השיתוף, שמירה', shown(store));
    if (store.status === 201) storedId = id;
  } catch (err) {
    add(false, 'שירות השיתוף, שמירה', `${err?.name}: ${err?.message}`);
  }
  if (storedId) {
    const back = await timed(`${shareApi}/s/${storedId}`);
    add(back.status === 200, 'שירות השיתוף, קריאה של מה שנשמר', shown(back));
  }

  const text = lines.join('\n');
  // Into the service's log too, when it can be reached.
  fetch(`${shareApi}/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ kind: 'check', details: text.slice(0, 1500), version: build ? String(build).slice(0, 12) : null }),
  }).catch(() => {});
  return text;
}
