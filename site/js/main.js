// App controller: form, provider selection (Google → OpenStreetMap fallback), search and results.

import { CATEGORIES, CATEGORY_IDS, DEFAULT_CATEGORY_IDS } from './core/categories.js';
import { encodeState, decodeState } from './core/state.js';
import { findMiddle } from './core/search.js';
import { pickTop } from './core/ranking.js';
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
  times: 'בודקים כמה זמן לוקח להגיע לכל מקום…',
};

const NOTICE_TEXT = {
  'transit-unsupported':
    'במפות החינמיות אין חישוב של תחבורה ציבורית, ולכן חישבנו את זמני ההגעה לפי נסיעה ברכב.',
  'transit-no-service':
    'לא מצאנו תחבורה ציבורית בזמן היציאה שנבחר (אולי שבת, חג או שעת לילה), ולכן חישבנו את הצד הזה לפי נסיעה ברכב.',
  'transit-error': 'לא הצלחנו לחשב כרגע זמני תחבורה ציבורית, ולכן חישבנו את הצד הזה לפי נסיעה ברכב.',
  'departure-past': 'זמן היציאה שנבחר כבר עבר, אז חיפשנו לפי יציאה עכשיו.',
};

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
let loadedProviderId = null;
/** Why (and until when) this page stopped using Google: {reason, until: ms}. */
let switchBlock = null;
let currentMap = null;
let mapPromise = null;
let mapKind = null;
/** The last search as the user asked for it (texts, modes…), to re-run after a provider switch. */
let lastRequest = null;
/** The search whose results are on screen, with resolved coordinates, for sharing. */
let lastQuery = null;
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
  // The cached provider must follow the current verdict: back on Google once a
  // block has expired, and off Google as soon as one is in force (even if another
  // tab recorded it).
  if (providerPromise && loadedProviderId === 'osm' && googleWanted()) providerPromise = null;
  if (providerPromise && loadedProviderId === 'google' && !googleWanted()) {
    providerPromise = null;
    loadedProviderId = null;
  }
  if (!providerPromise) {
    providerPromise = loadProvider().catch((err) => {
      providerPromise = null;
      throw err;
    });
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
      loadedProviderId = provider.id;
      return provider;
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError)) console.error(err);
      markGoogleUnavailable(err);
    }
  }
  const { createOsmProvider } = await import('./providers/osm.js');
  const provider = createOsmProvider();
  await provider.ready?.();
  loadedProviderId = provider.id;
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
    updateProviderNote(fallback);
    return fn(fallback);
  }
}

