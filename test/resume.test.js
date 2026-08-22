"use strict";

/* BULLPEN — resume-after-exit round trip.
 *
 * Ruta asked to be SURE that closing the app and coming back continues the
 * board she was on. "It looks right" is not an answer, so this drives the REAL
 * ui.js and the REAL game.js under a headless DOM, plays a board through the
 * real pointer handlers, then throws the entire sandbox away and boots a second
 * one over the same localStorage — which is exactly what a cold launch is after
 * iOS evicts a PWA from memory. Nothing is carried across in a variable; the
 * only thing shared between the two app instances is the storage Map.
 *
 * What it asserts, end to end:
 *   R.1  marks (bulls AND dots, cell for cell), tier, level, elapsed, hints,
 *        mistakes and the undo stack all survive the gap
 *   R.2  the rebuilt board is the SAME PUZZLE — same seed, same pens, same
 *        solution — not merely another board of that tier
 *   R.3  a paused save comes back paused, with the clock not advanced across
 *        the gap, and with the board inert to taps and drags
 *   R.4  a win on a RESUMED board reports the accumulated time to
 *        Meta.recordWin, not just the time since the resume
 *   R.5  starting another level, or finishing one, clears the stale save
 *
 * Run: node games/bullpen/test/resume.test.js
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- the DOM shim

   Just enough DOM for the real ui.js to run: ids resolve to nodes on demand,
   listeners are dispatchable, and the board reports a plausible rectangle so
   the real pointer geometry in cellAt() can be exercised. It renders nothing.
   (Same seam as games/strata/test/dom-shim.js.) */

const BOARD_PX = 360;

function makeDom(store) {
  class ClassList {
    constructor() { this.set = new Set(); }
    add(...c) { c.forEach((x) => x && this.set.add(x)); }
    remove(...c) { c.forEach((x) => this.set.delete(x)); }
    contains(c) { return this.set.has(c); }
    toggle(c, on) { if (on === undefined) on = !this.set.has(c); on ? this.add(c) : this.remove(c); return on; }
  }
  class Node {
    constructor(tag) {
      this.tagName = String(tag || "div").toUpperCase();
      this.children = []; this.parentNode = null;
      this.classList = new ClassList(); this.dataset = {}; this.style = {
        setProperty() {}, removeProperty() {}
      };
      this.attrs = {}; this._text = ""; this._html = "";
      this.hidden = false; this.disabled = false;
      this.listeners = {}; this.offsetWidth = 1; this.scrollTop = 0;
    }
    get className() { return Array.from(this.classList.set).join(" "); }
    set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this._html = String(v); this.children = []; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); this._text = String(v).replace(/<[^>]*>/g, ""); this.children = []; }
    appendChild(n) { n.parentNode = this; this.children.push(n); return n; }
    removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); return n; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    dispatch(t, ev) {
      const e = Object.assign({ target: this, preventDefault() {}, stopPropagation() {}, timeStamp: Date.now() }, ev || {});
      (this.listeners[t] || []).slice().forEach((fn) => fn.call(this, e));
    }
    click() { this.dispatch("click"); }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: BOARD_PX, height: BOARD_PX, right: BOARD_PX, bottom: BOARD_PX };
    }
    setPointerCapture() {} releasePointerCapture() {} focus() {} closest() { return null; }
    matches() { return false; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }

  const ids = new Map();
  const document = {
    hidden: false, listeners: {},
    body: new Node("body"), documentElement: new Node("html"),
    createElement: (t) => new Node(t),
    getElementById(id) {
      if (!ids.has(id)) { const n = new Node("div"); n.attrs.id = id; ids.set(id, n); }
      return ids.get(id);
    },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    dispatch(t, ev) { (this.listeners[t] || []).slice().forEach((fn) => fn(ev || {})); }
  };

  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] || null,
    get length() { return store.size; }
  };

  const window = {
    listeners: {}, innerWidth: 390, innerHeight: 844,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    dispatch(t, ev) { (this.listeners[t] || []).slice().forEach((fn) => fn(ev || {})); },
    confirm: () => true
  };

  return { document, window, localStorage, ids };
}

