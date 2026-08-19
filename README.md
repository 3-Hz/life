# life

A 3D cellular automaton on a voxel lattice, driven by whatever music is playing.

Audio does more than tint the picture: loudness sets the tick rate, beats seed
bursts of new cells, and spectral brightness shifts the birth thresholds — so the
lattice never settles while sound is playing.

Open `index.html` through a local web server (not `file://` — ES modules and
audio capture both refuse it):

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

No build step, no npm install. three.js is vendored in `vendor/`.

## Audio sources

The awkward truth: **an embedded player's audio cannot be read by the page.** A
SoundCloud or Spotify embed is a cross-origin iframe, and nothing in the browser
turns its audio into samples. Reaching the song that is playing means screen
capture, so most sources below go through the share picker.

| Source | How it works | Where it works |
| --- | --- | --- |
| **System / other tab** | `getDisplayMedia` — share a tab or screen with audio | Tab audio in any Chromium; "share system audio" only on Windows and ChromeOS |
| **This tab** | plays a SoundCloud track in the page, then captures this tab | Any Chromium, macOS included — the recommended path there |
| **Microphone** | `getUserMedia` | Everywhere. Also the macOS route to true system audio, via a loopback device such as BlackHole |
| **Audio file** | pick a local file | Everywhere, no picker, no permission — the most reproducible option |
| **Test tone** | built-in oscillator | Everywhere, no permission at all |

Every source needs a click: `AudioContext` starts suspended until a gesture, and
capture needs a permission prompt on top of that.

## Controls

| Control | Key | What it does |
| --- | --- | --- |
| SEED | `r` | Refills the middle of the lattice at random |
| PAUSE / PLAY | `space` | Stops and resumes |
| STEP | `s` | Pauses, then advances one generation |
| CLEAR | `c` | Empties the lattice |
| — | drag | Orbits the camera; scroll zooms |

**Wrap edges** makes the lattice toroidal (the default) so cells at the faces
have full neighborhoods. **Never let it die** reseeds a burst whenever the
population collapses, so the toy is never empty when no audio is driving it.
**Adapt quality to frame rate** is described under Performance below.

## Rules

Cells live on an `N³` lattice with a 26-cell Moore neighborhood. Rules give a
survival range and a birth range, in Bays' four-digit notation — survival
min/max, birth min/max — so `4555` survives on 4–5 neighbors and is born on
exactly 5. Counts above 9 need the range form, `S7-12/B9-12`.

Both forms work in the custom field. The dropdown is ordered as a dial: how much
of the visible structure survives each step. High persistence reads as an
organism breathing; low persistence reads as boiling static, because the lattice
is being replaced rather than evolved.

| Preset | live | persists per step | reads as |
| --- | --- | --- | --- |
| `S6-11/B4-4` | 32% | 91% | slow, coherent, breathing |
| `S6-14/B3-3` | 30% | 89% | slow, rippling surfaces |
| `4733` | 25% | 76% | **default** — lively but coherent |
| `5933` | 26% | 77% | similar, looser |
| `5855` | 27% | 46% | agitated, half replaced each step |
| `5-7/6-8` | 29% | 0% | boiling static, and the most expensive to draw |
| `4555`, `5766` | — | — | Bays' classics. **These die from random soup** — built for hand-placed structures. Beats keep reblooming them, which is a look of its own |

Figures are 48³ over 300 generations, from the seeding `seed()` actually uses.
That qualifier is load-bearing: **rules are extremely sensitive to how the
lattice is seeded.** An earlier default was chosen against a denser, full-lattice
seeding and shipped effectively dead — it collapsed to 29 live cells under the
seeding the app really uses, surviving only the one configuration it was measured
against. A test now runs every preset from the real seeding, which is the check
that would have caught it.

Candidates had to stay alive across three different seedings to qualify; only ten
rules in this family do. **Sparse and robust barely coexist here** — nothing
under ~23% live survives varied seeding without freezing into a static crystal.
That is a property of the rule family, not a tuning choice.

