"use strict";

/* BULLPEN — the service worker's cache version must match what it ships.
 *
 * The pre-commit hook in .githooks/ keeps this true automatically, but a hook
 * lives outside the repo's control: a fresh clone has core.hooksPath unset, and
 * --no-verify exists. So the invariant is asserted here too, where it travels
 * with the code.
 *
 * If this fails, the shipped files changed without the cache version changing —
 * which means an installed PWA will keep serving the OLD build off disk, no
 * matter how many times the site is rebuilt. That is precisely the bug that had
 * Ruta's phone playing a build two commits behind.
 *
 * Run: node games/bullpen/test/cache-stamp.test.js
 */

const fs = require("fs");
const path = require("path");
const stamp = require(path.join(__dirname, "..", "scripts", "stamp-cache.js"));

const SW = path.join(__dirname, "..", "sw.js");
const swText = fs.readFileSync(SW, "utf8");

let failures = 0;
function assert(name, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok || !detail ? "" : "  — " + detail));
  if (!ok) failures++;
}

console.log("\n--- service worker cache stamp ---");

const files = stamp.precachedFiles(swText);
assert("S.a sw.js declares a precache list", files.length > 5, files.length + " file(s)");

const missing = files.filter((rel) => !fs.existsSync(path.join(__dirname, "..", rel)));
assert("S.b every precached file exists (or it 404s the moment you go offline)",
  missing.length === 0, missing.join(", "));

const have = stamp.currentStamp(swText);
const want = stamp.stampFor(swText, false);
assert("S.c the cache version matches the bytes it ships", have === want,
  "is " + have + ", should be " + want + " — run: node scripts/stamp-cache.js");

/* The stamp is only useful if it is derived. A hand-written value would pass
   S.c exactly once and then rot, which is the whole history of this bug. */
assert("S.d the cache version is a content stamp, not a hand-typed counter",
  new RegExp("^" + stamp.PREFIX + "[0-9a-f]{12}$").test(have), have);

/* sw.js carries the hash, so hashing it could never converge. */
assert("S.e sw.js is not part of its own stamp", files.indexOf("sw.js") < 0);

console.log(failures === 0 ? "\nGREEN — cache stamp clean.\n" : "\nRED — " + failures + " failure(s).\n");
process.exit(failures === 0 ? 0 : 1);
