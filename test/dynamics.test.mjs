// The signal dynamics are pure, so they test in node like the rules do -- and
// they had better, because "does the visualization react" is decided here and
// nowhere else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveRange, Envelope, OnsetDetector, rate, smoothstep } from '../src/dynamics.js';

const FRAME = 1 / 60;

// Runs a signal through a range for `seconds`, returning every output.
function run(range, seconds, signal, dt = FRAME) {
    const out = [];
    for (let t = 0; t < seconds; t += dt) out.push(range.push(signal(t), dt));
    return out;
}

const last = (values, n) => values.slice(-n);
const min = (values) => Math.min(...values);
const max = (values) => Math.max(...values);

//-------FRAME-RATE INDEPENDENCE-------
test('the same elapsed time decays the same amount at any frame rate', () => {
    // A per-frame coefficient would make every effect twice as fast at 120fps.
    for (const tau of [0.05, 0.3, 2]) {
        const settle = (dt) => {
            let v = 1;
            for (let t = 0; t < 1; t += dt) v += (0 - v) * rate(dt, tau);
            return v;
        };
        assert.ok(Math.abs(settle(1 / 30) - settle(1 / 144)) < 0.01,
            `tau=${tau}: ${settle(1 / 30)} vs ${settle(1 / 144)}`);
    }
});

test('rate is bounded and degenerate inputs do not escape it', () => {
    assert.equal(rate(0, 0.5), 0);
    assert.equal(rate(1, 0), 1, 'a zero time constant means "go all the way"');
    assert.ok(rate(10, 0.01) <= 1);
    assert.ok(rate(-1, 0.5) === 0, 'a negative dt must not run the filter backwards');
});

test('smoothstep clamps outside its edges', () => {
    assert.equal(smoothstep(0, 1, -5), 0);
    assert.equal(smoothstep(0, 1, 5), 1);
    assert.equal(smoothstep(0, 1, 0.5), 0.5);
    assert.equal(smoothstep(2, 2, 3), 1, 'a zero-width edge must not divide by zero');
});

//-------ADAPTIVE RANGE-------
// This is the regression for the bug the whole change exists to fix.
test('a loud signal high above any fixed ceiling still uses the full range', () => {
    // Alternating between two loud levels, both of which an absolute scale would
    // have clipped to the same 1.0. Nothing about this may read as constant.
    const range = new AdaptiveRange({ attack: 0.1, release: 6, minSpan: 10, start: -20 });
    const out = run(range, 12, (t) => (Math.floor(t * 2) % 2 ? -18 : -34));
    const settled = last(out, 300);
    assert.ok(min(settled) < 0.1, `quiet half should read low, got ${min(settled)}`);
    assert.ok(max(settled) > 0.9, `loud half should read high, got ${max(settled)}`);
});

test('a steady signal settles mid-scale, not at either end', () => {
    // Widening the window by clamping the divisor instead of expanding around
    // the midpoint sends this to 0: the floor creeps up to meet the signal and
    // a sustained note reads as silence.
    const range = new AdaptiveRange({ attack: 0.1, release: 4, minSpan: 10, start: -30 });
    const out = run(range, 40, () => -30);
    assert.ok(Math.abs(out.at(-1) - 0.5) < 0.05, `settled at ${out.at(-1)}`);
});

test('the range reopens after the music changes level', () => {
    const range = new AdaptiveRange({ attack: 0.1, release: 4, minSpan: 10, start: -20 });
    run(range, 12, () => -15);                       // a loud section
    const drop = run(range, 1, () => -45);           // then a quiet one
    assert.ok(drop.at(-1) < 0.15, `the drop should read quiet, got ${drop.at(-1)}`);
    const after = run(range, 30, () => -45);         // which then becomes the norm
    assert.ok(after.at(-1) > 0.35,
        `a sustained quiet section should recover its own range, got ${after.at(-1)}`);
});

test('output stays inside 0-1 and never goes NaN, whatever it is fed', () => {
    const range = new AdaptiveRange({ minSpan: 1 });
    const out = run(range, 5, (t) => (t < 1 ? 0 : t < 2 ? 1e6 : t < 3 ? -1e6 : 0));
    for (const v of out) {
        assert.ok(Number.isFinite(v), 'non-finite output');
        assert.ok(v >= 0 && v <= 1, `out of range: ${v}`);
    }
});

