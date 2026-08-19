// Everything that decides how sound perturbs the automaton lives here, and
// nowhere else. Zero the sensitivity and the simulation is deterministic again.

export const TUNING = {
    tickRate: { min: 2, max: 60 },
    // Sensitivity used to scale loudness before the response curve, which made
    // the slider a ceiling rather than a gain: at its default 60%, even maximum
    // loudness reached only 16 steps/sec. This gain restores headroom, while
    // still multiplying sensitivity so that zeroing the slider zeroes every
    // audio effect and the simulation stays deterministic.
    levelGain: 2.0,
    levelCurve: 1.2,
    burst: { radiusMin: 3, radiusMax: 6, density: 0.45 },
    birthShift: 1,        // how far the centroid may slide the birth window
    voxelScale: { min: 0.7, max: 1.0 },
    emissive: { min: 0.05, max: 0.55 },
    hueRange: 0.5,        // full-treble hue rotation, in turns
    dolly: 0.12,          // fraction of camera distance the level may pull in
};

export const TARGETS = {
    tickRate: true,
    burst: true,
    birthShift: true,
    color: true,
    scale: true,
    camera: true,
};

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Audio -> what the simulation does.
export function mapToSim(features, sensitivity, targets = TARGETS) {
    const s = clamp(sensitivity, 0, 1);
    const level = features.level * s;

    const drive = clamp(level * TUNING.levelGain, 0, 1) ** TUNING.levelCurve;
    const tickRate = targets.tickRate
        ? lerp(TUNING.tickRate.min, TUNING.tickRate.max, drive)
        : TUNING.tickRate.min + (TUNING.tickRate.max - TUNING.tickRate.min) * 0.35;

    // A bright mix nudges birth toward being easier, a dark one toward harder.
    const birthShift = targets.birthShift
        ? Math.round((features.centroid - 0.5) * 2 * TUNING.birthShift * s)
        : 0;

    const burst = targets.burst && features.beat
        ? {
            radius: lerp(TUNING.burst.radiusMin, TUNING.burst.radiusMax, features.beatStrength),
            density: TUNING.burst.density * lerp(0.5, 1, features.beatStrength) * s,
        }
        : null;

    return { tickRate, birthShift, burst };
}

// Audio -> how it looks.
export function mapToVisual(features, sensitivity, targets = TARGETS) {
    const s = clamp(sensitivity, 0, 1);
    return {
        hueShift: targets.color ? features.treble * TUNING.hueRange * s : 0,
        emissive: targets.color
            ? lerp(TUNING.emissive.min, TUNING.emissive.max, features.mid * s)
            : TUNING.emissive.min,
        voxelScale: targets.scale
            ? lerp(TUNING.voxelScale.min, TUNING.voxelScale.max, features.level * s)
            : TUNING.voxelScale.max,
        dolly: targets.camera ? features.level * TUNING.dolly * s : 0,
    };
}

// Applies the centroid's nudge without letting the window invert or leave 0-26.
export function shiftBirth(rule, shift) {
    if (!shift) return rule;
    const bMin = clamp(rule.bMin + shift, 0, 26);
    const bMax = clamp(rule.bMax + shift, 0, 26);
    if (bMin > bMax) return rule;
    return { ...rule, bMin, bMax };
}
