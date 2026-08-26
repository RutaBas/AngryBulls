"use strict";

/* BULLPEN — which haptic mechanism a device gets.
 *
 * Why this file exists, and why it was rewritten once already:
 *
 *   Ruta asked for a buzz as she swipes. It shipped and did nothing. iOS has
 *   never had the Vibration API; the only thing that makes an iPhone tap back
 *   is the system haptic WebKit plays when a real <input type="checkbox"
 *   switch> is operated — and it has to be operated by a FINGER. Driving one
 *   from script produced nothing on her iOS 18.7, proven side by side: a real
 *   tap on a switch buzzed, a scripted click on one did not.
 *
 *   The first version of this test pinned a version window for the scripted
 *   trick, [17.4, 26.5), which turned out to be beside the point — the scripted
 *   path does not work inside that window either. A switch laid under the
 *   finger is a different mechanism, and is not version-gated at all.
 *
 * The rule now: vibrate where the API exists, overlay on iOS, nothing else.
 * The distinction matters to the UI, because overlay means TAPS ONLY — a swipe
 * is one continuous touch and never operates a switch, so per-cell buzzing
 * while painting cannot be done on iOS by any means.
 *
 * Run: node games/bullpen/test/haptics.test.js
 */

const path = require("path");

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

const mode = (ua, platform, touch, vibrates) =>
  Haptics._modeFor(ua, platform, touch, vibrates);

console.log("\n--- haptics: which mechanism a device gets ---");

assert("M.a Android, which has the real API, ticks from script",
  mode("Mozilla/5.0 (Linux; Android 14) Chrome/120", "Linux", 5, true) === "vibrate");

assert("M.b an iPhone gets the overlay, not a scripted tick",
  mode(iphone("18.7"), "iPhone", 5, false) === "overlay");

/* No version window any more, on purpose. The scripted trick is what Apple
   patched in 26.5, and it did not work on 18.7 either. A real tap on a real
   switch is a different mechanism and is not gated. */
assert("M.c iOS 26.5, where the SCRIPTED trick is patched, still gets the overlay",
  mode(iphone("26.5"), "iPhone", 5, false) === "overlay");

assert("M.d old iOS gets it too — a tap is a tap",
  mode(iphone("17.4"), "iPhone", 5, false) === "overlay");

assert("M.e an iPad calling itself a Mac is still an iPad",
  mode("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.4 Safari/605.1",
       "MacIntel", 5, false) === "overlay",
  "iPadOS masquerades as a Mac; touch points give it away");

assert("M.f a real Mac is not an iPad",
  mode("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.4 Safari/605.1",
       "MacIntel", 0, false) === "none");

assert("M.g a desktop browser with neither gets nothing",
  mode("Mozilla/5.0 (Windows NT 10.0) Firefox/120", "Win32", 0, false) === "none");

/* The scriptable one wins where both are possible: it can tick DURING a stroke,
   and the overlay can only ever answer a tap. */
assert("M.h where both are possible the scriptable one wins",
  mode(iphone("18.7"), "iPhone", 5, true) === "vibrate");

console.log(failures === 0
  ? "\nGREEN — haptics mechanism clean.\n"
  : "\nRED — " + failures + " failure(s).\n");
process.exit(failures === 0 ? 0 : 1);
