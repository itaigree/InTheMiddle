---
version: 1
slug: "site-index-html"
primary_target: "site/index.html"
related_targets: []
---

# Surface brief: the app (site/index.html)

Mode: Operate. One surface: start screen, results, picked place, both maps, share text.
Audience and job: families planning an outing and friends in two cities, on phones (mostly the Android WebView with a banner at the bottom), in daylight. Agree on one fair place, then navigate.
Proof: both travel times on every place; free (OpenStreetMap) mode with no photos or ratings is the main face.
Constraints: Hebrew RTL; no build step; Leaflet and Google maps both draw the same pins; standard controls; not childish, not a deals site, not a bus app (no line numbers or bus imagery).
Memorable moment: changing "what matters more" slides the stations along the line into their new order.

## Direction contract

THESIS: Every place is a station on the line between א and ב, and fairness is where its station sits on that line. Refuses the category default: a map over a list of identical text cards.
OWN-WORLD: The Israeli bus line strip. Ink band carrying the trip line; one cool concrete-grey ramp for every neutral; white surfaces; א blue and ב orange as the line's two ends; six category line colours, each with a drawn single-stroke icon in a station roundel; signal yellow only on buttons that act; minutes set large in tabular figures.
STORY: The visitor reads both sides' times for every place at a glance, sees which side a place favours by where its station sits, picks one, and taps the yellow Waze button; the share message carries the same line.
FIRST VIEWPORT: Results on a phone: ink band (א city, line with the middle station, ב city); chips with category roundels; the map with station pins and the selected place's two legs brightest; the picked card with its category colour as a full header band, both times large, its own line, a full-width yellow Waze button; below, the list as a vertical strip map joined by one line down its start edge.
FORM: Route line (the bus/train line strip), candidate 7 of my 7 grounded directions, chosen after two re-rolls. seed:9ca1f4849224dced
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Build progress (for the next session)

- [x] Chunk 1: tokens and category colours, category icons, list as strip map, picked card with header band, full-width yellow Waze, chips with roundels.
- [x] Chunk 2 (the selected place's two legs are not drawn: there is no per-place route geometry; the route itself is split blue/orange at the middle instead): map pins as station roundels (Leaflet and Google), selected legs brightest, start-screen line with the search button as the middle station, share text with the line, sliding re-sort motion, brand mark redrawn.
- [ ] Chunk 3: inspection rounds, detector, finish review, DESIGN.md by the documenter.
