"use strict";
/* One IIFE per logic file — matches STRATA's module style. */
(function (root) {

/* BULLPEN — puzzle generation, gated by the solver.

   The order of operations is not negotiable: a candidate board is only a
   puzzle once countSolutions() says it has exactly one solution AND solve()
   says that solution is reachable by pure deduction at the requested tier.
   Nothing here hand-tunes a board to fit a tier; the solver is the arbiter and
   anything it will not certify is thrown away.

   THE APPROACH — solution first, pens grown around it.
     Growing pens first and hoping a placement exists wastes most attempts, so
     BULLPEN does it the other way round:

       1. sample a random legal bull placement (k per row, k per column, no two
          touching) — pens ignored;
       2. partition those N*k bulls into N groups of k by proximity, one group
          per pen, which makes "k bulls per pen" true BY CONSTRUCTION;
       3. connect each group's bulls with a claimed path, then grow all N pens
          simultaneously from those seeds, smallest-pen-first, until the grid is
          covered. Growth only ever adds a cell orthogonally adjacent to the
          pen, so every pen is 4-connected by construction;
       4. enforce a size band so no pen is a thread or a continent;
       5. countSolutions(puzzle, 2) === 1 — reject non-unique boards. (The
          sampled placement is A solution; this proves it is THE solution.)
       6. solve() WITHOUT contradiction — reject unless fully solved, which is
          what guarantees a no-guess puzzle. `extreme` is the one tier allowed
          to fall through to depth-1 contradiction, and it is a parameter.
       7. grade by maxTechnique (+ effort band) and reject a board that does not
          match the tier that was asked for.
*/

const isNode = typeof module !== "undefined" && module.exports;
const solver = isNode ? require("./solver.js") : root.BullpenSolver;
const { mulberry32, hashSeed, shuffle } = isNode ? require("./rng.js") : root.BullpenRng;

const TECHNIQUES = solver.TECHNIQUES;
const rank = solver.rank;

// ------------------------------------------------- step 1: a legal placement

/* All k-subsets of 0..N-1 with no two adjacent columns. */
function rowPlacements(N, k) {
  const out = [];
  const cur = [];
  (function rec(start) {
    if (cur.length === k) {
      let mask = 0;
      for (const c of cur) mask |= 1 << c;
      out.push({ cols: cur.slice(), mask });
      return;
    }
    for (let c = start; c < N; c++) {
      cur.push(c);
      rec(c + 2);
      cur.pop();
    }
  })(0);
  return out;
}

/* Random legal placement: k bulls per row and column, none touching. Row by
   row with a shuffled placement order and a column look-ahead. Returns an
   array of cell indices, or null if the (seeded) search ran out of budget. */
function randomPlacement(N, k, rng, budget) {
  const base = rowPlacements(N, k);
  const colUsed = new Int32Array(N);
  const chosen = [];
  let nodes = 0;
  const cap = budget || 200000;

  function rec(r, prevMask) {
    if (++nodes > cap) return false;
    if (r === N) return true;
    const rowsLeft = N - r;
    for (let c = 0; c < N; c++) if (k - colUsed[c] > rowsLeft) return false;
    const order = shuffle(base.slice(), rng);
    for (const p of order) {
      if (prevMask & (p.mask | (p.mask << 1) | (p.mask >> 1))) continue;
      let ok = true;
      for (const c of p.cols) if (colUsed[c] + 1 > k) { ok = false; break; }
      if (!ok) continue;
      for (const c of p.cols) colUsed[c]++;
      chosen[r] = p.cols;
      if (rec(r + 1, p.mask)) return true;
      for (const c of p.cols) colUsed[c]--;
      if (nodes > cap) return false;
    }
    return false;
  }

  if (!rec(0, 0)) return null;
  const bulls = [];
  for (let r = 0; r < N; r++) for (const c of chosen[r]) bulls.push(r * N + c);
  return bulls;
}

// ------------------------------------------------------ step 2: bull groups

/* Partition the N*k bulls into N groups of k, greedily by proximity so each
   group can be joined by a short path. Seeded shuffle picks the anchors. */
function groupBulls(N, k, bulls, rng) {
  if (k === 1) return bulls.map((b) => [b]);
  const pool = shuffle(bulls.slice(), rng);
  const used = new Set();
  const groups = [];
  const dist = (a, b) => {
    const ar = (a / N) | 0, ac = a % N, br = (b / N) | 0, bc = b % N;
    return Math.abs(ar - br) + Math.abs(ac - bc);
  };
  for (const a of pool) {
    if (used.has(a)) continue;
    used.add(a);
    const group = [a];
    while (group.length < k) {
      let best = -1;
      let bestD = Infinity;
      for (const b of pool) {
        if (used.has(b)) continue;
        let d = 0;
        for (const gcell of group) d = Math.max(d, dist(gcell, b));
        const jitter = rng() * 0.5;
        if (d + jitter < bestD) { bestD = d + jitter; best = b; }
      }
      if (best < 0) return null;
      used.add(best);
      group.push(best);
    }
    groups.push(group);
  }
  return groups.length === N ? groups : null;
}

// -------------------------------------------------- step 3-4: growing pens

function orthNeighbors(N, i) {
  const r = (i / N) | 0;
  const c = i % N;
  const out = [];
  if (r > 0) out.push(i - N);
  if (r + 1 < N) out.push(i + N);
  if (c > 0) out.push(i - 1);
  if (c + 1 < N) out.push(i + 1);
  return out;
}

/* Grow the N pens around the given bull groups.

   Seeds are the groups themselves, joined first by a BFS path through cells
   that are still unclaimed and are not somebody else's bull — that is what
   keeps "exactly k bulls in this pen" true while making the pen connected.
   Then all pens grow at once, always extending the currently-smallest pen, so
   sizes stay near N instead of one pen swallowing the board.

   Returns an Int32Array cell->pen, or null if this seeding cannot be grown
   into a legal partition (the caller just retries with fresh randomness). */
function growPens(N, k, groups, rng, band, style) {
  const cells = N * N;
  const st = style || DEFAULT_STYLE;
  /* sizeBias: how strongly growth insists on feeding the smallest pen.
       0   -> strict smallest-first, every pen ends up near N cells (uniform);
       1   -> the choice is nearly random, so some pens balloon and others stay
              at their seed size (a couple of big pens, several small).
     compactness: which frontier cell the chosen pen takes.
       +1  -> strongly prefers a cell with many neighbours already in the pen,
              which fills concavities and yields compact rectangle-ish blobs;
       -1  -> prefers a cell with exactly one neighbour in the pen, which walks
              the pen outward in a line and yields long snaking / L / T pens. */
  const sizeJitter = 0.4 + st.sizeBias * 7;
  const compact = st.compactness;
  const pens = new Int32Array(cells).fill(-1);
  const isBull = new Int32Array(cells).fill(-1);
  groups.forEach((g, p) => g.forEach((i) => { isBull[i] = p; }));

  const size = new Int32Array(N);
  const order = shuffle(groups.map((_, p) => p), rng);

  for (const p of order) {
    const group = groups[p];
    pens[group[0]] = p;
    size[p]++;
    for (let m = 1; m < group.length; m++) {
      const target = group[m];
      if (pens[target] === p) continue;
      // BFS from the pen's current cells to `target`
      const prev = new Int32Array(cells).fill(-2);
      const q = [];
      for (let i = 0; i < cells; i++) if (pens[i] === p) { q.push(i); prev[i] = -1; }
      let hit = false;
      for (let head = 0; head < q.length && !hit; head++) {
        for (const nb of shuffle(orthNeighbors(N, q[head]), rng)) {
          if (prev[nb] !== -2) continue;
          if (pens[nb] !== -1 && pens[nb] !== p) continue;
          if (isBull[nb] >= 0 && isBull[nb] !== p) continue;
          prev[nb] = q[head];
          if (nb === target) { hit = true; break; }
          q.push(nb);
        }
      }
      if (!hit) return null;
      let cur = target;
      while (cur >= 0 && pens[cur] !== p) {
        pens[cur] = p;
        size[p]++;
        cur = prev[cur];
      }
    }
  }

  const maxSize = band.max;
  let remaining = cells;
  for (let i = 0; i < cells; i++) if (pens[i] >= 0) remaining--;

  while (remaining > 0) {
    // candidate frontier per pen
    let bestPen = -1;
    let bestSize = Infinity;
    const frontier = [];
    for (let p = 0; p < N; p++) frontier.push([]);
    for (let i = 0; i < cells; i++) {
      if (pens[i] !== -1) continue;
      for (const nb of orthNeighbors(N, i)) {
        const p = pens[nb];
        if (p >= 0 && frontier[p].indexOf(i) < 0) frontier[p].push(i);
      }
    }
    for (let p = 0; p < N; p++) {
      if (!frontier[p].length) continue;
      if (size[p] >= maxSize) continue;
      const jitter = rng() * sizeJitter;
      if (size[p] + jitter < bestSize) { bestSize = size[p] + jitter; bestPen = p; }
    }
    if (bestPen < 0) {
      // everyone at the cap but cells remain: let the smallest eligible pen overflow
      for (let p = 0; p < N; p++) {
        if (!frontier[p].length) continue;
        if (size[p] < bestSize) { bestSize = size[p]; bestPen = p; }
      }
      if (bestPen < 0) return null; // unreachable cells — bad seeding
    }
    /* Frontier-cell choice is the SHAPE knob. `touch` is how many of the cell's
       orthogonal neighbours already belong to this pen (1..4). Rewarding a high
       touch count grows a solid blob; penalising it grows a thread. The rng term
       keeps every option reachable, so no style can deadlock the growth. */
    const opts = frontier[bestPen];
    let pick = -1, pickScore = -Infinity;
    for (const cand of opts) {
      let touch = 0;
      for (const nb of orthNeighbors(N, cand)) if (pens[nb] === bestPen) touch++;
      const s = compact * 2 * touch + rng();
      if (s > pickScore) { pickScore = s; pick = cand; }
    }
    pens[pick] = bestPen;
    size[bestPen]++;
    remaining--;
  }

  for (let p = 0; p < N; p++) if (size[p] < band.min || size[p] > band.max) return null;
  return pens;
}

/* Independent structural check on a pen layout: N pens, each non-empty,
   4-connected, inside the size band. Never trusts growPens. */
function pensValid(N, pens, band) {
  const cells = N * N;
  const members = [];
  for (let p = 0; p < N; p++) members.push([]);
  for (let i = 0; i < cells; i++) {
    const p = pens[i];
    if (p < 0 || p >= N) return false;
    members[p].push(i);
  }
  for (let p = 0; p < N; p++) {
    const m = members[p];
    if (!m.length) return false;
    if (band && (m.length < band.min || m.length > band.max)) return false;
    const seen = new Set([m[0]]);
    const q = [m[0]];
    for (let h = 0; h < q.length; h++) {
      for (const nb of orthNeighbors(N, q[h])) {
        if (pens[nb] !== p || seen.has(nb)) continue;
        seen.add(nb);
        q.push(nb);
      }
    }
    if (seen.size !== m.length) return false;
  }
  return true;
}

// ------------------------------------------------------------ style (variety)

/* A LAYOUT STYLE is three cosmetic knobs. They never touch legality — the
   solver still decides everything — they only change what a board LOOKS like:

     sizeBias    0..1  uniform pens ................ a few big + several small
     compactness -1..1 snaking / L / T pens ........ solid rectangle-ish blobs
     spread      0..1  narrow size band ............ the widest legal band

   Why this exists: a 6x6 one-bull Star Battle has only ~26 distinguishable
   solver-effort values, so 1000 Paddock levels CANNOT be 1000 difficulties.
   Structure is the axis that is actually available, and this is the dial.

   CRITICAL — the style is drawn from the generator's own seeded rng, not passed
   in by the builder. A device rebuilds a level from its stored seed alone, so
   anything that changes the board has to live inside that one random stream. */
const DEFAULT_STYLE = { sizeBias: 0.07, compactness: 0, spread: 1 };

function sampleStyle(rng) {
  /* Skewed low so uniform-ish boards stay the common case, with a long tail of
     lumpy ones; compactness is centred but reaches both extremes. */
  const u = rng();
  return {
    sizeBias: u * u,
    compactness: rng() * 2 - 1,
    spread: rng(),
  };
}

function sizeBand(N, k, style) {
  const st = style || DEFAULT_STYLE;
  const wideMin = Math.max(2 * k, Math.ceil(N * 0.5));
  const wideMax = Math.max(2 * k + 2, Math.floor(N * 1.7));
  // spread=0 hugs the mean pen size (N cells) so pens come out near-uniform;
  // spread=1 opens up to the widest band the rest of the pipeline tolerates.
  const tightMin = Math.min(N, Math.max(wideMin, Math.round(N * 0.8)));
  const tightMax = Math.max(N, Math.min(wideMax, Math.round(N * 1.25)));
  const s = st.spread;
  return {
    min: Math.round(tightMin + (wideMin - tightMin) * s),
    max: Math.round(tightMax + (wideMax - tightMax) * s),
  };
}

/* generatePens(N, k, rng, tries, style) -> { pens, solution, band } | null
   Public because the harness wants to sample layouts on their own. */
function generatePens(N, k, rng, tries, style) {
  const st = style || DEFAULT_STYLE;
  const band = sizeBand(N, k, st);
  const attempts = tries || 40;
  for (let t = 0; t < attempts; t++) {
    const bulls = randomPlacement(N, k, rng);
    if (!bulls) continue;
    const groups = groupBulls(N, k, bulls, rng);
    if (!groups) continue;
    const pens = growPens(N, k, groups, rng, band, st);
    if (!pens) continue;
    if (!pensValid(N, pens, band)) continue;
    const solution = new Int8Array(N * N);
    for (const b of bulls) solution[b] = 1;
    return { pens, solution, band, style: st };
  }
  return null;
}

// --------------------------------------------- style-aware boundary moves

/* How many of cell i's orthogonal neighbours belong to pen p. High = the cell
   sits in a concavity of p; low = it dangles off the end of a limb. */
function touchCount(N, work, i, p) {
  let n = 0;
  for (const nb of orthNeighbors(N, i)) if (work[nb] === p) n++;
  return n;
}

/* Choose which adjacent pen receives cell i.
   Measured problem: refinePens and softenPens together make hundreds of
   accepted boundary moves on a 36-cell grid, which completely re-randomised the
   pen shapes that growPens had so carefully styled — corr(compactness,
   rectDeficit) came out at 0.003, i.e. the shape knob did nothing at all.
   So the two boundary walks are made style-aware as well: a compact style takes
   the recipient it already touches most, a snaking style the one it touches
   least. Legality is unchanged — this only reorders equally legal options. */
function pickRecipient(N, work, size, i, p, band, rng, compactness) {
  let best = -1, bestScore = -Infinity;
  for (const nb of orthNeighbors(N, i)) {
    const q = work[nb];
    if (q === p || size[q] >= band.max) continue;
    const s = compactness * 1.5 * touchCount(N, work, i, q) + rng();
    if (s > bestScore) { bestScore = s; best = q; }
  }
  return best;
}

/* Does moving cell i from p to q push the layout the way the style wants?
   Positive = yes. Used ONLY to modulate the probability of accepting a move the
   solver already rates as neutral; it can never accept something the solver
   rejected. */
function styleDelta(N, work, i, p, q, compactness) {
  return compactness * (touchCount(N, work, i, q) - touchCount(N, work, i, p));
}

function sidewaysProb(base, delta) {
  const p = base + 0.22 * delta;
  return p < 0.02 ? 0.02 : p > 0.9 ? 0.9 : p;
}

// ------------------------------------------------- step 5a: refine to unique

/* A freshly grown layout is almost never unique — a random 6x6 partition
   typically admits 10-40 placements. Rather than resample blindly (a hit rate
   near zero), the layout is HILL-CLIMBED towards uniqueness:

     repeatedly move one boundary cell from its pen to an adjacent pen and keep
     the move only if the number of solutions did not go up.

   Two invariants make this safe:
     - a cell holding one of the intended bulls is never moved, so every pen
       keeps exactly k bulls and the intended placement stays a solution (the
       count can therefore never reach 0);
     - the donor pen must stay 4-connected and both pens must stay inside the
       size band, which is re-checked by pensValid() at the end anyway.

   The count is capped, so "score" is really min(solutions, cap) — that is
   enough to drive the climb, and the final uniqueness claim is made by an
   uncapped-at-2 countSolutions() in generate(), not by this function. */
function refinePens(N, k, pens, solution, rng, band, opts) {
  const o = opts || {};
  const cap = o.cap || 24;
  const iters = o.iters || 600;
  const compactness = (o.style || DEFAULT_STYLE).compactness;
  const cells = N * N;
  const work = Int32Array.from(pens);

  const size = new Int32Array(N);
  for (let i = 0; i < cells; i++) size[work[i]]++;

  const connectedWithout = (p, drop) => {
    let start = -1;
    let n = 0;
    for (let i = 0; i < cells; i++) {
      if (work[i] !== p || i === drop) continue;
      n++;
      if (start < 0) start = i;
    }
    if (n === 0) return false;
    const seen = new Set([start]);
    const q = [start];
    for (let h = 0; h < q.length; h++) {
      for (const nb of orthNeighbors(N, q[h])) {
        if (nb === drop || work[nb] !== p || seen.has(nb)) continue;
        seen.add(nb);
        q.push(nb);
      }
    }
    return seen.size === n;
  };

  /* Legal move test, shared by the targeted and the random proposer. */
  function legal(i) {
    if (solution[i] === 1) return -1; // never move a bull between pens
    const p = work[i];
    if (size[p] <= band.min) return -1;
    const q = pickRecipient(N, work, size, i, p, band, rng, compactness);
    if (q < 0) return -1;
    if (!connectedWithout(p, i)) return -1;
    return q;
  }

  let cur = solver.countSolutions({ N, k, pens: work }, cap);
  let score = cur.count;
  /* Stagnation bail-out. A layout that has not improved in `patience` moves is
     usually stuck in a basin, and a fresh layout is cheaper than grinding this
     one: abandoning early is worth roughly 2x on 10x10 throughput. */
  const patience = o.patience || 220;
  let lastGain = 0;
  for (let it = 0; it < iters && score > 1; it++) {
    if (it - lastGain > patience) break;
    /* TARGETED move. The counter hands back the rival solutions it found, so
       instead of poking the layout at random we go straight at a rival: take a
       cell that holds a bull in the rival but NOT in the intended solution, and
       hand it to a neighbouring pen. That changes the rival's per-pen bull
       counts (the intended solution's counts are untouched, because intended
       bulls never move), which is the most direct way to kill it. Falls back to
       a random boundary move when no rival cell is movable. */
    let cell = -1, from = -1, to = -1;
    const rivals = cur.solutions || [];
    const wanted = [];
    for (const alt of rivals) {
      let differs = false;
      for (let i = 0; i < cells; i++) {
        if (alt[i] === 1 && solution[i] !== 1) { wanted.push(i); differs = true; }
      }
      if (differs) break;
    }
    shuffle(wanted, rng);
    for (const i of wanted) {
      const q = legal(i);
      if (q >= 0) { cell = i; from = work[i]; to = q; break; }
    }
    if (cell < 0) {
      for (let tries = 0; tries < 60; tries++) {
        const i = (rng() * cells) | 0;
        const q = legal(i);
        if (q >= 0) { cell = i; from = work[i]; to = q; break; }
      }
    }
    if (cell < 0) continue;

    const sd = styleDelta(N, work, cell, from, to, compactness);
    work[cell] = to;
    size[from]--; size[to]++;
    /* Adaptive cap: we only need to know whether this move got BELOW the
       current score (or matched it), so counting can stop at score+1. As the
       climb closes in on 1 the counter's work collapses — this is most of the
       generator's throughput at 10x10. */
    const probe = solver.countSolutions({ N, k, pens: work }, Math.min(cap, score + 1));
    const next = probe.count;
    /* A strictly better move is always taken — the solver's count is the only
       thing that matters. The style only decides how willing we are to take a
       move the count rates as NEUTRAL. */
    const accept = next < score || (next === score && rng() < sidewaysProb(0.35, sd));
    if (accept) {
      if (next < score) lastGain = it;
      score = next;
      cur = probe;
    } else {
      work[cell] = from;
      size[from]++; size[to]--;
    }
  }
  return { pens: work, score };
}

/* One legal boundary move on a layout: hand cell `i` to an adjacent pen. The
   caller supplies `size` and gets back {cell, from, to} or null. Bull cells are
   never moved, the donor must stay 4-connected, and the size band holds. */
function proposeMove(N, work, size, solution, band, rng, tries, compactness) {
  const cells = N * N;
  const comp = compactness || 0;
  const connectedWithout = (p, drop) => {
    let start = -1;
    let n = 0;
    for (let i = 0; i < cells; i++) {
      if (work[i] !== p || i === drop) continue;
      n++;
      if (start < 0) start = i;
    }
    if (n === 0) return false;
    const seen = new Set([start]);
    const q = [start];
    for (let h = 0; h < q.length; h++) {
      for (const nb of orthNeighbors(N, q[h])) {
        if (nb === drop || work[nb] !== p || seen.has(nb)) continue;
        seen.add(nb);
        q.push(nb);
      }
    }
    return seen.size === n;
  };
  for (let t = 0; t < (tries || 80); t++) {
    const i = (rng() * cells) | 0;
    if (solution[i] === 1) continue;
    const p = work[i];
    if (size[p] <= band.min) continue;
    const q = pickRecipient(N, work, size, i, p, band, rng, comp);
    if (q < 0) continue;
    if (!connectedWithout(p, i)) continue;
    return { cell: i, from: p, to: q, style: styleDelta(N, work, i, p, q, comp) };
  }
  return null;
}

/* Phase two, for the tiers that are supposed to be GENTLE.

   Hill-climbing to uniqueness lands on the hardest boards: a layout is unique
   exactly when it is barely over-constrained. The easy and medium tiers need
   the opposite, so this walk keeps making boundary moves, keeps only those that
   leave the board uniquely solvable, and prefers the ones the solver grades
   LOWER on the ladder. It stops the moment the target rank is reached. The
   solver is still the only judge; this just steers the search towards it. */
function softenPens(N, k, pens, solution, rng, band, targetRank, iters, style) {
  const compactness = (style || DEFAULT_STYLE).compactness;
  const cells = N * N;
  const work = Int32Array.from(pens);
  const size = new Int32Array(N);
  for (let i = 0; i < cells; i++) size[work[i]]++;

  // Softening only ever compares SHALLOW verdicts (no deep sets, no trials):
  // a board it cannot shallow-solve simply ranks 99 and loses every comparison.
  const shallowGrade = (pens) => {
    const g = grade({ N, k, pens }, { stopAt: "shallow" });
    return { g, r: g.solvedNoGuess ? rank(g.maxTechnique) : 99 };
  };

  let start = shallowGrade(work);
  let curRank = start.r;
  let curGrade = start.g;
  let best = Int32Array.from(work);
  let bestRank = curRank;
  let bestGrade = curGrade;
  if (bestRank <= targetRank) return { pens: work, graded: bestGrade };

  /* A RANDOM WALK over uniquely-solvable layouts, not a strict hill climb.
     Boards the shallow solver cannot finish all rank 99, so a strict climb has
     no gradient to follow and just stalls; accepting sideways moves lets the
     walk wander through that plateau until it falls off the edge into a board
     the shallow ladder can crack. Every step still has to stay unique, and the
     best layout ever seen is what gets returned. */
  for (let it = 0; it < (iters || 250); it++) {
    const mv = proposeMove(N, work, size, solution, band, rng, 80, compactness);
    if (!mv) continue;
    work[mv.cell] = mv.to;
    size[mv.from]--; size[mv.to]++;
    let keep = false;
    if (solver.countSolutions({ N, k, pens: work }, 2).count === 1) {
      const { g, r } = shallowGrade(work);
      /* The plateau walk (r === 99, nothing to climb) is exactly where the shape
         character used to get erased, so that is where the style steers. */
      if (r < curRank || (r === curRank && (
            (r === 99 ? rng() < sidewaysProb(0.88, mv.style) : false) ||
            g.effort <= curGrade.effort ||
            rng() < sidewaysProb(0.4, mv.style)))) {
        curRank = r;
        curGrade = g;
        keep = true;
        if (r < bestRank || (r === bestRank && r < 99 && g.effort < bestGrade.effort)) {
          bestRank = r;
          bestGrade = g;
          best = Int32Array.from(work);
        }
      }
    }
    if (!keep) {
      work[mv.cell] = mv.from;
      size[mv.from]++; size[mv.to]--;
    } else if (bestRank <= targetRank) break;
  }
  return { pens: best, graded: bestGrade };
}

// -------------------------------------------------------------- tier gating

/* Tiers are graded by the HARDEST technique the board REQUIRES, never by how
   many cells are blank. `minTech`/`maxTech` are inclusive bounds on the ladder
   index; `effortMin` is a secondary filter only and can never promote a board
   across a technique boundary. */
const TIERS = {
  /* Why easy stops at `region-in-line` and not at `region-forced`:
     a Star Battle layout is uniquely solvable only when it is barely
     over-constrained, and pure counting (rows/cols/pens plus adjacency) is
     never enough to crack one. Measured over 40 softened, uniquely-solvable
     6x6 k=1 layouts — each hill-climbed DOWNWARD as far as the solver would
     allow — the easiest grade ever reached was `region-in-line` (15/40); not a
     single board graded at or below `region-forced`. So the easy tier is
     "counting plus the one-pen-inside-lines cover", which is the true floor of
     the puzzle, and medium is the tier that also needs the converse. */
  /* PADDOCK IS A MIXED-SIZE TIER, and there are three keys for it.

     A 6x6 one-bull board has only ~26 distinguishable solver-effort values in
     the whole space, which is why the shipped table had 1000 levels sharing 26
     difficulties (levels 1-20 all read effort 52). A 7x7 one-bull board sits
     meaningfully above a 6x6 one and has its own band, so mixing the two
     roughly doubles Paddock's achievable range and breaks the long runs.

       easy6 / easy7  size-PINNED. The campaign uses these, one named per level
                      row in js/levels.js, so a level's grid size is an explicit
                      recorded fact rather than something inferred. Nothing is
                      drawn from the rng for the size, so there is no way for a
                      rebuild to silently disagree with the table.
       easy           size-SAMPLED, from the caller's own seeded stream. This is
                      the daily's key: it has no level row to carry a size, so
                      the size falls out of the date seed — same date, same size
                      for every player, always. The list is weighted because a
                      7x7 easy board is ~9x more expensive to find than a 6x6
                      one, so an even draw yielded only 10% sevens (4/40).

     All three share one technique band; the solver gates them identically. */
  easy: {
    N: 6, k: 1, sizes: [6, 7, 7, 7],
    minTech: "adjacency", maxTech: "region-in-line",
    maxSetSize: 2, allowContradiction: false, effortMin: 0,
  },
  easy6: {
    N: 6, k: 1,
    minTech: "adjacency", maxTech: "region-in-line",
    maxSetSize: 2, allowContradiction: false, effortMin: 0,
  },
  easy7: {
    N: 7, k: 1,
    minTech: "adjacency", maxTech: "region-in-line",
    maxSetSize: 2, allowContradiction: false, effortMin: 0,
  },
  medium: {
    N: 8, k: 1,
    minTech: "region-in-line", maxTech: "line-in-region",
    maxSetSize: 2, allowContradiction: false, effortMin: 0,
  },
  hard: {
    N: 9, k: 2,
    minTech: "adjacency-packing", maxTech: "set-cover",
    maxSetSize: 2, allowContradiction: false, effortMin: 0,
  },
  extreme: {
    N: 10, k: 2,
    // Not reachable at all with sets of 2 and no trials: it needs either a
    // deeper set-cover (|S| = 3..4) or a depth-1 contradiction.
    minTech: "adjacency-packing", maxTech: "contradiction",
    maxSetSize: 4, allowContradiction: true, effortMin: 0,
  },
};

/* Grade a puzzle by escalating the solver, cheapest configuration first. The
   ONLY thing that decides a grade is what the solver could and could not do. */
function grade(puzzle, opts) {
  const stopAt = (opts && opts.stopAt) || "full";
  const shallow = solver.solve(puzzle, { allowContradiction: false, maxSetSize: 2 });
  if (shallow.solved) {
    return {
      tier: tierOf(shallow.maxTechnique, 2, false),
      maxTechnique: shallow.maxTechnique,
      effort: shallow.effort,
      maxSetSize: shallow.maxSetSize,
      needsContradiction: false,
      techniques: shallow.techniques,
      solvedNoGuess: true,
    };
  }
  // The gentle/hard tiers only ever care about the shallow verdict, so they ask
  // for stopAt:"shallow" and never pay for the expensive trial pass.
  if (stopAt === "shallow") {
    return { tier: null, maxTechnique: shallow.maxTechnique, effort: shallow.effort, solvedNoGuess: false, stopped: true };
  }
  const deep = solver.solve(puzzle, { allowContradiction: false, maxSetSize: 4 });
  if (deep.solved) {
    return {
      tier: "extreme",
      maxTechnique: deep.maxTechnique,
      effort: deep.effort,
      maxSetSize: deep.maxSetSize,
      needsContradiction: false,
      needsDeepSets: true,
      techniques: deep.techniques,
      solvedNoGuess: true,
    };
  }
  const trial = solver.solve(puzzle, { allowContradiction: true, maxSetSize: 4 });
  if (trial.solved) {
    return {
      tier: "extreme",
      maxTechnique: trial.maxTechnique,
      effort: trial.effort,
      maxSetSize: trial.maxSetSize,
      needsContradiction: true,
      techniques: trial.techniques,
      solvedNoGuess: false,
    };
  }
  return { tier: null, maxTechnique: trial.maxTechnique, effort: trial.effort, solvedNoGuess: false };
}

function tierOf(maxTechnique, setSize, needsContradiction) {
  const r = rank(maxTechnique);
  if (needsContradiction) return "extreme";
  if (r <= rank("region-forced")) return "easy";
  if (r <= rank("line-in-region")) return "medium";
  return "hard";
}

function tierAccepts(tierKey, graded, N, k) {
  const rule = TIERS[tierKey];
  if (!rule || !graded || !graded.maxTechnique) return false;
  const r = rank(graded.maxTechnique);
  if (r < rank(rule.minTech) || r > rank(rule.maxTech)) return false;
  if (graded.effort < rule.effortMin) return false;
  if (tierKey === "extreme") {
    // must genuinely be out of reach of the hard tier's toolkit
    return !!(graded.needsContradiction || graded.needsDeepSets);
  }
  // every other tier must be solvable with sets of 2 and no trials at all
  if (!graded.solvedNoGuess || graded.needsContradiction || graded.needsDeepSets) return false;
  if (graded.maxSetSize > rule.maxSetSize) return false;
  return true;
}

// ------------------------------------------------------------------ public

function dailySeed(dateKey, tierKey) {
  return hashSeed("bullpen|" + dateKey + "|" + (tierKey || ""));
}

/* generate({N, k, tier, seed, maxAttempts})
     -> { N, k, pens, solution, grade, effort, maxTechnique, seed, attempts,
          techniques, unique }
   or { pens: null, reason } when the attempt budget runs out. Never throws.
   Deterministic: the same (tier, N, k, seed) always yields the same board. */
function generate(opts) {
  const o = opts || {};
  const tierKey = o.tier || "easy";
  const rule = TIERS[tierKey];
  if (!rule) return { pens: null, reason: "unknown tier " + tierKey, seed: o.seed };
  const k = o.k || rule.k;
  const baseSeed = o.seed === undefined ? 1 : (typeof o.seed === "number" ? o.seed >>> 0 : hashSeed(o.seed));
  const maxAttempts = o.maxAttempts || 400;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rng = mulberry32((baseSeed + attempt * 0x9e3779b1) >>> 0);

    /* The STYLE is drawn first, from this attempt's own stream. That keeps the
       whole board a pure function of (tier, seed) — a device replaying the
       stored effective seed on attempt 0 draws the identical style — while
       still giving the build a wide spread of pen characters for free. */
    const style = o.style || sampleStyle(rng);

    /* GRID SIZE, same contract as the style: drawn from this attempt's own
       stream, so the stored effective seed alone still rebuilds the board on a
       device and js/game.js needs no change to play a mixed-size tier. An
       explicit o.N always wins, so the verifier's fixed-size probes are
       unaffected. The level table also RECORDS the resulting N so the UI can
       label the tier honestly — but it is not needed to reconstruct the board. */
    const N = o.N || (rule.sizes ? rule.sizes[(rng() * rule.sizes.length) | 0] : rule.N);

    // 1-4: a layout with a known solution built in
    const layout = generatePens(N, k, rng, 20, style);
    if (!layout) continue;
    const refined = refinePens(N, k, layout.pens, layout.solution, rng, layout.band, {
      cap: o.refineCap || 60,
      iters: o.refineIters || 1000,
      patience: o.patience,
      style,
    });
    if (refined.score !== 1) continue;
    layout.pens = refined.pens;

    // gentle tiers get steered back down the ladder before they are judged
    // Every tier except `extreme` wants a board the SHALLOW solver can finish,
    // so the layout is steered down the ladder before it is judged. Extreme
    // wants the opposite and is left exactly where the uniqueness climb put it.
    if (tierKey !== "extreme") {
      const targetRank = rank(rule.maxTech);
      const soft = softenPens(N, k, layout.pens, layout.solution, rng, layout.band, targetRank, o.softenIters || 150, style);
      layout.pens = soft.pens;
    }
    if (!pensValid(N, layout.pens, layout.band)) continue;
    const puzzle = { N, k, pens: layout.pens };

    // 5: uniqueness, proved by exhaustive search and nothing else
    const cs = solver.countSolutions(puzzle, 2);
    if (cs.count !== 1) continue;

    // the sampled placement must BE that solution (paranoia; cheap)
    let same = true;
    for (let i = 0; i < N * N; i++) {
      if ((cs.solution[i] === 1) !== (layout.solution[i] === 1)) { same = false; break; }
    }
    if (!same) continue;

    // 6-7: the solver decides the grade, and the grade decides acceptance
    // Only `extreme` ever needs the deep/trial passes; the others reject a
    // board that the shallow solver cannot finish, which is much cheaper.
    const g = grade(puzzle, { stopAt: tierKey === "extreme" ? "full" : "shallow" });
    if (!g.tier) continue; // needs a guess at this tier's toolkit — reject
    if (!tierAccepts(tierKey, g, N, k)) continue;

    return {
      N, k,
      pens: layout.pens,
      solution: layout.solution,
      grade: tierKey,
      effort: g.effort,
      maxTechnique: g.maxTechnique,
      maxSetSize: g.maxSetSize,
      needsContradiction: !!g.needsContradiction,
      needsDeepSets: !!g.needsDeepSets,
      techniques: g.techniques,
      unique: true,
      style,
      seed: baseSeed,
      attempts: attempt + 1,
    };
  }
  return { pens: null, reason: "attempt budget exhausted", tier: tierKey, seed: baseSeed, attempts: maxAttempts };
}

const API = {
  generate,
  generatePens,
  refinePens,
  softenPens,
  growPens,
  pensValid,
  randomPlacement,
  groupBulls,
  grade,
  tierAccepts,
  sizeBand,
  sampleStyle,
  DEFAULT_STYLE,
  dailySeed,
  TIERS,
};

root.BullpenGenerator = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
