// Remembers (per browser) that Google is unavailable, so we don't keep paying the
// latency of failed calls once its quota is used up.

const KEY = 'inthemiddle.googleBlocked';

/**
 * Google's per-day quotas reset at midnight Pacific time. Returns the next such
 * midnight (plus a minute of slack). Off by up to an hour around DST changes,
 * which only means one extra retry or one extra hour on the fallback.
 */
export function nextPacificMidnight(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const msSinceMidnight = ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() - msSinceMidnight + 24 * 3600 * 1000 + 60 * 1000);
}

const RETRY_AFTER_MS = {
  auth: 60 * 60 * 1000,
  'load-failed': 10 * 60 * 1000,
  rate: 2 * 60 * 1000, // a per-minute limit
};

export function blockUntil(reason, now = new Date()) {
  if (reason === 'quota') return nextPacificMidnight(now);
  return new Date(now.getTime() + (RETRY_AFTER_MS[reason] ?? RETRY_AFTER_MS['load-failed']));
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** @returns {{reason: string, until: Date} | null} */
export function getGoogleBlock(now = new Date()) {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const { reason, until } = JSON.parse(raw);
    const date = new Date(until);
    if (!(date > now)) {
      storage()?.removeItem(KEY);
      return null;
    }
    return { reason, until: date };
  } catch {
    return null;
  }
}

/**
 * Remember that Google is unavailable. A block is only ever lengthened: a quick
 * network failure after the daily quota ran out must not shorten the wait.
 * Returns the block in force.
 */
export function setGoogleBlock(reason, now = new Date()) {
  const existing = getGoogleBlock(now);
  const until = blockUntil(reason, now);
  if (existing && existing.until >= until) return existing;
  try {
    storage()?.setItem(KEY, JSON.stringify({ reason, until: until.toISOString() }));
  } catch {
    // Private mode or storage disabled: the block lasts for this page view only.
  }
  return { reason, until };
}

export function clearGoogleBlock() {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // ignore
  }
}
