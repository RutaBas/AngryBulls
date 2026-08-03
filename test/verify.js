"use strict";

/* BULLPEN — adversarial correctness gate.

     node games/bullpen/test/verify.js
     BULLPEN_BATCH=100 node games/bullpen/test/verify.js

   The stance here is that the solver is WRONG until its numbers say otherwise.
   Nothing in this file asks the solver for its opinion of itself: the rule
   checker, the solution counter and the truth comparison below are all written
   fresh from the puzzle's rules, and every check prints the real numbers it
   measured. A red gate is a valid outcome; the exit code is non-zero if any
   assertion fails. */

const path = require("path");
const { execFileSync } = require("child_process");

const JS = path.join(__dirname, "..", "js");
const solver = require(path.join(JS, "solver.js"));
const gen = require(path.join(JS, "generator.js"));
const { mulberry32, hashSeed } = require(path.join(JS, "rng.js"));

/* Seeds exactly the way the shipped level builder must: a hashed string per
   (tier, index). NOTE: a naive `SEED + n * 0x9e3779b1` stride is NOT safe here
   — generate() walks its own attempts with that same stride, so board n's
   attempt 0 is bit-for-bit board n-1's attempt 1, and a tier that needs a few
   attempts collapses to a handful of distinct layouts. */
const boardSeed = (tier, n) => hashSeed("bullpen|" + SEED + "|" + tier + "|" + n);

const BATCH = parseInt(process.env.BULLPEN_BATCH || "40", 10);
const SEED = parseInt(process.env.BULLPEN_SEED || "20260803", 10);
const TIERS = ["easy", "medium", "hard", "extreme"];

const UNKNOWN = solver.UNKNOWN, BULL = solver.BULL, EMPTY = solver.EMPTY;

let failures = 0;
const log = (s) => console.log(s);
function assert(name, cond, detail) {
  if (!cond) failures++;
  log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  return !!cond;
}
const ms = (t0) => ((Date.now() - t0) / 1000).toFixed(1) + "s";
function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ============================================================ INDEPENDENT RULES
/* Everything below is written from the statement of the puzzle, not from the
   solver's source. If the solver and these disagree, the solver is wrong. */

function orth(N, i) {
  const r = (i / N) | 0, c = i % N, out = [];
  if (r > 0) out.push(i - N);
  if (r + 1 < N) out.push(i + N);
  if (c > 0) out.push(i - 1);
  if (c + 1 < N) out.push(i + 1);
  return out;
}

/* Do the pens partition the grid into N non-empty 4-connected regions? */
function checkPens(N, pens) {
  const cells = N * N;
  if (!pens || pens.length !== cells) return "pens array wrong length";
  const members = [];
  for (let p = 0; p < N; p++) members.push([]);
  for (let i = 0; i < cells; i++) {
    const p = pens[i];
    if (!(p >= 0 && p < N) || p !== Math.floor(p)) return "cell " + i + " has pen id " + p;
    members[p].push(i);
  }
  let covered = 0;
  for (let p = 0; p < N; p++) {
    const m = members[p];
    if (!m.length) return "pen " + p + " is empty";
    covered += m.length;
    const seen = new Set([m[0]]);
    const q = [m[0]];
    for (let h = 0; h < q.length; h++) {
      for (const nb of orth(N, q[h])) {
        if (pens[nb] !== p || seen.has(nb)) continue;
        seen.add(nb); q.push(nb);
      }
    }
    if (seen.size !== m.length) return "pen " + p + " is not 4-connected (" + seen.size + "/" + m.length + ")";
  }
  if (covered !== cells) return "pens cover " + covered + " of " + cells + " cells";
  return null;
}

/* Is this bull placement legal: exactly k per row / column / pen, none of the
   8 king-neighbours of a bull is a bull. Written from the rules; the solver's
   isSolution() is never called. */
function checkSolution(N, k, pens, sol) {
  const cells = N * N;
  const isB = (i) => sol[i] === 1 || sol[i] === BULL;
  const rows = new Array(N).fill(0), cols = new Array(N).fill(0), pn = new Array(N).fill(0);
  for (let i = 0; i < cells; i++) {
    if (!isB(i)) continue;
    const r = (i / N) | 0, c = i % N;
    rows[r]++; cols[c]++; pn[pens[i]]++;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue;
        if (isB(rr * N + cc)) return "bulls touch at r" + (r + 1) + "c" + (c + 1);
      }
    }
  }
  for (let x = 0; x < N; x++) {
    if (rows[x] !== k) return "row " + (x + 1) + " has " + rows[x] + " bulls, wanted " + k;
    if (cols[x] !== k) return "col " + (x + 1) + " has " + cols[x] + " bulls, wanted " + k;
    if (pn[x] !== k) return "pen " + (x + 1) + " has " + pn[x] + " bulls, wanted " + k;
  }
  return null;
}

/* My own solution counter: plain cell-by-cell backtracking with counting
   prunes. Deliberately a completely different algorithm from the solver's
   row-placement search, so agreeing with it is real evidence. */
