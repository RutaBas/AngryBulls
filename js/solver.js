"use strict";
/* One IIFE per logic file — matches STRATA's module style. */
(function (root) {

/* BULLPEN — deduction engine for Star Battle ("two not touch").

   Pure logic. No DOM, no randomness, no I/O. The same file powers the hint
   button, the auto-solver, the generator's uniqueness gate and the harness's
   soundness proof, so every line in here has to be defensible.

   THE PUZZLE
     An N x N grid partitioned into N connected pens. Exactly k bulls in every
     row, every column and every pen. No two bulls touch, orthogonally OR
     diagonally (king-move adjacency).

   THE CONTRACT
     A deduction is only ever made when it can be PROVEN. Every technique marks
     a cell BULL or EMPTY only after showing that no completion consistent with
     the constraints the technique looks at could have it otherwise. When a
     technique is unsure it marks nothing. Nothing in here reasons from "the
     puzzle is supposed to have one solution" — that would make the generator's
     uniqueness gate circular. The main path NEVER guesses; the one hypothetical
     technique ('contradiction') is opt-in, is depth-1, and only ever concludes
     EMPTY from a proven refutation.

   REPRESENTATION
     state[i] in {UNKNOWN, BULL, EMPTY}, an Int8Array(N*N).
     A "unit" is a row, a column or a pen; all three want exactly k bulls, which
     is why every counting technique below is written once over units.

   THE TECHNIQUE LADDER (weakest first — this IS the difficulty axis)
     adjacency          a bull empties its 8 neighbours.
     line-full          a row/col already holds k bulls -> the rest are EMPTY.
     region-full        same for a pen.
     line-forced        a row/col has exactly as many candidates as bulls left.
     region-forced      same for a pen.
     region-in-line     one pen's candidates sit inside lines whose total budget
                        equals the pen's -> those lines are spent on the pen.
     line-in-region     the converse: one line's candidates sit inside pens
                        whose total budget equals the line's.
     set-cover          the same argument over SETS of 2..maxSetSize units
                        (pigeonhole). This is what makes k=2 interesting.
     adjacency-packing  within one unit, a bull at c would leave no room to pack
                        the remaining bulls non-adjacently -> c is EMPTY.
     contradiction      OPT-IN, depth-1: assume BULL, run the ladder above, and
                        if it refutes, the cell is EMPTY. Grading only.
*/

const UNKNOWN = 0;
const BULL = 1;
const EMPTY = 2;

/* Ladder order. Index into this array IS the difficulty rank. */
const TECHNIQUES = [
  "adjacency",
  "line-full",
  "region-full",
  "line-forced",
  "region-forced",
  "region-in-line",
  "line-in-region",
  "adjacency-packing",
  "set-cover",
  "contradiction",
];

/* The no-guess ladder: everything a legitimate puzzle may require. */
const SOUND_TECHNIQUES = TECHNIQUES.slice(0, TECHNIQUES.length - 1);

/* What the depth-1 trial is allowed to use INSIDE a hypothesis (see
   techContradiction). A weaker prover refutes fewer cells, never more. */
const TRIAL_TECHNIQUES = TECHNIQUES.slice(0, TECHNIQUES.indexOf("set-cover"));

/* Effort weights. Harder techniques are weighted much heavier so that `effort`
   is dominated by the hard steps and the level builder can ramp on it without
   a wide easy board out-scoring a narrow hard one. set-cover additionally
   scales with the size of the set it needed. */
const WEIGHTS = {
  adjacency: 1,
  "line-full": 1,
  "region-full": 1,
  "line-forced": 2,
  "region-forced": 2,
  "region-in-line": 6,
  "line-in-region": 6,
  "adjacency-packing": 10,
  "set-cover": 15,
  contradiction: 60,
};

function stepWeight(step) {
  const w = WEIGHTS[step.technique] || 1;
  if (step.technique === "set-cover") return w * (step.setSize || 2);
  return w;
}

function rank(technique) {
  return TECHNIQUES.indexOf(technique);
}

// ----------------------------------------------------------------- geometry

/* Everything derived from (N, pens) that never changes during a solve, cached
   per puzzle object so the generator's thousands of solves do not rebuild it. */
const GEOM_CACHE = new WeakMap();

function geometry(puzzle) {
  if (typeof puzzle === "object" && puzzle !== null) {
    const hit = GEOM_CACHE.get(puzzle);
    if (hit && hit.k === puzzle.k) return hit;
  }
  const N = puzzle.N;
  const k = puzzle.k;
  const cells = N * N;
  const pens = puzzle.pens;

  const neighbors = [];
  for (let i = 0; i < cells; i++) {
    const r = (i / N) | 0;
    const c = i % N;
    const a = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue;
        a.push(rr * N + cc);
      }
    }
    neighbors.push(a);
  }

  const units = [];
  for (let r = 0; r < N; r++) {
    const a = [];
    for (let c = 0; c < N; c++) a.push(r * N + c);
    units.push({ kind: "row", n: r, cells: a, id: units.length });
  }
  for (let c = 0; c < N; c++) {
    const a = [];
    for (let r = 0; r < N; r++) a.push(r * N + c);
    units.push({ kind: "col", n: c, cells: a, id: units.length });
  }
  const penCells = [];
  for (let p = 0; p < N; p++) penCells.push([]);
  for (let i = 0; i < cells; i++) {
    const p = pens[i];
    if (p < 0 || p >= N) throw new Error("pen id out of range at cell " + i);
    penCells[p].push(i);
  }
  for (let p = 0; p < N; p++) units.push({ kind: "pen", n: p, cells: penCells[p], id: units.length });

  const rowUnits = units.filter((u) => u.kind === "row");
  const colUnits = units.filter((u) => u.kind === "col");
  const penUnits = units.filter((u) => u.kind === "pen");

  /* cell -> its row unit / col unit / pen unit, by index into `units`. */
  const cellRow = new Int32Array(cells);
  const cellCol = new Int32Array(cells);
  const cellPen = new Int32Array(cells);
  for (let i = 0; i < cells; i++) {
    cellRow[i] = ((i / N) | 0);
    cellCol[i] = N + (i % N);
    cellPen[i] = 2 * N + pens[i];
  }

  const g = {
    N, k, cells, pens, neighbors, units, rowUnits, colUnits, penUnits,
    penCells, cellRow, cellCol, cellPen,
  };
  if (typeof puzzle === "object" && puzzle !== null) GEOM_CACHE.set(puzzle, g);
  return g;
}

