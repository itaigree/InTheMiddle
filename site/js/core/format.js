// Hebrew formatting for durations, distances and counts.

const numberFmt = new Intl.NumberFormat('he-IL');
const decimalFmt = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 1 });

/** "35 דק׳", "שעה", "שעה ו-5 דק׳", "שעתיים ו-10 דק׳", "3 שעות ו-20 דק׳". */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const totalMin = Math.max(1, Math.round(seconds / 60));
  if (totalMin < 60) return `${totalMin} דק׳`;
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  const hoursText = hours === 1 ? 'שעה' : hours === 2 ? 'שעתיים' : `${hours} שעות`;
  return minutes === 0 ? hoursText : `${hoursText} ו-${minutes} דק׳`;
}

/** "850 מ׳", "1.2 ק״מ", "37 ק״מ". */
export function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return '—';
  if (meters < 1000) return `${Math.round(meters / 10) * 10} מ׳`;
  if (meters < 10000) return `${decimalFmt.format(meters / 1000)} ק״מ`;
  return `${numberFmt.format(Math.round(meters / 1000))} ק״מ`;
}

export function formatCount(n) {
  return Number.isFinite(n) ? numberFmt.format(n) : '';
}

export function formatRating(rating) {
  return Number.isFinite(rating) ? rating.toFixed(1) : '';
}
