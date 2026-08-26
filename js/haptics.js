"use strict";

/* BULLPEN — haptics.

   Two mechanisms, because iOS and everything else need different things, and
   the difference is not cosmetic.

     vibrate   navigator.vibrate. Android and desktop Chrome. Fires from script,
               so it can tick per cell as a stroke paints.

     overlay   iOS. WebKit has never shipped the Vibration API, and the ONLY
               thing that makes an iPhone tap back is the system haptic played
               when a real <input type="checkbox" switch> is operated. It has to
               be operated by an actual finger: driving one from script used to
               work, Apple closed that in iOS 26.5, and on Ruta's iOS 18.7 it
               never produced anything either — tested side by side, a real tap
               on a switch buzzed and a scripted click on one did not.

               So on iOS there is no tick() at all. Instead ui.js lays a real
               switch over every cell and the finger lands on it directly. That
               buys TAPS ONLY: a swipe is one continuous touch, so there is no
               per-cell activation to hang a haptic on, and per-cell buzzing
               while painting is simply not possible on this platform.

   The setting still governs both — on iOS by making the overlay untouchable, so
   nothing can fire, rather than by intercepting a tick that never happens. */

var Haptics = (function () {

  var KEY = "bullpen:haptics";
  var MIN_GAP_MS = 40;

  var enabled = true;
  try {
    var saved = localStorage.getItem(KEY);
    if (saved !== null) enabled = saved === "1";
  } catch (e) {}

  var canVibrate = typeof navigator !== "undefined" &&
                   typeof navigator.vibrate === "function";

  /* iPadOS reports itself as a Mac, so touch points are what give it away. */
  function looksIOS(ua, platform, touchPoints) {
    return /iP(hone|ad|od)/.test(ua || "") ||
           (platform === "MacIntel" && touchPoints > 1);
  }

  /* Which mechanism this device gets. Deliberately NOT version-gated any more:
     the overlay is a real tap on a real control, which is the one path Apple
     has left alone across every version that has the switch element at all. */
  function modeFor(ua, platform, touchPoints, vibrates) {
    if (vibrates) return "vibrate";
    if (looksIOS(ua, platform, touchPoints)) return "overlay";
    return "none";
  }

  var mode = "none";
  try {
    mode = modeFor(typeof navigator !== "undefined" ? navigator.userAgent : "",
                   typeof navigator !== "undefined" ? navigator.platform : "",
                   typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0,
                   canVibrate);
  } catch (e) {}

  var last = 0;

  /* A tick per painted cell — vibrate only. On iOS this is a no-op by design:
     there is nothing script can play, and pretending otherwise is what wasted a
     week. Throttled, or a fast flick machine-guns. */
  function tick() {
    if (!enabled || mode !== "vibrate") return false;
    var now = Date.now();
    if (now - last < MIN_GAP_MS) return false;
    last = now;
    try { navigator.vibrate(8); return true; } catch (e) { return false; }
  }

  return {
    tick: tick,
    /* Exported for test/haptics.test.js. */
    _modeFor: modeFor,
    get enabled() { return enabled; },
    get mode() { return mode; },
    /* True where anything at all can be felt. On iOS that means taps; the UI
       layer says which, because only it knows the difference matters. */
    get supported() { return mode !== "none"; },
    get tapsOnly() { return mode === "overlay"; },
    setEnabled: function (v) {
      enabled = !!v;
      try { localStorage.setItem(KEY, enabled ? "1" : "0"); } catch (e) {}
      if (enabled) { last = 0; tick(); }
    }
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Haptics;