function cellLabel(N, i) {
  return "r" + (((i / N) | 0) + 1) + "c" + ((i % N) + 1);
}

function unitLabel(u) {
  if (u.kind === "row") return "row " + (u.n + 1);
  if (u.kind === "col") return "column " + (u.n + 1);
  return "pen " + (u.n + 1);
}

function unitListLabel(list) {
  return list.map(unitLabel).join(" + ");
}

/* A unit, in the form the UI needs to find its cells again. */
function unitRef(u, role) {
  return { kind: u.kind, n: u.n, label: unitLabel(u), role: role || "focus" };
}

// ------------------------------------------------------------------ context

/* All mutable solver state travels in one context object so every write can be
   logged, truth-checked and contradiction-flagged from a single choke point.
   Nothing writes ctx.state except mark(). */
function makeCtx(g, state, opts) {
  const o = opts || {};
  return {
    g,
    state,
    tech: null,
    steps: [],
    collectSteps: !!o.collectSteps,
    counts: Object.create(null),
    effort: 0,
    contradiction: false,
    contradictionReason: null,
    hardest: -1,
    maxSetSize: 0,
    truth: o.truth || null,
    violations: [],
    allowContradiction: !!o.allowContradiction,
    setSizeLimit: Math.max(2, Math.min(4, o.maxSetSize === undefined ? 3 : o.maxSetSize)),
  };
}

/* THE choke point. Write `val` (BULL or EMPTY) into cell i.

   Returns true if this changed anything. Writing a value that conflicts with
   what is already there sets ctx.contradiction — that is how hypothetical
   branches get refuted, and how a wrongly-filled player board is detected.

   If a ground truth solution was supplied and this write disagrees with it,
   that is a SOUNDNESS BUG in this file: it is recorded in ctx.violations and
   not swallowed. checkAgainstTruth() surfaces the list. */
function mark(ctx, i, val, unit, explain, extra) {
  const cur = ctx.state[i];
  if (cur === val) return false;
  if (cur !== UNKNOWN) {
    ctx.contradiction = true;
    ctx.contradictionReason = "cell " + cellLabel(ctx.g.N, i) + " wanted both states";
    return false;
  }
  if (ctx.truth) {
    const t = ctx.truth[i] ? BULL : EMPTY;
    if (t !== val) {
      ctx.violations.push({
        cell: i,
        r: (i / ctx.g.N) | 0,
        c: i % ctx.g.N,
        claimed: val === BULL ? "BULL" : "EMPTY",
        truth: t === BULL ? "BULL" : "EMPTY",
        technique: ctx.tech,
        explain,
      });
    }
  }
  ctx.state[i] = val;
  const t = ctx.tech;
  ctx.counts[t] = (ctx.counts[t] || 0) + 1;
  const ri = rank(t);
  if (ri > ctx.hardest) ctx.hardest = ri;
  const step = {
    technique: t,
    cells: [{ index: i, r: (i / ctx.g.N) | 0, c: i % ctx.g.N, state: val === BULL ? "BULL" : "EMPTY" }],
    unit: unit ? unitLabel(unit) : (extra && extra.unit) || null,
    explain,
    /* The units and cells the SENTENCE names, structured so the UI can point at
       them on the board. `role` distinguishes the units that owe bulls ("focus")
       from the units those bulls have to come out of ("cover"); a one-unit
       technique only ever has a focus. */
    refs: (extra && extra.refs) || (unit ? [unitRef(unit, "focus")] : []),
    cues: (extra && extra.cues) || [],
  };
  if (extra && extra.setSize) {
    step.setSize = extra.setSize;
    // maxSetSize describes 'set-cover' only; the single-unit covers report 1.
    if (t === "set-cover" && extra.setSize > ctx.maxSetSize) ctx.maxSetSize = extra.setSize;
  }
  ctx.effort += stepWeight(step);
  if (ctx.collectSteps) ctx.steps.push(step);
  else if (ctx.steps.length === 0) ctx.steps.push(step); // keep the first, for nextStep()
  return true;
}

