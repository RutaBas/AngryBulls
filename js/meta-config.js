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

  /* TWO dailies a day, at fixed sizes, instead of a tier that rotates by
     weekday. A rotating tier made "the daily" unpredictable from the home
     screen; a fixed Easy and a fixed Hard are each a consistent ritual, and
     each keeps its own streak. Easy inherits the original daily's store key,
     so pre-split history and streaks carry into the Easy track. */
  var TRACK_TIER = { easy: "paddock", hard: "rangeland" };

  var meta = GameMeta.create({
    id: "bullpen",
    prefix: "bull",
    tiers: tiers,
    curves: curves,
    daily: {
      tier: TRACK_TIER.easy,
      freezes: { max: 3, earnEvery: 7 },
      firstDay: "2026-07-01"
    }
  });

  /* The Hard track: same Daily machinery, its own store key, its own streak
     and freezes. Starts fresh — old solves stay with Easy. */
  meta.daily2 = new GameMeta.Daily({
    store: meta.store,
    key: "daily2",
    tier: TRACK_TIER.hard,
    freezes: { max: 3, earnEvery: 7 },
    firstDay: "2026-07-01",
    starsFor: GameMeta.Progress.defaultStars
  });

  /* A tier that grows (Rangeland went 1000 -> 2000) must not strand a player
     who had already finished its old last level: recordWin never unlocks past
     the tier's level count, so they sat at unlocked=1000 with 1001 locked. If
     the highest unlocked level is already cleared, open the next one. Stars,
     bests and plays are keyed by level number and are never touched here. */
  (function extendUnlocks() {
    var changed = false;
    tiers.forEach(function (def) {
      var t = meta.progress.state.tiers[def.key];
      if (!t || !t.levels || !t.unlocked) return;
      var top = t.levels[t.unlocked];
      if (top && top.plays && t.unlocked < def.levels) { t.unlocked += 1; changed = true; }
    });
    if (changed) meta.progress.save();
  })();

  meta.trackTier = TRACK_TIER;
  meta.dailyTrack = function (track) { return track === "hard" ? meta.daily2 : meta.daily; };
  /* The save file and win context carry only the tier, so the track is derived
     from it rather than stored — the two tracks use different tiers. */
  meta.trackOfTier = function (tierKey) { return tierKey === TRACK_TIER.hard ? "hard" : "easy"; };
  meta.trackLabel = function (track) { return track === "hard" ? "Hard" : "Easy"; };

  /* recordWin routes daily solves by tier: the library instance only knows the
     Easy track, so a Hard solve is recorded here through the same steps the
     library takes (streak, records, rank), against the Hard instance. */
  var baseRecordWin = meta.recordWin;
  meta.recordWin = function (ctx) {
    if (ctx && ctx.mode === "daily" && meta.trackOfTier(ctx.tier) === "hard") {
      var out = {
        mode: "daily", tier: ctx.tier, level: 0,
        ms: ctx.ms || 0, hints: ctx.hints || 0, mistakes: ctx.mistakes || 0
      };
      out.daily = meta.daily2.record(ctx.dateKey, ctx);
      out.stars = out.daily.stars;
      out.alreadySolved = out.daily.alreadySolved;
      if (!out.alreadySolved) {
        out.records = meta.records.record(ctx.tier, ctx.ms);
        out.rankPercentile = meta.rank.percentile(ctx.tier, ctx.ms);
        meta.rank.submit({
          mode: "daily", tier: ctx.tier, dateKey: ctx.dateKey,
          ms: ctx.ms, stars: out.stars, hints: ctx.hints, mistakes: ctx.mistakes
        });
      }
      return out;
    }
    return baseRecordWin(ctx);
  };

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
  meta.dailyPuzzle = function (dateKey, track) {
    var plan = meta.dailyTrack(track).plan(dateKey);
    var def = DEFS[plan.tier];
    return {
      dateKey: plan.dateKey,
      day: plan.day,
      tier: plan.tier,
      track: meta.trackOfTier(plan.tier),
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
