// App controller: form, provider selection (Google → OpenStreetMap fallback), search and results.

import { CATEGORIES, CATEGORY_IDS, DEFAULT_CATEGORY_IDS } from './core/categories.js';
import { encodeState, decodeState, toIsraelTime, israelTimeToDate, ISRAEL_TIME_ZONE } from './core/state.js';
import { loadGreenLine, beyondGreenLine } from './core/green-line.js';
import { findMiddle } from './core/search.js';
import { findGroupMiddle, MAX_POINTS } from './core/group.js';
import { pickTop, rerankPlaces } from './core/ranking.js';
import { formatDistance, formatDuration } from './core/format.js';
import { getGoogleBlock, setGoogleBlock } from './core/availability.js';
import { makeSnapshot, parseSnapshot, snapshotToSearch, newSnapshotKey, MAX_SNAPSHOT_BYTES } from './core/snapshot.js';
import { ProviderUnavailableError } from './providers/errors.js';
import { attachAutocomplete } from './ui/autocomplete.js';
import { renderSummary, renderFilters, renderPlaces, setActiveCard, dropPhotoOnError, MAX_PHOTOS } from './ui/results.js';
import { shareOrCopy, googleMapsUrl } from './ui/links.js';
import { categoryRoundel } from './ui/category-icons.js';

const config = window.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);
/**
 * The share service (worker/share.js) that keeps free results for a shared link
 * to show as they are. Without it, every shared link searches again.
 */
const SHARE_API = (config.shareApiUrl || '').replace(/\/+$/, '');

const RESULTS_LIMIT = 20;
const MY_LOCATION_LABEL = 'המיקום שלי';
/** What a shared link calls the sender's "my location" (it isn't the recipient's location). */
const SHARED_LOCATION_LABEL = 'נקודת יציאה ששותפה';
const GEOLOCATION_WATCHDOG_MS = 30000;

const PROGRESS_TEXT = {
  geocode: 'מאתרים את נקודות היציאה…',
  route: 'מחשבים את הדרך בין שתי הנקודות…',
  balance: 'מחפשים את הנקודה שבה זמן הנסיעה שווה לשני הצדדים…',
  places: 'מחפשים מקומות שווים באזור…',
  wider: 'באמצע עצמו יש מעט מקומות, אז מחפשים קצת יותר רחוק…',
  times: 'בודקים כמה זמן לוקח להגיע לכל מקום…',
};
/** …where a search for three or more starting points says something else. */
const GROUP_PROGRESS_TEXT = {
  balance: 'מחפשים את האזור שבו זמני הנסיעה הכי הוגנים לכולם…',
};

const NOTICE_TEXT = {
  'transit-unsupported':
    'במפות החינמיות אין חישוב של תחבורה ציבורית, ולכן חישבנו את זמני ההגעה לפי נסיעה ברכב.',
  'transit-no-service':
    'לא מצאנו תחבורה ציבורית בזמן היציאה שנבחר (אולי שבת, חג או שעת לילה), ולכן חישבנו את הצד הזה לפי נסיעה ברכב.',
  'transit-error': 'לא הצלחנו לחשב כרגע זמני תחבורה ציבורית, ולכן חישבנו את הצד הזה לפי נסיעה ברכב.',
  'departure-past': 'זמן היציאה שנבחר כבר עבר, אז חיפשנו לפי יציאה עכשיו.',
  bypass: 'הדרך המהירה עוברת ביהודה ושומרון, אז חישבנו את האמצע לפי הדרך המהירה ביותר שעוקפת אותם.',
  'bypass-failed':
    'לא מצאנו דרך שעוקפת את יהודה ושומרון, אז חישבנו את האמצע לפי הדרך המהירה, שעוברת שם. מקומות שמעבר לקו הירוק לא מוצגים.',
  widened: (result) =>
    `באזור האמצע עצמו היו מעט מקומות, אז הרחבנו את החיפוש עד ${formatDistance(result.radius)} מנקודת האמצע.`,
  'green-line': 'נקודת האמצע קרובה לקו הירוק, ואחרי סינון המקומות שמעבר לו נשארו מעט מקומות.',
  shabbat:
    'נשארו מעט בתי קפה ומסעדות שסגורים בשבת: מוצגים רק מקומות ששעות הפתיחה שלהם ידועות, ולהרבה מקומות אין שעות פתיחה במפות.',
  'green-line-places-only':
    'בחיפוש של יותר משתי נקודות יציאה, הסינון משמיט מקומות שמעבר לקו הירוק, אבל לא בודק את הדרכים אליהם: הן עשויות לעבור ביהודה ושומרון.',
  'shabbat-busy':
    'שרת המקומות החינמי עמוס, ובינתיים אין לנו שעות פתיחה, אז אי אפשר לדעת אילו בתי קפה ומסעדות סגורים בשבת. כדאי לנסות שוב בעוד כמה דקות.',
  'shared-place-missing':
    'המקום ששותף בקישור לא נמצא הפעם (התוצאות משתנות לפי השעה ולפי המפות שזמינות עכשיו), אז הנה כל המקומות שמצאנו.',
  snapshot: (result) =>
    `אלה התוצאות ששותפו איתך, כמו שנמצאו ב-${sharedAtText(result.sharedAt)}. כדי לחפש שוב עכשיו, לוחצים על „מצאו לנו מקום באמצע”.`,
  'snapshot-missing': 'התוצאות ששותפו כבר לא שמורות, או שלא הצלחנו לפתוח אותן, אז חיפשנו מחדש.',
};

/** A short link whose stored results are gone (kept 30 days), or out of reach. */
const SNAPSHOT_GONE_TEXT = 'הקישור הזה כבר לא פעיל: תוצאות ששותפו נשמרות 30 יום. אפשר לבקש קישור חדש, או לחפש כאן.';
const SNAPSHOT_UNREACHABLE_TEXT = 'לא הצלחנו לפתוח את התוצאות ששותפו. כדאי לבדוק את החיבור לאינטרנט ולנסות שוב.';
/**
 * How long a share waits for its results to be stored before the share sheet
 * opens: the link is short only if they are. Browsers let a share sheet open up
 * to about 5 seconds after the tap.
 */
const SHARE_WAIT_MS = 2500;

/** "23.11 בשעה 14:30", Israel time. */
function sharedAtText(date) {
  const [, month, day, time] = toIsraelTime(date).match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})$/);
  return `${Number(day)}.${Number(month)} בשעה ${time}`;
}

/** What each choice of "what matters more" means, under the choices. */
const PRIORITY_HINT = {
  equal: 'זמן נסיעה כמעט שווה לשני הצדדים, גם אם שניהם נוסעים יותר.',
  balanced: 'זמן דומה לשני הצדדים, בלי להאריך את הדרך.',
  gap: 'מותר פער גדול יותר בזמני הנסיעה בין שני הצדדים, בשביל מקום קרוב יותר.',
};
/** …with three or more starting points. */
const GROUP_PRIORITY_HINT = {
  equal: 'זמן נסיעה כמעט שווה לכולם, גם אם כולם נוסעים יותר.',
  balanced: 'זמן דומה לכולם, בלי להאריך את הדרך.',
  gap: 'מותר פער גדול יותר בין זמני הנסיעה, בשביל מקום קרוב יותר.',
};
const priorityHint = (priority) => (extraKeys.length ? GROUP_PRIORITY_HINT : PRIORITY_HINT)[priority];

/** The kinds of places "closed on Shabbat" applies to (a park or a beach isn't a kashrut question). */
const SHABBAT_CATEGORIES = new Set(['cafe', 'food']);

const SWITCH_REASON_TEXT = {
  quota:
    'המכסה החינמית היומית של Google נגמרה, אז עברנו למפות החינמיות של OpenStreetMap עד שהמכסה תתחדש (בסביבות 10:00 בבוקר).',
  rate: 'Google עמוסה כרגע, אז עברנו לכמה דקות למפות החינמיות של OpenStreetMap.',
  auth: 'יש בעיה בהגדרות המפתח של Google, אז עברנו בינתיים למפות החינמיות של OpenStreetMap.',
  'load-failed': 'לא הצלחנו להתחבר ל-Google Maps, אז עברנו בינתיים למפות החינמיות של OpenStreetMap.',
};

const forcedProvider = decodeState(location.search).provider;

// ---------------------------------------------------------------- providers

