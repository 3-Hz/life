// Audio capture and per-frame feature extraction.
//
// Reaching the song that is actually playing is the awkward part of this app.
// getUserMedia only ever reaches a microphone, and an embedded player's audio
// lives in a cross-origin iframe that Web Audio cannot touch -- which leaves
// screen capture, and that does not exist on any mobile browser.
//
// The way out is to stop trying to capture someone else's player and own the
// element instead. Audio served with Access-Control-Allow-Origin loads into our
// own <audio>, and createMediaElementSource reads it directly: no picker, no
// permission, every browser. That is what useStream is for, and why Audius
// rather than SoundCloud sits behind it.
//
// Every feature here is reported *relative to the last few seconds of this
// signal*, not against an absolute ceiling. See AdaptiveRange in dynamics.ts for
// why: absolute measurements clip on any real master, and a clipped feature
// stops saying anything at all.

import { AdaptiveRange, Envelope, OnsetDetector, clamp, smoothstep } from './dynamics.js';
import type { AudioFeatures } from './mapping.js';

export const SOURCES = {
    STREAM: 'stream',
    SYSTEM: 'system',
    MIC: 'mic',
    FILE: 'file',
    TONE: 'tone',
} as const;

export type AudioSource = (typeof SOURCES)[keyof typeof SOURCES];

export const SOURCE_LABELS: Record<AudioSource, string> = {
    [SOURCES.STREAM]: 'Audius',
    [SOURCES.SYSTEM]: 'System / other tab',
    [SOURCES.MIC]: 'Microphone',
    [SOURCES.FILE]: 'Audio file',
    [SOURCES.TONE]: 'Test tone',
};

const FFT_SIZE = 2048;

// Log-spaced analysis bands. Twenty-four is enough to read as a spectrum when
// stood up inside the lattice, and cheap enough to normalize each one
// separately.
export const BAND_COUNT = 24;
const BAND_LO_HZ = 40;
const BAND_HI_HZ = 12000;

// Anything quieter than this is silence as far as the dB maths is concerned;
// getFloatFrequencyData reports -Infinity for a digitally silent bin.
const DB_FLOOR = -110;
// Weighting reference for the centroid: bins below this contribute nothing.
const DB_REF = -85;

// The one place absolute loudness still matters. Normalizing against a signal's
// own range has no notion of silence -- silence measured against silence would
// come out mid-scale and the app would behave as though music were playing --
// so an absolute gate multiplies every feature.
const GATE_LO_DB = -72;
const GATE_HI_DB = -46;

// A frame that arrives after the tab was backgrounded should not flush every
// running average, and a zero-length one must not divide anything.
const DT_MIN = 1 / 240;
const DT_MAX = 0.25;

export class AudioEngine {
    ctx: AudioContext | null;
    analyser: AnalyserNode | null;
    source: AudioNode | null;
    sourceKind: AudioSource | null;
    stream: MediaStream | null;
    element: HTMLAudioElement | null;
    error: string | null;
    freq: Float32Array<ArrayBuffer> | null;
    time: Uint8Array<ArrayBuffer> | null;
    bands: Float32Array<ArrayBuffer>;
    private _bandDb: Float32Array<ArrayBuffer>;
    private _prevBandDb: Float32Array<ArrayBuffer> | null;
    private _bandBins: Array<[number, number]> | null;
    private _bandLogHz: Float32Array<ArrayBuffer>;
    private _ranges: Record<'level' | 'bass' | 'mid' | 'treble' | 'centroid' | 'flux', AdaptiveRange>;
    private _bandRanges: AdaptiveRange[];
    private _onset: OnsetDetector;
    private _pulse: Envelope;

    constructor() {
        this.ctx = null;
        this.analyser = null;
        this.source = null;
        this.sourceKind = null;
        this.stream = null;
        this.element = null;
        this.error = null;

        this.freq = null;
        this.time = null;
        this.bands = new Float32Array(BAND_COUNT);
        this._bandDb = new Float32Array(BAND_COUNT);
        this._prevBandDb = null;   // null until the first frame has been read
        this._bandBins = null;     // [lo, hi] per band, rebuilt when the rate changes
        this._bandLogHz = new Float32Array(BAND_COUNT);

        // One adaptive window per feature, so a bright track and a bassy one
        // both use their full range instead of each pinning a different axis.
        this._ranges = {
            level: new AdaptiveRange({ attack: 0.08, release: 5, minSpan: 9, start: DB_FLOOR }),
            bass: new AdaptiveRange({ attack: 0.08, release: 6, minSpan: 10, start: DB_FLOOR }),
            mid: new AdaptiveRange({ attack: 0.08, release: 6, minSpan: 10, start: DB_FLOOR }),
            treble: new AdaptiveRange({ attack: 0.08, release: 6, minSpan: 10, start: DB_FLOOR }),
            // Slower, because the centroid drives hue and rule shift: those want
            // to follow the arrangement, not every hi-hat.
            centroid: new AdaptiveRange({ attack: 0.5, release: 9, minSpan: 0.35, start: 0.5 }),
            flux: new AdaptiveRange({ attack: 0.05, release: 4, minSpan: 12 }),
        };
        this._bandRanges = Array.from({ length: BAND_COUNT }, () => new AdaptiveRange({
            attack: 0.06, release: 5, minSpan: 12, start: DB_FLOOR,
        }));
        this._onset = new OnsetDetector();
        this._pulse = new Envelope({ attack: 0.008, release: 0.3 });
    }

