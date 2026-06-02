/* score.js - browser port of score.py. Transparent HAB risk model (NO ML).
   Keep this in sync with score.py if you tune one or the other.
   Series passed in are arrays of [Date, Number] sorted oldest -> newest. */
(function (global) {
  "use strict";

  // --- WEIGHTS (relative; model normalizes over factors present at a site) ---
  const W_WATER_TEMP = 0.35;  // measured water temperature (strongest driver)
  const W_AIR_PROXY  = 0.18;  // air-temp proxy, only when measured water temp absent
  const W_FLOW       = 0.25;  // discharge: low and/or declining => stagnation
  const W_SUNSHINE   = 0.15;  // sustained low-cloud (sunny) days
  const W_PRECIP     = 0.15;  // recent precip 3-7d prior => nutrient flush
  const W_DO         = 0.22;  // dissolved oxygen: low DO or large daily swing

  // --- THRESHOLDS ---
  const TEMP_MIN_C = 18.0, TEMP_MAX_C = 24.0;
  const PRECIP_FULL_MM = 25.0, PRECIP_LAG_DAYS = [3, 7];
  const SUN_FRAC_MIN = 0.45, SUN_FRAC_FULL = 0.85;
  const DO_LOW_OK_MGL = 7.0, DO_LOW_BAD_MGL = 4.0, DO_SWING_FULL_MGL = 6.0;

  const BAND_CUTS = [[75, "high"], [50, "elevated"], [25, "moderate"], [0, "low"]];

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const ramp = (x, lo, hi) => (hi === lo ? (x >= hi ? 1 : 0) : clamp01((x - lo) / (hi - lo)));

  function bandFor(score) {
    for (const [cut, name] of BAND_CUTS) if (score >= cut) return name;
    return "low";
  }

  function recentMean(series, hours) {
    if (!series || !series.length) return null;
    const newest = series[series.length - 1][0].getTime();
    const cutoff = newest - hours * 3600e3;
    const vals = series.filter(([t]) => t.getTime() >= cutoff).map(([, v]) => v);
    const use = vals.length ? vals : [series[series.length - 1][1]];
    return use.reduce((a, b) => a + b, 0) / use.length;
  }

  function maxDailyRange(series) {
    if (!series || !series.length) return null;
    const byDay = {};
    for (const [t, v] of series) {
      const k = t.toISOString().slice(0, 10);
      (byDay[k] = byDay[k] || []).push(v);
    }
    const ranges = Object.values(byDay).filter(vs => vs.length >= 2)
      .map(vs => Math.max(...vs) - Math.min(...vs));
    return ranges.length ? Math.max(...ranges) : null;
  }

  // --- factor functions: return [subscore, note] or null ---
  function tempSub(series) {
    const r = recentMean(series, 24);
    if (r === null) return null;
    return [ramp(r, TEMP_MIN_C, TEMP_MAX_C),
      `water temp ${r.toFixed(1)} C (ramp ${TEMP_MIN_C}-${TEMP_MAX_C} C)`];
  }
  function airProxySub(airC) {
    if (airC === null || airC === undefined) return null;
    return [ramp(airC, TEMP_MIN_C, TEMP_MAX_C),
      `air-temp PROXY ${airC.toFixed(1)} C (no measured water temp here)`];
  }
  function flowSub(series) {
    if (!series || series.length < 8) return null;
    const vals = series.map(([, v]) => v);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const latest = recentMean(series, 24);
    if (latest === null) return null;
    const lowness = hi > lo ? 1 - (latest - lo) / (hi - lo) : 0;
    const baseline = vals.reduce((a, b) => a + b, 0) / vals.length;
    const decline = baseline > 0 ? clamp01((baseline - latest) / baseline) : 0;
    const sub = clamp01(0.5 * lowness + 0.5 * decline);
    return [sub, `flow ${latest.toFixed(1)} cfs: lowness ${Math.round(lowness * 100)}%, ` +
      `declining ${Math.round(decline * 100)}% vs 7d avg`];
  }
  function sunSub(sunFrac) {
    if (sunFrac === null || sunFrac === undefined) return null;
    return [ramp(sunFrac, SUN_FRAC_MIN, SUN_FRAC_FULL),
      `sunshine ${Math.round(sunFrac * 100)}% of sky clear (recent days)`];
  }
  function precipSub(mm) {
    if (mm === null || mm === undefined) return null;
    return [ramp(mm, 0, PRECIP_FULL_MM),
      `precip ${mm.toFixed(1)} mm in ${PRECIP_LAG_DAYS[0]}-${PRECIP_LAG_DAYS[1]}d prior (nutrient flush)`];
  }
  function doSub(series) {
    if (!series || series.length < 4) return null;
    const vals = series.map(([, v]) => v);
    const doMin = Math.min(...vals);
    const lowS = ramp(DO_LOW_OK_MGL - doMin, 0, DO_LOW_OK_MGL - DO_LOW_BAD_MGL);
    const swing = maxDailyRange(series);
    const swingS = swing !== null ? ramp(swing, 0, DO_SWING_FULL_MGL) : 0;
    const sub = Math.max(lowS, swingS);
    const note = swing !== null
      ? `DO min ${doMin.toFixed(1)} mg/L, daily swing up to ${swing.toFixed(1)} mg/L`
      : `DO min ${doMin.toFixed(1)} mg/L`;
    return [sub, note];
  }

  function blend(contributions) {
    if (!contributions.length) return [0, []];
    const totalW = contributions.reduce((a, c) => a + c.w, 0);
    const score = 100 * contributions.reduce((a, c) => a + c.w * c.s, 0) / totalW;
    const factors = contributions.map(c => ({
      factor: c.label,
      subscore: Math.round(c.s * 100) / 100,
      points: Math.round((100 * c.w * c.s / totalW) * 10) / 10,
      weight: c.w,
      kind: c.kind,
      note: c.note,
    })).sort((a, b) => b.points - a.points);
    return [score, factors];
  }

  function outlook(site, current) {
    const forecast = ((site.weather || {}).outlook) || [];
    if (!forecast.length) return [];
    const hasMeasuredTemp = !!(site.series && site.series["00010"]);
    const fixed = current.filter(c =>
      !["Sunshine", "Water temperature", "Water temperature (proxy)"].includes(c.label));
    const out = [];
    for (const f of forecast.slice(0, 3)) {
      const contrib = fixed.slice();
      if (f.air_temp_c !== null && f.air_temp_c !== undefined) {
        contrib.push({ w: hasMeasuredTemp ? W_WATER_TEMP : W_AIR_PROXY,
          s: ramp(f.air_temp_c, TEMP_MIN_C, TEMP_MAX_C), label: "temp", note: "", kind: "proxy" });
      }
      if (f.sun_frac !== null && f.sun_frac !== undefined) {
        contrib.push({ w: W_SUNSHINE, s: ramp(f.sun_frac, SUN_FRAC_MIN, SUN_FRAC_FULL),
          label: "sun", note: "", kind: "measured" });
      }
      const [sc] = blend(contrib);
      out.push({ day: f.day, score: Math.round(sc * 10) / 10, band: bandFor(sc) });
    }
    return out;
  }

  function computeScore(site) {
    const series = site.series || {};
    const weather = site.weather || {};
    const contributions = [];
    const push = (w, sub, label, kind) => {
      if (sub) contributions.push({ w, s: sub[0], label, note: sub[1], kind });
    };

    const measuredTemp = series["00010"] ? tempSub(series["00010"]) : null;
    if (measuredTemp) push(W_WATER_TEMP, measuredTemp, "Water temperature", "measured");
    else push(W_AIR_PROXY, airProxySub(weather.air_temp_c), "Water temperature (proxy)", "proxy");

    if (series["00060"]) push(W_FLOW, flowSub(series["00060"]), "Flow stagnation", "measured");
    push(W_SUNSHINE, sunSub(weather.sun_frac), "Sunshine", "measured");
    push(W_PRECIP, precipSub(weather.precip_mm), "Nutrient-flush precip", "measured");
    if (series["00300"]) push(W_DO, doSub(series["00300"]), "Dissolved oxygen", "measured");

    const [score, factors] = blend(contributions);
    return {
      score: Math.round(score * 10) / 10,
      band: bandFor(score),
      contributing_factors: factors,
      n_factors: contributions.length,
      outlook: outlook(site, contributions),
    };
  }

  global.HABScore = { computeScore, bandFor, PRECIP_LAG_DAYS,
    TEMP_MIN_C, TEMP_MAX_C, SUN_FRAC_MIN, SUN_FRAC_FULL };
})(typeof window !== "undefined" ? window : this);
