# מקום באמצע (A Place in the Middle)

Product context for design work. Read this before changing how the app looks or reads.
The current visual system is described in `site/styles.css` (and in `DESIGN.md` once it exists).

## Platform

web

A static, phone-first web app in Hebrew (RTL), served from GitHub Pages:
https://itaigree.github.io/InTheMiddle/. The Android app in `android/` is the same site in a
WebView, with an AdMob banner below it. It is not a native UI, so web conventions apply, not
Material.

## What it does

Two people type where each is leaving from. The app finds the point on the route where both
sides' **travel time** is about equal (not the midpoint of the distance), then lists places to
meet near that point: cafés, malls, parks, nature and views (selected by default), plus
restaurants and attractions. Results show on a map and as a list ranked by travel time on both
sides, how fair the split is, and rating. Each place links to Waze and Google Maps, and the
whole search can be shared as a link.

Each side picks car or public transport, and can pick a departure time in the future (this
matters on Shabbat). Filters: "only inside the Green Line" and "closed on Shabbat" (for cafés
and restaurants). A "what matters more" control re-ranks the results without a new search:
equal time, balanced (the default), or a flexible gap in exchange for a closer place.

## Who it is for

- **Families on an outing.** Relatives or families with kids living in different towns, looking
  for a park, a nature spot or a mall to meet at. They often go on weekends, often with kids in
  the car, and sometimes on Shabbat or by public transport.
- **Friends in different cities.** Two friends or groups who want somewhere that is fair to both
  sides, usually a café or a place to eat.

They use it on a phone. Typically one person runs the search and sends the share link to the
other side, and it ends with a tap on Waze.

## The job

Agree on a place quickly, where both sides feel the drive is fair, and then go. A good session
ends with both sides saying yes to one place and opening navigation. Picking the place is the
real goal; the midpoint math only gets you there.

## Personality

**Going out.** The app should feel like planning an outing: the places and the anticipation of
the day are the main thing, not the route math. Inviting, lively and local, while staying fair
and trustworthy about the numbers (travel times on both sides are what people decide by).

This is a deliberate change. The current look is "one quiet surface, hairlines instead of boxes,
two colors" (`site/styles.css`), a quiet utility. That is no longer the target. The one part of
it with real meaning is the pair of colors: side א is blue and side ב is orange, and they meet in
the ink of the middle (the brand mark in the header). Keep or replace that idea on purpose, not by
accident.

## Constraints

- **It must look complete without photos or ratings.** Google mode (ratings, photos, opening
  hours, traffic-aware times, public transport) is capped at about 8 searches a day by the free
  quota. After that the app switches to OpenStreetMap: no photos, no ratings, few opening hours,
  and Leaflet instead of Google's map. A design that leans on photos has to have a strong
  no-photo state, because that state is what most visitors see most of the day.
- Hebrew only, right to left. Font: IBM Plex Sans Hebrew.
- Phones first, including inside the Android WebView, where a banner ad takes the bottom of the
  screen. The site itself has no ads.
- Light and dark mode are both supported, following the system setting.
- No build step and no framework. Plain HTML, CSS and ES modules in `site/`. The only vendored
  library is Leaflet (`site/vendor/leaflet`), for the map.
- Two map renderers (`site/js/ui/map-google.js`, `site/js/ui/map-leaflet.js`). Markers and
  colors should look like one product in both.
- No accounts and no server of its own. Filters and the last search are kept on the device
  only. Don't design features that assume a login or a backend.
- The Transitous data-source link in the footer is a license condition and must stay visible.
- The address bar stays the site's own address, so sharing it shares the app. A specific search
  is shared from the share button next to the results.
- Accessibility: the place inputs are ARIA comboboxes with autocomplete. Keep keyboard and
  screen-reader behavior working, and keep text contrast at WCAG AA.

## Open questions

These were not asked during setup. Raise them when they matter:

- Is the Android app (with ads) the main channel, or the website?
- How much should the "going out" direction change the search form, compared with the results?
