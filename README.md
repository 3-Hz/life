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

Both forms work in the custom field. The presets were picked by measurement, not
taste — a scan over the rule space looking for lattices that stay populated
*and* keep changing:

| Preset | Behavior from random soup |
| --- | --- |
| `S7-12/B9-12` | Wispy amoeba, decays slowly — the default |
| `S9/B7-10` | Compacts into a dense churning ball |
| `5-7/6-8` | Self-sustaining, holds ~28% of the lattice indefinitely |
| `4555`, `5766` | Bays' classics. **These die out from random soup** — they were built for hand-placed structures. With audio connected, beats keep reblooming them, which is a look of its own |

Most rules either die, decay, or saturate from soup; a rule that stays sparse and
lively on its own is rare. That is what the beat injection is for.

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
