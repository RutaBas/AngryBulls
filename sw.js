"use strict";

/* BULLPEN — service worker. Cache-first app shell.

   Every shipped file is listed explicitly. Boards are rebuilt from their seed
   on the device, so once the shell is cached the game is fully playable with
   no network at all — campaign, daily and all.

   CACHE_VERSION must change whenever any listed file changes, or an installed
   app keeps serving the old build off disk forever. That used to be a hand-bumped
   counter and it was forgotten exactly once, which is once too many — so the
   value is now STAMPED from the contents of the files below by
   scripts/stamp-cache.js, run automatically by the pre-commit hook in
   .githooks/. Do not edit it by hand; run the script. The activate handler
   deletes every cache that is not the current one. */

var CACHE_VERSION = "bullpen-d8b0d502c708";

var PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  // the certified logic core, in load order
  "./js/rng.js",
  "./js/solver.js",
  "./js/generator.js",
  // the shared meta-layer, vendored by games/_shared/sync.js. A service worker
  // cannot serve ../_shared/, so these MUST be listed here or the meta-layer
  // 404s the moment the network goes away.
  "./js/meta/store.js",
  "./js/meta/rng.js",
  "./js/meta/progress.js",
  "./js/meta/daily.js",
  "./js/meta/records.js",
  "./js/meta/rank.js",
  "./js/meta/index.js",
  // the app layer — js/levels.js is the 4,000-level table and is what makes
  // offline campaign play possible at all.
  "./js/par.js",
  "./js/levels.js",
  "./js/meta-config.js",
  "./js/theme.js",
  "./js/sound.js",
  "./js/game.js",
  "./js/meta-ui.js",
  "./js/ui.js",
  // icons
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE_VERSION ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  // Google Fonts is a progressive enhancement; never let it block a load.
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req)
        .then(function (res) {
          if (res && res.ok && res.type === "basic") {
            var copy = res.clone();
            caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
          }
          return res;
        })
        .catch(function () {
          if (req.mode === "navigate") return caches.match("./index.html");
          return new Response("", { status: 504, statusText: "offline" });
        });
    })
  );
});
