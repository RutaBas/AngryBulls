"use strict";

/* BULLPEN — level table builder.  node scripts/build-levels.js [options]

   Produces js/levels.js: for every tier, a table of [seed, effort, par] triples
   in ascending difficulty. The game rebuilds a level from its seed at run time
   with the SAME certified generator, so nothing about a board is stored except
   the number that reproduces it.

   ---------------------------------------------------------------- the traps

   1. THE SEEDING TRAP. generate() walks its own retry attempts with the stride
      0x9e3779b1: attempt a uses mulberry32(seed + a*0x9e3779b1). So seeding
      level n with SEED + n*0x9e3779b1 makes board n's attempt 0 bit-for-bit
      identical to board n-1's attempt 1 — the verifier measured medium
      collapsing to 3 distinct layouts across 40 levels. Every seed here comes
      from hashSeed("bullpen|<tier>|<n>|<try>") instead, and the emit step
      ASSERTS that all layouts in a tier are distinct before writing anything.

   2. THE STORED SEED IS THE *EFFECTIVE* SEED. A board accepted on attempt a of
      base seed S is reproduced exactly by attempt 0 of (S + a*0x9e3779b1),
      because every random choice in an attempt is drawn from that one stream.
      Storing the effective seed means the player's device runs ONE attempt
      instead of replaying a's worth of rejects — the difference between ~1.2s
      and ~250ms when a Badlands board opens.

   3. THE PASTURE FLOOR. The verifier found only 19/40 Pasture boards actually
      required `line-in-region`; the rest graded `region-in-line`, the same top
      technique as Paddock, just on a bigger grid. So Pasture here carries a
      minTechnique floor and rejects anything softer. Measured cost: about 30%
      of medium boards clear the floor, so the tier costs ~3.3x more to build
      (~1.1s/board vs ~0.34s). That is affordable; it is reported at the end of
      every run.

   ------------------------------------------------------------------- ramping

   Difficulty is NOT the raw seed order. Every candidate is graded with the
   solver's own `effort`, all candidates for a tier are sorted, and levels are
   assigned along that sorted ramp — so level 5 of Rangeland is the gentlest
   board that still requires set-cover and level 995 is the hardest.

   ------------------------------------------------------------ resumable runs

   Candidates are appended to scripts/.cache/<tier>.json as they are accepted,
   keyed by slot. Re-running skips slots already in the cache, so a long build
   can be done in chunks or sharded across processes:

     node scripts/build-levels.js --tier badlands --from 1   --to 250
     node scripts/build-levels.js --tier badlands --from 251 --to 500   (parallel)
     node scripts/build-levels.js --emit                                (at the end)

   With no --tier it builds every tier in order, then emits.
*/

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const gen = require(path.join(ROOT, "js", "generator.js"));
const solver = require(path.join(ROOT, "js", "solver.js"));
const { hashSeed } = require(path.join(ROOT, "js", "rng.js"));
const Par = require(path.join(ROOT, "js", "par.js"));

const STRIDE = 0x9e3779b1;

/* The Yard ladder. `gen` is the generator's own tier key (its technique band);
   `floor` is an extra minimum-technique requirement applied on top of it. */
const TIERS = [
  { key: "paddock",   name: "Paddock",   gen: "easy",    N: 6,  k: 1, levels: 1000, floor: null },
  { key: "pasture",   name: "Pasture",   gen: "medium",  N: 8,  k: 1, levels: 1000, floor: "line-in-region" },
  { key: "rangeland", name: "Rangeland", gen: "hard",    N: 9,  k: 2, levels: 1000, floor: null },
  { key: "badlands",  name: "Badlands",  gen: "extreme", N: 10, k: 2, levels: 1000, floor: null }
];

const CACHE_DIR = path.join(__dirname, ".cache");

// ------------------------------------------------------------------- args
function parseArgs(argv) {
  const o = { tier: null, from: 1, to: 0, emit: false, only: false, levels: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tier") o.tier = argv[++i];
    else if (a === "--from") o.from = parseInt(argv[++i], 10);
    else if (a === "--to") o.to = parseInt(argv[++i], 10);
    else if (a === "--levels") o.levels = parseInt(argv[++i], 10);
    else if (a === "--emit") o.emit = true;
    else if (a === "--no-emit") o.only = true;
  }
  return o;
}

// ------------------------------------------------------------------ cache
function cachePath(tierKey) {
  return path.join(CACHE_DIR, tierKey + ".json");
}
function loadCache(tierKey) {
  try {
    return JSON.parse(fs.readFileSync(cachePath(tierKey), "utf8"));
  } catch (e) {
    return {};
  }
}
/* Shards run in parallel over disjoint slot ranges, so a save must MERGE with
   whatever is on disk rather than clobber it. */
function saveCache(tierKey, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const disk = loadCache(tierKey);
  for (const k of Object.keys(data)) disk[k] = data[k];
  const tmp = cachePath(tierKey) + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(disk));
  fs.renameSync(tmp, cachePath(tierKey));
  return disk;
}

// ----------------------------------------------------------------- build
function penKeyOf(pens) {
  let s = "";
  for (let i = 0; i < pens.length; i++) s += pens[i].toString(36);
  return s;
}

