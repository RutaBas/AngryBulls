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
      every run. On 9x9 the same floor is what makes Pasture expensive: 44.2s per
      accepted board, and only 15-31% of seeds yield one at all (per-shard rates
      from the 169-board mixed build). The floor is NOT dropped for 9x9 — it is
      what makes Pasture a different puzzle from Paddock rather than a bigger
      one — the 9x9 SHARE is what was tuned to pay for it.

   ------------------------------------------------------------------- ramping

   Difficulty is NOT the raw seed order. Every candidate is graded with the
   solver's own `effort`, all candidates for a tier are sorted, and levels are
   assigned along that sorted ramp — so level 5 of Rangeland is the gentlest
   board that still requires set-cover and level 995 is the hardest.

   4. THE FLATNESS TRAP (this is the one Ruta hit). A pure ascending-effort sort
      is the WRONG final order for a tier whose effort is coarsely quantised.
      Measured on the shipped table: Paddock's 1000 levels shared just 26
      distinct effort values, so the sort produced a run of 49 consecutive
      boards at effort 52 followed by 142 at effort 57 — levels 1-20 were all
      the same difficulty AND, being adjacent in seed order, looked alike.

      The fix is a BLOCKED ramp. Rows are still sorted by effort, then cut into
      contiguous blocks of BLOCK levels; the ramp therefore still rises (block
      b is never harder than block b+1, so level 900 beats level 100), but
      WITHIN a block the order is chosen to maximise how much consecutive
      boards differ in pen character — pen-size spread, how far pens are from
      rectangles, elongation, raggedness, and grid size. Difficulty is a
      block-level property; variety is a level-level property.

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
const M = require("./variety-metrics.js");

const STRIDE = 0x9e3779b1;

/* How many consecutive levels share a difficulty step. Inside a block the order
   is by pen character, not by effort. 40 is small enough that the ramp is still
   obvious across a tier (25 rising steps over 1000 levels) and large enough to
   give the dispersion pass room to work. */
const BLOCK = 40;

/* The Yard ladder. `gen` is the generator's own tier key (its technique band);
   `floor` is an extra minimum-technique requirement applied on top of it.
   `sizes` is the grid sizes the tier can contain — Paddock mixes 6x6 and 7x7
   (see js/generator.js TIERS.easy), every other tier is a single size. */
const TIERS = [
  /* `gens` is the per-level gen-key menu with its weight. A slot picks one by a
     hash of the slot number, so the mix is deterministic and reproducible, and
     the chosen key is written into the level row as a STRING — js/meta-ui.js's
     Meta.levelRow reads a string fourth element as that level's gen key and
     deliberately IGNORES a bare number, so the size must travel as a name.
       Paddock is 70/30 six-to-seven. Sevens are ~9x more expensive to generate
     (797ms vs 86ms measured), and 30% is enough to break up the equal-effort
     runs across the whole upper half of the ramp without tripling build time. */
  { key: "paddock",   name: "Paddock",   gen: "easy",    N: 6,  sizes: [6, 7], k: 1, levels: 1000, floor: null,
    gens: [{ key: "easy6", N: 6, w: 7 }, { key: "easy7", N: 7, w: 3 }] },
  /* Pasture mixes 8x8 and 9x9, but at 5:1, not Paddock's 7:3. The ratio is a
     measured cost decision, not a taste one: with the `line-in-region` floor a
     9x9 k=1 board costs 44.2s to find (8 boards in 353s; only 16.7% of seeds
     yield an accepted board at all — 32/48 seeds exhausted their 400 attempts
     before the floor even got a look in), against 1.82s for an 8x8. At 1-in-6
     the tier costs 167*44.2 + 833*1.82 = ~2.5 CPU-hours; at 3-in-10 it would be
     4.0 hours. 167 nines still puts ~7 of them in every 40-level block, which
     is plenty to break the equal-effort runs, and each of them is ranked inside
     its OWN size population so the two sizes interleave the whole way down the
     ramp instead of splitting the tier into an 8x8 half and a 9x9 half. */
  { key: "pasture",   name: "Pasture",   gen: "medium",  N: 8,  sizes: [8, 9], k: 1, levels: 1000, floor: "line-in-region", sizeBonus: 0.45,
    gens: [{ key: "medium8", N: 8, w: 5 }, { key: "medium9", N: 9, w: 1 }] },
  { key: "rangeland", name: "Rangeland", gen: "hard",    N: 9,  sizes: [9],    k: 2, levels: 1000, floor: null },
  { key: "badlands",  name: "Badlands",  gen: "extreme", N: 10, sizes: [10],   k: 2, levels: 1000, floor: null }
];

/* Which gen key slot n of a tier uses. Deterministic, so a resumed or sharded
   build makes the same choice for the same slot. */