function fail(ctx, why) {
  ctx.contradiction = true;
  ctx.contradictionReason = why;
  return true;
}

/* Bulls placed / candidates left / bulls still owed, for one unit. */
function scan(ctx, u) {
  const st = ctx.state;
  let bulls = 0;
  const cand = [];
  for (const i of u.cells) {
    const v = st[i];
    if (v === BULL) bulls++;
    else if (v === UNKNOWN) cand.push(i);
  }
  return { bulls, cand, need: ctx.g.k - bulls };
}

// ------------------------------------------------------- technique: adjacency

function techAdjacency(ctx) {
  let changed = false;
  const { cells, neighbors, N } = ctx.g;
  for (let i = 0; i < cells; i++) {
    if (ctx.state[i] !== BULL) continue;
    for (const j of neighbors[i]) {
      if (ctx.state[j] === BULL) return fail(ctx, "two bulls touch at " + cellLabel(N, i));
      if (ctx.state[j] === UNKNOWN) {
        changed = mark(ctx, j, EMPTY, null, "a bull at " + cellLabel(N, i) + " touches " + cellLabel(N, j) + ", and bulls never touch.", { cues: [i] }) || changed;
        if (ctx.contradiction) return changed;
      }
    }
  }
  return changed;
}

// ------------------------------------------------- techniques: full / forced

function techFull(ctx, kind) {
  const units = kind === "pen" ? ctx.g.penUnits : ctx.g.rowUnits.concat(ctx.g.colUnits);
  let changed = false;
  for (const u of units) {
    const s = scan(ctx, u);
    if (s.need < 0) return fail(ctx, unitLabel(u) + " holds too many bulls");
    if (s.need !== 0 || !s.cand.length) continue;
    for (const i of s.cand) {
      changed = mark(ctx, i, EMPTY, u, unitLabel(u) + " already holds all " + ctx.g.k + " of its bulls, so its other cells are empty.") || changed;
      if (ctx.contradiction) return changed;
    }
  }
  return changed;
}

function techForced(ctx, kind) {
  const units = kind === "pen" ? ctx.g.penUnits : ctx.g.rowUnits.concat(ctx.g.colUnits);
  let changed = false;
  for (const u of units) {
    const s = scan(ctx, u);
    if (s.need < 0) return fail(ctx, unitLabel(u) + " holds too many bulls");
    if (s.cand.length < s.need) return fail(ctx, unitLabel(u) + " has nowhere left to put " + s.need + " bull(s)");
    if (s.need === 0 || s.cand.length !== s.need) continue;
    for (const i of s.cand) {
      changed = mark(ctx, i, BULL, u, unitLabel(u) + " still needs " + s.need + " bull(s) and has exactly " + s.need + " cell(s) left, so every one of them is a bull.") || changed;
      if (ctx.contradiction) return changed;
    }
  }
  return changed;
}

// ------------------------------------------- the containment / cover argument

/* The one sound argument behind region-in-line, line-in-region and set-cover.

   Let S be a set of units from one partition of the grid (rows, or columns, or
   pens) and let T be the set of units from ANOTHER partition that contain at
   least one remaining candidate of S. Every bull that S still owes must land on
   a candidate of S, and every such cell lies in some unit of T, so T must supply
   at least need(S) bulls inside cells(S).

     - if need(T) < need(S) the position is impossible;
     - if need(T) === need(S) then ALL of T's remaining bulls are inside cells(S),
       so every candidate of T outside cells(S) is EMPTY.

   Both partitions are exact partitions of the grid, so no cell is double
   counted and no bull is charged twice. That is the whole proof.

   `sUnits` are the units of S; `otherKind` picks which partition T is drawn
   from. Returns {changed} or sets ctx.contradiction. */
