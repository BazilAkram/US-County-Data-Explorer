const map = L.map("map", { minZoom: 3 }).setView([37.8, -96], 4);
let basemap = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 12, attribution: "&copy; OpenStreetMap"
});
basemap.addTo(map);
const toggleBtn = L.control({position:"topright"});
toggleBtn.onAdd = function(map) {
  const btn = L.DomUtil.create("button");
  btn.innerText = "Toggle Basemap";
  btn.style.padding = "4px 8px";
  btn.onclick = () => {
    if (map.hasLayer(basemap)) map.removeLayer(basemap);
    else basemap.addTo(map);
  };
  return btn;
};
toggleBtn.addTo(map);



const sel = new Set();
const namesDiv = document.getElementById("names");
const selCount = document.getElementById("selCount");
const statsDiv = document.getElementById("stats");

const M2_PER_KM2 = 1_000_000;
const M2_PER_MI2 = 2_589_988.110336;

const geo = await fetch("./data/counties_enriched.geojson").then(r => r.json());
const stats = await fetch("./data/counties_stats.json").then(r => r.json());

function fmtPct(x) { return x == null ? "—" : `${(+x).toFixed(1)}%`; }
function fmtNum(x) { return x == null ? "—" : (+x).toLocaleString(); }
function fmt1(x) { return x == null ? "—" : (+x).toFixed(1); }

function summarize(geoids) {
  if (geoids.length === 0) return null;

  let pop = 0, hh = 0, pop25 = 0, aland = 0;
  let hs_num = 0, ba_num = 0, bb_num = 0;

  for (const g of geoids) {
    const s = stats[g];
    if (!s) continue;
    // counts (safe add)
    if (s.pop) pop += s.pop;
    if (s.households) hh += s.households;
    if (s.pop25) pop25 += s.pop25;
    // area
    const f = geo.features.find(f => (f.properties.GEOID === g));
    const ALAND = f?.properties?.ALAND;
    if (Number.isFinite(ALAND)) aland += ALAND;

    // turn % into numerators, then re-divide (avoids Simpson’s paradox)
    if (s.edu_hs_or_higher_pct && s.pop25) hs_num += s.edu_hs_or_higher_pct/100 * s.pop25;
    if (s.edu_ba_or_higher_pct && s.pop25) ba_num += s.edu_ba_or_higher_pct/100 * s.pop25;
    if (s.broadband_any_pct && s.households) bb_num += s.broadband_any_pct/100 * s.households;
  }

  const area_km2 = aland ? (aland / M2_PER_KM2) : null;
  const density_km2 = (pop && area_km2) ? pop / area_km2 : null;
  const density_mi2 = (pop && aland) ? pop / (aland / M2_PER_MI2) : null;

  const hs_pct = (pop25 ? (hs_num / pop25 * 100) : null);
  const ba_pct = (pop25 ? (ba_num / pop25 * 100) : null);
  const bb_pct = (hh ? (bb_num / hh * 100) : null);

  return { pop, households: hh, pop25, area_km2, density_km2, density_mi2, hs_pct, ba_pct, bb_pct };
}

function renderPanel() {
  const arr = [...sel];
  selCount.textContent = arr.length;
  namesDiv.innerHTML = arr.slice(0, 12).map(g => `<span class="pill">${stats[g]?.name ?? g}</span>`).join("") +
    (arr.length > 12 ? ` …` : "");
  const sum = summarize(arr);
  if (!sum) { statsDiv.innerHTML = `<em>No selection</em>`; return; }
  statsDiv.innerHTML = `
    <div><b>Total population:</b> ${fmtNum(sum.pop)}</div>
    <div><b>Density:</b> ${fmt1(sum.density_mi2)} /mi² (${fmt1(sum.density_km2)} /km²)</div>
    <div style="margin-top:6px"><b>Education (25+):</b>
      HS+ ${fmtPct(sum.hs_pct)} · BA+ ${fmtPct(sum.ba_pct)}</div>
    <div><b>Households:</b> ${fmtNum(sum.households)} · <b>Broadband:</b> ${fmtPct(sum.bb_pct)}</div>
  `;
}

const defaultStyle = { weight: 0.6, color: "#555", fillOpacity: 0.05, fillColor: "#ccc" };
const selectedStyle = { weight: 1.5, color: "#111", fillOpacity: 0.35, fillColor: "#3388ff" };

const layer = L.geoJSON(geo, {
  style: defaultStyle,
  onEachFeature: (f, lyr) => {
    const g = f.properties.GEOID;
    const nm = f.properties.NAME;

    lyr.on("click", () => {
      if (sel.has(g)) { sel.delete(g); lyr.setStyle(defaultStyle); }
      else           { sel.add(g);     lyr.setStyle(selectedStyle); }
      renderPanel();
    });

    lyr.on("mouseover", () => lyr.setStyle({ weight: 1.2 }));
    lyr.on("mouseout",  () => lyr.setStyle(sel.has(g) ? selectedStyle : defaultStyle));

    lyr.bindTooltip(nm, { sticky: true });
  }
}).addTo(map);

map.on("dblclick", () => {
  sel.clear();
  layer.setStyle(defaultStyle);
  renderPanel();
});
