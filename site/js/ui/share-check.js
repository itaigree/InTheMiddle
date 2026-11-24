// "בדיקת שיתוף": a few requests to the share service from this very phone (or
// the Android app), each with its answer and time, and the last real share's
// fate, on screen and in the service's log. For when shares come out long and
// nothing reaches the service.

import { makeSnapshot, newSnapshotKey } from '../core/snapshot.js';

const LAST_SHARE_KEY = 'inthemiddle.lastShare';
const CHECK_TIMEOUT_MS = 15000;

/**
 * Note a share (`start`: a new one, which replaces the last) or what became of
 * it (merged only into the same share: an older one's outcome doesn't overwrite).
 */
export function rememberShareAttempt(id, patch, { start = false } = {}) {
  try {
    const last = JSON.parse(localStorage.getItem(LAST_SHARE_KEY) || 'null');
    if (!start && (!last || last.id !== id)) return;
    localStorage.setItem(LAST_SHARE_KEY, JSON.stringify(start ? { id, ...patch } : { ...last, ...patch }));
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

/** A call to the share store with a time limit, timed: {value, ms} or {error, ms}. */
async function timedCall(call) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  const started = performance.now();
  try {
    const value = await call(controller.signal);
    return { value, ms: Math.round(performance.now() - started) };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    return { error: err?.name === 'AbortError' ? `no answer in ${CHECK_TIMEOUT_MS / 1000} s` : `${err?.name}: ${err?.message}`, ms };
  } finally {
    clearTimeout(timer);
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
 * Run the check into `list` (an <ol>), one line per step as it ends, while
 * `isCurrent()` (a newer run replaces it). Returns the result as text: `shown`,
 * all of it (to copy), and `logged`, without what is personal (the last share's
 * id, which would open it, and the full browser string), for the service's log.
 */
export async function runShareCheck({ store, build, list, isCurrent = () => true }) {
  list.replaceChildren();
  const lines = [];
  const logged = [];
  const pending = document.createElement('li');
  pending.textContent = '· בודקים…';
  list.append(pending);
  const add = (ok, title, detail, { personal = null } = {}) => {
    if (!isCurrent()) return;
    const mark = ok === true ? '✓' : ok === false ? '✗' : '·';
    const line = `${mark} ${title}: ${detail}`;
    lines.push(line);
    if (personal !== 'drop') logged.push(personal === null ? line : `${mark} ${title}: ${personal}`);
    const li = document.createElement('li');
    li.textContent = line;
    pending.before(li);
  };

  const ua = navigator.userAgent;
  const appVersion = ua.match(/InTheMiddleApp\/(\S+)/)?.[1];
  add(null, 'גרסה', `${build ? String(build).slice(0, 7) : 'מקומית'}${appVersion ? ` · באפליקציה ${appVersion}` : ' · בדפדפן'}`);
  add(null, 'דפדפן', ua.replace(/\s*\(KHTML, like Gecko\)/, ''), { personal: 'drop' });
  const connection = navigator.connection;
  add(
    null,
    'רשת',
    `${navigator.onLine ? 'מחובר' : 'לא מחובר'}${connection?.type ? ` · ${connection.type}` : ''}${connection?.effectiveType ? ` · ${connection.effectiveType}` : ''}${connection?.rtt ? ` · rtt ${connection.rtt} ms` : ''}`,
  );
  add(null, 'יכולות', `crypto.subtle ${crypto?.subtle ? 'יש' : 'אין'} · navigator.share ${navigator.share ? 'יש' : 'אין'} · service worker ${navigator.serviceWorker?.controller ? 'פעיל' : 'לא פעיל'}`);

  const last = lastShareAttempt();
  const fate = (l) =>
    `${l.at || ''} · קישור ${l.link || '?'} · ${l.ok === true ? `נשמר אחרי ${l.ms} ms` : l.ok === false ? `לא נשמר (${l.problem || '?'}) אחרי ${l.ms} ms` : l.reason || 'לא ידוע אם נשמר'}`;
  add(last ? (last.ok ?? null) : null, 'השיתוף האחרון', last ? `${fate(last)}${last.id ? ` · ${last.id}` : ''}` : 'אין', {
    personal: last ? fate(last) : null,
  });

  // The site itself: the control (the app does reach it).
  const site = await timed(`config.js?check=${Date.now()}`, { cache: 'no-store' });
  add(site.status === 200, 'האתר עצמו', shown(site));

  if (!store) {
    add(false, 'שירות השיתוף', 'לא מוגדר באתר');
    pending.remove();
    return { shown: lines.join('\n'), logged: logged.join('\n') };
  }
  add(null, 'שירות השיתוף', store.kind === 'firestore' ? 'Google Firestore' : `Cloudflare (${store.origin.replace(/^https:\/\//, '')})`);
  const timing = (r, what) => (r.error ? `${r.error} · ${r.ms} ms` : `${what} · ${r.ms} ms`);
  const read = await timedCall((signal) => store.load('AAAAAAAAAAAA', { signal }));
  add(!read.error && read.value === null, 'שירות השיתוף, קריאה', timing(read, read.value === null ? 'עונה' : 'תשובה לא צפויה'));

  let storedId = null;
  const { key, id } = await newSnapshotKey();
  const save = await timedCall((signal) => store.save(id, JSON.stringify(testSnapshot()), { key, signal }));
  add(!save.error, 'שירות השיתוף, שמירה', timing(save, 'נשמר'));
  if (!save.error) storedId = id;
  if (storedId) {
    const back = await timedCall((signal) => store.load(storedId, { signal }));
    add(!back.error && back.value !== null, 'שירות השיתוף, קריאה של מה שנשמר', timing(back, back.value ? 'נקרא' : 'לא נמצא'));
  }

  if (isCurrent()) {
    pending.remove();
    // Into the service's log too, where there is one (the Cloudflare service).
    if (store.logUrl) fetch(store.logUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ kind: 'check', details: logged.join('\n').slice(0, 1500), version: build ? String(build).slice(0, 12) : null }),
    }).catch(() => {});
  }
  return { shown: lines.join('\n'), logged: logged.join('\n') };
}
