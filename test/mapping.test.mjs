// The audio -> simulation mapping is pure, so it tests in node like the rules do.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    mapToSim, mapToVisual, shiftBirth, densityControl, NO_DENSITY, TUNING,
} from '../dist/mapping.js';
import { parseRule } from '../dist/automata.js';

// Centroid 0.5 is "no opinion": it is where a signal with nothing to say sits,
// and it is what the engine reports when no audio is connected.
const silence = {
    bass: 0, mid: 0, treble: 0, level: 0, centroid: 0.5, flux: 0,
    beat: false, beatStrength: 0, pulse: 0,
};
const loud = {
    bass: 0.9, mid: 0.7, treble: 0.8, level: 1, centroid: 0.9, flux: 1,
    beat: true, beatStrength: 1, pulse: 1,
};
// What ordinary music looks like now that features are measured against their
// own recent range: somewhere in the middle, most of the time.
const ordinary = {
    bass: 0.5, mid: 0.5, treble: 0.45, level: 0.5, centroid: 0.5, flux: 0.3,
    beat: false, beatStrength: 0, pulse: 0.2,
};

test('louder audio raises the tick rate, within bounds', () => {
    const quiet = mapToSim(silence, 1);
    const busy = mapToSim(loud, 1);
    assert.equal(quiet.tickRate, TUNING.tickRate.min);
    assert.equal(busy.tickRate, TUNING.tickRate.max);
    assert.ok(busy.tickRate > quiet.tickRate);
});

// The point of the whole adaptive-feature change: middling input has to produce
// middling output. Absolute features pinned `level` at 1.0 for any real master,
// so this landed at the ceiling and stayed there for entire tracks.
test('ordinary music lands in the middle of the range, not against the ceiling', () => {
    const rate = mapToSim(ordinary, 0.6).tickRate;
    const { min, max } = TUNING.tickRate;
    assert.ok(rate > min + (max - min) * 0.15, `too close to the floor: ${rate.toFixed(1)}`);
    assert.ok(rate < min + (max - min) * 0.7, `saturated again: ${rate.toFixed(1)}`);
});

test('onset density moves the rate even when loudness does not', () => {
    const still = mapToSim({ ...ordinary, flux: 0 }, 1).tickRate;
    const busy = mapToSim({ ...ordinary, flux: 1 }, 1).tickRate;
    assert.ok(busy > still,
        'a busy break must outrun a sustained pad at the same loudness');
});

test('zero sensitivity removes every audio effect on the simulation', () => {
    const sim = mapToSim(loud, 0);
    assert.equal(sim.birthShift, 0);
    assert.equal(sim.tickRate, TUNING.tickRate.min);
    assert.equal(sim.burst.density, 0, 'a burst at zero sensitivity must place nothing');
});

test('beats produce a burst and silence does not', () => {
    assert.equal(mapToSim(silence, 1).burst, null);
    const burst = mapToSim(loud, 1).burst;
    assert.ok(burst.radius >= TUNING.burst.radiusMin && burst.radius <= TUNING.burst.radiusMax);
    assert.ok(burst.density > 0);
});

test('bursts land at the height the spectrum points to', () => {
    assert.ok(mapToSim({ ...loud, centroid: 0.9 }, 1).burst.height > 0.8);
    assert.ok(mapToSim({ ...loud, centroid: 0.1 }, 1).burst.height < 0.2);
});

test('a bright mix shifts birth up, a dark one down', () => {
    assert.ok(mapToSim({ ...loud, centroid: 1 }, 1).birthShift > 0);
    assert.ok(mapToSim({ ...loud, centroid: 0 }, 1).birthShift < 0);
    assert.equal(mapToSim({ ...loud, centroid: 0.5 }, 1).birthShift, 0);
});

test('shiftBirth clamps to 0-26 and never inverts the window', () => {
    const rule = parseRule('4555');
    assert.deepEqual(shiftBirth(rule, 0), rule);
    assert.deepEqual(shiftBirth({ sMin: 4, sMax: 5, bMin: 0, bMax: 1 }, -5).bMin, 0);
    assert.deepEqual(shiftBirth({ sMin: 4, sMax: 5, bMin: 25, bMax: 26 }, 5).bMax, 26);

    const wide = shiftBirth({ sMin: 4, sMax: 5, bMin: 25, bMax: 26 }, 5);
    assert.ok(wide.bMin <= wide.bMax, 'birth window must stay ordered');
});

//-------VISUALS-------
test('visual mapping stays inside its declared ranges', () => {
    const cases = [silence, ordinary, loud, { ...loud, level: 0.5, treble: 0.2 }];
    for (const features of cases) {
        const v = mapToVisual(features, 1);
        assert.ok(v.voxelScale >= TUNING.voxelScale.min && v.voxelScale <= TUNING.voxelScale.max);
        assert.ok(v.emissive >= TUNING.emissive.min && v.emissive <= TUNING.emissive.max);
        assert.ok(Math.abs(v.hueShift) <= TUNING.hueRange / 2);
        assert.ok(v.tintSat >= TUNING.tintSat.min && v.tintSat <= TUNING.tintSat.max);
        assert.ok(v.dolly >= 0 && v.dolly <= TUNING.dolly + TUNING.dollyPunch);
        assert.ok(v.bandGain >= 0 && v.bandGain <= TUNING.bandGain);
    }
});

