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
- [x] Chunk 3a: inspection round, detector (only the old .endpoints padding finding remains), finish review. Verdict: **fix**.
- [x] Chunk 3b (commit bb5bad0): apply the reviewer's fix batch in one go, rebuild once, recapture the same 9 viewports into .impeccable/review/, then a fresh verdict pass (the first reviewer can't be continued after the container restart: use degraded/finish-reviewer.md's Verdict Pass or spawn a fresh reviewer with the fix list).
- [ ] Chunk 3c: DESIGN.md and .impeccable/design.json by the impeccable-documenter.

### Finish review: fix list (round 1)

Keep: the hard-split blue/orange line with the ink-ringed middle station everywhere; the strip of category roundels on one spine; the picked card's category band; yellow only on Waze; the sliding re-sort.

1. First viewport: once there are results, fold the form into the ink band (the trip line becomes the tap-to-edit control), pin that compact band above the map, result chips with counts right under it, so band, chips, map and picked card share one 390x784 view.
2. Selected place's legs: draw straight lines, א blue to the place and the place to ב orange, brightest, with the split route dimmed under them.
3. Middle station hidden under place pins: Leaflet pin-mid needs a zIndexOffset; Google gives it zIndex 1 while places use their number. Put it above all place pins, below the active one.
4. Picked card line: full card width under the two times; label the ends with the place names instead of א/ב and car icons (keep mode icons only when the sides differ); fairness says the difference and the side ("7 דק׳ יותר לצד ב׳") instead of "מאוזן מאוד".
5. Start screen: the form itself is the line (full blue/orange connector), the search button reads as the station on it (not a ring glyph); use the empty lower viewport.
6. List rows: drop the repeated א/ב letters and car icons per row; minutes larger than the name; tighten rows (~138px now) so 7+ stations fit a phone view.
7. Floor: `.place-meta .rating::after { content: ' ★' }` is a glyph; replace with an authored SVG star in the 1.8 stroke.
8. Floor: self-host IBM Plex Sans Hebrew under site/vendor (and add it to sw.js); theme ::selection and caret-color.

Logged, not on the list: on desktop the picked card's times and Waze sit below the fold (secondary channel).

### Verdict pass (round 2): fix

Resolved: 1 (pinned compact band, chips, map, picked card in one phone view), 2 (legs), 3 (middle station on top), 4 (picked card line), 7 (SVG star), 8 (self-hosted font, selection, caret).
Partial: 5 (start screen: the form's vertical א–ב connector and the search station are still two separate lines), 6 (Google-mode rows still ~120–140px; free-mode rows are fine).
New regressions from the fix batch:
- R1: .submit-line and .how::before use a smooth blue→orange gradient (muddy purple middle); the signature line is hard-split. Two near-identical lines are stacked on the start screen.
- R2: phones after results hide the page's h1 with display:none; use the sr-only treatment instead.
- R3: desktop: #result-filters now sits above the "מקומות באמצע" heading, cut off from the list it filters; keep the phone placement, put it back under the heading on desktop.

Remaining work (round 3, the user's call): join the form connector and the search station into one line; tighten Google rows to 7 per phone view; hard stops on the start-screen lines and drop one; sr-only h1; desktop chip placement. Then DESIGN.md by the documenter.