    get active(): boolean {
        return this.source !== null;
    }

    // AudioContext starts suspended until a gesture, so every entry point here
    // is called from a click handler.
    async ensureContext(): Promise<AudioContext> {
        if (!this.ctx) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) throw new Error('Web Audio is not available in this browser');
            this.ctx = new Ctor();
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = FFT_SIZE;
            // No smoothing here. The analyser's own low-pass blunts exactly the
            // transients the onset detector is looking for; smoothing belongs
            // downstream, per feature, where each one can pick its own rate.
            this.analyser.smoothingTimeConstant = 0;
            // Float rather than byte data: getByteFrequencyData compresses the
            // spectrum into minDecibels..maxDecibels and clips everything above
            // -30dB flat, which is where loud music lives.
            this.freq = new Float32Array(this.analyser.frequencyBinCount);
            this.time = new Uint8Array(this.analyser.fftSize);
            this._buildBands();
        }
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        return this.ctx;
    }

    stop(): void {
        if (this.source) {
            try { this.source.disconnect(); } catch { /* already gone */ }
        }
        if (this.stream) {
            for (const track of this.stream.getTracks()) track.stop();
        }
        if (this.element) {
            this.element.pause();
            if (this.element.src.startsWith('blob:')) URL.revokeObjectURL(this.element.src);
            this.element = null;
        }
        this.source = null;
        this.sourceKind = null;
        this.stream = null;
        this.resetFeatures();
    }

    // A new source is a new signal. Carrying the old one's range across would
    // make the first seconds of the new one read as whatever the last one was
    // relative to -- a quiet track after a loud one would look like silence.
    resetFeatures(): void {
        for (const range of Object.values(this._ranges)) range.reset();
        for (const range of this._bandRanges) range.reset();
        this._onset.reset();
        this._pulse.reset();
        this._prevBandDb = null;
        this.bands.fill(0);
    }

    // Screen/tab share with audio: the route to a song playing somewhere this
    // page cannot reach, such as a Spotify or YouTube tab. Desktop only -- see
    // the disable in ui.ts.
    async useDisplayMedia(): Promise<AudioSource> {
        await this.ensureContext();
        if (!navigator.mediaDevices?.getDisplayMedia) {
            throw new Error('getDisplayMedia is unavailable — try Chrome, or use an audio file');
        }

        // Video is requested only because audio-only display capture is widely
        // rejected, and the track is kept alive because Chrome ends the whole
        // share session when it stops. It is never rendered.
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });

        if (stream.getAudioTracks().length === 0) {
            for (const track of stream.getTracks()) track.stop();
            throw new Error('No audio in that share — re-pick and tick "Share tab audio"');
        }

        this.stop();
        this.stream = stream;
        this.source = this.ctx!.createMediaStreamSource(stream);
        this.source.connect(this.analyser!);
        this.sourceKind = SOURCES.SYSTEM;
        // Captured audio is not routed to the destination: it is already
        // audible at its origin, and echoing it back would double it.
        return SOURCES.SYSTEM;
    }

    async useMicrophone(): Promise<AudioSource> {
        await this.ensureContext();
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        this.stop();
        this.stream = stream;
        this.source = this.ctx!.createMediaStreamSource(stream);
        this.source.connect(this.analyser!);
        this.sourceKind = SOURCES.MIC;
        return SOURCES.MIC;
    }

    // A track from a CORS-enabled host, played through an element this page
    // owns. No picker and no permission on any platform -- the only song source
    // that works on a phone.
    //
    // onEnded is how the panel advances a queue: the element is replaced on
    // every track, so a listener bound here dies with it and cannot leak.
    async useStream(url: string, onEnded?: () => void): Promise<AudioSource> {
        await this.ensureContext();
        this.stop();
        const element = new Audio();
        // Before src, not after. Set afterwards, the request has already gone
        // out without CORS mode, and a MediaElementAudioSourceNode over an
        // element it is not allowed to read answers with silence rather than an
        // error -- audible music, dead analyser, nothing in the console.
        element.crossOrigin = 'anonymous';
        element.src = url;
        element.loop = false;
        if (onEnded) element.addEventListener('ended', onEnded);
        this.element = element;
        this.source = this.ctx!.createMediaElementSource(element);
        this.source.connect(this.analyser!);
        this.source.connect(this.ctx!.destination); // this one we do want to hear
        await element.play();
        this.sourceKind = SOURCES.STREAM;
        return SOURCES.STREAM;
    }

    // The only full-fidelity path with no picker, which is what makes it the
    // source used for tuning and for the headless smoke check.
    async useFile(file: File): Promise<AudioSource> {
        await this.ensureContext();
        this.stop();
        const element = new Audio();
        element.crossOrigin = 'anonymous';
        element.src = URL.createObjectURL(file);
        element.loop = true;
        this.element = element;
        this.source = this.ctx!.createMediaElementSource(element);
        this.source.connect(this.analyser!);
        this.source.connect(this.ctx!.destination); // this one we do want to hear
        await element.play();
        this.sourceKind = SOURCES.FILE;
        return SOURCES.FILE;
    }

    // A wobbling tone plus noise bursts, so the app demonstrates itself with no
    // permissions granted at all.
    async useTestTone(): Promise<AudioSource> {
        await this.ensureContext();
        this.stop();
        const ctx = this.ctx!;
        const out = ctx.createGain();
        out.gain.value = 1;

        const bass = ctx.createOscillator();
        bass.type = 'sine';
        bass.frequency.value = 55;
        const bassGain = ctx.createGain();
        bassGain.gain.value = 1;
        bass.connect(bassGain).connect(out);

        // A slow LFO pumping the bass gives the beat detector something to find.
        const lfo = ctx.createOscillator();
        lfo.type = 'square';
        lfo.frequency.value = 2;
        const lfoDepth = ctx.createGain();
        lfoDepth.gain.value = 0.9;
        lfo.connect(lfoDepth).connect(bassGain.gain);

        const lead = ctx.createOscillator();
        lead.type = 'sawtooth';
        lead.frequency.value = 440;
        const leadGain = ctx.createGain();
        leadGain.gain.value = 0.25;
        lead.connect(leadGain).connect(out);

        const sweep = ctx.createOscillator();
        sweep.type = 'sine';
        sweep.frequency.value = 0.11;
        const sweepDepth = ctx.createGain();
        sweepDepth.gain.value = 300;
        sweep.connect(sweepDepth).connect(lead.frequency);

        // The analyser gets the full-strength signal; the speakers get a
        // polite fraction of it. Otherwise a comfortable listening level means
        // a limp reaction.
        out.connect(this.analyser!);
        const monitor = ctx.createGain();
        monitor.gain.value = 0.12;
        out.connect(monitor).connect(ctx.destination);
        for (const node of [bass, lfo, lead, sweep]) node.start();

        this.source = out;
        this.sourceKind = SOURCES.TONE;
        return SOURCES.TONE;
    }

    //-------BANDS-------
    // Log-spaced band edges, in bins. Built once per context: they depend only
    // on the sample rate and the FFT size, neither of which changes.
    private _buildBands(): void {
        const ctx = this.ctx!;
        const analyser = this.analyser!;
        const binHz = ctx.sampleRate / analyser.fftSize;
        const bins = analyser.frequencyBinCount;
        const ratio = Math.log(BAND_HI_HZ / BAND_LO_HZ) / BAND_COUNT;
        this._bandBins = [];
        for (let b = 0; b < BAND_COUNT; b++) {
            const loHz = BAND_LO_HZ * Math.exp(ratio * b);
            const hiHz = BAND_LO_HZ * Math.exp(ratio * (b + 1));
            const lo = clamp(Math.floor(loHz / binHz), 0, bins - 1);
            // The lowest bands are narrower than one bin at this resolution, so
            // several of them end up reading the same one. That is harmless --
            // they simply move together -- and cheaper than a second FFT.
            const hi = clamp(Math.max(lo, Math.ceil(hiHz / binHz) - 1), 0, bins - 1);
            this._bandBins.push([lo, hi]);
            this._bandLogHz[b] = Math.log2(Math.sqrt(loHz * hiHz));
        }
    }

    //-------FEATURES-------
    // Called once per animation frame. Returns normalized 0-1 values, each one
    // measured against this signal's own recent range.
    features(dt = 1 / 60): AudioFeatures {
        if (!this.active) return silentFeatures(this.bands);
        const step = clamp(dt, DT_MIN, DT_MAX);

        const analyser = this.analyser!;
        const freq = this.freq!;
        const time = this.time!;
        analyser.getFloatFrequencyData(freq);
        analyser.getByteTimeDomainData(time);

        const bandDb = this._bandDb;
        for (let b = 0; b < BAND_COUNT; b++) {
            const [lo, hi] = this._bandBins![b];
            let sum = 0;
            for (let i = lo; i <= hi; i++) sum += Math.max(freq[i], DB_FLOOR);
            bandDb[b] = sum / (hi - lo + 1);
        }

        // Spectral flux: how much of the spectrum got louder since the last
        // frame, as a rate so the number means the same thing at any frame rate.
        let flux = 0;
        if (this._prevBandDb) {
            for (let b = 0; b < BAND_COUNT; b++) {
                const rise = bandDb[b] - this._prevBandDb[b];
                if (rise > 0) flux += rise;
            }
            flux = flux / BAND_COUNT / step;
        } else {
            this._prevBandDb = new Float32Array(BAND_COUNT);
        }
        this._prevBandDb!.set(bandDb);

        // Centroid over log frequency, weighted by how far each band stands
        // above the noise floor. Log spacing is what makes an octave shift move
        // it by the same amount wherever it happens.
        let weighted = 0, total = 0;
        for (let b = 0; b < BAND_COUNT; b++) {
            const w = Math.max(0, bandDb[b] - DB_REF);
            weighted += w * this._bandLogHz[b];
            total += w;
        }
        const centroidHz = total > 0
            ? (weighted / total - Math.log2(BAND_LO_HZ)) / Math.log2(BAND_HI_HZ / BAND_LO_HZ)
            : 0.5;

        let sumSquares = 0;
        for (let i = 0; i < time.length; i++) {
            const v = (time[i] - 128) / 128;
            sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / time.length);
        const levelDb = Math.max(DB_FLOOR, 20 * Math.log10(rms || 1e-9));

        // The gate, and the only absolute judgement in here.
        const gate = smoothstep(GATE_LO_DB, GATE_HI_DB, levelDb);

        const ranges = this._ranges;
        const level = ranges.level.push(levelDb, step) * gate;
        const bass = ranges.bass.push(this._binMeanDb(20, 160), step) * gate;
        const mid = ranges.mid.push(this._binMeanDb(160, 2000), step) * gate;
        const treble = ranges.treble.push(this._binMeanDb(2000, 8000), step) * gate;
        const centroid = ranges.centroid.push(centroidHz, step);
        const fluxNorm = ranges.flux.push(flux, step) * gate;

        for (let b = 0; b < BAND_COUNT; b++) {
            this.bands[b] = this._bandRanges[b].push(bandDb[b], step) * gate;
        }

        const beatStrength = this._onset.push(flux, step) * gate;
        const beat = beatStrength > 0;
        if (beat) this._pulse.trigger(beatStrength);
        this._pulse.push(0, step);

        return {
            bass, mid, treble,
            level,
            centroid,
            flux: fluxNorm,
            beat,
            beatStrength,
            pulse: this._pulse.value,
            bands: this.bands,
        };
    }

    // Mean dB across a frequency span, straight off the FFT. Used for the three
    // broad bands, which want their own edges rather than the log band grid's.
    private _binMeanDb(loHz: number, hiHz: number): number {
        const analyser = this.analyser!;
        const freq = this.freq!;
        const binHz = this.ctx!.sampleRate / analyser.fftSize;
        const lo = clamp(Math.floor(loHz / binHz), 0, freq.length - 1);
        const hi = clamp(Math.ceil(hiHz / binHz), lo, freq.length - 1);
        let sum = 0;
        for (let i = lo; i <= hi; i++) sum += Math.max(freq[i], DB_FLOOR);
        return sum / (hi - lo + 1);
    }
}

// Shared shape for "no audio", so callers never have to test for it. The
// centroid rests at 0.5 rather than 0 because it is the one bipolar feature:
// zero is "as dark as this gets", which would hold the rule's birth window
// shifted down the whole time nothing is connected.
function silentFeatures(bands: Float32Array): AudioFeatures {
    return {
        bass: 0, mid: 0, treble: 0, level: 0, centroid: 0.5, flux: 0,
        beat: false, beatStrength: 0, pulse: 0, bands,
    };
}
