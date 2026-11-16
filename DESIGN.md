---
name: מקום באמצע
description: Fair meeting places for two starting points, drawn as stations on the line between א and ב.
colors:
  bg: "#e9ecee"
  surface: "#ffffff"
  surface-2: "#f2f4f5"
  text: "#11161b"
  muted: "#545e67"
  faint: "#6b747d"
  line: "#d6dbdf"
  line-strong: "#b8c0c7"
  ink: "#11161b"
  on-ink: "#ffffff"
  band: "#11161b"
  on-band: "#ffffff"
  side-a: "#2459ff"
  side-b: "#ff6512"
  side-a-text: "#1f4fe0"
  side-b-text: "#c44a00"
  go: "#ffc61a"
  on-go: "#11161b"
  cat-cafe: "#8a4b25"
  cat-mall: "#6d3fd1"
  cat-park: "#19784a"
  cat-nature: "#0b6f74"
  cat-food: "#c0352b"
  cat-attraction: "#b02a78"
  good: "#1a7f45"
  warn: "#9a5b06"
  danger: "#c8341f"
typography:
  headline:
    fontFamily: "IBM Plex Sans Hebrew, system-ui, -apple-system, Segoe UI, Arial, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "IBM Plex Sans Hebrew, system-ui, -apple-system, Segoe UI, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.3
  place-name:
    fontFamily: "IBM Plex Sans Hebrew, system-ui, -apple-system, Segoe UI, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.3
  minutes:
    fontFamily: "IBM Plex Sans Hebrew, system-ui, -apple-system, Segoe UI, Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    fontFeature: "tnum"
  minutes-picked:
    fontFamily: "IBM Plex Sans Hebrew, system-ui, -apple-system, Segoe UI, Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.15
    fontFeature: "tnum"
  body:
    fontFamily: "IBM Plex Sans Hebrew, system-ui, -apple-system, Segoe UI, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tnum"
  control:
    fontFamily: "IBM Plex Sans Hebrew, system-ui, -apple-system, Segoe UI, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
  label:
    fontFamily: "IBM Plex Sans Hebrew, system-ui, -apple-system, Segoe UI, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.4
  caption:
    fontFamily: "IBM Plex Sans Hebrew, system-ui, -apple-system, Segoe UI, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
rounded:
  tag: "4px"
  segment: "7px"
  sm: "10px"
  md: "14px"
  station: "50%"
spacing:
  hairline-row: "14px"
  gutter: "16px"
  gap: "20px"
  form: "24px"
  form-lane: "48px"
  strip-lane: "60px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "56px"
  button-go:
    backgroundColor: "{colors.go}"
    textColor: "{colors.on-go}"
    rounded: "{rounded.sm}"
    height: "52px"
    width: "100%"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    height: "34px"
    padding: "0 12px"
  place-action:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    height: "44px"
    padding: "0 14px"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    height: "36px"
    padding: "0 14px"
  chip-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.sm}"
    height: "36px"
  station-roundel:
    rounded: "{rounded.station}"
    size: "32px"
  station-roundel-sm:
    rounded: "{rounded.station}"
    size: "24px"
  strip-list:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
  trip-band:
    backgroundColor: "{colors.band}"
    textColor: "{colors.on-band}"
    padding: "18px 16px 16px"
  segmented-on:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.segment}"
    height: "36px"
---

# Design System: מקום באמצע

## Overview

**Creative North Star: "The Route Line"**

Every place is a station on the line between א and ב, and fairness is where its station sits on that line. The world is the Israeli bus-line strip: an ink band carrying the trip, one cool concrete-grey ramp for every neutral, white surfaces, א blue and ב orange as the line's two ends, six category line colours each with a drawn roundel, and signal yellow reserved for the one button that acts. Minutes are what people compare, so they are set large in tabular figures and sit directly on each place's own line.

The surface is a working tool on a phone inside an Android WebView, Hebrew and right to left, complete in the free OpenStreetMap mode with no photos or ratings. It is flat: hairlines and white panels on concrete ground, with depth spent only on things that float over the map or the page. The signature is a line that runs blue from א, stops hard, and continues orange to ב, with an ink-ringed station at the meeting point. It recurs as the start screen's spine, the map route, the trip band, each place's own short line and the picked card's full-width line; the strip-map list hangs every result off one spine as a station.

The direction refuses the category default of a map over a list of identical text cards. It is not a bus app: no route numbers, no bus livery.

