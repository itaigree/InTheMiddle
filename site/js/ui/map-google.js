// Map view on Google Maps (used in Google mode – Google's terms require Google
// place/route content to be shown on a Google map). Same interface as map-leaflet.js.

const PIN_SIZE = 30;
const ACTIVE_PIN_SIZE = 36;
// Zooming in on a place shows its streets, and what else is around it.
const PLACE_ZOOM = 15;
// The overview's frame never shrinks below this (px), however far in the big map is.
const MIN_FRAME = 16;
// Room above a place for its pin and name bubble (px).
const BUBBLE_ROOM = 100;

function cssVar(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Marker content whose bottom-center is the tip of the pin, because Advanced
 * Markers anchor their content at the bottom-center.
 */
function pinContent(className, text, size = PIN_SIZE) {
  const tip = Math.round(size / 2 + size / Math.SQRT2);
  const wrap = document.createElement('div');
  wrap.style.cssText = `width:${size}px;height:${tip}px;position:relative;`;
  const pin = document.createElement('div');
  pin.className = `pin ${className}`;
  pin.style.cssText = `width:${size}px;height:${size}px;position:absolute;top:0;left:0;`;
  const label = document.createElement('span');
  label.textContent = text;
  pin.append(label);
  wrap.append(pin);
  return wrap;
}

/** Midpoint dot, centered on its position. */
function midContent() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:18px;height:9px;position:relative;';
  const dot = document.createElement('div');
  dot.className = 'pin pin-mid';
  dot.style.cssText = 'position:absolute;top:0;left:0;';
  wrap.append(dot);
  return wrap;
}

/** A round dot centered on its position (the overview's markers). */
function dotContent(className, size) {
  const wrap = document.createElement('div');
  wrap.style.cssText = `width:${size}px;height:${size / 2}px;position:relative;`;
  const dot = document.createElement('div');
  dot.className = `dot ${className}`;
  dot.style.cssText = `width:${size}px;height:${size}px;position:absolute;top:0;left:0;`;
  wrap.append(dot);
  return wrap;
}

/**
 * How far (px) to put a zoomed-in place below the middle of the map, so its
 * name bubble doesn't run under the overview on a short map.
 */
function overviewClearance(overview, mapHeight) {
  if (!overview) return 0;
  const wasHidden = overview.hidden;
  overview.hidden = false; // measured in the same task, so never painted
  const bottom = overview.offsetTop + overview.offsetHeight;
  overview.hidden = wasHidden;
  return Math.min(Math.max(0, bottom + BUBBLE_ROOM - mapHeight / 2), mapHeight / 4);
}

const hasError = (el) => !!el.querySelector('.gm-err-container, .gm-err-content');

/**
 * @param {HTMLElement} container
 * @param {{mapId?: string, onError?: (reason: 'auth'|'quota') => void, overview?: HTMLElement}} options
 */
