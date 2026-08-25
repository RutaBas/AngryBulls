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

     the switch trick    iOS 17.4 to 26.4 plays the system's light haptic when
                         a <input type="checkbox" switch> is toggled by clicking
                         its LABEL — clicking the input directly does nothing,
                         WebKit only emits on the label path. Driving a hidden
                         one was the only way a web page could make an iPhone
                         tap back.

                         APPLE CLOSED IT IN iOS 26.5. From there the haptic
                         fires only for a GENUINE tap that lands on a real
                         switch (isTrusted), not for anything script triggers.
                         That kills this feature specifically, because a swipe
                         is not a series of taps: there is no real tap per cell
                         to hang a haptic on. A tap-to-mark buzz would still be
                         possible by putting a switch under every cell; a
                         swipe-to-paint buzz is not possible at all.

                         So the version is checked, and Settings says
                         "Unavailable" rather than showing an On switch that
                         cannot do anything. Discovered the hard way: this
                         shipped, and Ruta reported it did not buzz.

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
    /* RENDERED, not collapsed. The first version of this was width:0;height:0
       with overflow:hidden, which is a fair way to hide a thing and a bad way
       to hide THIS one: a control with no box may never be laid out, and the
       haptic is a side effect of WebKit actually operating a switch. So it is
       given a real size and pushed off-screen instead — the shape every working
       implementation of this trick uses. */
    /* No pointer-events:none, and not fully transparent. The element is parked
       off-screen so it can never intercept a touch anyway, which is all
       pointer-events was buying — and both of those are ways of telling WebKit
       "this control is not really interactive", which is the one thing it must
       not conclude about the control whose interactivity IS the feature. */
    label.style.cssText = "position:fixed;left:-200px;top:0;width:44px;height:26px;" +
                          "opacity:0.01;-webkit-tap-highlight-color:transparent";
    var box = document.createElement("input");
    box.type = "checkbox";
    box.setAttribute("switch", "");
    box.tabIndex = -1;
    label.appendChild(box);
    (document.body || document.documentElement).appendChild(label);
    lever = label;
    return lever;
  }

  /* "iPhone OS 26_5" -> 26.5, or null where there is no such thing to read. */
  function iosVersionOf(ua) {
    var m = /(?:iPhone )?OS (\d+)[._](\d+)/.exec(ua || "");
    return m ? parseFloat(m[1] + "." + m[2]) : null;
  }
  function iosVersion() { return iosVersionOf(navigator.userAgent); }

  /* Is the script-driven haptic available here? Only inside the window where
     WebKit both HAD the behaviour and had not yet closed it: 17.4 up to but not
     including 26.5.

     Permissive when the version cannot be read at all — an unknown WebKit gets
     the attempt, since clicking a hidden checkbox on a device that does not
     know what a switch is has no effect whatsoever. Never permissive about a
     version we CAN read and know is patched: that would be promising a buzz
     the device will not give. */
  var LEVER_MIN = 17.4, LEVER_PATCHED = 26.5;

  /* THE RULE, as a pure function of what the browser says about itself, so it
     can be tested against real user-agent strings without a DOM in the way.
     `reflects` is whether this engine exposes the `switch` property, which is
     genuine feature detection where it exists. */
  function leverAllowed(ua, platform, touchPoints, reflects) {
    var looksIOS = /iP(hone|ad|od)/.test(ua || "") ||
                   (platform === "MacIntel" && touchPoints > 1);
    if (!looksIOS && !reflects) return false;
    var v = iosVersionOf(ua);
    if (v === null) return looksIOS || !!reflects;
    return v >= LEVER_MIN && v < LEVER_PATCHED;
  }

  function canLever() {
    if (typeof document === "undefined" || typeof navigator === "undefined") return false;
    var box = document.createElement("input");
    box.type = "checkbox";
    return leverAllowed(navigator.userAgent, navigator.platform,
                        navigator.maxTouchPoints, typeof box.switch === "boolean");
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
    /* Exported for test/haptics.test.js — the version window is the whole point
       of this module and the only part with a right and a wrong answer. */
    _leverAllowed: leverAllowed,
    _iosVersionOf: iosVersionOf,
    get enabled() { return enabled; },
    get supported() { return supported; },
    /* Which backend answered, for the Settings line and for a bug report that
       starts "the buzzing does not work on my phone". */
    get backend() { return canVibrate ? "vibrate" : useLever ? "switch" : "none"; },
    /* For the Settings diagnostics line: what this browser told us about itself. */
    get iosVersion() { return iosVersion(); },
    /* Why it is off, in words, for the Settings line — "Unavailable" alone
       invites the reasonable guess that the app forgot to implement it. */
    get why() {
      if (canVibrate || useLever) return "";
      var v = iosVersion();
      if (v !== null && v >= LEVER_PATCHED) return "iOS " + v + " blocks it";
      if (v !== null && v < LEVER_MIN) return "needs iOS 17.4+";
      return "not supported here";
    },
    setEnabled: function (v) {
      enabled = !!v;
      try { localStorage.setItem(KEY, enabled ? "1" : "0"); } catch (e) {}
      /* Confirm the change with the thing being changed. */
      if (enabled) { last = 0; tick(); }
    }
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Haptics;
