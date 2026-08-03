"use strict";
/* One IIFE per file — matches the logic core's module style. */
(function (root) {

/* BULLPEN — par times.

   Shared by the campaign (baked into js/levels.js at build time) and by the
   daily (computed live from the graded board), so the two can never disagree
   about what "under par" means.

   PAR IS DELIBERATELY FORGIVING. The star rule is:
       3 stars — clean solve (no hints, no mistakes) under par
       2 stars — clean solve, over par
       1 star  — solved
   so par is the ONLY thing standing between a careful player and three stars.
   A lost star should come from a hint or a mistake, never from thinking. The
   numbers below are therefore anchored to measured human solve times with a
   generous margin on top, NOT to the solver's `effort` figure — effort measures
   how much deduction a board contains, which correlates with, but is not, the
   time a person needs.

   Measured reference (unhurried play, no hints):
     Paddock   6x6  k=1   ~40-70s
     Pasture   8x8  k=1   ~90-160s
     Rangeland 9x9  k=2   ~3-6 min
     Badlands  10x10 k=2  ~5-12 min
   Par sits comfortably above the slow end of each of those bands, and ramps
   with the level's position in its tier so level 990 is allowed more time than
   level 10 of the same tier. */

const BANDS = {
  paddock:   { lo: 100000, hi:  240000 },   // 1:40 -> 4:00
  pasture:   { lo: 220000, hi:  520000 },   // 3:40 -> 8:40
  rangeland: { lo: 480000, hi:  960000 },   // 8:00 -> 16:00
  badlands:  { lo: 720000, hi: 1560000 }    // 12:00 -> 26:00
};

/* ratio: where the level sits in its tier's difficulty ramp, 0 (easiest) to
   1 (hardest). Rounded to whole seconds so the win screen never shows a par
   with a stray fraction. */
function parMs(tierKey, ratio) {
  const b = BANDS[tierKey] || BANDS.rangeland;
  const p = Math.max(0, Math.min(1, ratio || 0));
  return Math.round((b.lo + (b.hi - b.lo) * p) / 1000) * 1000;
}

/* The daily has no ramp position — it is one board, graded on the spot. Its
   effort is mapped through the same effort band the build measured for that
   tier (baked into js/levels.js), so a hard daily gets a hard board's par. */
function parFromEffort(tierKey, effort, band) {
  if (!band || !(band.hi > band.lo)) return parMs(tierKey, 0.5);
  const r = (effort - band.lo) / (band.hi - band.lo);
  return parMs(tierKey, r);
}

const API = { parMs, parFromEffort, BANDS };

root.BullpenPar = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
