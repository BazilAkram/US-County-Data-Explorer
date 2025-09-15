const map = L.map("map", {
  minZoom: 3,
  boxZoom: false,
  doubleClickZoom: false,
  scrollWheelZoom: true
 }).setView([37.8, -96], 4);

let basemap = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 12, attribution: "&copy; OpenStreetMap"
});
basemap.addTo(map);
const toggleMapBtn = L.control({position:"topright"});
toggleMapBtn.onAdd = function(map) {
  const btn = L.DomUtil.create("button");
  btn.innerText = "Toggle Basemap";
  btn.style.padding = "4px 8px";
  btn.onclick = () => {
    if (map.hasLayer(basemap)) map.removeLayer(basemap);
    else basemap.addTo(map);
  };
  return btn;
};
toggleMapBtn.addTo(map);

const defaultStyle  = { weight: 0.6, color: "#555", fillOpacity: 0.05, fillColor: "#ccc" };
const selectedStyle = { weight: 1.5, color: "#111", fillOpacity: 0.35, fillColor: "#3388ff" };

const sel = new Set();

// UI elements
const panel = document.getElementById("panel");
const togglePanelBtn = document.getElementById("togglePanel");
const clearBtn = document.getElementById("clearBtn");
const stateSelect = document.getElementById("stateSelect");
const fillStateBtn = document.getElementById("fillStateBtn");

const selCount = document.getElementById("selCount");
const namesDiv = document.getElementById("names");
const statsDiv = document.getElementById("stats");
const eduNetDiv= document.getElementById("eduNet");
const raceDiv  = document.getElementById("race");
const ageDiv   = document.getElementById("age");
const incomeDiv= document.getElementById("income");

// State names (lower-48 + DC because we filtered AK/HI/PR/VI in preprocessing)
const STATE_NAMES = {
  "01":"Alabama","02":"Alaska","04":"Arizona","05":"Arkansas","06":"California","08":"Colorado","09":"Connecticut",
  "10":"Delaware","11":"District of Columbia","12":"Florida","13":"Georgia","15":"Hawaii","16":"Idaho","17":"Illinois",
  "18":"Indiana","19":"Iowa","20":"Kansas","21":"Kentucky","22":"Louisiana","23":"Maine","24":"Maryland",
  "25":"Massachusetts","26":"Michigan","27":"Minnesota","28":"Mississippi","29":"Missouri","30":"Montana",
  "31":"Nebraska","32":"Nevada","33":"New Hampshire","34":"New Jersey","35":"New Mexico","36":"New York",
  "37":"North Carolina","38":"North Dakota","39":"Ohio","40":"Oklahoma","41":"Oregon","42":"Pennsylvania",
  "44":"Rhode Island","45":"South Carolina","46":"South Dakota","47":"Tennessee","48":"Texas","49":"Utah",
  "50":"Vermont","51":"Virginia","53":"Washington","54":"West Virginia","55":"Wisconsin","56":"Wyoming",
  "60":"American Samoa","66":"Guam","69":"Northern Mariana Islands","72":"Puerto Rico","78":"U.S. Virgin Islands"
};


// Load data
const geo  = await fetch("./data/counties_enriched.geojson").then(r => r.json());
const stats= await fetch("./data/counties_stats.json").then(r => r.json());

// Populate state dropdown from data present
const haveStatesRaw = [...new Set(geo.features.map(f => f.properties.STATEFP))].sort();
const haveStates = haveStatesRaw.filter(fp => {
   // Keep if any county-equivalent in this state has non-null pop
   return geo.features.some(feat => feat.properties.STATEFP === fp && stats[feat.properties.GEOID]?.pop != null);
 });
stateSelect.innerHTML = haveStates.map(fp => `<option value="${fp}">${STATE_NAMES[fp] || `State ${fp}`}</option>`).join("");

// Build county layer
const layer = L.geoJSON(geo, {
  style: defaultStyle,
  onEachFeature: (f, lyr) => {
    const g  = f.properties.GEOID;
    const nm = f.properties.NAME;

    lyr.on("click", () => {
      if (sel.has(g)) { sel.delete(g); lyr.setStyle(defaultStyle); }
      else { sel.add(g); lyr.setStyle(selectedStyle); }
      renderPanel();
    });
    lyr.on("mouseover", () => lyr.setStyle({ weight: 1.2 }));
    lyr.on("mouseout",  () => lyr.setStyle(sel.has(g) ? selectedStyle : defaultStyle));
    lyr.bindTooltip(nm, { sticky: true });
  }
}).addTo(map);