let providerPromise = null;
/** The provider kind the current promise is for ('google' | 'osm'), set when the load starts. */
let providerKind = null;
/** Google maps that broke in this page (error screen, rejected key), to tell whether one did during a search. */
let googleFailures = 0;
/** Why (and until when) this page stopped using Google: {reason, until: ms}. */
let switchBlock = null;
let currentMap = null;
let mapPromise = null;
let mapKind = null;
/** A Google map that showed Google's error screen: it stays broken, so it's never reused. */
let brokenMap = null;
/** The search whose results are on screen, as asked (texts, modes…), to re-run after a provider switch. */
let shownRequest = null;
/** …and the provider they came from. */
let shownProvider = null;
/** The Google results on screen sit on a broken map, and no re-run of them has finished yet. */
let shownNeedsRedo = false;
/** The search whose results are on screen, with resolved coordinates, for sharing. */
let lastQuery = null;
/** An OpenStreetMap provider, to show stored results on its map (made when first needed). */
let snapshotProvider = null;
/** Attribution line under autocomplete suggestions, for the provider that served them. */
let suggestFooter = '';

function googleBlocked() {
  if (switchBlock && switchBlock.until <= Date.now()) switchBlock = null;
  // A block recorded by another tab (or before a reload) counts too, with its reason.
  const stored = getGoogleBlock();
  if (stored && !switchBlock) switchBlock = { reason: stored.reason, until: stored.until.getTime() };
  return Boolean(switchBlock);
}

function googleWanted() {
  return Boolean(config.googleMapsApiKey) && forcedProvider !== 'osm' && !googleBlocked();
}

function getProvider() {
  // The provider must follow the current verdict: back on Google once a block has
  // expired, and off Google as soon as one is in force (even if another tab
  // recorded it). Judged by the kind being loaded, so a load in progress counts.
  const want = googleWanted() ? 'google' : 'osm';
  if (providerPromise && providerKind !== want) providerPromise = null;
  if (!providerPromise) {
    providerKind = want;
    const promise = loadProvider().then(
      (provider) => {
        if (providerPromise === promise) providerKind = provider.id;
        return provider;
      },
      (err) => {
        if (providerPromise === promise) providerPromise = null;
        throw err;
      },
    );
    providerPromise = promise;
  }
  return providerPromise;
}

async function loadProvider() {
  if (googleWanted()) {
    try {
      const { createGoogleProvider } = await import('./providers/google.js');
      const provider = createGoogleProvider({
        apiKey: config.googleMapsApiKey,
        mapId: config.googleMapId,
        onUnavailable: handleGoogleUnavailable,
      });
      await provider.ready();
      // Blocked while the SDK was loading (e.g. by another tab): don't use it.
      if (googleWanted()) return provider;
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError)) console.error(err);
      markGoogleUnavailable(err);
    }
  }
  const { createOsmProvider } = await import('./providers/osm.js');
  const provider = createOsmProvider();
  await provider.ready?.();
  return provider;
}

function markGoogleUnavailable(err) {
  const reason = err instanceof ProviderUnavailableError ? err.reason : 'load-failed';
  console.warn(`Google unavailable (${reason}); switching to OpenStreetMap`, err);
  const block = reason === 'not-configured' ? { reason, until: Infinity } : setGoogleBlock(reason);
  const until = typeof block.until === 'number' ? block.until : block.until.getTime();
  // Keep whichever block lasts longer.
  if (!switchBlock || until > switchBlock.until) switchBlock = { reason: block.reason, until };
}

/** Run `fn` with the current provider; if Google drops out, retry once on the fallback. */
async function withProvider(fn) {
  const provider = await getProvider();
  suggestFooter = provider.suggestFooter || '';
  try {
    return await fn(provider);
  } catch (err) {
    if (provider.id !== 'google' || !(err instanceof ProviderUnavailableError)) throw err;
    markGoogleUnavailable(err);
    providerPromise = null;
    const fallback = await getProvider();
    suggestFooter = fallback.suggestFooter || '';
    noteProvider(fallback);
    return fn(fallback);
  }
}

/** Google reported a failure outside a call we made (e.g. key rejected while drawing the map). */
function handleGoogleUnavailable(err) {
  googleFailures++;
  if (mapKind === 'google') brokenMap = mapPromise;
  if (providerKind !== 'google') {
    // Already off Google (e.g. another tab blocked it). Still note it: a search on
    // Google that is finishing redoes itself, and this tab won't go back too soon.
    markGoogleUnavailable(err);
    redoShownSearch();
    return;
  }
  markGoogleUnavailable(err);
  providerPromise = null;
  getProvider()
    .then((p) => {
      noteProvider(p);
      redoShownSearch();
    })
    .catch((loadErr) => {
      console.error(loadErr);
      showStatus('error', 'לא הצלחנו לטעון את המפות. כדאי לבדוק את החיבור לאינטרנט ולנסות שוב.');
    });
}

/**
 * Google results on screen sit on a Google map that no longer works: show them
 * again with the current provider. (A search in progress falls back by itself.)
 * The user may be typing a new search meanwhile: don't hold it up, scroll away
 * from their field, mark fields, or replace an error they're reading.
 */
function redoShownSearch() {
  if (!shownRequest || lastResult?.providerId !== 'google') return;
  shownNeedsRedo = true;
  // A search in progress either shows new results or, if it fails, does this when it ends.
  if (!searching) runSearch({ request: shownRequest, background: true });
}

/**
 * A failed search may have swapped the map under the results on screen (Google's
 * map loads early): put them back on their own map.
 */
function restoreShownMap() {
  if (lastResult && !resultMap() && shownProvider && shownProvider.id !== 'google') drawOnMap(lastResult, shownProvider);
}

/** Results on screen keep the note and attribution of their provider (showResult sets them). */
function noteProvider(provider) {
  if (!lastResult) updateProviderNote(provider);
}

function updateProviderNote(provider) {
  $('provider-note').textContent =
    provider.id === 'google'
      ? 'מפות, מקומות וזמני נסיעה: Google Maps'
      : 'מפות, מקומות וזמני נסיעה: OpenStreetMap ושירותים פתוחים (מצב חינמי)';
  $('attribution').innerHTML = provider.attributionHtml || '';
}

// --------------------------------------------------------------------- form

/** The letters the starting points go by, in order: א and ב (the app), then the extra ones. */
const SIDE_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה'];

const newSide = (key) => ({ input: $(`input-${key}`), list: $(`list-${key}`), location: null, ac: null, pending: null, selection: null, geo: null });
const sides = { a: newSide('a'), b: newSide('b') };
/** The extra starting points' keys, in the order they're shown (each gets a new key: x1, x2…). */
let extraKeys = [];
let extraCount = 0;
/** Every starting point's key, in order. */
const sideKeys = () => ['a', 'b', ...extraKeys];
const locateButton = (key) => document.querySelector(`.locate[data-side="${key}"]`);

function getMode(key) {
  return document.querySelector(`input[name="mode-${key}"]:checked`)?.value || 'car';
}

function setMode(key, mode) {
  const radio = document.querySelector(`input[name="mode-${key}"][value="${mode}"]`);
  if (radio) radio.checked = true;
}

function getPriority() {
  return document.querySelector('input[name="priority"]:checked')?.value || 'balanced';
}

function setPriority(priority) {
  const radio = document.querySelector(`input[name="priority"][value="${priority}"]`);
  if (radio) radio.checked = true;
  $('priority-hint').textContent = priorityHint(getPriority());
}

/**
 * A new priority re-sorts the results on screen right away: the travel times
 * are known, only the order changes (no new searches).
 */
function priorityChanged() {
  const priority = getPriority();
  $('priority-hint').textContent = priorityHint(priority);
  if (!lastResult || !lastQuery) return;
  lastQuery = { ...lastQuery, priority };
  if (shownRequest) shownRequest = { ...shownRequest, priority };
  lastResult.priority = priority;
  lastResult.places = rerankPlaces(lastResult.places, { preferOpen: !lastResult.departure, priority });
  history.replaceState({ search: searchLink(lastQuery, { own: true }) }, '');
  renderSummary($('results-summary'), lastResult);
  slideIntoNewOrder($('place-list'), renderList);
}

/**
 * Re-render the list, then let each station slide from where it was to its new place
 * on the line (none of it when the visitor asked for reduced motion).
 */
function slideIntoNewOrder(list, render) {
  const before = new Map([...list.children].map((card) => [card.dataset.placeId, card.getBoundingClientRect().top]));
  render();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const card of list.children) {
    const from = before.get(card.dataset.placeId);
    const shift = from === undefined ? 0 : from - card.getBoundingClientRect().top;
    if (Math.abs(shift) < 1) continue;
    card.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], {
      duration: 520,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
  }
}

