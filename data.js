/* data.js - browser data layer. Fetches USGS + NWS + pi_readings.json live,
   normalizes, scores (via HABScore), and returns the same payload shape that
   fetch.py writes to data.json. No backend required.

   Mirrors fetch.py. If you change the SITES roster, update both (this file for
   the live site, fetch.py for local snapshots / Pi merging). */
(function (global) {
  "use strict";

  const USGS_IV = "https://waterservices.usgs.gov/nwis/iv/";
  const PARAM_CODES = ["00010", "00060", "00065", "00300"];
  const PARAM_NAMES = {
    "00010": "Water temp (C)", "00060": "Discharge (cfs)",
    "00065": "Gage height (ft)", "00300": "Dissolved O2 (mg/L)",
  };
  const PERIOD = "P7D";

  // Monitored roster (mirror of fetch.py SITES). lat/lng auto-refine from USGS.
  const SITES = [
    { id: "422303071084301", name: "Fresh Pond Buoy (Cambridge)", lat: 42.38417, lng: -71.14528 },
    { id: "01104480", name: "Stony Brook Reservoir at Dam", lat: 42.35565, lng: -71.26506 },
    { id: "01104460", name: "Stony Brook at Rt 20, Waltham", lat: 42.36899, lng: -71.27061 },
    { id: "01104200", name: "Charles River at Wellesley", lat: 42.29899, lng: -71.30533 },
    { id: "01104500", name: "Charles River at Waltham", lat: 42.36482, lng: -71.24168 },
    { id: "01103280", name: "Charles River at Medway", lat: 42.13982, lng: -71.38950 },
  ];

  const BAND_LEGEND = [
    { band: "low", max: 25, color: "#2ecc71" },
    { band: "moderate", max: 50, color: "#f1c40f" },
    { band: "elevated", max: 75, color: "#e67e22" },
    { band: "high", max: 100, color: "#e74c3c" },
  ];

  const CLOUD_COVER = { SKC: 0, CLR: 0, NCD: 0, NSC: 0, FEW: 0.15, SCT: 0.40, BKN: 0.75, OVC: 1, VV: 1 };

  const toNum = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

  async function getJSON(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
    return r.json();
  }

  // ---------- USGS ----------
  async function fetchUSGS(siteIds) {
    const url = `${USGS_IV}?format=json&sites=${siteIds.join(",")}` +
      `&parameterCd=${PARAM_CODES.join(",")}&period=${PERIOD}`;
    const out = {}; // site_id -> {meta:{name,lat,lng}, series:{param:[[Date,val]]}, latest:{param:{...}}}
    let payload;
    try { payload = await getJSON(url); }
    catch (e) { console.warn("[USGS] failed:", e); return out; }

    const tsList = ((payload.value || {}).timeSeries) || [];
    for (const ts of tsList) {
      try {
        const si = ts.sourceInfo || {};
        const codes = si.siteCode || [];
        const sid = codes.length ? codes[0].value : null;
        if (!sid) continue;
        const geo = ((si.geoLocation || {}).geogLocation) || {};
        const lat = toNum(geo.latitude), lng = toNum(geo.longitude);
        const vcodes = (ts.variable || {}).variableCode || [];
        const param = vcodes.length ? vcodes[0].value : null;
        if (!param) continue;
        const blocks = ts.values || [];
        const points = blocks.length ? (blocks[0].value || []) : [];

        const rec = out[sid] || (out[sid] = { meta: {}, series: {}, latest: {} });
        if (si.siteName) rec.meta.name = si.siteName;
        if (lat !== null && lng !== null) { rec.meta.lat = lat; rec.meta.lng = lng; }

        const arr = rec.series[param] || (rec.series[param] = []);
        for (const p of points) {
          const val = toNum(p.value), tt = p.dateTime;
          if (val === null || val <= -999990 || !tt) continue;
          const d = new Date(tt);
          if (isNaN(d)) continue;
          arr.push([d, val]);
          rec.latest[param] = { value: val, timestamp: d.toISOString(), source: "usgs" };
        }
        arr.sort((a, b) => a[0] - b[0]);
      } catch (e) { console.warn("[USGS] skipped a series:", e); }
    }
    return out;
  }

  // ---------- NWS (cached by forecast grid) ----------
  async function fetchWeather(lat, lng, cache) {
    try {
      const pts = await getJSON(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`);
      const props = pts.properties || {};
      const key = `${props.gridId}/${props.gridX}/${props.gridY}`;
      if (cache[key]) return cache[key];

      const weather = { air_temp_c: null, sun_frac: null, precip_mm: null, outlook: [] };

      if (props.forecastGridData) {
        try {
          const grid = (await getJSON(props.forecastGridData)).properties || {};
          weather.outlook = buildOutlook(grid);
        } catch (e) { console.warn("[NWS] grid failed:", e); }
      }
      if (props.observationStations) {
        try {
          const stations = (await getJSON(props.observationStations)).features || [];
          const sid = stations.length ? (stations[0].properties || {}).stationIdentifier : null;
          if (sid) await fillFromObservations(sid, weather);
        } catch (e) { console.warn("[NWS] observations failed:", e); }
      }
      cache[key] = weather;
      return weather;
    } catch (e) {
      console.warn("[NWS] points failed:", e);
      return {};
    }
  }

  function gridSeries(field) {
    const out = [];
    if (!field || !field.values) return out;
    for (const e of field.values) {
      const vt = e.validTime || "";
      if (e.value === null || e.value === undefined || vt.indexOf("/") < 0) continue;
      const d = new Date(vt.split("/")[0]);
      if (!isNaN(d)) out.push([d, Number(e.value)]);
    }
    return out;
  }

  function buildOutlook(grid) {
    const temps = gridSeries(grid.temperature);
    const sky = gridSeries(grid.skyCover);
    const today = new Date().toISOString().slice(0, 10);
    const daily = (series, xf) => {
      const b = {};
      for (const [t, v] of series) {
        const k = t.toISOString().slice(0, 10);
        (b[k] = b[k] || []).push(xf ? xf(v) : v);
      }
      const o = {};
      for (const k in b) o[k] = b[k].reduce((a, c) => a + c, 0) / b[k].length;
      return o;
    };
    const tempDaily = daily(temps);
    const sunDaily = daily(sky, (pct) => 1 - pct / 100);
    const days = [...new Set([...Object.keys(tempDaily), ...Object.keys(sunDaily)])]
      .filter(d => d > today).sort().slice(0, 3);
    return days.map((d, i) => ({
      day: `+${i + 1}d`, date: d,
      air_temp_c: d in tempDaily ? Math.round(tempDaily[d] * 10) / 10 : null,
      sun_frac: d in sunDaily ? Math.round(sunDaily[d] * 100) / 100 : null,
    }));
  }

  async function fillFromObservations(stationId, weather) {
    const start = new Date(Date.now() - 8 * 86400e3).toISOString();
    const data = await getJSON(
      `https://api.weather.gov/stations/${stationId}/observations?start=${start}&limit=300`);
    const feats = data.features || [];
    const now = Date.now();
    const [lagLo, lagHi] = HABScore.PRECIP_LAG_DAYS;
    const tempsRecent = [], sunRecent = [];
    let precipLag = 0, sawPrecip = false;

    for (const f of feats) {
      const p = f.properties || {};
      const t = new Date(p.timestamp);
      if (isNaN(t)) continue;
      const ageDays = (now - t.getTime()) / 86400e3;

      const temp = (p.temperature || {}).value;
      if (temp !== null && temp !== undefined && ageDays <= 1) tempsRecent.push(temp);

      if (ageDays <= 3) {
        const sf = sunFracFromLayers(p.cloudLayers);
        if (sf !== null) sunRecent.push(sf);
      }
      if (ageDays >= lagLo && ageDays <= lagHi) {
        const pr = (p.precipitationLastHour || {}).value;
        if (pr !== null && pr !== undefined) { sawPrecip = true; precipLag += Math.max(0, pr); }
      }
    }
    if (tempsRecent.length)
      weather.air_temp_c = Math.round(tempsRecent.reduce((a, b) => a + b, 0) / tempsRecent.length * 10) / 10;
    if (sunRecent.length)
      weather.sun_frac = Math.round(sunRecent.reduce((a, b) => a + b, 0) / sunRecent.length * 100) / 100;
    weather.precip_mm = sawPrecip ? Math.round(precipLag * 10) / 10 : null;
  }

  function sunFracFromLayers(layers) {
    if (!layers) return 1.0;
    if (!layers.length) return 1.0;
    let cover = 0;
    for (const l of layers) {
      const amt = (l || {}).amount;
      if (amt in CLOUD_COVER) cover = Math.max(cover, CLOUD_COVER[amt]);
    }
    return 1 - cover;
  }

  // ---------- Pi readings (static file) ----------
  async function fetchPi() {
    try {
      const r = await fetch("pi_readings.json", { cache: "no-store" });
      if (!r.ok) return [];
      const txt = (await r.text()).trim();
      if (!txt) return [];
      const readings = JSON.parse(txt);
      return Array.isArray(readings) ? readings : [];
    } catch (e) { console.warn("[Pi] none:", e); return []; }
  }

  function mergePi(usgsBySite, readings) {
    for (const rd of readings) {
      try {
        const sid = String(rd.site_id);
        const d = new Date(rd.timestamp);
        if (isNaN(d)) continue;
        const rec = usgsBySite[sid] || (usgsBySite[sid] = { meta: {}, series: {}, latest: {} });
        const add = (param, val) => {
          if (val === null || val === undefined) return;
          const arr = rec.series[param] || (rec.series[param] = []);
          arr.push([d, Number(val)]);
          arr.sort((a, b) => a[0] - b[0]);
          rec.latest[param] = { value: Number(val), timestamp: d.toISOString(), source: "pi" };
        };
        add("00010", rd.water_temp_c);
        add("00300", rd.do_mgl);
      } catch (e) { console.warn("[Pi] skipped:", e); }
    }
  }

  // ---------- build payload ----------
  async function buildLive(onProgress) {
    const prog = (m) => { try { onProgress && onProgress(m); } catch (e) {} };
    const ids = SITES.map(s => s.id);

    prog("Fetching USGS water data…");
    const usgs = await fetchUSGS(ids);

    prog("Merging Pi logger readings…");
    mergePi(usgs, await fetchPi());

    // refine site coords from USGS metadata
    for (const s of SITES) {
      const m = (usgs[s.id] || {}).meta || {};
      if (m.lat !== undefined) { s.lat = m.lat; s.lng = m.lng; }
    }

    prog("Fetching NWS weather…");
    const weatherCache = {};
    const weatherBySite = {};
    for (const s of SITES) {
      weatherBySite[s.id] = await fetchWeather(s.lat, s.lng, weatherCache);
    }

    prog("Scoring sites…");
    const sites = SITES.map(s => {
      const rec = usgs[s.id] || { meta: {}, series: {}, latest: {} };
      const weather = weatherBySite[s.id] || {};
      const result = HABScore.computeScore({ series: rec.series, weather });
      const seriesOut = {};
      for (const p in rec.series)
        seriesOut[p] = rec.series[p].map(([t, v]) => ({ t: t.toISOString(), v }));
      return {
        id: s.id,
        name: rec.meta.name || s.name,
        lat: rec.meta.lat !== undefined ? rec.meta.lat : s.lat,
        lng: rec.meta.lng !== undefined ? rec.meta.lng : s.lng,
        latest: rec.latest,
        series: seriesOut,
        param_names: PARAM_NAMES,
        weather,
        score: result.score,
        band: result.band,
        contributing_factors: result.contributing_factors,
        outlook: result.outlook,
        n_factors: result.n_factors,
      };
    });

    return {
      generated_at: new Date().toISOString(),
      param_names: PARAM_NAMES,
      band_legend: BAND_LEGEND,
      sites,
      _live: true,
    };
  }

  global.HABData = { buildLive, SITES, BAND_LEGEND, PARAM_NAMES };
})(typeof window !== "undefined" ? window : this);