function buildTier(tier, from, to) {
  const cache = loadCache(tier.key);
  const fresh = {};
  let made = 0, tried = 0, rejectedByFloor = 0, t0 = Date.now();
  const lo = Math.max(1, from);
  const hi = Math.min(tier.levels, to || tier.levels);

  for (let n = lo; n <= hi; n++) {
    if (cache[n]) continue;
    let row = null;
    for (let attempt = 0; attempt < 400 && !row; attempt++) {
      const seed = hashSeed("bullpen|" + tier.key + "|" + n + "|" + attempt);
      tried++;
      const g = gen.generate({ tier: tier.gen, seed, maxAttempts: 400 });
      if (!g.pens) continue;
      if (tier.floor && g.maxTechnique !== tier.floor) { rejectedByFloor++; continue; }
      const eff = (seed + (g.attempts - 1) * STRIDE) >>> 0;
      row = [eff, g.effort, penKeyOf(g.pens)];
    }
    if (!row) {
      console.error("  slot " + n + ": no candidate in 400 seeds — skipped");
      continue;
    }
    cache[n] = row;
    fresh[n] = row;
    made++;
    if (made % 10 === 0) {
      saveCache(tier.key, fresh);
      const per = (Date.now() - t0) / made;
      const left = ((hi - n) * per) / 1000;
      process.stdout.write(
        "  " + tier.key + " " + n + "/" + hi + "  " + per.toFixed(0) + "ms/board" +
        (left > 0 ? "  ~" + (left / 60).toFixed(1) + "min left" : "") + "\n"
      );
    }
  }
  if (made) saveCache(tier.key, fresh);
  const secs = (Date.now() - t0) / 1000;
  console.log(
    tier.key + ": +" + made + " boards in " + secs.toFixed(0) + "s" +
    (made ? " (" + (secs * 1000 / made).toFixed(0) + "ms each)" : "") +
    (tier.floor ? "  floor '" + tier.floor + "' accept-rate " +
      (tried ? ((100 * made) / tried).toFixed(0) : "0") + "% (" + rejectedByFloor + " rejected)" : "")
  );
}

// ------------------------------------------------------------------ emit
function emit() {
  const out = {};
  const meta = [];
  let total = 0;

  for (const tier of TIERS) {
    const cache = loadCache(tier.key);
    const rows = Object.keys(cache)
      .map((k) => cache[k])
      .filter(Boolean);

    // ---- HARD ASSERT: every layout in the tier must be distinct.
    const seen = new Map();
    for (const r of rows) {
      if (seen.has(r[2])) {
        throw new Error(
          "DUPLICATE LAYOUT in " + tier.key + " (seed " + r[0] + " repeats seed " + seen.get(r[2]) +
          "). The seeding is collapsing — check that seeds come from hashSeed(), not a fixed stride."
        );
      }
      seen.set(r[2], r[0]);
    }
    const seeds = new Set(rows.map((r) => r[0]));
    if (seeds.size !== rows.length) throw new Error("DUPLICATE SEED in " + tier.key);

    // ---- the ramp: sort by solver effort, then assign level numbers.
    rows.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const count = rows.length;
    const lo = count ? rows[0][1] : 0;
    const hi = count ? rows[count - 1][1] : 0;

    out[tier.key] = rows.map((r, i) => {
      const ratio = count > 1 ? i / (count - 1) : 0.5;
      return [r[0], r[1], Par.parMs(tier.key, ratio)];
    });
    meta.push({
      key: tier.key, name: tier.name, gen: tier.gen, N: tier.N, k: tier.k,
      levels: count, effortLo: lo, effortHi: hi
    });
    total += count;
    console.log(
      "  " + tier.key.padEnd(10) + count + " levels  effort " + lo + "-" + hi +
      "  par " + (out[tier.key][0] ? (out[tier.key][0][2] / 1000) : 0) + "s-" +
      (count ? out[tier.key][count - 1][2] / 1000 : 0) + "s"
    );
  }

  const body =
    '"use strict";\n' +
    "/* GENERATED by scripts/build-levels.js — do not edit by hand.\n\n" +
    "   Each row is [seed, effort, par]:\n" +
    "     seed   the EFFECTIVE generator seed. generate({tier, seed}) rebuilds\n" +
    "            this exact board on attempt 0.\n" +
    "     effort the solver's own weighted deduction cost — the ramp axis.\n" +
    "     par    the target time in ms (js/par.js), forgiving by design.\n\n" +
    "   Rows are in ascending difficulty within each tier: index 0 is level 1. */\n\n" +
    "var BULLPEN_TIERS = " + JSON.stringify(meta, null, 2) + ";\n\n" +
    "var BULLPEN_LEVELS = {\n" +
    TIERS.map((t) =>
      "  " + t.key + ": [\n" +
      (out[t.key] || []).map((r) => "    [" + r.join(",") + "]").join(",\n") +
      "\n  ]"
    ).join(",\n") +
    "\n};\n\n" +
    'if (typeof module !== "undefined" && module.exports) module.exports = { BULLPEN_TIERS: BULLPEN_TIERS, BULLPEN_LEVELS: BULLPEN_LEVELS };\n';

  const dest = path.join(ROOT, "js", "levels.js");
  fs.writeFileSync(dest, body);
  console.log("wrote js/levels.js — " + total + " levels, " + (body.length / 1024).toFixed(0) + "KB");
}

// ------------------------------------------------------------------ main
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.levels) TIERS.forEach((t) => { t.levels = args.levels; });

  if (args.tier) {
    const t = TIERS.find((x) => x.key === args.tier);
    if (!t) throw new Error("unknown tier " + args.tier);
    buildTier(t, args.from, args.to);
  } else if (!args.emit) {
    for (const t of TIERS) buildTier(t, args.from, args.to);
  }
  if (!args.only) emit();
}

if (require.main === module) main();
module.exports = { TIERS, emit, buildTier };