for (const radio of document.querySelectorAll('input[name="priority"]')) radio.addEventListener('change', priorityChanged);

function selectedCategories() {
  return [...document.querySelectorAll('#category-chips input:checked')].map((i) => i.value);
}

function renderCategoryChips(selected) {
  const container = $('category-chips');
  container.replaceChildren(
    ...CATEGORIES.map((cat) => {
      const label = document.createElement('label');
      label.className = 'chip';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = cat.id;
      input.checked = selected.includes(cat.id);
      const span = document.createElement('span');
      span.append(categoryRoundel(cat.id, 'roundel roundel-sm'), cat.label);
      label.append(input, span);
      return label;
    }),
  );
}

/** Forget anything in flight for a side: a picked suggestion resolving, a location request. */
function invalidateSide(side) {
  side.selection = null;
  side.pending = null;
  side.geo = null;
}

function setSideLocation(key, location) {
  const side = sides[key];
  side.location = location;
  side.input.value = location?.label ?? '';
  side.input.removeAttribute('aria-invalid');
}

/** Autocomplete, "my location" and the rest for the starting point `key`. */
function setupSide(key) {
  const side = sides[key];
  side.ac = attachAutocomplete(side.input, side.list, {
    fetchSuggestions: (query, signal) => withProvider((p) => p.suggest(query, { signal })),
    onSelect: (suggestion) => {
      side.input.removeAttribute('aria-invalid');
      side.geo = null;
      const value = suggestion.value ?? suggestion.title;
      const token = {};
      side.selection = token;
      // A search started before this resolves waits for it (see runSearch).
      side.pending = (async () => {
        try {
          const location = await suggestion.resolve();
          // Ignore if the user picked or typed something else meanwhile.
          if (side.selection === token && side.input.value === value && location) {
            side.location = { ...location, label: value };
          }
        } catch (err) {
          console.warn('could not resolve suggestion', err);
          if (side.selection === token) side.location = null;
        } finally {
          if (side.selection === token) side.pending = null;
        }
      })();
    },
    onEdit: () => {
      side.location = null;
      invalidateSide(side);
      side.input.removeAttribute('aria-invalid');
    },
    footer: () => suggestFooter,
  });
  // Start loading the provider's SDK as soon as the user shows intent.
  side.input.addEventListener('focus', () => getProvider().catch(() => {}), { once: true });
  const button = locateButton(key);
  button.addEventListener('click', () => locate(key, button));
  // Typing cancels the side's location request (see onEdit): clear its spinner.
  side.input.addEventListener('input', () => button.classList.remove('is-busy'));
}

for (const key of ['a', 'b']) setupSide(key);

// "Next" on a phone keyboard (or Enter) in field A moves on to field B instead of
// submitting a half-filled form. Registered after the combobox, which handles
// Enter itself when an option is highlighted.
sides.a.input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented) return;
  if (!sides.b.input.value.trim()) {
    e.preventDefault();
    sides.b.input.focus();
  }
});

/** Use the device's position for the starting point `key`. */
function locate(key, button) {
  const side = sides[key];
  if (!navigator.geolocation) {
    showStatus('error', 'הדפדפן הזה לא תומך באיתור מיקום.');
    return;
  }
  // The latest request wins; typing, picking or swapping cancels it.
  const token = {};
  side.geo = token;
  button.classList.add('is-busy');
  // A permission prompt left unanswered never calls back, so stop the spinner eventually.
  const watchdog = setTimeout(() => {
    if (side.geo === token) button.classList.remove('is-busy');
  }, GEOLOCATION_WATCHDOG_MS);
  const done = () => {
    clearTimeout(watchdog);
    if (side.geo !== token) return false;
    side.geo = null;
    button.classList.remove('is-busy');
    return true;
  };
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (!done()) return;
      side.ac.cancel();
      side.selection = null;
      side.pending = null;
      setSideLocation(key, {
        label: MY_LOCATION_LABEL,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        source: 'device',
      });
      // Clear an error (e.g. an earlier "couldn't get your location"), not a notice about
      // the results on screen or the progress of a search that is still running.
      if (showingError()) hideStatus();
    },
    () => {
      if (!done()) return;
      showStatus('error', 'לא הצלחנו לקבל את המיקום שלך. אפשר לבדוק שהרשאת המיקום מופעלת, או פשוט להקליד כתובת.');
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 },
  );
}

/**
 * One more starting point, under א and ב, up to MAX_POINTS in all. Returns its
 * key, or null when there are as many as a search takes.
 */
function addPoint({ focus = true } = {}) {
  if (sideKeys().length >= MAX_POINTS) return null;
  const key = `x${++extraCount}`;
  const row = $('extra-point-template').content.firstElementChild.cloneNode(true);
  row.dataset.side = key;
  const input = row.querySelector('input');
  const list = row.querySelector('.suggestions');
  input.id = `input-${key}`;
  input.name = key;
  list.id = `list-${key}`;
  input.setAttribute('aria-controls', list.id);
  row.querySelector('.endpoint-label').htmlFor = input.id;
  row.querySelector('.locate').dataset.side = key;
  for (const radio of row.querySelectorAll('.mode-toggle input')) radio.name = `mode-${key}`;
  row.querySelector('.remove-point').addEventListener('click', () => removePoint(key));
  $('extra-endpoints').append(row);
  extraKeys.push(key);
  sides[key] = newSide(key);
  setupSide(key);
  updateExtraPoints();
  if (focus) input.focus();
  return key;
}

function removePoint(key) {
  const side = sides[key];
  if (!side) return;
  side.ac.cancel();
  // Anything still resolving for it (a suggestion, a location) is dropped.
  invalidateSide(side);
  document.querySelector(`.endpoint[data-side="${key}"]`).remove();
  delete sides[key];
  extraKeys = extraKeys.filter((k) => k !== key);
  updateExtraPoints();
  $('add-point').focus();
}

/** Letters by position (removing ג makes ד the new ג), and the add button while there's room. */
function updateExtraPoints() {
  extraKeys.forEach((key, i) => {
    const row = document.querySelector(`.endpoint[data-side="${key}"]`);
    const letter = SIDE_LETTERS[i + 2];
    row.querySelector('.side-badge').textContent = letter;
    row.querySelector('.endpoint-label .sr-only').textContent = `נקודת יציאה ${letter}׳`;
    row.querySelector('.suggestions').setAttribute('aria-label', `הצעות לנקודה ${letter}׳`);
    row.querySelector('.mode-toggle').setAttribute('aria-label', `איך מגיעים מנקודה ${letter}׳`);
    row.querySelector('.remove-point').setAttribute('aria-label', `הסרת נקודה ${letter}׳`);
  });
  $('extra-endpoints').hidden = !extraKeys.length;
  $('add-point').hidden = sideKeys().length >= MAX_POINTS;
  $('priority-hint').textContent = priorityHint(getPriority());
}

$('add-point').addEventListener('click', () => addPoint());

$('swap').addEventListener('click', () => {
  const snapshot = (key) => ({ location: sides[key].location, text: sides[key].input.value, mode: getMode(key) });
  const a = snapshot('a');
  const b = snapshot('b');
  for (const [key, from] of [
    ['a', b],
    ['b', a],
  ]) {
    const side = sides[key];
    // Anything still resolving belonged to the other field.
    invalidateSide(side);
    side.location = from.location;
    side.input.value = from.text;
    // A "missing" mark was about the text that has just moved away.
    side.input.removeAttribute('aria-invalid');
    setMode(key, from.mode);
  }
  for (const key of ['a', 'b']) locateButton(key).classList.remove('is-busy');
});

const departureChoice = $('departure-choice');
const departureInput = $('departure');

// The field holds Israel time, whatever zone the device is set to (see core/state.js).
departureChoice.addEventListener('change', () => {
  const later = departureChoice.value === 'later';
  departureInput.hidden = !later;
  if (later) {
    const now = new Date();
    departureInput.min = toIsraelTime(now);
    // Fill a sensible default when empty or when the old value has already passed.
    if (!departureInput.value || israelTimeToDate(departureInput.value) < now) {
      const soon = new Date(now.getTime() + 60 * 60 * 1000);
      // Israel's offset is whole hours, so its quarter hours are UTC's.
      soon.setUTCMinutes(Math.ceil(soon.getUTCMinutes() / 15) * 15, 0, 0);
      departureInput.value = toIsraelTime(soon);
    }
    departureInput.focus();
  }
});

