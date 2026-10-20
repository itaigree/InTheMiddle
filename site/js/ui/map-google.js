// Map view on Google Maps (used in Google mode – Google's terms require Google
// place/route content to be shown on a Google map). Same interface as map-leaflet.js.

const PIN_SIZE = 30;
const ACTIVE_PIN_SIZE = 36;

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

/**
 * @param {HTMLElement} container
 * @param {{mapId?: string, onError?: (reason: 'auth'|'quota') => void}} options
 */
export async function createGoogleMapView(container, { mapId, onError } = {}) {
  const [{ Map: GoogleMap, Polyline, Circle, InfoWindow }, { AdvancedMarkerElement }, { LatLngBounds }] = await Promise.all([
    google.maps.importLibrary('maps'),
    google.maps.importLibrary('marker'),
    google.maps.importLibrary('core'),
  ]);

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
    if (!reported && container.querySelector('.gm-err-container, .gm-err-content')) {
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
  let baseBounds = null;

  function clear(list) {
    for (const o of list) {
      if ('setMap' in o) o.setMap(null);
      else o.map = null;
    }
  }

  function marker(position, content, { title, zIndex, clickable = false } = {}) {
    return new AdvancedMarkerElement({ map, position, content, title, zIndex, gmpClickable: clickable });
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

  return {
    kind: 'google',

    showSearch({ a, b, route, midpoint, radius }) {
      clear(searchOverlays);
      clear([...placeMarkers.values()].map((e) => e.marker));
      placeMarkers = new Map();
      activeId = null;
      info.close();
      const color = cssVar('--mid', '#7c3aed');
      searchOverlays = [];
      if (route?.length >= 2) {
        searchOverlays.push(
          new Polyline({ map, path: route, strokeColor: '#0f766e', strokeOpacity: 0.6, strokeWeight: 5, clickable: false }),
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
      baseBounds = new LatLngBounds();
      baseBounds.extend(a);
      baseBounds.extend(b);
      map.fitBounds(baseBounds, 48);
    },

    showPlaces(places, { numbering, onSelect }) {
      clear([...placeMarkers.values()].map((e) => e.marker));
      placeMarkers = new Map();
      activeId = null;
      info.close();
      for (const place of places) {
        const number = numbering.get(place.id);
        const entry = { number, marker: null };
        entry.marker = marker({ lat: place.lat, lng: place.lng }, pinContent('pin-place', String(number)), {
          title: place.name,
          zIndex: number,
          clickable: true,
        });
        entry.marker.addEventListener('gmp-click', () => onSelect(place, { from: 'map' }));
        entry.name = place.name;
        placeMarkers.set(place.id, entry);
      }
      if (places.length && baseBounds) {
        const bounds = new LatLngBounds(baseBounds.getSouthWest(), baseBounds.getNorthEast());
        for (const p of places) bounds.extend({ lat: p.lat, lng: p.lng });
        map.fitBounds(bounds, 48);
      }
    },

    highlight(placeId, { pan = true } = {}) {
      if (activeId && activeId !== placeId) setPlaceIcon(activeId, false);
      activeId = placeId;
      if (!placeId) return;
      setPlaceIcon(placeId, true);
      const entry = placeMarkers.get(placeId);
      if (!entry) return;
      popup(entry, entry.name);
      const pos = entry.marker.position;
      if (pan && pos && !map.getBounds()?.contains(pos)) map.panTo(pos);
    },

    resize() {
      // Google Maps tracks its container size on its own.
    },

    destroy() {
      observer.disconnect();
      info.close();
      clear(searchOverlays);
      clear([...placeMarkers.values()].map((e) => e.marker));
      container.replaceChildren();
    },
  };
}