// Lasso multi-select (Shift + drag)
let isShift = false;
let lassoPoints = [];
let lassoPolyline;

map.on("keydown", (e) => { if (e.originalEvent.key === "Shift") isShift = true; });
map.on("keyup",   (e) => { if (e.originalEvent.key === "Shift") { isShift = false; endLasso(); }});

map.on("mousedown", (e) => {
  if (!isShift) return;
  L.DomEvent.stop(e);                // stop default/propagation
  lassoPoints = [e.latlng];
  lassoPolyline = L.polyline(lassoPoints, { color:"#000", weight:1, dashArray:"4 2" }).addTo(map);
  map.dragging.disable();
  map.boxZoom.disable();
});

map.on("mousemove", (e) => {
  if (!lassoPolyline) return;
  L.DomEvent.stop(e);
  lassoPoints.push(e.latlng);
  lassoPolyline.setLatLngs(lassoPoints);
});

map.on("mouseup", () => { endLasso(); });

function endLasso() {
  if (!lassoPolyline) return;
  const pts = lassoPoints.map(ll => [ll.lng, ll.lat]);
  if (pts.length > 2) {
    pts.push(pts[0]);
    const poly = turf.polygon([pts]);
    // select intersecting counties
    geo.features.forEach(f => {
      const g = f.properties.GEOID;
      if (turf.booleanIntersects(poly, f)) sel.add(g);
    });
    // restyle
    layer.eachLayer(lyr => {
      const g = lyr.feature.properties.GEOID;
      lyr.setStyle(sel.has(g) ? selectedStyle : defaultStyle);
    });
    renderPanel();
  }
  map.removeLayer(lassoPolyline);
  lassoPolyline = null;
  lassoPoints = [];
  map.dragging.enable();
  map.boxZoom.enable();
}

// Controls
clearBtn.onclick = () => {
  sel.clear();
  layer.setStyle(defaultStyle);
  renderPanel();
};

togglePanelBtn.onclick = () => {
  panel.classList.toggle("collapsed");
  togglePanelBtn.textContent = panel.classList.contains("collapsed") ? "Maximize" : "Minimize";
};

fillStateBtn.onclick = () => {
  const fp = stateSelect.value;
  layer.eachLayer(lyr => {
    const st = lyr.feature.properties.STATEFP;
    const g  = lyr.feature.properties.GEOID;
    if (st === fp) sel.add(g);
  });
  layer.eachLayer(lyr => {
    const g = lyr.feature.properties.GEOID;
    lyr.setStyle(sel.has(g) ? selectedStyle : defaultStyle);
  });
  renderPanel();
};

// ---------- Aggregation & Rendering ----------
const M2_PER_KM2 = 1_000_000, M2_PER_MI2 = 2_589_988.110336;
const fmt = (n) => (n == null ? "—" : (+n).toLocaleString());
const fmt1 = (n) => (n == null ? "—" : (+n).toFixed(1));
const pct = (n, d) => (d > 0 && n != null) ? ((n/d)*100).toFixed(1) + "%" : "—";