**Key Characteristics:**
- A hard-split blue/orange line with an ink-ringed station as the recurring mark.
- Every place drawn as a station roundel in its category's colour, with one drawn icon in a 1.8 stroke.
- Lists as strip maps: one spine down the start edge, stations on it.
- One cool concrete ramp for all neutrals; white surfaces; an always-dark band.
- Signal yellow on the act of going (Waze) and nowhere else.
- Minutes larger than names, in tabular figures.

## Colors

A cool concrete-grey system with two line-end hues, six category line colours, and one signal yellow.

### Primary
- **Side A Blue** (`side-a`): א's end of every line, the start-screen spine's first stretch, the map route's first half, the א pin, the picked place's first leg on the map. `side-a-text` is the deeper shade for א letters and badges on light ground (white on it holds 6.5:1).
- **Side B Orange** (`side-b`): ב's end of every line, the spine after ב, the route's second half, the ב pin and leg. `side-b-text` is the deeper shade for ב letters and badges (white on it holds 4.9:1); raw `side-b` is a line colour, never a text colour on white.

### Secondary
- **Signal Yellow** (`go`, text `on-go`): the full-width Waze button on the picked place. Nothing else.

### Tertiary: category line colours
- **Café Brown** (`cat-cafe`), **Mall Violet** (`cat-mall`), **Park Green** (`cat-park`), **Nature Teal** (`cat-nature`), **Food Red** (`cat-food`), **Attraction Magenta** (`cat-attraction`). Each fills its station roundel, its map pin, and the picked card's header band. Every one holds at least 5.4:1 under white icons and text in light mode.
- **Category band** (`--cat-band`): set per element by `data-category`. In light mode it is the category colour itself; in dark mode it is `color-mix(in srgb, var(--cat) 82%, #000)`, deepening the lighter dark-theme category colours back under white text. An unknown category falls back to `muted`.

### Neutral
- **Concrete Ground** (`bg`): the page.
- **White Surface** (`surface`) and **Pale Concrete** (`surface-2`): panels and lists; pressed, focused and map-placeholder fills.
- **Ink Text** (`text`), **Concrete Muted** (`muted`), **Concrete Faint** (`faint`, placeholders and footer only).
- **Hairline** (`line`) and **Strong Hairline** (`line-strong`): dividers and borders; `line-strong` is also the list spine and chip outlines.
- **Ink** (`ink`, text `on-ink`): the strong fill for the search button, selected chips, switches on, and the toast. It inverts in dark mode (light ink on dark ground).
- **Band** (`band`, text `on-band`): the header strip and pin number tags. Dark in both themes (`#05080a` in dark).
- **State** (`good`, `warn`, `danger`): open now, fairness levels, closed now and errors.

