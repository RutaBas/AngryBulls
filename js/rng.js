"use strict";
/* One IIFE per logic file — matches STRATA's module style. */
(function (root) {

/* Seeded PRNG (mulberry32) — the same algorithm as games/_shared/meta/rng.js,
   re-stated locally so BULLPEN's js/ directory has no cross-game dependency.
   Seeds therefore behave identically across the two: mulberry32(s) here and
   there produce the same stream, and hashSeed() is the same FNV-1a + murmur3
   avalanche, so a string seed maps to the same number in both.

   Every random choice the generator makes flows through one of these streams,
   so a (tier, seed) pair fully reproduces a board. */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* FNV-1a, then a murmur3 finalising avalanche. Raw counters fed straight into
   mulberry32 give neighbouring seeds visibly similar boards; the avalanche is
   what makes "bullpen|hard|47" and "…|48" diverge completely. */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/* Alias kept for parity with STRATA's rng.js, which calls it hashString. */
const hashString = hashSeed;

/* Accepts a number (used directly) or a string (hashed first). */
function makeRng(seedOrString) {
  const s = typeof seedOrString === "number" ? seedOrString >>> 0 : hashSeed(seedOrString);
  return mulberry32(s);
}

function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

function randInt(rng, n) {
  return (rng() * n) | 0;
}

/* Fisher-Yates using a supplied rng(). Mutates and returns the array. */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

const API = { mulberry32, hashSeed, hashString, makeRng, randomSeed, randInt, shuffle };

root.BullpenRng = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
