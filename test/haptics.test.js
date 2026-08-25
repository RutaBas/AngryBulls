"use strict";

/* BULLPEN — the haptics support window.
 *
 * Why this file exists:
 *
 *   Ruta asked for a buzz as she swipes. It shipped, and it did not buzz. The
 *   reason is not a bug in the app — it is that the only mechanism iOS has ever
 *   given a web page for haptics is a side effect of <input type=checkbox
 *   switch>, and Apple closed the SCRIPT-DRIVEN path in iOS 26.5. From 26.5 the
 *   haptic fires only for a genuine tap landing on a real switch, which a swipe
 *   never produces.
 *
 * So the app must not claim it can buzz when it cannot. The rule is a pure
 * function of the user-agent, and this pins it to real strings: the window is
 * [17.4, 26.5). Get the boundary wrong in either direction and the Settings row
 * lies to the player — either promising a buzz that never comes, or hiding one
 * that would have worked.
 *
 * Run: node games/bullpen/test/haptics.test.js
 */

const path = require("path");

/* haptics.js is a browser IIFE. It only touches document/navigator inside
   functions, and the two exported here are pure, so requiring it bare is safe.
   (It reads localStorage at load, in a try/catch — hence the stub.) */
global.localStorage = { getItem: () => null, setItem: () => {} };
const Haptics = require(path.join(__dirname, "..", "js", "haptics.js"));

let failures = 0;
function assert(name, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok || !detail ? "" : "  — " + detail));
  if (!ok) failures++;
}

const iphone = (v) =>
  "Mozilla/5.0 (iPhone; CPU iPhone OS " + v.replace(".", "_") +
  " like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1";

console.log("\n--- haptics: the iOS support window ---");

/* --- reading the version out of the string ---------------------------- */
assert("V.a an iPhone user-agent yields its version",
  Haptics._iosVersionOf(iphone("18.2")) === 18.2, String(Haptics._iosVersionOf(iphone("18.2"))));
assert("V.b a two-digit major is not truncated",
  Haptics._iosVersionOf(iphone("26.5")) === 26.5, String(Haptics._iosVersionOf(iphone("26.5"))));
assert("V.c a non-iOS agent yields nothing",
  Haptics._iosVersionOf("Mozilla/5.0 (Linux; Android 14) Chrome/120") === null);

/* --- the window ------------------------------------------------------- */
const allowed = (v) => Haptics._leverAllowed(iphone(v), "iPhone", 5, false);

assert("H.a iOS 17.3 is too early — the switch element did not exist", allowed("17.3") === false);
assert("H.b iOS 17.4 is the first version that works", allowed("17.4") === true);
assert("H.c iOS 18.2 works", allowed("18.2") === true);
assert("H.d iOS 26.4 is the last version that works", allowed("26.4") === true);
assert("H.e iOS 26.5 is patched and must NOT be promised", allowed("26.5") === false);
assert("H.f a version after the patch stays refused", allowed("27.1") === false);

/* --- everything else -------------------------------------------------- */
assert("H.g a desktop browser with no switch support is refused",
  Haptics._leverAllowed("Mozilla/5.0 (Windows NT 10.0) Chrome/120", "Win32", 0, false) === false);
assert("H.h an iPad reporting itself as MacIntel is still recognised as iOS",
  Haptics._leverAllowed("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.4 Safari/605.1",
                        "MacIntel", 5, false) === true,
  "iPadOS masquerades as a Mac; touch points give it away");
assert("H.i an unknown engine that DOES expose the switch property gets the benefit of the doubt",
  Haptics._leverAllowed("SomeFutureBrowser/1.0", "Unknown", 0, true) === true);

console.log(failures === 0 ? "\nGREEN — haptics window clean.\n" : "\nRED — " + failures + " failure(s).\n");
process.exit(failures === 0 ? 0 : 1);
