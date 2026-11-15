# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Families on an outing.** Relatives or families with kids who live in different towns and
  want a park, a nature spot or a mall to meet at.
- **Friends in different cities.** Two friends or groups looking for a place that is fair to
  both sides, usually a café or somewhere to eat.

Either way, the job is the same: agree on one place both sides accept as fair, then go.

## Product Purpose

מקום באמצע ("a place in the middle") takes two starting points and finds places to meet that are
about the same travel time from both sides: cafés, malls, parks, nature and views (selected by
default), restaurants and attractions. Success is both sides saying yes to one place and opening
navigation (Waze or Google Maps). The midpoint math is how you get there; picking the place is
the goal.

## Positioning

**Fairness you can see.** Every result shows how long each side travels to it, and the user
chooses the trade-off: equal time, balanced, or a flexible gap for a closer place. A map search
gives you places; this gives you places together with how fair each one is, so two people can
agree.

## Operating Context

- The Android app is meant to be the main channel. It shows the website
  (https://itaigree.github.io/InTheMiddle/) in a WebView, with an AdMob banner at the bottom of
  the screen. The website itself has no ads. Because it is a wrapper, the design language is web,
  not Material.
- Used on phones. Each side picks car or public transport, and can set a future departure time,
  which matters for public transport on Shabbat.
- A search can be shared as a link from the share button next to the results. The address bar
  always stays the site's own address, so sharing it shares the app.
- Results end in a hand-off to Waze or Google Maps.

## Capabilities and Constraints

- **Travel time, not distance.** The app finds the point on the route where both sides' travel
  time is equal, then widens the search around it (up to a quarter of the route, 5–30 km) until
  places turn up. Results are ranked by average travel time, the gap between the sides, and
  rating.
- **Two data modes.** Google Maps mode (ratings, photos, opening hours, traffic-aware times,
  public transport) is limited by the free quota to about 8 searches a day. After that, the app
  switches automatically to OpenStreetMap: no photos, no ratings, few opening hours, and a
  Leaflet map. Every surface has to be complete in OpenStreetMap mode, because that is what most
  visitors get most of the day.
- **Filters.** "Only inside the Green Line" leaves out places in Judea and Samaria and Gaza (and
  keeps the route out of Judea and Samaria). "Closed on Shabbat" keeps only cafés and restaurants
  whose hours show them closed from Friday 19:00 to Saturday 17:00. That is a hint about
  kashrut, not a certification, and the UI must not present it as one.
- Hebrew only, right to left.
- No accounts and no server of its own. Filters and the last search are kept on the device only.
- No build step and no framework: plain HTML, CSS and ES modules in `site/`, deployed to GitHub
  Pages. Leaflet (`site/vendor/leaflet`) is the only vendored library.
- Two map renderers (`site/js/ui/map-google.js`, `site/js/ui/map-leaflet.js`) that must read as
  one product.
- The Transitous data-source link in the footer is a license condition and must stay visible.
- Light and dark mode both exist, following the system setting.

## Brand Commitments

- Name: מקום באמצע. Tagline: "נפגשים בדיוק באמצע הדרך".
- Brand mark: two endpoints, א and ב, meeting at a larger middle dot (the header SVG in
  `site/index.html` and `site/icons/icon.svg`). Whether it carries into a redesign is undecided.
- Personality, as the owner stated it for the next design: **going out**. Planning an outing,
  where the places and the day ahead come first and the route math stays in the background. This
  replaces the current quiet-utility look.

## Evidence on Hand

- Place data (names, ratings, photos, hours) comes only from Google Places or OpenStreetMap at
  runtime. The project has no photos of its own.
- Category list and emoji: `site/js/core/categories.js`. App icons: `site/icons/`. Privacy policy:
  `site/privacy.html`.
- There are no user counts, reviews, testimonials, press or store ratings. Don't make any up.

## Product Principles

1. **Show the fairness.** Both sides' travel times are what people decide by. Never hide them or
   the trade-off behind a single score.
2. **The place is the goal.** Every step should move two people toward one agreed place and a tap
   on navigation.
3. **Complete in free mode.** A screen that only works with Google's photos and ratings is
   broken for most visitors.
4. **Built for the app.** Design for a phone inside the Android WebView, with the banner at the
   bottom.
5. **Nothing to sign up for.** No accounts, no backend, nothing that assumes either.

## Accessibility & Inclusion

- The place inputs are ARIA comboboxes with autocomplete, and controls have screen-reader labels.
  Keep keyboard and screen-reader behavior working.
- Public-transport users and Shabbat observers are part of the audience: the transit mode,
  future departure time and Shabbat filter are product features, not extras.
- No specific WCAG level has been set.