/** {date: Date|null, past: boolean} – a past time means "now" to the routing services. */
function departureValue() {
  if (departureChoice.value !== 'later' || !departureInput.value) return { date: null, past: false };
  const date = israelTimeToDate(departureInput.value);
  if (Number.isNaN(date.getTime())) return { date: null, past: false };
  // A minute or two of slack: a time picked "just now" shouldn't count as past.
  if (date.getTime() < Date.now() - 2 * 60 * 1000) return { date: null, past: true };
  return { date: date < new Date() ? null : date, past: false };
}

function resetDepartureToNow() {
  departureChoice.value = 'now';
  departureInput.hidden = true;
  updateOptionsSummary();
}

// ------------------------------------------------------------------ options
// The options stay folded into one row; the row says how the search is set.

const PRIORITY_LABEL = { equal: 'זמן שווה', balanced: 'מאוזן', gap: 'פער גמיש' };

function departureSummary() {
  const date = departureChoice.value === 'later' && departureInput.value ? israelTimeToDate(departureInput.value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'יוצאים עכשיו';
  const format = (options) => new Intl.DateTimeFormat('he-IL', { timeZone: ISRAEL_TIME_ZONE, ...options }).format(date);
  // Today and tomorrow on Israel's calendar too (Date.parse reads a bare date as UTC midnight).
  const israelDay = (d) => Date.parse(toIsraelTime(d).slice(0, 10));
  const days = Math.round((israelDay(date) - israelDay(new Date())) / 86_400_000);
  const day =
    days === 0 ? 'היום' : days === 1 ? 'מחר' : `ב${format({ weekday: 'short' })} ${format({ day: 'numeric', month: 'numeric' })}`;
  return `יוצאים ${day} ב-${format({ hour: '2-digit', minute: '2-digit' })}`;
}

function updateOptionsSummary() {
  const filters = [];
  if ($('only-green-line').checked) filters.push('בתוך הקו הירוק');
  if ($('only-shabbat-closed').checked) filters.push('סגור בשבת');
  const parts = [PRIORITY_LABEL[getPriority()], departureSummary(), ...(filters.length ? filters : ['בלי סינון'])];
  // Lines break between the parts, never inside one.
  $('options-values').textContent = parts.map((part) => part.replaceAll(' ', ' ')).join(' · ');
}

// Typing a time fires `input`; everything else in the form fires `change`.
$('search-form').addEventListener('change', updateOptionsSummary);
departureInput.addEventListener('input', updateOptionsSummary);

// ------------------------------------------------------------------- status

function showStatus(kind, message, details = []) {
  const box = $('status');
  box.dataset.kind = kind;
  box.replaceChildren();
  if (kind === 'progress') {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    box.append(spinner);
  }
  const body = document.createElement('div');
  const p = document.createElement('p');
  p.textContent = message;
  body.append(p);
  if (details.length) {
    const ul = document.createElement('ul');
    for (const d of details) {
      const li = document.createElement('li');
      li.textContent = d;
      ul.append(li);
    }
    body.append(ul);
  }
  box.append(body);
  box.hidden = false;
}

function hideStatus() {
  $('status').hidden = true;
}

/** An error on screen (e.g. the user's own failed search), which a re-run they didn't ask for leaves alone. */
function showingError() {
  return !$('status').hidden && $('status').dataset.kind === 'error';
}

let toastTimer = 0;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 2600);
}

// ------------------------------------------------------------------- search

let searchSeq = 0;
let lastResult = null;
let activeFilter = 'all';
/** Places allowed to show a (billed) Google photo for the result on screen. */
let photoIds = new Set();
/** What the list currently shows, so the map can be drawn to match once it's ready. */
let shown = { places: [], numbering: new Map() };

/** What the user asked for, independent of any provider. */
function readForm() {
  const endpoint = (key) => ({ text: sides[key].input.value.trim(), location: sides[key].location });
  const departure = departureValue();
  return {
    a: endpoint('a'),
    b: endpoint('b'),
    modeA: getMode('a'),
    modeB: getMode('b'),
    categories: selectedCategories(),
    departure: departure.date,
    departurePast: departure.past,
    greenLine: $('only-green-line').checked,
    shabbat: $('only-shabbat-closed').checked,
    priority: getPriority(),
    // More starting points, after א and ב (key: their field, for remembering coordinates).
    extra: extraKeys.map((key) => ({ key, ...endpoint(key), mode: getMode(key) })),
  };
}

/**
 * Coordinates for an endpoint with `provider`. Known coordinates are reused,
 * except Google-derived ones on another provider: Google's terms keep its data
 * off non-Google maps, so those are looked up again.
 */
async function resolveEndpoint(endpoint, provider) {
  const loc = endpoint.location;
  if (loc && Number.isFinite(loc.lat) && (loc.source !== 'google' || provider.id === 'google')) {
    return { ...loc, label: endpoint.text || loc.label };
  }
  const found = await provider.geocode(endpoint.text);
  return found ? { ...found, label: endpoint.text } : null;
}

function validateForm() {
  const problems = [];
  sideKeys().forEach((key, i) => {
    if (sides[key].input.value.trim()) return;
    sides[key].input.setAttribute('aria-invalid', 'true');
    // An extra point can just as well go.
    problems.push(`חסרה נקודת יציאה ${SIDE_LETTERS[i]}׳${i >= 2 ? ' (או שאפשר להסיר אותה)' : ''}.`);
  });
  if (!selectedCategories().length) problems.push('צריך לבחור לפחות סוג מקום אחד.');
  return problems;
}

let searching = false;

/** `label`: what the button says meanwhile. */
function setBusy(busy, { background = false, label = 'מחפשים…' } = {}) {
  searching = busy;
  const button = $('submit');
  // A re-run the user didn't ask for leaves the button on: a search they start replaces it.
  button.disabled = busy && !background;
  button.textContent = button.disabled ? label : 'מצאו לנו מקום באמצע';
}

/**
 * Run a search from the form, or re-run `request` (an earlier one) after the
 * provider changed. `pick`: the id of a place to open the results on (a shared place link);
 * `notice`: one more notice to show with the results.
 */
