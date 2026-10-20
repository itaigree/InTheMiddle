// App controller: form, provider selection (Google → OpenStreetMap fallback), search and results.

import { CATEGORIES, CATEGORY_IDS, DEFAULT_CATEGORY_IDS } from './core/categories.js';
import { encodeState, decodeState } from './core/state.js';
import { findMiddle } from './core/search.js';
import { pickTop } from './core/ranking.js';
import { getGoogleBlock, setGoogleBlock } from './core/availability.js';
import { ProviderUnavailableError } from './providers/errors.js';
import { attachAutocomplete } from './ui/autocomplete.js';
import { renderSummary, renderFilters, renderPlaces, setActiveCard } from './ui/results.js';
import { shareOrCopy, googleMapsUrl } from './ui/links.js';

const config = window.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);

const RESULTS_LIMIT = 20;
const MY_LOCATION_LABEL = 'המיקום שלי';

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
};

const SWITCH_REASON_TEXT = {
  quota: 'המכסה החינמית היומית של Google נגמרה, אז עברנו למפות החינמיות של OpenStreetMap. מחר נחזור ל-Google.',
  auth: 'יש בעיה בהגדרות המפתח של Google, אז עברנו בינתיים למפות החינמיות של OpenStreetMap.',
  'load-failed': 'לא הצלחנו להתחבר ל-Google Maps, אז עברנו למפות החינמיות של OpenStreetMap.',
};

const forcedProvider = decodeState(location.search).provider;

// ---------------------------------------------------------------- providers

let providerPromise = null;
let switchReason = null;
let currentMap = null;
/** The last search as the user asked for it (texts, modes…), to re-run after a provider switch. */
let lastRequest = null;
/** The last search with resolved coordinates, for sharing. */
let lastQuery = null;
/** Attribution line under autocomplete suggestions, for the provider that served them. */
let suggestFooter = '';

function googleWanted() {
  return Boolean(config.googleMapsApiKey) && forcedProvider !== 'osm' && !switchReason && !getGoogleBlock();
}

function getProvider() {
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
      return provider;
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
  if (reason !== 'not-configured') setGoogleBlock(reason);
  switchReason = reason;
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
  if (switchReason) return;
  markGoogleUnavailable(err);
  providerPromise = null;
  getProvider().then((p) => {
    updateProviderNote(p);
    if (lastRequest) runSearch({ request: lastRequest });
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
  a: { input: $('input-a'), list: $('list-a'), location: null, ac: null },
  b: { input: $('input-b'), list: $('list-b'), location: null, ac: null },
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
    onSelect: async (suggestion) => {
      side.input.removeAttribute('aria-invalid');
      try {
        const location = await suggestion.resolve();
        // Ignore if the user kept typing while we resolved the suggestion.
        if (side.input.value === suggestion.title && location) side.location = { ...location, label: suggestion.title };
      } catch (err) {
        console.warn('could not resolve suggestion', err);
        side.location = null;
      }
    },
    onEdit: () => {
      side.location = null;
      side.input.removeAttribute('aria-invalid');
    },
    footer: () => suggestFooter,
  });
  // Start loading the provider's SDK as soon as the user shows intent.
  side.input.addEventListener('focus', () => getProvider().catch(() => {}), { once: true });
}

document.querySelectorAll('.locate').forEach((button) => {
  button.addEventListener('click', () => {
    const key = button.dataset.side;
    if (!navigator.geolocation) {
      showStatus('error', 'הדפדפן הזה לא תומך באיתור מיקום.');
      return;
    }
    button.classList.add('is-busy');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        button.classList.remove('is-busy');
        sides[key].ac.cancel();
        setSideLocation(key, {
          label: MY_LOCATION_LABEL,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          source: 'device',
        });
        hideStatus();
      },
      () => {
        button.classList.remove('is-busy');
        showStatus('error', 'לא הצלחנו לקבל את המיקום שלך. אפשר לבדוק שהרשאת המיקום מופעלת, או פשוט להקליד כתובת.');
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 },
    );
  });
});

$('swap').addEventListener('click', () => {
  const locA = sides.a.location;
  const textA = sides.a.input.value;
  const modeA = getMode('a');
  sides.a.location = sides.b.location;
  sides.a.input.value = sides.b.input.value;
  setMode('a', getMode('b'));
  sides.b.location = locA;
  sides.b.input.value = textA;
  setMode('b', modeA);
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
    if (!departureInput.value) {
      const soon = new Date(now.getTime() + 60 * 60 * 1000);
      soon.setMinutes(Math.ceil(soon.getMinutes() / 15) * 15, 0, 0);
      departureInput.value = toLocalInputValue(soon);
    }
    departureInput.focus();
  }
});

