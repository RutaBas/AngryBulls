"use strict";

/* BULLPEN — the game model.

   State, rules, timing, undo, save/restore and the hint bridge. NOTHING in this
   file touches the DOM: ui.js reads from here and draws, and the solver can be
   driven headlessly against it in a test harness. The board controller is the
   only thing that calls into it.

   A cell's PLAYER mark is one of:
     0 EMPTY  untouched
     1 DOT    the player's own "no bull here" note
     2 BULL
   Tapping cycles EMPTY -> DOT -> BULL -> EMPTY. Dragging paints dots only.

   The player's dots ARE fed to the solver as EMPTY, so a hint always reasons
   from the position actually on the board and can never "discover" something
   the player already wrote down. The poisoned-dot risk that argued against
   this is handled head-on instead: hint() checks every mark against the known
   solution first, and if one is wrong it says so rather than deducing from a
   broken position. See hint(). */

var Game = (function () {

  var M_EMPTY = 0, M_DOT = 1, M_BULL = 2;
  var SAVE_KEY = "bullpen:save";

  var G = {
    M_EMPTY: M_EMPTY, M_DOT: M_DOT, M_BULL: M_BULL,

    /* --- identity of the board currently loaded --- */
    mode: "level",        // "level" | "daily" | "free"
    tier: null,
    level: 0,
    dateKey: null,
    par: 0,
    seed: 0,

    /* --- the board --- */
    N: 0, k: 1,
    pens: null,           // Int32Array cell -> pen id
    solution: null,       // Int8Array 0/1
    marks: null,          // Int8Array of M_*
    puzzle: null,         // {N,k,pens} — the object the solver caches geometry on

    /* --- session --- */
    history: [],
    hints: 0,
    mistakes: 0,
    startedAt: 0,
    accumulated: 0,
    running: false,
    /* PAUSED is not merely "the clock is stopped". The clock also stops when the
       player walks to the home screen or wins, and neither of those should bring
       the player back behind a "Paused" panel. `paused` means specifically "the
       player asked for the board to be hidden, or the app was backgrounded" —
       it survives a save and the board screen refuses input while it is set. */
    paused: false,
    won: false
  };

  /* ------------------------------------------------------------ building */

  /* Rebuild a board from its seed with the certified generator. Pure and
     deterministic: the same (genTier, seed) always yields the same pens. */
  function build(genTier, seed) {
    var res = BullpenGenerator.generate({ tier: genTier, seed: seed, maxAttempts: 400 });
    if (!res || !res.pens) throw new Error("generator could not rebuild seed " + seed);
    return res;
  }

  function load(spec) {
    var res = spec.built || build(spec.genTier, spec.seed);
    /* Loading ANY board invalidates whatever was saved before it: Continue must
       never offer a board the player has already walked away from. The new
       board writes its own save as soon as the board screen is entered. */
    dropSave();
    G.mode = spec.mode || "level";
    G.tier = spec.tier || null;
    G.level = spec.level || 0;
    G.dateKey = spec.dateKey || null;
    G.par = spec.par || 0;
    G.seed = spec.seed;
    G.genTier = spec.genTier;
    G.N = res.N;
    G.k = res.k;
    G.pens = res.pens;
    G.solution = res.solution;
    G.effort = res.effort;
    G.puzzle = { N: res.N, k: res.k, pens: res.pens };
    G.marks = new Int8Array(res.N * res.N);
    G.history = [];
    G.hints = 0;
    G.mistakes = 0;
    G.accumulated = 0;
    G.startedAt = Date.now();
    G.running = true;
    G.paused = false;
    G.won = false;
    return G;
  }

  /* ------------------------------------------------------------- geometry */

  function idx(r, c) { return r * G.N + c; }
  function rowOf(i) { return (i / G.N) | 0; }
  function colOf(i) { return i % G.N; }

  function neighbors(i) {
    var out = [], r = rowOf(i), c = colOf(i), dr, dc;
    for (dr = -1; dr <= 1; dr++) {
      for (dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        var rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= G.N || cc < 0 || cc >= G.N) continue;
        out.push(rr * G.N + cc);
      }
    }
    return out;
  }

  function countBulls(cells) {
    var n = 0;
    for (var a = 0; a < cells.length; a++) if (G.marks[cells[a]] === M_BULL) n++;
    return n;
  }

  function rowCells(r) { var a = [], c; for (c = 0; c < G.N; c++) a.push(idx(r, c)); return a; }
  function colCells(c) { var a = [], r; for (r = 0; r < G.N; r++) a.push(idx(r, c)); return a; }
  function penCells(p) {
    var a = [], i;
    for (i = 0; i < G.N * G.N; i++) if (G.pens[i] === p) a.push(i);
    return a;
  }

  G.rowCells = rowCells; G.colCells = colCells; G.penCells = penCells;

  /* Which pens currently hold their full quota of bulls — drives the "pen
     completed" feedback and the deepened fill. */
  function completedPens() {
    var done = [], p;
    for (p = 0; p < G.N; p++) if (countBulls(penCells(p)) === G.k) done.push(p);
    return done;
  }

  /* Every unit a newly-placed bull breaks. Returns a list of
     {kind, n, cells} — the UI flashes exactly these and nothing else. */
  function violationsAt(i) {
    var out = [];
    var nb = neighbors(i), a;
    for (a = 0; a < nb.length; a++) {
      if (G.marks[nb[a]] === M_BULL) {
        out.push({ kind: "touch", n: nb[a], cells: [i, nb[a]] });
        break;
      }
    }
    var r = rowOf(i), c = colOf(i), p = G.pens[i];
    if (countBulls(rowCells(r)) > G.k) out.push({ kind: "row", n: r, cells: rowCells(r) });
    if (countBulls(colCells(c)) > G.k) out.push({ kind: "col", n: c, cells: colCells(c) });
    if (countBulls(penCells(p)) > G.k) out.push({ kind: "pen", n: p, cells: penCells(p) });
    return out;
  }

  /* ---------------------------------------------------------------- moves */

  /* THE single write path for a cell, so undo, mistake counting and auto-save
     all have one place to hook into. Returns a report the UI animates from. */
  function setMark(i, val, opts) {
    opts = opts || {};
    var prev = G.marks[i];
    if (prev === val) return null;
    if (!opts.noHistory) G.history.push({ t: "set", i: i, prev: prev });
    G.marks[i] = val;

    var rep = { cell: i, from: prev, to: val, violations: [], penDone: -1, mistake: false };

    if (val === M_BULL) {
      /* MISTAKES ARE COUNTED FROM THE BOARD. A bull standing where the
         solution has none is a mistake the moment it is placed — nothing here
         cares whether the player pressed a "check" button, because there
         isn't one. */
      if (!G.solution[i]) { G.mistakes++; rep.mistake = true; }
      rep.violations = violationsAt(i);
      if (!rep.violations.length && countBulls(penCells(G.pens[i])) === G.k) {
        rep.penDone = G.pens[i];
      }
    }
    return rep;
  }

  function cycle(i) {
    var cur = G.marks[i];
    var next = cur === M_EMPTY ? M_DOT : cur === M_DOT ? M_BULL : M_EMPTY;
    return setMark(i, next);
  }

  /* --- drag painting (dots only) ---

     A drag is one gesture and must cost exactly one undo, so the cells are
     written straight through without history while the finger moves and the
     whole stroke is filed as a single entry when it lifts. Only DOT <-> EMPTY
     is ever written here; bulls are a deliberate tap, so no mistake can be
     counted from a drag and no rule can be broken by one. */
  function dragPaint(i, val, changes) {
    if (val !== M_DOT && val !== M_EMPTY) return false;
    var prev = G.marks[i];
    if (prev === val || prev === M_BULL) return false;
    G.marks[i] = val;
    changes.push({ i: i, prev: prev });
    return true;
  }

  function commitDrag(changes) {
    if (!changes || !changes.length) return false;
    G.history.push({ t: "multi", changes: changes.slice() });
    return true;
  }

  function undo() {
    var op = G.history.pop();
    if (!op) return null;
    if (op.t === "set") {
      G.marks[op.i] = op.prev;
      return { cell: op.i };
    }
    if (op.t === "multi") {
      var cells = [];
      for (var a = op.changes.length - 1; a >= 0; a--) {
        G.marks[op.changes[a].i] = op.changes[a].prev;
        cells.push(op.changes[a].i);
      }
      return { cells: cells };
    }
    if (op.t === "bulk") {
      G.marks = Int8Array.from(op.prev);
      return { bulk: true };
    }
    return null;
  }

  function clear() {
    G.history.push({ t: "bulk", prev: Int8Array.from(G.marks) });
    G.marks = new Int8Array(G.N * G.N);
  }

  /* ------------------------------------------------------------ solved? */

  function bullsPlaced() {
    var n = 0, i;
    for (i = 0; i < G.marks.length; i++) if (G.marks[i] === M_BULL) n++;
    return n;
  }

  /* The rules decide, not a cell-by-cell comparison with the stored solution:
     the puzzle is unique, so satisfying the rules IS matching the solution, and
     asking the solver keeps one definition of "solved" in the codebase. */
  function isSolved() {
    if (bullsPlaced() !== G.N * G.k) return false;
    var st = new Int8Array(G.marks.length), i;
    for (i = 0; i < G.marks.length; i++) st[i] = G.marks[i] === M_BULL ? 1 : 0;
    return BullpenSolver.isSolution(G.puzzle, st);
  }

  /* ------------------------------------------------------------- hinting */

  /* Find the first mark that contradicts the solution: a bull where the
     solution has none, or a dot where a bull belongs. Returns null if the
     player's position is correct as far as it goes. */
  function firstWrongMark() {
    for (var i = 0; i < G.marks.length; i++) {
      var m = G.marks[i];
      if (m === M_BULL && !G.solution[i]) return { index: i, kind: "bull" };
      if (m === M_DOT && G.solution[i]) return { index: i, kind: "dot" };
    }
    return null;
  }

  function label(i) {
    return "r" + (rowOf(i) + 1) + "c" + (colOf(i) + 1);
  }

  /* The solver-powered hint.

     THE WHOLE POINT: a hint must tell the player something that is not already
     on her board. So the player's own position goes in verbatim — bulls as
     BULL, dots as EMPTY — and the solver's next deduction is therefore, by
     construction, about a cell she has left UNKNOWN. Feeding only the bulls
     (the old behaviour) made the solver re-derive the trivial adjacency dots
     she had already placed, and the first such re-derivation came back as the
     hint: correct, useless, and it still cost her a star.

     A wrong mark would poison that reasoning, so it is intercepted first: the
     most useful thing to say to someone with a bad dot is "that mark is wrong",
     not a deduction built on top of it.

     Returns {found, technique, cells, explain} — the solver's own shape, plus
     reason:"wrong-mark" for the correction case (which still counts as a
     delivered hint). */
  function hint() {
    var wrong = firstWrongMark();
    if (wrong) {
      var i = wrong.index;
      return {
        found: false,
        delivered: true,
        reason: "wrong-mark",
        technique: null,
        cells: [{ index: i, r: rowOf(i), c: colOf(i), state: wrong.kind === "bull" ? "EMPTY" : "BULL" }],
        explain: wrong.kind === "bull"
          ? "The bull at " + label(i) + " can't be right — no solution puts one there. Take it off and the rest will come out."
          : "You've dotted " + label(i) + ", but a bull belongs there. Clear that dot before going further."
      };
    }

    var grid = new Int8Array(G.marks.length), n;
    for (n = 0; n < G.marks.length; n++) {
      if (G.marks[n] === M_BULL) grid[n] = BullpenSolver.BULL;
      else if (G.marks[n] === M_DOT) grid[n] = BullpenSolver.EMPTY;
    }
    /* Sound techniques ONLY. Badlands boards are graded with the depth-1 trial
       technique too, so this can legitimately come up empty on a board that is
       still solvable — but a trial is a machine's move, not a deduction anyone
       enjoys being handed, so it is never delivered unasked. When nothing
       cheaper is left, hint() OFFERS it (reason:"trial-available", charging
       nothing) and the player decides. trialHint() below is the acceptance. */
    var step = BullpenSolver.nextStep(G.puzzle, grid, { maxSetSize: 4 });

    /* Belt and braces. The solver only ever writes into cells that were UNKNOWN
       when it started, and every marked cell went in as BULL or EMPTY, so a
       step about an already-marked cell should be impossible. If one ever does
       appear, refuse it rather than charge for it. */
    if (step.found) {
      var fresh = step.cells.filter(function (c) { return G.marks[c.index] === M_EMPTY; });
      if (!fresh.length) {
        return { found: false, delivered: false, reason: "nothing-new", technique: null, cells: [],
          explain: "Everything forced from here is already on your board." };
      }
      step.cells = fresh;
      step.delivered = true;
      return step;
    }

    step.delivered = false;

    /* Nothing sound is left. If a trial pass would find something, say so and
       let the player choose — the free message must not claim a guess is
       needed when it demonstrably is not. */
    if (step.reason === "guess-required") {
      var sweep = BullpenSolver.trialSweep(G.puzzle, grid, { maxSetSize: 4 });
      if (sweep.found) {
        var fresh2 = sweep.cells.filter(function (c) { return G.marks[c.index] === M_EMPTY; });
        if (fresh2.length) {
          return {
            found: false, delivered: false, reason: "trial-available", technique: "contradiction",
            cells: [], trialCount: fresh2.length,
            explain: "No pen, row or column settles anything on its own from here. What is left is trial and error: test a cell, and if the board breaks a few moves later, that cell was never an option."
          };
        }
      }
    }
    return step;
  }

  /* The opt-in half of the two-stage hint. Runs the trial sweep the offer above
     advertised and hands back EVERY cell it refutes at once, because one cell at
     a time was ten scattered hints that read as noise. Charged as one hint by
     the caller — the offer itself is free. */
  function trialHint() {
    var wrong = firstWrongMark();
    if (wrong) return hint();          // a bad mark still comes first

    var grid = new Int8Array(G.marks.length), n;
    for (n = 0; n < G.marks.length; n++) {
      if (G.marks[n] === M_BULL) grid[n] = BullpenSolver.BULL;
      else if (G.marks[n] === M_DOT) grid[n] = BullpenSolver.EMPTY;
    }
    var sweep = BullpenSolver.trialSweep(G.puzzle, grid, { maxSetSize: 4 });
    var fresh = (sweep.cells || []).filter(function (c) { return G.marks[c.index] === M_EMPTY; });
    if (!fresh.length) {
      return { found: false, delivered: false, reason: sweep.reason || "guess-required",
        technique: null, cells: [], explain: sweep.explain };
    }
    return {
      found: true, delivered: true, technique: "contradiction", cells: fresh,
      refs: [], cues: [], reasons: sweep.reasons,
      explain: fresh.length === 1
        ? "This cell cannot hold a bull: follow the rules from there and the board breaks a few moves later."
        : "None of these " + fresh.length + " cells can hold a bull: drop one in any of them and the board breaks a few moves later. Dotted them all."
    };
  }

  /* Plain-language names for the ladder, so the hint explains the TECHNIQUE and
     not just the cell. The solver's own sentence follows underneath. */
  var TECH_NAMES = {
    "adjacency": "Bulls never touch",
    "line-full": "That line is full",
    "region-full": "That pen is full",
    "line-forced": "Only room left in the line",
    "region-forced": "Only room left in the pen",
    "region-in-line": "A pen trapped inside its lines",
    "line-in-region": "A line trapped inside its pens",
    "adjacency-packing": "No room to stand apart",
    "set-cover": "Counting two pens at once",
    "contradiction": "It breaks if you try it"
  };

  /* ---------------------------------------------------------------- timer */

  function elapsedMs() {
    return G.accumulated + (G.running ? Date.now() - G.startedAt : 0);
  }
  /* pause(true) is the PLAYER's pause (or a backgrounded app): it hides the
     board and is remembered across a save. pause() with no argument is the
     bookkeeping stop used when leaving for the home screen or on a win. */
  function pause(explicit) {
    if (explicit) G.paused = true;
    if (!G.running) return;
    G.accumulated += Date.now() - G.startedAt;
    G.running = false;
  }
  function resume() {
    G.paused = false;
    if (G.running) return;
    G.startedAt = Date.now();
    G.running = true;
  }

  /* ----------------------------------------------------------- persistence */

  /* The undo stack has to survive a reload too, or "continue" hands back a
     board you can look at but can't take a move back on. It is encoded as
     compact arrays rather than the live objects: [0,i,prev] a single set,
     [1,[i,prev,...]] one drag stroke, [2,"marks"] a Clear. Only the most recent
     HISTORY_CAP entries are kept — the tail of a long stack is worth far less
     than staying inside the localStorage quota on a 10x10 board. */
  var HISTORY_CAP = 250;

  function encodeHistory() {
    var out = [], a, b;
    for (a = Math.max(0, G.history.length - HISTORY_CAP); a < G.history.length; a++) {
      var op = G.history[a];
      if (op.t === "set") out.push([0, op.i, op.prev]);
      else if (op.t === "multi") {
        var flat = [];
        for (b = 0; b < op.changes.length; b++) flat.push(op.changes[b].i, op.changes[b].prev);
        out.push([1, flat]);
      } else if (op.t === "bulk") {
        var s = "";
        for (b = 0; b < op.prev.length; b++) s += op.prev[b];
        out.push([2, s]);
      }
    }
    return out;
  }

  function decodeHistory(arr) {
    var out = [], a, b;
    if (!arr || !arr.length) return out;
    for (a = 0; a < arr.length; a++) {
      var e = arr[a];
      if (!e) continue;
      if (e[0] === 0) out.push({ t: "set", i: e[1], prev: e[2] });
      else if (e[0] === 1) {
        var changes = [];
        for (b = 0; b + 1 < e[1].length; b += 2) changes.push({ i: e[1][b], prev: e[1][b + 1] });
        out.push({ t: "multi", changes: changes });
      } else if (e[0] === 2) {
        var prev = new Int8Array(e[1].length);
        for (b = 0; b < e[1].length; b++) prev[b] = +e[1][b] || 0;
        out.push({ t: "bulk", prev: prev });
      }
    }
    return out;
  }

  function save() {
    if (!G.pens || G.won) return;
    try {
      var marks = "";
      for (var i = 0; i < G.marks.length; i++) marks += G.marks[i];
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        v: 1, mode: G.mode, tier: G.tier, level: G.level, dateKey: G.dateKey,
        genTier: G.genTier, seed: G.seed, par: G.par,
        marks: marks, ms: elapsedMs(), hints: G.hints, mistakes: G.mistakes,
        paused: !!G.paused, hist: encodeHistory()
      }));
    } catch (e) { /* private mode / quota — play continues, just unsaved */ }
  }

  function savedContext() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      return s && s.v === 1 && s.seed !== undefined ? s : null;
    } catch (e) { return null; }
  }

  function hasSave() { return !!savedContext(); }

  function dropSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  }

  /* Restore a save into a live game. The board itself is rebuilt from the seed,
     so the save holds nothing but marks, clock and counters. */
  function restore(s) {
    load({
      mode: s.mode, tier: s.tier, level: s.level, dateKey: s.dateKey,
      genTier: s.genTier, seed: s.seed, par: s.par
    });
    if (s.marks && s.marks.length === G.marks.length) {
      for (var i = 0; i < G.marks.length; i++) G.marks[i] = +s.marks[i] || 0;
    }
    G.accumulated = s.ms || 0;
    G.startedAt = Date.now();
    G.hints = s.hints || 0;
    G.mistakes = s.mistakes || 0;
    G.history = decodeHistory(s.hist);
    /* A board saved paused comes back paused, and — because `running` stays
       false — elapsedMs() is still exactly what it was when the app closed.
       The gap, however long, costs the player nothing and gains her nothing. */
    G.paused = !!s.paused;
    G.running = !G.paused;
    return G;
  }

  /* --------------------------------------------------------------- exports */

  G.build = build;
  G.load = load;
  G.setMark = setMark;
  G.cycle = cycle;
  G.dragPaint = dragPaint;
  G.commitDrag = commitDrag;
  G.firstWrongMark = firstWrongMark;
  G.undo = undo;
  G.clear = clear;
  G.isSolved = isSolved;
  G.bullsPlaced = bullsPlaced;
  G.completedPens = completedPens;
  G.hint = hint;
  G.trialHint = trialHint;
  G.techName = function (t) { return TECH_NAMES[t] || t; };
  G.elapsedMs = elapsedMs;
  G.pause = pause;
  G.resume = resume;
  G.save = save;
  G.hasSave = hasSave;
  G.savedContext = savedContext;
  G.dropSave = dropSave;
  G.restore = restore;
  G.neighbors = neighbors;
  return G;
})();