function bruteCount(N, k, pens, cap) {
  const cells = N * N;
  const rows = new Int32Array(N), cols = new Int32Array(N), pn = new Int32Array(N);
  const penLeft = new Int32Array(N);
  for (let i = 0; i < cells; i++) penLeft[pens[i]]++;
  const grid = new Uint8Array(cells);
  let found = 0;
  function touchesBull(i) {
    const r = (i / N) | 0, c = i % N;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue;
        if (grid[rr * N + cc]) return true;
      }
    return false;
  }
  function rec(i) {
    if (found >= cap) return;
    if (i === cells) {
      // final verification — the prunes only prove a unit CAN still reach k,
      // never that it did. Counting a leaf without this is how a counter
      // silently over-counts.
      for (let x = 0; x < N; x++) if (rows[x] !== k || cols[x] !== k || pn[x] !== k) return;
      found++;
      return;
    }
    const r = (i / N) | 0, c = i % N, p = pens[i];
    const rowLeft = N - c, colLeft = N - r;
    // prune: can the row / col / pen still reach k from here?
    if (k - rows[r] > rowLeft) return;
    if (k - cols[c] > colLeft) return;
    if (k - pn[p] > penLeft[p]) return;
    penLeft[p]--;
    // a unit that closes at this cell must be exactly full
    const closes = () =>
      (c === N - 1 && rows[r] !== k) || (r === N - 1 && cols[c] !== k) || (penLeft[p] === 0 && pn[p] !== k);
    // try BULL
    if (rows[r] < k && cols[c] < k && pn[p] < k && !touchesBull(i)) {
      grid[i] = 1; rows[r]++; cols[c]++; pn[p]++;
      if (!closes()) rec(i + 1);
      grid[i] = 0; rows[r]--; cols[c]--; pn[p]--;
    }
    // try EMPTY
    if (found < cap && !closes()) rec(i + 1);
    penLeft[p]++;
  }
  rec(0);
  return found;
}

/* Compare a solver grid against ground truth MYSELF. Returns the list of
   cells the solver settled that disagree with the real solution. */
function truthViolations(N, grid, sol) {
  const bad = [];
  for (let i = 0; i < N * N; i++) {
    const v = grid[i];
    if (v === UNKNOWN) continue;
    const t = (sol[i] === 1 || sol[i] === BULL) ? BULL : EMPTY;
    if (v !== t) bad.push({ i, r: (i / N) | 0, c: i % N, claimed: v === BULL ? "BULL" : "EMPTY" });
  }
  return bad;
}

function penKey(pens) { return Array.from(pens).join(","); }

// ================================================================ BUILD BATCH
const BOARDS = {};
function buildBatch() {
  log(`\n--- BATCH: generating ${BATCH} boards per tier (seed base ${SEED}) ---`);
  let allOk = true, totalFail = 0;
  for (const tier of TIERS) {
    const t0 = Date.now();
    const list = [];
    let fails = 0, attempts = 0;
    for (let n = 0; n < BATCH; n++) {
      const b = gen.generate({ tier, seed: boardSeed(tier, n) });
      if (!b || !b.pens) { fails++; continue; }
      attempts += b.attempts;
      list.push(b);
    }
    BOARDS[tier] = list;
    const per = (Date.now() - t0) / Math.max(1, BATCH);
    log(`  ${tier.padEnd(8)} ${list.length}/${BATCH} boards, ${fails} failures, ` +
        `mean ${(attempts / Math.max(1, list.length)).toFixed(1)} internal attempts, ` +
        `${per.toFixed(0)} ms/board, total ${ms(t0)}`);
    if (fails) { allOk = false; totalFail += fails; }
  }
  assert("0. generate() returned a board for every request (tight loop, no timeouts)", allOk,
    `${totalFail} failure(s)`);
}

// ===================================================================== CASE 1
function case1_structure() {
  log("\n--- CASE 1: structural validity (own partition/connectivity/rule checker) ---");
  let boards = 0, penErr = 0, solErr = 0;
  const firstErr = [];
  for (const tier of TIERS) {
    for (const b of BOARDS[tier]) {
      boards++;
      const e1 = checkPens(b.N, b.pens);
      if (e1) { penErr++; if (firstErr.length < 3) firstErr.push(tier + ": " + e1); }
      const e2 = checkSolution(b.N, b.k, b.pens, b.solution);
      if (e2) { solErr++; if (firstErr.length < 3) firstErr.push(tier + ": " + e2); }
    }
  }
  log(`  boards checked: ${boards}`);
  log(`  pen-partition / connectivity errors: ${penErr}   (must be 0)`);
  log(`  solution rule violations:            ${solErr}   (must be 0)`);
  if (firstErr.length) firstErr.forEach((e) => log("    " + e));
  assert("1.a every board's pens partition the grid into N connected pens", penErr === 0, `${penErr} bad`);
  assert("1.b every board's solution obeys k-per-row/col/pen + no-touch", solErr === 0, `${solErr} bad`);
}