test('reset clears the window so a new source starts fresh', () => {
    const range = new AdaptiveRange({ minSpan: 10, start: -30 });
    run(range, 10, () => -10);
    range.reset();
    assert.equal(range.lo, range.hi);
    assert.equal(range.push(-30, FRAME), 0.5, 'the first frame after a reset is mid-scale');
});

//-------ENVELOPE-------
test('an envelope snaps up on a trigger and eases back down', () => {
    const env = new Envelope({ attack: 0.01, release: 0.3 });
    env.trigger(1);
    assert.equal(env.value, 1);

    env.push(0, 0.1);
    const afterShort = env.value;
    assert.ok(afterShort < 1 && afterShort > 0.5, `decayed to ${afterShort} in 100ms`);

    for (let t = 0; t < 1; t += FRAME) env.push(0, FRAME);
    assert.ok(env.value < 0.05, `should be spent after a second, at ${env.value}`);
});

test('a trigger during a decay restarts it rather than being swallowed', () => {
    const env = new Envelope({ release: 0.3 });
    env.trigger(1);
    for (let t = 0; t < 0.2; t += FRAME) env.push(0, FRAME);
    const faded = env.value;
    env.trigger(0.6);
    assert.equal(env.value, 0.6);
    assert.ok(0.6 > faded, 'precondition: the new hit is louder than what is left');

    env.trigger(0.1);
    assert.equal(env.value, 0.6, 'a quieter hit must not cut the loud one short');
});

//-------ONSET DETECTION-------
// The other half of the regression: the old detector divided a fast bass
// envelope by a slow one, so on loud material -- where both clipped -- the ratio
// went to 1 and beats stopped exactly where the music had the most of them.
test('onsets are found in transients riding on a loud sustained signal', () => {
    const detector = new OnsetDetector();
    const period = 0.5;
    let hits = 0;
    for (let t = 0; t < 4; t += FRAME) {
        const phase = t % period;
        const flux = phase < 0.05 ? 240 : 60; // a big spike over a high floor
        if (detector.push(flux, FRAME) > 0) hits++;
    }
    assert.ok(hits >= 6, `expected roughly one onset per beat over 4s, got ${hits}`);
    assert.ok(hits <= 10, `and not a shower of them, got ${hits}`);
});

test('a flat loud signal is not a stream of beats', () => {
    const detector = new OnsetDetector();
    let hits = 0;
    for (let t = 0; t < 4; t += FRAME) {
        if (detector.push(200, FRAME) > 0) hits++;
    }
    assert.equal(hits, 0, `a constant signal has no onsets in it, got ${hits}`);
});

test('the first frame of a signal is not reported as a beat', () => {
    const detector = new OnsetDetector();
    assert.equal(detector.push(500, FRAME), 0);
});

test('silence produces nothing', () => {
    const detector = new OnsetDetector();
    let hits = 0;
    for (let t = 0; t < 3; t += FRAME) if (detector.push(0, FRAME) > 0) hits++;
    assert.equal(hits, 0);
});

test('a bigger transient reports a stronger onset', () => {
    const strengthOf = (spike) => {
        const detector = new OnsetDetector();
        let best = 0;
        for (let t = 0; t < 2; t += FRAME) {
            const flux = (t % 0.5) < 0.05 ? spike : 20;
            best = Math.max(best, detector.push(flux, FRAME));
        }
        return best;
    };
    assert.ok(strengthOf(40) < strengthOf(400));
});

test('onsets are rate limited, so one hit is one beat', () => {
    const detector = new OnsetDetector({ minInterval: 0.2 });
    let hits = 0;
    // Rising every single frame: without the limit this would fire 120 times.
    for (let t = 0, v = 10; t < 2; t += FRAME, v += 5) {
        if (detector.push(v, FRAME) > 0) hits++;
    }
    assert.ok(hits <= 2 / 0.2, `minInterval must cap the count, got ${hits}`);
});
