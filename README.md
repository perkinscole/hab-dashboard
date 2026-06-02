# Charles River HAB Risk Dashboard (v1)

A small harmful-algal-bloom (HAB) risk dashboard for the Charles River and nearby
fishable waters. It pulls **live, free, no-key public data**, computes a
**transparent threshold-based risk score** (no ML) per site, and shows it on a
MapLibre map with click-through 7-day trends and a crude 3-day outlook.

No cloud, no database server, no auth, no build step.

## Two ways it runs

This is a **fully static site** that works two ways from the same files:

1. **Live in the browser (default).** Opening the page fetches USGS + NWS directly
   from your browser (both APIs allow cross-origin requests) and scores everything
   client-side via `score.js` + `data.js`. Always current, zero backend — this is
   what gets deployed to GitHub Pages. A green **`live`** badge shows in the header.
2. **Snapshot fallback.** If the APIs are unreachable, the page falls back to the
   last `data.json` produced by `python3 fetch.py`, and shows an amber **`snapshot`**
   badge. `fetch.py` is also how the **Raspberry Pi** readings get merged (see below).

`score.py` and `score.js` implement the *same* model — keep them in sync if you tune
weights. (Verified: both produce identical scores on the same data.)

---

## Run it locally

Just serve the folder — no Python needed to *view* the live dashboard:

```bash
cd hab-dashboard
python3 -m http.server 8766    # then open http://localhost:8766/index.html
```

To refresh the **snapshot fallback** (and merge Pi readings) into `data.json`:

```bash
python3 fetch.py               # pulls USGS + NWS, writes water.db + data.json
```

Re-running `fetch.py` is idempotent (SQLite upserts never duplicate).
**`fetch.py` requires** Python 3 + `requests` (`pip install requests`); the live
in-browser path needs nothing but a browser.

---

## Publish to GitHub Pages

The dashboard is plain static files with **relative paths**, so it drops straight
into a GitHub Pages repo (works fine in a subfolder).

The files live at the repo **root**, so they publish at the repo's own Pages URL.

1. Push the repo (include `data.json` for the snapshot fallback, and `pi_readings.json`).
2. In the repo on GitHub: **Settings → Pages → Build and deployment → Source:
   "Deploy from a branch"**, pick `main` and `/ (root)`.
3. Your dashboard is live at
   `https://perkinscole.github.io/hab-dashboard/`.

Because the page fetches live data in the browser on each visit, **the numbers stay
current with no rebuilds** — visitors always see the latest USGS + NWS readings.

### Hourly auto-refresh (optional, already wired)
A GitHub Action at `.github/workflows/hab-refresh.yml` re-runs `fetch.py` every hour
and commits a fresh `data.json`. This keeps the **snapshot fallback** recent so the
page paints instantly even before the live fetch finishes (and covers visitors if an
API is briefly down). It needs no setup beyond having the workflow in the repo —
GitHub runs it on the cron, and you can also trigger it from the repo's **Actions**
tab via **Run workflow**. (Scheduled runs can lag a few minutes and auto-pause after
60 days of repo inactivity; any push re-enables them.)

To embed it on an existing project page, use an iframe:

```html
<iframe src="https://perkinscole.github.io/hab-dashboard/"
        style="width:100%;height:640px;border:0;border-radius:10px"></iframe>
```

> Note: GitHub Pages serves over HTTPS, which the data APIs and map tiles require —
> good. The free OpenStreetMap tiles are fine for a low-traffic class/project page;
> if it ever gets heavy traffic, switch to a tile provider with an API key.

---

## What you get

- **Map** centered on the Charles, one marker per site colored by risk band
  (green → yellow → orange → red).
- **Click a site** → side panel with:
  - a **risk dial** + 0–100 score and band,
  - the **contributing-factors breakdown** (the *why* — each factor's points, a
    plain-English note, and a `measured` vs `proxy` tag),
  - a **3-day outlook** strip (clearly labeled as a crude projection),
  - **7-day sparklines** for water temp, discharge, and dissolved oxygen
    (only the sensors a site actually has are shown).

---

## The data, honestly

The four original Charles mainstem gauges **do not report water temperature or
dissolved oxygen** — only discharge / gage height. Since water temp is the model's
primary driver, the roster was widened to nearby waters that carry the real
sensors:

