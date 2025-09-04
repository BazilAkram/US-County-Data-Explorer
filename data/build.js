import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");                 // repo root
const OUT_DIR = path.resolve(ROOT, "public", "data");       // write where the site can serve it

const YEAR = 2023; // bump when new ACS 5-yr drops
const API = "https://api.census.gov/data";
const KEY = process.env.CENSUS_API_KEY ? `&key=${process.env.CENSUS_API_KEY}` : "";

// ---------- Variables to fetch ----------
const VARS = {
  // Population (count)
  pop_total: { ds: "acs/acs5", codes: ["B01003_001E"] },

  // Households + Broadband (% of households with broadband)
  net: { ds: "acs/acs5/subject", codes: ["S2801_C01_001E", "S2801_C02_014E"] },

  // Education % (25+) + base population 25+
  edu: { ds: "acs/acs5/subject", codes: ["S1501_C02_014E", "S1501_C02_015E", "S1501_C01_006E"] },

  // Race counts (B02001)
  race: { ds: "acs/acs5", codes: [
    "B02001_001E", // total
    "B02001_002E", // White alone
    "B02001_003E", // Black or African American alone
    "B02001_004E", // American Indian and Alaska Native alone
    "B02001_005E", // Asian alone
    "B02001_006E", // Native Hawaiian and Other Pacific Islander alone
    "B02001_007E", // Some other race alone
    "B02001_008E"  // Two or more races
  ]},

  // Age buckets (counts) via S0101 (subject table)
  age: { ds: "acs/acs5/subject", codes: [
    "S0101_C01_001E", // total pop
    "S0101_C01_002E","S0101_C01_003E","S0101_C01_004E","S0101_C01_005E", // <18 components
    "S0101_C01_006E","S0101_C01_007E","S0101_C01_008E","S0101_C01_009E","S0101_C01_010E","S0101_C01_011E","S0101_C01_012E","S0101_C01_013E","S0101_C01_014E", // 18–64 components
    "S0101_C01_015E","S0101_C01_016E","S0101_C01_017E","S0101_C01_018E"  // 65+ components
  ]},

  // Median household income (USD)
  income: { ds: "acs/acs5", codes: ["B19013_001E"] }
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

const toNum = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

async function main() {
  console.log(`[build] ROOT=${ROOT}`);
  // 0) ensure input geometry exists
  const gjPath = path.join(__dirname, "counties_simplified.geojson");
  console.log(`[build] Input GeoJSON: ${gjPath}`);
  await fs.access(gjPath).catch(() => { throw new Error(`Input not found: ${gjPath}`); });

  // 1) fetch ACS blocks
  console.log("[build] Fetching ACS…");
  const mPop = await fetchACS(VARS.pop_total.ds, VARS.pop_total.codes);
  const mEdu = await fetchACS(VARS.edu.ds, VARS.edu.codes);
  const mNet = await fetchACS(VARS.net.ds, VARS.net.codes);
  const mRace= await fetchACS(VARS.race.ds, VARS.race.codes);
  const mAge = await fetchACS(VARS.age.ds, VARS.age.codes);
  const mInc = await fetchACS(VARS.income.ds, VARS.income.codes);
  const joined = mergeMaps(mPop, mEdu, mNet, mRace, mAge, mInc);

  // 2) load geometries
  const geo = JSON.parse(await fs.readFile(gjPath, "utf8"));

  // 3) compute stats & pin to features
  const M2_PER_KM2 = 1_000_000;
  const M2_PER_MI2 = 2_589_988.110336;
  const stats = {};

  for (const f of geo.features) {
    const p = f.properties || {};
    const geoid = p.GEOID || (p.STATEFP + p.COUNTYFP);
    const rec = joined.get(geoid);
    if (!rec) continue;

    const ALAND = toNum(p.ALAND); // m^2
    const area_km2 = ALAND != null ? ALAND / M2_PER_KM2 : null;

    // base counts
    const pop  = toNum(rec.B01003_001E);
    const hh   = toNum(rec.S2801_C01_001E);
    const pop25= toNum(rec.S1501_C01_006E);

    // rates (percentages)
    const hs_pct = toNum(rec.S1501_C02_014E);
    const ba_pct = toNum(rec.S1501_C02_015E);
    const bb_pct = toNum(rec.S2801_C02_014E);

    // densities
    const dens_km2 = (pop != null && area_km2) ? pop / area_km2 : null;
    const dens_mi2 = (pop != null && ALAND != null) ? pop / (ALAND / M2_PER_MI2) : null;

    // race (counts)
    const rTot = toNum(rec.B02001_001E);
    const rW   = toNum(rec.B02001_002E);
    const rB   = toNum(rec.B02001_003E);
    const rN   = toNum(rec.B02001_004E);
    const rA   = toNum(rec.B02001_005E);
    const rP   = toNum(rec.B02001_006E);
    const rO   = toNum(rec.B02001_007E);
    const rT   = toNum(rec.B02001_008E);

    // age buckets (counts)
    const under18 = (toNum(rec.S0101_C01_002E)||0)+(toNum(rec.S0101_C01_003E)||0)+(toNum(rec.S0101_C01_004E)||0)+(toNum(rec.S0101_C01_005E)||0);
    const age18_64= (toNum(rec.S0101_C01_006E)||0)+(toNum(rec.S0101_C01_007E)||0)+(toNum(rec.S0101_C01_008E)||0)+(toNum(rec.S0101_C01_009E)||0)+(toNum(rec.S0101_C01_010E)||0)+(toNum(rec.S0101_C01_011E)||0)+(toNum(rec.S0101_C01_012E)||0)+(toNum(rec.S0101_C01_013E)||0)+(toNum(rec.S0101_C01_014E)||0);
    const age65p  = (toNum(rec.S0101_C01_015E)||0)+(toNum(rec.S0101_C01_016E)||0)+(toNum(rec.S0101_C01_017E)||0)+(toNum(rec.S0101_C01_018E)||0);

    // income (median household)
    const medHH = toNum(rec.B19013_001E);

    const s = stats[geoid] = {
      geoid,
      name: p.NAME,
      statefp: p.STATEFP,
      countyfp: p.COUNTYFP,
      // core
      pop, households: hh, pop25,
      edu_hs_or_higher_pct: hs_pct,
      edu_ba_or_higher_pct: ba_pct,
      broadband_any_pct: bb_pct,
      area_km2, density_km2: dens_km2, density_mi2: dens_mi2,
      year: YEAR,
      // extras
      race_total: rTot, race_white: rW, race_black: rB, race_native: rN, race_asian: rA, race_pacific: rP, race_other: rO, race_two: rT,
      age_under18: under18, age_18to64: age18_64, age_65plus: age65p,
      median_hh_income: medHH
    };
    f.properties.__stats = s; // handy if you want per-county tooltips later
  }

  // 4) write outputs to /public/data
  await fs.mkdir(OUT_DIR, { recursive: true });
  const outGeo  = path.join(OUT_DIR, "counties_enriched.geojson");
  const outJson = path.join(OUT_DIR, "counties_stats.json");
  await fs.writeFile(outGeo, JSON.stringify(geo));
  await fs.writeFile(outJson, JSON.stringify(stats));

  // 5) verify
  const [stGeo, stJson] = await Promise.all([fs.stat(outGeo), fs.stat(outJson)]);
  console.log(`[build] Wrote ${outGeo} (${stGeo.size.toLocaleString()} bytes)`);
  console.log(`[build] Wrote ${outJson} (${stJson.size.toLocaleString()} bytes)`);
}

main().catch(e => {
  console.error("[build] ERROR:", e.message);
  process.exit(1);
});
