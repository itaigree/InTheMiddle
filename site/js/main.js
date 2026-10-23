// App controller: form, provider selection (Google → OpenStreetMap fallback), search and results.

import { CATEGORIES, CATEGORY_IDS, DEFAULT_CATEGORY_IDS } from './core/categories.js';
import { encodeState, decodeState } from './core/state.js';
import { loadGreenLine, beyondGreenLine } from './core/green-line.js';
import { findMiddle } from './core/search.js';
import { pickTop, rerankPlaces } from './core/ranking.js';
import { formatDistance } from './core/format.js';
import { getGoogleBlock, setGoogleBlock } from './core/availability.js';
import { ProviderUnavailableError } from './providers/errors.js';
import { attachAutocomplete } from './ui/autocomplete.js';
import { renderSummary, renderFilters, renderPlaces, setActiveCard, MAX_PHOTOS } from './ui/results.js';
import { shareOrCopy, googleMapsUrl } from './ui/links.js';

const config = window.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);

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
  'shabbat-busy':
    'שרת המקומות החינמי עמוס, ובינתיים אין לנו שעות פתיחה, אז אי אפשר לדעת אילו בתי קפה ומסעדות סגורים בשבת. כדאי לנסות שוב בעוד כמה דקות.',
};

/** What each choice of "what matters more" means, under the choices. */
const PRIORITY_HINT = {
  equal: 'זמן נסיעה כמעט שווה לשני הצדדים, גם אם שניהם נוסעים יותר.',
  balanced: 'זמן דומה לשני הצדדים, בלי להאריך את הדרך.',
  gap: 'מותר פער גדול יותר בזמני הנסיעה בין שני הצדדים, בשביל מקום קרוב יותר.',
};

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
/** A link to that search (the share button's; the address bar stays the plain site). */
let shownLink = null;
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

const sides = {
  a: { input: $('input-a'), list: $('list-a'), location: null, ac: null, pending: null, selection: null, geo: null },
  b: { input: $('input-b'), list: $('list-b'), location: null, ac: null, pending: null, selection: null, geo: null },
};

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
  $('priority-hint').textContent = PRIORITY_HINT[getPriority()];
}

/**
 * A new priority re-sorts the results on screen right away: the travel times
 * are known, only the order changes (no new searches).
 */
function priorityChanged() {
  const priority = getPriority();
  $('priority-hint').textContent = PRIORITY_HINT[priority];
  if (!lastResult || !lastQuery) return;
  lastQuery = { ...lastQuery, priority };
  if (shownRequest) shownRequest = { ...shownRequest, priority };
  lastResult.priority = priority;
  lastResult.places = rerankPlaces(lastResult.places, { preferOpen: !lastResult.departure, priority });
  shownLink = searchLink(lastQuery);
  history.replaceState({ search: searchLink(lastQuery, { own: true }) }, '');
  renderSummary($('results-summary'), lastResult);
  renderList();
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
      span.textContent = cat.label;
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

for (const key of ['a', 'b']) {
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
}

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

document.querySelectorAll('.locate').forEach((button) => {
  button.addEventListener('click', () => {
    const key = button.dataset.side;
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
        hideStatus();
      },
      () => {
        if (!done()) return;
        showStatus('error', 'לא הצלחנו לקבל את המיקום שלך. אפשר לבדוק שהרשאת המיקום מופעלת, או פשוט להקליד כתובת.');
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 },
    );
  });
});

document.querySelectorAll('.locate').forEach((button) => {
  // Clear the spinner when its side's request is invalidated.
  const side = sides[button.dataset.side];
  side.input.addEventListener('input', () => button.classList.remove('is-busy'));
});

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
    setMode(key, from.mode);
  }
  document.querySelectorAll('.locate').forEach((button) => button.classList.remove('is-busy'));
});

const departureChoice = $('departure-choice');
const departureInput = $('departure');

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

departureChoice.addEventListener('change', () => {
  const later = departureChoice.value === 'later';
  departureInput.hidden = !later;
  if (later) {
    const now = new Date();
    departureInput.min = toLocalInputValue(now);
    // Fill a sensible default when empty or when the old value has already passed.
    if (!departureInput.value || new Date(departureInput.value) < now) {
      const soon = new Date(now.getTime() + 60 * 60 * 1000);
      soon.setMinutes(Math.ceil(soon.getMinutes() / 15) * 15, 0, 0);
      departureInput.value = toLocalInputValue(soon);
    }
    departureInput.focus();
  }
});

/** {date: Date|null, past: boolean} – a past time means "now" to the routing services. */
function departureValue() {
  if (departureChoice.value !== 'later' || !departureInput.value) return { date: null, past: false };
  const date = new Date(departureInput.value);
  if (Number.isNaN(date.getTime())) return { date: null, past: false };
  // A minute or two of slack: a time picked "just now" shouldn't count as past.
  if (date.getTime() < Date.now() - 2 * 60 * 1000) return { date: null, past: true };
  return { date: date < new Date() ? null : date, past: false };
}

