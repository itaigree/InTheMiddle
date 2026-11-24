import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeSnapshot,
  parseSnapshot,
  snapshotToSearch,
  newSnapshotKey,
  snapshotIdOf,
  SNAPSHOT_KEY_RE,
  simplify,
  SNAPSHOT_ID_RE,
} from '../../site/js/core/snapshot.js';

const haifa = { lat: 32.794, lng: 34.9896 };
const telAviv = { lat: 32.0853, lng: 34.7818 };

/** A straight route from Haifa to Tel Aviv, `n` points. */
function straightRoute(n = 500) {
  return Array.from({ length: n }, (_, i) => ({
    lat: haifa.lat + ((telAviv.lat - haifa.lat) * i) / (n - 1),
    lng: haifa.lng + ((telAviv.lng - haifa.lng) * i) / (n - 1),
  }));
}

function pairResult(extra = {}) {
  return {
    providerId: 'osm',
    a: haifa,
    b: telAviv,
    modeA: 'car',
    modeB: 'transit',
    categories: ['cafe', 'park'],
    departure: null,
    route: straightRoute(),
    midpoint: { lat: 32.44, lng: 34.88 },
    radius: 5000,
    balance: { fraction: 0.5, time: 2040.4, reliable: true },
    priority: 'equal',
    notices: ['widened', 'departure-past'],
    places: [
      {
        id: 'osm-node-1',
        name: 'קפה 1',
        lat: 32.4412345,
        lng: 34.8812345,
        category: 'cafe',
        typeLabel: 'בית קפה',
        address: 'הרצל 5, חדרה',
        openNow: null,
        closedOnShabbat: true,
        source: 'osm',
        timeA: 2000.4,
        timeB: 2100,
        diff: 100,
        score: 1,
      },
      { id: 'osm-way-2', name: 'פארק 2', lat: 32.45, lng: 34.89, category: 'park', openNow: true, closedOnShabbat: null, timeA: 1900, timeB: 2300, diff: 400, score: 2 },
    ],
    ...extra,
  };
}

const query = { categories: ['cafe', 'park'], departure: null, greenLine: true, shabbat: false, priority: 'equal' };
const points = [
  { label: 'חיפה', ...haifa, mode: 'car' },
  { label: 'תל אביב-יפו', ...telAviv, mode: 'transit' },
];

