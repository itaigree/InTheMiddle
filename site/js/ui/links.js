// Deep links to navigation apps and sharing.

/** Waze: navigation to the place. */
export function wazeUrl(place) {
  return `https://waze.com/ul?ll=${place.lat}%2C${place.lng}&navigate=yes`;
}

/**
 * Google Maps: the place itself, not directions to it. Its page when Google
 * gave one; otherwise a pin at its coordinates (a search by name could find
 * another place of the same name).
 */
export function googleMapsUrl(place) {
  if (place.mapsUrl) return place.mapsUrl;
  const params = new URLSearchParams({ api: '1', query: `${place.lat},${place.lng}` });
  return `https://www.google.com/maps/search/?${params}`;
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