// ===================================================================== CASE 2
function case2_soundness() {
  log("\n--- CASE 2: SOUNDNESS (primary gate) — every deduction vs ground truth ---");
  let settled = 0, viol = 0, checks = 0;
  const detail = [];
  for (const tier of TIERS) {
    for (const b of BOARDS[tier]) {
      const p = { N: b.N, k: b.k, pens: b.pens };
      for (const allow of [false, true]) {
        for (const mss of [2, 3, 4]) {
          const r = solver.solve(p, { allowContradiction: allow, maxSetSize: mss });
          checks++;
          const bad = truthViolations(b.N, r.grid, b.solution);
          for (let i = 0; i < b.N * b.N; i++) if (r.grid[i] !== UNKNOWN) settled++;
          if (r.contradiction) {
            viol++;
            if (detail.length < 5) detail.push(`${tier} contradiction on a valid board: ${r.contradictionReason}`);
          }
          if (bad.length) {
            viol += bad.length;
            if (detail.length < 5) detail.push(`${tier} allow=${allow} mss=${mss}: r${bad[0].r + 1}c${bad[0].c + 1} claimed ${bad[0].claimed}`);
          }
          // and independently confirm the solver's own truth mode agrees
          if (mss === 4) {
            const ct = solver.checkAgainstTruth(p, b.solution, { allowContradiction: allow });
            if (!ct.sound) {
              viol += ct.violations.length;
              if (detail.length < 5) detail.push(`${tier} checkAgainstTruth: ${ct.message}`);
            }
          }
        }
      }
    }
  }
  log(`  solve() runs:            ${checks} (each board x {allowContradiction f,t} x {maxSetSize 2,3,4})`);
  log(`  cells settled & checked: ${settled}`);
  log(`  deductions contradicting ground truth: ${viol}   (must be 0)`);
  detail.forEach((d) => log("    " + d));
  assert("2.a zero unsound deductions across every solver configuration", viol === 0, `${viol} violation(s) over ${settled} settled cells`);
}

function case2b_randomBoards() {
  log("\n--- CASE 2b: soundness on RANDOM (non-unique) layouts, 2,000 boards ---");
  const t0 = Date.now();
  const rng = mulberry32(SEED ^ 0x5bd1e995);
  let boards = 0, settled = 0, viol = 0, contra = 0;
  const detail = [];
  const shapes = [{ N: 6, k: 1 }, { N: 8, k: 1 }, { N: 9, k: 2 }, { N: 10, k: 2 }];
  let tries = 0;
  while (boards < 2000 && tries < 6000) {
    tries++;
    const s = shapes[tries % shapes.length];
    const layout = gen.generatePens(s.N, s.k, rng, 8);
    if (!layout) continue;
    boards++;
    const p = { N: s.N, k: s.k, pens: layout.pens };
    // layout.solution IS a real solution, so ANY sound deduction must agree
    // with it even when the board admits many solutions.
    for (const allow of [false, true]) {
      const r = solver.solve(p, { allowContradiction: allow, maxSetSize: allow ? 4 : 2 });
      for (let i = 0; i < s.N * s.N; i++) if (r.grid[i] !== UNKNOWN) settled++;
      if (r.contradiction) { contra++; if (detail.length < 5) detail.push(`${s.N}x${s.N} k${s.k}: ${r.contradictionReason}`); }
      const bad = truthViolations(s.N, r.grid, layout.solution);
      if (bad.length) { viol += bad.length; if (detail.length < 5) detail.push(`${s.N}x${s.N} k${s.k}: r${bad[0].r + 1}c${bad[0].c + 1} claimed ${bad[0].claimed}`); }
    }
  }
  log(`  random layouts solved:   ${boards} (${ms(t0)})`);
  log(`  cells settled & checked: ${settled}`);
  log(`  unsound deductions:      ${viol}   (must be 0)`);
  log(`  false contradictions on a satisfiable board: ${contra}   (must be 0)`);
  detail.forEach((d) => log("    " + d));
  assert("2.b zero unsound deductions on 2,000 random layouts", viol === 0, `${viol} violation(s)`);
  assert("2.c solver never reports a contradiction on a board that has a solution", contra === 0, `${contra}`);
}

