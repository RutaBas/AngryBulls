"use strict";

/* BULLPEN — level-table contract test.  node test/levels-contract.test.js

   js/levels.js is only useful if a device can turn a row back into the exact
   board the build graded. Three things have to hold, and two of them have bitten
   this project before:

     1. attempt 0 of the stored seed reproduces the board — no replaying rejects;
     2. the rebuilt board has the GRID SIZE the tier promises. Paddock mixes 6x6
        and 7x7, and js/meta-config.js only honours a fourth element that is a
        STRING gen key — a bare number is ignored on purpose. If the build ever
        emitted the size as a number, every Paddock level would silently rebuild
        at the tier default and nobody would see an error;
     3. the rebuilt board's solver effort equals the effort baked into the row,
        which is what the difficulty ramp and par are built on.

   Plus: the daily must be deterministic. A mixed-size tier picks the daily's
   grid size from the date seed, so two players on the same date must get not
   just the same layout but the same SIZE. */

const path = require("path");
const ROOT = path.join(__dirname, "..");
const gen = require(path.join(ROOT, "js", "generator.js"));
const solver = require(path.join(ROOT, "js", "solver.js"));
const { BULLPEN_LEVELS, BULLPEN_TIERS } = require(path.join(ROOT, "js", "levels.js"));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS  " + name + (detail ? " — " + detail : "")); }
  else { fail++; console.log("  FAIL  " + name + (detail ? " — " + detail : "")); }
}

const DEFS = {};
BULLPEN_TIERS.forEach((t) => { DEFS[t.key] = t; });

// Sample evenly across each tier's 1000 levels.
const SAMPLES = 24;

console.log("--- level rows rebuild the exact graded board ---");
for (const t of BULLPEN_TIERS) {
  const rows = BULLPEN_LEVELS[t.key];
  let badSeed = 0, badEffort = 0, badSize = 0, missing = 0;
  const sizesSeen = {};
  for (let s = 0; s < SAMPLES; s++) {
    const n = 1 + Math.floor((s * (rows.length - 1)) / (SAMPLES - 1));
    const r = rows[n - 1];
    // Exactly the resolution js/meta-config.js meta.levelRow performs.
    const genTier = (typeof r[3] === "string" && r[3]) || t.gen;
    const g = gen.generate({ tier: genTier, seed: r[0], maxAttempts: 1 });
    if (!g.pens) { missing++; continue; }
    sizesSeen[g.N] = (sizesSeen[g.N] || 0) + 1;
    if (g.effort !== r[1]) badEffort++;
    // the size must be one the tier declares it can contain
    const declared = t.sizes || [t.N];
    if (declared.indexOf(g.N) < 0) badSize++;
    // and the board must still be the certified article
    const cs = solver.countSolutions({ N: g.N, k: g.k, pens: g.pens }, 2);
    if (cs.count !== 1) badSeed++;
  }
  check(t.key + ": every sampled seed rebuilds on ATTEMPT 0", missing === 0, missing + " failed to build");
  check(t.key + ": rebuilt effort equals the baked effort", badEffort === 0, badEffort + " mismatched");
  check(t.key + ": rebuilt grid size is one the tier declares", badSize === 0,
    "sizes seen " + JSON.stringify(sizesSeen));
  check(t.key + ": rebuilt board is still uniquely solvable", badSeed === 0, badSeed + " not unique");
}

console.log("\n--- the mixed tiers really are mixed, and say so ---");
for (const key of ["paddock", "pasture"]) {
  const t = DEFS[key];
  const rows = BULLPEN_LEVELS[key];
  const keys = {};
  rows.forEach((r) => { const g = typeof r[3] === "string" ? r[3] : "(default)"; keys[g] = (keys[g] || 0) + 1; });
  check(key + " rows carry a STRING gen key (a number would be ignored by the UI)",
    rows.every((r) => typeof r[3] === "string"), JSON.stringify(keys));
  check(key + " declares its sizes for the UI label",
    Array.isArray(t.sizes) && t.sizes.length === 2, JSON.stringify(t.sizes));
  // sizes must not be blocked: both should appear in the first 100 levels
  const early = {};
  rows.slice(0, 100).forEach((r) => { early[r[3]] = (early[r[3]] || 0) + 1; });
  check(key + ": both sizes appear within the first 100 levels (not blocked by size)",
    Object.keys(early).length === 2, JSON.stringify(early));
}
{
  // single-size tiers must NOT carry a key, so nothing is ambiguous
  check("single-size tiers omit the gen-key column",
    ["rangeland", "badlands"].every((k) => BULLPEN_LEVELS[k].every((r) => r.length === 3)));
}

console.log("\n--- the daily is deterministic, size included ---");
{
  let drift = 0;
  const dates = ["2026-08-06", "2026-08-07", "2026-08-08", "2026-09-01", "2026-12-25"];
  for (const d of dates) {
    for (const tier of ["paddock", "pasture", "rangeland", "badlands"]) {
      const seed = gen.dailySeed(d, tier);
      const a = gen.generate({ tier: DEFS[tier].gen, seed, maxAttempts: 400 });
      const b = gen.generate({ tier: DEFS[tier].gen, seed, maxAttempts: 400 });
      if (!a.pens || !b.pens) { drift++; continue; }
      if (a.N !== b.N || String(a.pens) !== String(b.pens)) drift++;
    }
  }
  check("same date + tier gives the same board AND the same grid size", drift === 0,
    drift + " drifted over " + dates.length * 4 + " dailies");
}

console.log("\n" + (fail === 0 ? "GREEN" : "RED") + " — " + pass + " passed, " + fail + " failed.");
process.exit(fail === 0 ? 0 : 1);
