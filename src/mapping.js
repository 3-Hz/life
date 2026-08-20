// Everything that decides how sound perturbs the automaton lives here, and
// nowhere else. Zero the sensitivity and the simulation is deterministic again.
//
// The features arriving here are already normalized against the signal's own
// recent range (see src/dynamics.js), so these curves shape a 0-1 input that
// genuinely uses 0-1, rather than one that pins at its ceiling on the first bar.

export const TUNING = {
    tickRate: { min: 2, max: 60 },
    // Sensitivity multiplies loudness after the response curve, so the slider is
    // a gain rather than a ceiling. The gain was 2.0 back when `level` was an
    // absolute measurement that clipped: it needed the headroom to reach the top
    // at all. Now that loudness spans its own range, that much gain would spend
    // most of a track against the ceiling instead.
    levelGain: 1.85,
    levelCurve: 1.15,
    // Loudness alone cannot tell a sustained pad from a busy break at the same
    // level. Onset density can, so it gets a share of the rate.
    fluxWeight: 0.3,
    burst: { radiusMin: 3, radiusMax: 7, density: 0.45 },
    birthShift: 1,        // how far the centroid may slide the birth window
    voxelScale: { min: 0.58, max: 1.0 },
    // How far density relief may shrink the voxels on top of that. A packed
    // lattice at full scale is one opaque block; the same lattice at half scale
    // is a lace you can see into.
    reliefDepth: 0.38,
    // The ceiling is far above 1.0 on purpose: the shader tone-maps now, so a
    // hard transient compresses instead of clipping to flat white.
    emissive: { min: 0.04, max: 1.15 },
    pulseWeight: 0.7,     // share of the glow that comes from transients, not level
    hueRange: 0.34,       // full centroid-driven hue swing, in turns, bipolar
    tintSat: { min: 0.12, max: 0.5, rest: 0.25 },
    dolly: 0.09,          // fraction of camera distance the level may pull in
    dollyPunch: 0.05,     // and how much further a hit may
    bandGain: 0.85,       // how brightly the spectrum lights its slab of lattice
    // All as a fraction of cells alive. Measured over 400 generations at 48³,
    // the shipped rules settle between 0.26 and 0.33 on their own, so pushing
    // back before that would be a permanent handicap on the rule rather than a
    // response to anything. `target` sits at the top of that spread: it is
    // audio-driven growth past what the automaton does unaided that this exists
    // to catch. Relief is separate and continuous, because legibility is a
    // question about the lattice in front of you, not about who filled it.
    density: {
        clear: 0.1, packed: 0.32,
        target: 0.3, band: 0.1, thin: 0.6, minBirthChance: 0.35,
    },
};

export const TARGETS = {
    tickRate: true,
    burst: true,
    birthShift: true,
    color: true,
    scale: true,
    camera: true,
};

// What the density controller returns when it is switched off, and the default
// for every caller that does not care about it.
export const NO_DENSITY = { burstScale: 1, birthChance: 1, relief: 0 };

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// How full the lattice is -> how hard to push back.
//
// Beat bursts inject cells with no idea how much is already there, so a dense
// rule under loud music packs the cube into a solid shell and everything
// interesting happens where nobody can see it. Three levers, weakest first:
// stop feeding it, then thin what it grows, then make what is there see-through.
//
// Thinning births rather than shifting the rule's windows is deliberate. Whether
// shifting a birth window adds or removes cells depends on the local neighbor
// count, so it fights back in exactly the crowded regions this is meant to open
// up; a birth roll works the same way under every rule.
export function densityControl(fill, enabled = true, tuning = TUNING.density) {
    if (!enabled) return NO_DENSITY;
    // 0 at the target, 1 at the top of the band, and negative below it.
    const over = (fill - tuning.target) / tuning.band;
    return {
        burstScale: clamp(1 - over, 0, 1),
        // Only bites past the band: inside it the rule is left entirely alone.
        birthChance: clamp(1 - (over - 1) * tuning.thin, tuning.minBirthChance, 1),
        relief: clamp((fill - tuning.clear) / (tuning.packed - tuning.clear), 0, 1),
    };
}

// Audio -> what the simulation does.
export function mapToSim(features, sensitivity, targets = TARGETS, density = NO_DENSITY) {
    const s = clamp(sensitivity, 0, 1);
    const energy = lerp(features.level, features.flux ?? 0, TUNING.fluxWeight) * s;

    const drive = clamp(energy * TUNING.levelGain, 0, 1) ** TUNING.levelCurve;
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
            density: TUNING.burst.density * lerp(0.5, 1, features.beatStrength) * s
                * density.burstScale,
            // Where it lands, as a height through the lattice: bright music
            // seeds near the ceiling, bass-heavy music near the floor. Scattering
            // them uniformly threw away the one thing the spectrum was saying.
            height: features.centroid,
        }
        : null;

    return { tickRate, birthShift, burst, birthChance: density.birthChance };
}

// Audio -> how it looks.
export function mapToVisual(features, sensitivity, targets = TARGETS, density = NO_DENSITY) {
    const s = clamp(sensitivity, 0, 1);
    const pulse = (features.pulse ?? 0) * s;

    // Mostly transient. Driving the glow from a band level alone left it sitting
    // at one value for a whole track -- measured at a flat 0.26 across every
    // loudness there is -- which is a lamp, not a reaction.
    const glow = lerp(features.mid * s, pulse, TUNING.pulseWeight);
    const scale = targets.scale
        ? lerp(TUNING.voxelScale.min, TUNING.voxelScale.max, features.level * s)
        : TUNING.voxelScale.max;

    return {
        // Bipolar around the base hue, so a mix that darkens moves the colour as
        // far as one that brightens. Keyed to the centroid rather than to treble
        // level, because where the energy sits is what actually changes over a
        // track; how much treble there is barely moves.
        hueShift: targets.color ? (features.centroid - 0.5) * TUNING.hueRange * s : 0,
        tintSat: targets.color
            ? lerp(TUNING.tintSat.min, TUNING.tintSat.max, features.treble * s)
            : TUNING.tintSat.rest,
        emissive: targets.color
            ? lerp(TUNING.emissive.min, TUNING.emissive.max, glow)
            : TUNING.emissive.min,
        bandGain: targets.color ? TUNING.bandGain * s : 0,
        // Density relief is not an audio effect, so it applies whatever the
        // targets say -- it is the lattice keeping itself legible.
        voxelScale: scale * (1 - density.relief * TUNING.reliefDepth),
        dolly: targets.camera
            ? features.level * TUNING.dolly * s + pulse * TUNING.dollyPunch
            : 0,
        pulse,
        bands: features.bands ?? null,
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