// ===================================================================== CASE 3
function case3_uniqueness() {
  log("\n--- CASE 3: uniqueness, and the uniqueness prover itself ---");
  let boards = 0, notUnique = 0;
  for (const tier of TIERS) {
    for (const b of BOARDS[tier]) {
      boards++;
      const c = solver.countSolutions({ N: b.N, k: b.k, pens: b.pens }, 3).count;
      if (c !== 1) notUnique++;
    }
  }
  log(`  boards with countSolutions(p,3) === 1: ${boards - notUnique}/${boards}`);
  assert("3.a every generated board has exactly one solution", notUnique === 0, `${notUnique} not unique`);

  // cross-check the prover against my own counter on small random layouts
  log("  cross-checking countSolutions() against an independent brute force (6x6 k=1, 200 layouts):");
  const rng = mulberry32(SEED ^ 0x1234567);
  let n = 0, disagree = 0, tries = 0;
  const dist = {};
  const detail = [];
  while (n < 200 && tries < 900) {
    tries++;
    const layout = gen.generatePens(6, 1, rng, 8);
    if (!layout) continue;
    n++;
    const p = { N: 6, k: 1, pens: layout.pens };
    const a = solver.countSolutions(p, 20).count;
    const b = bruteCount(6, 1, layout.pens, 20);
    dist[a] = (dist[a] || 0) + 1;
    if (a !== b) { disagree++; if (detail.length < 4) detail.push(`countSolutions=${a} brute=${b}`); }
  }
  const keys = Object.keys(dist).map(Number).sort((x, y) => x - y);
  log(`    layouts: ${n}, solution-count spread: ${keys.map((x) => x + "x" + dist[x]).join(" ")}`);
  log(`    disagreements: ${disagree}   (must be 0)`);
  detail.forEach((d) => log("      " + d));
  assert("3.b countSolutions() agrees with an independent brute-force counter", disagree === 0, `${disagree}/${n}`);
  assert("3.c the cross-check saw a real spread of counts (not all 0 or all 1)", keys.length >= 2 && keys.some((x) => x > 1),
    `counts seen: ${keys.join(",")}`);
}

// ===================================================================== CASE 4
function case4_noGuess() {
  log("\n--- CASE 4: gate SUFFICIENT — no board ever requires a guess ---");
  let ok = true;
  for (const tier of TIERS) {
    const rule = gen.TIERS[tier];
    let solved = 0, viol = 0;
    for (const b of BOARDS[tier]) {
      const p = { N: b.N, k: b.k, pens: b.pens };
      const r = solver.solve(p, {
        allowContradiction: !!rule.allowContradiction,
        maxSetSize: rule.maxSetSize,
      });
      // independent completeness + rule check, not solver.solved
      let complete = true;
      for (let i = 0; i < b.N * b.N; i++) if (r.grid[i] === UNKNOWN) complete = false;
      const rulesOk = complete && !checkSolution(b.N, b.k, b.pens, Array.from(r.grid).map((v) => (v === BULL ? 1 : 0)));
      const bad = truthViolations(b.N, r.grid, b.solution).length;
      if (rulesOk && !bad) solved++; else viol++;
    }
    log(`  ${tier.padEnd(8)} fully solved with its own tier toolkit ` +
        `(allowContradiction=${!!rule.allowContradiction}, maxSetSize=${rule.maxSetSize}): ${solved}/${BOARDS[tier].length}`);
    if (viol) ok = false;
  }
  // and the stronger claim: the three non-extreme tiers need NO trials at all
  let noTrial = 0, total = 0;
  for (const tier of ["easy", "medium", "hard"]) {
    for (const b of BOARDS[tier]) {
      total++;
      const r = solver.solve({ N: b.N, k: b.k, pens: b.pens }, { allowContradiction: false, maxSetSize: gen.TIERS[tier].maxSetSize });
      let complete = true;
      for (let i = 0; i < b.N * b.N; i++) if (r.grid[i] === UNKNOWN) complete = false;
      if (complete && !truthViolations(b.N, r.grid, b.solution).length) noTrial++;
    }
  }
  log(`  easy+medium+hard solvable with allowContradiction:false : ${noTrial}/${total}`);
  assert("4.a every board is fully and correctly solved by its tier's toolkit", ok);
  assert("4.b no non-extreme board needs a hypothetical (contradiction) step", noTrial === total, `${total - noTrial} needed one`);
}

