"""
score.py - Transparent HAB (harmful algal bloom) risk model for the Charles River
dashboard. NO machine learning: every factor is a documented weighted flag so the
weights can be calibrated by hand against observed blooms over the season.

Risk rises with:  warm water + low/declining flow + sustained sun
                  + recent nutrient-loading precip + DO swings/low DO.

Each factor produces a sub-score in [0, 1]. The final 0-100 score is the
weight-normalized blend of *whichever factors are actually available at a site*
(so a sparse site is scored fairly on what it has, never penalized for missing
sensors). Every factor that contributed is returned in `contributing_factors`
with its points and a plain-English note, so you can always see WHY a site scored
where it did.

Tune the constants in the WEIGHTS / THRESHOLDS blocks below.
"""

from __future__ import annotations
from datetime import datetime, timezone, timedelta

# ---------------------------------------------------------------------------
# WEIGHTS  -- relative importance of each factor. They do NOT need to sum to 1;
# the model normalizes over the factors present at each site. Bump a weight to
# make that signal matter more in the final score.
# ---------------------------------------------------------------------------
W_WATER_TEMP   = 0.35   # measured water temperature (strongest driver)
W_AIR_PROXY    = 0.18   # air-temp proxy, used ONLY when measured water temp is absent
W_FLOW         = 0.25   # discharge: low and/or declining => stagnation
W_SUNSHINE     = 0.15   # sustained low-cloud (sunny) days
W_PRECIP       = 0.15   # recent precip 3-7 days prior => nutrient flush
W_DO           = 0.22   # dissolved-oxygen: low DO or large daily swing (late-stage)

# ---------------------------------------------------------------------------
# THRESHOLDS  -- where each signal turns "on" and where it saturates.
# ---------------------------------------------------------------------------
TEMP_MIN_C        = 18.0   # below this, water-temp contribution is 0
TEMP_MAX_C        = 24.0   # at/above this, water-temp contribution is full (cyano love warmth)

PRECIP_FULL_MM    = 25.0   # ~1 inch of rain in the 3-7d window => full nutrient-flush flag
PRECIP_LAG_DAYS   = (3, 7) # "recent" nutrient flush window, days before now

SUN_FRAC_MIN      = 0.45   # avg sunshine fraction below this contributes nothing
SUN_FRAC_FULL     = 0.85   # sustained sunshine at/above this => full sun flag

DO_LOW_OK_MGL     = 7.0    # DO at/above this is healthy => 0 contribution
DO_LOW_BAD_MGL    = 4.0    # DO at/below this => full low-DO flag
DO_SWING_FULL_MGL = 6.0    # daily DO range at/above this => full swing flag

# Band cutoffs on the 0-100 score.
BAND_CUTS = [(75, "high"), (50, "elevated"), (25, "moderate"), (0, "low")]


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _ramp(x: float, lo: float, hi: float) -> float:
    """Linear 0->1 ramp: 0 at/below lo, 1 at/above hi."""
    if hi == lo:
        return 1.0 if x >= hi else 0.0
    return _clamp01((x - lo) / (hi - lo))


def band_for(score: float) -> str:
    for cut, name in BAND_CUTS:
        if score >= cut:
            return name
    return "low"


# ---------------------------------------------------------------------------
# Individual factor functions. Each returns (subscore_0_1, note) or None if the
# factor cannot be evaluated for this site (missing data).
# ---------------------------------------------------------------------------

def _temp_subscore(series):
    """Measured water temperature. Uses the mean of the most recent ~day."""
    recent = _recent_mean(series, hours=24)
    if recent is None:
        return None
    sub = _ramp(recent, TEMP_MIN_C, TEMP_MAX_C)
    return sub, f"water temp {recent:.1f} C (ramp {TEMP_MIN_C:.0f}-{TEMP_MAX_C:.0f} C)"


def _air_proxy_subscore(air_temp_c):
    """Air-temp PROXY for water warmth; used only when no measured water temp."""
    if air_temp_c is None:
        return None
    sub = _ramp(air_temp_c, TEMP_MIN_C, TEMP_MAX_C)
    return sub, f"air-temp PROXY {air_temp_c:.1f} C (no measured water temp here)"


