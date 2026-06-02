/* Charles River HAB Risk Dashboard - frontend.
   Vanilla JS + MapLibre GL. Reads data.json (produced by fetch.py).
   State is held in plain JS variables -- no localStorage/sessionStorage. */

const BAND_COLOR = { low: "#2ecc71", moderate: "#f1c40f", elevated: "#e67e22", high: "#e74c3c" };
const SPARK_PARAMS = [
  { code: "00010", label: "Water temp", unit: "°C", color: "#ff7b6b" },
  { code: "00060", label: "Discharge", unit: "cfs", color: "#6bd6ff" },
  { code: "00300", label: "Dissolved O₂", unit: "mg/L", color: "#9b8cff" },
];

let DATA = null;
let SITES_BY_ID = {};
let selectedId = null;
const markerEls = {};

const $ = (sel, root = document) => root.querySelector(sel);

init();

async function init() {
  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
                  "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
                  "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors",
        },
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    },
    center: [-71.30, 42.30],
    zoom: 10.3,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");

  // Load data: try LIVE in-browser fetch first; fall back to a committed
  // data.json snapshot if the APIs are unreachable.
  const setMsg = (m) => { const el = $("#loaderMsg"); if (el) el.textContent = m; };
  let fromSnapshot = false;
  try {
    if (!window.HABData) throw new Error("data layer missing");
    DATA = await HABData.buildLive(setMsg);
  } catch (eLive) {
    console.warn("Live build failed, trying snapshot:", eLive);
    setMsg("Live data unavailable — loading saved snapshot…");
    try {
      const res = await fetch("data.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      DATA = await res.json();
      fromSnapshot = true;
    } catch (eSnap) {
      hideLoader();
      $("#panel").innerHTML =
        `<div class="err">Couldn't load live data or a saved snapshot.<br><br>
         Live error: ${eLive}<br>Snapshot error: ${eSnap}</div>`;
      $("#panel").classList.add("open");
      return;
    }
  }

  DATA._fromSnapshot = fromSnapshot;
  SITES_BY_ID = Object.fromEntries(DATA.sites.map(s => [s.id, s]));
  renderHeader();
  hideLoader();

  // Markers attach to the map regardless of tile/style load state, so add them
  // directly (avoids a race when the live fetch finishes after the load event).
  DATA.sites.forEach(s => addMarker(map, s));
  fitToSites(map);
}

function hideLoader() {
  const el = $("#loader");
  if (el) el.classList.add("hide");
}

function renderHeader() {
  const gen = new Date(DATA.generated_at);
  const badge = DATA._fromSnapshot
    ? `<span class="fresh snap" title="APIs unreachable; showing last saved snapshot">snapshot</span>`
    : `<span class="fresh live" title="Fetched live from USGS + NWS in your browser">live</span>`;
  $("#gen").innerHTML = "Updated " + gen.toLocaleString() +
    " · " + DATA.sites.length + " sites" + badge;
  $("#legend").innerHTML = DATA.band_legend.map(b =>
    `<span class="item"><span class="dot" style="background:${b.color}"></span>${b.band}</span>`).join("");
}

function addMarker(map, site) {
  if (site.lat == null || site.lng == null) return;
  const el = document.createElement("div");
  el.className = "pin";
  el.style.background = BAND_COLOR[site.band] || "#888";
  el.title = `${site.name} — ${site.band} (${site.score})`;
  el.addEventListener("click", (ev) => { ev.stopPropagation(); selectSite(site.id); });
  markerEls[site.id] = el;
  new maplibregl.Marker({ element: el }).setLngLat([site.lng, site.lat]).addTo(map);
}

function fitToSites(map) {
  const pts = DATA.sites.filter(s => s.lat != null && s.lng != null);
  if (!pts.length) return;
  const b = new maplibregl.LngLatBounds();
  pts.forEach(s => b.extend([s.lng, s.lat]));
  map.fitBounds(b, { padding: 90, maxZoom: 12 });
}

function selectSite(id) {
  selectedId = id;
  Object.entries(markerEls).forEach(([sid, el]) => el.classList.toggle("sel", sid === id));
  renderPanel(SITES_BY_ID[id]);
}

function renderPanel(site) {
  const panel = $("#panel");
  panel.classList.add("open");
  panel.innerHTML = `
    <div class="p-head">
      <div class="close" id="closeBtn">×</div>
      <h2>${esc(site.name)}</h2>
      <div class="meta">${site.lat?.toFixed(4)}, ${site.lng?.toFixed(4)} · ${site.n_factors} factor(s) scored</div>
    </div>
    <div class="section">
      <div class="dial-wrap">
        ${dialSVG(site.score, site.band)}
        <div>
          <div class="dial-num" style="color:${BAND_COLOR[site.band]}">${site.score}</div>
          <div class="dial-band" style="color:${BAND_COLOR[site.band]}">${site.band} risk</div>
          <div class="dial-note">0–100 bloom-risk · higher = more favorable for cyanobacteria</div>
        </div>
      </div>
    </div>
    <div class="section">
      <h3>Why this score — contributing factors</h3>
      ${factorsHTML(site.contributing_factors)}
    </div>
    <div class="section">
      <h3>3-day outlook</h3>
      ${outlookHTML(site.outlook)}
    </div>
    <div class="section">
      <h3>7-day trends</h3>
      ${sparksHTML(site)}
    </div>`;
  $("#closeBtn").addEventListener("click", () => {
    panel.classList.remove("open");
    selectedId = null;
    Object.values(markerEls).forEach(el => el.classList.remove("sel"));
  });
}

