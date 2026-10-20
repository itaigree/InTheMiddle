import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPacificMidnight, blockUntil } from '../../site/js/core/availability.js';

test('next Pacific midnight during PDT (UTC-7)', () => {
  // 2026-10-20 12:00 UTC = 05:00 PDT → next midnight PDT is 2026-10-21 07:00 UTC.
  const next = nextPacificMidnight(new Date('2026-10-20T12:00:00Z'));
  assert.equal(next.toISOString(), '2026-10-21T07:01:00.000Z');
});

test('next Pacific midnight during PST (UTC-8)', () => {
  // 2026-12-01 23:30 PST = 2026-12-02 07:30 UTC → next midnight is 2026-12-02 08:00 UTC.
  const next = nextPacificMidnight(new Date('2026-12-02T07:30:00Z'));
  assert.equal(next.toISOString(), '2026-12-02T08:01:00.000Z');
});

test('block durations by reason', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  assert.equal(blockUntil('quota', now).toISOString(), '2026-10-21T07:01:00.000Z');
  assert.equal(blockUntil('auth', now).getTime() - now.getTime(), 3600 * 1000);
  assert.equal(blockUntil('load-failed', now).getTime() - now.getTime(), 600 * 1000);
  assert.equal(blockUntil('something-else', now).getTime() - now.getTime(), 600 * 1000);
});