test('a snapshot keeps what the list and the map need, and comes back as the same search', () => {
  const at = Date.parse('2026-11-23T12:30:00Z');
  const snap = makeSnapshot({ at, points, result: pairResult(), query });
  // Through JSON, as it travels.
  const back = parseSnapshot(JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(back, snap);
  // Only what was asked for: no source, score or the sender's own notices.
  assert.deepEqual(Object.keys(snap.places[0]).sort(), ['address', 'category', 'closedOnShabbat', 'id', 'lat', 'lng', 'name', 'openNow', 'times', 'typeLabel']);
  assert.deepEqual(snap.notices, ['widened']);
  assert.deepEqual(snap.places[0].times, [2000, 2100]);
  assert.equal(snap.places[0].lat, 32.44123);
  // A straight route needs only its two ends.
  assert.equal(snap.route.length, 2);

  const { query: q, result } = snapshotToSearch(back);
  assert.equal(q.a.label, 'חיפה');
  assert.equal(q.a.source, 'link');
  assert.equal(q.modeB, 'transit');
  assert.equal(q.greenLine, true);
  assert.equal(q.priority, 'equal');
  assert.deepEqual(q.extra, []);
  assert.equal(result.providerId, 'osm');
  assert.equal(result.group, undefined);
  assert.deepEqual(result.a, haifa);
  assert.equal(result.balance.time, 2040);
  assert.equal(result.sharedAt.getTime(), at);
  assert.deepEqual(
    result.places.map((p) => [p.id, p.timeA, p.timeB, p.diff]),
    [
      ['osm-node-1', 2000, 2100, 100],
      ['osm-way-2', 1900, 2300, 400],
    ],
  );
  assert.equal(result.route[0].lat, haifa.lat);
});

test('a group snapshot: everyone\'s times, no route', () => {
  const group = {
    ...pairResult(),
    group: true,
    points: [haifa, telAviv, { lat: 31.25, lng: 34.79 }],
    modes: ['car', 'car', 'transit'],
    route: null,
    places: [{ id: 'osm-node-9', name: 'קניון', lat: 32, lng: 34.9, category: 'cafe', openNow: null, closedOnShabbat: null, times: [100, 200, 300] }],
  };
  const snap = makeSnapshot({
    at: 1,
    points: [...points, { label: 'באר שבע', lat: 31.25, lng: 34.79, mode: 'transit' }],
    result: group,
    query,
  });
  const { query: q, result } = snapshotToSearch(parseSnapshot(JSON.parse(JSON.stringify(snap))));
  assert.equal(result.group, true);
  assert.equal(result.route, null);
  assert.deepEqual(result.modes, ['car', 'transit', 'transit']);
  assert.deepEqual(result.places[0].times, [100, 200, 300]);
  assert.equal(result.places[0].diff, 200);
  assert.deepEqual(q.extra, [{ label: 'באר שבע', lat: 31.25, lng: 34.79, source: 'link', mode: 'transit' }]);
});

test('a place\'s hours go with it, and whether it\'s open is as of when the link is opened', () => {
  const result = pairResult();
  const hours = 'Su-Th 08:00-22:00; Fr 08:00-14:00';
  result.places[0] = { ...result.places[0], hours, openNow: true };
  const snap = makeSnapshot({ at: 1, points, result, query });
  assert.equal(snap.places[0].hours, hours);
  assert.equal(snap.places[0].openNow, null); // not the sender's moment
  assert.equal(snap.places[1].openNow, true); // no hours (an older kind of place): as it was
  const back = parseSnapshot(JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(back, snap);
  const wednesdayMorning = new Date('2026-11-25T08:00:00Z'); // 10:00 in Israel
  const fridayEvening = new Date('2026-11-27T18:00:00Z'); // 20:00
  assert.equal(snapshotToSearch(back, wednesdayMorning).result.places[0].openNow, true);
  const later = snapshotToSearch(back, fridayEvening).result;
  assert.equal(later.places[0].openNow, false);
  assert.equal(later.places[0].hours, hours);
  assert.equal(later.places[1].openNow, true);
});

test('the route from a sender\'s own position starts away from it', () => {
  const snap = makeSnapshot({ at: 1, points, privatePoints: [haifa], result: pairResult({ route: straightRoute(2000) }), query });
  const first = { lat: snap.route[0][0], lng: snap.route[0][1] };
  const meters = Math.hypot((first.lat - haifa.lat) * 111000, (first.lng - haifa.lng) * 94000);
  assert.ok(meters >= 300, `${meters} m`);
  assert.deepEqual(snap.route.at(-1), [telAviv.lat, telAviv.lng]);
});

test('simplify keeps the bends that matter and drops the rest', () => {
  // An L: two straight legs of 1 km.
  const leg = (n, f) => Array.from({ length: n }, (_, i) => f(i / (n - 1)));
  const path = [...leg(50, (t) => ({ lat: 32, lng: 34.8 + 0.0106 * t })), ...leg(50, (t) => ({ lat: 32 + 0.009 * t, lng: 34.8106 }))];
  const out = simplify(path, 10);
  assert.equal(out.length, 3);
  assert.equal(out[1].lng, 34.8106);
});

test('a snapshot from elsewhere is checked: anything malformed is refused, anything extra dropped', () => {
  const good = JSON.parse(JSON.stringify(makeSnapshot({ at: 1, points, result: pairResult(), query })));
  assert.ok(parseSnapshot(good));
  // Extras on a place (a link, a picture) don't come through.
  const extras = structuredClone(good);
  Object.assign(extras.places[0], { mapsUrl: 'javascript:alert(1)', photoUrl: 'https://evil.example/x.png', rating: 5 });
  extras.html = '<script>';
  const cleaned = parseSnapshot(extras);
  assert.equal(cleaned.places[0].mapsUrl, undefined);
  assert.equal(cleaned.places[0].photoUrl, undefined);
  assert.equal(cleaned.html, undefined);

  const broken = [
    (s) => (s.v = 2),
    (s) => delete s.points,
    (s) => (s.points = [s.points[0]]),
    (s) => (s.points[0].lat = 91),
    (s) => (s.points[0].mode = 'plane'),
    (s) => (s.points[1].label = ' '),
    (s) => (s.categories = ['casino']),
    (s) => (s.categories = ['cafe', 'cafe']),
    (s) => (s.departure = 'tomorrow'),
    (s) => (s.priority = 'fast'),
    (s) => (s.radius = -1),
    (s) => (s.route = [[1, 2]]),
    (s) => (s.notices = ['<b>']),
    (s) => (s.places[0].id = '../x'),
    (s) => (s.places[1].id = s.places[0].id),
    (s) => (s.places[0].category = 'casino'),
    (s) => (s.places[0].times = [1]),
    (s) => (s.places[0].times = [1, -5]),
    (s) => (s.places[0].name = 'x'.repeat(201)),
    (s) => (s.places[0].openNow = 'yes'),
    (s) => (s.places[0].hours = 5),
    (s) => (s.places[0].hours = ' '),
    (s) => (s.places[0].hours = 'x'.repeat(256)),
    (s) => (s.places = Array.from({ length: 101 }, (_, i) => ({ ...s.places[0], id: `osm-node-${i}` }))),
  ];
  for (const breakIt of broken) {
    const s = structuredClone(good);
    breakIt(s);
    assert.equal(parseSnapshot(s), null, breakIt.toString());
  }
  for (const value of [null, 'x', 5, []]) assert.equal(parseSnapshot(value), null);
});

test('a snapshot\'s id comes from its random key: 12 URL-safe characters, the same every time', async () => {
  const made = await Promise.all(Array.from({ length: 200 }, newSnapshotKey));
  assert.equal(new Set(made.map((m) => m.key)).size, 200);
  assert.equal(new Set(made.map((m) => m.id)).size, 200);
  for (const { key, id } of made) {
    assert.match(key, SNAPSHOT_KEY_RE);
    assert.match(id, SNAPSHOT_ID_RE);
    assert.equal(await snapshotIdOf(key), id);
  }
  // SHA-256, base64url, the first 12 characters.
  assert.equal(await snapshotIdOf('AAAAAAAAAAAAAAAAAAAAAA'), 'ilvbTMFRZBJs');
});
