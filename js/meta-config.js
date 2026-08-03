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
  meta.sizeLabel = function (tierKey) {
    var d = DEFS[tierKey];
    return d ? d.N + "×" + d.N + " · " + d.k + " bull" + (d.k > 1 ? "s" : "") : "";
  };
  meta.labelOf = function (tierKey) {
    var d = DEFS[tierKey];
    return LADDER[tierKey] + (d ? " · " + d.N + "×" + d.N : "");
  };

  /* A campaign level is three baked numbers: seed, effort, par. */
  meta.levelRow = function (tierKey, n) {
    var rows = LEVELS[tierKey];
    var r = rows && rows[n - 1];
    return r ? { seed: r[0], effort: r[1], par: r[2], genTier: DEFS[tierKey].gen } : null;
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
      N: def.N, k: def.k,
      seed: BullpenGenerator.dailySeed(plan.dateKey, plan.tier)
    };
  };

  meta.parForEffort = function (tierKey, effort) {
    var d = DEFS[tierKey];
    return BullpenPar.parFromEffort(tierKey, effort, { lo: d.effortLo, hi: d.effortHi });
  };

  return meta;
})();
