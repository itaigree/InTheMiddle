// Deep links to navigation apps and sharing.

/** Waze: navigation to the place. */
export function wazeUrl(place) {
  return `https://waze.com/ul?ll=${place.lat}%2C${place.lng}&navigate=yes`;
}

/**
 * Google Maps: the place itself, not directions to it. Its page when Google
 * gave one; otherwise a search for its name with the map at its coordinates,
 * so Google finds that place and not another of the same name elsewhere.
 * (Google's documented search link has no way to say where to look.)
 */
export function googleMapsUrl(place) {
  if (place.mapsUrl) return place.mapsUrl;
  if (!place.name) return `https://www.google.com/maps/search/?api=1&query=${place.lat}%2C${place.lng}`;
  return `https://www.google.com/maps/search/${encodeURIComponent(place.name)}/@${place.lat},${place.lng},17z`;
}

/**
 * Share with the native share sheet (WhatsApp etc.) when available, else copy to
 * the clipboard. Returns 'shared' | 'copied' | 'cancelled' | 'failed'.
 */
export async function shareOrCopy({ title, text, url }) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
      // Fall through to copying (e.g. share not allowed in this context).
    }
  }
  const payload = [text, url].filter(Boolean).join('\n');
  try {
    await navigator.clipboard.writeText(payload);
    return 'copied';
  } catch {
    return 'failed';
  }
}
