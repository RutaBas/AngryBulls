"use strict";

/* BULLPEN — hint regression.
 *
 * The bug this exists to stop coming back:
 *
 *   Ruta played Rangeland 1, dotted every cell trivially adjacent to the bulls
 *   she had placed, pressed Hint, and was told "a bull at r1c6 touches r1c5,
 *   and bulls never touch" — about r1c5, which already had her dot on it. The
 *   hint had cost her a star to restate something already on her board.
 *
 *   Cause: Game.hint() handed the solver the BULLS ONLY, so the solver started
 *   from a blanker board than the player's and its cheapest deduction was one
 *   she had already made.
 *
 * The invariant asserted here: from ANY correctly-marked position, every hint
 * settles at least one cell the player had not already marked. Plus: a wrong
 * mark is reported as a wrong mark rather than deduced around, and a hint that
 * delivers nothing is flagged as not delivered so the counter isn't charged.
 *
 * Run: node games/bullpen/test/hint-regression.js
 */

const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "js");
require(path.join(dir, "rng.js"));
const solver = require(path.join(dir, "solver.js"));
require(path.join(dir, "generator.js"));

// game.js is a browser IIFE assigning `var Game`. Indirect eval runs it in the
// global scope, where it finds BullpenSolver / BullpenGenerator already set.
// (game.js opens with "use strict", so its `var Game` stays inside the eval —
// hence the explicit hand-off on the end.)
const Game = (0, eval)(fs.readFileSync(path.join(dir, "game.js"), "utf8") + ";Game;");

let failures = 0;
function assert(name, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok || !detail ? "" : "  — " + detail));
  if (!ok) failures++;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* A plausible mid-game position: some correct bulls placed, and every cell
   they trivially forbid dotted — exactly the state Ruta was in. */
function playToPosition(rand, fraction) {
  const n = Game.N * Game.N;
  const bulls = [];
  for (let i = 0; i < n; i++) if (Game.solution[i]) bulls.push(i);
  for (const i of bulls) {
    if (rand() > fraction) continue;
    Game.setMark(i, Game.M_BULL);
    for (const j of Game.neighbors(i)) {
      if (Game.marks[j] === Game.M_EMPTY) Game.setMark(j, Game.M_DOT);
    }
  }
}

// Real shipped boards, not invented seeds — level 1 is exactly what Ruta hit.
const LEVELS = require(path.join(dir, "levels.js"));
const TIERS = LEVELS.BULLPEN_TIERS;
const LEVEL_NOS = [1, 2, 40, 500];

let boards = 0, hints = 0, stale = 0, falseWrong = 0, noProgress = 0;

for (const def of TIERS) {
  const tier = def.key;
  for (const lv of LEVEL_NOS) {
    const seed = LEVELS.BULLPEN_LEVELS[tier][lv - 1][0];
    Game.load({ mode: "level", tier, level: lv, genTier: def.gen, seed, par: 0 });
    boards++;
    const rand = mulberry(seed);
    playToPosition(rand, 0.5);

    // Now solve the rest by hint alone. Every single one must be news.
    for (let guard = 0; guard < Game.N * Game.N + 5; guard++) {
      if (Game.isSolved()) break;
      const before = Int8Array.from(Game.marks);
      const step = Game.hint();

      if (step.reason === "wrong-mark") { falseWrong++; break; }
      if (!step.found) {
        if (step.reason !== "solved") noProgress++;
        break;
      }
      hints++;

      // THE assertion: at least one cell of this hint was unmarked.
      const fresh = step.cells.filter((c) => before[c.index] === Game.M_EMPTY);
      if (!fresh.length) {
        stale++;
        console.log("    stale hint on " + tier + "/" + seed + ": " + step.explain);
        break;
      }
      for (const c of step.cells) {
        Game.setMark(c.index, c.state === "BULL" ? Game.M_BULL : Game.M_DOT);
      }
    }
  }
}

