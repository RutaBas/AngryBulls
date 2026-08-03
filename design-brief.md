# BULLPEN — design brief

Status: **✅ DESIGN GATE SIGNED OFF — both rounds complete. UI may be built.**

Ruta asked to match the real App Store game rather than pick an invented direction. Everything
below is settled:

| Decision | Choice |
|---|---|
| Look | Faithful match to the real Bullpen app, built from original assets |
| Ladder | **Yard** — Paddock · Pasture · Rangeland · Badlands |
| Default theme | **Cream** `#F3EAD6` (Pale Mint, Rosé and Dark also ship as selectable themes) |
| Extra beyond the original | **A dark theme** (the real app is light-only) |
| Home screen | **Variant B with horizontal tier rows** — pen-plan watermark background |
| Sound set | **2 · Soft Bell** — FM brass bells, warm and round, shimmer on the win |
| In-game tools | **Clear · Undo · Hint** (undo added at Ruta's request) |
| Win screen buttons | **Home** and **Next ▶** (Share replaced with Home at Ruta's request) |

Companion files: `design-moodboard.html` (round 1 — themes, tappable boards),
`design-screens.html` (round 2 — home / in-game / win, with a live theme switcher),
`design-sound.html` (round 2 — sound picker).

---

## 0. What the design has to carry

BULLPEN is Star Battle. An N×N grid is partitioned into N irregular **pens**; the player places
exactly **k bulls** in every row, column and pen, and no two bulls may touch — not even diagonally.
Ruta's stated priority is the **hard end**, which here means **k = 2**: two bulls per pen, row and
column. That single change is what turns counting into real deduction, and it drives the layout:

1. **Pen boundaries and pen identity must both be unmistakable.** Every deduction is "this pen's
   remaining candidates all live in one row". The real app solves this with *two* channels at once —
   a distinct pastel fill per pen **and** a heavy deep-wine rule on every pen boundary. We do the
   same, so the board still reads with colour vision differences (boundary alone is sufficient).
2. **Three cell states, distinct without colour**: untouched, **dot** (player-marked "no bull"), and
   **bull**. On a 9×9 k=2 board a finished screen is ~18 bulls and ~63 dots, so the dot is what the
   player looks at most — quiet, but trustworthy.
3. **The board takes essentially the full width.** At 10×10 on a 390px screen cells are ~36–40px.
   No decorative frame; chrome must be genuinely thin.

There is **no lose state** — a mistake is recoverable. So: a win screen, no fail screen. Mistakes are
counted from the board (a bull placed where the solution has none), never from pressing Check.

---

## Stage 1 · Concept anchor

**Matched, not invented.** Ruta asked for the App Store game's look, so the anchor is inherited from
it rather than derived fresh:

> **"BULLPEN feels like a soft pastel stock plan — pens washed in colour and ruled in one heavy
> wine-dark line, calm enough to sit with for twenty minutes."**

Everything below is answerable with "because that's how the real game does it." Where the real app is
ambiguous or where accessibility demands more, the brief says so explicitly.

**Assets are original.** The bull is my own SVG line-drawing, the faces are Google Fonts
(Playfair Display + Nunito Sans) rather than the app's licensed types, and every colour was sampled
by eye from public screenshots. This is a faithful look-alike built from scratch, not lifted files.

## Stage 2 · Colour

**Pen pastels — shared by every theme** (fill / dot / horn):

| Pen | Fill | Dot & horn |
|---|---|---|
| 1 | `#F7CBC7` rose | `#CF6A62` |
| 2 | `#E0D6F0` lavender | `#8877B8` |
| 3 | `#FAE2BA` apricot | `#DDA13F` |
| 4 | `#D6E9D2` mint | `#6E9E68` |
| 5 | `#CBDFF2` sky | `#4E86B5` |
| 6 | `#FFFDF7` bone | `#B08A5A` |

(Boards larger than 6 pens extend this ramp with further muted pastels at the same lightness, so no
pen ever reads as "the loud one".)

**Rule / ink — every theme:** `#6E2639` deep wine. Board outline, pen boundaries, all text.
Text on any ground clears WCAG AA 4.5:1; the rule clears 3:1 against every pen fill.

**Ground themes — one is the default, the rest ship as selectable Themes** (the real app does this too):

- **Cream** `#F3EAD6`, chip `#E7DCC2` — the app's lead palette. Highest contrast, best in sunlight.
- **Pale Mint** `#D6EBDB`, chip `#C4E0CB` — cooler and calmer, good at night.
- **Rosé** `#F6DCDE`, chip `#EDC9CD` — warmest; the rose pen deepens to `#F0B7B2` here to keep separation.
- **Dark** `#241018`, card `#33191F`, chip `#3E1F27` — *not in the original app; added at Ruta's request.*
  On dark the rule inverts to warm cream `#EFDFC6` and the pens use a darkened set
  (`#7C4247` `#544A73` `#7A6136` `#3F5F44` `#3C5670` `#5B5148` …) with **light** dots/horns, so the
  bull still reads as a light mark on a dark pen. The bull's face fills `#EFE2CE` instead of white.

_Default theme: **Cream.** All four are selectable in settings; the choice persists in `localStorage`
and drives the PWA `theme-color`._

## Stage 3 · Typography

- **Playfair Display** 400 / 600 / italic — headings, the big translucent level numeral, the timer,
  and *all* UI labels. The real app sets even "Remaining Bulls" and "Forfeit" in a serif; matching
  that is most of why it reads as calm rather than as a utility app.
- **Nunito Sans** 400 / 600 — body copy, how-to-play, stats tables.
- Tabular figures on the timer so it doesn't twitch as digits change.

## Stage 4 · Spacing & depth

- **Scale: 4 / 8 / 16 / 24 / 32.** Everything snaps to it.
- **Material: soft paper-flat.** No gradients, no glass, no neumorphism. 10px board radius, 99px pill
  chrome, a single very soft shadow on cards only. The board is ruled, not raised.
- **Pressed state:** `scale(.92)`, matching the app's tactile snap. Applied to every tappable thing.
- **Tap targets ≥ 44px** for chrome. Cells run ~36–40px at 10×10 — the whole cell is the target, with
  hit-slop, and any mistap is one undo away.

## Stage 5 · Motion language

**Calm and settled**, one exception. Dots appear instantly — they're scratch notes. Bulls *land*:
220ms with a small overshoot, because placing a bull is the one committed act in the game. Screen
transitions cross-dissolve with a small rise.

## Stage 6 · Feedback & juice

| Moment | Visual | Motion | Sound | Haptic |
|---|---|---|---|---|
| Dot placed / cleared | none | instant | — | — |
| Bull placed (legal) | — | land + settle 220ms | short tick | 8ms |
| Bull breaking a rule | offending row / column / pen outline flashes wine | 4px shake on that rule only, never the screen | soft thunk | 20ms |
| Pen completed | its fill deepens once and holds; its tally pip goes out | 200ms | faint chime | — |
| Puzzle solved | pens light in sequence, bulls do a small wave | biggest in the game | win phrase | pattern |

_Chosen sound set: **2 · Soft Bell.** "A quiet room and a small brass bell." FM-synthesized brass
bells with gentle decay — the closest of the three to the real app's calm tone. Synthesized live with
Web Audio in `js/sound.js`; nothing ships as an audio asset._

| Moment | Soft Bell voice |
|---|---|
| Dot | 1320Hz sine, 50ms, gain .09 — barely there |
| Bull | FM 660Hz, ratio 1.8, index 120, 300ms |
| Rule broken | FM 180Hz, ratio 1.41 (detuned/dull), 340ms |
| Pen completed | FM 880 → 1320Hz, two bells 110ms apart |
| Solved | FM arpeggio 523·659·784·1047 at 130ms spacing, plus a 1568Hz shimmer tail over 1.5s |

Sound is off until the player's first tap (iOS requires a gesture before audio starts) and has a mute
toggle in settings. Haptics fire on the same moments regardless of the mute state.

## Stage 7 · Screens & layout

Matched to the real app's arrangement:

- **In-game** — grid icon (level select) top-left, timer pill top-right; a big translucent serif
  **level numeral** with `◀ Level ▶` beneath the top bar; the board full-width; **"Remaining Bulls"**
  with a row of pips below it (18 pips on a 9×9 k=2 board, going out as bulls are placed); and three
  tools pinned at the bottom: **🗑 Clear · ↺ Undo · 💡 Hint**. Undo is a Ruta addition — the real app
  ships clear + hint only, and undo matters more than clear on a 20-minute board.
- **Start screen — variant B, chosen.** Background is a faint tilted **stock plan**: the pen
  boundaries themselves drawn large across the whole screen at ~13% opacity, rotated -8°. Over it: a
  bull app-mark tile, the BULLPEN title and tagline, the **Continue** primary, the four Yard tiers as
  **full-width horizontal rows each filled in its own pen pastel** with size / bull-count / progress,
  and the daily with its streak. All above the fold at 390px.
- **Win screen** — pastel confetti in the pen colours, a bull mark, "Penned!", stars, time /
  mistakes / hints, personal best, streak, and two buttons: **Home** and **Next ▶**. The payoff; gets
  the most polish. (Share was dropped at Ruta's request in favour of Home.)
- **No lose screen** — the game cannot be lost.

## Stage 8 · App-store extras

Original app icon (a bull head on a pastel rounded tile), theme + splash colour from the chosen
ground, safe-area insets for notch and home bar, pull-to-refresh and text-selection disabled on the
board, offline via service worker, and a first-launch how-to that returning players never see again.

---

## Difficulty ladder — **Yard** (chosen)

| Tier | Name | Grid | Bulls per pen/row/col | Levels | Gate |
|---|---|---|---|---|---|
| 1 | **Paddock** | 6×6 | 1 | **1000** | — |
| 2 | **Pasture** | 8×8 | 1 | **1000** | — |
| 3 | **Rangeland** | 9×9 | **2** | **1000** | — |
| 4 | **Badlands** | 10×10 | **2** | **1000** | unlocked by clearing 150 levels |

### 1000 levels per tier — what that changes

**4000 levels total.** Three things follow, and all three are requirements, not nice-to-haves:

1. **Level select must be chunked.** A flat list of 1000 is unusable. The grid icon opens a tier's
   levels in **pages of 100** (`1–100`, `101–200`, …) with a page strip along the top, the current
   page landing on the player's furthest level. Each cell shows the level number and its star count.
2. **The difficulty ramp is per-tier and spans all 1000.** Levels are assigned along a smooth ramp of
   solver `effort` within the tier's technique band — level 5 of Rangeland is the gentlest board that
   still requires set-cover, level 995 is the hardest. A raw seed per level would make level 3 brutal
   and level 900 trivial.
3. **Build cost is real and it's a build-time cost only.** `scripts/build-levels.js` must generate,
   uniqueness-check and solver-grade far more than 4000 candidates (most get rejected by the tier
   gate), with the 10×10 two-bull Badlands boards by far the slowest. The script therefore has to
   support **resumable, parallel, per-tier runs** that append to a cache, so a long build can be done
   in chunks rather than one uninterruptible pass. Runtime cost to the player is zero — `js/levels.js`
   is a static table of `[seed, grade, par]` triples, ~100–150KB, gzipped by the host and cached by
   the service worker for offline play.

Rangeland and Badlands are gated by the solver on **technique**, not just on size: a board only ships
as Rangeland if solving it genuinely requires set-cover / adjacency-packing logic rather than plain
counting. That gate is what makes the hard end actually hard.