function applyCover(ctx, sUnits, otherKind, techName, setSize) {
  const st = ctx.state;
  const g = ctx.g;
  let needS = 0;
  const inS = new Set();
  const cands = [];
  for (const u of sUnits) {
    const s = scan(ctx, u);
    if (s.need < 0) return fail(ctx, unitLabel(u) + " holds too many bulls");
    needS += s.need;
    for (const i of u.cells) inS.add(i);
    for (const i of s.cand) cands.push(i);
  }
  if (needS <= 0) return false;
  if (!cands.length) return fail(ctx, unitListLabel(sUnits) + " still needs bulls but has no cells left");

  const pick = otherKind === "pen" ? g.cellPen : otherKind === "row" ? g.cellRow : g.cellCol;
  const tIds = new Set();
  for (const i of cands) tIds.add(pick[i]);
  const tUnits = [...tIds].map((id) => g.units[id]);

  let needT = 0;
  for (const u of tUnits) {
    const s = scan(ctx, u);
    if (s.need < 0) return fail(ctx, unitLabel(u) + " holds too many bulls");
    needT += s.need;
  }
  if (needT < needS) {
    return fail(ctx, unitListLabel(sUnits) + " needs " + needS + " bulls but " + unitListLabel(tUnits) + " can only supply " + needT);
  }
  if (needT !== needS) return false;

  let changed = false;
  const why =
    unitListLabel(sUnits) + " still needs " + needS + " bull(s), and every cell it can use lies in " +
    unitListLabel(tUnits) + ", which has exactly " + needT + " bull(s) left. So all of those bulls are used up inside " +
    unitListLabel(sUnits) + " — the rest of " + unitListLabel(tUnits) + " is empty.";
  for (const u of tUnits) {
    for (const i of u.cells) {
      if (st[i] !== UNKNOWN || inS.has(i)) continue;
      changed = mark(ctx, i, EMPTY, null, why, {
        setSize,
        unit: unitListLabel(tUnits),
        refs: sUnits.map((s) => unitRef(s, "focus")).concat(tUnits.map((t2) => unitRef(t2, "cover"))),
      }) || changed;
      if (ctx.contradiction) return changed;
    }
  }
  return changed;
}

/* Technique 4: one pen, covered by lines. */
function techRegionInLine(ctx) {
  let changed = false;
  for (const u of ctx.g.penUnits) {
    ctx.tech = "region-in-line";
    changed = applyCover(ctx, [u], "row", "region-in-line", 1) || changed;
    if (ctx.contradiction) return changed;
    changed = applyCover(ctx, [u], "col", "region-in-line", 1) || changed;
    if (ctx.contradiction) return changed;
  }
  return changed;
}

/* Technique 5: one line, covered by pens. */
function techLineInRegion(ctx) {
  let changed = false;
  for (const u of ctx.g.rowUnits.concat(ctx.g.colUnits)) {
    changed = applyCover(ctx, [u], "pen", "line-in-region", 1) || changed;
    if (ctx.contradiction) return changed;
  }
  return changed;
}

/* Technique 6: the same argument over SETS, |S| = 2..limit, in both
   directions (rows/cols vs pens, pens vs rows/cols). Bounded so it stays fast:
   C(10,4) = 210 subsets per family, each O(N^2). */
function combinations(arr, size, out) {
  const cur = [];
  (function rec(start) {
    if (cur.length === size) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      cur.push(arr[i]);
      rec(i + 1);
      cur.pop();
    }
  })(0);
  return out;
}

function techSetCover(ctx) {
  const g = ctx.g;
  const families = [
    { units: g.rowUnits, other: "pen" },
    { units: g.colUnits, other: "pen" },
    { units: g.penUnits, other: "row" },
    { units: g.penUnits, other: "col" },
  ];
  for (let size = 2; size <= ctx.setSizeLimit; size++) {
    for (const fam of families) {
      // Only sets that still owe bulls are worth trying.
      const live = fam.units.filter((u) => scan(ctx, u).need > 0);
      if (live.length < size) continue;
      const subs = combinations(live, size, []);
      for (const S of subs) {
        const changed = applyCover(ctx, S, fam.other, "set-cover", size);
        if (ctx.contradiction) return true;
        if (changed) return true; // hand back to the weaker techniques
      }
    }
  }
  return false;
}

// ----------------------------------------------- technique: adjacency-packing

/* Can we choose `need` pairwise non-adjacent cells from `cells`, and (if
   `must` >= 0) include cells[must] among them? Plain backtracking; a unit has
   at most a couple of dozen candidates, and the tail bound prunes hard. */
function packable(cells, adj, need, must) {
  const n = cells.length;
  if (need <= 0) return must < 0;
  const chosen = [];
  function ok(idx) {
    for (const c of chosen) if (adj[c][idx]) return false;
    return true;
  }
  function rec(idx, left, needMust) {
    if (left === 0) return !needMust;
    if (n - idx < left) return false;
    if (needMust && must < idx) return false;
    for (let i = idx; i < n; i++) {
      if (n - i < left) return false;
      if (!ok(i)) continue;
      chosen.push(i);
      const r = rec(i + 1, left - 1, needMust && i !== must);
      chosen.pop();
      if (r) return true;
    }
    return false;
  }
  return rec(0, need, must >= 0);
}

