// Map with basemap toggle (blank ↔ OSM)
const map = L.map("map", { minZoom: 3, boxZoom: false, doubleClickZoom: false }).setView([37.8, -96], 4);
let osm = null;
const toggleBasemapBtn = document.getElementById("toggleBasemap");
toggleBasemapBtn.onclick = () => {
  if (osm) {
    map.removeLayer(osm); osm = null; toggleBasemapBtn.textContent = "OSM On";
  } else {
    osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 12, attribution: "&copy; OpenStreetMap" }).addTo(map);
    toggleBasemapBtn.textContent = "OSM Off";
  }
};

const defaultStyle  = { weight: 0.6, color: "#555", fillOpacity: 0.05, fillColor: "#ccc" };
const selectedStyle = { weight: 1.4, color: "#111", fillOpacity: 0.35, fillColor: "#3388ff" };

const sel = new Set();

// UI refs
const panel = document.getElementById("panel");
const toggleBtn = document.getElementById("togglePanel");
const clearBtn = document.getElementById("clearBtn");
const stateSelect = document.getElementById("stateSelect");
const fillStateBtn = document.getElementById("fillStateBtn");

const selCount = document.getElementById("selCount");
const namesDiv = document.getElementById("names");
const coreDiv  = document.getElementById("core");
const eduNetDiv= document.getElementById("eduNet");
const raceDiv  = document.getElementById("race");
const ageDiv   = document.getElementById("age");
const incomeDiv= document.getElementById("income");
const economyDiv= document.getElementById("economy");
const housingDiv= document.getElementById("housing");
const socialDiv = document.getElementById("social");

// State names (incl territories; we’ll filter out ones without pop data)
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
const V = Date.now(); // dev-only
const geo  = await fetch("./data/counties_enriched.geojson").then(r => r.json());
const stats= await fetch("./data/counties_stats.json").then(r => r.json());

// Populate state dropdown from those that actually have pop data
const haveStatesRaw = [...new Set(geo.features.map(f => f.properties.STATEFP))].sort();
const haveStates = haveStatesRaw.filter(fp =>
  geo.features.some(feat => feat.properties.STATEFP === fp && stats[feat.properties.GEOID]?.pop != null)
);
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
    lyr.on("mouseover", () => lyr.setStyle({ weight: 1.0 }));
    lyr.on("mouseout",  () => lyr.setStyle(sel.has(g) ? selectedStyle : defaultStyle));
    lyr.bindTooltip(nm, { sticky: true });
  }
}).addTo(map);

