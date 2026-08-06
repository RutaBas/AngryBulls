"use strict";

/* BULLPEN — variety report.  node scripts/measure-variety.js

   Reads the SHIPPED js/levels.js and joins each level's effective seed back to
   the pen layout recorded in scripts/.cache/<tier>.json, then reports the
   numbers Ruta's complaint is actually about:

     - distinct effort values in levels 1-100      (are early levels the same?)
     - distinct canonical pen shapes / 60 boards   (do pens repeat?)
     - mean character distance between ADJACENT levels (are neighbours twins?)

   Pure reporting; writes nothing. */

const fs = require("fs");
const path = require("path");
const M = require("./variety-metrics.js");

const ROOT = path.join(__dirname, "..");
const TIERS = [
  { key: "paddock", N: 6 }, { key: "pasture", N: 8 },
  { key: "rangeland", N: 9 }, { key: "badlands", N: 10 },
];

/* Works on both the old cache row ([seed, effort, penKey]) and the new one
   ([seed, effort, penKey, N, genKey]), so before/after are measured the same
   way and the comparison is honest. */
function boardsOf(cache, levels, defaultN) {
  const bySeed = new Map();
  for (const k of Object.keys(cache)) {
    const r = cache[k];
    if (r) bySeed.set(r[0], { key: r[2], N: r[3] || defaultN });
  }
  return levels.map((r) => bySeed.get(r[0])).filter(Boolean);
}

function main() {
  const L = require(path.join(ROOT, "js", "levels.js"));
  const rowsOut = [];
  for (const t of TIERS) {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(path.join(__dirname, ".cache", t.key + ".json"), "utf8")); }
    catch (e) { /* no cache — shape metrics unavailable */ }
    const levels = L.BULLPEN_LEVELS[t.key] || [];
    const boards = boardsOf(cache, levels, t.N);

    const eff100 = new Set(levels.slice(0, 100).map((r) => r[1]));
    const effAll = new Set(levels.map((r) => r[1]));

    // Shapes are counted per grid size — the same polyomino in a 6x6 and a 7x7
    // pen layout is a different-looking board, so the size is part of the key.
    const shapes = new Set();
    let penTotal = 0;
    for (const b of boards.slice(0, 60)) {
      for (const p of M.pensFromKey(b.key, b.N)) { shapes.add(b.N + ":" + M.shapeSig(p)); penTotal++; }
    }
    const boardsDistinct = new Set(boards.slice(0, 60).map((b) => b.N + ":" + b.key)).size;

    // Adjacent-level difference, over the first 200 levels.
    const win = boards.slice(0, 200);
    const vecs = win.map((b) => M.characterVector(b.key, b.N));
    let adjChar = 0, adjShape = 0, sizeFlips = 0;
    for (let i = 1; i < win.length; i++) {
      adjChar += M.charDistance(vecs[i - 1], vecs[i]);
      adjShape += win[i].N === win[i - 1].N
        ? M.shapeDistance(win[i - 1].key, win[i].key, win[i].N) : 1;
      if (win[i].N !== win[i - 1].N) sizeFlips++;
    }
    const d = Math.max(1, win.length - 1);
    const sizeMix = {};
    for (const b of boards) sizeMix[b.N] = (sizeMix[b.N] || 0) + 1;

    /* THE COMPLAINT METRICS.
       longestRun  the longest run of consecutive levels with identical effort
                   AND identical grid size — the "levels 1-20 are all the same"
                   number Ruta actually felt.
       twins       fraction of adjacent level pairs whose pen character differs
                   by less than 0.15, i.e. pairs a player would call near-twins.
       Both over the first 200 levels. */
    let longestRun = 0, run = 0, twins = 0;
    for (let i = 0; i < win.length; i++) {
      const same = i > 0 && levels[i][1] === levels[i - 1][1] && win[i].N === win[i - 1].N;
      run = same ? run + 1 : 1;
      if (run > longestRun) longestRun = run;
      if (i > 0 && M.charDistance(vecs[i - 1], vecs[i]) < 0.15) twins++;
    }

    rowsOut.push({
      tier: t.key,
      levels: levels.length,
      distinctEffort_1_100: eff100.size,
      distinctEffort_all: effAll.size,
      effortLo: levels.length ? levels[0][1] : 0,
      effortHi: levels.length ? levels[levels.length - 1][1] : 0,
      shapes60: shapes.size + "/" + penTotal,
      distinctBoards60: boardsDistinct + "/60",
      adjChar: (adjChar / d).toFixed(4),
      adjShape: (adjShape / d).toFixed(4),
      longestSameRun_200: longestRun,
      nearTwinPairs_200: twins + "/" + d,
      sizeFlips_200: sizeFlips,
      sizeMix: JSON.stringify(sizeMix),
    });
  }
  console.table(rowsOut);
}

if (require.main === module) main();
module.exports = { main };
