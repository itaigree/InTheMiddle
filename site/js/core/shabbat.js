// "Closed on Shabbat", from a place's weekly opening hours: a hint that it may be
// kosher (closed on Shabbat doesn't mean kosher, but it often goes with it).
//
// Hours are weekly intervals in minutes from Sunday 00:00, [start, end).

const DAY = 1440;
const WEEK = 7 * DAY;

/**
 * Friday 19:00 to Saturday 17:00: inside Shabbat all year (it starts by 19:20 on
 * Friday in summer and ends after 17:15 on Saturday in winter), so a place that
 * keeps Shabbat is closed throughout, and one that doesn't is usually open some of it.
 */
const SHABBAT = [5 * DAY + 19 * 60, 6 * DAY + 17 * 60];

/** true: closed throughout; false: open some of it; null: hours unknown. */
export function closedOnShabbat(intervals) {
  if (!intervals) return null;
  const [s, e] = SHABBAT;
  return !intervals.some(([start, end]) => {
    // Intervals may run past the end of the week (Saturday night into Sunday).
    return (start < e && end > s) || (start - WEEK < e && end - WEEK > s);
  });
}

/** Google Places opening hours ({periods: [{open: {day, hour, minute}, close}]}) → intervals. */
export function intervalsFromGoogle(openingHours) {
  const periods = openingHours?.periods;
  if (!periods?.length) return null;
  const out = [];
  for (const { open, close } of periods) {
    if (!open) continue;
    if (!close) return [[0, WEEK]]; // open 24/7
    const start = open.day * DAY + open.hour * 60 + (open.minute || 0);
    let end = close.day * DAY + close.hour * 60 + (close.minute || 0);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null; // a time it doesn't give: unknown
    if (end <= start) end += WEEK;
    out.push([start, end]);
  }
  return out.length ? out : null;
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function parseDays(text) {
  const days = new Set();
  for (const part of text.split(',')) {
    const m = part.match(/^(Su|Mo|Tu|We|Th|Fr|Sa)(?:-(Su|Mo|Tu|We|Th|Fr|Sa))?$/);
    if (!m) return null;
    const from = DAYS.indexOf(m[1]);
    const to = m[2] ? DAYS.indexOf(m[2]) : from;
    for (let d = from; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === to) break;
    }
  }
  return days;
}

function parseTimes(text) {
  const ranges = [];
  for (const part of text.split(',')) {
    const m = part.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})(\+?)$/);
    if (!m) return null;
    const start = Number(m[1]) * 60 + Number(m[2]);
    let end = Number(m[3]) * 60 + Number(m[4]);
    if (start >= 24 * 60 || end > 48 * 60) return null;
    if (end <= start) end += DAY; // past midnight
    // "+": open end, it may close later than that.
    ranges.push([start, end, m[5] === '+']);
  }
  return ranges;
}

/**
 * OpenStreetMap opening_hours → intervals, for the common forms only
 * ("Su-Th 08:00-22:00; Fr 08:00-14:00; Sa off", "24/7"). Anything else (months,
 * holidays only, comments…) is unknown (null) rather than guessed.
 */
export function intervalsFromOsm(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const value = text.trim();
  if (value === '24/7') return [[0, WEEK]];
  if (value.includes('||')) return null; // fallback rules
  const perDay = new Map(); // day → [[start, end, openEnd] in minutes from that day's 00:00]
  // Rules are separated by ";" or by ", " before a new day selector ("Mo-Fr 08:00-17:00, PH off").
  // A ", " rule is an additional one: it adds to earlier rules for its days instead of replacing them.
  const rules = value
    .split(';')
    .flatMap((r) => r.split(/,\s+(?=(?:Su|Mo|Tu|We|Th|Fr|Sa|PH)\b)/).map((rule, i) => ({ rule, additional: i > 0 })));
  for (let { rule, additional } of rules) {
    rule = rule.trim().replace(/,PH\b|\bPH,/g, '');
    if (!rule) continue;
    if (/^PH\b/.test(rule)) {
      // Public holidays only: not a weekly rule (anything more in it isn't understood).
      if (/^PH\s+(?:off|closed|[\d:,+\s-]+)$/i.test(rule)) continue;
      return null;
    }
    const m = rule.match(/^(?:([A-Za-z,-]+)\s+)?(.+)$/);
    const days = m[1] ? parseDays(m[1]) : new Set([0, 1, 2, 3, 4, 5, 6]);
    let times = m[2];
    if (!m[1] && /^[A-Z][a-z](?:[-,][A-Z][a-z])*$/.test(m[2])) {
      // "Mo-Fr" alone isn't a full rule.
      return null;
    }
    if (!days) return null;
    if (/^(off|closed)$/i.test(times)) {
      for (const d of days) if (!additional || !perDay.has(d)) perDay.set(d, []);
      continue;
    }
    if (times === '24:00' || times === '00:00-24:00') times = '00:00-24:00';
    const ranges = parseTimes(times.replace(/\s+/g, ''));
    if (!ranges) return null;
    // A later rule replaces earlier ones for its days; an additional one adds to them.
    for (const d of days) perDay.set(d, additional && perDay.has(d) ? [...perDay.get(d), ...ranges] : ranges);
  }
  if (!perDay.size) return null;
  // Never open ("off", "Sa off" alone): nothing says it keeps Shabbat.
  if (![...perDay.values()].some((ranges) => ranges.length)) return null;
  const out = [];
  for (const [d, ranges] of perDay) {
    for (const [s, e, openEnd] of ranges) {
      // An open end ("14:00+") within half a day before or during Shabbat may run into it: unknown.
      if (openEnd && d * DAY + e > SHABBAT[0] - 12 * 60 && d * DAY + e < SHABBAT[1]) return null;
      out.push([d * DAY + s, d * DAY + e]);
    }
  }
  return out;
}