/* ---- risk dial (semicircular gauge) ---- */
function dialSVG(score, band) {
  const r = 46, cx = 54, cy = 54, w = 12;
  const frac = Math.max(0, Math.min(1, score / 100));
  const a0 = Math.PI, a1 = Math.PI * (1 - frac); // 180° -> 0°
  const arc = (a) => [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  const [sx, sy] = arc(a0), [bx, by] = arc(0), [ex, ey] = arc(a1);
  const large = frac > 0.5 ? 1 : 0;
  return `<svg class="dial" width="108" height="64" viewBox="0 0 108 64">
    <path d="M${sx} ${sy} A${r} ${r} 0 0 1 ${bx} ${by}" fill="none" stroke="#1b3047" stroke-width="${w}" stroke-linecap="round"/>
    <path d="M${sx} ${sy} A${r} ${r} 0 ${large} 1 ${ex} ${ey}" fill="none" stroke="${BAND_COLOR[band]}" stroke-width="${w}" stroke-linecap="round"/>
  </svg>`;
}

/* ---- factor breakdown ---- */
function factorsHTML(factors) {
  if (!factors || !factors.length)
    return `<div class="empty">No scoreable data at this site right now.</div>`;
  const maxPts = Math.max(...factors.map(f => f.points), 1);
  return factors.map(f => {
    const band = bandForPoints(f.subscore);
    const tag = f.kind === "proxy"
      ? `<span class="tag proxy">proxy</span>`
      : `<span class="tag measured">measured</span>`;
    const wpct = Math.round((f.points / maxPts) * 100);
    return `<div class="factor">
      <div class="row"><span class="name">${esc(f.factor)}${tag}</span>
        <span class="pts">+${f.points.toFixed(1)} pts</span></div>
      <div class="bar"><span style="width:${wpct}%;background:${BAND_COLOR[band]}"></span></div>
      <div class="note">${esc(f.note)}</div>
    </div>`;
  }).join("");
}
function bandForPoints(sub) {
  if (sub >= 0.75) return "high";
  if (sub >= 0.5) return "elevated";
  if (sub >= 0.25) return "moderate";
  return "low";
}

/* ---- outlook ---- */
function outlookHTML(outlook) {
  if (!outlook || !outlook.length)
    return `<div class="empty">No forecast available (NWS data missing).</div>`;
  const chips = outlook.map(o => `
    <div class="ochip">
      <div class="d">${o.day}</div>
      <div class="s" style="color:${BAND_COLOR[o.band]}">${o.score}</div>
      <div class="b" style="color:${BAND_COLOR[o.band]}">${o.band}</div>
    </div>`).join("");
  return `<div class="outlook">${chips}</div>
    <div class="crude">⚠ Crude projection: forward-trends temp + sky from NWS forecast,
    holds flow/precip/DO fixed. A hint, not a prediction.</div>`;
}

/* ---- sparklines ---- */
function sparksHTML(site) {
  return SPARK_PARAMS.map(p => {
    const pts = (site.series && site.series[p.code]) || [];
    if (!pts.length)
      return `<div class="spark"><div class="lbl"><b>${p.label}</b>
        <span class="cur">no sensor here</span></div></div>`;
    const last = pts[pts.length - 1];
    const src = (site.latest[p.code] || {}).source === "pi" ? " · Pi" : "";
    return `<div class="spark">
      <div class="lbl"><b>${p.label}</b>
        <span class="cur">${fmt(last.v)} ${p.unit}${src}</span></div>
      ${sparkSVG(pts, p.color)}
    </div>`;
  }).join("");
}

function sparkSVG(pts, color) {
  const W = 340, H = 46, pad = 3;
  const vals = pts.map(p => p.v);
  const ts = pts.map(p => new Date(p.t).getTime());
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const minT = Math.min(...ts), maxT = Math.max(...ts);
  const spanV = (maxV - minV) || 1, spanT = (maxT - minT) || 1;
  const x = t => pad + ((t - minT) / spanT) * (W - 2 * pad);
  const y = v => H - pad - ((v - minV) / spanV) * (H - 2 * pad);
  const d = pts.map((p, i) => (i ? "L" : "M") + x(ts[i]).toFixed(1) + " " + y(p.v).toFixed(1)).join(" ");
  const area = d + ` L${x(maxT).toFixed(1)} ${H - pad} L${x(minT).toFixed(1)} ${H - pad} Z`;
  const lx = x(maxT).toFixed(1), ly = y(vals[vals.length - 1]).toFixed(1);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${area}" fill="${color}" opacity="0.13"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/>
    <circle cx="${lx}" cy="${ly}" r="2.6" fill="${color}"/>
  </svg>`;
}

/* ---- utils ---- */
function fmt(v) { return (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)); }
function esc(s) { return String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
