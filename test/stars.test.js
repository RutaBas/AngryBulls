"use strict";

/* BULLPEN — star rule, take-back forgiveness, and saved-progress safety.
 *
 * The rule (js/meta-config.js): over par, a hint, and a wrong bull each cost
 * ONE star; a solve always earns at least one. A wrong bull taken off again
 * within 12 s of play time is a mis-tap and costs nothing (js/game.js).
 *
 * Ruta's condition for the change: it must not touch progress she already
 * has. S.3 boots the real meta layer over a hand-written save in the exact
 * stored shape, and checks every stored star, best time, streak and total
 * comes back untouched, and that replays can only raise stars.
 *
 *   S.1  the full star table, including free play (no par)
 *   S.2  the new rule never gives fewer stars than the old one
 *   S.3  existing progress and dailies survive the change untouched
 *   S.4  take-backs: tap-off, Undo and Clear inside the window are forgiven;
 *        outside it they count; paused time does not use up the window
 *   S.5  a save from before this change keeps its mistakes on resume, and the
 *        window survives a save/restore round trip
 *
 * Run: node games/bullpen/test/stars.test.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

let failures = 0;
function assert(name, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok || !detail ? "" : "  — " + detail));
  if (!ok) failures++;
}

/* A controllable clock, so the 12 s window is tested without sleeping. */
let clock = 1_000_000;
class FakeDate extends Date {
  constructor(...a) { super(...(a.length ? a : [clock])); }
  static now() { return clock; }
}

function boot(store) {
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => Array.from(store.keys())[i] || null,
    get length() { return store.size; }
  };
  const sandbox = { localStorage, console, Math, JSON, Date: FakeDate, window: {} };
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });
  ["js/rng.js", "js/solver.js", "js/generator.js",
   "js/meta/store.js", "js/meta/rng.js", "js/meta/progress.js", "js/meta/daily.js",
   "js/meta/records.js", "js/meta/rank.js", "js/meta/index.js",
   "js/par.js", "js/levels.js"].forEach(load);
  sandbox.window.BULLPEN_TIERS = sandbox.BULLPEN_TIERS;
  sandbox.window.BULLPEN_LEVELS = sandbox.BULLPEN_LEVELS;
  ["js/meta-config.js", "js/game.js"].forEach(load);
  return sandbox;
}

/* ------------------------------------------------------- S.1 / S.2 the rule */

const S = boot(new Map());
const starsFor = S.Meta.starsFor;
const oldStars = S.GameMeta.Progress.defaultStars;
const PAR = 60000;

const table = [
  // [label, ms, hints, mistakes, expected]
  ["clean, under par",            50000, 0, 0, 3],
  ["clean, over par",             90000, 0, 0, 2],
  ["hint, under par",             50000, 1, 0, 2],
  ["mistake, under par",          50000, 0, 1, 2],
  ["hint, over par",              90000, 2, 0, 1],
  ["mistake, over par",           90000, 0, 3, 1],
  ["hint + mistake, under par",   50000, 1, 1, 1],
  ["hint + mistake, over par",    90000, 1, 1, 1],
  ["exactly on par counts as under", 60000, 0, 0, 3]
];
table.forEach(([label, ms, hints, mistakes, want]) => {
  const got = starsFor({ ms, hints, mistakes }, PAR);
  assert(`S.1 ${label} → ${want}★`, got === want, `got ${got}`);
});
assert("S.1 free play (no par), clean → 2★", starsFor({ ms: 1, hints: 0, mistakes: 0 }, 0) === 2);
assert("S.1 free play (no par), one hint → 1★", starsFor({ ms: 1, hints: 1, mistakes: 0 }, 0) === 1);

let never = true;
for (const ms of [30000, 60000, 90000]) for (const h of [0, 1, 4]) for (const m of [0, 1, 4]) for (const p of [0, PAR]) {
  const r = { ms, hints: h, mistakes: m };
  if (starsFor(r, p) < oldStars(r, p)) never = false;
}
assert("S.2 new rule never gives fewer stars than the old one", never);

/* ---------------------------------------------- S.3 existing progress is safe */

const saved = new Map();
const progressBefore = {
  v: 1,
  tiers: {
    paddock: { unlocked: 4, levels: {
      1: { stars: 3, bestMs: 41000, plays: 2 },
      2: { stars: 1, bestMs: 99000, plays: 1 },
      3: { stars: 2, bestMs: 70000, plays: 1 }
    } },
    rangeland: { unlocked: 2, levels: { 1: { stars: 1, bestMs: 300000, plays: 1 } } }
  },
  totalStars: 7, solvedCount: 5, clearedCount: 4, openedTiers: []
};
const dailyBefore = {
  v: 1, streak: 4, best: 9, lastDay: null, freezes: 1, freezeProgress: 4, totalSolved: 12,
  days: { "2026-11-10": { day: 0, ms: 80000, stars: 1, tier: "paddock", hints: 1, mistakes: 0 } }
};
saved.set("bull:progress", JSON.stringify(progressBefore));
saved.set("bull:daily", JSON.stringify(dailyBefore));
saved.set("bull:daily2", JSON.stringify(Object.assign({}, dailyBefore, { streak: 2 })));

const P = boot(saved);
const prog = P.Meta.progress;
const lv = (t, n) => prog.level(t, n);

assert("S.3a every stored level keeps its stars, best time and plays",
  JSON.stringify(prog.state.tiers.paddock.levels) === JSON.stringify(progressBefore.tiers.paddock.levels) &&
  JSON.stringify(prog.state.tiers.rangeland.levels) === JSON.stringify(progressBefore.tiers.rangeland.levels));
