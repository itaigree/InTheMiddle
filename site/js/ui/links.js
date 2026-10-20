// Deep links to navigation apps and sharing.

export function wazeUrl(place) {
  return `https://waze.com/ul?ll=${place.lat}%2C${place.lng}&navigate=yes`;
}

/** Google Maps: the place page when we know it, otherwise directions to the coordinates. */
export function googleMapsUrl(place, { mode } = {}) {
  if (place.mapsUrl) return place.mapsUrl;
  const params = new URLSearchParams({ api: '1', destination: `${place.lat},${place.lng}` });
  if (mode === 'transit') params.set('travelmode', 'transit');
  else if (mode === 'car') params.set('travelmode', 'driving');
  return `https://www.google.com/maps/dir/?${params}`;
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