function summarize(geoids) {
  if (!geoids.length) return null;
  let pop=0, hh=0, pop25=0, aland=0;

  // education/internet weighted sums
  let hs_num=0, ba_num=0, bb_num=0; // numerators
  let hs_den=0, ba_den=0, bb_den=0; // denominators (pop25 / hh)

  // race totals
  let rTot=0, rW=0, rB=0, rN=0, rA=0, rP=0, rO=0, rT=0;

  // age totals
  let aU=0, aM=0, aS=0;

  // income (HH-weighted mean of county medians)
  let inc_weighted_sum = 0, inc_weight = 0;

  for (const g of geoids) {
    const s = stats[g]; if (!s) continue;

    pop += s.pop || 0;
    hh  += s.households || 0;
    pop25 += s.pop25 || 0;

    // area
    const f = geo.features.find(f => f.properties.GEOID === g);
    const ALAND = f?.properties?.ALAND;
    if (Number.isFinite(ALAND)) aland += ALAND;

    // education / internet numerators
    if (s.edu_hs_or_higher_pct && s.pop25) { hs_num += (s.edu_hs_or_higher_pct/100) * s.pop25; hs_den += s.pop25; }
    if (s.edu_ba_or_higher_pct && s.pop25) { ba_num += (s.edu_ba_or_higher_pct/100) * s.pop25; ba_den += s.pop25; }
    if (s.broadband_any_pct && s.households){ bb_num += (s.broadband_any_pct/100) * s.households; bb_den += s.households; }

    // race
    rTot += s.race_total || 0;
    rW   += s.race_white || 0;
    rB   += s.race_black || 0;
    rN   += s.race_native || 0;
    rA   += s.race_asian || 0;
    rP   += s.race_pacific || 0;
    rO   += s.race_other || 0;
    rT   += s.race_two || 0;

    // age
    aU += s.age_under18 || 0;
    aM += s.age_18to64 || 0;
    aS += s.age_65plus || 0;

    // income
    if (s.median_hh_income && s.households) {
      inc_weighted_sum += s.median_hh_income * s.households;
      inc_weight += s.households;
    }
  }

  const area_km2 = aland ? (aland / M2_PER_KM2) : null;
  const density_mi2 = (pop && aland) ? pop / (aland / M2_PER_MI2) : null;

  const hs = hs_den ? (hs_num / hs_den * 100) : null;
  const ba = ba_den ? (ba_num / ba_den * 100) : null;
  const bb = bb_den ? (bb_num / bb_den * 100) : null;

  return {
    pop, hh, pop25, area_km2, density_mi2,
    edu_hs_pct: hs, edu_ba_pct: ba, broadband_pct: bb,
    race: { total:rTot, white:rW, black:rB, native:rN, asian:rA, pacific:rP, other:rO, two:rT },
    age:  { under18:aU, mid:aM, senior:aS, total: (aU+aM+aS) || null },
    income: { median_hh_weighted: (inc_weight ? inc_weighted_sum / inc_weight : null) }
  };
}

function renderPanel() {
  const arr = [...sel];
  selCount.textContent = arr.length;
  namesDiv.innerHTML = arr.slice(0, 12).map(g => `<span class="pill">${stats[g]?.name ?? g}</span>`).join("") + (arr.length > 12 ? ` …` : "");

  if (!arr.length) {
    statsDiv.innerHTML = `<em>No selection</em>`;
    eduNetDiv.innerHTML = raceDiv.innerHTML = ageDiv.innerHTML = incomeDiv.innerHTML = "";
    return;
  }

  const sum = summarize(arr);

  statsDiv.innerHTML = `
    <div><b>Total population:</b> ${fmt(sum.pop)}</div>
    <div><b>Density:</b> ${fmt1(sum.density_mi2)} /mi²</div>
    <div><b>Households:</b> ${fmt(sum.hh)}</div>
  `;

  eduNetDiv.innerHTML = `
    <div><b>Education (25+):</b> HS+ ${sum.edu_hs_pct==null?"—":sum.edu_hs_pct.toFixed(1)+"%"} · BA+ ${sum.edu_ba_pct==null?"—":sum.edu_ba_pct.toFixed(1)+"%"}</div>
    <div><b>Broadband (HH):</b> ${sum.broadband_pct==null?"—":sum.broadband_pct.toFixed(1)+"%"}</div>
  `;

  const r = sum.race, rt = r.total || sum.pop || 0;
  raceDiv.innerHTML = `
    <b>White:</b> ${pct(r.white, rt)} · <b>Black:</b> ${pct(r.black, rt)} · <b>Native:</b> ${pct(r.native, rt)}<br/>
    <b>Asian:</b> ${pct(r.asian, rt)} · <b>Pacific:</b> ${pct(r.pacific, rt)} · <b>Other:</b> ${pct(r.other, rt)} · <b>Two+:</b> ${pct(r.two, rt)}
  `;

  const a = sum.age, at = a.total || sum.pop || 0;
  ageDiv.innerHTML = `
    <b>Under 18:</b> ${pct(a.under18, at)} · <b>18–64:</b> ${pct(a.mid, at)} · <b>65+:</b> ${pct(a.senior, at)}
  `;

  const inc = sum.income;
  incomeDiv.innerHTML = `<b>Median household income (HH-weighted):</b> ${inc.median_hh_weighted ? "$" + Math.round(inc.median_hh_weighted).toLocaleString() : "—"}`;
}

renderPanel();