/* A single-unit impossibility test, and the strongest thing on the ladder that
   is still purely local.

   For a candidate cell c, hypothesise a bull there and look at ONE unit U:
     - if c is in U, U now owes one bull fewer and c is used up;
     - every candidate of U that touches c is knocked out by adjacency.
   If what is left cannot seat U's remaining bulls without two of them touching,
   then c is not a bull in ANY completion, so c is EMPTY. Only one unit's
   constraints are consulted, which is what keeps this cheap — and the reasoning
   is a proof, not a trial: no assumption is ever adopted, only refuted.

   It covers the two everyday Star Battle moves in one rule: "this cell touches
   every remaining square of that pen" and "a bull here would split the row so
   its two stars can no longer stand apart". */
function techAdjacencyPacking(ctx) {
  const g = ctx.g;
  const st = ctx.state;
  let changed = false;

  // one snapshot of every unit: candidates, need, and the in-unit adjacency
  const info = [];
  for (const u of g.units) {
    const s = scan(ctx, u);
    const n = s.cand.length;
    const adj = [];
    for (let a = 0; a < n; a++) adj.push(new Array(n).fill(false));
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const i = s.cand[a];
        const j = s.cand[b];
        const dr = Math.abs(((i / g.N) | 0) - ((j / g.N) | 0));
        const dc = Math.abs((i % g.N) - (j % g.N));
        if (dr <= 1 && dc <= 1) { adj[a][b] = true; adj[b][a] = true; }
      }
    }
    const pos = new Map();
    s.cand.forEach((cell, idx) => pos.set(cell, idx));
    info.push({ u, cand: s.cand, need: s.need, adj, pos });
    if (s.need > 0 && !packable(s.cand, adj, s.need, -1)) {
      return fail(ctx, unitLabel(u) + " cannot seat its remaining " + s.need + " bull(s) without two touching");
    }
  }

  for (let c = 0; c < g.cells; c++) {
    if (st[c] !== UNKNOWN) continue;
    const touched = new Set([g.cellRow[c], g.cellCol[c], g.cellPen[c]]);
    for (const nb of g.neighbors[c]) {
      touched.add(g.cellRow[nb]);
      touched.add(g.cellCol[nb]);
      touched.add(g.cellPen[nb]);
    }
    for (const id of touched) {
      const inf = info[id];
      const inUnit = inf.pos.has(c);
      const need = inf.need - (inUnit ? 1 : 0);
      if (need < 0) {
        changed = mark(ctx, c, EMPTY, inf.u, unitLabel(inf.u) + " already has all its bulls, so " + cellLabel(g.N, c) + " cannot hold one.") || changed;
        if (ctx.contradiction) return changed;
        break;
      }
      if (need === 0) continue;
      // survivors: candidates of U that neither are c nor touch c
      const keep = [];
      for (const cell of inf.cand) {
        if (cell === c) continue;
        const dr = Math.abs(((cell / g.N) | 0) - ((c / g.N) | 0));
        const dc = Math.abs((cell % g.N) - (c % g.N));
        if (dr <= 1 && dc <= 1) continue;
        keep.push(cell);
      }
      if (keep.length >= need) {
        const idx = keep.map((cell) => inf.pos.get(cell));
        const sub = [];
        for (let a = 0; a < idx.length; a++) sub.push(new Array(idx.length).fill(false));
        for (let a = 0; a < idx.length; a++) {
          for (let b = a + 1; b < idx.length; b++) {
            if (inf.adj[idx[a]][idx[b]]) { sub[a][b] = true; sub[b][a] = true; }
          }
        }
        if (packable(keep, sub, need, -1)) continue;
      }
      changed = mark(
        ctx, c, EMPTY, inf.u,
        "a bull at " + cellLabel(g.N, c) + " would leave " + unitLabel(inf.u) +
          " no room for its remaining " + need + " bull(s) without two of them touching."
      ) || changed;
      if (ctx.contradiction) return changed;
      break;
    }
  }
  return changed;
}

// ---------------------------------------------------- technique: contradiction

/* Depth-1 trial. Assume a cell is a BULL, run the WHOLE sound ladder on a copy;
   if that refutes itself, the cell is provably EMPTY. Only ever concludes
   EMPTY from a refutation — it never adopts a hypothesis, so it is still not a
   guess. Opt-in, because the no-guess tiers must be able to exclude it. */