// ===================================================================== CASE 5
function case5_necessity() {
  log("\n--- CASE 5: gate NECESSARY — the hard techniques are genuinely required ---");

  // sanity: the cap option really removes techniques
  const probe = BOARDS.hard[0];
  const capped = solver.solve({ N: probe.N, k: probe.k, pens: probe.pens }, { allowContradiction: false, maxTechnique: "adjacency" });
  const usedOnly = Object.keys(capped.techniques);
  assert("5.0 maxTechnique cap really restricts the ladder", usedOnly.every((t) => t === "adjacency"),
    `techniques used under cap 'adjacency': ${usedOnly.join(",") || "none"}`);

  // HARD: must not be solvable with the medium toolkit (up to line-in-region)
  let hardBlocked = 0;
  const hardCells = [];
  for (const b of BOARDS.hard) {
    const r = solver.solve({ N: b.N, k: b.k, pens: b.pens }, {
      allowContradiction: false, maxSetSize: 2, maxTechnique: "line-in-region",
    });
    let open = 0;
    for (let i = 0; i < b.N * b.N; i++) if (r.grid[i] === UNKNOWN) open++;
    hardCells.push(open);
    if (open > 0) hardBlocked++;
  }
  log(`  hard boards NOT solvable with techniques <= line-in-region: ${hardBlocked}/${BOARDS.hard.length}`);
  log(`    cells still unknown when capped: median ${median(hardCells)}, min ${Math.min(...hardCells)}, max ${Math.max(...hardCells)}`);
  assert("5.a every HARD board genuinely requires adjacency-packing or set-cover", hardBlocked === BOARDS.hard.length,
    `${BOARDS.hard.length - hardBlocked} crackable with the medium toolkit`);

  // EXTREME: must not be solvable with maxSetSize 2 and no trials
  let exBlocked = 0;
  const exCells = [];
  for (const b of BOARDS.extreme) {
    const r = solver.solve({ N: b.N, k: b.k, pens: b.pens }, { allowContradiction: false, maxSetSize: 2 });
    let open = 0;
    for (let i = 0; i < b.N * b.N; i++) if (r.grid[i] === UNKNOWN) open++;
    exCells.push(open);
    if (open > 0) exBlocked++;
  }
  log(`  extreme boards NOT solvable with maxSetSize:2 + no trials: ${exBlocked}/${BOARDS.extreme.length}`);
  log(`    cells still unknown when capped: median ${median(exCells)}, min ${Math.min(...exCells)}, max ${Math.max(...exCells)}`);
  assert("5.b every EXTREME board genuinely needs deep sets (|S|>=3) or a contradiction", exBlocked === BOARDS.extreme.length,
    `${BOARDS.extreme.length - exBlocked} crackable with the hard toolkit`);

  // MEDIUM: should need more than the easy band's top technique on at least some boards
  let medNeedsConverse = 0;
  for (const b of BOARDS.medium) {
    const r = solver.solve({ N: b.N, k: b.k, pens: b.pens }, { allowContradiction: false, maxSetSize: 2, maxTechnique: "region-in-line" });
    let open = 0;
    for (let i = 0; i < b.N * b.N; i++) if (r.grid[i] === UNKNOWN) open++;
    if (open > 0) medNeedsConverse++;
  }
  log(`  medium boards that genuinely need line-in-region (not just region-in-line): ${medNeedsConverse}/${BOARDS.medium.length}`);
  assert("5.c the medium tier can produce boards that REQUIRE line-in-region", medNeedsConverse > 0,
    `${medNeedsConverse} of ${BOARDS.medium.length}`);

  // the "empty easy band" claim, tested rather than assumed
  let countingOnly = 0;
  for (const b of BOARDS.easy) {
    const r = solver.solve({ N: b.N, k: b.k, pens: b.pens }, { allowContradiction: false, maxTechnique: "region-forced" });
    let open = 0;
    for (let i = 0; i < b.N * b.N; i++) if (r.grid[i] === UNKNOWN) open++;
    if (open === 0) countingOnly++;
  }
  // an independent sweep: 400 random UNIQUE 6x6 layouts, can counting alone crack any?
  const rng = mulberry32(SEED ^ 0xa5a5a5);
  let uniqueSeen = 0, countingCrack = 0, tries = 0;
  while (uniqueSeen < 400 && tries < 4000) {
    tries++;
    const layout = gen.generatePens(6, 1, rng, 6);
    if (!layout) continue;
    const ref = gen.refinePens(6, 1, layout.pens, layout.solution, rng, layout.band, { cap: 8, iters: 250 });
    const p = { N: 6, k: 1, pens: ref.pens };
    if (solver.countSolutions(p, 2).count !== 1) continue;
    uniqueSeen++;
    const r = solver.solve(p, { allowContradiction: false, maxTechnique: "region-forced" });
    let open = 0;
    for (let i = 0; i < 36; i++) if (r.grid[i] === UNKNOWN) open++;
    if (open === 0) countingCrack++;
  }
  log(`  "empty easy band" claim — uniquely-solvable 6x6 boards cracked by counting alone:`);
  log(`    from the generated easy batch: ${countingOnly}/${BOARDS.easy.length}`);
  log(`    from ${uniqueSeen} independently refined unique 6x6 layouts: ${countingCrack}`);
  assert("5.d claim verified: no uniquely-solvable board is solvable by counting alone",
    countingOnly === 0 && countingCrack === 0,
    `${countingOnly + countingCrack} counterexample(s) found — the claim would be FALSE`);
}

// ===================================================================== CASE 6
function case6_grading() {
  log("\n--- CASE 6: grading is real (effort separation + band compliance) ---");
  const meds = {};
  let bandBad = 0;
  for (const tier of TIERS) {
    const rule = gen.TIERS[tier];
    const efforts = [], techs = {};
    for (const b of BOARDS[tier]) {
      efforts.push(b.effort);
      techs[b.maxTechnique] = (techs[b.maxTechnique] || 0) + 1;
      const r = solver.rank(b.maxTechnique);
      if (r < solver.rank(rule.minTech) || r > solver.rank(rule.maxTech)) bandBad++;
    }
    meds[tier] = median(efforts);
    log(`  ${tier.padEnd(8)} effort median ${median(efforts).toFixed(1).padStart(7)} ` +
        `(min ${Math.min(...efforts)}, max ${Math.max(...efforts)})  band [${rule.minTech}..${rule.maxTech}]`);
    log(`           maxTechnique: ${Object.entries(techs).map(([t, n]) => `${t} x${n}`).join(", ")}`);
  }
  const mono = meds.easy < meds.medium && meds.medium < meds.hard && meds.hard < meds.extreme;
  log(`  medians: easy ${meds.easy.toFixed(1)} < medium ${meds.medium.toFixed(1)} < hard ${meds.hard.toFixed(1)} < extreme ${meds.extreme.toFixed(1)} ? ${mono}`);
  assert("6.a median effort strictly increases easy < medium < hard < extreme", mono,
    TIERS.map((t) => `${t}=${meds[t].toFixed(1)}`).join(" "));
  assert("6.b every board's maxTechnique falls inside its tier's declared band", bandBad === 0, `${bandBad} outside`);
}