/* -------------------------------------------------------- boot the real app */

function bootApp(store) {
  const dom = makeDom(store);
  /* The real markup has these hidden at rest; the shim defaults everything to
     visible, so the two overlays are pre-set or pauseGame()'s "already paused?"
     guard would misfire. */
  dom.document.getElementById("pause-veil").hidden = true;
  dom.document.getElementById("busy").hidden = true;

  const sandbox = {
    document: dom.document, window: dom.window, localStorage: dom.localStorage,
    navigator: { vibrate() {}, userAgent: "node" },
    location: { href: "http://localhost/", protocol: "http:" },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    console, Math, Date, JSON, Promise,
    performance: { now: () => Date.now() }
  };
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  sandbox.window.document = dom.document;
  vm.createContext(sandbox);

  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });

  // the certified core + the real meta library + the real game model
  ["js/rng.js", "js/solver.js", "js/generator.js",
   "js/meta/store.js", "js/meta/rng.js", "js/meta/progress.js", "js/meta/daily.js",
   "js/meta/records.js", "js/meta/rank.js", "js/meta/index.js",
   "js/par.js", "js/levels.js"].forEach(load);
  /* In a browser the sandbox global IS `window`, so levels.js's top-level vars
     are window properties and meta-config.js reads them off window. Under vm
     the two are separate objects, so the bridge is made explicit here rather
     than by pretending the shim's window is the global. */
  sandbox.window.BULLPEN_TIERS = sandbox.BULLPEN_TIERS;
  sandbox.window.BULLPEN_LEVELS = sandbox.BULLPEN_LEVELS;
  ["js/meta-config.js", "js/game.js"].forEach(load);

  /* Presentation-only collaborators are stubbed: they DRAW, they do not decide.
     MetaUI keeps a real `current` and a real fmt() because ui.js branches on
     both. */
  vm.runInContext(`
    function nullDouble(named) {
      return new Proxy(named || {}, { get: function (t, k) {
        if (k in t) return t[k];
        return function () { return undefined; };
      }});
    }
    var Sound = nullDouble({ muted: false });
    /* ui.js ticks the haptics on every cell a stroke paints, so the stub has to
       exist here or a drag throws before it paints anything. */
    var Haptics = nullDouble({ enabled: true, supported: true, backend: "none" });
    var Theme = nullDouble({ current: "cream" });
    var __screen = "home";
    var MetaUI = nullDouble({
      show: function (n) { __screen = n; },
      get current() { return __screen; },
      fmt: function (ms) {
        var s = Math.round((ms || 0) / 1000);
        return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
      }
    });
  `, sandbox);

  vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "ui.js"), "utf8"), sandbox, { filename: "js/ui.js" });

  // spy on the ONE meta hook, without changing what it does
  const winCalls = [];
  const realRecordWin = sandbox.Meta.recordWin;
  sandbox.Meta.recordWin = function (ctx) { winCalls.push(ctx); return realRecordWin.call(sandbox.Meta, ctx); };

  return { sandbox, dom, winCalls, UI: sandbox.UI, Game: sandbox.Game, $: (id) => dom.document.getElementById(id) };
}

/* ------------------------------------------------- driving the real pointers */

