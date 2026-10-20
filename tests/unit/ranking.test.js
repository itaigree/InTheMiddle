import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePlace, rankPlaces, pickTop, fairnessLevel, dedupePlaces } from '../../site/js/core/ranking.js';

const place = (id, extra = {}) => ({ id, name: id, lat: 32, lng: 34.9, category: 'cafe', ...extra });

test('balanced beats unbalanced at the same longest trip', () => {
  const balanced = scorePlace(place('x'), 1800, 1800);
  const unbalanced = scorePlace(place('y'), 1800, 600);
  assert.ok(balanced < unbalanced);
});

test('good rating with many reviews improves the score; few reviews barely count', () => {
  const base = scorePlace(place('a'), 1800, 1800);
  const great = scorePlace(place('b', { rating: 4.8, ratingCount: 2000 }), 1800, 1800);
  const thin = scorePlace(place('c', { rating: 5, ratingCount: 1 }), 1800, 1800);
  const poor = scorePlace(place('d', { rating: 3.2, ratingCount: 500 }), 1800, 1800);
  assert.ok(great < base);
  assert.ok(base - thin < base - great);
  assert.ok(poor > base);
});

test('closed places are penalised only when preferOpen is set', () => {
  const p = place('a', { openNow: false });
  assert.equal(scorePlace(p, 600, 600), scorePlace(place('b'), 600, 600));
  assert.ok(scorePlace(p, 600, 600, { preferOpen: true }) > scorePlace(place('b'), 600, 600, { preferOpen: true }));
});

test('rankPlaces drops unreachable places and sorts best-first', () => {
  const places = [place('far'), place('unreach'), place('good'), place('neg')];
  const ranked = rankPlaces(places, [3600, null, 1200, -5], [3600, 900, 1300, 900]);
  assert.deepEqual(
    ranked.map((p) => p.id),
    ['good', 'far'],
  );
  assert.equal(ranked[0].timeA, 1200);
  assert.equal(ranked[0].timeB, 1300);
  assert.equal(ranked[0].diff, 100);
});

test('pickTop caps categories but fills leftover slots', () => {
  const ranked = [
    { id: 1, category: 'cafe', score: 1 },
    { id: 2, category: 'cafe', score: 2 },
    { id: 3, category: 'cafe', score: 3 },
    { id: 4, category: 'park', score: 4 },
  ];
  assert.deepEqual(
    pickTop(ranked, { limit: 3, perCategory: 1 }).map((p) => p.id),
    [1, 2, 4],
  );
  assert.deepEqual(
    pickTop(ranked, { limit: 2, perCategory: 1 }).map((p) => p.id),
    [1, 4],
  );
  assert.deepEqual(
    pickTop(ranked, { limit: 10 }).map((p) => p.id),
    [1, 2, 3, 4],
  );
});

test('fairnessLevel thresholds', () => {
  assert.equal(fairnessLevel(1800, 1900), 'great');
  assert.equal(fairnessLevel(3600, 3600 + 6 * 60), 'good');
  assert.equal(fairnessLevel(600, 1800), 'fair');
});

test('dedupePlaces removes same id and same name nearby', () => {
  const list = [
    place('1', { name: 'Aroma', lat: 32.1, lng: 34.8 }),
    place('1', { name: 'Aroma', lat: 32.1, lng: 34.8 }),
    place('2', { name: 'Aroma', lat: 32.1001, lng: 34.8001 }),
    place('3', { name: 'Aroma', lat: 32.2, lng: 34.8 }),
  ];
  assert.deepEqual(
    dedupePlaces(list).map((p) => p.id),
    ['1', '3'],
  );
});
