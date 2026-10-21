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

test('a rate-limit block is short', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  assert.equal(blockUntil('rate', now).getTime() - now.getTime(), 120 * 1000);
});

test('setGoogleBlock never shortens an existing block', async () => {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  try {
    const { setGoogleBlock, getGoogleBlock } = await import('../../site/js/core/availability.js');
    const now = new Date('2026-10-20T12:00:00Z');
    setGoogleBlock('quota', now);
    const kept = setGoogleBlock('load-failed', new Date(now.getTime() + 1000));
    assert.equal(kept.reason, 'quota');
    assert.equal(getGoogleBlock(new Date(now.getTime() + 2000)).reason, 'quota');
    // A longer block replaces a shorter one.
    store.clear();
    setGoogleBlock('rate', now);
    assert.equal(setGoogleBlock('auth', now).reason, 'auth');
  } finally {
    delete globalThis.window;
  }
});
