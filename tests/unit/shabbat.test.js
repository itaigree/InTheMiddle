import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedOnShabbat, intervalsFromGoogle, intervalsFromOsm } from '../../site/js/core/shabbat.js';

const osm = (text) => closedOnShabbat(intervalsFromOsm(text));

test('OSM opening hours: closed on Shabbat or not', () => {
  assert.equal(osm('Su-Th 07:00-23:00; Fr 07:00-14:00; Sa off'), true);
  assert.equal(osm('Su-Th 08:00-22:00; Fr 08:00-15:00'), true); // Saturday not listed = closed
  assert.equal(osm('Su-Th 08:00-22:00; Fr 08:00-15:00; Sa 20:00-24:00'), true); // opens after Shabbat
  assert.equal(osm('Mo-Su 08:00-22:00'), false);
  assert.equal(osm('Su-Th 08:00-23:00; Fr-Sa 09:00-01:00'), false);
  assert.equal(osm('Fr 18:00-02:00'), false); // Friday night
  assert.equal(osm('Su-Fr 08:00-20:00; PH off'), false); // Friday evening
  assert.equal(osm('24/7'), false);
  assert.equal(osm('Mo-Fr 08:00-17:00; Sa 09:00-13:00'), false);
  assert.equal(osm('Mo-Fr 08:00-17:00, PH off'), true);
});

test('OSM opening hours that are not understood are unknown, not guessed', () => {
  for (const text of [undefined, '', 'Fr 08:00-sunset', 'Jan-Mar Mo-Fr 08:00-17:00', '"by appointment"', 'Mo-Fr']) {
    assert.equal(osm(text), null, String(text));
  }
});

test('Google opening hours: closed on Shabbat or not', () => {
  const period = (d1, h1, d2, h2) => ({ open: { day: d1, hour: h1, minute: 0 }, close: { day: d2, hour: h2, minute: 0 } });
  const weekdays = [0, 1, 2, 3, 4].map((d) => period(d, 8, d, 22));
  assert.equal(closedOnShabbat(intervalsFromGoogle({ periods: [...weekdays, period(5, 8, 5, 14)] })), true);
  assert.equal(closedOnShabbat(intervalsFromGoogle({ periods: [...weekdays, period(6, 20, 0, 1)] })), true); // Saturday night into Sunday
  assert.equal(closedOnShabbat(intervalsFromGoogle({ periods: [...weekdays, period(6, 10, 6, 18)] })), false);
  assert.equal(closedOnShabbat(intervalsFromGoogle({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] })), false); // 24/7
  assert.equal(closedOnShabbat(intervalsFromGoogle(undefined)), null);
});