// ===================================================================== CASE 7
function case7_determinism() {
  log("\n--- CASE 7: determinism ---");
  const seeds = [11, 4242, 999983];
  let same = 0, total = 0;
  const forward = {};
  for (const tier of TIERS) for (const s of seeds) {
    forward[tier + "|" + s] = gen.generate({ tier, seed: s });
  }
  // regenerate out of order
  const order = [];
  for (const s of seeds.slice().reverse()) for (const tier of TIERS.slice().reverse()) order.push([tier, s]);
  for (const [tier, s] of order) {
    total++;
    const a = forward[tier + "|" + s], b = gen.generate({ tier, seed: s });
    if (a.pens && b.pens && penKey(a.pens) === penKey(b.pens) &&
        penKey(a.solution) === penKey(b.solution) && a.effort === b.effort && a.maxTechnique === b.maxTechnique) same++;
  }
  log(`  same-seed reproductions (out of order, same process): ${same}/${total}`);
  assert("7.a same seed reproduces a byte-identical puzzle, in any order", same === total, `${total - same} drifted`);

  // fresh process
  const script = `const g=require(${JSON.stringify(path.join(JS, "generator.js"))});
const out=[];for(const t of ${JSON.stringify(TIERS)})for(const s of ${JSON.stringify(seeds)}){
const b=g.generate({tier:t,seed:s});out.push(t+"|"+s+"|"+(b.pens?Array.from(b.pens).join(""):"null")+"|"+b.effort+"|"+b.maxTechnique);}
console.log(out.join("\\n"));`;
  const t0 = Date.now();
  const child = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim().split("\n");
  const mine = [];
  for (const t of TIERS) for (const s of seeds) {
    const b = forward[t + "|" + s];
    mine.push(t + "|" + s + "|" + (b.pens ? Array.from(b.pens).join("") : "null") + "|" + b.effort + "|" + b.maxTechnique);
  }
  const diff = mine.filter((x, i) => x !== child[i]).length;
  log(`  fresh-process reproductions: ${mine.length - diff}/${mine.length} (${ms(t0)})`);
  assert("7.b a fresh node process produces identical boards for the same seeds", diff === 0, `${diff} differ`);
}

