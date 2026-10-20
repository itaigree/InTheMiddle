import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatDistance } from '../../site/js/core/format.js';
import { encodeState, decodeState } from '../../site/js/core/state.js';

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
    provider: null,
  };
  const decoded = decodeState(encodeState(state));
  assert.deepEqual(decoded, state);
});

test('decodeState drops malformed values', () => {
  const d = decodeState('a=%D7%97&all=999,1&am=plane&b=&c=cafe,,bogus&t=tomorrow&p=bing', {
    knownCategories: ['cafe', 'park'],
  });
  assert.deepEqual(d, {
    a: { label: 'ח' },
    b: null,
    modeA: 'car',
    modeB: 'car',
    categories: ['cafe'],
    departure: null,
    provider: null,
  });
});

test('encodeState omits empty parts', () => {
  assert.equal(
    encodeState({ a: null, b: { label: 'x' }, modeA: 'car', modeB: 'car', categories: [], departure: null }),
    'b=x',
  );
});