async function runSearch({ request = null, redo = false, background = false, pick = null, notice = null } = {}) {
  if (!request) {
    const problems = validateForm();
    if (problems.length) {
      showStatus('error', problems.join(' '));
      return;
    }
  }
  const seq = ++searchSeq;
  if (!request) {
    setBusy(true);
    showStatus('progress', PROGRESS_TEXT.geocode);
    // A suggestion picked a moment ago may still be resolving: use it, don't re-geocode.
    await Promise.all(sideKeys().map((key) => sides[key].pending));
    if (seq !== searchSeq) return;
    // The form may have changed meanwhile (a point added, a field emptied): check it again.
    const problems = validateForm();
    if (problems.length) {
      setBusy(false);
      showStatus('error', problems.join(' '));
      if (shownNeedsRedo) redoShownSearch();
      return;
    }
    request = readForm();
    if (request.departurePast) resetDepartureToNow();
  }
  const failuresBefore = googleFailures;
  setBusy(true, { background });
  const quiet = () => background && showingError();
  if (!quiet()) showStatus('progress', PROGRESS_TEXT.geocode);
  const progress = (step) => {
    const text = (request.extra?.length && GROUP_PROGRESS_TEXT[step]) || PROGRESS_TEXT[step];
    if (seq === searchSeq && text && !quiet()) showStatus('progress', text);
  };

  try {
    const result = await withProvider(async (provider) => {
      const greenLineAreas = request.greenLine ? loadGreenLine().catch(greenLineFailed) : null;
      greenLineAreas?.catch(() => {});
      const endpoints = [
        ['a', request.a],
        ['b', request.b],
        ...(request.extra || []).map((point) => [point.key, point]),
      ];
      const found = await Promise.all(endpoints.map(([, endpoint]) => resolveEndpoint(endpoint, provider)));
      if (seq !== searchSeq) return null;
      const missing = [];
      endpoints.forEach(([key, endpoint], i) => {
        const loc = found[i];
        // (A re-run may outlive an extra point's field: the user removed it.)
        const side = sides[key];
        if (!loc) missing.push([key, endpoint.text]);
        // Remember the coordinates while the field still says the same thing, and the
        // user hasn't given it other coordinates since (e.g. "my location" again).
        else if (side && side.input.value.trim() === endpoint.text && side.location === endpoint.location) {
          side.location = loc;
        }
      });
      if (missing.length) {
        for (const [key, text] of missing) {
          // Not when the field says something else by now (e.g. a re-run while typing).
          if (sides[key]?.input.value.trim() === text) sides[key].input.setAttribute('aria-invalid', 'true');
        }
        const err = new Error('not found');
        err.userMessage = `לא הצלחנו למצוא את ${missing.map(([, t]) => `„${t}”`).join(' ואת ')}. אפשר לנסות לכתוב אחרת או לבחור מהרשימה שנפתחת בזמן ההקלדה.`;
        throw err;
      }
      // Load the Google map now: it's needed anyway, and it is when Google reports a
      // rejected Maps key – before the billed place searches run. (Not before both
      // places are found: a search that stops there leaves the map on screen as it is.)
      const mapReady = provider.id === 'google' ? ensureMap(provider) : null;
      mapReady?.catch(() => {});
      const [a, b, ...more] = found;
      const query = {
        a,
        b,
        extra: more.map((loc, i) => ({ ...loc, mode: request.extra[i].mode })),
        modeA: request.modeA,
        modeB: request.modeB,
        categories: request.categories,
        departure: request.departure,
        greenLine: request.greenLine,
        shabbat: request.shabbat,
        priority: request.priority,
      };
      // The filters the user chose, noting which ones left places out.
      const dropped = new Set();
      if (request.greenLine || request.shabbat) {
        const areas = await greenLineAreas;
        // The middle is found along a road that doesn't go through the West Bank.
        if (areas) query.avoidAreas = areas;
        query.placeFilter = (place) => {
          if (areas && beyondGreenLine(areas, place)) {
            dropped.add('green-line');
            return false;
          }
          if (request.shabbat && SHABBAT_CATEGORIES.has(place.category) && place.closedOnShabbat !== true) {
            dropped.add(place.hoursUnknown ? 'shabbat-busy' : 'shabbat');
            return false;
          }
          return true;
        };
      }
      // Two starting points meet along the road between them; more, in the area they surround.
      const res = query.extra.length
        ? await findGroupMiddle(groupQuery(query), provider, { onProgress: progress })
        : await findMiddle(query, provider, { onProgress: progress });
      // Google results need a Google map; if it can't load, redo the search on OSM.
      if (mapReady) await mapReady;
      return { res, provider, query, dropped };
    });
    if (!result || seq !== searchSeq) return;
    // Google failed in this page while the search was running (e.g. the map showed
    // its error screen late): its results would sit on a broken map, so redo it.
    // (A block recorded by another tab doesn't make this tab's results wrong.)
    if (result.provider.id === 'google' && googleFailures !== failuresBefore && !redo) {
      return await runSearch({ request, redo: true, background, pick, notice });
    }
    if (request.departurePast) result.res.notices.unshift('departure-past');
    if (notice) result.res.notices.unshift(notice);
    result.res.searchedAt = Date.now();
    // Say why there are few places when a filter took some away.
    const { places } = result.res;
    if (result.dropped.has('green-line') && places.length < 5) result.res.notices.push('green-line');
    if (result.dropped.has('shabbat-busy')) result.res.notices.push('shabbat-busy');
    else if (result.dropped.has('shabbat') && places.filter((p) => SHABBAT_CATEGORIES.has(p.category)).length < 3) {
      result.res.notices.push('shabbat');
    }
    // The priority was changed while the search ran: sort its places the new way.
    const priority = getPriority();
    if (priority !== result.res.priority) {
      result.res.priority = priority;
      result.res.places = rerankPlaces(result.res.places, { preferOpen: !result.res.departure, priority });
      result.query = { ...result.query, priority };
      request = { ...request, priority };
    }
    lastQuery = result.query;
    shownRequest = request;
    shownNeedsRedo = false;
    // A reload (or coming back to this page) shows this search again, on the shared
    // place it opened on if any; the address bar stays as it is.
    history.replaceState({ search: searchLink(result.query, { own: true, place: pick }) }, '');
    // A re-run doesn't scroll away from a field the user is typing in, or to an error it leaves on screen.
    const typing = sideKeys().some((key) => sides[key].input === document.activeElement);
    await showResult(result.res, result.provider, { scroll: !(background && (typing || quiet())), status: !quiet(), pick });
  } catch (err) {
    if (seq !== searchSeq) return;
    console.error(err);
    if (!quiet()) showStatus('error', err.userMessage || 'משהו השתבש בחיפוש. כדאי לנסות שוב בעוד רגע.');
    restoreShownMap();
  } finally {
    if (seq === searchSeq) {
      setBusy(false);
      // A re-run that failed isn't retried; a search that took its place and failed does it again.
      if (background) shownNeedsRedo = false;
      else if (shownNeedsRedo) redoShownSearch();
    }
  }
}

/** The search for three or more starting points (core/group.js), from the form's query. */
function groupQuery(query) {
  return {
    points: [query.a, query.b, ...query.extra],
    modes: [query.modeA, query.modeB, ...query.extra.map((p) => p.mode)],
    categories: query.categories,
    departure: query.departure,
    priority: query.priority,
    avoidAreas: query.avoidAreas,
    placeFilter: query.placeFilter,
  };
}

function greenLineFailed(err) {
  console.error(err);
  const failed = new Error('Green Line data failed to load');
  failed.userMessage = 'לא הצלחנו לטעון את גבולות הקו הירוק. כדאי לנסות שוב, או לחפש בלי הסינון.';
  throw failed;
}

/** How an endpoint appears in a shared link (or, `own`, in this tab's history). */
function forLink(loc, { own = false } = {}) {
  // Google-derived coordinates stay out of links (they'd end up on other maps).
  if (loc.source === 'google') return { label: loc.label };
  // The sender's own position: neutral label, ~100 m precision (not their doorstep).
  if (loc.source === 'device' && !own) {
    const round = (x) => Math.round(x * 1e3) / 1e3;
    return { label: SHARED_LOCATION_LABEL, lat: round(loc.lat), lng: round(loc.lng) };
  }
  return loc;
}

/**
 * A link to the search (`own`: only for this tab's history, so "my location" stays
 * as it is). With `place`, the link opens the search on that place (a shared place);
 * with `snapshot`, it opens those stored results if it can, and searches if not.
 */
function searchLink(query, { own = false, place = null, snapshot = null } = {}) {
  const qs = encodeState({
    a: forLink(query.a, { own }),
    b: forLink(query.b, { own }),
    modeA: query.modeA,
    modeB: query.modeB,
    categories: query.categories,
    departure: query.departure ? toIsraelTime(query.departure) : null,
    greenLine: query.greenLine,
    shabbat: query.shabbat,
    priority: query.priority,
    provider: forcedProvider,
    extra: (query.extra || []).map((p) => ({ ...forLink(p, { own }), mode: p.mode })),
    place,
    snapshot,
  });
  return own ? `?${qs}` : `${location.origin}${location.pathname}?${qs}`;
}

/** The address of the site itself, without a search (sharing it shares the app). */
function plainAddress() {
  return forcedProvider ? `${location.pathname}?p=${forcedProvider}` : location.pathname;
}

/** The map view for `provider`'s kind, created once (concurrent callers share it). */
function ensureMap(provider) {
  const wanted = provider.id === 'google' ? 'google' : 'leaflet';
  if (mapPromise && mapKind === wanted && mapPromise !== brokenMap) return mapPromise;
  // Google's billed calls wait for its map's verdict on the key: tell it one is
  // coming before the wait for the old map below, which a running search would
  // otherwise slip past.
  provider.expectMap?.();
  const previous = mapPromise;
  mapKind = wanted;
  const promise = (async () => {
    const old = await previous?.catch(() => null);
    currentMap = null;
    try {
      old?.destroy();
    } catch (err) {
      // A Google map whose key was rejected can fail on teardown; it's gone either way.
      console.warn('map teardown failed', err);
    }
    const map = await provider.createMap($('map'), { overview: $('overview') });
    if (mapPromise !== promise) {
      // Superseded while loading (the provider switched).
      map.destroy();
      throw new Error('map superseded');
    }
    currentMap = map;
    document.body.classList.add('has-map');
    return map;
  })();
  mapPromise = promise;
  promise.catch(() => {
    if (mapPromise === promise) {
      mapPromise = null;
      mapKind = null;
    }
  });
  return promise;
}

