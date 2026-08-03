"use strict";

/* BULLPEN — sound. Set 2, "Soft Bell", chosen at the design gate.

   "A quiet room and a small brass bell." FM-synthesised brass bells with a
   gentle decay; nothing ships as an audio asset, so the app stays a few
   hundred KB and works offline with no extra cache entries.

   iOS will not start an AudioContext without a user gesture, so nothing is
   created until the first tap. Mute is persisted; haptics fire regardless of
   it, because they are the same feedback channel by another route. */

var Sound = (function () {

  var ctx = null;
  var muted = false;
  try { muted = localStorage.getItem("bullpen:muted") === "1"; } catch (e) {}

  function AC() {
    if (!ctx) {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  /* Unlocked on the first gesture anywhere in the app. */
  function unlock() { if (!muted) AC(); }

  /* --- primitives (lifted from design-sound.html) ----------------------- */

  function tone(o) {
    var c = AC(); if (!c) return;
    var t0 = c.currentTime + (o.at || 0);
    var osc = c.createOscillator(), g = c.createGain();
    var dur = o.dur || 0.18, decay = o.decay || dur;
    osc.type = o.type || "sine";
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.glide) osc.frequency.exponentialRampToValueAtTime(o.glide, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(o.gain === undefined ? 0.22 : o.gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    osc.connect(g).connect(c.destination);
    osc.start(t0); osc.stop(t0 + decay + 0.05);
  }

  function fm(o) {
    var c = AC(); if (!c) return;
    var t0 = c.currentTime + (o.at || 0);
    var dur = o.dur || 0.4;
    var car = c.createOscillator(), mod = c.createOscillator();
    var mg = c.createGain(), g = c.createGain();
    car.frequency.value = o.freq;
    mod.frequency.value = o.freq * (o.ratio === undefined ? 2.4 : o.ratio);
    mg.gain.value = o.index === undefined ? 180 : o.index;
    mod.connect(mg).connect(car.frequency);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(o.gain === undefined ? 0.2 : o.gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    car.connect(g).connect(c.destination);
    mod.start(t0); car.start(t0);
    mod.stop(t0 + dur + 0.05); car.stop(t0 + dur + 0.05);
  }

  /* --- haptics ---------------------------------------------------------- */

  function buzz(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} }
  }

  /* --- the moments, exactly as tabled in the design brief --------------- */

  var S = {
    get muted() { return muted; },
    setMuted: function (v) {
      muted = !!v;
      try { localStorage.setItem("bullpen:muted", muted ? "1" : "0"); } catch (e) {}
    },
    unlock: unlock,

    dot: function () {
      if (!muted) tone({ freq: 1320, dur: 0.05, type: "sine", gain: 0.09 });
    },
    bull: function () {
      if (!muted) fm({ freq: 660, ratio: 1.8, index: 120, dur: 0.3, gain: 0.2 });
      buzz(8);
    },
    wrong: function () {
      if (!muted) fm({ freq: 180, ratio: 1.41, index: 90, dur: 0.34, gain: 0.16 });
      buzz(20);
    },
    penDone: function () {
      if (muted) return;
      fm({ freq: 880, ratio: 2, index: 80, dur: 0.34, gain: 0.16 });
      fm({ freq: 1320, ratio: 2, index: 70, dur: 0.44, gain: 0.14, at: 0.11 });
    },
    /* One star landing on the win screen — the same bell, a step higher each
       time, so three stars read as a rising figure. */
    star: function (i) {
      if (!muted) fm({ freq: [784, 988, 1175][i] || 784, ratio: 2, index: 90, dur: 0.5, gain: 0.15 });
      buzz(10);
    },
    win: function () {
      if (!muted) {
        [523, 659, 784, 1047].forEach(function (f, i) {
          fm({ freq: f, ratio: 2, index: 110, dur: 0.85, gain: 0.18, at: i * 0.13 });
        });
        fm({ freq: 1568, ratio: 3, index: 60, dur: 1.5, gain: 0.1, at: 0.55 });
      }
      buzz([12, 60, 12, 60, 24]);
    }
  };

  return S;
})();