function xyOf(app, i) {
  const N = app.Game.N, b = 3, pitch = (BOARD_PX - b * 2) / N;
  const r = Math.floor(i / N), c = i % N;
  return { x: b + (c + 0.5) * pitch, y: b + (r + 0.5) * pitch };
}
function tap(app, i) {
  const bd = app.$("board"), p = xyOf(app, i);
  bd.dispatch("pointerdown", { pointerId: 1, clientX: p.x, clientY: p.y });
  bd.dispatch("pointerup", { pointerId: 1, clientX: p.x, clientY: p.y });
}
function dragRow(app, from, to) {
  const bd = app.$("board"), a = xyOf(app, from), b = xyOf(app, to);
  bd.dispatch("pointerdown", { pointerId: 2, clientX: a.x, clientY: a.y });
  bd.dispatch("pointermove", { pointerId: 2, clientX: b.x, clientY: b.y });
  bd.dispatch("pointerup", { pointerId: 2, clientX: b.x, clientY: b.y });
}
function snapshot(G) {
  return {
    marks: Array.from(G.marks), pens: Array.from(G.pens), solution: Array.from(G.solution),
    tier: G.tier, level: G.level, seed: G.seed, mode: G.mode, par: G.par,
    hints: G.hints, mistakes: G.mistakes, ms: G.elapsedMs(), history: G.history.length
  };
}
const sameArray = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* ================================================================== the run */

