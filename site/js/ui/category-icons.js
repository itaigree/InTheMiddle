// One drawn icon per kind of place, all on a 24-unit grid in the same 1.8 stroke.
// They sit white inside the station roundels, in the category's own colour.

const PATHS = {
  // A cup with steam.
  cafe: 'M5 10h11v4a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM16 11h1.5a2.5 2.5 0 0 1 0 5H16M8.5 3.5c-.8 1 .8 2 0 3M12 3.5c-.8 1 .8 2 0 3',
  // A shopping bag.
  mall: 'M5.5 8h13l-1 12h-11zM9 8V6.5a3 3 0 0 1 6 0V8',
  // A broad tree.
  park: 'M12 21v-7M12 14l-3-2.5M12 15.5l2.5-2M7.5 13.5a4.5 4.5 0 0 1 .7-8.9 4.5 4.5 0 0 1 7.6 0 4.5 4.5 0 0 1 .7 8.9z',
  // Two ridges and the sun.
  nature: 'M2.5 19l6-9 4 5.5 2.5-3.5 6.5 7zM16.5 7.5a1.8 1.8 0 1 0 0 .1',
  // Fork and knife.
  food: 'M7 3v7M5 3v4.5a2 2 0 0 0 4 0V3M7 10v11M16.5 21V3c-2 1.5-3 4-3 7v2.5h3',
  // A Ferris wheel.
  attraction: 'M12 11.5m-6.5 0a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0M12 5v13M5.5 11.5h13M7.4 6.9l9.2 9.2M16.6 6.9l-9.2 9.2M8.5 21l3.5-3 3.5 3',
};

/** The icon for a category as an SVG element (empty for an unknown id). */
export function categoryIcon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'cat-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (PATHS[id]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', PATHS[id]);
    svg.append(path);
  }
  return svg;
}

/** A station roundel: the category's colour (from CSS, by data-category) with its icon. */
export function categoryRoundel(id, className = 'roundel') {
  const span = document.createElement('span');
  span.className = className;
  span.dataset.category = id;
  span.setAttribute('aria-hidden', 'true');
  span.append(categoryIcon(id));
  return span;
}

/** The same icon as SVG markup, for map markers built from HTML strings. */
export function categoryIconMarkup(id) {
  return `<svg class="cat-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${PATHS[id] || ''}"/></svg>`;
}