function techContradiction(ctx) {
  if (!ctx.allowContradiction) return false;
  const g = ctx.g;
  let any = false;
  for (let i = 0; i < g.cells; i++) {
    if (ctx.state[i] !== UNKNOWN) continue;
    const trial = makeCtx(g, Int8Array.from(ctx.state), {
      allowContradiction: false,
      maxSetSize: ctx.setSizeLimit,
    });
    trial.tech = "adjacency";
    trial.state[i] = BULL;
    /* The refutation runs the ladder UP TO adjacency-packing and stops short of
       set-cover. Using a weaker prover inside the trial can only ever refute
       fewer cells, never more, so it stays sound — and it keeps a depth-1 pass
       affordable on a 10x10 board, where the trial is run once per open cell. */
    propagate(trial, TRIAL_TECHNIQUES);
    if (!trial.contradiction) continue;
    ctx.tech = "contradiction";
    /* One SWEEP, not one refutation: re-running the whole sweep after every
       single elimination is what made a 10x10 trial pass expensive. Applying
       each refutation as it is proven only strengthens the later trials in the
       same sweep, and every one of them is still proven from the live state. */
    ctx.tech = "contradiction";
    const changed = mark(
      ctx, i, EMPTY, null,
      "suppose " + cellLabel(g.N, i) + " held a bull: following the rules from there breaks the board (" +
        (trial.contradictionReason || "no legal continuation") + "). So it is empty."
    );
    if (changed) any = true;
    if (ctx.contradiction) return true;
  }
  return any;
}

// -------------------------------------------------------------- propagation

const RUNNERS = {
  adjacency: (ctx) => techAdjacency(ctx),
  "line-full": (ctx) => techFull(ctx, "line"),
  "region-full": (ctx) => techFull(ctx, "pen"),
  "line-forced": (ctx) => techForced(ctx, "line"),
  "region-forced": (ctx) => techForced(ctx, "pen"),
  "region-in-line": (ctx) => techRegionInLine(ctx),
  "line-in-region": (ctx) => techLineInRegion(ctx),
  "set-cover": (ctx) => techSetCover(ctx),
  "adjacency-packing": (ctx) => techAdjacencyPacking(ctx),
  contradiction: (ctx) => techContradiction(ctx),
};

/* Run the enabled techniques weakest-first to a fixpoint, falling back to the
   weakest one that still bites after every change. That ordering is what makes
   maxTechnique mean "the hardest technique the board REQUIRES" rather than
   "the hardest technique that happened to run". */
function propagate(ctx, techniques) {
  let rounds = 0;
  for (;;) {
    let changed = false;
    for (const name of techniques) {
      ctx.tech = name;
      const did = RUNNERS[name](ctx);
      if (ctx.contradiction) {
        ctx.tech = null;
        return rounds;
      }
      if (did) {
        changed = true;
        break;
      }
    }
    ctx.tech = null;
    if (!changed) return rounds;
    if (++rounds > 5000) return rounds; // paranoia; every technique is monotone
  }
}

function initialState(puzzle, board) {
  const g = geometry(puzzle);
  const st = new Int8Array(g.cells);
  if (board) {
    for (let i = 0; i < g.cells; i++) {
      const v = board[i];
      if (v === BULL || v === EMPTY) st[i] = v;
    }
  }
  return st;
}

function isComplete(ctx) {
  for (let i = 0; i < ctx.g.cells; i++) if (ctx.state[i] === UNKNOWN) return false;
  return true;
}

// -------------------------------------------------------- independent checks

/* Does this fully-marked grid actually satisfy the rules? Nothing in the
   solver is trusted for this — countSolutions() and checkAgainstTruth() both
   re-validate from scratch. `bulls` may be an Int8Array of states or of 0/1. */
function isSolution(puzzle, state) {
  const g = geometry(puzzle);
  const isBull = (i) => state[i] === BULL || state[i] === 1;
  const rows = new Int32Array(g.N);
  const cols = new Int32Array(g.N);
  const pen = new Int32Array(g.N);
  for (let i = 0; i < g.cells; i++) {
    if (!isBull(i)) continue;
    rows[(i / g.N) | 0]++;
    cols[i % g.N]++;
    pen[g.pens[i]]++;
    for (const j of g.neighbors[i]) if (isBull(j)) return false;
  }
  for (let x = 0; x < g.N; x++) {
    if (rows[x] !== g.k || cols[x] !== g.k || pen[x] !== g.k) return false;
  }
  return true;
}

/* Exhaustive backtracking count, capped at `limit`. Row by row: the legal
   in-row placements are precomputed (k non-adjacent columns), then filtered
   against the previous row, the column budget and the pen budget, with a
   look-ahead that kills a branch as soon as a column or pen can no longer be
   filled. Completely independent of the technique ladder — that independence
   is what makes it usable as a uniqueness proof. */
