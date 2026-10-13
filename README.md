# Vinted clone

A pixel-matched clone of the Vinted iPhone app's Profile and Listings screens, built as a home-screen web app for an iPhone 18 Pro (402×874pt).

Plain HTML, CSS and JavaScript. No build step, no server-side code.

## What it does

- **Profile tab** — clone of the real screen. "View my listings" opens the listings page with the iOS push animation and edge-swipe back.
- **Listings page** — Active / Sold filter chips, item count, two-column grid, green Sold band, Bump button (inert).
- **Sell tab** — opens the add-listing form: photo, title, price, sold toggle.
- **Tap a listing** — action sheet with Mark as sold / active, Edit, Delete.
- **Views and favourites** are generated, not entered. Each listing gets a random profile at creation and its numbers grow with age along a realistic curve. They are deterministic, so they never jump or go backwards, and they freeze at the moment a listing is marked sold. A listing added as already sold is backdated so it carries believable numbers.
- Everything is stored on the phone: listing data in localStorage, photos in IndexedDB. Photos are resized to 1200px JPEG before saving.

## Running it

Any static file server works. For local testing:

```
python3 -m http.server 8787 --bind 0.0.0.0
```

then open `http://<your-mac-ip>:8787/` on the phone over Wi-Fi.

Preview helpers for desktop browsers (query parameters):

- `?demo=1` — loads six sample listings using photos in `reference/demo/` (not persisted)
- `?sim=1&bottom=34` — simulates the home-indicator safe area
- `#listings` — opens straight onto the listings page; `&filter=sold` or `&filter=active` presets the chip

## Installing on the phone

The app must be served over **HTTPS** for the service worker and offline cache to work. GitHub Pages is the simplest option:

1. Push this repo to GitHub.
2. Settings → Pages → Source: Deploy from branch, `main`, `/ (root)`.
3. Open the Pages URL in Safari on the phone, tap Share → **Add to Home Screen**.

After that it launches full-screen with no Safari chrome. When you deploy a change, bump `VERSION` in `sw.js` so installed phones pick up the new files.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | markup for all screens plus the inline SVG icon set |
| `styles.css` | every size and colour, measured from the reference screenshots |
| `app.js` | storage, stats generation, navigation, form, action sheet |
| `sw.js`, `manifest.webmanifest` | PWA plumbing |
| `assets/` | Inter font files, avatar, app icons |
| `reference/` | the original screenshots the clone was measured against |

## Measurement notes

Colours and layout were sampled from 1206×2622 screenshots (3× scale). Key values:

| Token | Value |
| --- | --- |
| Teal | `#007782` |
| Text | `#15191a` |
| Secondary text | `#5a6566` |
| Section band | `#edf2f2` |
| Banner background | `#edf9f9` |
| Sold band | `#28865a` |
| Chip selected fill | `#e6fafa` |

The app's typeface is not SF Pro. Inter is the closest open face and is bundled locally; per-style letter-spacing brings every measured text run to within half a point of the original width. If you can identify Vinted's actual font, swapping the `@font-face` rules at the top of `styles.css` is all that's needed.