export async function createGoogleMapView(container, { mapId, onError, isCancelled = () => false, overview } = {}) {
  const [{ Map: GoogleMap, Polyline, Circle, Rectangle, InfoWindow }, { AdvancedMarkerElement }, { LatLngBounds, Point }] = await Promise.all([
    google.maps.importLibrary('maps'),
    google.maps.importLibrary('marker'),
    google.maps.importLibrary('core'),
  ]);

  // Too late (the app has moved on to another map): don't touch the container.
  if (isCancelled()) throw new Error('Google map creation cancelled');
  container.replaceChildren();
  const map = new GoogleMap(container, {
    center: { lat: 31.8, lng: 35.0 },
    zoom: 8,
    mapId: mapId || 'DEMO_MAP_ID',
    colorScheme: 'FOLLOW_SYSTEM',
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
  });

  // Over-quota / key errors on the map itself don't throw; Google replaces the map
  // with an error overlay. Watch for it so the app can switch to the free maps.
  let reported = false;
  const observer = new MutationObserver(() => {
    if (!reported && hasError(container)) {
      reported = true;
      observer.disconnect();
      onError?.(window.__inthemiddleGoogleAuthFailed ? 'auth' : 'quota');
    }
  });
  observer.observe(container, { childList: true, subtree: true });

  const info = new InfoWindow({ headerDisabled: true });
  let searchOverlays = [];
  let placeMarkers = new Map();
  let activeId = null;
  let search = null;
  let places = [];
  let wholeBounds = null; // the two points and the places

  function clear(list) {
    for (const o of list) {
      if ('setMap' in o) o.setMap(null);
      else o.map = null;
    }
  }

  function marker(position, content, { title, zIndex, clickable = false, on = map } = {}) {
    return new AdvancedMarkerElement({ map: on, position, content, title, zIndex, gmpClickable: clickable });
  }

  const containsAll = (view) => view.contains(wholeBounds.getNorthEast()) && view.contains(wholeBounds.getSouthWest());

  function showAll() {
    if (wholeBounds) map.fitBounds(wholeBounds, 48);
  }

  // The small map in the corner: the whole search zoomed out, with a frame around
  // what the big map shows. It's there while the big map is zoomed in past the
  // search, and tapping it zooms back out. Made on first use: every Google map
  // is a billed map load, so a search that never zooms in costs nothing more.
  const overviewMap = overview?.querySelector('.overview-map');
  const listeners = new AbortController();
  const mapListeners = [];
  let mini = null;
  let miniItems = [];
  let frame = null;
  let miniStale = true;

  function drawMini() {
    clear(miniItems);
    miniItems = [];
    const color = cssVar('--mid', '#161616');
    const dot = (p, className, size, zIndex = 0) =>
      miniItems.push(marker({ lat: p.lat, lng: p.lng }, dotContent(className, size), { on: mini, zIndex }));
    if (search.route?.length >= 2) {
      miniItems.push(
        new Polyline({ map: mini, path: search.route, strokeColor: cssVar('--route', '#161616'), strokeOpacity: 0.5, strokeWeight: 2, clickable: false }),
      );
    }
    dot(search.midpoint, 'dot-mid', 8, 1);
    for (const p of places) if (p.id !== activeId) dot(p, 'dot-place', 6, 2);
    const active = places.find((p) => p.id === activeId);
    if (active) dot(active, 'dot-place is-active', 10, 3);
    dot(search.a, 'dot-a', 10, 4);
    dot(search.b, 'dot-b', 10, 4);
    frame = new Rectangle({
      map: mini,
      bounds: map.getBounds(),
      strokeColor: color,
      strokeOpacity: 0.9,
      strokeWeight: 1.5,
      fillColor: color,
      fillOpacity: 0.1,
      clickable: false,
    });
    miniItems.push(frame);
    miniStale = false;
  }

  /** The frame follows the big map (and stays big enough to see). */
  function moveFrame() {
    const view = map.getBounds();
    if (!frame || !view || overview.hidden) return;
    const projection = mini.getProjection?.();
    const zoom = mini.getZoom?.();
    if (!projection || zoom == null) return frame.setBounds(view);
    const scale = 2 ** zoom;
    const ne = projection.fromLatLngToPoint(view.getNorthEast());
    const sw = projection.fromLatLngToPoint(view.getSouthWest());
    // World coordinates: y grows southward.
    const [x, y] = [(ne.x + sw.x) / 2, (ne.y + sw.y) / 2];
    const halfWidth = Math.max(ne.x - sw.x, MIN_FRAME / scale) / 2;
    const halfHeight = Math.max(sw.y - ne.y, MIN_FRAME / scale) / 2;
    const corner = (dx, dy) => projection.fromPointToLatLng(new Point(x + dx, y + dy));
    frame.setBounds(new LatLngBounds(corner(-halfWidth, halfHeight), corner(halfWidth, -halfHeight)));
  }

  function updateOverview() {
    if (!overview) return;
    const view = map.getBounds();
    const zoomedIn = !!wholeBounds && !!view && !containsAll(view) && !(mini && hasError(overviewMap));
    if (!zoomedIn) {
      if (mini) overview.hidden = true;
      return;
    }
    overview.hidden = false;
    if (!mini) {
      mini = new GoogleMap(overviewMap, {
        center: view.getCenter?.() ?? { lat: 31.8, lng: 35.0 },
        zoom: 8,
        mapId: mapId || 'DEMO_MAP_ID',
        colorScheme: 'FOLLOW_SYSTEM',
        disableDefaultUI: true,
        gestureHandling: 'none',
        keyboardShortcuts: false,
        clickableIcons: false,
      });
      // Its zoom settles after fitting: then the frame's size can be worked out.
      mapListeners.push(mini.addListener('idle', moveFrame));
      overview.querySelector('.overview-button').addEventListener('click', showAll, { signal: listeners.signal });
    }
    // The whole search, and the big map's view if it wandered off it.
    const bounds = new LatLngBounds(wholeBounds.getSouthWest(), wholeBounds.getNorthEast());
    bounds.extend(view.getNorthEast());
    bounds.extend(view.getSouthWest());
    mini.fitBounds(bounds, 10);
    if (miniStale) drawMini();
    moveFrame();
  }

  if (overview) {
    mapListeners.push(map.addListener('bounds_changed', moveFrame), map.addListener('idle', updateOverview));
  }

  function setPlaceIcon(id, active) {
    const entry = placeMarkers.get(id);
    if (!entry) return;
    entry.marker.content = pinContent(`pin-place${active ? ' is-active' : ''}`, String(entry.number), active ? ACTIVE_PIN_SIZE : PIN_SIZE);
    entry.marker.zIndex = active ? 1000 : entry.number;
  }

  function popup(entry, name) {
    const el = document.createElement('div');
    el.className = 'map-popup';
    el.dir = 'rtl';
    const strong = document.createElement('strong');
    strong.textContent = name;
    el.append(strong);
    info.setContent(el);
    info.open({ map, anchor: entry.marker, shouldFocus: false });
  }

  // Resolves when the first tiles have loaded, i.e. Google accepted the key.
  const loaded = new Promise((resolve) => {
    const listener = map.addListener('tilesloaded', () => {
      listener.remove();
      resolve();
    });
  });

  return {
    kind: 'google',
    loaded,

    showSearch({ a, b, route, midpoint, radius }) {
      clear(searchOverlays);
      clear([...placeMarkers.values()].map((e) => e.marker));
      placeMarkers = new Map();
      activeId = null;
      search = { a, b, route, midpoint };
      places = [];
      miniStale = true;
      info.close();
      const color = cssVar('--mid', '#161616');
      searchOverlays = [];
      if (route?.length >= 2) {
        searchOverlays.push(
          new Polyline({ map, path: route, strokeColor: cssVar('--route', '#161616'), strokeOpacity: 0.45, strokeWeight: 4, clickable: false }),
        );
      }
      searchOverlays.push(
        new Circle({
          map,
          center: midpoint,
          radius,
          strokeColor: color,
          strokeOpacity: 0.7,
          strokeWeight: 1.5,
          fillColor: color,
          fillOpacity: 0.06,
          clickable: false,
        }),
        marker(midpoint, midContent(), { title: 'נקודת האמצע', zIndex: 1 }),
        marker({ lat: a.lat, lng: a.lng }, pinContent('pin-a', 'א'), { title: a.label, zIndex: 2000 }),
        marker({ lat: b.lat, lng: b.lng }, pinContent('pin-b', 'ב'), { title: b.label, zIndex: 2000 }),
      );
      wholeBounds = new LatLngBounds();
      wholeBounds.extend(a);
      wholeBounds.extend(b);
      map.fitBounds(wholeBounds, 48);
    },

    showPlaces(list, { numbering, onSelect }) {
      clear([...placeMarkers.values()].map((e) => e.marker));
      placeMarkers = new Map();
      activeId = null;
      places = list;
      miniStale = true;
      info.close();
      for (const place of list) {
        const number = numbering.get(place.id);
        const entry = { number, marker: null };
        entry.marker = marker({ lat: place.lat, lng: place.lng }, pinContent('pin-place', String(number)), {
          title: place.name,
          zIndex: number,
          clickable: true,
        });
        entry.marker.addEventListener('gmp-click', () => onSelect(place, { from: 'map' }));
        entry.name = place.name;
        entry.position = { lat: place.lat, lng: place.lng };
        placeMarkers.set(place.id, entry);
      }
      if (search) {
        wholeBounds = new LatLngBounds();
        wholeBounds.extend(search.a);
        wholeBounds.extend(search.b);
        for (const p of list) wholeBounds.extend({ lat: p.lat, lng: p.lng });
        // Fitting ends with 'idle', which updates the overview.
        if (list.length) map.fitBounds(wholeBounds, 48);
        else updateOverview();
      }
    },

    highlight(placeId, { focus = false } = {}) {
      if (activeId && activeId !== placeId) setPlaceIcon(activeId, false);
      activeId = placeId;
      miniStale = true;
      const entry = placeId && placeMarkers.get(placeId);
      if (!entry) return updateOverview();
      setPlaceIcon(placeId, true);
      if (focus) {
        const zoom = Math.max(map.getZoom() ?? 0, PLACE_ZOOM);
        let center = entry.position;
        const projection = map.getProjection?.();
        if (projection) {
          const shift = overviewClearance(overview, container.clientHeight) / 2 ** zoom;
          const p = projection.fromLatLngToPoint(center);
          center = projection.fromPointToLatLng(new Point(p.x, p.y - shift));
        }
        map.moveCamera({ center, zoom });
      }
      popup(entry, entry.name);
      updateOverview();
    },

    showAll,

    resize() {
      // Google Maps tracks its container size on its own.
    },

    destroy() {
      observer.disconnect();
      listeners.abort();
      for (const l of mapListeners) l.remove();
      info.close();
      clear(searchOverlays);
      clear([...placeMarkers.values()].map((e) => e.marker));
      container.replaceChildren();
      if (mini) {
        clear(miniItems);
        overviewMap.replaceChildren();
        overview.hidden = true;
      }
    },
  };
}
