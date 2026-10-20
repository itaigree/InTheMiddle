// Kinds of meeting places the user can pick. Each provider maps these ids to its own
// place types (Google place types / OpenStreetMap tags).

export const CATEGORIES = [
  { id: 'cafe', label: 'בתי קפה', singular: 'בית קפה', emoji: '☕', selected: true },
  { id: 'mall', label: 'קניונים', singular: 'קניון', emoji: '🛍️', selected: true },
  { id: 'park', label: 'פארקים', singular: 'פארק', emoji: '🌳', selected: true },
  { id: 'nature', label: 'טבע ונוף', singular: 'טבע ונוף', emoji: '🏞️', selected: true },
  { id: 'food', label: 'מסעדות', singular: 'מסעדה', emoji: '🍽️', selected: false },
  { id: 'attraction', label: 'אטרקציות', singular: 'אטרקציה', emoji: '🎡', selected: false },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

export const DEFAULT_CATEGORY_IDS = CATEGORIES.filter((c) => c.selected).map((c) => c.id);

export function categoryById(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}