def _flow_subscore(series):
    """Low and/or declining discharge => stagnation. Site-relative."""
    vals = [v for _, v in series]
    if len(vals) < 8:
        return None
    lo, hi = min(vals), max(vals)
    latest = _recent_mean(series, hours=24)
    if latest is None:
        return None
    # lowness: how close the recent flow sits to the window minimum (1 = at min)
    lowness = 1.0 - ((latest - lo) / (hi - lo)) if hi > lo else 0.0
    # decline: recent mean vs full-window baseline (positive => dropping)
    baseline = sum(vals) / len(vals)
    decline = _clamp01((baseline - latest) / baseline) if baseline > 0 else 0.0
    sub = _clamp01(0.5 * lowness + 0.5 * decline)
    return sub, (f"flow {latest:.1f} cfs: lowness {lowness:.0%}, "
                 f"declining {decline:.0%} vs 7d avg")


def _sunshine_subscore(sun_frac):
    """Sustained sunshine fraction over recent days (1 = clear skies)."""
    if sun_frac is None:
        return None
    sub = _ramp(sun_frac, SUN_FRAC_MIN, SUN_FRAC_FULL)
    return sub, f"sunshine {sun_frac:.0%} of sky clear (recent days)"


def _precip_subscore(precip_mm):
    """Recent precip in the 3-7d lag window => nutrient flush."""
    if precip_mm is None:
        return None
    sub = _ramp(precip_mm, 0.0, PRECIP_FULL_MM)
    return sub, (f"precip {precip_mm:.1f} mm in {PRECIP_LAG_DAYS[0]}-{PRECIP_LAG_DAYS[1]}d "
                 f"prior (nutrient flush)")


def _do_subscore(series):
    """Dissolved oxygen: low DO OR large daily swing => strong late-stage signal."""
    vals = [v for _, v in series]
    if len(vals) < 4:
        return None
    do_min = min(vals)
    # low-DO component: healthy >= DO_LOW_OK, critical <= DO_LOW_BAD
    low_sub = _ramp(DO_LOW_OK_MGL - do_min, 0.0, DO_LOW_OK_MGL - DO_LOW_BAD_MGL)
    # swing component: largest single-day range in the window
    swing = _max_daily_range(series)
    swing_sub = _ramp(swing, 0.0, DO_SWING_FULL_MGL) if swing is not None else 0.0
    sub = max(low_sub, swing_sub)
    return sub, (f"DO min {do_min:.1f} mg/L, daily swing up to {swing:.1f} mg/L"
                 if swing is not None else f"DO min {do_min:.1f} mg/L")


# ---------------------------------------------------------------------------
# Series helpers. Series are lists of (datetime, float), oldest -> newest.
# ---------------------------------------------------------------------------

def _recent_mean(series, hours=24):
    if not series:
        return None
    newest = series[-1][0]
    cutoff = newest - timedelta(hours=hours)
    vals = [v for t, v in series if t >= cutoff]
    if not vals:
        vals = [series[-1][1]]
    return sum(vals) / len(vals)


def _max_daily_range(series):
    """Largest (max-min) within any rolling calendar day in the window."""
    if not series:
        return None
    by_day = {}
    for t, v in series:
        by_day.setdefault(t.date(), []).append(v)
    ranges = [max(vs) - min(vs) for vs in by_day.values() if len(vs) >= 2]
    return max(ranges) if ranges else None


# ---------------------------------------------------------------------------
# Main entry point.
# ---------------------------------------------------------------------------

