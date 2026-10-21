// A small fake of the Google Maps JavaScript API, served in place of
// https://maps.googleapis.com/maps/api/js during end-to-end tests. It implements
// just the classes the app uses, with deterministic data.
//
// window.__fakeGoogleOptions:
//   authFail: true           → call gm_authFailure() right after loading
//   quota: 'nearby'|'matrix'|'autocomplete'|'route'  → that call fails with RESOURCE_EXHAUSTED
//   transitNoService: true   → every TRANSIT matrix element is ROUTE_NOT_FOUND
//   detailsDelayMs: n        → Place.fetchFields takes n ms (a slow suggestion resolve)
//   mapNeverLoads: true      → the map never fires 'tilesloaded'
//   lateOverlayMs: n         → n ms after the map is created, show Google's error screen
//   matrixDelayMs: n         → RouteMatrix calls take n ms
(() => {
  const options = window.__fakeGoogleOptions || {};
  const calls = (window.__fakeGoogleCalls = []);

  const KNOWN = {
    חיפה: { name: 'חיפה', lat: 32.794, lng: 34.9896, region: 'ישראל' },
    'תל אביב': { name: 'תל אביב-יפו', lat: 32.0853, lng: 34.7818, region: 'ישראל' },
    'באר שבע': { name: 'באר שבע', lat: 31.2518, lng: 34.7913, region: 'ישראל' },
  };
  const find = (q) => {
    const key = Object.keys(KNOWN).find((k) => q.includes(k) || k.includes(q));
    return key ? KNOWN[key] : null;
  };

  function haversine(a, b) {
    const R = 6371008.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const lit = (p) => ({ lat: typeof p.lat === 'function' ? p.lat() : p.lat, lng: typeof p.lng === 'function' ? p.lng() : p.lng });

  class MapsNetworkError extends Error {
    constructor(message, code, endpoint) {
      super(message);
      this.code = code;
      this.endpoint = endpoint;
    }
  }
  class MapsRequestError extends MapsNetworkError {}
  class MapsServerError extends MapsNetworkError {}

  function maybeQuota(kind, endpoint) {
    calls.push(kind);
    if (options.quota === kind) {
      throw new MapsRequestError(`${endpoint}: RESOURCE_EXHAUSTED: Quota exceeded for quota metric`, 'RESOURCE_EXHAUSTED', endpoint);
    }
  }

  class LatLng {
    constructor(lat, lng) {
      this._lat = lat;
      this._lng = lng;
    }
    lat() {
      return this._lat;
    }
    lng() {
      return this._lng;
    }
  }

  class LatLngBounds {
    constructor(sw, ne) {
      this.s = Infinity;
      this.w = Infinity;
      this.n = -Infinity;
      this.e = -Infinity;
      if (sw) this.extend(sw);
      if (ne) this.extend(ne);
    }
    extend(p) {
      const { lat, lng } = lit(p);
      this.s = Math.min(this.s, lat);
      this.n = Math.max(this.n, lat);
      this.w = Math.min(this.w, lng);
      this.e = Math.max(this.e, lng);
      return this;
    }
    getSouthWest() {
      return new LatLng(this.s, this.w);
    }
    getNorthEast() {
      return new LatLng(this.n, this.e);
    }
    contains(p) {
      const { lat, lng } = lit(p);
      return lat >= this.s && lat <= this.n && lng >= this.w && lng <= this.e;
    }
  }

  // ------------------------------------------------------------------ places

  let placeSeq = 0;
  class Place {
    constructor(data = {}) {
      Object.assign(this, data);
    }
    async fetchFields({ fields }) {
      if (options.detailsDelayMs) await new Promise((r) => setTimeout(r, options.detailsDelayMs));
      maybeQuota('details', 'PLACES_GET_PLACE');
      calls.push(`fetchFields:${fields.join(',')}`);
      if (this._loc) this.location = new LatLng(this._loc.lat, this._loc.lng);
      return { place: this };
    }
    static async searchByText(req) {
      maybeQuota('text', 'PLACES_SEARCH_TEXT');
      calls.push(`searchByText:${req.fields.join(',')}`);
      const hit = find(req.textQuery);
      return { places: hit ? [new Place({ id: `text-${hit.name}`, _loc: hit })] : [] };
    }
    static async searchNearby(req) {
      maybeQuota('nearby', 'PLACES_NEARBY_SEARCH');
      const types = req.includedPrimaryTypes || req.includedTypes || [];
      calls.push(`searchNearby:${types.join(',')}`);
      const { center, radius } = req.locationRestriction;
      const c = lit(center);
      const kind = types[0];
      const label = { cafe: 'בית קפה', shopping_mall: 'קניון', park: 'פארק', national_park: 'גן לאומי', restaurant: 'מסעדה', tourist_attraction: 'אטרקציה' }[kind] || kind;
      const count = kind === 'shopping_mall' ? 3 : 6;
      const places = Array.from({ length: count }, (_, i) => {
        const offset = (radius / 111000) * 0.5;
        const loc = { lat: c.lat + ((i % 3) - 1) * offset, lng: c.lng + (Math.floor(i / 3) - 0.5) * offset };
        const id = `g-${kind}-${++placeSeq}`;
        return new Place({
          id,
          displayName: `${label} ${i + 1}`,
          location: new LatLng(loc.lat, loc.lng),
          primaryType: kind,
          primaryTypeDisplayName: label,
          shortFormattedAddress: `רחוב ${i + 1}, עיר האמצע`,
          googleMapsURI: `https://maps.google.com/?cid=${id}`,
          businessStatus: i === 5 ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL',
          rating: 3.8 + (i % 4) * 0.3,
          userRatingCount: 50 * (i + 1),
          // The first of each kind closes for Shabbat; the rest are open 24/7.
          regularOpeningHours: {
            periods:
              i === 0
                ? [0, 1, 2, 3, 4, 5].map((day) => ({ open: { day, hour: 8, minute: 0 }, close: { day, hour: day === 5 ? 14 : 22, minute: 0 } }))
                : [{ open: { day: 0, hour: 0, minute: 0 } }],
          },
          photos: [
            {
              getURI: () =>
                'data:image/svg+xml;utf8,' +
                encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="hsl(${i * 50},60%,70%)"/></svg>`),
              authorAttributions: [{ displayName: `צלם ${i + 1}`, uri: 'https://example.com/photographer' }],
            },
          ],
        });
      });
      return { places };
    }
  }

  class AutocompleteSessionToken {}

  const AutocompleteSuggestion = {
    async fetchAutocompleteSuggestions(req) {
      maybeQuota('autocomplete', 'PLACES_AUTOCOMPLETE');
      const hit = find(req.input);
      if (!hit) return { suggestions: [] };
      return {
        suggestions: [
          {
            placePrediction: {
              placeId: `ac-${hit.name}`,
              text: { text: `${hit.name}, ${hit.region}` },
              mainText: { text: hit.name },
              secondaryText: { text: hit.region },
              toPlace: () => new Place({ id: `ac-${hit.name}`, _loc: hit }),
            },
          },
        ],
      };
    },
  };

  // ------------------------------------------------------------------ routes

  const SPEED = { DRIVING: 20, TRANSIT: 12 };

  const Route = {
    async computeRoutes(req) {
      maybeQuota('route', 'ROUTES');
      const a = lit(req.origin);
      const b = lit(req.destination);
      const n = 4;
      const pts = Array.from({ length: n * 5 + 1 }, (_, i) => ({
        lat: a.lat + ((b.lat - a.lat) * i) / (n * 5),
        lng: a.lng + ((b.lng - a.lng) * i) / (n * 5),
      }));
      const steps = Array.from({ length: n }, (_, s) => {
        const path = pts.slice(s * 5, s * 5 + 6);
        let d = 0;
        for (let i = 1; i < path.length; i++) d += haversine(path[i - 1], path[i]);
        return { path, distanceMeters: d, staticDurationMillis: (d / SPEED.DRIVING) * 1000 };
      });
      const distance = haversine(a, b);
      return {
        routes: [
          {
            distanceMeters: distance,
            durationMillis: (distance / SPEED.DRIVING) * 1000,
            path: pts,
            legs: [{ steps }],
          },
        ],
      };
    },
  };

  const RouteMatrix = {
    async computeRouteMatrix(req) {
      if (options.matrixDelayMs) await new Promise((r) => setTimeout(r, options.matrixDelayMs));
      maybeQuota('matrix', 'ROUTES');
      calls.push(`matrix:${req.travelMode}:${req.origins.length}x${req.destinations.length}`);
      const speed = SPEED[req.travelMode];
      return {
        matrix: {
          rows: req.origins.map((o) => ({
            items: req.destinations.map((d) =>
              req.travelMode === 'TRANSIT' && options.transitNoService
                ? { condition: 'ROUTE_NOT_FOUND', durationMillis: null }
                : { condition: 'ROUTE_EXISTS', durationMillis: (haversine(lit(o), lit(d)) / speed) * 1000 },
            ),
          })),
        },
      };
    },
  };

  // -------------------------------------------------------------- map/marker

  class FakeMap {
    constructor(container, opts) {
      calls.push(`map:${opts.mapId}`);
      if (options.lateOverlayMs) {
        setTimeout(() => {
          const err = document.createElement('div');
          err.className = 'gm-err-container';
          err.textContent = 'This page can’t load Google Maps correctly.';
          this.div.append(err);
        }, options.lateOverlayMs);
      }
      if (options.authFail === 'map') setTimeout(() => window.gm_authFailure?.(), 50);
      this.container = container;
      this.div = document.createElement('div');
      this.div.className = 'fake-google-map';
      this.div.style.cssText = 'position:absolute;inset:0;background:#e8eae6;overflow:hidden;font:12px sans-serif;';
      this.div.textContent = 'Fake Google Map';
      container.append(this.div);
      this.bounds = new LatLngBounds({ lat: 31, lng: 34.3 }, { lat: 33, lng: 35.7 });
      this.items = new Set();
    }
    fitBounds(bounds) {
      this.bounds = new LatLngBounds(bounds.getSouthWest(), bounds.getNorthEast());
      const padLat = (this.bounds.n - this.bounds.s) * 0.1 + 0.01;
      const padLng = (this.bounds.e - this.bounds.w) * 0.1 + 0.01;
      this.bounds.extend({ lat: this.bounds.s - padLat, lng: this.bounds.w - padLng });
      this.bounds.extend({ lat: this.bounds.n + padLat, lng: this.bounds.e + padLng });
      for (const item of this.items) item.place?.();
    }
    getBounds() {
      return this.bounds;
    }
    addListener(name, fn) {
      // With a rejected key Google shows its error screen instead of loading tiles.
      const loads = name === 'tilesloaded' && !options.mapNeverLoads && options.authFail !== 'map';
      const timer = loads ? setTimeout(fn, 20) : 0;
      return { remove: () => clearTimeout(timer) };
    }
    panTo() {}
    project(p) {
      const { lat, lng } = lit(p);
      const w = this.div.clientWidth || 400;
      const h = this.div.clientHeight || 300;
      return {
        x: ((lng - this.bounds.w) / (this.bounds.e - this.bounds.w)) * w,
        y: ((this.bounds.n - lat) / (this.bounds.n - this.bounds.s)) * h,
      };
    }
  }

  class Overlay {
    constructor(opts) {
      this.opts = opts;
      this.setMap(opts.map);
    }
    setMap(map) {
      this.map?.items.delete(this);
      this.map = map;
      map?.items.add(this);
    }
  }
  class Polyline extends Overlay {}
  class Circle extends Overlay {}

  class InfoWindow {
    setContent(el) {
      this.content = el;
    }
    open() {}
    close() {}
  }

  class AdvancedMarkerElement extends EventTarget {
    constructor({ map, position, content, title, zIndex }) {
      super();
      this.el = document.createElement('div');
      this.el.className = 'fake-marker';
      this.el.style.cssText = 'position:absolute;transform:translate(-50%,-100%);cursor:pointer;';
      this.el.title = title || '';
      this.el.addEventListener('click', () => this.dispatchEvent(new Event('gmp-click')));
      this.position = position;
      this.zIndex = zIndex;
      this.content = content;
      this.map = map;
    }
    set content(node) {
      this.el.replaceChildren(...(node ? [node] : []));
    }
    set zIndex(z) {
      this.el.style.zIndex = String(z ?? 0);
    }
    set map(map) {
      this._map?.items.delete(this);
      this.el.remove();
      this._map = map;
      if (map) {
        map.items.add(this);
        map.div.append(this.el);
        this.place();
      }
    }
    get map() {
      return this._map;
    }
    place() {
      if (!this._map) return;
      const { x, y } = this._map.project(this.position);
      this.el.style.left = `${x}px`;
      this.el.style.top = `${y}px`;
    }
  }

  const libraries = {
    core: { LatLng, LatLngBounds, MapsNetworkError, MapsRequestError, MapsServerError },
    places: { Place, AutocompleteSuggestion, AutocompleteSessionToken },
    routes: { Route, RouteMatrix },
    maps: { Map: FakeMap, Polyline, Circle, InfoWindow },
    marker: { AdvancedMarkerElement },
  };

  window.google.maps.importLibrary = async (name) => {
    if (!libraries[name]) throw new Error(`fake google: unknown library ${name}`);
    return libraries[name];
  };
  Object.assign(window.google.maps, libraries.core, libraries.maps);
  window.google.maps.__ib__();
  // authFail: 'load' (right after the SDK loads) or 'map' (when the first map is created,
  // which is when Google really reports a Maps JS key problem).
  if (options.authFail === true || options.authFail === 'load') setTimeout(() => window.gm_authFailure?.(), 0);
})();