// The glow used to read a band level and nothing else, so it sat at one value
// for a whole track. It has to answer to hits now.
test('the glow is mostly transient, not a steady lamp', () => {
    const resting = mapToVisual({ ...ordinary, pulse: 0 }, 1).emissive;
    const hit = mapToVisual({ ...ordinary, pulse: 1 }, 1).emissive;
    assert.ok(hit > resting * 2, `a hit must be clearly brighter: ${resting} -> ${hit}`);
});

test('hue swings both ways around its resting point', () => {
    assert.ok(mapToVisual({ ...ordinary, centroid: 1 }, 1).hueShift > 0);
    assert.ok(mapToVisual({ ...ordinary, centroid: 0 }, 1).hueShift < 0);
    assert.equal(mapToVisual({ ...ordinary, centroid: 0.5 }, 1).hueShift, 0);
});

test('targets switch individual effects off', () => {
    const sim = mapToSim(loud, 1, { tickRate: true, burst: false, birthShift: false });
    assert.equal(sim.burst, null);
    assert.equal(sim.birthShift, 0);
    assert.equal(sim.tickRate, TUNING.tickRate.max);

    const visual = mapToVisual(loud, 1, { color: false, scale: false, camera: false });
    assert.equal(visual.hueShift, 0);
    assert.equal(visual.dolly, 0);
    assert.equal(visual.bandGain, 0);
    assert.equal(visual.voxelScale, TUNING.voxelScale.max);
});

test('the sensitivity slider is a gain, not a ceiling', () => {
    // It used to scale loudness before the response curve, so at its default
    // 60% even maximum loudness reached only 16 of a possible 24 steps/sec. It
    // is applied after the curve now, and has to stay monotonic in both
    // arguments so the slider always does what it looks like.
    const full = mapToSim(loud, 1).tickRate;
    assert.equal(full, TUNING.tickRate.max, 'full loudness at full sensitivity reaches the ceiling');

    let previous = -Infinity;
    for (const level of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
        const rate = mapToSim({ ...ordinary, level }, 0.6).tickRate;
        assert.ok(rate >= previous, 'louder audio must never step slower');
        previous = rate;
    }
    previous = -Infinity;
    for (const s of [0, 0.25, 0.5, 0.75, 1]) {
        const rate = mapToSim(ordinary, s).tickRate;
        assert.ok(rate >= previous, 'raising sensitivity must never step slower');
        previous = rate;
    }
});

test('silence still rests at the floor whatever the slider says', () => {
    for (const s of [0, 0.5, 1]) {
        assert.equal(mapToSim(silence, s).tickRate, TUNING.tickRate.min);
    }
});

//-------DENSITY-------
test('a sparse lattice is left completely alone', () => {
    for (const fill of [0, TUNING.density.clear / 2, TUNING.density.clear]) {
        assert.deepEqual(densityControl(fill), NO_DENSITY);
    }
});

// Measured equilibrium for every shipped rule is 0.26-0.33, so the controller
// must not be leaning on the automaton at those fills -- only past them.
test('the rules own natural density is not fought', () => {
    for (const fill of [0.26, 0.3]) {
        const control = densityControl(fill);
        assert.equal(control.burstScale, 1, `bursts held back at fill ${fill}`);
        assert.equal(control.birthChance, 1, `births thinned at fill ${fill}`);
    }
});

test('a filling lattice loses its bursts first, then its new births', () => {
    const { target, band } = TUNING.density;
    const edge = densityControl(target + band);
    assert.equal(edge.burstScale, 0, 'bursts stop feeding a lattice that is already full');
    // The band edge is a float boundary, so this is "untouched" to within dust.
    assert.ok(edge.birthChance > 0.999, 'the rule itself is untouched inside the band');

    const packed = densityControl(target + band * 2);
    assert.ok(packed.birthChance < 1, 'well past the band, growth gets thinned');
    assert.ok(packed.birthChance >= TUNING.density.minBirthChance);
});

test('relief tracks how crowded the lattice is, all the way up', () => {
    const { clear, packed } = TUNING.density;
    assert.equal(densityControl(clear).relief, 0);
    assert.equal(densityControl(packed).relief, 1);
    const half = densityControl((clear + packed) / 2).relief;
    assert.ok(Math.abs(half - 0.5) < 1e-9, `should be linear between, got ${half}`);
});

test('density control never thins below its floor, however full it gets', () => {
    const crammed = densityControl(1);
    assert.equal(crammed.birthChance, TUNING.density.minBirthChance);
    assert.equal(crammed.burstScale, 0);
    assert.equal(crammed.relief, 1);
});

test('switching it off restores exactly the untouched behaviour', () => {
    assert.deepEqual(densityControl(0.9, false), NO_DENSITY);
    const burst = mapToSim(loud, 1, undefined, densityControl(0.9, false)).burst;
    assert.equal(burst.density, mapToSim(loud, 1).burst.density);
});

test('a crowded lattice is made see-through rather than left as a block', () => {
    const packed = densityControl(TUNING.density.packed);
    const open = mapToVisual(loud, 1).voxelScale;
    const relieved = mapToVisual(loud, 1, undefined, packed).voxelScale;
    assert.ok(relieved < open, 'relief has to actually shrink the voxels');
    assert.ok(relieved >= TUNING.voxelScale.max * (1 - TUNING.reliefDepth) - 1e-9);
});