def compute_score(site):
    """
    site dict expects:
      series: {'00010': [(dt,val)...], '00060': [...], '00300': [...]}  (any subset)
      weather: {'air_temp_c': float|None, 'sun_frac': float|None,
                'precip_mm': float|None, 'outlook': [{day, air_temp_c, sun_frac}, ...]}
    Returns: {score, band, contributing_factors:[...], outlook:[...]}
    """
    series = site.get("series", {})
    weather = site.get("weather", {}) or {}

    contributions = []  # (weight, subscore, label, note)

    # --- water temperature (measured) OR air-temp proxy ---
    temp_series = series.get("00010")
    measured_temp = _temp_subscore(temp_series) if temp_series else None
    if measured_temp:
        contributions.append((W_WATER_TEMP, measured_temp[0], "Water temperature",
                              measured_temp[1], "measured"))
    else:
        proxy = _air_proxy_subscore(weather.get("air_temp_c"))
        if proxy:
            contributions.append((W_AIR_PROXY, proxy[0], "Water temperature (proxy)",
                                  proxy[1], "proxy"))

    # --- flow stagnation ---
    flow = _flow_subscore(series.get("00060")) if series.get("00060") else None
    if flow:
        contributions.append((W_FLOW, flow[0], "Flow stagnation", flow[1], "measured"))

    # --- sunshine ---
    sun = _sunshine_subscore(weather.get("sun_frac"))
    if sun:
        contributions.append((W_SUNSHINE, sun[0], "Sunshine", sun[1], "measured"))

    # --- precip nutrient flush ---
    precip = _precip_subscore(weather.get("precip_mm"))
    if precip:
        contributions.append((W_PRECIP, precip[0], "Nutrient-flush precip",
                              precip[1], "measured"))

    # --- dissolved oxygen ---
    do = _do_subscore(series.get("00300")) if series.get("00300") else None
    if do:
        contributions.append((W_DO, do[0], "Dissolved oxygen", do[1], "measured"))

    score, factors = _blend(contributions)

    return {
        "score": round(score, 1),
        "band": band_for(score),
        "contributing_factors": factors,
        "n_factors": len(contributions),
        "outlook": _outlook(site, contributions),
    }


def _blend(contributions):
    """Weight-normalized blend over whichever factors are present."""
    if not contributions:
        return 0.0, []
    total_w = sum(w for w, *_ in contributions)
    score = 100.0 * sum(w * s for w, s, *_ in contributions) / total_w
    factors = []
    for w, s, label, note, kind in contributions:
        pts = round(100.0 * w * s / total_w, 1)  # points this factor added to score
        factors.append({
            "factor": label,
            "subscore": round(s, 2),     # 0-1 intensity of this signal
            "points": pts,               # actual points contributed to the 0-100 score
            "weight": w,
            "kind": kind,                # "measured" or "proxy"
            "note": note,
        })
    factors.sort(key=lambda f: f["points"], reverse=True)
    return score, factors


def _outlook(site, current_contributions):
    """
    Crude 3-day outlook: hold flow/precip/DO constant and re-blend using the
    NWS-forecast air temp + sky for each of the next 3 days. CLEARLY crude --
    it's a trend hint, not a prediction.
    """
    weather = site.get("weather", {}) or {}
    forecast = weather.get("outlook") or []
    if not forecast:
        return []

    has_measured_temp = bool(site.get("series", {}).get("00010"))
    # carry over everything that isn't temp/sun (flow, precip, DO stay fixed)
    fixed = [(w, s, label, note, kind) for (w, s, label, note, kind)
             in current_contributions
             if label not in ("Sunshine", "Water temperature", "Water temperature (proxy)")]

    out = []
    for f in forecast[:3]:
        contrib = list(fixed)
        # temp: forecast air temp (proxy unless the site measures water temp, in
        # which case we still only have an air-temp-based forward hint -> proxy)
        at = f.get("air_temp_c")
        if at is not None:
            w = W_WATER_TEMP if has_measured_temp else W_AIR_PROXY
            contrib.append((w, _ramp(at, TEMP_MIN_C, TEMP_MAX_C), "temp", "", "proxy"))
        sf = f.get("sun_frac")
        if sf is not None:
            contrib.append((W_SUNSHINE, _ramp(sf, SUN_FRAC_MIN, SUN_FRAC_FULL),
                            "sun", "", "measured"))
        sc, _ = _blend(contrib)
        out.append({"day": f.get("day"), "score": round(sc, 1), "band": band_for(sc)})
    return out


if __name__ == "__main__":
    # tiny self-test
    now = datetime.now(timezone.utc)
    demo = {
        "series": {
            "00010": [(now - timedelta(hours=h), 25.0) for h in range(24, -1, -1)],
            "00060": [(now - timedelta(hours=h), 30 - h * 0.2) for h in range(168, -1, -1)],
        },
        "weather": {"air_temp_c": 28, "sun_frac": 0.9, "precip_mm": 20,
                    "outlook": [{"day": "+1d", "air_temp_c": 29, "sun_frac": 0.9},
                                {"day": "+2d", "air_temp_c": 30, "sun_frac": 0.95},
                                {"day": "+3d", "air_temp_c": 31, "sun_frac": 0.8}]},
    }
    import json
    print(json.dumps(compute_score(demo), indent=2))