const PLACEMENT_CACHE = new Map();
function rowPlacementsCached(N, k) {
  const key = N + "|" + k;
  const hit = PLACEMENT_CACHE.get(key);
  if (hit) return hit;
  const out = [];
  const cur = [];
  (function build(start) {
    if (cur.length === k) {
      let mask = 0;
      for (const c of cur) mask |= 1 << c;
      out.push({ cols: Int32Array.from(cur), mask });
      return;
    }
    for (let c = start; c < N; c++) {
      cur.push(c);
      build(c + 2);
      cur.pop();
    }
  })(0);
  PLACEMENT_CACHE.set(key, out);
  return out;
}

function countSolutions(puzzle, limit) {
  /* Deliberately does NOT call geometry(): the generator calls this thousands
     of times with a freshly built {N,k,pens} object, and rebuilding the unit
     tables each time cost more than the search itself. Rows/cols/pens/adjacency
     are all handled directly below. */
  const N = puzzle.N;
  const k = puzzle.k;
  const g = { N, k, cells: N * N, pens: puzzle.pens };
  const cap = limit === undefined ? 2 : limit;

  // all k-subsets of columns with no two adjacent (cached per N,k — this
  // function is called thousands of times by the generator's refinement)
  const placements = rowPlacementsCached(N, k);

  // penCellsFromRow[p][r] = how many cells of pen p live in rows >= r
  const penFrom = [];
  for (let p = 0; p < N; p++) penFrom.push(new Int32Array(N + 1));
  for (let r = N - 1; r >= 0; r--) {
    for (let p = 0; p < N; p++) penFrom[p][r] = penFrom[p][r + 1];
    for (let c = 0; c < N; c++) penFrom[g.pens[r * N + c]][r]++;
  }

  const colUsed = new Int32Array(N);
  const penUsed = new Int32Array(N);
  let found = 0;
  let first = null;
  const sols = []; // kept for the generator's targeted refinement; bounded
  const chosen = [];

  function rec(r, prevMask) {
    if (found >= cap) return;
    if (r === N) {
      found++;
      if (!first || sols.length < 64) {
        const grid = new Int8Array(g.cells);
        for (let rr = 0; rr < N; rr++) for (const c of chosen[rr]) grid[rr * N + c] = 1;
        if (!first) first = grid;
        if (sols.length < 64) sols.push(grid);
      }
      return;
    }
    const rowsLeft = N - r;
    for (let x = 0; x < N; x++) {
      if (k - colUsed[x] > rowsLeft) return;
      if (k - penUsed[x] > penFrom[x][r]) return;
      if (colUsed[x] > k || penUsed[x] > k) return;
    }
    const base = r * N;
    for (let pi = 0; pi < placements.length; pi++) {
      const p = placements[pi];
      // no vertical/diagonal contact with the row above
      if (prevMask & (p.mask | (p.mask << 1) | (p.mask >> 1))) continue;
      const cols = p.cols;
      let ok = true;
      for (let a = 0; a < cols.length; a++) {
        if (colUsed[cols[a]] + 1 > k) { ok = false; break; }
      }
      if (!ok) continue;
      let placed = 0;
      for (; placed < cols.length; placed++) {
        const pen = g.pens[base + cols[placed]];
        if (penUsed[pen] + 1 > k) { ok = false; break; }
        penUsed[pen]++;
      }
      if (ok) {
        for (let a = 0; a < cols.length; a++) colUsed[cols[a]]++;
        chosen[r] = cols;
        rec(r + 1, p.mask);
        for (let a = 0; a < cols.length; a++) colUsed[cols[a]]--;
      }
      for (let a = 0; a < placed; a++) penUsed[g.pens[base + cols[a]]]--;
      if (found >= cap) return;
    }
  }
  rec(0, 0);
  return { count: found, solution: first, solutions: sols };
}

// -------------------------------------------------------------- public API

/* solve(puzzle, opts)
     opts = { allowContradiction, maxSetSize, collectSteps, board, truth,
              checkUnique }
   -> { solved, unique, grid, techniques, maxTechnique, effort, steps,
        contradiction, violations, maxSetSize } */
function solve(puzzle, opts) {
  const o = opts || {};
  const g = geometry(puzzle);
  const state = initialState(puzzle, o.board);
  const ctx = makeCtx(g, state, o);
  let ladder = o.allowContradiction ? TECHNIQUES : SOUND_TECHNIQUES;
  /* Optional ladder cap. Purely subtractive: it removes techniques from the
     top of the ladder so a caller can ask "is this board still solvable WITHOUT
     the hard move?". Never adds anything, so it cannot make a solve unsound. */
  if (o.maxTechnique) {
    const cap = rank(o.maxTechnique);
    if (cap < 0) throw new Error("unknown technique " + o.maxTechnique);
    ladder = ladder.filter((t) => rank(t) <= cap);
  }
  propagate(ctx, ladder);

  const solved = !ctx.contradiction && isComplete(ctx) && isSolution(puzzle, ctx.state);
  let unique;
  if (o.checkUnique) unique = countSolutions(puzzle, 2).count === 1;

  return {
    solved,
    unique,
    grid: ctx.state,
    techniques: ctx.counts,
    maxTechnique: ctx.hardest >= 0 ? TECHNIQUES[ctx.hardest] : null,
    maxSetSize: ctx.maxSetSize,
    effort: ctx.effort,
    steps: ctx.steps,
    contradiction: ctx.contradiction,
    contradictionReason: ctx.contradictionReason,
    violations: ctx.violations,
  };
}