// ===================================================================== CASE 8
function case8_nextStep() {
  log("\n--- CASE 8: nextStep() robustness ---");
  let empties = 0, emptyBad = 0, partial = 0, partialBad = 0, crashes = 0, wrongHandled = 0, wrongTotal = 0;
  const rng = mulberry32(SEED ^ 0xbeef);
  const detail = [];
  for (const tier of TIERS) {
    for (const b of BOARDS[tier]) {
      const p = { N: b.N, k: b.k, pens: b.pens }, cells = b.N * b.N;
      // (a) empty grid
      let s;
      try { s = solver.nextStep(p, new Int8Array(cells), { allowContradiction: tier === "extreme" }); }
      catch (e) { crashes++; detail.push("empty-grid throw: " + e.message); continue; }
      if (!s.found) { emptyBad++; if (detail.length < 5) detail.push(`${tier}: no hint from an empty grid (${s.reason})`); }
      else {
        empties++;
        for (const c of s.cells) {
          const t = b.solution[c.index] === 1 ? "BULL" : "EMPTY";
          if (t !== c.state) { emptyBad++; if (detail.length < 5) detail.push(`${tier}: empty-grid hint r${c.r + 1}c${c.c + 1} says ${c.state}, truth ${t}`); }
        }
      }
      // (b) correct partial grid: reveal ~60% of the true states
      const board = new Int8Array(cells);
      for (let i = 0; i < cells; i++) if (rng() < 0.6) board[i] = b.solution[i] === 1 ? BULL : EMPTY;
      let s2;
      try { s2 = solver.nextStep(p, board, { allowContradiction: tier === "extreme" }); }
      catch (e) { crashes++; detail.push("partial-grid throw: " + e.message); continue; }
      partial++;
      if (s2.found) {
        for (const c of s2.cells) {
          const t = b.solution[c.index] === 1 ? "BULL" : "EMPTY";
          if (t !== c.state) { partialBad++; if (detail.length < 5) detail.push(`${tier}: partial hint r${c.r + 1}c${c.c + 1} says ${c.state}, truth ${t}`); }
        }
      } else if (s2.reason !== "solved") {
        partialBad++;
        if (detail.length < 5) detail.push(`${tier}: correct partial grid gave up with reason ${s2.reason}`);
      }
      // (c) deliberately WRONG grid: two touching bulls
      const bad = new Int8Array(cells);
      let placed = false;
      for (let r = 0; r + 1 < b.N && !placed; r++) for (let c = 0; c + 1 < b.N && !placed; c++) {
        bad[r * b.N + c] = BULL; bad[r * b.N + c + 1] = BULL; placed = true;
      }
      wrongTotal++;
      try {
        const s3 = solver.nextStep(p, bad, { allowContradiction: false });
        if (s3 && typeof s3.found === "boolean" && Array.isArray(s3.cells) && typeof s3.explain === "string") wrongHandled++;
        else detail.push(`${tier}: malformed nextStep result on a wrong grid`);
      } catch (e) { crashes++; if (detail.length < 5) detail.push("wrong-grid throw: " + e.message); }
      // (d) a bull where the solution has none, board otherwise blank
      let liar = -1;
      for (let i = 0; i < cells; i++) if (b.solution[i] !== 1) { liar = i; break; }
      const bad2 = new Int8Array(cells); bad2[liar] = BULL;
      wrongTotal++;
      try {
        const s4 = solver.nextStep(p, bad2, { allowContradiction: false });
        if (s4 && typeof s4.found === "boolean" && Array.isArray(s4.cells)) wrongHandled++;
      } catch (e) { crashes++; if (detail.length < 5) detail.push("liar-grid throw: " + e.message); }
    }
  }
  log(`  hints from an empty grid:        ${empties} sound, ${emptyBad} unsound/missing`);
  log(`  hints from a correct partial grid: ${partial} boards, ${partialBad} unsound/gave-up`);
  log(`  deliberately wrong grids handled without a crash: ${wrongHandled}/${wrongTotal}`);
  log(`  exceptions thrown: ${crashes}   (must be 0)`);
  detail.slice(0, 6).forEach((d) => log("    " + d));
  assert("8.a nextStep gives a sound hint from an empty grid on every board", emptyBad === 0, `${emptyBad} bad`);
  assert("8.b nextStep agrees with ground truth on a correct partial grid", partialBad === 0, `${partialBad} bad`);
  assert("8.c nextStep never throws, even on a wrong player grid", crashes === 0 && wrongHandled === wrongTotal,
    `${crashes} throws, ${wrongTotal - wrongHandled} unhandled`);
}

// ===================================================================== CASE 9
function case9_batch() {
  log("\n--- CASE 9: batch/volume sanity (the shipped build bakes 1000/tier) ---");
  let ok = true;
  for (const tier of TIERS) {
    const list = BOARDS[tier];
    const keys = new Set(list.map((b) => penKey(b.pens)));
    const sols = new Set(list.map((b) => penKey(b.solution)));
    log(`  ${tier.padEnd(8)} ${list.length} boards, ${keys.size} distinct pen layouts, ${sols.size} distinct solutions`);
    if (keys.size !== list.length || list.length !== BATCH) ok = false;
  }
  assert("9.a a batch of " + BATCH + "/tier produces 100% distinct pen layouts and zero failures", ok);

  // throughput probe: a tight loop of fresh seeds, no shared state
  const t0 = Date.now();
  let n = 0;
  for (let i = 0; i < 30; i++) {
    const b = gen.generate({ tier: "easy", seed: (SEED * 3 + i * 7919) >>> 0 });
    if (b.pens) n++;
  }
  const rate = 30 / ((Date.now() - t0) / 1000);
  log(`  tight-loop probe: ${n}/30 easy boards, ${rate.toFixed(1)} boards/sec ` +
      `-> 1000 easy boards ~= ${(1000 / rate).toFixed(0)}s`);
  assert("9.b generate() is safe in a tight loop (30/30, no failures)", n === 30, `${30 - n} failures`);
}

