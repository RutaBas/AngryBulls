"use strict";

/* BULLPEN — haptics.

   A short tick under the finger as a stroke paints each cell. Mirrors js/sound.js:
   one flag, persisted, off-switch in Settings, and every entry point is a no-op
   when it is off.

   TWO BACKENDS, because the obvious one does not exist on the device this was
   asked for:

     navigator.vibrate   Android, and desktop Chrome with a phone attached.
                         NOT implemented in ANY iOS browser — every one of them
                         is WebKit, and WebKit has never shipped the Vibration
                         API. Calling it on an iPhone is silently ignored, so a
                         haptics feature built on it alone would do nothing at
                         all on the only device Ruta plays this on.

     the switch trick    iOS 17.4+ plays the system's light haptic when a
                         <input type="checkbox" switch> is toggled by a click.
                         Driving a hidden one is currently the only way for a
                         web page to make an iPhone tap back. It is a quirk of
                         the engine and not a standard: a future WebKit could
                         take it away, and older iOS never had it. When it is
                         not there the app is simply silent, which is why
                         `supported` is reported honestly to Settings rather
                         than assumed.

   Everything is throttled: a fast flick crosses a dozen cells, and a dozen
   buzzes in a quarter second is a phone screaming, not feedback. */

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

  /* The hidden switch, built once and only where it might do something. Kept
     out of the layout and out of the accessibility tree: it is a noise-maker,
     not a control, and a screen reader announcing a stray checkbox on the board
     screen would be a real bug. */
  var lever = null;
  function buildLever() {
    if (lever || typeof document === "undefined") return lever;
    var label = document.createElement("label");
    label.setAttribute("aria-hidden", "true");
    label.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none";
    var box = document.createElement("input");
    box.type = "checkbox";
    box.setAttribute("switch", "");
    box.tabIndex = -1;
    label.appendChild(box);
    (document.body || document.documentElement).appendChild(label);
    lever = label;
    return lever;
  }

  /* Two ways to believe the lever might work, either of which is enough:

       1. Safari 17.4+ reflects `switch` as a property on the element, so this
          is real feature detection where it is available.
       2. Failing that, the device merely LOOKS like an iPhone or iPad. iPadOS
          reports itself as "MacIntel" with touch points, hence the second half.

     Permissive on purpose. Clicking a hidden checkbox on a device that has no
     idea what a switch is does nothing whatsoever — no error, no side effect —
     so guessing wrong costs nothing, while guessing too strictly would leave
     the feature dead on the exact device it was asked for. */
  function canLever() {
    if (typeof document === "undefined" || typeof navigator === "undefined") return false;
    var box = document.createElement("input");
    box.type = "checkbox";
    if (typeof box.switch === "boolean") return true;
    var ua = navigator.userAgent || "";
    return /iP(hone|ad|od)/.test(ua) ||
           (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  var useLever = false;
  try { useLever = !canVibrate && canLever(); } catch (e) {}

  var supported = canVibrate || useLever;
  var last = 0;

  /* One tick, at most every MIN_GAP_MS. Never throws: a device that refuses the
     call must not take the stroke down with it. */
  function tick() {
    if (!enabled || !supported) return false;
    var now = Date.now();
    if (now - last < MIN_GAP_MS) return false;
    last = now;
    try {
      if (canVibrate) {
        navigator.vibrate(8);
      } else {
        var l = buildLever();
        if (l) l.click();
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    tick: tick,
    get enabled() { return enabled; },
    get supported() { return supported; },
    /* Which backend answered, for the Settings line and for a bug report that
       starts "the buzzing does not work on my phone". */
    get backend() { return canVibrate ? "vibrate" : useLever ? "switch" : "none"; },
    setEnabled: function (v) {
      enabled = !!v;
      try { localStorage.setItem(KEY, enabled ? "1" : "0"); } catch (e) {}
      /* Confirm the change with the thing being changed. */
      if (enabled) { last = 0; tick(); }
    }
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Haptics;
