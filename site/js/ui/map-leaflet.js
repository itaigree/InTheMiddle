// Map view on Leaflet + OpenStreetMap tiles, used in the free (OSM) mode.
// Same interface as map-google.js: showSearch / showPlaces / highlight / destroy.

const LEAFLET_JS = new URL('../../vendor/leaflet/leaflet.js', import.meta.url).href;
const LEAFLET_CSS = new URL('../../vendor/leaflet/leaflet.css', import.meta.url).href;

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

let leafletPromise = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = LEAFLET_CSS;
    document.head.append(css);
    const script = document.createElement('script');
    script.src = LEAFLET_JS;
    script.onload = () => resolve(window.L);
    script.onerror = () => {
      leafletPromise = null;
      reject(new Error('Leaflet failed to load'));
    };
    document.head.append(script);
  });
  return leafletPromise;
}

function pinIcon(L, className, text, size = 30) {
  const html = `<div class="pin ${className}" style="width:${size}px;height:${size}px"><span>${text}</span></div>`;
  // The pin is a rotated square; its tip sits ~size/√2 below its center.
  const tip = Math.round(size / 2 + size / Math.SQRT2);
  return L.divIcon({ className: 'pin-icon', html, iconSize: [size, size], iconAnchor: [size / 2, tip], popupAnchor: [0, -tip] });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export async function createLeafletMap(container) {
  const L = await loadLeaflet();
  const map = L.map(container, { zoomControl: true, attributionControl: true }).setView([31.8, 35.0], 8);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);

  const searchLayer = L.layerGroup().addTo(map);
  const placesLayer = L.layerGroup().addTo(map);
  const markers = new Map(); // place id -> {marker, number}
  let activeId = null;
  let lastBounds = null;

  function setMarkerIcon(id, active) {
    const entry = markers.get(id);
    if (!entry) return;
    entry.marker.setIcon(pinIcon(L, `pin-place${active ? ' is-active' : ''}`, entry.number, active ? 36 : 30));
    entry.marker.setZIndexOffset(active ? 1000 : 0);
  }

  return {
    kind: 'leaflet',

    showSearch({ a, b, route, midpoint, radius }) {
      searchLayer.clearLayers();
      placesLayer.clearLayers();
      markers.clear();
      activeId = null;
      const color = getComputedStyle(document.documentElement).getPropertyValue('--mid').trim() || '#7c3aed';
      if (route?.length >= 2) {
        L.polyline(route.map((p) => [p.lat, p.lng]), { color: '#0f766e', weight: 5, opacity: 0.55 }).addTo(searchLayer);
      }
      L.circle([midpoint.lat, midpoint.lng], {
        radius,
        color,
        weight: 1.5,
        dashArray: '6 6',
        fillColor: color,
        fillOpacity: 0.06,
        interactive: false,
      }).addTo(searchLayer);
      L.marker([midpoint.lat, midpoint.lng], {
        icon: L.divIcon({ className: 'pin-icon', html: '<div class="pin pin-mid"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        title: 'נקודת האמצע',
        keyboard: false,
      }).addTo(searchLayer);
      L.marker([a.lat, a.lng], { icon: pinIcon(L, 'pin-a', 'א'), title: a.label }).addTo(searchLayer);
      L.marker([b.lat, b.lng], { icon: pinIcon(L, 'pin-b', 'ב'), title: b.label }).addTo(searchLayer);
      lastBounds = L.latLngBounds([
        [a.lat, a.lng],
        [b.lat, b.lng],
      ]);
      map.invalidateSize();
      map.fitBounds(lastBounds, { padding: [40, 40] });
    },

    showPlaces(places, { numbering, onSelect }) {
      placesLayer.clearLayers();
      markers.clear();
      activeId = null;
      for (const place of places) {
        const number = numbering.get(place.id);
        const marker = L.marker([place.lat, place.lng], { icon: pinIcon(L, 'pin-place', number), title: place.name, riseOnHover: true });
        marker.bindPopup(`<div class="map-popup" dir="rtl"><strong>${escapeHtml(place.name)}</strong></div>`, { closeButton: false });
        marker.on('click', () => onSelect(place, { from: 'map' }));
        marker.addTo(placesLayer);
        markers.set(place.id, { marker, number });
      }
      if (places.length && lastBounds) {
        const bounds = L.latLngBounds(lastBounds.getSouthWest(), lastBounds.getNorthEast());
        for (const p of places) bounds.extend([p.lat, p.lng]);
        map.fitBounds(bounds, { padding: [40, 40] });
      }
    },

    highlight(placeId, { pan = true } = {}) {
      if (activeId && activeId !== placeId) setMarkerIcon(activeId, false);
      activeId = placeId;
      if (!placeId) return;
      setMarkerIcon(placeId, true);
      const entry = markers.get(placeId);
      if (!entry) return;
      entry.marker.openPopup();
      if (pan && !map.getBounds().pad(-0.1).contains(entry.marker.getLatLng())) {
        map.panTo(entry.marker.getLatLng());
      }
    },

    resize() {
      map.invalidateSize();
    },

    destroy() {
      map.remove();
      container.replaceChildren();
    },
  };
}
