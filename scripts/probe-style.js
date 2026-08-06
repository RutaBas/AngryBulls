"use strict";

/* Probe: does the layout style survive refinePens/softenPens, and what does it
   cost in throughput?  node scripts/probe-style.js <genTier> <N> <count> [floor]

   Prints the character vectors of the ACCEPTED boards (post-solver), so we can
   see whether the growth-stage knobs still show up in the shipped layout. */

const path = require("path");
const ROOT = path.join(__dirname, "..");
const gen = require(path.join(ROOT, "js", "generator.js"));
const { hashSeed } = require(path.join(ROOT, "js", "rng.js"));
const M = require("./variety-metrics.js");

const genTier = process.argv[2] || "easy";
/* "-" means "let the tier choose its own grid size(s)"; a number pins it. */
const forceN = process.argv[3] === "-" ? 0 : parseInt(process.argv[3] || "0", 10);
const COUNT = parseInt(process.argv[4] || "40", 10);
const floor = process.argv[5] || null;

function penKeyOf(pens) {
  let s = "";
  for (let i = 0; i < pens.length; i++) s += pens[i].toString(36);
  return s;
}

const keys = [], vecs = [], efforts = [], styles = [], sizes = [];
const shapeSet = new Set();
let penTotal = 0;
const t0 = Date.now();
let tried = 0;
for (let n = 1; keys.length < COUNT && n < COUNT * 40; n++) {
  tried++;
  const seed = hashSeed("probe|" + genTier + "|" + n);
  const req = { tier: genTier, seed, maxAttempts: 400 };
  if (forceN) req.N = forceN;
  const g = gen.generate(req);
  if (!g.pens) continue;
  if (floor && g.maxTechnique !== floor) continue;
  const key = penKeyOf(g.pens);
  keys.push(key);
  sizes.push(g.N);
  // metrics ALWAYS use the board's own N — a mixed-size tier has no single N.
  vecs.push(M.characterVector(key, g.N));
  for (const p of M.pensFromKey(key, g.N)) { shapeSet.add(g.N + ":" + M.shapeSig(p)); penTotal++; }
  efforts.push(g.effort);
  styles.push(g.style);
}
const secs = (Date.now() - t0) / 1000;

const ds = { distinct: shapeSet.size, pens: penTotal };
const col = (i) => vecs.map((v) => v[i]);
const stat = (a) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length);
  return m.toFixed(3) + " +/-" + sd.toFixed(3) + " [" + Math.min(...a).toFixed(2) + ".." + Math.max(...a).toFixed(2) + "]";
};
const sizeMix = {};
for (const s of sizes) sizeMix[s] = (sizeMix[s] || 0) + 1;
console.log(genTier + " N=" + (forceN || "mixed") + " boards=" + keys.length + " tried=" + tried +
  "  " + (secs * 1000 / keys.length).toFixed(0) + "ms/board  sizes " + JSON.stringify(sizeMix));
console.log("  distinct shapes  " + ds.distinct + "/" + ds.pens);
console.log("  sizeSpread       " + stat(col(0)));
console.log("  rectDeficit      " + stat(col(1)));
console.log("  elongation       " + stat(col(2)));
console.log("  roughness        " + stat(col(3)));
console.log("  effort distinct  " + new Set(efforts).size + " of " + efforts.length +
  " range " + Math.min(...efforts) + "-" + Math.max(...efforts));

/* Correlation between the sampled style knob and the realised character —
   this is what tells us the knob survived the solver-driven refinement. */
function corr(a, b) {
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db || 1);
}
console.log("  corr(sizeBias, sizeSpread)     " + corr(styles.map(s => s.sizeBias), col(0)).toFixed(3));
console.log("  corr(spread,   sizeSpread)     " + corr(styles.map(s => s.spread), col(0)).toFixed(3));
console.log("  corr(compactness, rectDeficit) " + corr(styles.map(s => s.compactness), col(1)).toFixed(3));
console.log("  corr(compactness, roughness)   " + corr(styles.map(s => s.compactness), col(3)).toFixed(3));
