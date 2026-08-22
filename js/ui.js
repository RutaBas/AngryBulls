"use strict";

/* BULLPEN — the board controller.

   Owns the board screen only: drawing cells, handling taps, the timer, the
   tools and the hint banner. Progression screens live in js/meta-ui.js and
   progression itself lives in js/meta/. The game model (js/game.js) holds no
   DOM, so the solver can be driven against it head-lessly. */

var UI = (function () {

  function $(id) { return document.getElementById(id); }

  var boardEl, cellEls = [], timerHandle = null, lastTick = "";

  /* Deliberately WIDER than any double-tap window this app might use of its
     own. iOS decides "that was a double-tap, zoom" on its own ~350ms clock, so
     a suppression window matched to the app's own timing would miss and the
     board would still zoom. This window has to cover iOS's, not ours.
     (Ported from CatDoku, where it was hard-won.) */
  var ZOOM_SUPPRESS_MS = 400;
  var BOARD_BORDER_PX = 3;  // must match .board's border-width in css/style.css

  /* One in-progress paint stroke, or null when idle. See onPointerDown(). */
  var drag = null;
  var DRAG_SOUND_MS = 55;   // the dot bell is throttled to this, or a stroke machine-guns

  /* ------------------------------------------------------------- starting */

  /* Generating a Badlands board takes about a second on a phone, so the veil
     goes up first and the work happens on the next frame — otherwise the tap
     looks dropped. */
  function busy(on) { $("busy").hidden = !on; }

  function withBusy(fn) {
    busy(true);
    setTimeout(function () {
      try { fn(); } finally { busy(false); }
    }, 16);
  }

  /* Re-entering the board you are already part-way through must RESUME it, not
     wipe it. Game.load() calls dropSave(), so without this guard picking your
     own in-progress level from the map (or the ◀ ▶ arrows) silently restarts it
     — you lose the marks and the clock with no warning and no undo. Continue
     already routed through resumeSave(); every other way back in now does too. */
  function savedIs(match) {
    var s = Game.savedContext();
    if (!s) return null;
    for (var k in match) if (s[k] !== match[k]) return null;
    return s;
  }

  function startLevel(tier, level) {
    var row = Meta.levelRow(tier, level);
    if (!row) return;
    if (savedIs({ mode: "level", tier: tier, level: level })) { resumeSave(); return; }
    withBusy(function () {
      Game.load({
        mode: "level", tier: tier, level: level,
        genTier: row.genTier, seed: row.seed, par: row.par
      });
      enterGame();
    });
  }

  function startDaily(dateKey) {
    var d = Meta.dailyPuzzle(dateKey);
    if (savedIs({ mode: "daily", dateKey: d.dateKey })) { resumeSave(); return; }
    withBusy(function () {
      var built = Game.build(d.genTier, d.seed);
      Game.load({
        mode: "daily", tier: d.tier, dateKey: d.dateKey,
        genTier: d.genTier, seed: d.seed,
        par: Meta.parForEffort(d.tier, built.effort),
        built: built
      });
      enterGame();
    });
  }

  function resumeSave() {
    var s = Game.savedContext();
    if (!s) return;
    withBusy(function () {
      Game.restore(s);
      enterGame();
    });
  }

  function enterGame() {
    MetaUI.show("game");
    renderAll();
    /* A board saved paused comes back paused — behind the panel, clock stopped.
       Anything else starts running immediately. */
    if (Game.paused) showPause();
    else { hidePause(); Game.resume(); startTimer(); }
    Game.save();
  }

  /* ---------------------------------------------------------------- pause

     Pausing HIDES THE BOARD. That is the whole point: if the grid stayed
     readable the player could go on solving with the clock stopped, and every
     par, best time and record in the game would stop meaning anything. The
     panel is opaque (a blur can be beaten with a screenshot) and the pointer
     handlers below bail out on Game.paused, so the board is inert to taps and
     to drags, not merely covered. */

  function showPause() {
    Game.pause(true);
    stopTimer();
    Game.save();
    $("pause-where").textContent = whereText();
    $("pause-time").textContent = MetaUI.fmt(Game.elapsedMs());
    $("pause-veil").hidden = false;
  }

  function hidePause() {
    $("pause-veil").hidden = true;
  }

  function pauseGame() {
    if (Game.won || MetaUI.current !== "game") return;
    if (!$("pause-veil").hidden) return;
    Sound.unlock();
    /* A stroke in flight is filed before the board goes dark, so the dots the
       finger already laid down are kept and cost their one undo. */
    if (drag) {
      var d = drag; drag = null;
      if (d.changes.length) { Game.commitDrag(d.changes); renderPips(); }
    }
    showPause();
  }

  function resumeGame() {
    hidePause();
    Game.resume();
    tickTimer(true);
    startTimer();
    Game.save();
  }

  /* --------------------------------------------------------------- render */

  function renderAll() {
    renderHead();
    renderBoard();
    renderPips();
    $("hintbar").hidden = true;
    $("btn-undo").disabled = false;
  }

  /* ---- naming the board you are on

     The daily's tier changes from day to day, so "Daily · 2026-08-06" told the
     player nothing about whether she was about to play a one-bull or a two-bull
     board. Every mode now names its tier AND states the rule in words.

     The rule line is derived from Game.k — the k the board was actually built
     with — never from the tier name. A tier's k could be retuned in the ladder
     and this line would follow it; a per-name lookup would quietly lie. */

  var COUNT_WORD = ["no", "One", "Two", "Three", "Four", "Five"];

  function ruleText() {
    var k = Game.k;
    if (!k) return "";
    var word = COUNT_WORD[k] || String(k);
    return word + (k === 1 ? " bull" : " bulls") + " per pen, row & column";
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];

  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday",
                  "Thursday", "Friday", "Saturday"];

  /* Weekday for a YYYY-MM-DD key. Built from the numeric parts via the local
     Date constructor — NOT new Date(string), which treats a bare ISO date as
     UTC and names the wrong day for anyone west of Greenwich. */
  function weekdayOf(key) {
    var p = String(key || "").split("-");
    if (p.length !== 3) return "";
    var d = new Date(+p[0], (+p[1]) - 1, +p[2]);
    return isNaN(d.getTime()) ? "" : WEEKDAYS[d.getDay()];
  }

  /* "2026-08-06" -> "6 Aug". Split, not new Date(), because parsing a bare
     ISO date string is treated as UTC and can render as the previous day for
     anyone west of Greenwich. */
  function shortDate(key) {
    var p = String(key || "").split("-");
    if (p.length !== 3) return key || "";
    return (+p[2]) + " " + (MONTHS[(+p[1]) - 1] || p[1]);
  }

  function tierName() {
    return (Game.tier && Meta.ladder[Game.tier]) || "";
  }

  /* Where you are, one line — used by the pause panel and the header. */
  function whereText() {
    if (Game.mode === "level") return tierName() + " · Level " + Game.level;
    if (Game.mode === "daily") {
      return "Daily · " + tierName() + " · " + shortDate(Game.dateKey);
    }
    return tierName() || "Free play";
  }

  function renderHead() {
    if (Game.mode === "level") {
      $("big-num").classList.remove("bignum-date");
      $("big-num").textContent = Game.level;
      $("level-lbl").textContent = tierName();
      $("btn-prev").disabled = Game.level <= 1;
      $("btn-next").disabled = Game.level >= Meta.tierDef(Game.tier).levels;
      $("btn-prev").hidden = $("btn-next").hidden = false;
    } else if (Game.mode === "daily") {
      /* The date keeps its place as the daily's identity — it lives in the big
         translucent numeral. The month is stacked ABOVE the day rather than set
         beside it: a level's numeral is narrow and sits cleanly behind the tier
         name, but "August" set alongside pushed the watermark out past the title
         on both sides and the whole header read as crowded. Stacked, the daily
         watermark is as narrow as a level's and still reads as "August 11". */
      var parts = String(Game.dateKey || "").split("-");
      var big = $("big-num");
      big.textContent = "";
      big.classList.toggle("bignum-date", parts.length === 3);
      if (parts.length === 3) {
        var mo = document.createElement("span");
        mo.className = "bignum-mo";
        mo.textContent = MONTHS_FULL[(+parts[1]) - 1] || "";
        big.appendChild(mo);
        big.appendChild(document.createTextNode(String(+parts[2])));
      }
      $("level-lbl").textContent = "Daily · " + tierName();
      $("btn-prev").hidden = $("btn-next").hidden = true;
    } else {
      $("big-num").classList.remove("bignum-date");
      $("big-num").textContent = "";
      $("level-lbl").textContent = tierName() || "Free play";
      $("btn-prev").hidden = $("btn-next").hidden = true;
    }

    /* The numeral above now reads "August 6", so repeating the date here would
       just be noise — the sub-line carries the weekday instead, which the
       numeral cannot show and which reinforces that this is a date. */
    var rule = ruleText();
    if (Game.mode === "daily" && rule) {
      var wd = weekdayOf(Game.dateKey);
      if (wd) rule = wd + " · " + rule;
    }
    $("rule-lbl").textContent = rule;
    tickTimer(true);
  }

  function renderBoard() {
    boardEl = $("board");
    boardEl.style.gridTemplateColumns = "repeat(" + Game.N + ", 1fr)";
    boardEl.innerHTML = "";
    cellEls = [];
    var N = Game.N;
    for (var i = 0; i < N * N; i++) {
      var r = (i / N) | 0, c = i % N, pen = Game.pens[i];
      var el = document.createElement("button");
      el.type = "button";
      el.className = "cell" +
        ((c === N - 1 || Game.pens[i + 1] !== pen) ? " pR" : "") +
        ((r === N - 1 || Game.pens[i + N] !== pen) ? " pB" : "");
      el.style.setProperty("--pf", "var(--p" + (pen % 10) + "f)");
      el.style.setProperty("--pd", "var(--p" + (pen % 10) + "d)");
      el.dataset.i = i;
      boardEl.appendChild(el);
      cellEls.push(el);
      paintCell(i);
    }
    paintPens();
  }

  function paintCell(i, landed) {
    var el = cellEls[i];
    if (!el) return;
    var m = Game.marks[i];
    if (m === Game.M_BULL) {
      el.innerHTML = '<svg class="bullsvg"><use href="#bull"/></svg>';
      if (landed) {
        el.classList.remove("landed");
        void el.offsetWidth;
        el.classList.add("landed");
      }
    } else if (m === Game.M_DOT) {
      el.innerHTML = '<span class="dot"></span>';
    } else {
      el.innerHTML = "";
    }
  }

  /* A pen that holds its quota deepens once and holds. */
  function paintPens() {
    var done = {}, list = Game.completedPens(), a;
    for (a = 0; a < list.length; a++) done[list[a]] = 1;
    for (var i = 0; i < cellEls.length; i++) {
      cellEls[i].classList.toggle("penDone", !!done[Game.pens[i]]);
    }
  }

  function renderPips() {
    var total = Game.N * Game.k;
    var placed = Game.bullsPlaced();
    var html = "";
    for (var i = 0; i < total; i++) html += '<i class="' + (i < placed ? "off" : "") + '"></i>';
    $("remain-pips").innerHTML = html;
  }

  /* ---------------------------------------------------------------- input

     Two gestures, one pointer model:

       TAP    cycles the cell EMPTY -> DOT -> BULL -> EMPTY. Placing a bull is
              a deliberate single tap and nothing else can place one.
       DRAG   paints DOTS across every cell the finger crosses. On a 10x10
              two-bull board a finished grid carries ~80 dots, so tapping each
              one is the game's main friction.

     The rules that keep a drag predictable:
       · The FIRST cell decides the whole stroke — started on empty, the stroke
         adds dots; started on a dot, the stroke erases dots. Never a per-cell
         toggle, or crossing a half-dotted row would come out as noise.
       · A stroke never writes a bull and never disturbs one.
       · Idempotent: a cell re-entered mid-stroke (jitter, backtracking) is not
         flipped a second time.
       · One stroke is ONE undo. The cells are written without history while
         the finger moves and the whole thing is filed as a single entry on
         lift — 30 undos to take back one careless swipe would be unusable.

     Pointer Events cover mouse and touch in one path (the model is ported from
     battleships). Cells are resolved from the board's own geometry, because
     touch fires no per-cell mouseover during a drag, and the gap between two
     pointermove samples is filled in so a fast flick doesn't skip cells. */

  /* Geometry, not elementFromPoint: cheaper, steadier under a fast finger, and
     it can't be fooled by the dot/bull child elements. Cells are 1fr with no
     gap, so the pitch is just the ruled interior divided by N. Returns -1 off
     the board. (Ported from battleships' cellAt.) */
  function cellAt(x, y) {
    if (!boardEl || !Game.N) return -1;
    var rect = boardEl.getBoundingClientRect();
    var b = BOARD_BORDER_PX;
    var px = x - rect.left - b, py = y - rect.top - b;
    var span = rect.width - b * 2;
    if (span <= 0 || px < 0 || py < 0 || px > span || py > rect.height - b * 2) return -1;
    var pitch = span / Game.N;
    var c = Math.min(Game.N - 1, Math.max(0, Math.floor(px / pitch)));
    var r = Math.min(Game.N - 1, Math.max(0, Math.floor(py / pitch)));
    return r * Game.N + c;
  }

  /* Paint one cell into the running stroke. The `from` guard is what enforces
     "the first cell decides": a stroke that started by adding dots slides over
     cells that already carry a dot or a bull instead of flipping them back. */
  function dragApply(i) {
    if (i < 0 || drag.applied[i]) return;
    drag.applied[i] = 1;
    if (Game.marks[i] !== drag.from) return;
    if (!Game.dragPaint(i, drag.to, drag.changes)) return;
    paintCell(i);
    var now = Date.now();
    if (now - drag.lastSound >= DRAG_SOUND_MS) { drag.lastSound = now; Sound.dot(); }
  }

  /* Walk the straight line from the last painted cell to this one, so a fast
     flick paints the cells it flew over rather than two lonely endpoints. */
  function dragTo(i) {
    if (i < 0 || i === drag.last) return;
    var N = Game.N;
    var r0 = (drag.last / N) | 0, c0 = drag.last % N;
    var r1 = (i / N) | 0, c1 = i % N;
    var steps = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0));
    for (var s = 1; s <= steps; s++) {
      var rr = Math.round(r0 + ((r1 - r0) * s) / steps);
      var cc = Math.round(c0 + ((c1 - c0) * s) / steps);
      dragApply(rr * N + cc);
    }
    drag.last = i;
  }

  function onPointerDown(e) {
    if (drag || Game.won || Game.paused) return;
    var i = cellAt(e.clientX, e.clientY);
    if (i < 0) return;
    e.preventDefault();
    Sound.unlock();
    clearHint();

    var m = Game.marks[i];
    drag = {
      pointerId: e.pointerId,
      start: i,
      last: i,
      moved: false,
      /* Decided here, from the first cell, and never revisited. A stroke that
         begins on a bull paints nothing — bulls are tap-only. */
      from: m === Game.M_DOT ? Game.M_DOT : Game.M_EMPTY,
      to: m === Game.M_DOT ? Game.M_EMPTY : Game.M_DOT,
      paints: m !== Game.M_BULL,
      applied: {},
      changes: [],
      lastSound: 0
    };
    try { boardEl.setPointerCapture(e.pointerId); } catch (err) { /* a nicety, not a requirement */ }
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var i = cellAt(e.clientX, e.clientY);
    if (i < 0 || i === drag.last) return;
    e.preventDefault();
    if (!drag.paints) { drag.moved = true; return; }
    /* The stroke only becomes a stroke once the pointer leaves its first cell.
       Until then it is still a tap, and a tap must be free to place a bull. */
    if (!drag.moved) { drag.moved = true; dragApply(drag.start); }
    dragTo(i);
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var d = drag;
    drag = null;
    try { boardEl.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!d.moved) { onCellTap(d.start); return; }
    if (!d.changes.length) return;
    Game.commitDrag(d.changes);   // the whole stroke, one undo
    renderPips();
    Game.save();
  }

  function onPointerCancel(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var d = drag;
    drag = null;
    if (d.changes.length) { Game.commitDrag(d.changes); renderPips(); Game.save(); }
  }

  function onCellTap(i) {
    Sound.unlock();
    clearHint();
    var rep = Game.cycle(i);
    if (!rep) return;
    paintCell(i, rep.to === Game.M_BULL);
    paintPens();
    renderPips();

    if (rep.to === Game.M_BULL) {
      if (rep.violations.length) {
        Sound.wrong();
        flash(rep.violations);
      } else {
        Sound.bull();
        if (rep.penDone >= 0) Sound.penDone();
      }
    } else if (rep.to === Game.M_DOT) {
      Sound.dot();
    }

    Game.save();
    if (Game.isSolved()) win();
  }

  /* Only the offending row / column / pen flashes — never the screen. */
  function flash(violations) {
    var cells = {};
    violations.forEach(function (v) { v.cells.forEach(function (c) { cells[c] = 1; }); });
    Object.keys(cells).forEach(function (c) {
      var el = cellEls[c];
      el.classList.remove("bad");
      void el.offsetWidth;
      el.classList.add("bad");
      setTimeout(function () { el.classList.remove("bad"); }, 400);
    });
  }

  /* ----------------------------------------------------------------- hint */

  /* THE way out. Every hint now dims the rest of the board, which is a much
     louder state than the old wash was — so it needs an explicit exit, or the
     only way back to a normal board is to make a move you may not want to make.
     The button, Escape, and any tap on the board all land here. */
  function dismissHint() {
    clearHint();
    $("hintbar").hidden = true;
  }

  function clearHint() {
    for (var i = 0; i < cellEls.length; i++) {
      cellEls[i].classList.remove("hinted", "hint-cover", "hint-cue", "hint-off");
    }
    var marks = $("hintmarks");
    if (marks) marks.innerHTML = "";
  }

  /* The cells of one unit the hint sentence named. Rows and columns are
     positional; a pen is whatever cells carry its id. */
  function unitCells(ref) {
    var out = [], i, N = Game.N;
    if (ref.kind === "row") { for (i = 0; i < N; i++) out.push(ref.n * N + i); return out; }
    if (ref.kind === "col") { for (i = 0; i < N; i++) out.push(i * N + ref.n); return out; }
    for (i = 0; i < N * N; i++) if (Game.pens[i] === ref.n) out.push(i);
    return out;
  }

  /* A triangle in the margin, pointing into the board at one line. The board
     itself clips to its rounded frame, so these live in a sibling layer over
     .pad's padding. Positioned by fraction rather than by measuring a cell, so
     they stay put through a rotation with no recalculation. */
  function markLine(kind, n, role) {
    var marks = $("hintmarks");
    if (!marks) return;
    var f = (n + 0.5) / Game.N;
    var b = BOARD_BORDER_PX;
    var pos = "calc(" + b + "px + (100% - " + (2 * b) + "px) * " + f + ")";
    [0, 1].forEach(function (side) {
      var t = document.createElement("i");
      t.className = "hm hm-" + kind + (role === "cover" ? " cover" : "");
      if (kind === "row") {
        t.style.top = pos;
        t.style[side ? "right" : "left"] = "-13px";
        t.textContent = side ? "◀" : "▶";
      } else {
        t.style.left = pos;
        t.style[side ? "bottom" : "top"] = "-13px";
        t.textContent = side ? "▲" : "▼";
      }
      marks.appendChild(t);
    });
  }

  /* Show, on the board, the pens and lines the explanation is talking about.
     Without this the harder hints ("pen 1 + pen 3 + pen 5 + pen 9 ...") are a
     wall of numbers the player has to hunt down by hand.

     The named units keep their TRUE pen colours and everything else is dimmed,
     rather than the named units being tinted: on a board where every cell is
     already coloured, "brighter than the rest" is the only emphasis that reads
     at a glance. Three steps — the units that still owe bulls, the units those
     bulls have to come out of, and the rest of the board — plus a triangle in
     the margin against every row and column named, so a line does not have to
     be counted out by hand. */
  function paintHintRefs(step) {
    var role = {}, i;

    (step.refs || []).forEach(function (ref) {
      var r = ref.role === "cover" ? "cover" : "focus";
      unitCells(ref).forEach(function (c) {
        if (role[c] !== "focus") role[c] = r;   // focus outranks cover on overlap
      });
      if (ref.kind === "row" || ref.kind === "col") markLine(ref.kind, ref.n, r);
    });

    /* The cells the hint is ABOUT are always lit, even when it named no unit at
       all — the trial sweep and the adjacency argument both work that way. */
    (step.cues || []).forEach(function (c) { role[c] = "focus"; cellEls[c].classList.add("hint-cue"); });
    (step.cells || []).forEach(function (c) { role[c.index] = "focus"; });

    /* A named cell is left ALONE — true pen colour, nothing painted over it.
       Every attempt to also "lift" it fought the player's own dots, which are
       drawn in the pen's own accent: the one treatment that widened the gap
       measurably also dropped a dot's contrast against its cell from 3.87 to
       3.0 on the dark ground. The separation comes from the veil, not from
       touching the thing being pointed at. */
    for (i = 0; i < cellEls.length; i++) {
      if (role[i] === "focus") continue;
      cellEls[i].classList.add(role[i] === "cover" ? "hint-cover" : "hint-off");
    }
  }

  /* The named units, listed under the sentence, in the same two shades — so
     "pen 3" in the text and the tinted cells on the board are visibly one thing. */
  function refLegend(step) {
    var refs = step.refs || [];
    if (!refs.length) return "";
    var seen = {}, out = [];
    refs.forEach(function (ref) {
      var key = ref.kind + ref.n;
      if (seen[key]) return;
      seen[key] = 1;
      out.push('<i class="' + (ref.role === "cover" ? "cover" : "focus") + '">' + ref.label + "</i>");
    });
    return '<span class="hintrefs">' + out.join("") + "</span>";
  }

  /* The hint is the SOLVER's next deduction, not a peek at the answer: it names
     the technique in plain language, gives the solver's own reason, and then
     makes that one move. */
  function doHint() {
    if (Game.paused || Game.won) return;
    Sound.unlock();
    clearHint();
    var step = Game.hint();
    var bar = $("hintbar"), text = $("hinttext");

    /* A wrong mark on the board beats any deduction: pointing at it is the
       only useful thing to say, and it still counts as a hint delivered. */
    if (step.reason === "wrong-mark") {
      Game.hints++;
      text.innerHTML = "<b>One of your marks is wrong</b>" + step.explain;
      bar.hidden = false;
      step.cells.forEach(function (c) { cellEls[c.index].classList.add("hinted"); });
      Sound.wrong();
      Game.save();
      return;
    }

    /* Nothing DEDUCED, but a trial pass would find something. Offer it rather
       than spending it: a trial is "test this cell and watch the board break
       four moves later", which is a machine's move, and being handed ten of
       them one at a time — each costing a star, none following from the last —
       is what made them read as noise. So the offer is free, it is the player's
       call, and taking it clears the whole sweep for a single hint. */
    if (step.reason === "trial-available") {
      text.innerHTML = "<b>Nothing simple is left</b>" + step.explain +
        '<span class="free">No hint used — your stars are safe.</span>' +
        '<button class="hintmore" id="btn-trial" type="button">' +
        "Show me what breaks · costs 1 hint</button>";
      bar.hidden = false;
      $("btn-trial").addEventListener("click", doTrialHint);
      return;
    }

    /* Nothing was delivered — never charge the counter for a no-op, and SAY so,
       so the player isn't left wondering whether she just spent a star on
       "nothing forced". */
    if (!step.found) {
      text.innerHTML = "<b>" + (step.reason === "contradiction" ? "Something's off" : "Nothing forced") +
        "</b>" + step.explain +
        '<span class="free">No hint used — your stars are safe.</span>';
      bar.hidden = false;
      if (step.reason === "contradiction") Sound.wrong();
      return;
    }

    deliver(step);
  }

  /* The accepted offer: one hint, every cell the trial sweep refutes. */
  function doTrialHint() {
    if (Game.paused || Game.won) return;
    Sound.unlock();
    clearHint();
    var step = Game.trialHint();
    var bar = $("hintbar"), text = $("hinttext");
    if (!step.found) {
      text.innerHTML = "<b>Nothing forced</b>" + step.explain +
        '<span class="free">No hint used — your stars are safe.</span>';
      bar.hidden = false;
      return;
    }
    deliver(step);
  }

  /* Charge one hint, say what it was, make the move(s) and light the board. */
  function deliver(step) {
    var bar = $("hintbar"), text = $("hinttext");
    Game.hints++;
    text.innerHTML = "<b>" + Game.techName(step.technique) + "</b>" + step.explain + refLegend(step);
    bar.hidden = false;
    paintHintRefs(step);

    /* One bell for the whole batch. The trial sweep can settle a dozen cells at
       once and a bell each would machine-gun. */
    var quiet = step.cells.length > 2, bell = null;
    step.cells.forEach(function (c) {
      var want = c.state === "BULL" ? Game.M_BULL : Game.M_DOT;
      var rep = Game.setMark(c.index, want);
      paintCell(c.index, want === Game.M_BULL);
      cellEls[c.index].classList.add("hinted");
      if (rep && rep.to === Game.M_BULL) bell = "bull";
      else if (!bell) bell = "dot";
      if (!quiet) { if (bell === "bull") Sound.bull(); else Sound.dot(); bell = null; }
    });
    if (quiet && bell) { if (bell === "bull") Sound.bull(); else Sound.dot(); }
    paintPens();
    renderPips();
    Game.save();
    if (Game.isSolved()) win();
  }

  /* ------------------------------------------------------------------ win */

  /* THE single win handler. Everything the meta-layer records comes through
     Game.recordWin(), which is called once, here, from MetaUI.showWin(). */
  Game.recordWin = function () {
    return Meta.recordWin({
      mode: Game.mode,
      tier: Game.tier,
      level: Game.level,
      dateKey: Game.dateKey,
      ms: Game.elapsedMs(),
      hints: Game.hints,
      mistakes: Game.mistakes,
      par: Game.par
    });
  };

  function win() {
    Game.pause();
    Game.won = true;
    stopTimer();
    hidePause();
    Game.dropSave();
    clearHint();

    // The bulls do a small wave, pen by pen, before the card arrives.
    var order = [];
    for (var i = 0; i < cellEls.length; i++) if (Game.marks[i] === Game.M_BULL) order.push(i);
    order.sort(function (a, b) { return (a % Game.N) - (b % Game.N) || a - b; });
    order.forEach(function (i, n) {
      setTimeout(function () { cellEls[i].classList.add("wave"); }, n * 55);
    });

    setTimeout(function () { MetaUI.showWin(); }, Math.min(900, order.length * 55 + 260));
  }

  /* ---------------------------------------------------------------- timer */

  function tickTimer(force) {
    var s = MetaUI.fmt(Game.elapsedMs());
    if (force || s !== lastTick) { lastTick = s; $("timer").textContent = s; }
  }
  function startTimer() {
    stopTimer();
    timerHandle = setInterval(function () { tickTimer(); }, 250);
  }
  function stopTimer() {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
  }

  /* --------------------------------------------------------------- wiring */

  function leaveGame(to) {
    Game.pause();
    stopTimer();
    Game.save();
    hidePause();
    MetaUI.show(to || "home");
  }

  function bind() {
    // ---- home
    $("btn-continue").addEventListener("click", function () {
      Sound.unlock();
      if (this.dataset.action === "resume") resumeSave();
      else startLevel(this.dataset.tier, +this.dataset.level);
    });
    $("tier-list").addEventListener("click", function (e) {
      var row = e.target.closest(".tierrow");
      if (!row) return;
      MetaUI.show("map", row.dataset.tier);
    });
    $("btn-daily").addEventListener("click", function () { MetaUI.show("daily"); });
    $("btn-calendar").addEventListener("click", function () { MetaUI.show("daily"); });
    $("btn-records").addEventListener("click", function () { MetaUI.show("records"); });
    $("btn-settings").addEventListener("click", function () { MetaUI.show("settings"); });
    $("btn-howto").addEventListener("click", openHowto);

    // ---- board: one pointer model handles tap AND drag-paint, so there is no
    //      separate click listener for the two of them to fight over.
    var bd = $("board");
    bd.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    bd.addEventListener("pointerdown", onPointerDown);
    bd.addEventListener("pointermove", onPointerMove);
    bd.addEventListener("pointerup", onPointerUp);
    bd.addEventListener("pointercancel", onPointerCancel);

    /* iOS double-tap zoom. `touch-action` and `user-scalable=no` are both
       ignored by Safari for this gesture; cancelling the touch default on a
       quick second tap is the only thing that actually works. Timing alone
       decides it — iOS zooms on two taps landing anywhere near each other.
       Scoped to the board and on touchend, so ordinary taps, swipes and
       pinch-zoom everywhere else still behave. `passive:false` because
       preventDefault is ignored on a passive listener. */
    var lastTouchEndAt = -Infinity;
    bd.addEventListener("touchend", function (e) {
      if (e.timeStamp - lastTouchEndAt <= ZOOM_SUPPRESS_MS) e.preventDefault();
      lastTouchEndAt = e.timeStamp;
    }, { passive: false });
    $("btn-map").addEventListener("click", function () {
      leaveGame();
      MetaUI.show("map", Game.mode === "level" ? Game.tier : MetaUI.mapTier);
    });
    $("btn-tohome").addEventListener("click", function () { leaveGame("home"); });
    $("btn-prev").addEventListener("click", function () {
      if (Game.level > 1) startLevel(Game.tier, Game.level - 1);
    });
    $("btn-next").addEventListener("click", function () {
      if (Game.level < Meta.tierDef(Game.tier).levels) startLevel(Game.tier, Game.level + 1);
    });
    $("btn-pause").addEventListener("click", pauseGame);
    $("btn-pause-resume").addEventListener("click", resumeGame);
    $("btn-pause-home").addEventListener("click", function () { leaveGame("home"); });
    $("btn-clear").addEventListener("click", function () {
      if (Game.paused) return;
      Sound.unlock(); clearHint();
      Game.clear(); renderBoard(); renderPips(); Game.save();
    });
    $("btn-undo").addEventListener("click", function () {
      if (Game.paused) return;
      Sound.unlock(); clearHint();
      var u = Game.undo();
      if (!u) return;
      if (u.bulk !== undefined) renderBoard();
      else if (u.cells) u.cells.forEach(function (c) { paintCell(c); });  // a whole drag, in one press
      else paintCell(u.cell);
      paintPens(); renderPips(); Game.save();
    });
    $("btn-hint").addEventListener("click", doHint);
    $("btn-hint-close").addEventListener("click", function () { Sound.unlock(); dismissHint(); });
    /* A physical keyboard is not the target, but Escape costs nothing and is
       what anyone playing on a desktop will try first. */
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && MetaUI.current === "game" && !$("hintbar").hidden) dismissHint();
    });

    // ---- map
    $("map-back").addEventListener("click", function () { MetaUI.show("home"); });
    $("map-tiers").addEventListener("click", function (e) {
      var c = e.target.closest(".chip");
      if (c) MetaUI.renderMap(c.dataset.tier);
    });
    $("map-pages").addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (b) MetaUI.renderMap({ page: +b.dataset.page });
    });
    $("map-grid").addEventListener("click", function (e) {
      var b = e.target.closest(".lvl");
      if (b && !b.disabled) startLevel(b.dataset.tier, +b.dataset.level);
    });

    // ---- daily
    $("daily-back").addEventListener("click", function () { MetaUI.show("home"); });
    $("btn-daily-play").addEventListener("click", function () { startDaily(this.dataset.date); });
    $("cal-grid").addEventListener("click", function (e) {
      var b = e.target.closest(".day");
      if (b && !b.disabled) startDaily(b.dataset.date);
    });

    // ---- records / settings
    $("records-back").addEventListener("click", function () { MetaUI.show("home"); });
    $("settings-back").addEventListener("click", function () { MetaUI.show("home"); });
    $("theme-list").addEventListener("click", function (e) {
      var b = e.target.closest(".themebtn");
      if (!b) return;
      Theme.apply(b.dataset.theme);
      MetaUI.renderSettings();
    });
    $("btn-mute").addEventListener("click", function () {
      Sound.setMuted(!Sound.muted);
      MetaUI.renderSettings();
    });
    $("btn-howto2").addEventListener("click", openHowto);
    $("btn-reset").addEventListener("click", function () {
      if (!window.confirm("Erase every level, star, record and streak? This cannot be undone.")) return;
      Meta.reset();
      Game.dropSave();
      MetaUI.show("home");
    });

    // ---- dialogs
    $("btn-howto-close").addEventListener("click", function () {
      $("dlg-howto").classList.remove("open");
    });
    $("btn-win-home").addEventListener("click", function () {
      MetaUI.hideWin();
      MetaUI.show("home");
    });
    $("btn-win-next").addEventListener("click", function () {
      MetaUI.hideWin();
      startLevel(this.dataset.tier, +this.dataset.level);
    });

    // ---- lifecycle: never lose a board to a backgrounded tab
    /* A backgrounded app comes back BEHIND the pause panel rather than into a
       running clock nobody is looking at yet. The player decides when play
       restarts; until she taps Resume the board stays covered and the timer
       stays where she left it. */
    document.addEventListener("visibilitychange", function () {
      if (MetaUI.current !== "game" || Game.won) return;
      if (document.hidden) { Game.pause(true); stopTimer(); Game.save(); }
      else showPause();
    });
    window.addEventListener("pagehide", function () {
      if (MetaUI.current === "game" && !Game.won) { Game.pause(true); stopTimer(); Game.save(); }
    });
    // Text selection and the iOS long-press callout have no place on a board.
    document.addEventListener("gesturestart", function (e) { e.preventDefault(); });
  }

  function openHowto() {
    $("dlg-howto").classList.add("open");
    try { localStorage.setItem("bullpen:seen-howto", "1"); } catch (e) {}
  }

  /* ----------------------------------------------------------------- boot */

  function boot() {
    Theme.init();
    bind();
    MetaUI.show("home");

    // First launch only — returning players never see it again.
    var seen = false;
    try { seen = localStorage.getItem("bullpen:seen-howto") === "1"; } catch (e) {}
    if (!seen) openHowto();

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function () {});
      });
    }
  }

  boot();

  return { startLevel: startLevel, startDaily: startDaily, resumeSave: resumeSave };
})();