/**
 * The map to draw the results on screen on: only one of the kind their provider
 * needs (a stale map of the other kind may be broken, e.g. a rejected Google key).
 */
function resultMap() {
  if (!currentMap || !lastResult) return null;
  return currentMap.kind === (lastResult.providerId === 'google' ? 'google' : 'leaflet') ? currentMap : null;
}

/** Map updates never get to break the list. */
function onMap(fn) {
  const map = resultMap();
  if (!map) return;
  try {
    fn(map);
  } catch (err) {
    console.error('map update failed', err);
  }
}

function displayedPlaces() {
  if (!lastResult) return [];
  if (activeFilter !== 'all') {
    return lastResult.places.filter((p) => p.category === activeFilter).slice(0, RESULTS_LIMIT);
  }
  const perCategory = Math.max(4, Math.ceil(RESULTS_LIMIT / Math.max(1, lastResult.categories.length)) + 2);
  return pickTop(lastResult.places, { limit: RESULTS_LIMIT, perCategory });
}

function renderList() {
  showPicked(null);
  const places = displayedPlaces();
  const numbering = new Map(places.map((p, i) => [p.id, i + 1]));
  shown = { places, numbering };
  renderFilters($('result-filters'), lastResult.places, activeFilter, (id) => {
    activeFilter = id;
    renderList();
  });
  renderPlaces($('place-list'), $('place-card-template'), places, {
    modeA: lastResult.modeA,
    modeB: lastResult.modeB,
    modes: lastResult.modes,
    labels: tripLabels(),
    numbering,
    photoIds,
    showOpenState: !lastResult.departure,
    onSelect: selectPlace,
    onShare: sharePlace,
  });
  onMap((map) => map.showPlaces(places, { numbering, onSelect: selectPlace }));
}

/**
 * The two starting points' names, as the search on screen was made (or as typed,
 * before one). On the user's own screen "my location" keeps its name: the neutral
 * label is for what gets shared (see forLink).
 */
function tripLabels() {
  const all = lastQuery
    ? [lastQuery.a, lastQuery.b, ...(lastQuery.extra || [])].map((p) => p.label)
    : sideKeys().map((key) => sides[key].input.value.trim());
  return { a: all[0], b: all[1], all };
}

/**
 * Once there is a trip, the header carries it: א's place, the line with its middle,
 * ב's place, and how many more starting points a group has ("+2").
 */
function showTrip({ a, b, all }) {
  $('trip-a').textContent = a;
  $('trip-b').textContent = b;
  const more = all.length - 2;
  $('trip-more').hidden = more < 1;
  $('trip').classList.toggle('is-group', more > 0);
  $('trip-more-count').textContent = `+${more}`;
  $('trip-more-text').textContent = more === 1 ? 'ועוד נקודת יציאה אחת' : `ועוד ${more} נקודות יציאה`;
  $('trip').hidden = false;
  document.querySelector('.tagline').hidden = true;
  document.body.classList.add('has-results');
}

// The result chips sit above the map on phones, and under the results heading on wider screens.
const wideScreen = matchMedia('(min-width: 960px)');
function placeResultFilters() {
  if (wideScreen.matches) $('results-summary').after($('result-filters'));
  else document.querySelector('.status-region').after($('result-filters'));
}
wideScreen.addEventListener('change', placeResultFilters);
placeResultFilters();

// The trip in the header is the way back to the search form.
$('trip').addEventListener('click', () => window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));

/**
 * Show a search's results. `pick`: the id of a place to open them on, picked as
 * its sender had it (a shared place link).
 */
async function showResult(result, provider, { scroll = true, status = true, pick = null } = {}) {
  lastResult = result;
  shownProvider = provider;
  activeFilter = 'all';
  // Photos are billed per image: allow them for the first few places of this
  // result only, however the list is filtered later.
  photoIds = new Set(displayedPlaces().slice(0, MAX_PHOTOS).map((p) => p.id));
  updateProviderNote(provider);
  // The search's own names, not the fields: a re-run may finish while the user types the next search.
  showTrip(tripLabels());

  const notices = result.notices.map((n) => (typeof NOTICE_TEXT[n] === 'function' ? NOTICE_TEXT[n](result) : NOTICE_TEXT[n])).filter(Boolean);
  // (Not over stored results: they come from the free maps whatever this page uses.)
  if (provider.id !== 'google' && !result.sharedAt && switchBlock && SWITCH_REASON_TEXT[switchBlock.reason]) {
    notices.unshift(SWITCH_REASON_TEXT[switchBlock.reason]);
  }
  // The place someone shared: the recipient's search may not have it (another time,
  // or the free maps instead of Google's), so it's looked for among the results.
  let picked = pick ? result.places.find((p) => p.id === pick) || null : null;
  const listed = () => displayedPlaces().some((p) => p.id === picked.id);
  if (picked && !listed()) {
    // Left out of the whole list (its sender had its kind of places chosen): the
    // list of its kind, as the sender saw it.
    activeFilter = picked.category;
    if (!listed()) {
      activeFilter = 'all';
      picked = null;
    }
  }
  if (pick && !picked) notices.push(NOTICE_TEXT['shared-place-missing']);
  if (!status) {
    // Leave what the status says (an error the user is reading).
  } else if (notices.length === 1) showStatus('info', notices[0]);
  else if (notices.length > 1) showStatus('info', 'כמה דברים שכדאי לדעת:', notices);
  else hideStatus();

  // The list doesn't wait for the map (a slow map script must not hide results).
  $('results').hidden = false;
  warmShareService();
  renderSummary($('results-summary'), result);
  renderList();

  // Show the map box right away (it fills in when the map is ready), so the
  // phone layout has something to scroll to on the first search.
  document.body.classList.add('has-map');
  if (picked) {
    // Picked as from the list: its card marked (under the map on phones) and
    // scrolled to; the map zooms in on it once it's drawn.
    selectPlace(picked, { from: 'link', scroll });
  } else if (scroll && window.matchMedia('(max-width: 959px)').matches) {
    // A notice explains the results, so show it first; otherwise go to the map.
    scrollIntoPlace(notices.length ? $('status') : resultsTop());
  }
  await drawOnMap(result, provider);
  // Still the place on screen (not another one picked, or another list chosen, meanwhile).
  if (picked && lastResult === result && $('place-list').querySelector('.place-card.is-active')?.dataset.placeId === picked.id) {
    onMap((map) => map.highlight(picked.id, { focus: true }));
  }
}

async function drawOnMap(result, provider) {
  try {
    await ensureMap(provider);
  } catch (err) {
    console.error('map failed', err);
    return;
  }
  if (lastResult !== result) return;
  onMap((map) => {
    map.showSearch(result);
    map.showPlaces(shown.places, { numbering: shown.numbering, onSelect: selectPlace });
  });
}

const isPhone = () => window.matchMedia('(max-width: 959px)').matches;
// A touch screen, so typing brings up an on-screen keyboard. A narrow desktop
// window (snapped, or zoomed in) has the phone layout but a hardware keyboard.
const hasTouchKeyboard = () => window.matchMedia('(pointer: coarse)').matches;

/**
 * `from`: 'list', 'map', or 'link' (a shared place, picked for the recipient as
 * its sender had it). `scroll: false` leaves the page where it is.
 */
function selectPlace(place, { from, scroll = true }) {
  // Its card has a share button.
  warmShareService();
  // A place picked from the list is zoomed in on (with the whole search in the
  // corner); one picked on the map stays where the user is looking.
  onMap((map) => map.highlight(place.id, { focus: from !== 'map' }));
  const phone = isPhone();
  // Its card comes into view in the list, unless the user just tapped it there.
  setActiveCard($('place-list'), place.id, { scroll: scroll && from !== 'list' && !phone });
  if (!phone) return;
  // On phones the map and the list are far apart: the picked place's card comes
  // up under the map, so the map and its links (Waze etc.) are on screen together.
  showPicked(place);
  if (scroll && from !== 'map') scrollIntoPlace(resultsTop());
}

/** Where the results begin on a phone: their category chips, or the map when there are none. */
function resultsTop() {
  const filters = $('result-filters');
  return filters.hidden ? document.querySelector('.map-wrap') : filters;
}

/**
 * Scroll `target` to the top of the screen, under the pinned header (phones). A smooth
 * scroll that starts right after another scroll can end without moving; if it ends
 * short, go there directly.
 */
