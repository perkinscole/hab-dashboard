"""
fetch.py - Pull live public water data for the Charles River HAB dashboard,
normalize it into a local SQLite store, score each site, and emit data.json for
the static frontend.

Run:  python3 fetch.py
Then: open index.html  (or:  python3 -m http.server  then visit /index.html)

Sources (all free, no API key):
  - USGS Instantaneous Values API  (water temp / discharge / gage height / DO)
  - NOAA/NWS API                   (air temp proxy, sky cover, recent precip)
  - pi_readings.json               (optional local Pi temp/DO logger, merged in)

Everything is defensive: sites have inconsistent sensors, so we never index
blindly, and the app still works if a source is down or a param is missing.

Where to edit:
  - SITES below  -> add/remove monitoring sites (site IDs + display names)
  - score.py     -> tune the risk-model weights
"""

from __future__ import annotations
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone, timedelta

import requests

import score as scoremod

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "water.db")
DATA_JSON = os.path.join(HERE, "data.json")
PI_JSON = os.path.join(HERE, "pi_readings.json")

USGS_IV = "https://waterservices.usgs.gov/nwis/iv/"
NWS_POINTS = "https://api.weather.gov/points/{lat},{lng}"
# NWS requires a descriptive User-Agent with contact info.
USER_AGENT = "charles-hab-dashboard (educational project; contact: cole@example.com)"

PERIOD = "P7D"
PARAM_CODES = ["00010", "00060", "00065", "00300"]
PARAM_NAMES = {
    "00010": "Water temp (C)",
    "00060": "Discharge (cfs)",
    "00065": "Gage height (ft)",
    "00300": "Dissolved O2 (mg/L)",
}

# --- The monitored roster. site_id is the USGS site number. -----------------
# lat/lng are filled in automatically from USGS metadata; the literal here is a
# fallback used for the NWS weather lookup if USGS metadata is unavailable.
SITES = [
    {"id": "422303071084301", "name": "Fresh Pond Buoy (Cambridge)", "lat": 42.38417, "lng": -71.14528},
    {"id": "01104480",        "name": "Stony Brook Reservoir at Dam", "lat": 42.35565, "lng": -71.26506},
    {"id": "01104460",        "name": "Stony Brook at Rt 20, Waltham", "lat": 42.36899, "lng": -71.27061},
    {"id": "01104200",        "name": "Charles River at Wellesley",   "lat": 42.29899, "lng": -71.30533},
    {"id": "01104500",        "name": "Charles River at Waltham",     "lat": 42.36482, "lng": -71.24168},
    {"id": "01103280",        "name": "Charles River at Medway",      "lat": 42.13982, "lng": -71.38950},
]

REQUEST_TIMEOUT = 45


# ===========================================================================
# SQLite store
# ===========================================================================

