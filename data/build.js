// node >=18
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.resolve(ROOT, "public", "data");

const YEAR = 2023; // bump when new ACS 5-yr drops
const API = "https://api.census.gov/data";
const KEY = process.env.CENSUS_API_KEY ? `&key=${process.env.CENSUS_API_KEY}` : "";

// ------------ helpers ------------
async function fetchACS(ds, codes) {
  const GEO = "for=county:*&in=state:*";
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
  return (Number.isFinite(x) && (x >= 0)) ? x : null;
};

// ------------ variables ------------
const VARS = {
  // core
  pop_total: { ds: "acs/acs5", codes: ["B01003_001E"] },
  net:       { ds: "acs/acs5/subject", codes: ["S2801_C01_001E", "S2801_C02_014E"] }, // HH total, % broadband
  edu:       { ds: "acs/acs5/subject", codes: ["S1501_C02_014E","S1501_C02_015E","S1501_C01_006E"] }, // HS+/BA+ %, 25+ base

  // race + hispanic
  race:      { ds: "acs/acs5", codes: [
                "B02001_001E","B02001_002E","B02001_003E","B02001_004E",
                "B02001_005E","B02001_006E","B02001_007E","B02001_008E"
              ]},
  hisp:      { ds: "acs/acs5", codes: ["B03003_001E","B03003_003E"] }, // base, hispanic

  // age (fine buckets via S0101)
  age:       { ds: "acs/acs5/subject", codes: [
                "S0101_C01_002E","S0101_C01_003E","S0101_C01_004E","S0101_C01_005E", // 0-4,5-9,10-14,15-19
                "S0101_C01_006E","S0101_C01_007E","S0101_C01_008E","S0101_C01_009E","S0101_C01_010E",
                "S0101_C01_011E","S0101_C01_012E","S0101_C01_013E","S0101_C01_014E",
                "S0101_C01_015E","S0101_C01_016E","S0101_C01_017E","S0101_C01_018E"
              ]},

  // income distribution (for mean, P20, P80) and median income
  income_dist: { ds: "acs/acs5", codes: [
    "B19001_001E","B19001_002E","B19001_003E","B19001_004E","B19001_005E",
    "B19001_006E","B19001_007E","B19001_008E","B19001_009E","B19001_010E",
    "B19001_011E","B19001_012E","B19001_013E","B19001_014E","B19001_015E",
    "B19001_016E","B19001_017E"
  ]},
  income_median: { ds: "acs/acs5", codes: ["B19013_001E"] },

  // economy + housing (kept), social (pruned to robust)
  employment: { ds: "acs/acs5", codes: [
    "B23025_001E","B23025_002E","B23025_003E","B23025_004E","B23025_005E","B23025_006E","B23025_007E"
  ]},
  poverty:   { ds: "acs/acs5/subject", codes: ["S1701_C02_001E","S1701_C01_001E"] },
  tenure:    { ds: "acs/acs5", codes: ["B25003_001E","B25003_002E","B25003_003E"] },
  rent:      { ds: "acs/acs5", codes: ["B25064_001E"] },
  yearbuilt: { ds: "acs/acs5", codes: [
    "B25034_001E","B25034_002E","B25034_003E","B25034_004E","B25034_005E","B25034_006E",
    "B25034_007E","B25034_008E","B25034_009E","B25034_010E"
  ]},

  // social (robust only)
  foreign:   { ds: "acs/acs5", codes: ["B05002_001E","B05002_013E"] },     // % foreign-born
  lang: { ds: "acs/acs5", codes: [
    "C16001_001E", // total 5+
    "C16001_002E", // speak only English
    "C16001_003E", // speaks Spanish
  ]},
};

