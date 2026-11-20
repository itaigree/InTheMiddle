// Map view on Leaflet + OpenStreetMap tiles, used in the free (OSM) mode.
// Same interface as map-google.js: showSearch / showPlaces / highlight / destroy.

import { categoryIconMarkup } from './category-icons.js';
import { splitAtNearest } from '../core/geo.js';

const LEAFLET_JS = new URL('../../vendor/leaflet/leaflet.js', import.meta.url).href;
const LEAFLET_CSS = new URL('../../vendor/leaflet/leaflet.css', import.meta.url).href;

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

// Zooming in on a place shows its streets, and what else is around it.
const PLACE_ZOOM = 15;
// The overview's frame never shrinks below this (px), however far in the big map is.
const MIN_FRAME = 16;
// Room above a place for its pin and name bubble (px).
const BUBBLE_ROOM = 100;

/** The starting points' letters, and their pins' and dots' colour classes: א, ב, then a group's extra ones. */
const LETTERS = ['א', 'ב', 'ג', 'ד', 'ה'];
const sideKind = (i) => (i === 0 ? 'a' : i === 1 ? 'b' : 'extra');
/** Each starting point's line colour (a group's extra ones in ink). */
const SIDE_COLOR = { a: '--side-a', b: '--side-b', extra: '--mid' };

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