Dark mode redefines every token on `:root` under `prefers-color-scheme: dark`: ground `#0d1013`, surfaces `#161a1e` / `#1e2328`, text `#eef1f3`, and lifted line ends and category colours (values in the sidecar's `colorMeta`).

### Named Rules
**The Hard Split Rule.** Blue meets orange at a hard colour stop, and the station sits on the stop. The line is never a blend; a purple or white middle is a defect.

**The Signal Yellow Rule.** Yellow marks the act of going. The search button is ink, the place actions are outlined; only Waze on the picked place is yellow.

**The Ink Versus Band Rule.** `ink` is a fill that follows the theme; `band` is the strip that stays dark in both. Never swap them: a light band in dark mode loses the bus strip, a dark ink button in dark mode disappears.

**The Line Colour Rule.** Category colours live on roundels, pins and the picked band, always under white. They never colour body text.

## Typography

**Display Font:** none; the system has no display role.
**Body Font:** IBM Plex Sans Hebrew (400, 500, 600), self-hosted from `site/vendor/plex-hebrew` with Hebrew and Latin subsets, falling back to system-ui.

**Character:** one engineered sans in three weights, Hebrew-first, with tabular figures set on `body` so every minute and count aligns.

### Hierarchy
- **Headline** (600, 1.25rem, 1.2, -0.01em): the app name in the band.
- **Title** (600, 1.0625rem): section headings such as the results heading.
- **Place name** (600, 1rem, 1.3): a station's name.
- **Minutes** (600, 1.125rem in list rows; 1.5rem on the picked place): both sides' times, always larger than the place's name.
- **Body** (400, 15px, 1.5): text and inputs (inputs at 1rem).
- **Control** (400, 0.875rem): chips, segmented options, status, summary, tagline.
- **Label** (500, 0.8125rem, muted): group legends, the "from" place names over picked times, place meta.
- **Caption** (400, 0.75rem): photo credit, footer, chip counts.

### Named Rules
**The Minutes First Rule.** On any place, the two times are the largest type in the row, in tabular figures, with the place's own line between them.

**The Three Weights Rule.** 400, 500 and 600 only; 600 is for names, headings and minutes.

## Layout

Phone first, single column, 16px side gutter (respecting safe-area insets), 20px between blocks. The form stacks at 24px; its groups align to a 48px lane beside the start-screen spine. List rows indent their times and actions to a 60px lane beside the strip's spine.

On phones the order is: band, status, result chips, map (46dvh, min 320px), the picked place, then the list. Once results exist, the band pins to the top as one compact row (mark and trip line, tap to edit), the h1 is clipped to screen-reader-only, and the chips scroll horizontally on touch. At 960px and up the panel is a 420px column beside a sticky full-height map; the picked card is hidden there because the list's active row carries the picked state. With a fine pointer, chips wrap instead of scrolling.

## Elevation & Depth

Flat by default: white panels with 1px hairlines on concrete ground, divided internally by hairlines rather than boxes. Shadow is spent only on things that float over the page or map.

### Shadow Vocabulary
- **Pop** (`--pop`: `0 12px 32px rgb(17 22 27 / 12%), 0 1px 3px rgb(17 22 27 / 8%)`; dark `0 12px 32px rgb(0 0 0 / 50%)`): autocomplete suggestions, the toast, map popups.
- **Segment lift** (`0 1px 2px rgb(0 0 0 / 12%)`): the selected segment in a segmented control.
- **Pin** (`0 1px 4px rgb(0 0 0 / 30%)`): map pins.
- **Active pin** (`0 0 0 3px var(--cat), 0 4px 12px rgb(0 0 0 / 35%)`): the picked place's pin.
- **Station cut-out** (`0 0 0 3px var(--surface)`): a ring in the surface colour that cuts each list roundel out of the spine; not elevation.

### Named Rules
**The Flat Panel Rule.** Panels never carry shadows. A shadow means the thing floats over the map or the page.

## Shapes

Gently rounded panels (14px) and controls (10px), 7px inner segments, 4px number tags. Stations are circles. Lines are 3px spines (list, start screen) and 4px place lines, 6px on the picked card, all with rounded ends. The ink-ringed station is a surface- or band-coloured disc with a 3-4px ring in `text` (or `on-band` in the band). A/B map pins are teardrops rotated -45deg; place pins are round stations.

Icons are drawn line icons on a 24-unit grid with round caps and joins: category icons at 1.8 stroke in white inside roundels, interface icons (mode, locate, swap, share, chevron) at 1.6.

## Components

### Buttons
- **Primary (search):** ink fill, on-ink text, 56px tall, 14px radius, 500 weight. Hover drops to 0.88 opacity, active scales to 0.995, disabled 0.45 with a progress cursor. On the start screen it sits on the spine as its last station.
- **Go (Waze):** signal yellow, on-go text, full width, 52px, 600 weight, on the picked place only.
- **Place actions (Google Maps, share):** outlined in `line-strong` on surface, 40px in rows and 44px on the picked place where they split the width; hover darkens the border to `muted`.
- **Ghost:** 34px outlined, 0.8125rem with a 16px icon, for "share search".
- **Icon button:** 36px, transparent, muted icon; hover fills `surface-2`.

### Chips
- **Style:** 36px, 10px radius, `line-strong` outline on surface, 0.875rem. With a category, a 24px roundel leads and the start padding tightens to 6px.
- **State:** selected is an ink fill with on-ink text. Result filters carry a count at 0.75rem and 60% opacity, and use `aria-pressed`.

### Station roundel
A 32px circle in the category colour holding the category icon in white at 18px; 24px with a 14px icon inside chips. In the list it carries a 3px surface ring that cuts it out of the spine, with the map number on a small tag beneath. On the picked band it inverts: white disc, icon stroked in `--cat-band`.

### Strip-map list
A white panel with a 3px `line-strong` spine down the start edge, running from the first station to the last. Each row: roundel and number on the spine, name and one-line meta, then both times with the place's own split line between them, its station placed at `timeA / (timeA + timeB)` so it sits nearer the side that travels less. Photos, credits, address, fairness line and actions are held back until a row is picked, keeping every row one station tall.

### Picked card
The picked place (under the map on phones; the active list row on desktop): the header is a full band in `--cat-band` with white text and an inverted roundel. Below it, each time sits under its starting place's name at 1.5rem, the line runs the card's full width at 6px with an 18px station, and the fairness line states the difference and the side in words ("7 דק׳ יותר מתל אביב"), its dot coloured by level (`good` great, `text` good, `warn` fair). Then the full-width yellow Waze and the two outlined actions.

### Trip band
The always-dark header: the brand mark, the app name and tagline. After a search it shows the trip: א badge and place, the line with its ringed middle station, ב place and badge, and an edit pencil; the whole row is one button that returns to the form.

### Map pins
Shared by Leaflet and Google. A and B are teardrop pins in their side colour with a white 2px border and the letter. Places are 30px round stations in the category colour with the icon and a number tag on `band`; the active one gets a 3px white border, a category-colour halo and a higher stack. The middle station is a 16px disc in `bg` with a 3px ring in `--mid`, stacked above every place pin and below the active one. The route is drawn as two halves, blue to the middle and orange after, at 5px and 0.85 opacity; when a place is picked the route dims to 0.3 and the two legs draw straight from א to the place and on to ב as round-dotted 4px lines in the side colours. Leaflet tiles are desaturated to half (inverted to a soft charcoal in dark mode); the Google map follows the system scheme.

### Segmented controls and switches
Segments sit in a `surface-2` track with 3px padding; the chosen one lifts to `seg-on` with the segment shadow. Switches are 40x24, `line-strong` off and `ink` on, the knob sliding over 0.2s.

### Motion
State changes ease over 0.15s (background, border, colour). The signature motion is the re-sort: when "what matters more" changes, every row slides from its old position to its new one over 520ms on `cubic-bezier(0.22, 1, 0.36, 1)`, and a place line's station slides along its line over 0.5s on the same curve. Under `prefers-reduced-motion: reduce`, the slide is skipped, CSS animations and transitions are removed, and map moves jump instead of flying.

### State rules
- Loading: an inline status with a 16px spinner; the locate button pulses while busy.
- Error: status in `danger` text with a danger-tinted border; an invalid place input gets a wavy danger underline.
- Info: status on `surface-2` with no border.
- Empty results: a centred muted sentence saying what to widen.
- Focus: a 2px `text` outline offset 2px everywhere (inset for the overview map); `on-band` inside the band.
- Selection and caret follow the palette: selection is side-a at 28%, the caret is `side-a-text`.
- Open/closed: `good` and `danger` text in the meta; on the picked band both turn white and 600.

## Do's and Don'ts

### Do:
- **Do** draw every א-to-ב line with a hard stop between `side-a` and `side-b`, the ink-ringed station sitting on the stop.
- **Do** put a place on screen as a station roundel in its category colour, with its icon in white at the 1.8 stroke.
- **Do** set both travel times larger than the place's name, in tabular figures, with the place's own line between them.
- **Do** hang lists of places off one spine as a strip map, and hold extras (photo, address, actions) until a row is picked.
- **Do** keep `band` dark in both themes and let `ink` invert.
- **Do** derive a picked header from `--cat-band` so white text holds in both themes.
- **Do** make every surface complete in OpenStreetMap mode, without photos or ratings.
- **Do** keep the re-sort slide and every transition behind `prefers-reduced-motion`.

### Don't:
- **Don't** blend blue into orange; a smooth gradient between the two ends is a defect.
- **Don't** use signal yellow on anything but the button that sends people on their way.
- **Don't** use category colours for text, or `side-b` as a text colour on light ground; use `side-b-text`.
- **Don't** give panels shadows; shadows are for things that float.
- **Don't** add route numbers or bus livery; the car and transit mode icons stay, as functional marks.
- **Don't** use glyph or emoji icons; icons are drawn SVG in the shared strokes.
- **Don't** add kickers or eyebrow labels over headings.

### Known gaps in the build (not system rules)
- On desktop (1280x800) the active row with its times and Waze button sits below the fold under the form and chips.
- The start-screen spine is assembled from three pieces (`.endpoints::before`, `.search-form::before`, `.submit-bar::before`), and the first two overlap over the endpoints.
