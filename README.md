# life

A 3D cellular automaton on a voxel lattice, driven by whatever music is playing.

Audio does more than tint the picture: loudness sets the tick rate, onsets seed
bursts of new cells and send shells expanding out through the lattice, the
spectrum lights the height it belongs to, and spectral brightness shifts the
birth thresholds — so the lattice never settles while sound is playing.

Every feature is measured **against the signal's own recent range**, not against
a fixed ceiling, which is what keeps it moving. See *Reacting to audio* below.

Open `index.html` through a local web server (not `file://` — ES modules and
audio capture both refuse it):

```sh
bun install
bun run build
python3 -m http.server 8000   # then open http://localhost:8000
```

The source is TypeScript and the compiler writes browser-ready modules to
`dist/`. three.js is still vendored in `vendor/`.

## Audio sources

The awkward truth: **an embedded player's audio cannot be read by the page.** A
SoundCloud or Spotify embed is a cross-origin iframe, and nothing in the browser
turns its audio into samples. Screen capture is the only way to reach it, and
screen capture does not exist on any mobile browser — Android defines
`getDisplayMedia` and always rejects it, iOS omits it.

So the app does not try to capture someone else's player. It owns one. Audio
served with `Access-Control-Allow-Origin` loads into our own `<audio>` element,
and `createMediaElementSource` reads every sample of it: no picker, no
permission, every browser. **Audius** clears that bar where SoundCloud never
could — open API, no key, CORS on the stream and on the redirect in front of it.

| Source | How it works | Where it works |
| --- | --- | --- |
| **Audius / Music** | search Audius, stream it through our own element | Everywhere, no permission — the primary song source and the only one that works on a phone |
| **System / other tab** | `getDisplayMedia` — share a tab or screen with audio | Desktop Chromium, for reaching Spotify or YouTube; "share system audio" only on Windows and ChromeOS |
| **Microphone** | `getUserMedia` | Everywhere. Also the macOS route to true system audio, via a loopback device such as BlackHole |
| **Audio file** | pick a local file | Everywhere, no picker, no permission — the most reproducible option |
| **Test tone** | built-in oscillator | Everywhere, no permission at all |

Every source still needs a click, because `AudioContext` starts suspended until
a gesture. Only the middle two add a permission prompt on top of that.

The Audius player is persistent and centered at the bottom of the usable
visualization on a PC. Its search icon toggles the search field and result list
without hiding the now-playing transport or seek bar. On a smaller layout, the
`MUSIC` button in the dock opens it as a bottom-sheet overlay with search and
results visible. It includes play/pause, elapsed and total time, and a seek bar;
the browser uses range requests so the playhead can scrub the track. The search
box also takes an `audius.co` link.

Audius is not the only host that qualifies: anything serving audio with the CORS
header works through the same path, and `archive.org` downloads carry
`Access-Control-Allow-Origin: *` across some 290,000 live recordings. Those
alternative source paths remain under **Advanced** in the controls panel.

## Controls

| Control | Key | What it does |
| --- | --- | --- |
| SEED | `r` | Refills the middle of the lattice at random |
| PAUSE / PLAY | `space` | Stops and resumes the visualization |
| STEP | `s` | Pauses, then advances one generation |
| CLEAR | `c` | Empties the lattice |

The **STATS** toggle lives in the controls panel with the visualization controls.

On the lattice itself: **tap or click to re-seed**, **drag to rotate**, **pinch
or scroll to zoom**. Camera panning is deliberately absent — it only ever slid
the lattice off-centre with no easy way back.

**Auto camera rotation** is enabled by default and gives the lattice a slow,
sinusoidal breathing orbit on two axes. Dragging or zooming takes control for a
moment; the automatic motion then resumes from the orientation you left it at.
Turn it off in the Automaton controls when you want a completely still camera.

Re-seeding on tap means a drag misread as a tap would throw the board away, so
the threshold errs the other way: anything past ~12px or ~300ms is a drag.

**Wrap edges** makes the lattice toroidal (the default) so cells at the faces
have full neighborhoods. **Never let it die** reseeds a burst whenever the
population collapses, so the toy is never empty when no audio is driving it.
**Keep it breathable** is its opposite number, described under *Density* below.
**Adapt quality to frame rate** is described under Performance below.

## Layout

One controls panel, collapsible everywhere, uses a right rail on a wide
landscape PC and a bottom sheet on smaller layouts. Opening it reframes the
visualization on desktop; on smaller layouts it overlays the visualization so
the lattice does not jump. Tapping the lattice never toggles it, since taps
re-seed. Pause/play and the stats toggle live inside this panel.
The HUD is off by default and trims to GEN, ALIVE and FPS on a narrow screen,
where seven stats do not fit.

The panel starts open only where there is room (landscape, 900px or wider). On a
phone it starts collapsed. The Audius player is always available on a PC and is
opened from its dedicated `MUSIC` dock button on mobile. The mobile player and
controls sheets are mutually exclusive, and the player overlays rather than
reframes the visualization.

The camera fits and centres the lattice against the area the dock leaves, not
the whole canvas. Fitting to lattice size alone cropped roughly 40% of the width
off a portrait phone; centring on the canvas left the lattice 28px low behind a
55px dock. The canvas itself stays full-bleed, so the lattice still shows through
the translucent panel.

