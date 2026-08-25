"use strict";

/* The meta-layer screens: home, level map, daily calendar, records, settings
   and the win screen.

   Kept separate from ui.js, which owns the board — rendering cells and handling
   taps is a different job from rendering progression, and mixing the two is how
   a 600-line UI file becomes a 1,600-line one. ui.js calls exactly three things
   here: MetaUI.show() to route, MetaUI.showWin() on a solve, and
   MetaUI.renderHome() after a save changes. Nothing in this file computes
   progression itself — every number comes from Meta (js/meta/). */

var MetaUI = (function () {

  function $(id) { return document.getElementById(id); }

  var SCREENS = ["home", "game", "map", "daily", "records", "settings"];
  var current = "home";
  var mapTier = "paddock";
  var mapPage = 0;
  var PAGE = 100;

  /* --- formatting -------------------------------------------------------- */

  function fmt(ms) {
    var t = Math.floor((ms || 0) / 1000);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
  }
  function fmtDelta(ms) { return "−" + fmt(ms); }

  function pips3(n) {
    var out = "";
    for (var i = 0; i < 3; i++) out += '<i class="' + (i < n ? "on" : "") + '"></i>';
    return '<span class="pips3">' + out + "</span>";
  }

  /* --- routing ----------------------------------------------------------- */

  function show(name, arg) {
    SCREENS.forEach(function (s) {
      var el = $("screen-" + s);
      if (el) el.classList.toggle("on", s === name);
    });
    current = name;
    if (name === "home") renderHome();
    if (name === "map") renderMap(arg);
    if (name === "daily") renderDaily(arg);
    if (name === "records") renderRecords();
    if (name === "settings") renderSettings();
    var el = $("screen-" + name);
    if (el && el.scrollTo) el.scrollTo(0, 0);
  }

  /* --- home -------------------------------------------------------------- */

  /* The stock-plan watermark: a fixed 7x7 pen map drawn as boundaries only. */
  var PLAN = ["AABBBCC", "AABBCCC", "ADDBCEE", "DDDEEEE", "DFFFEEG", "FFFGGGG", "FFGGGGG"];

  function renderPlan() {
    var host = $("home-plan");
    if (host.children.length) return;
    var html = "";
    for (var r = 0; r < 7; r++) {
      for (var c = 0; c < 7; c++) {
        var pen = PLAN[r][c];
        var bR = c === 6 || PLAN[r][c + 1] !== pen;
        var bB = r === 6 || PLAN[r + 1][c] !== pen;
        html += '<i style="border-right:' + (bR ? 2.5 : 0.5) + "px solid var(--rule);border-bottom:" +
          (bB ? 2.5 : 0.5) + 'px solid var(--rule)"></i>';
      }
    }
    host.innerHTML = html;
  }

  /* The pen colour each tier row is filled with — one per tier, in the order
     the brief's preview used them. */
  var TIER_PEN = { paddock: 3, pasture: 2, rangeland: 0, badlands: 1 };

  function renderHome() {
    renderPlan();
    var h = Meta.home();

    /* The primary slot belongs to the two dailies. A half-finished board gets
       a slim Continue row under them; with no save the row disappears rather
       than showing a dead button. */
    ["easy", "hard"].forEach(function (track) {
      var d = Meta.dailyTrack(track);
      var plan = d.plan();
      var st = d.currentStreak();
      var entry = d.entry(plan.dateKey);
      $("daily-" + track + "-fire").textContent = "🔥 " + st.streak;
      $("daily-" + track + "-sub").textContent =
        Meta.gridLabel(plan.tier) + " · " + Meta.ladder[plan.tier];
      var val = $("daily-" + track + "-val");
      if (entry) {
        var pips = "";
        for (var i = 0; i < 3; i++) {
          pips += '<span class="' + (i < (entry.stars || 0) ? "" : "off") + '">★</span>';
        }
        val.innerHTML = fmt(entry.ms) + ' <span class="pips">' + pips + "</span>";
      } else {
        val.textContent = "Play";
      }
      $("btn-daily-" + track).dataset.date = plan.dateKey;
    });

    // The date lives once, in the header's calendar link, not in both cards.
    var todayKey = Meta.daily.plan().dateKey;
    $("btn-cal-link").textContent =
      MONTHS[+todayKey.slice(5, 7) - 1].slice(0, 3) + " " + (+todayKey.slice(8)) + " · Calendar ›";

    var saved = Game.hasSave() ? Game.savedContext() : null;
    var cont = $("btn-continue");
    cont.hidden = !saved;
    if (saved) {
      $("continue-sub").textContent = saved.mode === "daily"
        ? "Daily " + Meta.trackLabel(Meta.trackOfTier(saved.tier)) + " · " + saved.dateKey
        : Meta.ladder[saved.tier] + " · level " + saved.level;
    }

    // Tier rows, each in its own pen pastel, ascending.
    var host = $("tier-list");
    host.innerHTML = "";
    h.tiers.forEach(function (t) {
      var st = Meta.progress.tierState(t.key);
      var cleared = 0;
      Object.keys(st.levels).forEach(function (k) { if (st.levels[k].plays) cleared++; });

      var el = document.createElement("button");
      el.type = "button";
      el.className = "tierrow" + (t.unlocked ? "" : " locked");
      el.dataset.tier = t.key;
      el.style.background = "var(--p" + TIER_PEN[t.key] + "f)";

      var right;
      if (t.unlocked) {
        right = cleared + "/" + t.levels;
      } else {
        var gate = t.gate && t.gate[0];
        right = "🔒 " + (gate ? gate.have + "/" + gate.need : "locked");
      }
      el.innerHTML =
        '<span class="nm">' + Meta.ladder[t.key] + "</span>" +
        '<span class="mt">' + Meta.sizeLabel(t.key) + "</span>" +
        '<span class="pg">' + right + "</span>";
      host.appendChild(el);
    });

  }

  /* --- level map --------------------------------------------------------- */

  /* 1,000 levels per tier is unusable as a flat list, so the map is paged into
     hundreds and opens on the page holding the player's furthest level. */
  function renderMap(arg) {
    var autoPage = true;
    if (typeof arg === "string") {
      mapTier = arg;
      mapPage = Math.floor((Meta.progress.nextLevel(mapTier) - 1) / PAGE);
    } else if (arg && typeof arg === "object") {
      if (arg.tier) mapTier = arg.tier;
      autoPage = arg.page === undefined;
      mapPage = autoPage
        ? Math.floor((Meta.progress.nextLevel(mapTier) - 1) / PAGE) : arg.page;
    }
    var key = mapTier;
    var def = Meta.tierDef(key);
    var open = Meta.progress.isTierUnlocked(key);

    $("map-name").textContent = Meta.ladder[key];

    var rows = Meta.progress.mapFor(key);
    var cleared = 0, stars = 0;
    rows.forEach(function (r) { if (r.played) cleared++; stars += r.stars; });
    $("map-sub").textContent =
      Meta.sizeLabel(key) + " · " + cleared + " of " + def.levels + " cleared · " + stars + "★";

    // tier chips
    var chips = $("map-tiers");
    chips.innerHTML = "";
    Meta.tiers.forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (t.key === key ? " on" : "") +
        (Meta.progress.isTierUnlocked(t.key) ? "" : " locked");
      b.dataset.tier = t.key;
      b.textContent = Meta.ladder[t.key];
      chips.appendChild(b);
    });

    // The gate reads as PROGRESS, not a wall.
    var gate = Meta.progress.tierGate(key);
    var gEl = $("map-gate");
    if (gate && gate.length) {
      var g = gate[0];
      var pct = Math.min(100, Math.round((g.have / g.need) * 100));
      gEl.innerHTML =
        "<b>" + Meta.ladder[key] + "</b> opens at " + g.need + " levels cleared. You're at <b>" +
        g.have + "</b> — " + (g.need - g.have) + " to go." +
        '<span class="bar"><i style="width:' + pct + '%"></i></span>';
      gEl.hidden = false;
    } else {
      gEl.hidden = true;
    }

    // page strip
    var pages = Math.ceil(def.levels / PAGE);
    var strip = $("map-pages");
    strip.innerHTML = "";
    for (var p = 0; p < pages; p++) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = p === mapPage ? "on" : "";
      b.dataset.page = p;
      b.textContent = (p * PAGE + 1) + "–" + Math.min(def.levels, (p + 1) * PAGE);
      strip.appendChild(b);
    }

    var grid = $("map-grid");
    grid.innerHTML = "";
    var from = mapPage * PAGE;
    rows.slice(from, from + PAGE).forEach(function (r) {
      var el = document.createElement("button");
      el.type = "button";
      var cur = r.unlocked && !r.played;
      el.className = "lvl" + (r.played ? " done" : "") + (cur ? " cur" : "") + (r.unlocked ? "" : " locked");
      el.disabled = !r.unlocked;
      el.dataset.level = r.level;
      el.dataset.tier = key;
      el.innerHTML = '<span class="n">' + r.level + "</span>" + pips3(r.stars);
      grid.appendChild(el);
    });

    // Scroll the current page button into view without moving the whole screen.
    var on = strip.querySelector(".on");
    if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest", inline: "center" });

    // Jump straight to the next level to play, so opening a tier never lands
    // the player at level 1 of a page they have mostly cleared. Deferred a
    // frame because show() resets the screen's scroll after this render, and
    // skipped when the player picked a page themselves.
    if (autoPage) {
      var cur = grid.querySelector(".cur");
      if (cur && cur.scrollIntoView) setTimeout(function () {
        cur.scrollIntoView({ block: "center" });
      }, 0);
    }
    if (!open) { /* rows are already disabled by mapFor's unlocked flag */ }
  }

  /* --- daily ------------------------------------------------------------- */

  var MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];

  function renderFreezes(host, count) {
    var out = "";
    for (var i = 0; i < 3; i++) out += '<i class="' + (i < count ? "on" : "") + '"></i>';
    host.innerHTML = out;
  }

  var dailyTrack = "easy";

  function renderDaily(track) {
    if (track === "easy" || track === "hard") dailyTrack = track;
    var d = Meta.dailyTrack(dailyTrack);
    var other = Meta.dailyTrack(dailyTrack === "hard" ? "easy" : "hard");
    var cal = d.calendar();
    var otherCal = other.calendar();
    var plan = d.plan();
    var solvedToday = d.isSolved(plan.dateKey);
    var streak = d.currentStreak();
    var solvedCount = cal.days.filter(function (x) { return x.solved; }).length;

    $("daily-tracks").querySelectorAll(".chip").forEach(function (c) {
      c.classList.toggle("on", c.dataset.track === dailyTrack);
    });

    $("daily-month").textContent =
      MONTHS[cal.month] + " " + cal.year + " · " + solvedCount + " of " + cal.days.length + " solved";
    $("daily-play-main").textContent = solvedToday ? "Replay today" : "Play today";
    $("daily-play-sub").textContent =
      Meta.trackLabel(dailyTrack) + " · " + Meta.labelOf(plan.tier);
    $("btn-daily-play").dataset.date = plan.dateKey;

    $("daily-streak-n").textContent = streak.streak;
    $("daily-streak-lab").textContent = "day streak · best " + d.state.best;
    renderFreezes($("daily-freezes"), streak.freezes);

    var head = $("cal-head");
    if (!head.children.length) {
      ["S", "M", "T", "W", "T", "F", "S"].forEach(function (d) {
        var e = document.createElement("div");
        e.className = "dow"; e.textContent = d;
        head.appendChild(e);
      });
    }

    var grid = $("cal-grid");
    grid.innerHTML = "";
    for (var p = 0; p < cal.days[0].dow; p++) grid.appendChild(document.createElement("span"));
    cal.days.forEach(function (x, i) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "day" + (x.solved ? " solved" : "") + (x.isToday ? " today" : "") +
        (x.playable ? "" : " future");
      el.disabled = !x.playable;
      el.dataset.date = x.dateKey;
      // Both tracks' marks on every day: the fill is the selected track, the
      // two dots under the number are Easy then Hard, so a glance shows what
      // the OTHER track still has open without switching chips.
      var easySolved = dailyTrack === "easy" ? x.solved : otherCal.days[i].solved;
      var hardSolved = dailyTrack === "hard" ? x.solved : otherCal.days[i].solved;
      el.innerHTML = '<span class="n">' + x.dom + "</span>" +
        '<span class="dots"><i class="' + (easySolved ? "on" : "") + '"></i>' +
        '<i class="' + (hardSolved ? "on" : "") + '"></i></span>';
      if (x.solved) el.title = fmt(x.ms);
      grid.appendChild(el);
    });
  }

  /* --- records ----------------------------------------------------------- */

  function renderRecords() {
    var host = $("records-list");
    host.innerHTML = "";
    Meta.tiers.forEach(function (t) {
      var r = Meta.records.get(t.key);
      var trend = Meta.records.trend(t.key);
      var el = document.createElement("div");
      el.className = "rec";
      el.innerHTML =
        '<div class="rechead"><span class="nm">' + Meta.ladder[t.key] + "</span>" +
        '<span class="sz">' + Meta.sizeLabel(t.key) + "</span></div>" +
        '<div class="recstats">' +
          "<span><b>" + (r.bestMs ? fmt(r.bestMs) : "—") + "</b>best</span>" +
          "<span><b>" + (r.avgMs ? fmt(r.avgMs) : "—") + "</b>average</span>" +
          "<span><b>" + r.wins + "</b>solved</span>" +
        "</div>" +
        (trend.enough
          ? '<div class="trend">Lately you\'re ' + fmt(Math.abs(trend.trendMs)) + " " +
            (trend.improving ? "faster" : "slower") + " than you used to be</div>"
          : '<div class="trend">Solve a few more to see a trend</div>');
      host.appendChild(el);
    });

    var de = Meta.dailyTrack("easy").stats();
    var dh = Meta.dailyTrack("hard").stats();
    $("records-daily").innerHTML =
      "<b>Daily Easy</b> · " + de.solved + " solved · streak " + de.streak +
      " (best " + de.best + ") · fastest " + (de.bestMs ? fmt(de.bestMs) : "—") + "<br>" +
      "<b>Daily Hard</b> · " + dh.solved + " solved · streak " + dh.streak +
      " (best " + dh.best + ") · fastest " + (dh.bestMs ? fmt(dh.bestMs) : "—");
  }

  /* --- settings ---------------------------------------------------------- */

  function renderSettings() {
    var host = $("theme-list");
    host.innerHTML = "";
    Object.keys(Theme.THEMES).forEach(function (k) {
      var t = Theme.THEMES[k];
      var b = document.createElement("button");
      b.type = "button";
      b.className = "themebtn" + (Theme.current === k ? " on" : "");
      b.dataset.theme = k;
      b.innerHTML = '<i style="background:' + t.swatch + '"></i>' + t.label;
      host.appendChild(b);
    });
    $("mute-state").textContent = Sound.muted ? "Off" : "On";
    /* Say "Unavailable" rather than "Off" where the device cannot buzz at all.
       An off-looking switch that does nothing when you press it is worse than
       no switch. */
    $("haptics-state").textContent = !Haptics.supported ? (Haptics.why || "Unavailable")
      : Haptics.enabled ? "On" : "Off";
    $("btn-haptics").disabled = !Haptics.supported;
    var tot = Meta.progress.totals();
    $("about-line").textContent =
      "BULLPEN · " + tot.clearedCount + " levels cleared · " + tot.totalStars + " stars. " +
      "Boards are generated on your device and verified unique by the solver.";
  }

  /* --- win --------------------------------------------------------------- */

  var lastResult = null;

  /* The solved image, first in the hierarchy: the board that was just won,
     pens and all, at whatever size fits. */
  function drawWinBoard() {
    var N = Game.N;
    var host = $("winboard");
    var px = Math.max(8, Math.min(15, Math.floor(150 / N)));
    host.style.gridTemplateColumns = "repeat(" + N + ", " + px + "px)";
    var html = "";
    for (var i = 0; i < N * N; i++) {
      var p = Game.pens[i] % 10;
      html += '<i class="' + (Game.solution[i] ? "b" : "") + '" style="width:' + px + "px;height:" + px +
        "px;background:var(--p" + p + 'f)"></i>';
    }
    host.innerHTML = html;
  }

  function confetti() {
    var host = $("confetti");
    var html = "";
    for (var i = 0; i < 44; i++) {
      var p = i % 10;
      var dur = (2.2 + Math.random() * 1.8).toFixed(2);
      html += '<i style="left:' + (Math.random() * 100).toFixed(1) + "%;background:var(--p" + p +
        "f);animation-duration:" + dur + "s;animation-delay:" + (Math.random() * 1.2).toFixed(2) +
        "s;width:" + (6 + Math.random() * 5).toFixed(0) + 'px"></i>';
    }
    host.innerHTML = html;
    setTimeout(function () { host.innerHTML = ""; }, 6000);
  }

  function showWin() {
    // THE single integration point: one call hands the solve to the meta-layer.
    var res = Game.recordWin();
    lastResult = res;
    var stars = res.stars || 0;
    var isReview = !!res.alreadySolved;

    drawWinBoard();

    var stEls = $("win-stars").children;
    for (var i = 0; i < 3; i++) stEls[i].classList.remove("on", "land");

    $("win-word").textContent = isReview ? "Penned again" : "Penned!";
    if (Game.mode === "level") {
      $("win-sub").textContent = Meta.ladder[Game.tier] + " · Level " + Game.level;
    } else if (Game.mode === "daily") {
      $("win-sub").textContent =
        "Daily " + Meta.trackLabel(Meta.trackOfTier(Game.tier)) + " · " + Game.dateKey;
    } else {
      $("win-sub").textContent = "Free play · " + Game.N + "×" + Game.N;
    }

    var ms = Game.elapsedMs();
    $("win-time").textContent = fmt(ms);

    if (Game.mode === "daily") {
      $("win-mid-k").textContent = "Streak";
      $("win-mid-v").textContent = (res.daily ? res.daily.streak : 0) + "d";
    } else {
      $("win-mid-k").textContent = "Par";
      $("win-mid-v").textContent = Game.par ? fmt(Game.par) : "—";
    }

    var bestEl = $("win-best");
    if (res.records && res.records.isNewBest && res.records.deltaMs) {
      $("win-best-k").textContent = "Best";
      bestEl.textContent = fmtDelta(res.records.deltaMs);
    } else if (res.records && res.records.isNewBest) {
      $("win-best-k").textContent = "Best";
      bestEl.textContent = "first";
    } else if (res.records) {
      $("win-best-k").textContent = "Your best";
      bestEl.textContent = res.records.bestMs ? fmt(res.records.bestMs) : "—";
    } else {
      $("win-best-k").textContent = "Your best";
      bestEl.textContent = "—";
    }

    // The rank badge — the only saturated block on the screen.
    var rank = $("win-rank");
    if (res.rankPercentile) {
      rank.textContent = res.rankPercentile.label.toUpperCase() + " · " +
        Meta.ladder[Game.tier].toUpperCase();
      rank.hidden = false;
    } else {
      rank.hidden = true;
    }

    // A note only when there is something worth saying.
    var msg = "";
    if (isReview) {
      msg = "You already solved this one; nothing was recorded again.";
    } else if (res.progress && res.progress.unlockedTiers.length) {
      msg = Meta.ladder[res.progress.unlockedTiers[0]] + " unlocked.";
    } else if (Game.hints || Game.mistakes) {
      var bits = [];
      if (Game.hints) bits.push(Game.hints + " hint" + (Game.hints > 1 ? "s" : ""));
      if (Game.mistakes) bits.push(Game.mistakes + " mistake" + (Game.mistakes > 1 ? "s" : ""));
      msg = bits.join(" and ") + " — a clean solve is worth more.";
    } else if (stars === 2 && Game.par) {
      msg = "Clean solve. Under " + fmt(Game.par) + " earns the third.";
    } else if (Game.mode === "daily") {
      msg = "Daily streak " + (res.daily ? res.daily.streak : 0) + " day" +
        ((res.daily && res.daily.streak) === 1 ? "" : "s") + ".";
    }
    $("win-note").textContent = msg;

    // Next button
    var next = $("btn-win-next");
    if (Game.mode === "level" && Game.level < Meta.tierDef(Game.tier).levels) {
      next.hidden = false;
      next.dataset.tier = Game.tier;
      next.dataset.level = Game.level + 1;
      $("btn-win-home").parentNode.classList.remove("one");
    } else {
      next.hidden = true;
      $("btn-win-home").parentNode.classList.add("one");
    }

    $("dlg-win").classList.add("open");
    confetti();
    Sound.win();

    // Stars land ONE AT A TIME — the moment the meta-layer either feels earned
    // or feels like a popup.
    if (stars) {
      var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      for (var s = 0; s < stars; s++) {
        (function (k) {
          setTimeout(function () {
            stEls[k].classList.add("on", "land");
            Sound.star(k);
          }, reduced ? 0 : 480 + k * 300);
        })(s);
      }
    }
  }

  function hideWin() { $("dlg-win").classList.remove("open"); }

  return {
    show: show,
    showWin: showWin,
    hideWin: hideWin,
    renderHome: renderHome,
    renderMap: renderMap,
    renderSettings: renderSettings,
    fmt: fmt,
    get dailyTrack() { return dailyTrack; },
    get current() { return current; },
    get mapTier() { return mapTier; },
    get lastResult() { return lastResult; }
  };
})();