function scrollIntoPlace(target) {
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const landed = () => {
    if (Math.abs(target.getBoundingClientRect().top - margin) > 24) target.scrollIntoView({ block: 'start' });
  };
  // Not AbortSignal.timeout(): browsers without it (Safari 15, old WebViews) would
  // throw here, and the search would end in an error with its results half shown.
  window.addEventListener('scrollend', landed, { once: true });
  setTimeout(() => window.removeEventListener('scrollend', landed), 1500);
}

/** A copy of the place's card under the map (phones), or none. */
function showPicked(place) {
  const box = $('picked');
  const card = place && $('place-list').querySelector(`.place-card[data-place-id="${CSS.escape(place.id)}"]`);
  if (!card) {
    box.hidden = true;
    box.firstElementChild.replaceChildren();
    return;
  }
  const copy = card.cloneNode(true);
  copy.classList.remove('is-active');
  dropPhotoOnError(copy); // its photo loads on its own, and may fail on its own
  copy.querySelector('.share-place')?.addEventListener('click', () => sharePlace(place));
  box.firstElementChild.replaceChildren(copy);
  box.hidden = false;
}

/** The starting points of the search on screen, as a shared text names them. */
function sharedLabels() {
  return [lastQuery.a, lastQuery.b, ...(lastQuery.extra || [])].map((loc) => forLink(loc).label);
}

/** "חיפה, תל אביב ובאר שבע" */
function joinNames(names) {
  // Not names.at(-1): Safari before 15.4 and old WebViews don't have it.
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ו${names[names.length - 1]}`;
}

/**
 * The link to share for the results on screen (`place`: opening on that place).
 * Free (OpenStreetMap) results travel as they are: stored with the share service,
 * and the link is a short one to them (they hold the search too). Google's terms
 * don't allow storing its results, so their link carries the search, which runs
 * again; so does the link of results that couldn't be stored.
 */
async function shareLink({ place = null } = {}) {
  const placeId = place?.id ?? null;
  const stored = snapshotFor(lastResult, lastQuery);
  if (stored) {
    const outcome = await settledWithin(stored.done, SHARE_WAIT_MS);
    // Stored: the short link.
    if (outcome === true) return { url: snapshotLink(stored.id, { place: placeId }), stored };
    // Still on the way: a link to them that carries the search too, which runs if
    // they don't make it (or if the recipient can't reach the share service).
    if (outcome === undefined && stored.id) return { url: searchLink(lastQuery, { place: placeId, snapshot: stored.id }), stored };
  }
  return { url: searchLink(lastQuery, { place: placeId }), stored };
}

/**
 * Once a share is done: if its results couldn't be stored, say so and why (the
 * link that went out is the long one, which searches again).
 */
function reportStore(stored) {
  stored?.done.then((ok) => {
    if (!ok) toast(`לא הצלחנו לשמור את התוצאות (${stored.problem || 'סיבה לא ידועה'}), אז הקישור ארוך ומחפש מחדש.`);
  });
}

/**
 * Tell the share service's log about a store or read that failed or was slow
 * (what went wrong and how long it took, nothing shared). Best effort.
 */
function reportShare(details) {
  // A plain request, not sendBeacon (keepalive, which the Android app's WebView didn't send).
  fetch(`${SHARE_API}/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ ...details, version: config.build ? String(config.build).slice(0, 12) : null }),
    signal: timeoutSignal(20000),
  }).catch(() => {
    // Only a report.
  });
}

/** Why storing failed, in words. */
function storeProblem(err) {
  if (err?.name === 'AbortError') return 'שירות השיתוף לא ענה בזמן';
  const status = String(err?.message || '').match(/share service: (\d+)/)?.[1];
  if (status) return `שירות השיתוף ענה ${status}`;
  return 'אין חיבור לשירות השיתוף';
}

/**
 * Open a connection to the share service ahead of a share (free results on
 * screen, a place picked), so storing is quick enough for the short link.
 * Nothing is sent; a browser drops an unused connection after a few seconds.
 */
function warmShareService() {
  if (!SHARE_API || lastResult?.providerId !== 'osm') return;
  document.getElementById('share-preconnect')?.remove();
  const link = document.createElement('link');
  link.id = 'share-preconnect';
  link.rel = 'preconnect';
  link.href = SHARE_API;
  link.crossOrigin = 'anonymous';
  document.head.append(link);
}

/** `promise`'s value if it settles within `ms`, else undefined. */
function settledWithin(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

/** A search as fillForm takes it (a decoded link). */
function formState(query) {
  return decodeState(encodeState({ ...query, departure: query.departure ? toIsraelTime(query.departure) : null }), {
    knownCategories: CATEGORY_IDS,
  });
}

/** A short link to stored results (core/snapshot.js), opening on `place` if given. */
function snapshotLink(id, { place = null, own = false } = {}) {
  const qs = encodeState({ snapshot: id, place, provider: forcedProvider });
  return own ? `?${qs}` : `${location.origin}${location.pathname}?${qs}`;
}

/**
 * `result` stored with the share service, storing it now if need be: {id, done},
 * `done` resolving to whether it was stored. One per result and order (the
 * priority re-sorts it). Null for results that aren't stored (Google's), or
 * with no service.
 */
function snapshotFor(result, query) {
  if (!SHARE_API || !result || !query || result.providerId !== 'osm') return null;
  result.snapshots ??= {};
  const key = result.priority;
  if (result.snapshots[key]) return result.snapshots[key];
  const endpoints = [query.a, query.b, ...(query.extra || [])];
  const modes = [query.modeA, query.modeB, ...(query.extra || []).map((p) => p.mode)];
  // As a shared link shows them: "my location" rounded, under a neutral name.
  const points = endpoints.map((loc, i) => ({ ...forLink(loc), mode: modes[i] }));
  if (!points.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))) return null;
  const body = JSON.stringify(
    makeSnapshot({
      at: result.searchedAt || Date.now(),
      points,
      // The route isn't drawn up to the sender's own door.
      privatePoints: endpoints.filter((loc) => loc.source === 'device'),
      result,
      query,
    }),
  );
  // More than the service keeps (unheard of: a usual one is ~10 KB): the link searches again.
  if (new TextEncoder().encode(body).length > MAX_SNAPSHOT_BYTES - 100) return null;
  const stored = { id: null, done: null, problem: null, ms: null };
  stored.done = (async () => {
    const { key, id } = await newSnapshotKey();
    stored.id = id;
    const started = performance.now();
    try {
      await storeSnapshot(id, key, body);
    } finally {
      stored.ms = Math.round(performance.now() - started);
    }
  })().then(
    () => {
      if (stored.ms > SHARE_WAIT_MS) reportShare({ kind: 'store-slow', ms: stored.ms, bytes: body.length });
      return true;
    },
    (err) => {
      console.warn('storing the shared results failed', err);
      stored.problem = storeProblem(err);
      reportShare({ kind: 'store-failed', problem: `${err?.name}: ${err?.message}`, ms: stored.ms, bytes: body.length });
      // The next share tries again.
      if (result.snapshots[key] === stored) delete result.snapshots[key];
      return false;
    },
  );
  result.snapshots[key] = stored;
  return stored;
}

