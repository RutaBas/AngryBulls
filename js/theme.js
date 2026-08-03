"use strict";

/* BULLPEN — themes.

   Four grounds, exactly as signed off: Cream (default), Pale Mint, Rosé and
   Dark. The pen pastels are shared by the three light grounds; Dark swaps in
   the darkened set with LIGHT dots and horns so a bull still reads as a light
   mark on a dark pen, and inverts the rule to warm cream.

   Every colour is published as a CSS custom property on <html>, so switching
   theme recolours a rendered board with no re-render at all — the cells only
   ever refer to var(--p3f) / var(--p3d). */

var Theme = (function () {

  /* Pen 0-5 are the brief's table verbatim; 6-9 extend the ramp with further
     muted pastels at the same lightness, so a 10-pen Badlands board never has
     a pen that reads as "the loud one". */
  var LIGHT_PENS = [
    { fill: "#F7CBC7", dot: "#CF6A62" },
    { fill: "#E0D6F0", dot: "#8877B8" },
    { fill: "#FAE2BA", dot: "#DDA13F" },
    { fill: "#D6E9D2", dot: "#6E9E68" },
    { fill: "#CBDFF2", dot: "#4E86B5" },
    { fill: "#FFFDF7", dot: "#B08A5A" },
    { fill: "#F2D8C4", dot: "#C4834F" },
    { fill: "#DCEAE6", dot: "#5E9186" },
    { fill: "#EDDCEC", dot: "#A86FA3" },
    { fill: "#E4E7C8", dot: "#8A9440" }
  ];
  var DARK_PENS = [
    { fill: "#7C4247", dot: "#F0AFA9" },
    { fill: "#544A73", dot: "#C4B6E8" },
    { fill: "#7A6136", dot: "#F0CE8A" },
    { fill: "#3F5F44", dot: "#A8D3A2" },
    { fill: "#3C5670", dot: "#9FC7E8" },
    { fill: "#5B5148", dot: "#DCC49C" },
    { fill: "#75503A", dot: "#E8B78C" },
    { fill: "#3D5C57", dot: "#9CCFC5" },
    { fill: "#5F4260", dot: "#D6A7D0" },
    { fill: "#4E5A38", dot: "#C3D08A" }
  ];

  /* Rosé deepens the rose pen so it still separates from its own ground. */
  var ROSE_PENS = LIGHT_PENS.slice();
  ROSE_PENS[0] = { fill: "#F0B7B2", dot: "#B5544C" };

  var THEMES = {
    cream: {
      label: "Cream", swatch: "#F3EAD6",
      bg: "#F3EAD6", card: "#FBF5E8", chip: "#E7DCC2", rule: "#6E2639", ink: "#6E2639",
      face: "#ffffff", bullink: "#4a1b28", pens: LIGHT_PENS, dark: false
    },
    mint: {
      label: "Pale Mint", swatch: "#D6EBDB",
      bg: "#D6EBDB", card: "#EDF7EF", chip: "#C4E0CB", rule: "#6E2639", ink: "#6E2639",
      face: "#ffffff", bullink: "#4a1b28", pens: LIGHT_PENS, dark: false
    },
    rose: {
      label: "Rosé", swatch: "#F6DCDE",
      bg: "#F6DCDE", card: "#FDEFF0", chip: "#EDC9CD", rule: "#6E2639", ink: "#6E2639",
      face: "#ffffff", bullink: "#4a1b28", pens: ROSE_PENS, dark: false
    },
    dark: {
      label: "Dark", swatch: "#241018",
      bg: "#241018", card: "#33191F", chip: "#3E1F27", rule: "#EFDFC6", ink: "#F2E6D4",
      face: "#EFE2CE", bullink: "#2A1218", pens: DARK_PENS, dark: true
    }
  };

  var KEY = "bullpen:theme";
  var current = "cream";

  function apply(key) {
    var t = THEMES[key] || THEMES.cream;
    current = THEMES[key] ? key : "cream";
    var s = document.documentElement.style;
    s.setProperty("--bg", t.bg);
    s.setProperty("--card", t.card);
    s.setProperty("--chip", t.chip);
    s.setProperty("--rule", t.rule);
    s.setProperty("--ink", t.ink);
    s.setProperty("--face", t.face);
    s.setProperty("--bullink", t.bullink);
    for (var i = 0; i < t.pens.length; i++) {
      s.setProperty("--p" + i + "f", t.pens[i].fill);
      s.setProperty("--p" + i + "d", t.pens[i].dot);
    }
    document.documentElement.setAttribute("data-theme", current);
    document.documentElement.classList.toggle("is-dark", !!t.dark);
    var meta = document.getElementById("meta-theme");
    if (meta) meta.setAttribute("content", t.bg);
    try { localStorage.setItem(KEY, current); } catch (e) {}
  }

  function init() {
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) {}
    apply(saved || "cream");
  }

  return {
    THEMES: THEMES,
    apply: apply,
    init: init,
    get current() { return current; },
    penFill: function (p) { return "var(--p" + (p % 10) + "f)"; },
    penDot: function (p) { return "var(--p" + (p % 10) + "d)"; }
  };
})();
