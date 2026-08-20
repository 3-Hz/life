// Signal dynamics: the pieces that turn an absolute measurement into one that
// keeps moving.
//
// Pure like automata.ts -- no DOM, no Web Audio, no imports -- because this is
// where "reacts to the music" is actually decided, and that deserves to be
// testable in node rather than only by ear.

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// Fraction of the way to a target after dt seconds for a one-pole filter with
// time constant tau. Written in seconds rather than as a per-frame coefficient
// so the response does not change when the frame rate does -- a beat has to
// decay over the same 300ms at 30fps as at 120.
export function rate(dt: number, tau: number): number {
    if (!(tau > 0)) return 1;
    return 1 - Math.exp(-Math.max(dt, 0) / tau);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
    if (edge1 === edge0) return x < edge0 ? 0 : 1;
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

// Maps a signal onto 0-1 against its own recent range instead of against an
// absolute ceiling.
//
// This is the fix for the whole app looking pinned. Every feature used to be an
// absolute measurement compared against a fixed maximum, so any real music sat
// hard against that maximum and stopped saying anything: loudness clipped, the
// bass band clipped, and the beat detector -- which divides one clipped value by
// another -- stopped finding beats exactly when the music was busiest.
//
// The floor falls fast and rises slowly; the ceiling rises fast and falls
// slowly. So a transient reaches the top of the range immediately, and the range
// then reopens over the following seconds. A steady signal converges on the
// middle rather than on either end, which is what makes a quiet passage read
// quiet again a few seconds after a loud one.
export class AdaptiveRange {
    attack: number;
    release: number;
    minSpan: number;
    start: number;
    lo!: number;
    hi!: number;
    value!: number;

    constructor({ attack = 0.1, release = 6, minSpan = 1, start = 0 }: {
        attack?: number;
        release?: number;
        minSpan?: number;
        start?: number;
    } = {}) {
        this.attack = attack;
        this.release = release;
        // Keeps a near-constant signal from being amplified into full-scale
        // noise: below this width the range is treated as one flat value.
        this.minSpan = minSpan;
        this.start = start;
        this.reset();
    }

    reset(value: number = this.start): this {
        this.lo = value;
        this.hi = value;
        this.value = 0.5;
        return this;
    }

    push(v: number, dt: number): number {
        const fast = rate(dt, this.attack);
        const slow = rate(dt, this.release);
        this.hi += (v - this.hi) * (v > this.hi ? fast : slow);
        this.lo += (v - this.lo) * (v < this.lo ? fast : slow);

        // Widen around the midpoint, never by dragging one edge: clamping the
        // divisor instead would send a steady signal to 0 as the floor crept up
        // to meet it, which reads as silence during a sustained note.
        let { lo, hi } = this;
        const span = hi - lo;
        if (span < this.minSpan) {
            const mid = (hi + lo) / 2;
            lo = mid - this.minSpan / 2;
            hi = mid + this.minSpan / 2;
        }
        this.value = clamp((v - lo) / (hi - lo), 0, 1);
        return this.value;
    }
}

// Asymmetric envelope follower: snaps up, eases down. What makes a beat read as
// a hit that fades rather than a step change.
export class Envelope {
    attack: number;
    release: number;
    value: number;

    constructor({ attack = 0.02, release = 0.3, value = 0 }: {
        attack?: number;
        release?: number;
        value?: number;
    } = {}) {
        this.attack = attack;
        this.release = release;
        this.value = value;
    }

    reset(value = 0): this {
        this.value = value;
        return this;
    }

    // Jump straight to v if that is louder than where we already are, so a hit
    // during a decay restarts it instead of being swallowed by it.
    trigger(v: number): number {
        if (v > this.value) this.value = v;
        return this.value;
    }

    push(target: number, dt: number): number {
        const tau = target > this.value ? this.attack : this.release;
        this.value += (target - this.value) * rate(dt, tau);
        return this.value;
    }
}

// Onset detection from spectral flux against an adaptive threshold.
//
// It replaces a fast-bass-over-slow-bass ratio, which had the failure the rest
// of this file exists to avoid: both envelopes clipped at the same ceiling on
// loud material, the ratio went to 1, and the app stopped seeing beats in
// exactly the music that has the most of them.
export class OnsetDetector {
    memory: number;
    sensitivity: number;
    minInterval: number;
    floor: number;
    warmup: number;
    mean!: number;
    dev!: number;
    previous!: number;
    since!: number;
    age!: number;

    constructor({ memory = 0.7, sensitivity = 1.4, minInterval = 0.11, floor = 0.02,
                  warmup = 0.25 }: {
        memory?: number;
        sensitivity?: number;
        minInterval?: number;
        floor?: number;
        warmup?: number;
    } = {}) {
        this.memory = memory;
        this.sensitivity = sensitivity;
        this.minInterval = minInterval;
        this.floor = floor;
        // Until the running statistics have seen anything, every value is
        // infinitely far above the mean. Without this the first frame of any
        // signal -- including the moment a source connects -- reports a beat.
        this.warmup = warmup;
        this.reset();
    }

    reset(): this {
        this.mean = 0;
        this.dev = 0;
        this.previous = 0;
        this.since = this.minInterval;
        this.age = 0;
        return this;
    }

    // Returns 0 for no onset, otherwise how far above the threshold it landed,
    // on 0-1. Flux is expected non-negative and in any consistent unit: the
    // threshold is built from the signal's own statistics, so scale cancels.
    push(flux: number, dt: number): number {
        this.since += dt;
        this.age += dt;
        const threshold = this.mean + this.sensitivity * this.dev + this.floor;
        // Rising as well as loud, so one sustained crescendo fires once at its
        // leading edge rather than on every frame it stays above the line.
        const rising = flux > this.previous;
        let strength = 0;
        if (flux > threshold && rising && this.since >= this.minInterval
            && this.age >= this.warmup) {
            strength = clamp((flux - threshold) / (this.dev * 3 + this.floor), 0, 1);
            this.since = 0;
        }

        const k = rate(dt, this.memory);
        this.dev += (Math.abs(flux - this.mean) - this.dev) * k;
        this.mean += (flux - this.mean) * k;
        this.previous = flux;
        return strength;
    }
}