/** A timeout for fetch, without AbortSignal.timeout (missing in Safari 15 and old WebViews). */
function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** Store a snapshot (`snapshot`, its JSON) under `id`, with the `key` that id comes from. */
async function storeSnapshot(id, key, snapshot) {
  const body = `{"key":${JSON.stringify(key)},"snapshot":${snapshot}}`;
  // Plain text: a simple request, so no preflight. Not keepalive: in the Android
  // app (a WebView) such requests never went out, and a share waits for this one.
  const response = await fetch(`${SHARE_API}/s/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body,
    signal: timeoutSignal(20000),
  });
  if (response.status !== 201) throw new Error(`share service: ${response.status}`);
}

/** The stored results under `id`, or null if there are none (expired); throws if out of reach. */
async function fetchSnapshot(id) {
  const response = await fetch(`${SHARE_API}/s/${id}`, { signal: timeoutSignal(12000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`share service: ${response.status}`);
  return response.json();
}

/**
 * A link to stored results was opened: show them as they were, without searching,
 * and put their search in the form. If they're gone (or out of reach), an older
 * link that also carries the search runs it; a short one says so.
 */
async function openSnapshot(id, { pick = null, canSearch = false } = {}) {
  const seq = ++searchSeq;
  setBusy(true, { label: 'טוענים את התוצאות…' });
  showStatus('progress', 'פותחים את התוצאות ששותפו…');
  // A short link has no names of its own: until they come, the fields say so.
  const waiting = new Map(sideKeys().filter((key) => !sides[key].input.value).map((key) => [key, sides[key].input.placeholder]));
  for (const key of waiting.keys()) sides[key].input.placeholder = 'טוענים…';
  let opened = null;
  let gone = false;
  const started = performance.now();
  try {
    const found = await fetchSnapshot(id);
    gone = found === null;
    const snapshot = found && parseSnapshot(found);
    if (snapshot) {
      const shown = snapshotToSearch(snapshot);
      // Their search, in the form, as soon as it's here (the map takes a moment more).
      if (seq === searchSeq) fillForm(formState(shown.query));
      if (!snapshotProvider) {
        const { createOsmProvider } = await import('./providers/osm.js');
        snapshotProvider = createOsmProvider();
        await snapshotProvider.ready?.();
      }
      opened = shown;
    }
  } catch (err) {
    console.warn('opening the shared results failed', err);
    reportShare({ kind: 'read-failed', problem: `${err?.name}: ${err?.message}`, ms: Math.round(performance.now() - started) });
  }
  for (const [key, placeholder] of waiting) if (sides[key]) sides[key].input.placeholder = placeholder;
  // The user started a search meanwhile: it's theirs to show.
  if (seq !== searchSeq) return;
  setBusy(false);
  if (!opened) {
    if (canSearch) {
      runSearch({ pick, notice: 'snapshot-missing' });
    } else {
      showStatus('error', gone ? SNAPSHOT_GONE_TEXT : SNAPSHOT_UNREACHABLE_TEXT);
      if (!config.googleMapsApiKey || forcedProvider === 'osm') updateProviderNote({ id: 'osm', attributionHtml: '' });
    }
    return;
  }
  const { query, result } = opened;
  result.places = rerankPlaces(result.places, { preferOpen: !result.departure, priority: result.priority });
  result.notices.unshift('snapshot');
  // Shared on from here, they keep their id.
  result.snapshots = { [result.priority]: id };
  lastQuery = query;
  shownRequest = null;
  shownNeedsRedo = false;
  // A reload shows them again.
  history.replaceState({ search: snapshotLink(id, { own: true, place: pick }) }, '');
  await showResult(result, snapshotProvider, { pick });
}

async function sharePlace(place) {
  // The proof that it's fair goes with it: how long each side travels.
  const times = lastQuery
    ? `\n${sharedLabels()
        .map((name, i) => `${formatDuration(place.times ? place.times[i] : i ? place.timeB : place.timeA)} מ${name}`)
        .join(' · ')}`
    : '';
  const { url, stored } = lastQuery ? await shareLink({ place }) : { url: googleMapsUrl(place), stored: null };
  const outcome = await shareOrCopy({
    title: place.name,
    text: `נפגשים באמצע? מה דעתך על ${place.name}${times}`,
    // The app, on this search with this place picked: the recipient sees the place
    // and the rest of the list, as the sender does (and has Waze and Google Maps there).
    url,
  });
  if (outcome === 'copied') toast('הקישור הועתק');
  else if (outcome === 'failed') toast('לא הצלחנו לשתף');
  if (outcome !== 'cancelled') reportStore(stored);
}

$('share-search').addEventListener('click', async () => {
  const names = lastQuery ? sharedLabels() : [];
  const text = !lastQuery
    ? 'מקום באמצע'
    : names.length > 2
      ? `מקומות באמצע בין ${joinNames(names)}`
      : `מקומות באמצע הדרך בין ${names[0]} לבין ${names[1]}`;
  const { url, stored } = lastQuery ? await shareLink() : { url: `${location.origin}${plainAddress()}`, stored: null };
  const outcome = await shareOrCopy({ title: 'מקום באמצע', text, url });
  if (outcome === 'copied') toast('הקישור לחיפוש הועתק');
  else if (outcome === 'failed') toast('לא הצלחנו לשתף');
  if (outcome !== 'cancelled') reportStore(stored);
});

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  for (const key of sideKeys()) sides[key].ac.cancel();
  // Searched from a phone's keyboard: put it away, or it covers the results the page
  // scrolls to. Not when a field is still empty: the user is sent back to type it.
  // Not without a touch screen either: there focus stays put, as on a wide desktop.
  const field = sideKeys().find((key) => sides[key].input === document.activeElement);
  if (field && isPhone() && hasTouchKeyboard() && sideKeys().every((key) => sides[key].input.value.trim())) sides[field].input.blur();
  runSearch();
});

// --------------------------------------------------------------------- init

function isFramed() {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

/** The filters remembered in this browser: the user's own choice, kept from visit to visit. */
const FILTERS_KEY = 'inthemiddle.filters';

function savedFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS_KEY)) || {};
    return { greenLine: saved.greenLine === true, shabbat: saved.shabbat === true };
  } catch {
    return { greenLine: false, shabbat: false };
  }
}

function saveFilters() {
  try {
    localStorage.setItem(
      FILTERS_KEY,
      JSON.stringify({ greenLine: $('only-green-line').checked, shabbat: $('only-shabbat-closed').checked }),
    );
  } catch {
    // Storage off (private mode etc.): the filters just aren't remembered.
  }
}

// Only a change the user makes is remembered, not filters a shared link brought.
for (const id of ['only-green-line', 'only-shabbat-closed']) $(id).addEventListener('change', saveFilters);

/**
 * Put a search into the form (decoded from a link, this tab's history, or
 * stored results). `own`: this tab's own search, where "my location" is the device's.
 */
function fillForm(state, { own = false } = {}) {
  renderCategoryChips(state.categories || DEFAULT_CATEGORY_IDS);
  const restore = (key, loc) => {
    let source = 'link';
    if (loc.label === MY_LOCATION_LABEL) {
      // This tab's own search (from history): the device's position, shared only rounded.
      // From a link (older links carried the sender's "my location" label): someone else's.
      if (own) source = 'device';
      else loc = { ...loc, label: SHARED_LOCATION_LABEL };
    }
    sides[key].input.value = loc.label;
    sides[key].location = Number.isFinite(loc.lat) ? { ...loc, source } : null;
  };
  for (const key of ['a', 'b']) if (state[key]) restore(key, state[key]);
  setMode('a', state.modeA);
  setMode('b', state.modeB);
  for (const { mode, ...loc } of state.extra) {
    const key = addPoint({ focus: false });
    restore(key, loc);
    setMode(key, mode);
  }
  // A search (from a link, or this tab's last one) brings its own filters;
  // otherwise the ones this browser used last time.
  const filters = state.a && state.b ? state : savedFilters();
  $('only-green-line').checked = filters.greenLine;
  $('only-shabbat-closed').checked = filters.shabbat;
  setPriority(state.priority);
  if (state.departure) {
    // A time that has passed is reset to "now" by the search, with a notice.
    departureChoice.value = 'later';
    departureInput.hidden = false;
    departureInput.value = state.departure;
  }
  updateOptionsSummary();
}

function init() {
  // Which deploy this page runs (to tell an old open tab from the current site).
  if (config.build) {
    $('app-version').textContent = `· גרסה ${String(config.build).slice(0, 7)}`;
    $('app-version').hidden = false;
  }
  // A search link opened in this tab earlier (or the search shown before a reload or
  // a return to this page) lives in history.state: the address bar is the plain site.
  const linkSearch = location.search !== new URL(plainAddress(), location.href).search ? location.search : null;
  const state = decodeState(linkSearch ?? history.state?.search ?? '', { knownCategories: CATEGORY_IDS });
  fillForm(state, { own: linkSearch === null });
  // A search link was opened: its search runs below, and the address bar goes back
  // to the plain site, so sharing the page from the browser shares the app itself.
  if (linkSearch !== null) history.replaceState({ search: linkSearch }, '', plainAddress());
  // A shared link: show its results right away, on the place it shared if any. (Not
  // inside a frame, where another site could run billed searches on visitors' behalf.)
  const canSearch = Boolean(state.a && state.b);
  if (state.snapshot && SHARE_API && !isFramed()) {
    // Stored results (a short link has only them; an older link has its search too).
    openSnapshot(state.snapshot, { pick: state.place, canSearch });
  } else if (canSearch && !isFramed()) {
    runSearch({ pick: state.place });
  } else if (!config.googleMapsApiKey || forcedProvider === 'osm') {
    updateProviderNote({ id: 'osm', attributionHtml: '' });
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // Never awaited: registration can stay pending (e.g. when service workers are blocked).
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('service worker', err));
    });
  }
}

init();
