import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePlace, scoreTimes, travelScore, rankPlaces, rankGroupPlaces, rerankPlaces, pickTop, fairnessLevel, dedupePlaces } from '../../site/js/core/ranking.js';

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

test('priority: equal favors the even split, gap allows a gap for less travel, balanced is as before', () => {
  const even = place('even'); // 40 and 40 minutes
  const quick = place('quick'); // 25 and 45 minutes: 10 minutes less on average
  const score = (p, a, b, priority) => scorePlace(p, a * 60, b * 60, { priority });
  // Balanced: the longer trip plus 1.2× the difference.
  assert.ok(Math.abs(score(quick, 25, 45, 'balanced') - (45 + 1.2 * 20)) < 1e-9);
  assert.ok(score(even, 40, 40, 'equal') < score(quick, 25, 45, 'equal'));
  assert.ok(score(even, 40, 40, 'balanced') < score(quick, 25, 45, 'balanced'));
  assert.ok(score(quick, 25, 45, 'gap') < score(even, 40, 40, 'gap'));
  // Unknown priority: balanced.
  assert.equal(score(quick, 25, 45, 'whatever'), score(quick, 25, 45, 'balanced'));
});

test('rerankPlaces re-sorts known times for another priority', () => {
  const ranked = rankPlaces([place('even'), place('quick')], [2400, 1500], [2400, 2700], { priority: 'equal' });
  assert.deepEqual(ranked.map((p) => p.id), ['even', 'quick']);
  const again = rerankPlaces(ranked, { priority: 'gap' });
  assert.deepEqual(again.map((p) => p.id), ['quick', 'even']);
  assert.equal(again[0].timeA, 1500);
});

test('two sides score the same through scorePlace and scoreTimes', () => {
  const p = place('x', { rating: 4.6, ratingCount: 300, openNow: false });
  for (const priority of ['equal', 'balanced', 'gap']) {
    const opts = { priority, preferOpen: true };
    assert.equal(scoreTimes(p, [1500, 2700], opts), scorePlace(p, 1500, 2700, opts));
    assert.equal(scoreTimes(p, [2700, 1500], opts), scorePlace(p, 1500, 2700, opts));
  }
  // The travel part alone: the average plus 1.7× the difference, in minutes.
  assert.ok(Math.abs(travelScore([1500, 2700]) - (35 + 1.7 * 20)) < 1e-9);
});

test('a group is held to its two longest trips: those two about equal, everyone else less', () => {
  const min = (...m) => m.map((x) => x * 60);
  // Jerusalem 82, Yeruham 46, Neta 46 minutes, against 60, 60 and 20: the second is
  // fairer to the two who travel most, whatever matters more.
  for (const priority of ['equal', 'balanced', 'gap']) {
    assert.ok(travelScore(min(60, 60, 20), priority) < travelScore(min(82, 46, 46), priority), priority);
  }
  // Living near the middle doesn't count against a place.
  assert.ok(travelScore(min(55, 55, 10)) < travelScore(min(60, 60, 60)));
  // The two longest, as for a pair (plus a little for the rest): 50 and 40, then 10.
  assert.ok(Math.abs(travelScore(min(10, 50, 40), 'balanced') - (45 + 1.7 * 10 + 0.1 * 10)) < 1e-9);
  // Between places equally fair to those two, the one nearer the rest comes first.
  assert.ok(travelScore(min(50, 50, 10)) < travelScore(min(50, 50, 40)));
});

test('rankGroupPlaces drops places anyone cannot reach and sorts best-first', () => {
  const places = [place('uneven'), place('unreach'), place('even')];
  const rows = [
    [600, 900, 1500],
    [600, null, 1500],
    [3000, 900, 1500],
  ];
  const ranked = rankGroupPlaces(places, rows);
  assert.deepEqual(ranked.map((p) => p.id), ['even', 'uneven']);
  assert.deepEqual(ranked[1].times, [600, 600, 3000]);
  assert.equal(ranked[1].diff, 2400);
  assert.equal(ranked[0].timeA, undefined);
});

test('rerankPlaces re-sorts a group by its times', () => {
  const rows = [
    [2400, 1200],
    [2400, 1200],
    [2400, 3000],
  ];
  const ranked = rankGroupPlaces([place('even'), place('quick')], rows, { priority: 'equal' });
  assert.deepEqual(ranked.map((p) => p.id), ['even', 'quick']);
  const again = rerankPlaces(ranked, { priority: 'gap' });
  assert.deepEqual(again.map((p) => p.id), ['quick', 'even']);
  assert.deepEqual(again[0].times, [1200, 1200, 3000]);
});

test('fairnessLevel takes a group as a list, judged by its two longest trips', () => {
  assert.equal(fairnessLevel([1800, 1850, 1900]), 'great');
  // Someone close by doesn't make it less fair.
  assert.equal(fairnessLevel([600, 3000, 3000]), 'great');
  assert.equal(fairnessLevel([600, 2400, 2400 + 6 * 60]), 'good');
  assert.equal(fairnessLevel([600, 1200, 1800]), 'fair');
  assert.equal(fairnessLevel([1800, 1900]), fairnessLevel(1800, 1900));
});
