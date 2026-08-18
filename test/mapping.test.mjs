// The audio -> simulation mapping is pure, so it tests in node like the rules do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapToSim, mapToVisual, shiftBirth, TUNING } from '../src/mapping.js';
import { parseRule } from '../src/automata.js';

const silence = { bass: 0, mid: 0, treble: 0, level: 0, centroid: 0, beat: false, beatStrength: 0 };
const loud = { bass: 0.9, mid: 0.7, treble: 0.8, level: 1, centroid: 0.9, beat: true, beatStrength: 1 };

test('louder audio raises the tick rate, within bounds', () => {
    const quiet = mapToSim(silence, 1);
    const busy = mapToSim(loud, 1);
    assert.equal(quiet.tickRate, TUNING.tickRate.min);
    assert.equal(busy.tickRate, TUNING.tickRate.max);
    assert.ok(busy.tickRate > quiet.tickRate);
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

test('a bright mix shifts birth up, a dark one down', () => {
    assert.ok(mapToSim({ ...loud, centroid: 1 }, 1).birthShift > 0);
    assert.ok(mapToSim({ ...loud, centroid: 0 }, 1).birthShift < 0);
    assert.equal(mapToSim({ ...loud, centroid: 0.5 }, 1).birthShift, 0);
});

test('shiftBirth clamps to 0-26 and never inverts the window', () => {
    const rule = parseRule('4555');
    assert.deepEqual(shiftBirth(rule, 0), rule);
    assert.deepEqual(shiftBirth(rule, 1), { sMin: 4, sMax: 5, bMin: 6, bMax: 6 });
    assert.deepEqual(shiftBirth({ sMin: 4, sMax: 5, bMin: 0, bMax: 1 }, -5).bMin, 0);
    assert.deepEqual(shiftBirth({ sMin: 4, sMax: 5, bMin: 25, bMax: 26 }, 5).bMax, 26);

    const wide = shiftBirth({ sMin: 4, sMax: 5, bMin: 25, bMax: 26 }, 5);
    assert.ok(wide.bMin <= wide.bMax, 'birth window must stay ordered');
});

test('visual mapping stays inside its declared ranges', () => {
    for (const features of [silence, loud, { ...loud, level: 0.5, treble: 0.2 }]) {
        const v = mapToVisual(features, 1);
        assert.ok(v.voxelScale >= TUNING.voxelScale.min && v.voxelScale <= TUNING.voxelScale.max);
        assert.ok(v.emissive >= TUNING.emissive.min && v.emissive <= TUNING.emissive.max);
        assert.ok(v.hueShift >= 0 && v.hueShift <= TUNING.hueRange);
        assert.ok(v.dolly >= 0 && v.dolly <= TUNING.dolly);
    }
});

test('targets switch individual effects off', () => {
    const sim = mapToSim(loud, 1, { tickRate: true, burst: false, birthShift: false });
    assert.equal(sim.burst, null);
    assert.equal(sim.birthShift, 0);
    assert.equal(sim.tickRate, TUNING.tickRate.max);

    const visual = mapToVisual(loud, 1, { color: false, scale: false, camera: false });
    assert.equal(visual.hueShift, 0);
    assert.equal(visual.dolly, 0);
    assert.equal(visual.voxelScale, TUNING.voxelScale.max);
});
