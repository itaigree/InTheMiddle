import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wazeUrl, googleMapsUrl } from '../../site/js/ui/links.js';

const place = { name: 'קפה', lat: 32.4401, lng: 34.9213 };

test('Waze navigates to the place', () => {
  const url = new URL(wazeUrl(place));
  assert.equal(url.searchParams.get('ll'), '32.4401,34.9213');
  assert.equal(url.searchParams.get('navigate'), 'yes');
});

test('Google Maps shows the place itself, not directions to it', () => {
  // Google's own page for the place, when Google gave one.
  assert.equal(googleMapsUrl({ ...place, mapsUrl: 'https://maps.google.com/?cid=123' }), 'https://maps.google.com/?cid=123');
  // Otherwise a pin at its coordinates.
  const url = new URL(googleMapsUrl(place));
  assert.equal(url.pathname, '/maps/search/');
  assert.equal(url.searchParams.get('api'), '1');
  assert.equal(url.searchParams.get('query'), '32.4401,34.9213');
  assert.equal(url.searchParams.get('destination'), null);
});