function departureValue() {
  if (departureChoice.value !== 'later' || !departureInput.value) return null;
  const date = new Date(departureInput.value);
  // A time in the past means "now" to the routing services.
  return Number.isNaN(date.getTime()) || date < new Date() ? null : date;
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

/** What the user asked for, independent of any provider. */
function readForm() {
  const endpoint = (key) => ({ text: sides[key].input.value.trim(), location: sides[key].location });
  return {
    a: endpoint('a'),
    b: endpoint('b'),
    modeA: getMode('a'),
    modeB: getMode('b'),
    categories: selectedCategories(),
    departure: departureValue(),
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

function setBusy(busy) {
  const button = $('submit');
  button.disabled = busy;
  button.textContent = busy ? 'מחפשים…' : 'מצאו לנו מקום באמצע';
}

/**
 * Run a search from the form, or re-run `request` (an earlier one) after the
 * provider changed.
 */
async function runSearch({ request = null } = {}) {
  const seq = ++searchSeq;
  if (!request) {
    const problems = validateForm();
    if (problems.length) {
      showStatus('error', problems.join(' '));
      return;
    }
    request = readForm();
  }
  lastRequest = request;
  setBusy(true);
  showStatus('progress', PROGRESS_TEXT.geocode);
  const progress = (step) => {
    if (seq === searchSeq && PROGRESS_TEXT[step]) showStatus('progress', PROGRESS_TEXT[step]);
  };

  try {
    const result = await withProvider(async (provider) => {
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
      lastQuery = query;
      updateUrl(query);
      const res = await findMiddle(query, provider, { onProgress: progress });
      return { res, provider };
    });
    if (!result || seq !== searchSeq) return;
    await showResult(result.res, result.provider);
  } catch (err) {
    if (seq !== searchSeq) return;
    console.error(err);
    showStatus('error', err.userMessage || 'משהו השתבש בחיפוש. כדאי לנסות שוב בעוד רגע.');
  } finally {
    if (seq === searchSeq) setBusy(false);
  }
}

function updateUrl(query) {
  // Google-derived coordinates stay out of shared links (they'd end up on other maps).
  const forLink = (loc) => (loc.source === 'google' ? { label: loc.label } : loc);
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

async function ensureMap(provider) {
  const wanted = provider.id === 'google' ? 'google' : 'leaflet';
  if (currentMap?.kind === wanted) return currentMap;
  currentMap?.destroy();
  currentMap = null;
  currentMap = await provider.createMap($('map'));
  document.body.classList.add('has-map');
  return currentMap;
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
  renderFilters($('result-filters'), lastResult.places, activeFilter, (id) => {
    activeFilter = id;
    renderList();
  });
  renderPlaces($('place-list'), $('place-card-template'), places, {
    modeA: lastResult.modeA,
    modeB: lastResult.modeB,
    numbering,
    showOpenState: !lastResult.departure,
    onSelect: selectPlace,
    onShare: sharePlace,
  });
  currentMap?.showPlaces(places, { numbering, onSelect: selectPlace });
}

async function showResult(result, provider) {
  lastResult = result;
  activeFilter = 'all';
  updateProviderNote(provider);

  const notices = result.notices.map((n) => NOTICE_TEXT[n]).filter(Boolean);
  if (provider.id !== 'google' && switchReason && SWITCH_REASON_TEXT[switchReason]) {
    notices.unshift(SWITCH_REASON_TEXT[switchReason]);
  }
  if (notices.length === 1) showStatus('info', notices[0]);
  else if (notices.length > 1) showStatus('info', 'כמה דברים שכדאי לדעת:', notices);
  else hideStatus();

  try {
    const map = await ensureMap(provider);
    map.showSearch(result);
  } catch (err) {
    console.error('map failed', err);
  }
  $('results').hidden = false;
  renderSummary($('results-summary'), result);
  renderList();

  if (window.matchMedia('(max-width: 959px)').matches) {
    document.querySelector('.map-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function selectPlace(place, { from }) {
  currentMap?.highlight(place.id, { pan: from === 'list' });
  setActiveCard($('place-list'), place.id, { scroll: from === 'map' });
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
  const outcome = await shareOrCopy({
    title: 'מקום באמצע',
    text: lastQuery ? `מקומות באמצע הדרך בין ${lastQuery.a.label} לבין ${lastQuery.b.label}` : 'מקום באמצע',
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

function init() {
  const state = decodeState(location.search, { knownCategories: CATEGORY_IDS });
  renderCategoryChips(state.categories || DEFAULT_CATEGORY_IDS);
  for (const key of ['a', 'b']) {
    const loc = state[key];
    if (!loc) continue;
    sides[key].input.value = loc.label;
    sides[key].location = Number.isFinite(loc.lat) ? { ...loc, source: 'link' } : null;
  }
  setMode('a', state.modeA);
  setMode('b', state.modeB);
  if (state.departure && new Date(state.departure) > new Date()) {
    departureChoice.value = 'later';
    departureInput.hidden = false;
    departureInput.value = state.departure;
  }
  if (state.a && state.b) {
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