/* nextStep(puzzle, currentGrid) — the CHEAPEST sound deduction available from
   the player's board right now. Powers the hint button, so it must survive a
   partially- and even wrongly-filled grid: it re-derives everything from the
   given states and reports a contradiction rather than throwing.

   Returns { found, technique, cells, refs, cues, explain } — or found:false with
   a reason of "solved", "contradiction" or "guess-required". `refs` are the units
   the sentence names (so a caller can point at them) and `cues` the cells it
   names as evidence. It never invents a move. */
function nextStep(puzzle, currentGrid, opts) {
  const o = opts || {};
  const g = geometry(puzzle);
  const board = initialState(puzzle, currentGrid);

  let open = 0;
  for (let i = 0; i < g.cells; i++) if (board[i] === UNKNOWN) open++;
  if (open === 0) {
    return {
      found: false,
      reason: isSolution(puzzle, board) ? "solved" : "contradiction",
      technique: null,
      cells: [],
      explain: isSolution(puzzle, board) ? "Every cell is already settled." : "This board is full but breaks the rules.",
    };
  }

  const ladder = o.allowContradiction ? TECHNIQUES : SOUND_TECHNIQUES;
  for (let t = 1; t <= ladder.length; t++) {
    const ctx = makeCtx(g, Int8Array.from(board), {
      collectSteps: false,
      maxSetSize: o.maxSetSize,
      allowContradiction: ladder[t - 1] === "contradiction",
    });
    propagate(ctx, ladder.slice(0, t));
    if (ctx.contradiction && !ctx.steps.length) {
      return {
        found: false,
        reason: "contradiction",
        technique: ladder[t - 1],
        cells: [],
        explain: "This board already breaks the rules: " + (ctx.contradictionReason || "no legal continuation") + ".",
      };
    }
    if (ctx.steps.length) {
      const s = ctx.steps[0];
      return {
        found: true, technique: s.technique, cells: s.cells, unit: s.unit,
        refs: s.refs, cues: s.cues, explain: s.explain,
      };
    }
  }
  return {
    found: false,
    reason: "guess-required",
    technique: null,
    cells: [],
    explain: "Nothing is forced from here — going further would require a guess.",
  };
}

/* Ground-truth mode. Runs the technique solver with the real solution wired
   into the choke point and reports EVERY deduction that disagreed with it.
   `sound:false` means a technique in this file is buggy — callers are expected
   to fail loudly rather than continue. `solution` may be an Int8Array of 0/1
   or of BULL/EMPTY states. */
function checkAgainstTruth(puzzle, solution, opts) {
  const o = opts || {};
  const g = geometry(puzzle);
  const truth = new Int8Array(g.cells);
  for (let i = 0; i < g.cells; i++) truth[i] = solution[i] === 1 || solution[i] === BULL ? 1 : 0;

  const violations = [];
  const tiers = [];
  const ladder = o.allowContradiction === false ? SOUND_TECHNIQUES : TECHNIQUES;
  for (let t = 1; t <= ladder.length; t++) {
    const ctx = makeCtx(g, new Int8Array(g.cells), {
      truth,
      collectSteps: false,
      maxSetSize: o.maxSetSize === undefined ? 4 : o.maxSetSize,
      allowContradiction: ladder.slice(0, t).indexOf("contradiction") >= 0,
    });
    propagate(ctx, ladder.slice(0, t));
    for (const v of ctx.violations) violations.push({ ...v, tier: ladder[t - 1] });
    if (ctx.contradiction) {
      violations.push({ tier: ladder[t - 1], technique: null, claimed: "contradiction", explain: ctx.contradictionReason });
    }
    tiers.push({
      technique: ladder[t - 1],
      solved: !ctx.contradiction && isComplete(ctx),
      effort: ctx.effort,
      contradiction: ctx.contradiction,
    });
  }
  return {
    sound: violations.length === 0,
    violations,
    tiers,
    message: violations.length
      ? "SOUNDNESS BUG: " + violations.length + " deduction(s) disagreed with the known solution."
      : "sound",
  };
}

const API = {
  solve,
  nextStep,
  countSolutions,
  checkAgainstTruth,
  isSolution,
  geometry,
  initialState,
  rank,
  UNKNOWN,
  BULL,
  EMPTY,
  TECHNIQUES,
  SOUND_TECHNIQUES,
  WEIGHTS,
};

root.BullpenSolver = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