/** Google reported a failure outside a call we made (e.g. key rejected while drawing the map). */
function handleGoogleUnavailable(err) {
  if (loadedProviderId !== 'google') return;
  markGoogleUnavailable(err);
  providerPromise = null;
  getProvider()
    .then((p) => {
      updateProviderNote(p);
      // A search in progress falls back by itself; otherwise redo the last one.
      if (lastRequest && !searching) runSearch({ request: lastRequest });
    })
    .catch((loadErr) => {
      console.error(loadErr);
      showStatus('error', 'לא הצלחנו לטעון את המפות. כדאי לבדוק את החיבור לאינטרנט ולנסות שוב.');
    });
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
      span.textContent = `${cat.emoji} ${cat.label}`;
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

function setBusy(busy) {
  searching = busy;
  const button = $('submit');
  button.disabled = busy;
  button.textContent = busy ? 'מחפשים…' : 'מצאו לנו מקום באמצע';
}

/**
 * Run a search from the form, or re-run `request` (an earlier one) after the
 * provider changed.
 */
async function runSearch({ request = null, redo = false } = {}) {
  const seq = ++searchSeq;
  if (!request) {
    const problems = validateForm();
    if (problems.length) {
      showStatus('error', problems.join(' '));
      return;
    }
    setBusy(true);
    showStatus('progress', PROGRESS_TEXT.geocode);
    // A suggestion picked a moment ago may still be resolving: use it, don't re-geocode.
    await Promise.all([sides.a.pending, sides.b.pending]);
    if (seq !== searchSeq) return;
    request = readForm();
    if (request.departurePast) resetDepartureToNow();
  }
  lastRequest = request;
  setBusy(true);
  showStatus('progress', PROGRESS_TEXT.geocode);
  const progress = (step) => {
    if (seq === searchSeq && PROGRESS_TEXT[step]) showStatus('progress', PROGRESS_TEXT[step]);
  };

  try {
    const result = await withProvider(async (provider) => {
      // Load the Google map right away: it's needed anyway, and it is when Google
      // reports a rejected Maps key – before the billed place searches run.
      const mapReady = provider.id === 'google' ? ensureMap(provider) : null;
      mapReady?.catch(() => {});
      const [a, b] = await Promise.all([resolveEndpoint(request.a, provider), resolveEndpoint(request.b, provider)]);
      if (seq !== searchSeq) return null;
      const missing = [];
      for (const [key, loc] of [
        ['a', a],
        ['b', b],
      ]) {
        if (!loc) missing.push([key, request[key].text]);
        // Remember the coordinates while the field still says the same thing.
        else if (sides[key].input.value.trim() === request[key].text) sides[key].location = loc;
      }
      if (missing.length) {
        for (const [key] of missing) sides[key].input.setAttribute('aria-invalid', 'true');
        const err = new Error('not found');
        err.userMessage = `לא הצלחנו למצוא את ${missing.map(([, t]) => `„${t}”`).join(' ואת ')}. אפשר לנסות לכתוב אחרת או לבחור מהרשימה שנפתחת בזמן ההקלדה.`;
        throw err;
      }
      const query = {
        a,
        b,
        modeA: request.modeA,
        modeB: request.modeB,
        categories: request.categories,
        departure: request.departure,
      };
      const res = await findMiddle(query, provider, { onProgress: progress });
      // Google results need a Google map; if it can't load, redo the search on OSM.
      if (mapReady) await mapReady;
      return { res, provider, query };
    });
    if (!result || seq !== searchSeq) return;
    // Google failed while this search was running (e.g. the map showed its error
    // screen late): its results would sit on a broken Google map, so redo it.
    if (result.provider.id === 'google' && !googleWanted() && !redo) {
      return await runSearch({ request, redo: true });
    }
    if (request.departurePast) result.res.notices.unshift('departure-past');
    lastQuery = result.query;
    updateUrl(result.query);
    await showResult(result.res, result.provider);
  } catch (err) {
    if (seq !== searchSeq) return;
    console.error(err);
    showStatus('error', err.userMessage || 'משהו השתבש בחיפוש. כדאי לנסות שוב בעוד רגע.');
  } finally {
    if (seq === searchSeq) setBusy(false);
  }
}

/** How an endpoint appears in a shared link. */
function forLink(loc) {
  // Google-derived coordinates stay out of links (they'd end up on other maps).
  if (loc.source === 'google') return { label: loc.label };
  // The sender's own position: neutral label, ~100 m precision (not their doorstep).
  if (loc.source === 'device') {
    const round = (x) => Math.round(x * 1e3) / 1e3;
    return { label: SHARED_LOCATION_LABEL, lat: round(loc.lat), lng: round(loc.lng) };
  }
  return loc;
}

function updateUrl(query) {
  const qs = encodeState({
    a: forLink(query.a),
    b: forLink(query.b),
    modeA: query.modeA,
    modeB: query.modeB,
    categories: query.categories,
    departure: query.departure ? toLocalInputValue(query.departure) : null,
    provider: forcedProvider,
  });
  history.replaceState(null, '', `${location.pathname}?${qs}`);
}

/** The map view for `provider`'s kind, created once (concurrent callers share it). */
function ensureMap(provider) {
  const wanted = provider.id === 'google' ? 'google' : 'leaflet';
  if (mapPromise && mapKind === wanted) return mapPromise;
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
    const map = await provider.createMap($('map'));
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

async function showResult(result, provider) {
  lastResult = result;
  activeFilter = 'all';
  // Photos are billed per image: allow them for the first few places of this
  // result only, however the list is filtered later.
  photoIds = new Set(displayedPlaces().slice(0, MAX_PHOTOS).map((p) => p.id));
  updateProviderNote(provider);

  const notices = result.notices.map((n) => NOTICE_TEXT[n]).filter(Boolean);
  if (provider.id !== 'google' && switchBlock && SWITCH_REASON_TEXT[switchBlock.reason]) {
    notices.unshift(SWITCH_REASON_TEXT[switchBlock.reason]);
  }
  if (notices.length === 1) showStatus('info', notices[0]);
  else if (notices.length > 1) showStatus('info', 'כמה דברים שכדאי לדעת:', notices);
  else hideStatus();

  // The list doesn't wait for the map (a slow map script must not hide results).
  $('results').hidden = false;
  renderSummary($('results-summary'), result);
  renderList();

  // Show the map box right away (it fills in when the map is ready), so the
  // phone layout has something to scroll to on the first search.
  document.body.classList.add('has-map');
  if (window.matchMedia('(max-width: 959px)').matches) {
    // A notice explains the results, so show it first; otherwise go to the map.
    const target = notices.length ? $('status') : document.querySelector('.map-wrap');
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

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
  onMap((map) => map.highlight(place.id, { pan: from === 'list' }));
  setActiveCard($('place-list'), place.id, { scroll: from === 'map' });
  // On phones the map can be far above the tapped card: bring it into view.
  if (from === 'list' && window.matchMedia('(max-width: 959px)').matches) {
    document.querySelector('.map-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

async function sharePlace(place) {
  const mode = lastResult && lastResult.modeA === lastResult.modeB ? lastResult.modeA : undefined;
  const outcome = await shareOrCopy({
    title: place.name,
    text: `נפגשים באמצע? מה דעתך על ${place.name}`,
    url: googleMapsUrl(place, { mode }),
  });
  if (outcome === 'copied') toast('הקישור הועתק');
  else if (outcome === 'failed') toast('לא הצלחנו לשתף');
}

$('share-search').addEventListener('click', async () => {
  const label = (loc) => forLink(loc).label;
  const outcome = await shareOrCopy({
    title: 'מקום באמצע',
    text: lastQuery ? `מקומות באמצע הדרך בין ${label(lastQuery.a)} לבין ${label(lastQuery.b)}` : 'מקום באמצע',
    url: location.href,
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
  const state = decodeState(location.search, { knownCategories: CATEGORY_IDS });
  renderCategoryChips(state.categories || DEFAULT_CATEGORY_IDS);
  for (const key of ['a', 'b']) {
    let loc = state[key];
    if (!loc) continue;
    // Older links carried the sender's "my location" label.
    if (loc.label === MY_LOCATION_LABEL) loc = { ...loc, label: SHARED_LOCATION_LABEL };
    sides[key].input.value = loc.label;
    sides[key].location = Number.isFinite(loc.lat) ? { ...loc, source: 'link' } : null;
  }
  setMode('a', state.modeA);
  setMode('b', state.modeB);
  if (state.departure) {
    // A time that has passed is reset to "now" by the search, with a notice.
    departureChoice.value = 'later';
    departureInput.hidden = false;
    departureInput.value = state.departure;
  }
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