// Lasso (Shift + drag)
let isShift = false;
let lassoPoints = [];
let lassoPolyline;
map.on("keydown", (e) => { if (e.originalEvent.key === "Shift") isShift = true; });
map.on("keyup",   (e) => { if (e.originalEvent.key === "Shift") { isShift = false; endLasso(); }});
map.on("mousedown", (e) => {
  if (!isShift) return;
  L.DomEvent.stop(e);
  lassoPoints = [e.latlng];
  lassoPolyline = L.polyline(lassoPoints, { color:"#000", weight:1, dashArray:"4 2" }).addTo(map);
  map.dragging.disable();
});
map.on("mousemove", (e) => {
  if (!lassoPolyline) return; L.DomEvent.stop(e);
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
    geo.features.forEach(f => {
      const g = f.properties.GEOID;
      if (turf.booleanIntersects(poly, f)) sel.add(g);
    });
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
}

// Controls
clearBtn.onclick = () => { sel.clear(); layer.setStyle(defaultStyle); renderPanel(); };
toggleBtn.onclick = () => {
  panel.classList.toggle("collapsed");
  toggleBtn.textContent = panel.classList.contains("collapsed") ? "Maximize" : "Minimize";
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

// ---------- Aggregation ----------
const M2_PER_MI2 = 2_589_988.110336;
const fmt = (n) => (n == null ? "—" : (+n).toLocaleString());
const fmt1 = (n) => (n == null ? "—" : (+n).toFixed(1));
const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString());
const pct = (n, d) => (d > 0 && n != null) ? ((n/d)*100).toFixed(1) + "%" : "—";
const clampPct = (x) => x==null ? null : Math.max(0, Math.min(100, x));

function sumAgeDetail(ag) {
  // Return cohorts: 0–4, 5–17, 18–24, 25–44, 45–64, 65–74, 75+
  const z = (k)=>ag[k]||0;
  return {
    a0_4:  z("a0_4"),
    a5_17: z("a5_9")+z("a10_14")+z("a15_19")- (z("a20_24")? z("a15_19") : 0), // keep 15-17 approx: trim a15_19 by 2/5 ≈ 0.4 (too fussy for now) — simpler: group 5–19 as proxy:
    a5_19: z("a5_9")+z("a10_14")+z("a15_19"),
    a18_24: z("a20_24"), // proxy for 18–24 (close enough for panel)
    a25_44: z("a25_29")+z("a30_34")+z("a35_39")+z("a40_44"),
    a45_64: z("a45_49")+z("a50_54")+z("a55_59")+z("a60_64"),
    a65_74: z("a65_69")+z("a70_74"),
    a75p:   z("a75_79")+z("a80p")
  };
}

function summarize(geoids) {
  if (!geoids.length) return null;

  let pop=0, hh=0, pop25=0, aland=0;

  // education/internet weighted sums
  let hs_num=0, ba_num=0, bb_num=0, hs_den=0, ba_den=0, bb_den=0;

  // race & hisp
  let rTot=0,rW=0,rB=0,rN=0,rA=0,rP=0,rO=0,rT=0, hisp=0, hisp_base=0;

  // age
  let ageAgg = { a0_4:0, a5_19:0, a18_24:0, a25_44:0, a45_64:0, a65_74:0, a75p:0 };

  // income distribution bins sum
  const BINS = new Array(16).fill(0);
  let inc_total = 0;
  let inc_med_wsum = 0, inc_med_w = 0; // for HH-weighted median of county medians

  // economy / housing
  let e_total16=0,e_inLF=0,e_civLF=0,e_emp=0,e_unemp=0;
  let occ=0, own=0, rent=0;
  let rent_median_wsum=0, rent_median_w=0;
  let yb_tot=0, yb_pre80=0, yb_80_99=0, yb_00_09=0, yb_10p=0;

  // social (robust)
  let foreign_cnt=0, foreign_den=0;
  let lang_base5_sum = 0, eng_only_sum = 0, spanish_sum = 0;

  for (const g of geoids) {
    const s = stats[g]; if (!s) continue;

    pop += s.pop || 0;
    hh  += s.households || 0;
    pop25 += s.pop25 || 0;

    // area (m²)
    const feat = geo.features.find(f => f.properties.GEOID === g);
    const ALAND = feat?.properties?.ALAND;
    if (Number.isFinite(ALAND)) aland += ALAND;

    // edu/net weighted by bases
    if (s.edu_hs_or_higher_pct && s.pop25) { hs_num += (s.edu_hs_or_higher_pct/100)*s.pop25; hs_den += s.pop25; }
    if (s.edu_ba_or_higher_pct && s.pop25) { ba_num += (s.edu_ba_or_higher_pct/100)*s.pop25; ba_den += s.pop25; }
    if (s.broadband_any_pct && s.households){ bb_num += (s.broadband_any_pct/100)*s.households; bb_den += s.households; }

    // race
    rTot += s.race_total || 0; rW += s.race_white || 0; rB += s.race_black || 0; rN += s.race_native || 0;
    rA += s.race_asian || 0; rP += s.race_pacific || 0; rO += s.race_other || 0; rT += s.race_two || 0;
    hisp += s.hisp_total || 0; hisp_base += s.hisp_base || (s.pop||0);

    // age cohorts
    const ad = sumAgeDetail(s.age_detail || {});
    ageAgg.a0_4   += ad.a0_4;
    ageAgg.a5_19  += ad.a5_19;
    ageAgg.a18_24 += ad.a18_24;
    ageAgg.a25_44 += ad.a25_44;
    ageAgg.a45_64 += ad.a45_64;
    ageAgg.a65_74 += ad.a65_74;
    ageAgg.a75p   += ad.a75p;

    // income dist
    if (Array.isArray(s.inc_bins) && s.inc_bins.length === 16) {
      for (let i=0;i<16;i++) BINS[i] += s.inc_bins[i] || 0;
      inc_total += s.inc_total || 0;
    }
    // median income
    if (s.median_hh_income && s.households) {
      inc_med_wsum += s.median_hh_income * s.households;
      inc_med_w += s.households;
    }

    // economy / housing
    e_total16 += s.emp_total16 || 0; e_inLF += s.emp_inLF || 0; e_civLF += s.emp_civLF || 0; e_emp += s.emp_employed || 0; e_unemp += s.emp_unemployed || 0;
    occ += s.occ_units || 0; own += s.owner_occ || 0; rent += s.renter_occ || 0;
    if (s.med_rent && s.renter_occ) { rent_median_wsum += s.med_rent*s.renter_occ; rent_median_w += s.renter_occ; }
    yb_tot += s.yb_total || 0; yb_pre80 += s.yb_pre80 || 0; yb_80_99 += s.yb_80_99 || 0; yb_00_09 += s.yb_00_09 || 0; yb_10p += s.yb_10p || 0;

    // social (robust) — weight by population; clamp later
    if (s.foreign_total!=null) foreign_cnt += s.foreign_total;
    if (s.foreign_base!=null)  foreign_den += s.foreign_base;
    if (s.lang_base5 != null)  lang_base5_sum += s.lang_base5;
    if (s.eng_only != null)    eng_only_sum   += s.eng_only;
    if (s.spanish != null)     spanish_sum    += s.spanish;
  }

  // derived
  const area_mi2 = aland ? (aland / M2_PER_MI2) : null;

  const hs = hs_den ? (hs_num/hs_den*100) : null;
  const ba = ba_den ? (ba_num/ba_den*100) : null;
  const bb = bb_den ? (bb_num/bb_den*100) : null;

  // income mean + P20/P80 from bins
  const binEdges = [
    [0,10000],[10000,15000],[15000,20000],[20000,25000],[25000,30000],
    [30000,35000],[35000,40000],[40000,45000],[45000,50000],[50000,60000],
    [60000,75000],[75000,100000],[100000,125000],[125000,150000],[150000,200000],[200000,250000] // top open bin capped at 250k
  ];
  const median_income = inc_med_w ? (inc_med_wsum / inc_med_w) : null;

  const binMids = binEdges.map(([a,b]) => (a+b)/2);
  let mean_income = null, p20=null, p80=null;
  if (inc_total > 0) {
    // mean
    let sum=0;
    for (let i=0;i<16;i++) sum += BINS[i]*binMids[i];
    mean_income = sum / inc_total;

    // percentiles by linear interpolation within bin
    const targets = [0.2*inc_total, 0.8*inc_total];
    const cum = [];
    let acc=0; for (let i=0;i<16;i++){ acc += BINS[i]; cum[i]=acc; }
    function quantile(t){
      for (let i=0;i<16;i++){
        if (t <= cum[i]){
          const prev = i===0 ? 0 : cum[i-1];
          const within = BINS[i] ? (t - prev)/BINS[i] : 0;
          const [a,b] = binEdges[i];
          return a + within*(b-a);
        }
      }
      return binEdges[15][1];
    }
    p20 = quantile(targets[0]);
    p80 = quantile(targets[1]);
  }

  // economy
  const unemp_rate = (e_civLF>0) ? (e_unemp/e_civLF*100) : null;
  const lf_participation = (e_total16>0) ? (e_inLF/e_total16*100) : null;

  // housing
  const owner_pct = occ? (own/occ*100): null;
  const renter_pct= occ? (rent/occ*100): null;
  const med_rent = rent_median_w ? (rent_median_wsum/rent_median_w) : null;

  // social (clamped)
  const foreign = clampPct(foreign_den ? (foreign_cnt/foreign_den*100) : null);
  const lang_other_pct = (lang_base5_sum != null && lang_base5_sum > 0 && eng_only_sum != null)
    ? Math.max(0, Math.min(100, ((lang_base5_sum - eng_only_sum) / lang_base5_sum) * 100))
    : null;

  const spanish_pct = (lang_base5_sum != null && lang_base5_sum > 0 && spanish_sum != null)
    ? Math.max(0, Math.min(100, (spanish_sum / lang_base5_sum) * 100))
    : null;


  return {
    pop, hh, pop25, area_mi2,
    edu_hs_pct: hs, edu_ba_pct: ba, broadband_pct: bb,
    race: { total:rTot, white:rW, black:rB, native:rN, asian:rA, pacific:rP, other:rO, two:rT,
            hisp_pct: (hisp_base? (hisp/hisp_base*100): null) },
    age:  ageAgg,
    income: { median: median_income, mean: mean_income, p20, p80 },
    economy: { lf_participation, unemp_rate, inLF: e_inLF, employed: e_emp, unemployed: e_unemp },
    housing: {
      occupied: occ, owner: own, renter: rent,
      owner_pct, renter_pct, median_rent: med_rent,
      yearbuilt: {
        pre1980_pct: yb_tot? (yb_pre80/yb_tot*100): null,
        y1980_1999_pct: yb_tot? (yb_80_99/yb_tot*100): null,
        y2000_2009_pct: yb_tot? (yb_00_09/yb_tot*100): null,
        y2010plus_pct: yb_tot? (yb_10p/yb_tot*100): null
      }
    },
    social: { foreign_born_pct: foreign, lang_other_pct: lang_other_pct, spanish_home_pct: spanish_pct}
  };
}

function renderKV(el, rows) {
  el.innerHTML = rows.filter(Boolean).map(([k, v]) => `<div><b>${k}</b></div><div>${v}</div>`).join("");
}

function renderPanel() {
  const arr = [...sel];
  selCount.textContent = arr.length;
  namesDiv.innerHTML = arr.slice(0, 12).map(g => `<span class="pill">${stats[g]?.name ?? g}</span>`).join("") + (arr.length > 12 ? ` …` : "");
  if (!arr.length) {
    [coreDiv, eduNetDiv, raceDiv, ageDiv, incomeDiv, economyDiv, housingDiv, socialDiv].forEach(d => d.innerHTML = "<div><em>No selection</em></div>");
    return;
  }

  const s = summarize(arr);

  renderKV(coreDiv, [
    ["Total population", fmt(s.pop)],
    ["Total area", s.area_mi2==null ? "—" : `${fmt1(s.area_mi2)} mi² (${fmt1(s.area_mi2*2.58999)} km²)`],
    ["Density", (s.area_mi2 && s.pop) ? `${fmt1(s.pop/s.area_mi2)} /mi²  (${fmt1(s.pop/(s.area_mi2*2.58999))} /km²)` : "—"],
    ["Households", fmt(s.hh)]
  ]);

  renderKV(eduNetDiv, [
    ["HS+ (25+)", s.edu_hs_pct==null ? "—" : `${s.edu_hs_pct.toFixed(1)}%`],
    ["BA+ (25+)", s.edu_ba_pct==null ? "—" : `${s.edu_ba_pct.toFixed(1)}%`],
    ["Broadband (HH)", s.broadband_pct==null ? "—" : `${s.broadband_pct.toFixed(1)}%`]
  ]);

  const rt = s.race.total || s.pop || 0;
  renderKV(raceDiv, [
    ["Hispanic or Latino (any race)", s.race.hisp_pct==null ? "—" : `${s.race.hisp_pct.toFixed(1)}%`],
    ["White (alone)", pct(s.race.white, rt)],
    ["Black (alone)", pct(s.race.black, rt)],
    ["American Indian/Alaska Native", pct(s.race.native, rt)],
    ["Asian (alone)", pct(s.race.asian, rt)],
    ["NH/Other Pacific Islander", pct(s.race.pacific, rt)],
    ["Some other race", pct(s.race.other, rt)],
    ["Two or more races", pct(s.race.two, rt)]
  ]);

  const at = s.pop || 0;
  renderKV(ageDiv, [
    ["0–4", pct(s.age.a0_4, at)],
    ["5–19", pct(s.age.a5_19, at)],
    ["18–24", pct(s.age.a18_24, at)],
    ["25–44", pct(s.age.a25_44, at)],
    ["45–64", pct(s.age.a45_64, at)],
    ["65–74", pct(s.age.a65_74, at)],
    ["75+", pct(s.age.a75p, at)]
  ]);

  renderKV(incomeDiv, [
    ["Mean household income", money(s.income.mean)],
    ["Median household income", money(s.income.median)],
    ["P20 (bottom quintile)", money(s.income.p20)],
    ["P80 (top quintile)", money(s.income.p80)]
  ]);

  renderKV(economyDiv, [
    ["Labor force participation", s.economy.lf_participation==null ? "—" : `${s.economy.lf_participation.toFixed(1)}%`],
    ["Unemployment rate", s.economy.unemp_rate==null ? "—" : `${s.economy.unemp_rate.toFixed(1)}%`],
    ["In labor force (16+)", fmt(s.economy.inLF)],
    ["Employed", fmt(s.economy.employed)],
    ["Unemployed", fmt(s.economy.unemployed)]
  ]);

  renderKV(housingDiv, [
    ["Occupied units", fmt(s.housing.occupied)],
    ["Owner-occupied", fmt(s.housing.owner) + (s.housing.owner_pct!=null? ` (${s.housing.owner_pct.toFixed(1)}%)`:"")],
    ["Renter-occupied", fmt(s.housing.renter) + (s.housing.renter_pct!=null? ` (${s.housing.renter_pct.toFixed(1)}%)`:"")],
    ["Median gross rent (weighted)", money(s.housing.median_rent)],
  ]);

  renderKV(socialDiv, [
    ["Foreign-born", s.social.foreign_born_pct==null ? "—" : `${s.social.foreign_born_pct.toFixed(1)}%`],
    ["Language other than English at home (5+)", s.social.lang_other_pct==null ? "—" : `${s.social.lang_other_pct.toFixed(1)}%`],
    ["Spanish spoken at home (5+)", s.social.spanish_home_pct==null ? "—" : `${s.social.spanish_home_pct.toFixed(1)}%`]
  ]);
}

renderPanel();