console.log("\n--- hint regression (" + boards + " boards, " + hints + " hints) ---");
assert("H.a every hint settles a cell the player had NOT already marked", stale === 0, stale + " stale hint(s)");
assert("H.b a correct position is never reported as a wrong mark", falseWrong === 0, falseWrong + " false alarm(s)");
assert("H.c hints alone carry a correct position to a solved board", noProgress === 0, noProgress + " board(s) stalled");
assert("H.d the hint bridge actually ran", hints > 0);

/* A poisoned position must be called out, not deduced around. */
const RANGE = TIERS.find((t) => t.key === "rangeland");
const rangeSeed = LEVELS.BULLPEN_LEVELS.rangeland[0][0];
function loadRangeland1() {
  Game.load({ mode: "level", tier: "rangeland", level: 1, genTier: RANGE.gen, seed: rangeSeed, par: 0 });
}
loadRangeland1();
let bullCell = -1, emptyCell = -1;
for (let i = 0; i < Game.solution.length; i++) {
  if (Game.solution[i] && bullCell < 0) bullCell = i;
  if (!Game.solution[i] && emptyCell < 0) emptyCell = i;
}
Game.setMark(bullCell, Game.M_DOT);
let w = Game.hint();
assert("H.e a dot where a bull belongs is reported as a wrong mark",
  w.reason === "wrong-mark" && w.cells[0].index === bullCell, JSON.stringify(w.reason));
assert("H.f a wrong-mark hint counts as delivered", w.delivered === true);

loadRangeland1();
Game.setMark(emptyCell, Game.M_BULL);
w = Game.hint();
assert("H.g a bull where none belongs is reported as a wrong mark",
  w.reason === "wrong-mark" && w.cells[0].index === emptyCell, JSON.stringify(w.reason));

/* A solved board delivers nothing — and must therefore not be chargeable. */
const PAD = TIERS.find((t) => t.key === "paddock");
Game.load({ mode: "level", tier: "paddock", level: 1, genTier: PAD.gen, seed: LEVELS.BULLPEN_LEVELS.paddock[0][0], par: 0 });
for (let i = 0; i < Game.solution.length; i++) {
  Game.setMark(i, Game.solution[i] ? Game.M_BULL : Game.M_DOT);
}
const done = Game.hint();
assert("H.h a finished board delivers no hint (so nothing is charged)",
  done.found === false && done.delivered === false, JSON.stringify(done.reason));

/* One drag is one undo. */
const BAD = TIERS.find((t) => t.key === "badlands");
Game.load({ mode: "level", tier: "badlands", level: 1, genTier: BAD.gen, seed: LEVELS.BULLPEN_LEVELS.badlands[0][0], par: 0 });
const hist0 = Game.history.length;
const batch = [];
for (let c = 0; c < 10; c++) Game.dragPaint(c, Game.M_DOT, batch);
Game.commitDrag(batch);
let dotted = 0;
for (let c = 0; c < 10; c++) if (Game.marks[c] === Game.M_DOT) dotted++;
assert("H.i a drag paints every cell it crosses", dotted === 10, dotted + "/10");
assert("H.j a drag adds exactly ONE undo entry", Game.history.length === hist0 + 1);
Game.undo();
let left = 0;
for (let c = 0; c < 10; c++) if (Game.marks[c] !== Game.M_EMPTY) left++;
assert("H.k one undo rolls the whole drag back", left === 0, left + " cell(s) survived");

/* A drag must never touch a bull. */
Game.setMark(3, Game.M_BULL);
const b2 = [];
for (let c = 0; c < 10; c++) Game.dragPaint(c, Game.M_DOT, b2);
assert("H.l a drag never removes or places a bull",
  Game.marks[3] === Game.M_BULL && b2.length === 9, b2.length + " changes");

console.log(failures === 0 ? "\nGREEN — hint regression clean.\n" : "\nRED — " + failures + " failure(s).\n");
process.exit(failures === 0 ? 0 : 1);