// ================================================================= UNIT CASES
function unitCases() {
  log("\n--- CASE 10: hand-crafted unit cases ---");

  /* 10.a/b adjacency-packing, the trickiest deduction in this game.

     A hand-built 6x6 k=1 board. Pen 1 is the L-shape {r1c1, r1c2, r2c1}. The
     cell r2c2 is a king-neighbour of ALL THREE of those cells, so a bull at
     r2c2 would leave pen 1 with nowhere to stand -> r2c2 is provably EMPTY.
     No counting technique can see this: pen 1 has 3 candidates and needs 1,
     and its cells span two rows and two columns, so neither region-in-line nor
     line-in-region bites either. It MUST come from adjacency-packing.

     Solution (verified below by the independent rule checker):
       r1c1, r2c3, r3c5, r4c2, r5c6, r6c4  */
  const N = 6, k = 1;
  const PENS = [
    [[0, 0], [0, 1], [1, 0]],                                                   // pen 0: the L
    [[0, 2], [0, 3], [1, 1], [1, 2], [1, 3]],                                   // pen 1
    [[0, 4], [0, 5], [1, 4], [1, 5], [2, 4], [2, 5]],                           // pen 2
    [[2, 0], [2, 1], [2, 2], [2, 3], [3, 0], [3, 1], [3, 2], [3, 3]],           // pen 3
    [[3, 4], [3, 5], [4, 3], [4, 4], [4, 5], [5, 4], [5, 5]],                   // pen 4
    [[4, 0], [4, 1], [4, 2], [5, 0], [5, 1], [5, 2], [5, 3]],                   // pen 5
  ];
  const pens = new Int32Array(N * N).fill(-1);
  for (let p0 = 0; p0 < PENS.length; p0++) for (const [r, c] of PENS[p0]) pens[r * N + c] = p0;
  const sol = new Int8Array(N * N);
  for (const [r, c] of [[0, 0], [1, 2], [2, 4], [3, 1], [4, 5], [5, 3]]) sol[r * N + c] = 1;
  const p = { N, k, pens };

  const structErr = checkPens(N, pens) || checkSolution(N, k, pens, sol);
  log(`  10.a hand-built board is well-formed: ${structErr ? "NO — " + structErr : "yes"}`);
  assert("10.a the hand-crafted board itself is a legal, well-formed puzzle", !structErr, structErr || "");

  const target = 1 * N + 1; // r2c2
  const capWeak = solver.solve(p, { allowContradiction: false, maxSetSize: 2, maxTechnique: "line-in-region" });
  const capPack = solver.solve(p, { allowContradiction: false, maxSetSize: 2, maxTechnique: "adjacency-packing" });
  log(`       r2c2 with the ladder capped at line-in-region:    ${capWeak.grid[target] === UNKNOWN ? "unknown" : capWeak.grid[target] === EMPTY ? "EMPTY" : "BULL"}`);
  log(`       r2c2 with the ladder capped at adjacency-packing: ${capPack.grid[target] === UNKNOWN ? "unknown" : capPack.grid[target] === EMPTY ? "EMPTY" : "BULL"}`);
  log(`       adjacency-packing deductions made: ${capPack.techniques["adjacency-packing"] || 0}`);
  const packViol = truthViolations(N, capPack.grid, sol).length;
  log(`       deductions disagreeing with the hand solution: ${packViol}`);
  assert("10.b adjacency-packing proves r2c2 EMPTY (an L-pen its bull cannot leave)",
    capPack.grid[target] === EMPTY && (capPack.techniques["adjacency-packing"] || 0) > 0 && packViol === 0);
  assert("10.b2 that deduction is genuinely out of reach below adjacency-packing", capWeak.grid[target] === UNKNOWN);

  /* 10.c a full but ILLEGAL grid must be reported as a contradiction, not
     "solved" — the deadlock/duplicate case the hint button will hit. */
  const full = new Int8Array(N * N).fill(EMPTY);
  full[0] = BULL; full[1] = BULL; // touching bulls
  const s = solver.nextStep({ N, k, pens }, full);
  log(`  10.c full illegal grid -> found=${s.found}, reason=${s.reason}`);
  assert("10.c a full but rule-breaking grid is reported as a contradiction", s.found === false && s.reason === "contradiction");

  /* 10.d countSolutions must respect its cap and my brute force must agree on
     an unconstrained board with many solutions. */
  const many = { N: 6, k: 1, pens: (() => {
    const a = new Int32Array(36);
    for (let i = 0; i < 36; i++) a[i] = (i / 6) | 0; // each row is a pen
    return a;
  })() };
  const capped = solver.countSolutions(many, 3).count;
  const brute3 = bruteCount(6, 1, many.pens, 3);
  const bruteAll = bruteCount(6, 1, many.pens, 100000);
  const allSolver = solver.countSolutions(many, 100000).count;
  log(`  10.d row-pens 6x6 k=1: countSolutions cap3=${capped}, brute cap3=${brute3}, uncapped solver=${allSolver}, uncapped brute=${bruteAll}`);
  assert("10.d countSolutions honours its cap and matches brute force uncapped",
    capped === 3 && brute3 === 3 && allSolver === bruteAll && bruteAll > 1,
    `${allSolver} vs ${bruteAll}`);
}

// ======================================================================= MAIN
const T0 = Date.now();
log("BULLPEN verification harness");
log(`node ${process.version}  batch=${BATCH}/tier  seed=${SEED}`);
buildBatch();
case1_structure();
case2_soundness();
case2b_randomBoards();
case3_uniqueness();
case4_noGuess();
case5_necessity();
case6_grading();
case7_determinism();
case8_nextStep();
case9_batch();
unitCases();

log("\n=====================================================");
log(`total wall time: ${ms(T0)}`);
if (failures) {
  log(`RESULT: FAIL — ${failures} check(s) red. The gate is CLOSED.`);
  process.exit(1);
}
log("RESULT: PASS — every check green. The gate is OPEN.");
process.exit(0);