(async function main() {
  const store = new Map();

  // ---------------------------------------------------- 1. play a real board
  const A = bootApp(store);
  A.UI.startLevel("rangeland", 7);
  await sleep(60);
  assert("R.0 the board screen opened on the level asked for",
    A.Game.tier === "rangeland" && A.Game.level === 7 && A.Game.N === 9,
    A.Game.tier + "/" + A.Game.level);

  // A mix of marks, laid down through the real tap and drag handlers.
  const G = A.Game;
  const bulls = [], blanks = [];
  for (let i = 0; i < G.solution.length; i++) (G.solution[i] ? bulls : blanks).push(i);

  tap(A, bulls[0]); tap(A, bulls[0]);          // empty -> dot -> BULL (correct)
  tap(A, bulls[3]); tap(A, bulls[3]);          // a second correct bull
  const badCell = blanks.find((i) => !G.neighbors(i).some((n) => G.marks[n] === G.M_BULL));
  tap(A, badCell); tap(A, badCell);            // a deliberate MISTAKE bull
  tap(A, blanks[blanks.length - 1]);           // a single dot
  dragRow(A, 8 * 9 + 0, 8 * 9 + 5);            // a drag stroke of dots — one undo

  A.$("btn-hint").click();                     // a real solver-powered hint

  await sleep(700);                            // let the clock actually run
  A.Game.save();

  const before = snapshot(G);
  const nBulls = before.marks.filter((m) => m === 2).length;
  const nDots = before.marks.filter((m) => m === 1).length;
  assert("R.0b the position under test really has bulls AND dots",
    nBulls >= 3 && nDots >= 6, nBulls + " bulls, " + nDots + " dots");
  assert("R.0c a mistake and a hint were really recorded",
    before.mistakes === 1 && before.hints === 1,
    "mistakes=" + before.mistakes + " hints=" + before.hints);
  assert("R.0d the clock really advanced", before.ms >= 600, before.ms + "ms");

  // ------------------------------------- 2. cold launch over the same storage
  /* Everything above is now thrown away: a brand new sandbox, a brand new
     ui.js, a brand new Game. The ONLY thing that crosses the gap is the
     localStorage Map — exactly what survives an app close. */
  await sleep(300);                            // the app is "shut" for a while
  const B = bootApp(store);
  assert("R.1a a cold launch sees a save to continue", B.Game.hasSave());
  B.UI.resumeSave();
  await sleep(60);
  const after = snapshot(B.Game);

  assert("R.1b every mark survives, cell for cell (bulls AND dots)",
    sameArray(before.marks, after.marks),
    after.marks.filter((m, i) => m !== before.marks[i]).length + " cell(s) differ");
  assert("R.1c tier and level survive",
    after.tier === before.tier && after.level === before.level, after.tier + "/" + after.level);
  assert("R.1d elapsed time survives (and does not restart at zero)",
    after.ms >= before.ms && after.ms < before.ms + 3000, before.ms + " -> " + after.ms);
  assert("R.1e the hint count survives", after.hints === before.hints, String(after.hints));
  assert("R.1f the mistake count survives", after.mistakes === before.mistakes, String(after.mistakes));
  assert("R.1g the undo stack survives", after.history === before.history,
    before.history + " -> " + after.history);

  // undo availability is not just a number — it has to actually undo.
  const preUndo = Array.from(B.Game.marks);
  B.$("btn-undo").click();
  const changed = preUndo.filter((m, i) => m !== B.Game.marks[i]).length;
  assert("R.1h the restored undo stack actually undoes the last stroke", changed === 6,
    changed + " cell(s) rolled back");
  B.$("btn-undo").click();                     // ...and again, to be sure
  assert("R.1i a second undo still works", B.Game.history.length === after.history - 2,
    String(B.Game.history.length));

  // ------------------------------------------------ 3. it is the SAME puzzle
  assert("R.2a the stored seed came back", after.seed === before.seed, String(after.seed));
  assert("R.2b the pen layout regenerates identically", sameArray(before.pens, after.pens));
  assert("R.2c the solution regenerates identically", sameArray(before.solution, after.solution));
  assert("R.2d par came back with it", after.par === before.par && after.par > 0, String(after.par));

  // ----------------------------------------------------- 4. paused round trip
  const C = bootApp(store);
  C.UI.startLevel("pasture", 12);
  await sleep(60);
  tap(C, 0); tap(C, 0);                        // something on the board to protect
  await sleep(450);
  C.$("btn-pause").click();
  const pausedMs = C.Game.elapsedMs();
  assert("R.3a tapping the timer pill pauses the game",
    C.Game.paused === true && C.Game.running === false);
  assert("R.3b the pause panel covers the board", C.$("pause-veil").hidden === false);

  const marksAtPause = Array.from(C.Game.marks);
  tap(C, 30); tap(C, 30);                      // taps while paused...
  dragRow(C, 20, 26);                          // ...and a drag while paused
  assert("R.3c the board is inert while paused (taps AND drags)",
    sameArray(marksAtPause, Array.from(C.Game.marks)),
    Array.from(C.Game.marks).filter((m, i) => m !== marksAtPause[i]).length + " cell(s) changed");
  assert("R.3d the clock does not advance while paused",
    Math.abs(C.Game.elapsedMs() - pausedMs) < 5,
    pausedMs + " -> " + C.Game.elapsedMs());

  await sleep(500);                            // a long gap with the app closed
  const D = bootApp(store);
  D.UI.resumeSave();
  await sleep(60);
  assert("R.3e a paused save restores PAUSED, behind the panel",
    D.Game.paused === true && D.Game.running === false && D.$("pause-veil").hidden === false);
  assert("R.3f the clock did not advance across the gap",
    Math.abs(D.Game.elapsedMs() - pausedMs) < 60,
    pausedMs + " -> " + D.Game.elapsedMs());
  assert("R.3g the marks survived the paused save", sameArray(marksAtPause, Array.from(D.Game.marks)));

  D.$("btn-pause-resume").click();
  assert("R.3h Resume restarts the clock without losing accumulated time",
    D.Game.running === true && D.Game.paused === false && D.Game.elapsedMs() >= pausedMs,
    String(D.Game.elapsedMs()));
  await sleep(250);
  assert("R.3i the clock is genuinely running again after Resume",
    D.Game.elapsedMs() > pausedMs + 150, String(D.Game.elapsedMs()));

  // backgrounding the app must land on the same panel, not a running clock
  D.dom.document.hidden = true;
  D.dom.document.dispatch("visibilitychange");
  const bgMs = D.Game.elapsedMs();
  await sleep(200);
  D.dom.document.hidden = false;
  D.dom.document.dispatch("visibilitychange");
  assert("R.3j returning from the background shows the pause panel, not a running clock",
    D.Game.paused === true && D.$("pause-veil").hidden === false &&
    Math.abs(D.Game.elapsedMs() - bgMs) < 20, String(D.Game.elapsedMs() - bgMs));

  // ------------------------------------ 5. a resumed win reports the FULL time
  const E = bootApp(store);
  E.UI.startLevel("paddock", 3);
  await sleep(60);
  tap(E, 0);                                   // one dot, so there is a save
  await sleep(900);                            // time that must not be forgotten
  E.Game.save();
  const carried = E.Game.elapsedMs();

  const F = bootApp(store);
  F.UI.resumeSave();
  await sleep(60);
  const FG = F.Game;
  // Solve all but the last bull off the board, then place the last one by tap.
  const fBulls = [];
  for (let i = 0; i < FG.solution.length; i++) if (FG.solution[i]) fBulls.push(i);
  for (let a = 0; a < fBulls.length - 1; a++) FG.setMark(fBulls[a], FG.M_BULL);
  const last = fBulls[fBulls.length - 1];
  tap(F, last); tap(F, last);                  // the winning move, through the UI
  assert("R.4a the resumed board reaches a solved state", FG.won === true);
  const ctx = FG.recordWin();
  assert("R.4b Meta.recordWin was called once", F.winCalls.length === 1);
  assert("R.4c a resumed win reports the ACCUMULATED time, not the time since resume",
    F.winCalls[0].ms >= carried, carried + " carried vs " + (F.winCalls[0] || {}).ms + " reported");
  assert("R.4d the win reports the right level",
    F.winCalls[0].tier === "paddock" && F.winCalls[0].level === 3);
  assert("R.4e the win was actually recorded", !!ctx);

  // --------------------------------------------- 6. stale saves are cleared
  assert("R.5a finishing a level clears the save (Continue can't re-offer it)",
    F.Game.hasSave() === false);

  const H = bootApp(store);
  H.UI.startLevel("paddock", 5);
  await sleep(60);
  tap(H, 0);
  H.Game.save();
  H.UI.startLevel("paddock", 9);                // switch levels mid-board
  await sleep(60);
  const sv = H.Game.savedContext();
  assert("R.5b starting another level replaces the stale save, never leaves it",
    sv && sv.level === 9 && sv.marks.indexOf("1") === -1 && sv.marks.indexOf("2") === -1,
    sv ? "level " + sv.level : "no save");

  // and a fresh load with no save at all offers nothing to continue
  store.delete("bullpen:save");
  const I = bootApp(store);
  assert("R.5c with no save, there is nothing to continue", I.Game.hasSave() === false);

  // ------------------------------------- 7. re-entering YOUR OWN board resumes
  /* Ruta hit this: pause -> Home -> Continue resumed fine, but going in via the
     level-select grid and tapping the SAME level restarted it. startLevel() ran
     Game.load(), which drops the save. Re-entry from the map, the ◀ ▶ arrows and
     the daily must all resume rather than wipe. */
  const J = bootApp(store);
  J.UI.startLevel("rangeland", 12);
  await sleep(80);
  tap(J, 0); tap(J, 0);                    // a bull and some clock
  J.Game.save();
  const beforeMarks = J.Game.savedContext().marks;
  const beforeMs = J.Game.savedContext().ms;
  await sleep(40);

  J.UI.startLevel("rangeland", 12);        // the exact bug: same level, via the map
  await sleep(60);
  assert("R.6a re-entering the SAME level keeps the marks (does not restart)",
    J.Game.savedContext() && J.Game.savedContext().marks === beforeMarks,
    "before " + beforeMarks.slice(0, 24) + " / after " +
      (J.Game.savedContext() || {}).marks);
  assert("R.6b re-entering the SAME level keeps the clock running on, not reset",
    J.Game.elapsedMs() >= beforeMs, beforeMs + " -> " + J.Game.elapsedMs());
  assert("R.6c a DIFFERENT level still starts fresh",
    (J.UI.startLevel("rangeland", 13), await sleep(60),
      J.Game.savedContext().level === 13 &&
      J.Game.savedContext().marks.indexOf("2") === -1));

  console.log(failures === 0 ? "\nGREEN — resume round trip clean.\n" : "\nRED — " + failures + " failure(s).\n");
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
