"use strict";

/* BULLPEN — variety metrics.

   Shared, dependency-free measurements of how DIFFERENT two pen layouts look.
   Used two ways:
     - by scripts/build-levels.js, to order levels so that consecutive boards
       differ in pen character (not just in effort);
     - by scripts/measure-variety.js, to report before/after numbers.

   Nothing here touches the solver or decides whether a board is legal. These
   are cosmetic/structural descriptors only. */

/* Canonical shape signature of one pen, invariant under translation and the 8
   square symmetries. Two pens share a signature iff they are the same polyomino
   up to rotation/reflection. */
function shapeSig(cellsRC) {
  let best = null;
  for (let sym = 0; sym < 8; sym++) {
    const pts = cellsRC.map(([r, c]) => {
      let x = r, y = c;
      if (sym & 4) { const t = x; x = y; y = t; }
      if (sym & 1) x = -x;
      if (sym & 2) y = -y;
      return [x, y];
    });
    let minx = Infinity, miny = Infinity;
    for (const [x, y] of pts) { if (x < minx) minx = x; if (y < miny) miny = y; }
    const norm = pts.map(([x, y]) => [x - minx, y - miny]);
    norm.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const s = norm.map((p) => p[0] + "," + p[1]).join(";");
    if (best === null || s < best) best = s;
  }
  return best;
}

/* penKey (base36 digits, one per cell, row-major) -> array of pens, each an
   array of [r,c]. */
function pensFromKey(key, N) {
  const groups = new Map();
  for (let i = 0; i < key.length; i++) {
    const p = parseInt(key[i], 36);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push([(i / N) | 0, i % N]);
  }
  return [...groups.keys()].sort((a, b) => a - b).map((p) => groups.get(p));
}

/* ---------------------------------------------------------- character vector

   Four numbers that describe the FEEL of a layout, all scale-free so 6x6 and
   10x10 are comparable:

     sizeSpread   stddev of pen sizes / mean size. 0 = every pen the same size,
                  high = a couple of continents plus several scraps.
     rectDeficit  mean over pens of 1 - area/bboxArea. 0 = every pen is a solid
                  rectangle, high = L/T/S and snaking pens.
     elongation   mean over pens of (long bbox side - short) / (long + short).
                  0 = square-ish blobs, high = long thin pens.
     roughness    mean over pens of perimeter / (2*ceil(2*sqrt(area))), i.e. how
                  much longer the border is than a compact blob of that area.
                  ~1 = compact, high = ragged / snaking.
*/
function characterVector(key, N) {
  const pens = pensFromKey(key, N);
  const sizes = pens.map((p) => p.length);
  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const varr = sizes.reduce((a, b) => a + (b - mean) * (b - mean), 0) / sizes.length;
  const sizeSpread = Math.sqrt(varr) / (mean || 1);

  let rectDef = 0, elong = 0, rough = 0;
  for (const cellsRC of pens) {
    let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
    const set = new Set();
    for (const [r, c] of cellsRC) {
      set.add(r * N + c);
      if (r < r0) r0 = r; if (r > r1) r1 = r;
      if (c < c0) c0 = c; if (c > c1) c1 = c;
    }
    const h = r1 - r0 + 1, w = c1 - c0 + 1;
    rectDef += 1 - cellsRC.length / (h * w);
    const lo = Math.min(h, w), hiD = Math.max(h, w);
    elong += (hiD - lo) / (hiD + lo);
    let per = 0;
    for (const [r, c] of cellsRC) {
      if (!set.has((r - 1) * N + c) || r === 0) per++;
      if (!set.has((r + 1) * N + c) || r === N - 1) per++;
      if (!set.has(r * N + c - 1) || c === 0) per++;
      if (!set.has(r * N + c + 1) || c === N - 1) per++;
    }
    const compact = 2 * Math.ceil(2 * Math.sqrt(cellsRC.length));
    rough += per / compact;
  }
  const n = pens.length;
  return [sizeSpread, rectDef / n, elong / n, rough / n];
}

function charDistance(a, b) {
  /* Weighted L1. sizeSpread and rectDeficit are the two a player notices most,
     so they carry more weight than elongation/roughness. */
  const w = [1.6, 1.4, 0.9, 0.9];
  let d = 0;
  for (let i = 0; i < a.length; i++) d += w[i] * Math.abs(a[i] - b[i]);
  return d;
}

/* Multiset-of-shapes distance: 1 - Jaccard over canonical pen signatures.
   0 = the two boards use exactly the same set of pen shapes. */
function shapeDistance(keyA, keyB, N) {
  const A = new Set(pensFromKey(keyA, N).map(shapeSig));
  const B = new Set(pensFromKey(keyB, N).map(shapeSig));
  let inter = 0;
  for (const s of A) if (B.has(s)) inter++;
  return 1 - inter / (A.size + B.size - inter);
}

/* Distinct canonical pen shapes over the first `window` boards of a tier. */
function distinctShapes(keys, N, window) {
  const set = new Set();
  let pens = 0;
  for (const key of keys.slice(0, window)) {
    for (const p of pensFromKey(key, N)) { set.add(shapeSig(p)); pens++; }
  }
  return { distinct: set.size, pens };
}

/* Mean character distance between CONSECUTIVE levels — the "adjacent levels are
   not near-twins" metric. */
function adjacencyVariety(keys, N) {
  if (keys.length < 2) return 0;
  const vs = keys.map((k) => characterVector(k, N));
  let sum = 0;
  for (let i = 1; i < vs.length; i++) sum += charDistance(vs[i - 1], vs[i]);
  return sum / (vs.length - 1);
}

/* Mean shape-overlap distance between consecutive levels. */
function adjacentShapeDistance(keys, N) {
  if (keys.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < keys.length; i++) sum += shapeDistance(keys[i - 1], keys[i], N);
  return sum / (keys.length - 1);
}

module.exports = {
  shapeSig, pensFromKey, characterVector, charDistance,
  shapeDistance, distinctShapes, adjacencyVariety, adjacentShapeDistance,
};