The dock and an open controls panel count as chrome on desktop, so the lattice
reframes into the space that remains. On mobile, only the dock counts as chrome;
the Controls and Audius sheets overlay the full visualization area. The offset
is fixed rather than tracking the cube's projected outline, so it does not drift
while you rotate. The floating Audius player is deliberately excluded from the
camera inset, so opening it does not make the lattice jump while someone
searches or scrubs.

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

The presets live in `RULE_PRESETS` in `src/automata.ts`; the dropdown and the
test both read from it, so there is one list rather than two that drift.

## Reacting to audio

The hard part is not extracting features, it is that **absolute features clip.**
`getByteFrequencyData` compresses the spectrum into a 70dB window and pins every
bin above -30dB at 255, which is where loud music lives; RMS loudness compared
against a fixed maximum pins in the same way on any modern master. Once a
feature is pinned it has stopped saying anything, and the whole picture holds
still while the music does not. Worst of all, the old beat detector divided a
fast bass envelope by a slow one — when both clip the ratio is 1, so beats
stopped being found exactly in the music that has the most of them.

So every feature is normalized against its own recent range (`AdaptiveRange` in
`src/dynamics.ts`): a floor that drops fast and rises slowly, a ceiling that
rises fast and drops slowly, and the signal mapped onto 0–1 between them. A
transient reaches the top of the range immediately, and the range reopens over
the following seconds, so a quiet passage reads quiet again shortly after a loud
one. A steady signal converges on mid-scale rather than on either end.

Pure normalization has no idea what silence is — silence measured against
silence would come out mid-scale — so one absolute gate on loudness multiplies
every feature, and that is the only absolute judgement left.

Beats come from **spectral flux against an adaptive threshold** built from the
signal's own mean and deviation, which is immune to the clipping failure above.

What each feature drives:

| Feature | Drives |
| --- | --- |
| Loudness | Step rate, voxel size, camera dolly |
| Onset density (flux) | Step rate, alongside loudness |
| Onsets | Bursts of new cells, shockwaves, the emissive punch |
| Spectral centroid | Hue, birth-window shift, the height bursts land at |
| Per-band energy | Brightness of the lattice at that height |

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
sync ms, frame ms, the current quality level, and the normalized loudness and
onset density. Those last two are the ones to watch when the picture looks
stuck — either of them sitting at 1.00 is the pinning described above.

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
src/automata.ts   lattice, rules, step() — pure, no DOM (the tested module)
src/audio.ts      capture chain, analyser, feature extraction
src/audius.ts     Audius search and stream URLs
src/mapping.ts    audio features -> simulation and visual parameters
src/camera-motion.ts pure sinusoidal camera offsets
src/render.ts     three.js scene, instanced voxels
src/main.ts       wiring and the frame loop
dist/             generated browser modules (do not edit)
vendor/           three.js r185.1 (module + core + OrbitControls)
```

`src/automata.ts` imports nothing, which is what makes the rules testable:

```sh
bun run test
```

Neighbor counting is separable — three one-dimensional passes give every cell its
3×3×3 box sum in about six adds instead of 26 loads. The third pass is fused with
the rule application, since writing counts only to read them straight back cost a
full N³ round trip; it still fills `counts[]`, which the renderer shades from.

`computeCounts()` and `countNeighborsNaive()` remain in the module purely as
oracles. The tests check the real, fused path against them cell-for-cell —
otherwise the separable-vs-naive test would keep passing while covering code
nothing runs.

## Density

Beat bursts inject cells with no idea how full the lattice already is, so a
dense rule under loud music used to pack the cube into an opaque block with
everything interesting happening where nobody could see it. **Keep it
breathable** pushes back, weakest lever first: bursts stop feeding a lattice
that is already full, then new births are thinned, and throughout, the voxels
shrink as the lattice crowds so you can see into it rather than at it.

Measured over 400 generations at 48³, the shipped rules settle between 26% and
33% full on their own, so the burst and birth levers only engage past 30% — what
they exist to catch is audio-driven growth beyond what the automaton does
unaided, not the automaton itself. Shrinking is separate and continuous, because
legibility is a question about the lattice in front of you, not about who filled
it.

Births are thinned with a probability roll rather than by shifting the rule's
birth window, which sounds equivalent and is not: whether shifting that window
adds or removes cells depends on the local neighbor count, so it pushes the
wrong way in exactly the crowded regions this is meant to open up.

## Colour and light

Everything the music adds — the transient glow, the band sitting at a cell's
height, any shockwave passing through — is added on top of the key light and
then **tone mapped**, `1 - exp(-colour * exposure)`, rather than clipped. Added
light used to run straight past 1.0 and flatten to white, so every loud moment
looked identical to the one before it. Compressing instead keeps a harder hit
reading as harder, and is what lets the glow be pushed far enough to be worth
watching.

The spectrum is uploaded as a one-texel-per-band texture and sampled in the
vertex shader by lattice height — a texture rather than a uniform array because
GLSL ES 1.00 will not index one of those with a computed index, and a loop over
every band per vertex costs too much on the mobile path.

## Tuning

Every constant coupling audio to the simulation lives in `TUNING` in
`src/mapping.ts`, behind the sensitivity slider. Set sensitivity to 0 and the
simulation is deterministic again: same seed, same rule, same lattice.

The feature extraction has its own knobs — attack and release per feature, the
silence gate, the onset threshold — in `src/audio.ts` and `src/dynamics.ts`.
`dynamics.ts` is pure and has no imports, so what it does is pinned down by
`test/dynamics.test.mjs` rather than only by ear.