async function main() {
  const gjPath = path.join(__dirname, "counties_simplified.geojson");
  await fs.access(gjPath).catch(() => { throw new Error(`Input not found: ${gjPath}`); });

  const pulls = {};
  for (const [k, spec] of Object.entries(VARS)) {
    try {
      pulls[k] = await fetchACS(spec.ds, spec.codes);
      console.log(`[build] fetched ${k}`);
    } catch (e) {
      pulls[k] = new Map();
      console.warn(`[build] WARN: ${k} fetch failed: ${e.message}`);
    }
  }
  const joined = mergeMaps(...Object.values(pulls));
  const geo = JSON.parse(await fs.readFile(gjPath, "utf8"));

  const M2_PER_KM2 = 1_000_000;
  const M2_PER_MI2 = 2_589_988.110336;
  const stats = {};

  for (const f of geo.features) {
    const p = f.properties || {};
    const geoid = p.GEOID || (p.STATEFP + p.COUNTYFP);
    const rec = joined.get(geoid);
    if (!rec) continue;

    const ALAND = toNum(p.ALAND);
    const area_km2 = ALAND != null ? ALAND / M2_PER_KM2 : null;

    // core
    const pop  = toNum(rec.B01003_001E);
    const hh   = toNum(rec.S2801_C01_001E);
    const pop25= toNum(rec.S1501_C01_006E);
    const hs_pct = toNum(rec.S1501_C02_014E);
    const ba_pct = toNum(rec.S1501_C02_015E);
    const bb_pct = toNum(rec.S2801_C02_014E);
    const dens_km2 = (pop != null && area_km2) ? pop / area_km2 : null;
    const dens_mi2 = (pop != null && ALAND != null) ? pop / (ALAND / M2_PER_MI2) : null;

    // race + hispanic
    const rTot = toNum(rec.B02001_001E);
    const rW   = toNum(rec.B02001_002E);
    const rB   = toNum(rec.B02001_003E);
    const rN   = toNum(rec.B02001_004E);
    const rA   = toNum(rec.B02001_005E);
    const rP   = toNum(rec.B02001_006E);
    const rO   = toNum(rec.B02001_007E);
    const rT   = toNum(rec.B02001_008E);
    const hisp_base = toNum(rec.B03003_001E);
    const hisp      = toNum(rec.B03003_003E);

    // age fine cohorts (we’ll compose later)
    const age = {
      a0_4:  toNum(rec.S0101_C01_002E),
      a5_9:  toNum(rec.S0101_C01_003E),
      a10_14:toNum(rec.S0101_C01_004E),
      a15_19:toNum(rec.S0101_C01_005E),
      a20_24:toNum(rec.S0101_C01_006E),
      a25_29:toNum(rec.S0101_C01_007E),
      a30_34:toNum(rec.S0101_C01_008E),
      a35_39:toNum(rec.S0101_C01_009E),
      a40_44:toNum(rec.S0101_C01_010E),
      a45_49:toNum(rec.S0101_C01_011E),
      a50_54:toNum(rec.S0101_C01_012E),
      a55_59:toNum(rec.S0101_C01_013E),
      a60_64:toNum(rec.S0101_C01_014E),
      a65_69:toNum(rec.S0101_C01_015E),
      a70_74:toNum(rec.S0101_C01_016E),
      a75_79:toNum(rec.S0101_C01_017E),
      a80p:  toNum(rec.S0101_C01_018E)
    };

    // income distribution (B19001 bins 1..17)
    const id = (k) => toNum(rec[k]) || 0;
    const inc_bins = [
      id("B19001_002E"), // <10k
      id("B19001_003E"), // 10-14,999
      id("B19001_004E"), // 15-19,999
      id("B19001_005E"), // 20-24,999
      id("B19001_006E"), // 25-29,999
      id("B19001_007E"), // 30-34,999
      id("B19001_008E"), // 35-39,999
      id("B19001_009E"), // 40-44,999
      id("B19001_010E"), // 45-49,999
      id("B19001_011E"), // 50-59,999
      id("B19001_012E"), // 60-74,999
      id("B19001_013E"), // 75-99,999
      id("B19001_014E"), // 100-124,999
      id("B19001_015E"), // 125-149,999
      id("B19001_016E"), // 150-199,999
      id("B19001_017E")  // 200k+
    ];
    const inc_total = toNum(rec["B19001_001E"]);
    // median household income
    const medHH = toNum(rec.B19013_001E);

    // economy / housing / social (robust)
    const emp_total16 = toNum(rec.B23025_001E);
    const emp_inLF    = toNum(rec.B23025_002E);
    const emp_civLF   = toNum(rec.B23025_003E);
    const emp_employed= toNum(rec.B23025_004E);
    const emp_unemployed=toNum(rec.B23025_005E);
    const emp_armed   = toNum(rec.B23025_006E);
    const emp_notLF   = toNum(rec.B23025_007E);

    const pov_pct = toNum(rec.S1701_C02_001E);
    const pov_base= toNum(rec.S1701_C01_001E);

    const occ_units = toNum(rec.B25003_001E);
    const owner_occ = toNum(rec.B25003_002E);
    const renter_occ= toNum(rec.B25003_003E);
    const med_rent  = toNum(rec.B25064_001E);

    const yb_total = id("B25034_001E");
    const yb_pre80 = id("B25034_002E")+id("B25034_003E")+id("B25034_004E")+id("B25034_005E")+id("B25034_006E");
    const yb_80_99 = id("B25034_007E")+id("B25034_008E");
    const yb_00_09 = id("B25034_009E");
    const yb_10p   = id("B25034_010E");

    const foreign_total = toNum(rec.B05002_013E);
    const foreign_base  = toNum(rec.B05002_001E);
    const lang_base5 = toNum(rec.C16001_001E);
    const eng_only   = toNum(rec.C16001_002E);
    const spanish    = toNum(rec.C16001_003E) || 0;

    stats[geoid] = {
      geoid, name: p.NAME, statefp: p.STATEFP, countyfp: p.COUNTYFP,
      // core
      pop, households: hh, pop25,
      edu_hs_or_higher_pct: hs_pct, edu_ba_or_higher_pct: ba_pct, broadband_any_pct: bb_pct,
      area_km2, density_km2: dens_km2, density_mi2: dens_mi2, year: YEAR,
      // race + hispanic
      race_total: rTot, race_white: rW, race_black: rB, race_native: rN, race_asian: rA, race_pacific: rP, race_other: rO, race_two: rT,
      hisp_total: hisp, hisp_base,
      // age detail
      age_detail: age,
      // income dist and median
      inc_bins, inc_total, median_hh_income: medHH,
      // economy/housing
      emp_total16, emp_inLF, emp_civLF, emp_employed, emp_unemployed, emp_armed, emp_notLF,
      pov_pct, pov_base,
      occ_units, owner_occ, renter_occ, med_rent,
      yb_total, yb_pre80, yb_80_99, yb_00_09, yb_10p,
      // social (robust)
      foreign_total, foreign_base,
      lang_base5, eng_only, spanish,
    };
    f.properties.__stats = { geoid, name: p.NAME }; // light touch
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "counties_enriched.geojson"), JSON.stringify(geo));
  await fs.writeFile(path.join(OUT_DIR, "counties_stats.json"), JSON.stringify(stats));
  console.log("[build] wrote public/data/{counties_enriched.geojson,counties_stats.json}");
}

main().catch(e => { console.error("[build] ERROR:", e.message); process.exit(1); });