assert("S.3b totals unchanged (stars, solved, cleared)",
  prog.state.totalStars === 7 && prog.state.solvedCount === 5 && prog.state.clearedCount === 4);
assert("S.3c unlocks unchanged", prog.state.tiers.paddock.unlocked === 4 && prog.state.tiers.rangeland.unlocked === 2);
assert("S.3d stored dailies and streaks untouched",
  P.Meta.daily.state.days["2026-11-10"].stars === 1 && P.Meta.daily.state.streak === 4 &&
  P.Meta.daily.state.best === 9 && P.Meta.daily2.state.streak === 2);

// A messy replay of a 3★ level must not lower it.
const par1 = prog.parFor("paddock", 1);
P.Meta.recordWin({ mode: "level", tier: "paddock", level: 1, ms: par1 * 3, hints: 2, mistakes: 2 });
assert("S.3e a worse replay never lowers stars (3★ stays 3★)", lv("paddock", 1).stars === 3);
assert("S.3f ...and its best time is kept", lv("paddock", 1).bestMs === 41000);

// A replay that earns more under the new rule raises it, and the total follows.
const par2 = prog.parFor("paddock", 2);
P.Meta.recordWin({ mode: "level", tier: "paddock", level: 2, ms: Math.max(1, par2 - 1000), hints: 1, mistakes: 0 });
assert("S.3g a replay with one hint under par lifts 1★ → 2★", lv("paddock", 2).stars === 2);
assert("S.3h total stars rise by exactly the difference", prog.state.totalStars === 8,
  "total " + prog.state.totalStars);
assert("S.3i a stored daily is not re-scored when replayed",
  P.Meta.recordWin({ mode: "daily", tier: "paddock", dateKey: "2026-11-10", ms: 1, hints: 0, mistakes: 0 }).stars === 1);

/* ------------------------------------------------------ S.4 take-backs */

const G = boot(new Map()).Game;
const row = S.Meta.levelRow("paddock", 1);
function fresh() {
  G.load({ mode: "level", tier: "paddock", level: 1, genTier: row.genTier, seed: row.seed, par: row.par });
}
function wrongCells() {
  const out = [];
  for (let i = 0; i < G.solution.length; i++) if (!G.solution[i]) out.push(i);
  return out;
}
const tick = (ms) => { clock += ms; };

fresh();
let [w1, w2, w3] = wrongCells();
G.setMark(w1, G.M_BULL);
assert("S.4a a wrong bull counts a mistake at once", G.mistakes === 1);
tick(2000); G.setMark(w1, G.M_EMPTY);
assert("S.4b tapped off after 2 s → forgiven", G.mistakes === 0);

G.setMark(w1, G.M_BULL); tick(11000); G.setMark(w1, G.M_EMPTY);
assert("S.4c tapped off after 11 s → still forgiven", G.mistakes === 0);

G.setMark(w1, G.M_BULL); tick(13000); G.setMark(w1, G.M_EMPTY);
assert("S.4c' left 13 s then removed → counts", G.mistakes === 1);

fresh();
G.setMark(w1, G.M_BULL); tick(1000); G.undo();
assert("S.4d Undo inside the window → forgiven", G.mistakes === 0 && G.marks[w1] === G.M_EMPTY);

fresh();
G.setMark(w1, G.M_BULL); G.setMark(w2, G.M_BULL); tick(3000); G.clear();
assert("S.4e Clear inside the window forgives every fresh wrong bull", G.mistakes === 0);

fresh();
G.setMark(w1, G.M_BULL); tick(1000); G.pause(true); tick(60000); G.resume(); tick(1000);
G.setMark(w1, G.M_EMPTY);
assert("S.4f paused time does not use up the window", G.mistakes === 0);

fresh();
const right = G.solution.findIndex((v) => v);
G.setMark(right, G.M_BULL); tick(500); G.setMark(right, G.M_EMPTY);
assert("S.4g a correct bull never touches the count", G.mistakes === 0);

fresh();
G.setMark(w1, G.M_BULL); tick(1000); G.setMark(w1, G.M_EMPTY);
G.setMark(w1, G.M_BULL); tick(1000); G.setMark(w1, G.M_EMPTY);
assert("S.4h repeated quick take-backs never go below zero", G.mistakes === 0);

/* ------------------------------------------------- S.5 saves, old and new */

const store5 = new Map();
const H = boot(store5).Game;
// A save written BEFORE this change: no `pend`, one mistake on the board.
H.load({ mode: "level", tier: "paddock", level: 1, genTier: row.genTier, seed: row.seed, par: row.par });
const marks = new Array(H.marks.length).fill(0);
[w3] = wrongCells(); marks[w3] = 2;
store5.set("bullpen:save", JSON.stringify({
  v: 1, mode: "level", tier: "paddock", level: 1, dateKey: null, genTier: row.genTier,
  seed: row.seed, par: row.par, marks: marks.join(""), ms: 20000, hints: 0, mistakes: 1,
  paused: false, hist: [[0, w3, 0]]
}));
H.restore(H.savedContext());
assert("S.5a an old save keeps its mistake on resume", H.mistakes === 1);
H.setMark(w3, H.M_EMPTY);
assert("S.5b ...and removing that old bull does not refund it", H.mistakes === 1);

H.load({ mode: "level", tier: "paddock", level: 1, genTier: row.genTier, seed: row.seed, par: row.par });
H.setMark(w3, H.M_BULL); tick(1000); H.save();
const I = boot(store5).Game;
I.restore(I.savedContext());
tick(1000); I.setMark(w3, I.M_EMPTY);
assert("S.5c the window survives a save and reload", I.mistakes === 0);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