| Site | Measured here |
|------|---------------|
| **Fresh Pond Buoy** (Cambridge) | water temp — a still reservoir, prime bloom water |
| **Stony Brook Reservoir at Dam** | dissolved oxygen + discharge |
| **Stony Brook at Rt 20** (Waltham) | water temp + discharge |
| **Charles at Wellesley / Waltham / Medway** | discharge (flow-stagnation signal) |

Where a site lacks measured water temp, the model falls back to a **NWS air-temp
proxy**, always tagged `proxy` in the UI so you know it isn't measured. When the
**Raspberry Pi logger** comes online (see below), those sites upgrade to real
temp/DO automatically — no code changes.

### Data sources
- **USGS Instantaneous Values** — `waterservices.usgs.gov/nwis/iv` — temp `00010`,
  discharge `00060`, gage height `00065`, DO `00300`, last 7 days.
- **NOAA / NWS** — `api.weather.gov` — air temp + recent sunshine (past
  observations) and the forward sky/temp forecast (for the outlook). NWS is
  best-effort: if it's down, the score still computes from USGS alone.

---

## Where to edit things

### Add / remove monitored sites
The roster lives in **two places** — update both so live and snapshot agree:
- `data.js` → `SITES` (the live, in-browser path)
- `fetch.py` → `SITES` (snapshot + Pi merging)

```js
// data.js
const SITES = [
  { id: "01104500", name: "Charles River at Waltham", lat: 42.36482, lng: -71.24168 },
  // ... add a USGS site number + display name; lat/lng auto-refine from USGS metadata
];
```
Find USGS site numbers at <https://waterdata.usgs.gov/>. Sites that return no data
are simply skipped — the dashboard never breaks on a missing sensor.

### Tune the risk-model weights
All weights and thresholds are **named constants at the top of `score.py` and
`score.js`** (identical in both). Bump a weight to make that signal matter more:

```python
W_WATER_TEMP = 0.35   # measured water temperature (strongest driver)
W_FLOW       = 0.25   # discharge: low and/or declining => stagnation
W_SUNSHINE   = 0.15   # sustained sunny days
W_PRECIP     = 0.15   # recent precip => nutrient flush
W_DO         = 0.22   # dissolved oxygen: low / large daily swing
TEMP_MIN_C   = 18.0   # temp contribution starts here
TEMP_MAX_C   = 24.0   # ...and saturates here (cyanobacteria love warmth)
```
The model **normalizes over whichever factors a site actually has**, so a sparse
site is scored fairly on what it measures. Re-run `python3 fetch.py` to apply.

---

## Raspberry Pi logger (optional, stubbed for v1)

`pi_readings.json` is an empty `[]` stub. When your Pi water-temp + DO logger is
online, write rows in this schema and re-run `fetch.py` — they merge into the same
normalized store and override the air-temp proxy with real measurements:

```jsonc
[
  {
    "site_id": "422303071084301",   // must match a SITES id
    "timestamp": "2026-06-15T14:30:00Z",
    "water_temp_c": 23.4,
    "do_mgl": 6.1
  }
]
```

---

## Files
| File | Role |
|------|------|
| `index.html` | MapLibre dashboard shell + styles + loading state |
| `app.js` | map, markers, side panel, dial, sparklines, outlook; live-load w/ snapshot fallback |
| `data.js` | **live** in-browser data layer (USGS + NWS + Pi → scored payload) |
| `score.js` | the risk model, in JS (mirror of `score.py`) — used by the live site |
| `fetch.py` | snapshot/Pi path: pulls USGS + NWS + Pi into `water.db`, writes `data.json` |
| `score.py` | the risk model, in Python (mirror of `score.js`) |
| `pi_readings.json` | empty stub for the Pi logger ingest path |
| `water.db` | generated SQLite store (safe to delete; rebuilt on next fetch) |
| `data.json` | generated snapshot payload — the offline fallback for the live site |

---

## Notes & next steps
- The score model is intentionally crude and **meant to be calibrated** against
  blooms you observe this season — adjust the weights/thresholds in `score.py`.
- The 3-day outlook trends temp + sky forward and holds flow/precip/DO fixed; it's
  a hint, not a forecast.
- v1 keeps state in plain JS variables (no localStorage/sessionStorage).