function resetDepartureToNow() {
  departureChoice.value = 'now';
  departureInput.hidden = true;
}

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
  for (const [key, name] of [
    ['a', 'א׳'],
    ['b', 'ב׳'],
  ]) {
    if (!sides[key].input.value.trim()) {
      sides[key].input.setAttribute('aria-invalid', 'true');
      problems.push(`חסרה נקודת יציאה ${name}.`);
    }
  }
  if (!selectedCategories().length) problems.push('צריך לבחור לפחות סוג מקום אחד.');
  return problems;
}

let searching = false;

function setBusy(busy, { background = false } = {}) {
  searching = busy;
  const button = $('submit');
  // A re-run the user didn't ask for leaves the button on: a search they start replaces it.
  button.disabled = busy && !background;
  button.textContent = button.disabled ? 'מחפשים…' : 'מצאו לנו מקום באמצע';
}

/**
 * Run a search from the form, or re-run `request` (an earlier one) after the
 * provider changed.
 */
async function runSearch({ request = null, redo = false, background = false } = {}) {
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
    await Promise.all([sides.a.pending, sides.b.pending]);
    if (seq !== searchSeq) return;
    request = readForm();
    if (request.departurePast) resetDepartureToNow();
  }
  const failuresBefore = googleFailures;
  setBusy(true, { background });
  const quiet = () => background && showingError();
  if (!quiet()) showStatus('progress', PROGRESS_TEXT.geocode);
  const progress = (step) => {
    if (seq === searchSeq && PROGRESS_TEXT[step] && !quiet()) showStatus('progress', PROGRESS_TEXT[step]);
  };

  try {
    const result = await withProvider(async (provider) => {
      const greenLineAreas = request.greenLine ? loadGreenLine().catch(greenLineFailed) : null;
      greenLineAreas?.catch(() => {});
      const [a, b] = await Promise.all([resolveEndpoint(request.a, provider), resolveEndpoint(request.b, provider)]);
      if (seq !== searchSeq) return null;
      const missing = [];
      for (const [key, loc] of [
        ['a', a],
        ['b', b],
      ]) {
        if (!loc) missing.push([key, request[key].text]);
        // Remember the coordinates while the field still says the same thing, and the
        // user hasn't given it other coordinates since (e.g. "my location" again).
        else if (sides[key].input.value.trim() === request[key].text && sides[key].location === request[key].location) {
          sides[key].location = loc;
        }
      }
      if (missing.length) {
        for (const [key, text] of missing) {
          // Not when the field says something else by now (e.g. a re-run while typing).
          if (sides[key].input.value.trim() === text) sides[key].input.setAttribute('aria-invalid', 'true');
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
      const query = {
        a,
        b,
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
      const res = await findMiddle(query, provider, { onProgress: progress });
      // Google results need a Google map; if it can't load, redo the search on OSM.
      if (mapReady) await mapReady;
      return { res, provider, query, dropped };
    });
    if (!result || seq !== searchSeq) return;
    // Google failed in this page while the search was running (e.g. the map showed
    // its error screen late): its results would sit on a broken map, so redo it.
    // (A block recorded by another tab doesn't make this tab's results wrong.)
    if (result.provider.id === 'google' && googleFailures !== failuresBefore && !redo) {
      return await runSearch({ request, redo: true, background });
    }
    if (request.departurePast) result.res.notices.unshift('departure-past');
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
    shownLink = searchLink(result.query);
    // A reload (or coming back to this page) shows this search again; the address bar stays as it is.
    history.replaceState({ search: searchLink(result.query, { own: true }) }, '');
    // A re-run doesn't scroll away from a field the user is typing in, or to an error it leaves on screen.
    const typing = [sides.a.input, sides.b.input].includes(document.activeElement);
    await showResult(result.res, result.provider, { scroll: !(background && (typing || quiet())), status: !quiet() });
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

/** A link to the search (`own`: only for this tab's history, so "my location" stays as it is). */
function searchLink(query, { own = false } = {}) {
  const qs = encodeState({
    a: forLink(query.a, { own }),
    b: forLink(query.b, { own }),
    modeA: query.modeA,
    modeB: query.modeB,
    categories: query.categories,
    departure: query.departure ? toLocalInputValue(query.departure) : null,
    greenLine: query.greenLine,
    shabbat: query.shabbat,
    priority: query.priority,
    provider: forcedProvider,
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
    numbering,
    photoIds,
    showOpenState: !lastResult.departure,
    onSelect: selectPlace,
    onShare: sharePlace,
  });
  onMap((map) => map.showPlaces(places, { numbering, onSelect: selectPlace }));
}

async function showResult(result, provider, { scroll = true, status = true } = {}) {
  lastResult = result;
  shownProvider = provider;
  activeFilter = 'all';
  // Photos are billed per image: allow them for the first few places of this
  // result only, however the list is filtered later.
  photoIds = new Set(displayedPlaces().slice(0, MAX_PHOTOS).map((p) => p.id));
  updateProviderNote(provider);

  const notices = result.notices.map((n) => (typeof NOTICE_TEXT[n] === 'function' ? NOTICE_TEXT[n](result) : NOTICE_TEXT[n])).filter(Boolean);
  if (provider.id !== 'google' && switchBlock && SWITCH_REASON_TEXT[switchBlock.reason]) {
    notices.unshift(SWITCH_REASON_TEXT[switchBlock.reason]);
  }
  if (!status) {
    // Leave what the status says (an error the user is reading).
  } else if (notices.length === 1) showStatus('info', notices[0]);
  else if (notices.length > 1) showStatus('info', 'כמה דברים שכדאי לדעת:', notices);
  else hideStatus();

  // The list doesn't wait for the map (a slow map script must not hide results).
  $('results').hidden = false;
  renderSummary($('results-summary'), result);
  renderList();

  // Show the map box right away (it fills in when the map is ready), so the
  // phone layout has something to scroll to on the first search.
  document.body.classList.add('has-map');
  if (scroll && window.matchMedia('(max-width: 959px)').matches) {
    // A notice explains the results, so show it first; otherwise go to the map.
    const target = notices.length ? $('status') : document.querySelector('.map-wrap');
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  await drawOnMap(result, provider);
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

function selectPlace(place, { from }) {
  // A place picked from the list is zoomed in on (with the whole search in the
  // corner); one picked on the map stays where the user is looking.
  onMap((map) => map.highlight(place.id, { focus: from === 'list' }));
  setActiveCard($('place-list'), place.id, { scroll: from === 'map' });
  // On phones the map can be far above the tapped card: bring it into view.
  if (from === 'list' && window.matchMedia('(max-width: 959px)').matches) {
    document.querySelector('.map-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

async function sharePlace(place) {
  const outcome = await shareOrCopy({
    title: place.name,
    text: `נפגשים באמצע? מה דעתך על ${place.name}`,
    url: googleMapsUrl(place),
  });
  if (outcome === 'copied') toast('הקישור הועתק');
  else if (outcome === 'failed') toast('לא הצלחנו לשתף');
}

$('share-search').addEventListener('click', async () => {
  const label = (loc) => forLink(loc).label;
  const outcome = await shareOrCopy({
    title: 'מקום באמצע',
    text: lastQuery ? `מקומות באמצע הדרך בין ${label(lastQuery.a)} לבין ${label(lastQuery.b)}` : 'מקום באמצע',
    url: shownLink || `${location.origin}${plainAddress()}`,
  });
  if (outcome === 'copied') toast('הקישור לחיפוש הועתק');
  else if (outcome === 'failed') toast('לא הצלחנו לשתף');
});

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sides.a.ac.cancel();
  sides.b.ac.cancel();
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

function init() {
  // A search link opened in this tab earlier (or the search shown before a reload or
  // a return to this page) lives in history.state: the address bar is the plain site.
  const linkSearch = location.search !== new URL(plainAddress(), location.href).search ? location.search : null;
  const state = decodeState(linkSearch ?? history.state?.search ?? '', { knownCategories: CATEGORY_IDS });
  renderCategoryChips(state.categories || DEFAULT_CATEGORY_IDS);
  for (const key of ['a', 'b']) {
    let loc = state[key];
    if (!loc) continue;
    let source = 'link';
    if (loc.label === MY_LOCATION_LABEL) {
      // This tab's own search (from history): the device's position, shared only rounded.
      // From a link (older links carried the sender's "my location" label): someone else's.
      if (linkSearch === null) source = 'device';
      else loc = { ...loc, label: SHARED_LOCATION_LABEL };
    }
    sides[key].input.value = loc.label;
    sides[key].location = Number.isFinite(loc.lat) ? { ...loc, source } : null;
  }
  setMode('a', state.modeA);
  setMode('b', state.modeB);
  $('only-green-line').checked = state.greenLine;
  $('only-shabbat-closed').checked = state.shabbat;
  setPriority(state.priority);
  if (state.departure) {
    // A time that has passed is reset to "now" by the search, with a notice.
    departureChoice.value = 'later';
    departureInput.hidden = false;
    departureInput.value = state.departure;
  }
  // A search link was opened: its search runs below, and the address bar goes back
  // to the plain site, so sharing the page from the browser shares the app itself.
  if (linkSearch !== null) history.replaceState({ search: linkSearch }, '', plainAddress());
  if (state.a && state.b && !isFramed()) {
    // A shared link: show its results right away. (Not inside a frame, where
    // another site could run billed searches on visitors' behalf.)
    runSearch();
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
