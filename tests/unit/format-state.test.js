import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatDistance } from '../../site/js/core/format.js';
import { encodeState, decodeState, EXTRA_KEYS } from '../../site/js/core/state.js';
import { MAX_POINTS } from '../../site/js/core/group.js';

test('formatDuration in Hebrew', () => {
  assert.equal(formatDuration(0), '1 דק׳');
  assert.equal(formatDuration(35 * 60), '35 דק׳');
  assert.equal(formatDuration(60 * 60), 'שעה');
  assert.equal(formatDuration(65 * 60), 'שעה ו-5 דק׳');
  assert.equal(formatDuration(130 * 60), 'שעתיים ו-10 דק׳');
  assert.equal(formatDuration(180 * 60), '3 שעות');
  assert.equal(formatDuration(59.6 * 60), 'שעה');
  assert.equal(formatDuration(NaN), '—');
  assert.equal(formatDuration(-1), '—');
});

test('formatDistance in Hebrew', () => {
  assert.equal(formatDistance(847), '850 מ׳');
  assert.equal(formatDistance(994), '990 מ׳');
  assert.equal(formatDistance(997), '1 ק״מ'); // not "1000 מ׳"
  assert.equal(formatDistance(1234), '1.2 ק״מ');
  assert.equal(formatDistance(37400), '37 ק״מ');
  assert.equal(formatDistance(undefined), '—');
});

test('state round-trips through the query string', () => {
  const state = {
    a: { label: 'חיפה', lat: 32.794, lng: 34.9896 },
    b: { label: 'תל אביב-יפו', lat: 32.0853, lng: 34.7818 },
    modeA: 'car',
    modeB: 'transit',
    categories: ['cafe', 'park'],
    departure: '2026-10-21T18:30',
    greenLine: true,
    shabbat: true,
    priority: 'equal',
    provider: null,
    extra: [],
  };
  const decoded = decodeState(encodeState(state));
  assert.deepEqual(decoded, state);
  assert.match(encodeState(state), /(^|&)g=1(&|$)/);
  assert.doesNotMatch(encodeState({ ...state, greenLine: false }), /(^|&)g=/);
  // The usual priority stays out of links.
  assert.match(encodeState(state), /(^|&)f=equal(&|$)/);
  assert.doesNotMatch(encodeState({ ...state, priority: 'balanced' }), /(^|&)f=/);
  assert.equal(decodeState(encodeState({ ...state, priority: 'gap' })).priority, 'gap');
  // Links made with the option's first name still open it.
  assert.equal(decodeState('f=short').priority, 'gap');
});

test('decodeState drops malformed values', () => {
  const d = decodeState('a=%D7%97&all=999,1&am=plane&b=&c=cafe,,bogus&t=tomorrow&g=yes&f=fast&p=bing', {
    knownCategories: ['cafe', 'park'],
  });
  assert.deepEqual(d, {
    a: { label: 'ח' },
    b: null,
    modeA: 'car',
    modeB: 'car',
    categories: ['cafe'],
    departure: null,
    greenLine: false,
    shabbat: false,
    priority: 'balanced',
    provider: null,
    extra: [],
  });
});

test('more starting points travel in the link after א and ב, in order', () => {
  const state = {
    a: { label: 'חיפה', lat: 32.794, lng: 34.9896 },
    b: { label: 'תל אביב-יפו', lat: 32.0853, lng: 34.7818 },
    modeA: 'car',
    modeB: 'car',
    categories: ['cafe'],
    extra: [
      { label: 'באר שבע', lat: 31.2518, lng: 34.7913, mode: 'transit' },
      { label: 'ירושלים' },
    ],
  };
  const qs = encodeState(state);
  const params = new URLSearchParams(qs);
  assert.equal(params.get('p3'), 'באר שבע');
  assert.equal(params.get('p3ll'), '31.25180,34.79130');
  assert.equal(params.get('p3m'), 'transit');
  assert.equal(params.get('p4'), 'ירושלים');
  assert.equal(params.get('p4m'), null); // driving is the default
  assert.equal(params.get('c'), 'cafe'); // the kinds of places keep their key
  assert.deepEqual(decodeState(qs).extra, [
    { label: 'באר שבע', lat: 31.2518, lng: 34.7913, mode: 'transit' },
    { label: 'ירושלים', mode: 'car' },
  ]);
  // A pair's link has no extra points, and old links decode with none.
  assert.doesNotMatch(encodeState({ ...state, extra: [] }), /p3/);
  assert.deepEqual(decodeState('a=x&b=y').extra, []);
});

test('extra starting points: gaps close up, empty and malformed parts are dropped, at most three', () => {
  const d = decodeState('a=x&b=y&p4=%D7%92&p4ll=32,&p4m=plane&p5=%20&p3=');
  assert.deepEqual(d.extra, [{ label: 'ג', mode: 'car' }]);
  const many = Array.from({ length: 5 }, (_, i) => ({ label: `נקודה ${i}` }));
  const back = decodeState(encodeState({ a: { label: 'x' }, b: { label: 'y' }, extra: many })).extra;
  assert.deepEqual(back.map((p) => p.label), ['נקודה 0', 'נקודה 1', 'נקודה 2']);
  // א, ב and the extra keys add up to the most points a search takes.
  assert.equal(2 + EXTRA_KEYS.length, MAX_POINTS);
});

test('decodeState drops coordinates with an empty part instead of reading it as 0', () => {
  assert.deepEqual(decodeState('a=x&all=,').a, { label: 'x' });
  assert.deepEqual(decodeState('a=x&all=32.1,').a, { label: 'x' });
  assert.deepEqual(decodeState('a=x&all=,34.8').a, { label: 'x' });
  assert.deepEqual(decodeState('a=x&all=32.1, 34.8').a, { label: 'x', lat: 32.1, lng: 34.8 });
  assert.deepEqual(decodeState('a=x&all=0,0').a, { label: 'x', lat: 0, lng: 0 });
});

test('encodeState omits empty parts', () => {
  assert.equal(
    encodeState({ a: null, b: { label: 'x' }, modeA: 'car', modeB: 'car', categories: [], departure: null }),
    'b=x',
  );
});

test('guessAreaName picks the most common town among the top places', async () => {
  // results.js touches `document` only inside render functions, so it imports fine in Node.
  const { guessAreaName } = await import('../../site/js/ui/results.js');
  const p = (address) => ({ address });
  assert.equal(guessAreaName([p('הרצל 5, חדרה'), p('הנשיא 2, חדרה'), p('הים 1, קיסריה')]), 'חדרה');
  assert.equal(guessAreaName([p('הרצל 5, חדרה'), p('הים 1, קיסריה')]), null);
  assert.equal(guessAreaName([p('חדרה'), p('חדרה'), p(undefined)]), null);
  assert.equal(guessAreaName([p('כביש 4, 3800000'), p('כביש 2, 3800000')]), null);
  assert.equal(guessAreaName([]), null);
});
