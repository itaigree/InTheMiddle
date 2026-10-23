// Rendering of the results: summary line, category filters and place cards.

import { categoryById } from '../core/categories.js';
import { formatDuration, formatCount, formatRating } from '../core/format.js';
import { fairnessLevel } from '../core/ranking.js';
import { wazeUrl, googleMapsUrl } from './links.js';

/** Line icons for the two ways of getting there (the same as in the form). */
const MODE_ICON = {
  car: '<path d="M4.5 16.5v-4.2L6.6 7h10.8l2.1 5.3v4.2M4.5 16.5h15M4.5 12.3h15M6.5 16.5v2M17.5 16.5v2" /><circle cx="8" cy="14.4" r=".6" /><circle cx="16" cy="14.4" r=".6" />',
  transit:
    '<rect x="5.5" y="3.5" width="13" height="14" rx="2.5" /><path d="M5.5 11h13M8.5 17.5v2.5M15.5 17.5v2.5" /><circle cx="8.6" cy="14.3" r=".6" /><circle cx="15.4" cy="14.3" r=".6" />',
};

function modeIcon(mode) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'mode-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.mode = mode;
  svg.innerHTML = MODE_ICON[mode];
  return svg;
}
/** Google bills every photo shown, so only the first few places of a search get one. */
export const MAX_PHOTOS = 3;
const MODE_TITLE = { car: 'ברכב', transit: 'בתחבורה ציבורית' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * The town the midpoint is in, guessed from the places' addresses ("רחוב 5, חדרה"):
 * the most common last part among the best places, if it appears at least twice.
 */
export function guessAreaName(places, sample = 10) {
  const counts = new Map();
  for (const p of places.slice(0, sample)) {
    const parts = (p.address || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const town = parts[parts.length - 1];
    if (/\d/.test(town) || town === 'ישראל' || town === 'Israel') continue;
    counts.set(town, (counts.get(town) || 0) + 1);
  }
  let best = null;
  for (const [town, n] of counts) if (n >= 2 && (!best || n > best[1])) best = [town, n];
  return best ? best[0] : null;
}

/** "נקודת האמצע נמצאת באזור חדרה, בערך 34 דק׳ נסיעה מכל צד." */
/** How the list is sorted, by what the user said matters more. */
const ORDER_TEXT = {
  equal: 'מסודרים קודם לפי כמה זמן הנסיעה שווה לשני הצדדים.',
  balanced: 'מסודרים לפי כמה הם מאוזנים וקרובים לשני הצדדים.',
  gap: 'מסודרים בעיקר לפי כמה הם קרובים, גם אם יש פער בין הצדדים.',
};

export function renderSummary(container, result) {
  container.replaceChildren();
  // Only claim an equal time when it was measured on both sides, not guessed.
  const time = result.balance?.reliable ? result.balance.time : null;
  const area = guessAreaName(result.places);
  if (area || Number.isFinite(time)) {
    container.append('נקודת האמצע נמצאת ');
    if (area) {
      container.append('באזור ', el('strong', null, area));
      container.append(Number.isFinite(time) ? ', ' : '. ');
    }
    if (Number.isFinite(time)) {
      container.append('בערך ', el('strong', null, formatDuration(time)), ' נסיעה מכל צד. ');
    }
  }
  container.append(result.places.length ? `מצאנו ${formatCount(result.places.length)} מקומות, ${ORDER_TEXT[result.priority] || ORDER_TEXT.balanced}` : '');
}

/**
 * Category filter chips with counts. `active` is a category id or 'all'.
 * Calls onChange(id) when a chip is pressed.
 */
export function renderFilters(container, places, active, onChange) {
  const counts = new Map();
  for (const p of places) counts.set(p.category, (counts.get(p.category) || 0) + 1);
  // Rebuilding the chips would drop keyboard focus to <body>; put it back.
  const focused = container.contains(document.activeElement) ? document.activeElement.dataset.filter : null;
  container.replaceChildren();
  if (counts.size < 2) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const make = (id, label, count) => {
    const b = el('button', 'filter-chip');
    b.type = 'button';
    b.dataset.filter = id;
    b.setAttribute('aria-pressed', String(active === id));
    b.append(label, ' ', el('span', 'count', `(${formatCount(count)})`));
    b.addEventListener('click', () => onChange(id));
    return b;
  };
  container.append(make('all', 'הכל', places.length));
  for (const [id, count] of counts) {
    const cat = categoryById(id);
    container.append(make(id, cat ? cat.label : id, count));
  }
  if (focused) [...container.children].find((b) => b.dataset.filter === focused)?.focus();
}

function fairnessText(place) {
  const level = fairnessLevel(place.timeA, place.timeB);
  if (level === 'great') return { level, text: 'מאוזן מאוד' };
  if (level === 'good') return { level, text: 'מאוזן' };
  const longer = place.timeA > place.timeB ? 'א׳' : 'ב׳';
  return { level, text: `+${formatDuration(place.diff)} לצד ${longer}` };
}

function openText(place) {
  if (place.openNow === true) return el('span', 'open', 'פתוח עכשיו');
  if (place.openNow === false) return el('span', 'closed', 'סגור עכשיו');
  return null;
}

/**
 * Render place cards. `places` are ranked results (with timeA/timeB);
 * `numbering` maps place id → the number shown on its map marker; `photoIds`
 * are the places allowed to show a photo (default: the first MAX_PHOTOS).
 */
export function renderPlaces(list, template, places, { modeA, modeB, numbering, photoIds, showOpenState, onSelect, onShare }) {
  list.replaceChildren();
  if (!places.length) {
    list.append(el('li', 'empty-results', 'לא מצאנו מקומות מתאימים, גם אחרי שהרחבנו את החיפוש סביב האמצע. אפשר לבחור עוד סוגי מקומות, או לכבות סינון אם הוא פעיל.'));
    return;
  }
  places.forEach((place, index) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.placeId = place.id;
    const cat = categoryById(place.category);

    const number = numbering.get(place.id) ?? '';
    node.querySelector('.place-rank').textContent = number;
    node.querySelector('.place-number').textContent = number ? `מקום ${number} במפה: ` : '';
    const photo = node.querySelector('.place-photo');
    const withPhoto = place.photoUrl && (photoIds ? photoIds.has(place.id) : index < MAX_PHOTOS);
    if (withPhoto) {
      const img = el('img');
      img.src = place.photoUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => img.remove()); // no picture: the box hides
      photo.append(img);
    }
    node.querySelector('.place-name').textContent = place.name;

    const meta = node.querySelector('.place-meta');
    meta.append(el('span', null, place.typeLabel || cat?.singular || ''));
    if (Number.isFinite(place.rating) && place.rating > 0) {
      const rating = el('span', 'rating', formatRating(place.rating));
      if (place.ratingCount) rating.append(` (${formatCount(place.ratingCount)})`);
      meta.append(rating);
    }
    if (showOpenState) {
      const open = openText(place);
      if (open) meta.append(open);
    }
    if (place.closedOnShabbat === true && (place.category === 'cafe' || place.category === 'food')) {
      meta.append(el('span', 'shabbat', 'סגור בשבת'));
    }
    if (place.address) meta.append(el('span', null, place.address));

    // The א/ב badges and mode icons are visual; screen readers get the words.
    const fillTime = (selector, sideName, mode, seconds) => {
      const box = node.querySelector(selector);
      box.querySelector('.time-who').textContent = `מנקודה ${sideName} ${MODE_TITLE[mode]}: `;
      box.querySelector('.time-value').replaceChildren(modeIcon(mode), formatDuration(seconds));
    };
    fillTime('.time-a', 'א׳', modeA, place.timeA);
    fillTime('.time-b', 'ב׳', modeB, place.timeB);
    const fairness = fairnessText(place);
    const fairEl = node.querySelector('.fairness');
    fairEl.dataset.level = fairness.level;
    fairEl.textContent = fairness.text;

    const sameMode = modeA === modeB ? modeA : undefined;
    const waze = node.querySelector('.waze');
    waze.href = wazeUrl(place);
    waze.setAttribute('aria-label', `ניווט ב-Waze אל ${place.name}`);
    const gmaps = node.querySelector('.gmaps');
    gmaps.href = googleMapsUrl(place, { mode: sameMode });
    gmaps.setAttribute('aria-label', `פתיחה ב-Google Maps: ${place.name}`);
    const share = node.querySelector('.share-place');
    share.setAttribute('aria-label', `שיתוף ${place.name}`);
    share.addEventListener('click', () => onShare(place));

    if (withPhoto && place.photoCredit?.name) {
      const credit = el('p', 'photo-credit', 'צילום: ');
      if (place.photoCredit.uri) {
        const link = el('a', null, place.photoCredit.name);
        link.href = place.photoCredit.uri;
        link.target = '_blank';
        link.rel = 'noopener';
        credit.append(link);
      } else {
        credit.append(place.photoCredit.name);
      }
      node.querySelector('.place-actions').before(credit);
    }

    node.querySelector('.place-main').addEventListener('click', () => onSelect(place, { from: 'list' }));
    list.append(node);
  });
}

/** Mark one card as active and (optionally) scroll it into view. */
export function setActiveCard(list, placeId, { scroll = false } = {}) {
  for (const card of list.querySelectorAll('.place-card')) {
    const active = card.dataset.placeId === placeId;
    card.classList.toggle('is-active', active);
    if (active && scroll) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
