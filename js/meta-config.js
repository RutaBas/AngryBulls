"use strict";

/* Mounts the shared meta-layer for BULLPEN.

   Everything game-specific about progression lives here; nothing else in the
   game knows how stars, streaks, gates or ranks are computed. The library in
   js/meta/ is vendored from games/_shared/meta and is never edited. */

var Meta = (function () {

  /* The Yard ladder. Names come from the signed-off brief; sizes and levels
     come from the baked table, so the two can never drift apart. */
  var LADDER = {
    paddock:   "Paddock",
    pasture:   "Pasture",
    rangeland: "Rangeland",
    badlands:  "Badlands"
  };

  var LEVELS = window.BULLPEN_LEVELS;
  var DEFS = {};
  window.BULLPEN_TIERS.forEach(function (t) { DEFS[t.key] = t; });

  var tiers = window.BULLPEN_TIERS.map(function (t) {
    return {
      key: t.key,
      name: LADDER[t.key],
      levels: t.levels,
      /* Par is baked per level by scripts/build-levels.js (js/par.js decides
         the number), so the tier's par function just reads the row. */
      par: function (n) {
        var row = LEVELS[t.key][n - 1];
        return row ? row[2] : 0;
      },
      /* Badlands is the gated tier — 150 levels cleared anywhere opens it. */
      requires: t.key === "badlands" ? { cleared: 150 } : null
    };
  });

  /* Percentile curves.

     There is no backend, so these are a modelled distribution rather than
     measured data, and they say so: the breakpoints are par-relative, which
     makes the badge mean "fast for this board" instead of pretending to be a
     real population. When a leaderboard exists, rank.js swaps the source and
     nothing here changes. */
  function curveFor(tierKey) {
    var rows = LEVELS[tierKey];
    if (!rows || !rows.length) return [];
    var mid = 0;
    for (var i = 0; i < rows.length; i++) mid += rows[i][2];
    mid = mid / rows.length;
    return [
      [Math.round(mid * 0.30), 3],
      [Math.round(mid * 0.50), 12],
      [Math.round(mid * 0.75), 30],
      [Math.round(mid * 1.00), 50],
      [Math.round(mid * 1.45), 75],
      [Math.round(mid * 2.30), 94]
    ];
  }

  var curves = {};
  tiers.forEach(function (t) { curves[t.key] = curveFor(t.key); });

  /* The daily rotates the tier by weekday — a short one on Monday, the big
     board at the weekend. UTC weekday, matching daily.js's day boundary.
     Badlands appears on Saturday whether or not the campaign gate is open:
     the daily is a taste of the hard end, not a reward for grinding. */
  var DAILY_BY_DOW = ["rangeland", "paddock", "pasture", "pasture", "rangeland", "rangeland", "badlands"];

  var meta = GameMeta.create({
    id: "bullpen",
    prefix: "bull",
    tiers: tiers,
    curves: curves,
    daily: {
      freezes: { max: 3, earnEvery: 7 },
      firstDay: "2026-07-01",
      plan: function (day, dateKey) {
        var d = new Date(day * 86400000);
        return { day: day, dateKey: dateKey, tier: DAILY_BY_DOW[d.getUTCDay()], index: day };
      }
    }
  });

  /* --- game-specific helpers layered on top ------------------------------ */

  meta.ladder = LADDER;
  meta.defOf = function (tierKey) { return DEFS[tierKey]; };

  /* A tier is NOT one grid size any more. Paddock mixes 6×6 and 7×7 boards, so
     every size shown to the player is derived from the tier definition rather
     than printed from a single `N`. Several shapes of tier data are accepted —
     `sizes` / `Ns` (an array) or a plain `N` — because the level table that
     supplies them is owned elsewhere; whichever it ships, the label follows it.
     Nothing here may ever grow a literal "6×6": that is exactly the bug this
     replaces. */
  function sizesOf(def) {
    if (!def) return [];
    var raw = def.sizes || def.Ns || def.N;
    var list = (Object.prototype.toString.call(raw) === "[object Array]") ? raw : [raw];
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var n = +list[i];
      if (!n || seen[n]) continue;
      seen[n] = 1; out.push(n);
    }
    return out.sort(function (a, b) { return a - b; });
  }

  /* "6×6", "6×6 & 7×7", "6×6–9×9" — a mixed tier says so instead of lying
     about half its levels. Three or more sizes collapse to a range so the home
     row can't outgrow its width at 390px. */
  function gridLabel(tierKey) {
    var s = sizesOf(DEFS[tierKey]);
    var sq = function (n) { return n + "×" + n; };
    if (!s.length) return "";
    if (s.length === 1) return sq(s[0]);
    if (s.length === 2) return sq(s[0]) + " & " + sq(s[1]);
    return sq(s[0]) + "–" + sq(s[s.length - 1]);
  }

  meta.sizesOf = sizesOf;
  meta.gridLabel = gridLabel;

  meta.sizeLabel = function (tierKey) {
    var d = DEFS[tierKey];
    if (!d) return "";
    return gridLabel(tierKey) + " · " + d.k + " bull" + (d.k > 1 ? "s" : "");
  };
  meta.labelOf = function (tierKey) {
    var g = gridLabel(tierKey);
    return LADDER[tierKey] + (g ? " · " + g : "");
  };

  /* A campaign level is three baked numbers: seed, effort, par — and, once a
     tier mixes grid sizes, optionally a FOURTH naming that level's own gen
     tier. A mixed Paddock cannot be built from one tier-wide gen key, so if the
     table ships a per-row key it wins; a plain 3-tuple still falls back to the
     tier's. Only a string is accepted, so a fourth number meaning something
     else entirely can never be mistaken for a gen key. */
  meta.levelRow = function (tierKey, n) {
    var rows = LEVELS[tierKey];
    var r = rows && rows[n - 1];
    if (!r) return null;
    var gen = (typeof r[3] === "string" && r[3]) || DEFS[tierKey].gen;
    return { seed: r[0], effort: r[1], par: r[2], genTier: gen };
  };

  /* The daily is NOT a campaign level — reusing one would spoil it for whoever
     hasn't reached it yet. It gets its own seed from the date, via the
     generator's own dailySeed(). Par is computed live from the graded board
     through the same js/par.js the build script used, so campaign and daily
     agree about what "under par" means. */
  meta.dailyPuzzle = function (dateKey) {
    var plan = meta.daily.plan(dateKey);
    var def = DEFS[plan.tier];
    return {
      dateKey: plan.dateKey,
      day: plan.day,
      tier: plan.tier,
      genTier: def.gen,
      /* Advisory only — the board's real N comes back from the generator. On a
         mixed-size tier `def.N` may be absent, so fall back to the tier's
         smallest declared size rather than reporting undefined. */
      N: def.N || sizesOf(def)[0], k: def.k,
      seed: BullpenGenerator.dailySeed(plan.dateKey, plan.tier)
    };
  };

  meta.parForEffort = function (tierKey, effort) {
    var d = DEFS[tierKey];
    return BullpenPar.parFromEffort(tierKey, effort, { lo: d.effortLo, hi: d.effortHi });
  };

  return meta;
})();