/** A place: a station in its category's colour, centered on its position, with its number. */
function stationIcon(L, category, number, active) {
  const size = active ? 40 : 32;
  const html = `<div class="pin pin-place${active ? ' is-active' : ''}" data-category="${category}" style="width:${size}px;height:${size}px">${categoryIconMarkup(category)}<span>${number}</span></div>`;
  return L.divIcon({ className: 'pin-icon', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
}

/** A round dot centered on its position (the overview's markers). */
function dotIcon(L, className, size) {
  return L.divIcon({ className: 'pin-icon', html: `<div class="dot ${className}"></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
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

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export async function createLeafletMap(container, { overview } = {}) {
  const L = await loadLeaflet();
  const map = L.map(container, { zoomControl: true, attributionControl: true }).setView([31.8, 35.0], 8);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);

  const searchLayer = L.layerGroup().addTo(map);
  // The picked place's two legs, from א and to ב, over the route.
  const legsLayer = L.layerGroup().addTo(map);
  const placesLayer = L.layerGroup().addTo(map);
  let routeLines = [];
  const markers = new Map(); // place id -> {marker, number}
  let activeId = null;
  let search = null;
  let places = [];
  let wholeBounds = null; // the starting points and the places
  const css = () => getComputedStyle(document.documentElement);

  /**
   * The picked place's legs: straight, from א in its blue and on to ב in its orange;
   * the route dims under them. A group: a leg from everyone, each in its colour.
   */
  function drawLegs(place) {
    legsLayer.clearLayers();
    for (const line of routeLines) line.setStyle({ opacity: place ? 0.3 : 0.85 });
    if (!place || !search) return;
    const leg = (from, to, name) =>
      L.polyline([from, to], { color: css().getPropertyValue(name).trim(), weight: 4, opacity: 1, dashArray: '1 9', lineCap: 'round', interactive: false }).addTo(legsLayer);
    const [a, b, ...more] = search.points;
    leg([a.lat, a.lng], place, '--side-a');
    leg(place, [b.lat, b.lng], '--side-b');
    more.forEach((p) => leg([p.lat, p.lng], place, SIDE_COLOR.extra));
  }

  function setMarkerIcon(id, active) {
    const entry = markers.get(id);
    if (!entry) return;
    entry.marker.setIcon(stationIcon(L, entry.category, entry.number, active));
    // Above the middle station (1000), which is above every other place.
    entry.marker.setZIndexOffset(active ? 2000 : 0);
  }

  function showAll() {
    if (!wholeBounds) return;
    if (reducedMotion()) map.fitBounds(wholeBounds, { padding: [40, 40] });
    else map.flyToBounds(wholeBounds, { padding: [40, 40], duration: 0.6 });
  }

  // The small map in the corner: the whole search zoomed out, with a frame around
  // what the big map shows. It's there while the big map is zoomed in past the
  // search, and tapping it zooms back out. Made on first use.
  const overviewMap = overview?.querySelector('.overview-map');
  const listeners = new AbortController();
  let mini = null;
  let miniLayer = null;
  let frame = null;
  let miniStale = true;

  function drawMini() {
    miniLayer.clearLayers();
    const routeColor = css().getPropertyValue('--route').trim() || '#161616';
    const color = css().getPropertyValue('--mid').trim() || '#161616';
    const dot = (p, className, size) =>
      L.marker([p.lat, p.lng], { icon: dotIcon(L, className, size), interactive: false, keyboard: false }).addTo(miniLayer);
    if (search.route?.length >= 2) {
      L.polyline(search.route.map((p) => [p.lat, p.lng]), { color: routeColor, weight: 2, opacity: 0.5, interactive: false }).addTo(miniLayer);
    }
    dot(search.midpoint, 'dot-mid', 8);
    for (const p of places) if (p.id !== activeId) dot(p, 'dot-place', 6);
    const active = places.find((p) => p.id === activeId);
    if (active) dot(active, 'dot-place is-active', 10).setZIndexOffset(1000);
    search.points.forEach((p, i) => dot(p, `dot-${sideKind(i)}`, 10));
    frame = L.rectangle(map.getBounds(), { color, weight: 1.5, fillColor: color, fillOpacity: 0.1, interactive: false }).addTo(miniLayer);
    miniStale = false;
  }

  /** The frame follows the big map (and stays big enough to see). */
  function moveFrame() {
    if (!frame || overview.hidden) return;
    const view = map.getBounds();
    const sw = mini.latLngToContainerPoint(view.getSouthWest());
    const ne = mini.latLngToContainerPoint(view.getNorthEast());
    const center = sw.add(ne).divideBy(2);
    const half = L.point(Math.max(ne.x - sw.x, MIN_FRAME) / 2, Math.max(sw.y - ne.y, MIN_FRAME) / 2);
    frame.setBounds(L.latLngBounds(mini.containerPointToLatLng(center.subtract(half)), mini.containerPointToLatLng(center.add(half))));
  }

  function updateOverview() {
    if (!overview) return;
    const zoomedIn = !!wholeBounds && !map.getBounds().contains(wholeBounds);
    if (!zoomedIn) {
      if (mini) overview.hidden = true;
      return;
    }
    overview.hidden = false;
    if (!mini) {
      mini = L.map(overviewMap, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        touchZoom: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        zoomSnap: 0.25,
        fadeAnimation: false,
        zoomAnimation: false,
        markerZoomAnimation: false,
      });
      L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(mini);
      miniLayer = L.layerGroup().addTo(mini);
      overview.querySelector('.overview-button').addEventListener('click', showAll, { signal: listeners.signal });
    }
    mini.invalidateSize();
    // The whole search, and the big map's view if it wandered off it.
    mini.fitBounds(L.latLngBounds(wholeBounds.getSouthWest(), wholeBounds.getNorthEast()).extend(map.getBounds()), {
      padding: [10, 10],
      animate: false,
    });
    if (miniStale) drawMini();
    moveFrame();
  }

  if (overview) {
    map.on('move', moveFrame);
    map.on('moveend', updateOverview);
  }

  return {
    kind: 'leaflet',

    /** `points`: a group's starting points, in order (two people: `a` and `b`). */
    showSearch({ a, b, points = [a, b], route, midpoint, radius }) {
      searchLayer.clearLayers();
      legsLayer.clearLayers();
      routeLines = [];
      placesLayer.clearLayers();
      markers.clear();
      activeId = null;
      search = { points, route, midpoint };
      places = [];
      miniStale = true;
      const color = css().getPropertyValue('--mid').trim() || '#161616';
      if (route?.length >= 2) {
        // The line itself: א's half in its blue, ב's half in its orange, meeting at the middle.
        routeLines = splitAtNearest(route, points[0], midpoint).map((half, i) => {
          const sideColor = css().getPropertyValue(i ? '--side-b' : '--side-a').trim();
          return L.polyline(half.map((p) => [p.lat, p.lng]), { color: sideColor, weight: 5, opacity: 0.85 }).addTo(searchLayer);
        });
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
        // Places gather around the middle: its station stays on top of theirs.
        zIndexOffset: 1000,
      }).addTo(searchLayer);
      points.forEach((p, i) => {
        L.marker([p.lat, p.lng], { icon: pinIcon(L, `pin-${sideKind(i)}`, LETTERS[i]), title: p.label }).addTo(searchLayer);
      });
      wholeBounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
      map.invalidateSize();
      map.fitBounds(wholeBounds, { padding: [40, 40] });
    },

    showPlaces(list, { numbering, onSelect }) {
      placesLayer.clearLayers();
      drawLegs(null);
      markers.clear();
      activeId = null;
      places = list;
      miniStale = true;
      for (const place of list) {
        const number = numbering.get(place.id);
        const marker = L.marker([place.lat, place.lng], { icon: stationIcon(L, place.category, number, false), title: place.name, riseOnHover: true });
        marker.bindPopup(`<div class="map-popup" dir="rtl"><strong>${escapeHtml(place.name)}</strong></div>`, { closeButton: false });
        marker.on('click', () => onSelect(place, { from: 'map' }));
        marker.addTo(placesLayer);
        markers.set(place.id, { marker, number, category: place.category });
      }
      if (search) {
        wholeBounds = L.latLngBounds(search.points.map((p) => [p.lat, p.lng]));
        for (const p of list) wholeBounds.extend([p.lat, p.lng]);
        // Fitting ends with 'moveend', which updates the overview.
        if (list.length) map.fitBounds(wholeBounds, { padding: [40, 40] });
        else updateOverview();
      }
    },

    highlight(placeId, { focus = false } = {}) {
      if (activeId && activeId !== placeId) setMarkerIcon(activeId, false);
      activeId = placeId;
      miniStale = true;
      const entry = placeId && markers.get(placeId);
      drawLegs(entry ? entry.marker.getLatLng() : null);
      if (!entry) return updateOverview();
      setMarkerIcon(placeId, true);
      // Zooming in brings the place to the middle, so its bubble needs no panning
      // (which would cut the zoom short).
      const popup = entry.marker.getPopup();
      popup.options.autoPan = !focus;
      entry.marker.openPopup();
      popup.options.autoPan = true;
      if (!focus) return updateOverview();
      const zoom = Math.max(map.getZoom(), PLACE_ZOOM);
      const shift = overviewClearance(overview, map.getSize().y);
      const center = map.unproject(map.project(entry.marker.getLatLng(), zoom).subtract([0, shift]), zoom);
      if (reducedMotion()) map.setView(center, zoom, { animate: false });
      else map.flyTo(center, zoom, { duration: 0.8 });
    },

    showAll,

    resize() {
      map.invalidateSize();
      mini?.invalidateSize();
    },

    destroy() {
      listeners.abort();
      map.remove();
      container.replaceChildren();
      if (mini) {
        mini.remove();
        overviewMap.replaceChildren();
        overview.hidden = true;
      }
    },
  };
}
