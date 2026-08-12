# BULLPEN

Star Battle, penned. An N×N grid is split into N irregular **pens**; place exactly **k bulls**
in every row, every column and every pen — and no two bulls may touch, not even at a corner.

4,000 solver-verified boards across four tiers, plus a daily challenge. Vanilla HTML/CSS/JS,
no build step, no backend, fully playable offline once installed.

Open `index.html` and play.

## How to play

- Tap a cell to cycle it: **empty → dot → bull → empty**. The dot is your own "no bull here"
  note; the bull is the committed move.
- Every row, column and pen wants the same number of bulls (1 in Paddock and Pasture, 2 in
  Rangeland and Badlands). The **Remaining Bulls** pips count down as you place them.
- **Bulls never touch** — including diagonally.
- **Clear** wipes the board, **Undo** takes back any move (full history, including a clear),
  **Hint** performs the next move the rules actually force and tells you which technique
  proved it.
- The game **cannot be lost**. There is a win screen and no fail screen. Mistakes are counted
  from the board — a bull standing where the solution has none — never from pressing anything.

### The Yard ladder

| Tier | Grid | Bulls | Levels | Gate |
|---|---|---|---|---|
| **Paddock** | 6×6 | 1 | 1000 | — |
| **Pasture** | 8×8 | 1 | 1000 | — |
| **Rangeland** | 9×9 | 2 | 1000 | — |
| **Badlands** | 10×10 | 2 | 1000 | 150 levels cleared |

Stars: **3** for a clean solve (no hints, no mistakes) under par, **2** for a clean solve over
par, **1** for solving it. Par is deliberately forgiving — a lost star should come from a hint
or a mistake, never from thinking.

## How it works

### The solver is the arbiter

`js/solver.js` is a pure deduction engine with a ten-rung technique ladder, weakest first:
adjacency → line/region full → line/region forced → region-in-line → line-in-region →
adjacency-packing → set-cover → (opt-in, grading only) depth-1 contradiction. Every technique
marks a cell only when it can *prove* the mark; nothing reasons from "the puzzle is supposed to
have one solution", which is what keeps the generator's uniqueness gate non-circular.

A board only ships if `countSolutions()` proves it has exactly one solution **and** `solve()`
reaches that solution with no guessing. The **hardest technique a board requires** is its
grade — that is the difficulty axis, not the grid size.

`nextStep()` powers the hint button: it re-derives the cheapest available deduction from the
bulls you have placed (your dots are notes and are never fed to it, because one wrong dot would
poison every hint after it) and hands back the technique, the cell and its own plain
explanation.

### The level table

`js/levels.js` is a static table of `[seed, effort, par]` triples — 4,000 rows, ~115 KB, cached
by the service worker. A board is rebuilt from its seed on the device by the same certified
generator, so nothing about a puzzle is stored except the number that reproduces it.

Two details that matter:

- The stored seed is the **effective** seed. A board accepted on attempt *a* of seed *S* is
  reproduced by attempt 0 of `(S + a*0x9e3779b1)`, so the player's device runs one attempt
  instead of replaying the rejects.
- Levels are **ramped**, not raw. Every candidate is graded by the solver's own `effort`, the
  1,000 candidates in a tier are sorted, and level numbers are assigned along that ramp — level
  5 of Rangeland is the gentlest board that still needs set-cover, level 995 the hardest.

Pasture additionally carries a **minimum-technique floor** (`line-in-region`): without it about
60% of 8×8 boards graded at the same top technique as Paddock, just on a bigger grid.

## Project structure

```
index.html               one page, all screens
css/style.css            the whole stylesheet
js/rng.js                seeded PRNG + hashSeed          ] the certified
js/solver.js             deduction engine, hints, uniqueness ] logic core —
js/generator.js          solution-first board generation  ] read-only
js/par.js                par times, shared by campaign and daily
js/levels.js             GENERATED — 4,000 [seed, effort, par] rows
js/meta/                 vendored from games/_shared/meta (never edited)
js/meta-config.js        mounts the meta-layer: tiers, gates, curves, daily
js/meta-ui.js            home, level map, calendar, records, settings, win
js/theme.js              the four themes and the pen palettes
js/sound.js              Web Audio "Soft Bell" set, synthesised live
js/game.js               the game model — state, rules, undo, save. No DOM.
js/ui.js                 the board controller
sw.js                    service worker, cache-first app shell
scripts/build-levels.js  builds js/levels.js
scripts/make-icons.js    builds icons/ (real PNGs, no dependencies)
scripts/stamp-cache.js   stamps sw.js's CACHE_VERSION from the shipped bytes
test/verify.js           the logic-core gate
```

`js/game.js` holds no DOM and `js/solver.js` holds no state, so the logic stays headlessly
testable; `js/meta-ui.js` never computes progression itself — every number comes from
`js/meta/`.

## Running the tests

```
node test/verify.js             # the logic-core gate: 30 checks, ~3.5 min, exit 0 on pass
node test/hint-regression.js    # the hint bridge: no stale, no dead-end hints
node test/levels-contract.test.js  # the shipped level table matches its declared tiers
node test/resume.test.js        # a save round-trips
node test/cache-stamp.test.js   # sw.js's cache version matches the bytes it ships
```

## After a fresh clone

The service worker is cache-first, so a shipped change that leaves `CACHE_VERSION` alone
cannot reach an installed app — the phone keeps serving the old build off disk. The
version is therefore stamped from the contents of the precached files, automatically, by
a pre-commit hook. Hooks are not cloned, so enable it once:

```
git config core.hooksPath .githooks
```

Without it nothing silently rots — `test/cache-stamp.test.js` fails on a stale stamp, and
`node scripts/stamp-cache.js` fixes one.

## Rebuilding the level table

The full 4,000-level build takes roughly 40 minutes single-process (Paddock 50 ms/board,
Rangeland 270 ms, Badlands 1.3 s, Pasture 1.1 s including its technique floor). It is
resumable and shardable — candidates are appended to `scripts/.cache/<tier>.json` and
already-built slots are skipped:

```
node scripts/build-levels.js                                  # everything, then emit
node scripts/build-levels.js --tier badlands --from 1 --to 250 --no-emit
node scripts/build-levels.js --tier badlands --from 251 --to 500 --no-emit   # in parallel
node scripts/build-levels.js --emit                           # write js/levels.js
```

The emit step **asserts every layout in a tier is distinct** and refuses to write if not.
(Seeding levels with a fixed stride silently collapses the output, because the generator walks
its own retries with that same stride — see the comment at the top of the script.)

```
node scripts/make-icons.js  # regenerate icons/ from source
```

## Deploying and installing on an iPhone

Any static host works — the whole game is files. Serve the `games/bullpen/` directory over
**HTTPS** (a service worker will not register otherwise, except on `localhost`).

```
python -m http.server 8899     # local check: http://localhost:8899/index.html
```

On the phone: open the URL in **Safari** → Share → **Add to Home Screen**. It launches
standalone with no browser chrome, uses the theme's ground colour for the status bar and the
splash, respects the notch and home-bar insets, and works with no network at all — boards,
daily, progress and records are all local. Changing the theme in Settings changes the installed
app's `theme-color` too.

After changing any shipped file, bump `CACHE_VERSION` in `sw.js`, or already-installed players
keep the old shell.
