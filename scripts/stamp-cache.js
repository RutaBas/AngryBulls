"use strict";

/* BULLPEN — stamp the service worker's cache version.
 *
 * The bug this exists to stop coming back:
 *
 *   Ruta's phone kept playing an old build. sw.js is cache-first, so an
 *   installed PWA serves js/ui.js and css/style.css off disk until
 *   CACHE_VERSION changes. Two commits shipped changes to both files and left
 *   the constant at "bullpen-v4", so no amount of rebuilding Pages could reach
 *   her — and nothing anywhere failed to say so.
 *
 * The fix is to stop asking a human to remember. CACHE_VERSION is now DERIVED:
 * it is a hash of the contents of every file sw.js precaches, so any change to
 * any shipped file changes the version by construction, and a change that
 * cannot affect the shipped bytes does not.
 *
 * Run:
 *   node scripts/stamp-cache.js            rewrite sw.js from the working tree
 *   node scripts/stamp-cache.js --check    exit 1 if the stamp is stale
 *   node scripts/stamp-cache.js --staged   read the INDEX, not the working tree
 *                                          (what the pre-commit hook wants: the
 *                                          stamp must describe what is actually
 *                                          being committed)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SW = path.join(ROOT, "sw.js");
const PREFIX = "bullpen-";

/* The list of shipped files lives in sw.js and nowhere else, so read it from
   there rather than keeping a second copy that can fall out of step. */
function precachedFiles(swText) {
  const block = swText.match(/var PRECACHE = \[([\s\S]*?)\];/);
  if (!block) throw new Error("could not find the PRECACHE array in sw.js");
  const out = [];
  for (const m of block[1].matchAll(/"([^"]+)"/g)) {
    const rel = m[1].replace(/^\.\//, "");
    // "./" is the navigation entry; index.html is listed separately and is the
    // thing that actually has bytes.
    if (!rel) continue;
    out.push(rel);
  }
  return out.sort();
}

function readStaged(rel) {
  return execFileSync("git", ["show", ":" + rel], { cwd: ROOT, maxBuffer: 1 << 28 });
}

/* Hash the shipped bytes. sw.js is deliberately NOT part of this: it is what
   carries the hash, so including it could not converge. */
function stampFor(swText, staged) {
  const h = crypto.createHash("sha256");
  const missing = [];
  for (const rel of precachedFiles(swText)) {
    let buf;
    try {
      buf = staged ? readStaged(rel) : fs.readFileSync(path.join(ROOT, rel));
    } catch (e) {
      missing.push(rel);
      continue;
    }
    h.update(rel).update("\0").update(buf).update("\0");
  }
  if (missing.length) {
    /* A precached file that does not exist is a 404 waiting to happen the first
       time the network goes away, so it is a hard error, not a warning. */
    throw new Error("sw.js precaches file(s) that are not there: " + missing.join(", "));
  }
  return PREFIX + h.digest("hex").slice(0, 12);
}

function currentStamp(swText) {
  const m = swText.match(/var CACHE_VERSION = "([^"]+)"/);
  if (!m) throw new Error("could not find CACHE_VERSION in sw.js");
  return m[1];
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const staged = args.includes("--staged");

  // The PRECACHE list itself must come from the same place as the bytes.
  const swText = staged ? readStaged("sw.js").toString("utf8") : fs.readFileSync(SW, "utf8");
  const want = stampFor(swText, staged);
  const have = currentStamp(swText);

  if (have === want) {
    if (!check) console.log("cache version already current: " + have);
    return 0;
  }

  if (check) {
    console.error(
      "STALE cache version in sw.js.\n" +
      "  is:     " + have + "\n" +
      "  should: " + want + "\n" +
      "An installed PWA will keep serving the OLD files until this changes.\n" +
      "Fix: node scripts/stamp-cache.js"
    );
    return 1;
  }

  /* Always rewrite the file on disk, even under --staged: the hook re-adds it,
     so the working tree and the index end up agreeing. */
  const onDisk = fs.readFileSync(SW, "utf8");
  fs.writeFileSync(SW, onDisk.replace(currentStamp(onDisk), want));
  console.log("cache version " + have + " -> " + want);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { stampFor, currentStamp, precachedFiles, PREFIX };