The presets live in `RULE_PRESETS` in `src/automata.js`; the dropdown and the
test both read from it, so there is one list rather than two that drift.

## Step rate and motion

The automaton runs at **20 steps/sec** with no audio, and loudness drives it
between 2 and 60. Sensitivity is a gain on that, not a ceiling — it used to
scale loudness *before* the response curve, so at its default 60% even maximum
loudness reached only 16 steps/sec and ordinary music sat near 7.

Births grow in and deaths shrink away across the gap between generations, so the
lattice moves continuously rather than holding one frozen image for several
frames. Two things follow from that:

- **Smoothing and the top of the rate range are alternatives, not cumulative.**
  Above roughly one step per frame there is no gap left to animate, and the
  interpolation correctly becomes a no-op.
- **Dying cells cost instances**, since they are drawn while shrinking. That is
  about +12% on the default rule and nearly double on `5-7/6-8`, which is why
  the boiling preset is also the expensive one.

## Performance

Add `?perf` to the URL for a live breakdown in the HUD: simulation ms, instance
sync ms, frame ms, and the current quality level.

Two things dominate a tick, and the renderer used to cost twice the simulation.
Measured per tick, before and after this pass:

| Lattice | before | after | |
| --- | --- | --- | --- |
| 32³ | 2.07ms | 0.77ms | 2.7× |
| 48³ | 7.16ms | 2.76ms | 2.6× |
| 64³ | 15.4ms | 6.57ms | 2.3× |

At 64³ a single tick used to nearly consume a whole 16.6ms frame on its own.

The renderer no longer rebuilds instance matrices. Per tick it writes five bytes
per live cell — lattice coordinate, age, neighbor count — into instanced
attributes, and the GPU resolves placement, color, scale, ambient occlusion and
fog. Voxel scale is a uniform now, so the audio reaction costs nothing per cell.
Ambient occlusion comes free from the neighbor counts the simulation already
computes.

Occlusion culling was removed. It cost ~1.2ms a tick and removed only ~12% of
instances — it never paid for itself. What replaced it, skipping cells with all
26 neighbors alive, is free but rarely fires at ordinary densities.

**Adaptive quality** watches frame time (not frame rate — a 20ms frame is a
dropped frame whatever the average says) and steps down under load: pixel ratio
first, then the tick-rate ceiling, then lattice size. Pixel ratio and tick rate
recover when there is headroom. Lattice size does not: shrinking reallocates and
reseeds, so reversing it would throw the board away a second time. Raise it back
by hand when you want it. Phones start at 32³ with antialiasing off and a lower
pixel-ratio ceiling.

The controller ignores the first four seconds. Startup frames are slow for
reasons that say nothing about steady state — shaders compiling, buffers
uploading — and judging quality on them would walk the lattice down before the
page had drawn anything, permanently, since the size drop is one-way.

## Layout

```
index.html        import map, canvas, controls
src/automata.js   lattice, rules, step() — pure, no DOM (the tested module)
src/audio.js      capture chain, analyser, feature extraction
src/player.js     SoundCloud widget embed
src/mapping.js    audio features -> simulation and visual parameters
src/render.js     three.js scene, instanced voxels
src/main.js       wiring and the frame loop
vendor/           three.js r185.1 (module + core + OrbitControls)
```

`src/automata.js` imports nothing, which is what makes the rules testable:

```sh
node --test
```

Neighbor counting is separable — three one-dimensional passes give every cell its
3×3×3 box sum in about six adds instead of 26 loads. The third pass is fused with
the rule application, since writing counts only to read them straight back cost a
full N³ round trip; it still fills `counts[]`, which the renderer shades from.

`computeCounts()` and `countNeighborsNaive()` remain in the module purely as
oracles. The tests check the real, fused path against them cell-for-cell —
otherwise the separable-vs-naive test would keep passing while covering code
nothing runs.

## Tuning

Every constant coupling audio to the simulation lives in `TUNING` in
`src/mapping.js`, behind the sensitivity slider. Set sensitivity to 0 and the
simulation is deterministic again: same seed, same rule, same lattice.