def init_db(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS observations (
            site_id   TEXT NOT NULL,
            site_name TEXT,
            lat       REAL,
            lng       REAL,
            param     TEXT NOT NULL,
            value     REAL NOT NULL,
            timestamp TEXT NOT NULL,   -- ISO 8601 UTC
            source    TEXT NOT NULL,   -- 'usgs' | 'pi'
            PRIMARY KEY (site_id, param, timestamp, source)
        )
    """)
    conn.commit()


def upsert(conn, rows):
    """Idempotent: re-running fetch.py replaces, never duplicates."""
    conn.executemany("""
        INSERT OR REPLACE INTO observations
            (site_id, site_name, lat, lng, param, value, timestamp, source)
        VALUES (:site_id, :site_name, :lat, :lng, :param, :value, :timestamp, :source)
    """, rows)
    conn.commit()


# ===========================================================================
# USGS
# ===========================================================================

def fetch_usgs(site_ids):
    """Returns parsed rows + a metadata dict {site_id: {name, lat, lng}}."""
    params = {
        "format": "json",
        "sites": ",".join(site_ids),
        "parameterCd": ",".join(PARAM_CODES),
        "period": PERIOD,
    }
    rows, meta = [], {}
    try:
        r = requests.get(USGS_IV, params=params, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        payload = r.json()
    except Exception as e:
        print(f"  [USGS] request failed: {e}", file=sys.stderr)
        return rows, meta

    ts_list = (payload.get("value", {}) or {}).get("timeSeries", []) or []
    for ts in ts_list:
        try:
            si = ts.get("sourceInfo", {}) or {}
            codes = si.get("siteCode") or []
            site_id = codes[0].get("value") if codes else None
            if not site_id:
                continue
            site_name = si.get("siteName", site_id)
            geo = ((si.get("geoLocation") or {}).get("geogLocation") or {})
            lat = _to_float(geo.get("latitude"))
            lng = _to_float(geo.get("longitude"))
            var = ts.get("variable", {}) or {}
            vcodes = var.get("variableCode") or []
            param = vcodes[0].get("value") if vcodes else None
            if not param:
                continue
            blocks = ts.get("values") or []
            points = blocks[0].get("value", []) if blocks else []
            if lat is not None and lng is not None:
                meta.setdefault(site_id, {"name": site_name, "lat": lat, "lng": lng})
            for p in points:
                val = _to_float(p.get("value"))
                tstamp = p.get("dateTime")
                # USGS uses -999999 as a no-data sentinel; skip it.
                if val is None or val <= -999990 or not tstamp:
                    continue
                rows.append({
                    "site_id": site_id, "site_name": site_name,
                    "lat": lat, "lng": lng, "param": param,
                    "value": val, "timestamp": _to_utc_iso(tstamp), "source": "usgs",
                })
        except Exception as e:  # never let one bad series kill the run
            print(f"  [USGS] skipped a series: {e}", file=sys.stderr)
            continue
    return rows, meta


# ===========================================================================
# NWS weather  (air-temp proxy, sunshine, recent precip, 3-day outlook)
# ===========================================================================

CLOUD_COVER = {  # METAR sky-cover code -> fraction of sky covered
    "SKC": 0.0, "CLR": 0.0, "NCD": 0.0, "NSC": 0.0,
    "FEW": 0.15, "SCT": 0.40, "BKN": 0.75, "OVC": 1.0, "VV": 1.0,
}


def _nws_get(url, **params):
    r = requests.get(url, headers={"User-Agent": USER_AGENT},
                     params=params or None, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    return r.json()


def fetch_weather(lat, lng, cache):
    """Best-effort NWS weather for a point. Cached by forecast grid cell so
    nearby sites share one lookup. Returns dict or {} on failure."""
    try:
        pts = _nws_get(NWS_POINTS.format(lat=round(lat, 4), lng=round(lng, 4)))
        props = pts.get("properties", {}) or {}
        grid_key = (props.get("gridId"), props.get("gridX"), props.get("gridY"))
        if grid_key in cache:
            return cache[grid_key]

        weather = {"air_temp_c": None, "sun_frac": None, "precip_mm": None, "outlook": []}

        # ---- forward-looking grid forecast -> 3-day outlook (temp + sky) ----
        grid_url = props.get("forecastGridData")
        if grid_url:
            try:
                grid = _nws_get(grid_url).get("properties", {}) or {}
                weather["outlook"] = _build_outlook(grid)
            except Exception as e:
                print(f"  [NWS] grid forecast failed: {e}", file=sys.stderr)

        # ---- past observations -> air temp, recent sunshine, recent precip ----
        sta_url = props.get("observationStations")
        if sta_url:
            try:
                stations = _nws_get(sta_url).get("features", []) or []
                if stations:
                    sid = stations[0].get("properties", {}).get("stationIdentifier")
                    if sid:
                        _fill_from_observations(sid, weather)
            except Exception as e:
                print(f"  [NWS] observations failed: {e}", file=sys.stderr)

        cache[grid_key] = weather
        return weather
    except Exception as e:
        print(f"  [NWS] points lookup failed for {lat},{lng}: {e}", file=sys.stderr)
        return {}


def _build_outlook(grid):
    """Average forecast air temp + sunshine per calendar day, next 3 days."""
    temps = _grid_series(grid.get("temperature"))            # degC
    sky = _grid_series(grid.get("skyCover"))                 # % cloud
    today = datetime.now(timezone.utc).date()

    def daily(series, transform=lambda v: v):
        buckets = {}
        for t, v in series:
            buckets.setdefault(t.date(), []).append(transform(v))
        return {d: sum(vs) / len(vs) for d, vs in buckets.items()}

    temp_daily = daily(temps)
    sun_daily = daily(sky, transform=lambda pct: 1.0 - pct / 100.0)  # cloud% -> sun frac
    future_days = sorted(d for d in set(temp_daily) | set(sun_daily) if d > today)[:3]
    out = []
    for i, d in enumerate(future_days, start=1):
        out.append({
            "day": f"+{i}d",
            "date": d.isoformat(),
            "air_temp_c": round(temp_daily.get(d), 1) if d in temp_daily else None,
            "sun_frac": round(sun_daily.get(d), 2) if d in sun_daily else None,
        })
    return out


def _grid_series(field):
    """NWS grid field {values:[{validTime:'<iso>/<dur>', value}]} -> [(dt,val)]."""
    out = []
    if not field:
        return out
    for entry in field.get("values", []) or []:
        vt = entry.get("validTime", "")
        val = entry.get("value")
        if val is None or "/" not in vt:
            continue
        start = vt.split("/")[0]
        try:
            out.append((datetime.fromisoformat(start), float(val)))
        except Exception:
            continue
    return out


def _fill_from_observations(station_id, weather):
    """Pull ~7 days of station obs: air temp (recent mean), recent sunshine
    fraction (from cloud layers), and precip in the 3-7d nutrient-flush window."""
    start = (datetime.now(timezone.utc) - timedelta(days=8)).strftime("%Y-%m-%dT%H:%M:%SZ")
    data = _nws_get(f"https://api.weather.gov/stations/{station_id}/observations",
                    start=start, limit=300)
    feats = data.get("features", []) or []
    now = datetime.now(timezone.utc)
    lag_lo, lag_hi = scoremod.PRECIP_LAG_DAYS

    temps_recent, sun_recent, precip_lag = [], [], 0.0
    saw_precip_field = False
    for f in feats:
        p = f.get("properties", {}) or {}
        t = _parse_dt(p.get("timestamp"))
        if t is None:
            continue
        age_days = (now - t).total_seconds() / 86400.0

        temp = (p.get("temperature") or {}).get("value")
        if temp is not None and age_days <= 1.0:
            temps_recent.append(temp)

        if age_days <= 3.0:
            sf = _sun_frac_from_layers(p.get("cloudLayers"))
            if sf is not None:
                sun_recent.append(sf)

        if lag_lo <= age_days <= lag_hi:
            pr = (p.get("precipitationLastHour") or {}).get("value")
            if pr is not None:
                saw_precip_field = True
                precip_lag += max(0.0, pr)

    if temps_recent:
        weather["air_temp_c"] = round(sum(temps_recent) / len(temps_recent), 1)
    if sun_recent:
        weather["sun_frac"] = round(sum(sun_recent) / len(sun_recent), 2)
    # If the station never reported the precip field we leave it None (unknown,
    # so the score model simply drops the precip factor). If it reported zeros,
    # 0.0 is a real "no recent rain" reading.
    weather["precip_mm"] = round(precip_lag, 1) if saw_precip_field else None


def _sun_frac_from_layers(layers):
    if not layers:
        return 1.0  # explicitly empty layer list => clear
    cover = 0.0
    for layer in layers:
        amt = (layer or {}).get("amount")
        if amt in CLOUD_COVER:
            cover = max(cover, CLOUD_COVER[amt])
    return 1.0 - cover


# ===========================================================================
# Raspberry Pi logger ingest (optional)
# ===========================================================================

def fetch_pi():
    """Merge local Pi readings if present. Schema per row:
    {site_id, timestamp, water_temp_c, do_mgl}."""
    rows = []
    if not os.path.exists(PI_JSON):
        return rows
    try:
        with open(PI_JSON) as fh:
            content = fh.read().strip()
        if not content:
            return rows
        readings = json.loads(content)
    except Exception as e:
        print(f"  [Pi] could not read {PI_JSON}: {e}", file=sys.stderr)
        return rows

    by_id = {s["id"]: s for s in SITES}
    for rd in readings if isinstance(readings, list) else []:
        try:
            sid = str(rd["site_id"])
            ts = _to_utc_iso(rd["timestamp"])
            site = by_id.get(sid, {})
            base = {"site_id": sid, "site_name": site.get("name", sid),
                    "lat": site.get("lat"), "lng": site.get("lng"), "source": "pi"}
            if rd.get("water_temp_c") is not None:
                rows.append({**base, "param": "00010", "value": float(rd["water_temp_c"]),
                             "timestamp": ts})
            if rd.get("do_mgl") is not None:
                rows.append({**base, "param": "00300", "value": float(rd["do_mgl"]),
                             "timestamp": ts})
        except Exception as e:
            print(f"  [Pi] skipped a reading: {e}", file=sys.stderr)
    if rows:
        print(f"  [Pi] merged {len(rows)} readings")
    return rows


# ===========================================================================
# Build data.json from the store
# ===========================================================================

def build_data(conn, weather_by_site):
    out_sites = []
    for s in SITES:
        sid = s["id"]
        cur = conn.execute(
            "SELECT param, value, timestamp, source, site_name, lat, lng "
            "FROM observations WHERE site_id=? ORDER BY timestamp ASC", (sid,))
        rows = cur.fetchall()

        series = {}        # param -> [(dt, val)]
        latest = {}        # param -> {value, timestamp, source}
        name, lat, lng = s["name"], s["lat"], s["lng"]
        for param, value, tstamp, src, snm, slat, slng in rows:
            dt = _parse_dt(tstamp)
            if dt is None:
                continue
            series.setdefault(param, []).append((dt, value))
            latest[param] = {"value": value, "timestamp": tstamp, "source": src}
            if snm:
                name = snm
            if slat is not None:
                lat, lng = slat, slng

        site_for_score = {"series": series, "weather": weather_by_site.get(sid, {})}
        result = scoremod.compute_score(site_for_score)

        out_sites.append({
            "id": sid,
            "name": name,
            "lat": lat,
            "lng": lng,
            "latest": {p: latest[p] for p in latest},
            "series": {p: [{"t": dt.isoformat(), "v": v} for dt, v in pts]
                       for p, pts in series.items()},
            "param_names": PARAM_NAMES,
            "weather": weather_by_site.get(sid, {}),
            "score": result["score"],
            "band": result["band"],
            "contributing_factors": result["contributing_factors"],
            "outlook": result["outlook"],
            "n_factors": result["n_factors"],
        })

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "param_names": PARAM_NAMES,
        "band_legend": [
            {"band": "low", "max": 25, "color": "#2ecc71"},
            {"band": "moderate", "max": 50, "color": "#f1c40f"},
            {"band": "elevated", "max": 75, "color": "#e67e22"},
            {"band": "high", "max": 100, "color": "#e74c3c"},
        ],
        "sites": out_sites,
    }


# ===========================================================================
# small helpers
# ===========================================================================

def _to_float(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _parse_dt(s):
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _to_utc_iso(s):
    dt = _parse_dt(s)
    return dt.isoformat() if dt else s


# ===========================================================================
# main
# ===========================================================================

def main():
    print("Charles River HAB dashboard - fetch")
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    site_ids = [s["id"] for s in SITES]

    print("Fetching USGS instantaneous values...")
    usgs_rows, usgs_meta = fetch_usgs(site_ids)
    print(f"  [USGS] {len(usgs_rows)} observations")
    if usgs_rows:
        upsert(conn, usgs_rows)

    # patch site coords from authoritative USGS metadata where available
    for s in SITES:
        m = usgs_meta.get(s["id"])
        if m:
            s["lat"], s["lng"] = m["lat"], m["lng"]

    print("Fetching Pi logger readings (if any)...")
    pi_rows = fetch_pi()
    if pi_rows:
        upsert(conn, pi_rows)

    print("Fetching NWS weather...")
    weather_cache, weather_by_site = {}, {}
    for s in SITES:
        w = fetch_weather(s["lat"], s["lng"], weather_cache)
        weather_by_site[s["id"]] = w
        tag = "ok" if w else "unavailable"
        print(f"  [NWS] {s['name']}: {tag}")

    print("Scoring + writing data.json...")
    data = build_data(conn, weather_by_site)
    with open(DATA_JSON, "w") as fh:
        json.dump(data, fh, indent=2)

    conn.close()

    # quick console summary
    print("\nRisk summary:")
    for site in data["sites"]:
        print(f"  {site['band'].upper():9s} {site['score']:5.1f}  {site['name']}"
              f"  ({site['n_factors']} factors)")
    print(f"\nWrote {DATA_JSON}")
    print("Open index.html (or run: python3 -m http.server  then visit the page).")


if __name__ == "__main__":
    main()