function genForSlot(tier, n) {
  if (!tier.gens) return { key: tier.gen, N: tier.N };
  const total = tier.gens.reduce((a, g) => a + g.w, 0);
  let x = hashSeed("bullpen-size|" + tier.key + "|" + n) % total;
  for (const g of tier.gens) { if (x < g.w) return g; x -= g.w; }
  return tier.gens[0];
}

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
    const slotGen = genForSlot(tier, n);
    for (let attempt = 0; attempt < 400 && !row; attempt++) {
      const seed = hashSeed("bullpen|" + tier.key + "|" + n + "|" + attempt);
      tried++;
      const g = gen.generate({ tier: slotGen.key, seed, maxAttempts: 400 });
      if (!g.pens) continue;
      if (tier.floor && g.maxTechnique !== tier.floor) { rejectedByFloor++; continue; }
      const eff = (seed + (g.attempts - 1) * STRIDE) >>> 0;
      /* The gen KEY is recorded, not just the size. It is what the level row
         carries and what a device passes straight back to generate(), so the
         grid size can never be re-derived differently at run time. */
      if (g.N !== slotGen.N) throw new Error("size mismatch: " + slotGen.key + " produced N=" + g.N);
      row = [eff, g.effort, penKeyOf(g.pens), g.N, slotGen.key];
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

// ------------------------------------------------------- variety ordering

/* Distance between two candidate rows for the purpose of "do these two boards
   look alike?". Character vector first, then how much their pen SHAPES overlap,
   then a flat bonus for a change of grid size — a 6x6 next to a 7x7 always
   reads as a different board. Never consults difficulty: difficulty is already
   handled by the block the rows sit in. */
function rowDistance(a, b, sizeBonus) {
  let d = M.charDistance(a.vec, b.vec);
  /* A change of grid size is the single most visible difference between two
     boards, but it must not be worth MORE than everything else put together: at
     a bonus of 0.85 the greedy pass produced a rigid 7,6,7,6,7,6... alternation
     until the sevens ran out, which is just a different kind of pattern. 0.45 is
     about what a same-size pair with completely disjoint pen shapes scores, so
     the two considerations compete instead of one dominating. It is a per-tier
     `sizeBonus` because a scarce second size might have wanted a different
     weight, but the measurement says otherwise: re-emitting Pasture (5:1) at
     0.45 / 0.30 / 0.22 / 0.15 gave a longest 8x8-only run of 25 / 27 / 54 / 44.
     Below ~0.3 the few 9x9s stop repelling each other and arrive in clumps
     ("999...") separated by 40-plus 8x8s, which is worse on both counts, so
     both mixed tiers keep 0.45. */
  d += a.N === b.N ? 0.35 * M.shapeDistance(a.key, b.key, a.N)
                   : (sizeBonus === undefined ? 0.45 : sizeBonus);
  return d;
}

/* Greedy max-dispersion ordering of one block.

   Plain "always take the farthest remaining board" degenerates into a ping-pong
   between the two extremes of the block, which is its own kind of sameness, so
   the score also rewards distance from the board BEFORE last. `startFrom` is
   the previous block's final row, which stops the seam between two blocks from
   being the one place where twins sit together. */
function disperse(block, startFrom, sizeBonus) {
  const pool = block.slice();
  const out = [];
  let last = startFrom || null;
  let last2 = null;
  while (pool.length) {
    let bi = 0;
    if (last) {
      let bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        let s = rowDistance(pool[i], last, sizeBonus);
        if (last2) s += 0.5 * rowDistance(pool[i], last2, sizeBonus);
        if (s > bestScore) { bestScore = s; bi = i; }
      }
    } else {
      // deterministic seed for the very first block: the most extreme board
      let bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i].vec.reduce((x, y) => x + y, 0);
        if (s > bestScore) { bestScore = s; bi = i; }
      }
    }
    const pick = pool.splice(bi, 1)[0];
    out.push(pick);
    last2 = last;
    last = pick;
  }
  return out;
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
    // Keyed by grid size + layout, because a mixed-size tier's pen keys are of
    // different lengths and must not be compared as if they were the same grid.
    const seen = new Map();
    for (const r of rows) {
      r[3] = r[3] || tier.N;           // rows cached before the size mix existed
      const sig = r[3] + ":" + r[2];
      if (seen.has(sig)) {
        throw new Error(
          "DUPLICATE LAYOUT in " + tier.key + " (seed " + r[0] + " repeats seed " + seen.get(sig) +
          "). The seeding is collapsing — check that seeds come from hashSeed(), not a fixed stride."
        );
      }
      seen.set(sig, r[0]);
    }
    const seeds = new Set(rows.map((r) => r[0]));
    if (seeds.size !== rows.length) throw new Error("DUPLICATE SEED in " + tier.key);

    const count = rows.length;
    const effs = rows.map((r) => r[1]).sort((a, b) => a - b);
    const lo = count ? effs[0] : 0;
    const hi = count ? effs[count - 1] : 0;

    /* ---- the ramp, PER SIZE POPULATION.

       A single global sort by effort is wrong for a mixed-size tier: the very
       easiest 7x7 (effort 71) is harder than the hardest 6x6 in the bottom
       third, so a global sort dumps every 7x7 into the top of the table. That
       is exactly the "levels 1-500 are 6x6, 501-1000 are 7x7" split we do not
       want, and it left Paddock levels 1-100 sharing just 3 effort values.

       Instead each gen key is ranked WITHIN ITSELF and levels are assigned by
       that normalised rank. Level 50 is the ~5th-percentile board of whatever
       size it is; level 950 is the ~95th-percentile board of whatever size it
       is. Difficulty still rises monotonically along the tier, the two sizes
       are interleaved in proportion all the way down, and levels 1-100 now
       contain the gentle end of BOTH populations rather than only the 6x6s.

       For a single-size tier this is identical to the old global sort. */
    const byGen = new Map();
    for (const r of rows) {
      const g = r[4] || tier.gen;
      if (!byGen.has(g)) byGen.set(g, []);
      byGen.get(g).push(r);
    }
    const cand = [];
    for (const [g, list] of byGen) {
      list.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      list.forEach((r, i) => cand.push({
        seed: r[0], effort: r[1], key: r[2], N: r[3], gen: g,
        // rampRatio is the level's place in the ladder, and drives par. It is
        // captured BEFORE the dispersion pass so par tracks real difficulty.
        rampRatio: list.length > 1 ? i / (list.length - 1) : 0.5,
        vec: M.characterVector(r[2], r[3]),
      }));
    }
    cand.sort((a, b) => a.rampRatio - b.rampRatio || a.effort - b.effort || a.seed - b.seed);

    const ordered = [];
    let carry = null;
    for (let s = 0; s < cand.length; s += BLOCK) {
      const block = disperse(cand.slice(s, s + BLOCK), carry, tier.sizeBonus);
      for (const c of block) ordered.push(c);
      carry = block[block.length - 1];
    }

    out[tier.key] = ordered.map((c) => {
      /* A 7x7 Paddock board takes a person longer than a 6x6 one at the same
         solver effort, so an above-baseline grid gets a floor under its par
         ratio. Without it an early-ramp 7x7 would inherit a 6x6's par. */
      let ratio = c.rampRatio;
      if (c.N > tier.N) ratio = Math.max(ratio, 0.35);
      /* Fourth element is the gen key as a STRING. Meta.levelRow reads a string
         here as this level's gen key and ignores a number, so a bare size would
         be silently dropped and every Paddock level would rebuild at the tier
         default. Only emit the column when a tier actually has a menu. */
      const out4 = tier.gens ? [c.seed, c.effort, Par.parMs(tier.key, ratio), c.gen]
                             : [c.seed, c.effort, Par.parMs(tier.key, ratio)];
      return out4;
    });

    const sizeMix = {};
    for (const c of ordered) sizeMix[c.N] = (sizeMix[c.N] || 0) + 1;
    meta.push({
      key: tier.key, name: tier.name, gen: tier.gen, N: tier.N,
      sizes: tier.sizes, sizeMix, k: tier.k,
      levels: count, effortLo: lo, effortHi: hi, block: BLOCK
    });
    total += count;
    console.log(
      "  " + tier.key.padEnd(10) + count + " levels  effort " + lo + "-" + hi +
      "  sizes " + JSON.stringify(sizeMix) +
      "  par " + (out[tier.key][0] ? (out[tier.key][0][2] / 1000) : 0) + "s-" +
      (count ? out[tier.key][count - 1][2] / 1000 : 0) + "s"
    );
  }

  const body =
    '"use strict";\n' +
    "/* GENERATED by scripts/build-levels.js — do not edit by hand.\n\n" +
    "   Each row is [seed, effort, par] or [seed, effort, par, genKey]:\n" +
    "     seed   the EFFECTIVE generator seed. generate({tier, seed}) rebuilds\n" +
    "            this exact board on attempt 0.\n" +
    "     effort the solver's own weighted deduction cost — the ramp axis.\n" +
    "     par    the target time in ms (js/par.js), forgiving by design.\n" +
    "     genKey OPTIONAL 4th element, a STRING naming this level's generator\n" +
    "            tier. The mixed-size tiers have it: Paddock mixes 6x6 and 7x7\n" +
    "            ('easy6'/'easy7'), Pasture mixes 8x8 and 9x9\n" +
    "            ('medium8'/'medium9'), and the device passes it straight to\n" +
    "            generate({tier: genKey, seed}). The size is therefore a\n" +
    "            recorded fact, never re-derived. Tiers with one size omit it.\n\n" +
    "   Difficulty rises in BLOCKS of " + BLOCK + " levels; inside a block the order is\n" +
    "   chosen so consecutive boards differ as much as possible in pen character,\n" +
    "   because a 6x6 one-bull board simply does not have 1000 distinct\n" +
    "   difficulties to offer. See the header of scripts/build-levels.js. */\n\n" +
    "var BULLPEN_TIERS = " + JSON.stringify(meta, null, 2) + ";\n\n" +
    "var BULLPEN_LEVELS = {\n" +
    TIERS.map((t) =>
      "  " + t.key + ": [\n" +
      // JSON.stringify, not join(",") — the optional 4th element is a STRING
      // gen key and has to come out quoted.
      (out[t.key] || []).map((r) => "    " + JSON.stringify(r)).join(",\n") +
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
