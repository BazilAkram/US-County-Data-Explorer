// node >=18
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const YEAR = 2024;
const API = "https://api.census.gov/data";
const KEY = process.env.CENSUS_API_KEY ? `&key=${process.env.CENSUS_API_KEY}` : "";

// ---- variables ----
const VARS = {
  // detailed table
  pop_total: { ds: `acs/acs5`, codes: ["B01003_001E"] },
  // subject: education (S1501)
  edu: {
    ds: `acs/acs5/subject`,
    codes: [
      "S1501_C02_014E", // HS+ %
      "S1501_C02_015E", // BA+ %
      "S1501_C01_006E"  // Pop 25+ (count)
    ]
  },
  // subject: internet (S2801)
  net: {
    ds: `acs/acs5/subject`,
    codes: [
      "S2801_C01_001E", // households (count)
      "S2801_C02_014E"  // broadband of any type, %
    ]
  }
};

const GEO = "for=county:*&in=state:*"; // all counties

async function fetchACS(ds, codes) {
  const get = ["NAME", ...codes].join(",");
  const url = `${API}/${YEAR}/${ds}?get=${get}&${GEO}${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const rows = await res.json();
  const [header, ...data] = rows;
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const out = new Map();
  for (const r of data) {
    const state = r[idx.state], county = r[idx.county];
    const geoid = state + county;
    const obj = { geoid, name: r[idx.NAME], state, county };
    for (const c of codes) obj[c] = r[idx[c]];
    out.set(geoid, obj);
  }
  return out;
}

function mergeMaps(...maps) {
  const out = new Map();
  for (const m of maps) {
    for (const [geoid, rec] of m) {
      if (!out.has(geoid)) out.set(geoid, { geoid });
      Object.assign(out.get(geoid), rec);
    }
  }
  return out;
}

function toNum(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

async function main() {
  console.log("Fetching ACS…");
  const mPop = await fetchACS(VARS.pop_total.ds, VARS.pop_total.codes);
  const mEdu = await fetchACS(VARS.edu.ds, VARS.edu.codes);
  const mNet = await fetchACS(VARS.net.ds, VARS.net.codes);
  const joined = mergeMaps(mPop, mEdu, mNet);

  // load geometries (input stays in /data)
  const gjPath = path.join(__dirname, "counties_simplified.geojson");
  const geo = JSON.parse(await fs.readFile(gjPath, "utf8"));

  // constants for density
  const M2_PER_KM2 = 1_000_000;
  const M2_PER_MI2 = 2_589_988.110336;

  // enrich features + stats map
  const stats = {};
  for (const f of geo.features) {
    const p = f.properties || {};
    const geoid = p.GEOID || (p.STATEFP + p.COUNTYFP);
    const rec = joined.get(geoid);
    if (!rec) continue;

    const ALAND = toNum(p.ALAND); // m^2 (if missing, leave null)
    const pop = toNum(rec.B01003_001E);
    const hh = toNum(rec.S2801_C01_001E);
    const pop25 = toNum(rec.S1501_C01_006E);
    const hs_pct = toNum(rec.S1501_C02_014E);
    const ba_pct = toNum(rec.S1501_C02_015E);
    const bb_pct = toNum(rec.S2801_C02_014E);

    const area_km2 = ALAND != null ? ALAND / M2_PER_KM2 : null;
    const dens_km2 = (pop != null && area_km2) ? pop / area_km2 : null;
    const dens_mi2 = (pop != null && ALAND != null) ? pop / (ALAND / M2_PER_MI2) : null;

    // write compact stats object
    const s = stats[geoid] = {
      geoid,
      name: p.NAME,
      statefp: p.STATEFP,
      countyfp: p.COUNTYFP,
      pop,
      households: hh,
      pop25,
      edu_hs_or_higher_pct: hs_pct,
      edu_ba_or_higher_pct: ba_pct,
      broadband_any_pct: bb_pct,
      area_km2,
      density_km2: dens_km2,
      density_mi2: dens_mi2,
      year: YEAR
    };
    // also pin on feature for quick tooltips
    f.properties.__stats = s;
  }

  // >>> write directly to /public/data (web root for local + GitHub Pages)
  const outDir = path.join(__dirname, "../public/data");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "counties_enriched.geojson"), JSON.stringify(geo));
  await fs.writeFile(path.join(outDir, "counties_stats.json"), JSON.stringify(stats));
  console.log("Wrote public/data/counties_enriched.geojson and public/data/counties_stats.json");
}

main().catch(e => { console.error(e); process.exit(1); });
