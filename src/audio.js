// Audio capture and per-frame feature extraction.
//
// Reaching the song that is actually playing is the awkward part of this app.
// getUserMedia only ever reaches a microphone, and an embedded player's audio
// lives in a cross-origin iframe that Web Audio cannot touch. getDisplayMedia
// is the only route to either, so most sources below funnel through it.

export const SOURCES = {
    SYSTEM: 'system',
    TAB: 'tab',
    MIC: 'mic',
    FILE: 'file',
    TONE: 'tone',
};

export const SOURCE_LABELS = {
    [SOURCES.SYSTEM]: 'System / other tab',
    [SOURCES.TAB]: 'This tab (SoundCloud)',
    [SOURCES.MIC]: 'Microphone',
    [SOURCES.FILE]: 'Audio file',
    [SOURCES.TONE]: 'Test tone',
};

const FFT_SIZE = 2048;

export class AudioEngine {
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

        // Beat detection state: a fast and a slow envelope of bass energy.
        this._bassFast = 0;
        this._bassSlow = 0;
        this._level = 0;
        this._lastBeat = 0;
    }

    get active() {
        return this.source !== null;
    }

    // AudioContext starts suspended until a gesture, so every entry point here
    // is called from a click handler.
    async ensureContext() {
        if (!this.ctx) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) throw new Error('Web Audio is not available in this browser');
            this.ctx = new Ctor();
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = FFT_SIZE;
            this.analyser.smoothingTimeConstant = 0.6;
            this.freq = new Uint8Array(this.analyser.frequencyBinCount);
            this.time = new Uint8Array(this.analyser.fftSize);
        }
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        return this.ctx;
    }

    stop() {
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
    }

    // Screen/tab share with audio. preferCurrentTab narrows the picker to this
    // page, which is how the in-page SoundCloud widget gets captured -- Chrome
    // offers tab audio on every platform, unlike "share system audio".
    async useDisplayMedia({ preferCurrentTab = false } = {}) {
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
            preferCurrentTab,
        });

        if (stream.getAudioTracks().length === 0) {
            for (const track of stream.getTracks()) track.stop();
            throw new Error('No audio in that share — re-pick and tick "Share tab audio"');
        }

        this.stop();
        this.stream = stream;
        this.source = this.ctx.createMediaStreamSource(stream);
        this.source.connect(this.analyser);
        this.sourceKind = preferCurrentTab ? SOURCES.TAB : SOURCES.SYSTEM;
        // Captured audio is not routed to the destination: it is already
        // audible at its origin, and echoing it back would double it.
        return this.sourceKind;
    }

    async useMicrophone() {
        await this.ensureContext();
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        this.stop();
        this.stream = stream;
        this.source = this.ctx.createMediaStreamSource(stream);
        this.source.connect(this.analyser);
        this.sourceKind = SOURCES.MIC;
        return this.sourceKind;
    }

    // The only full-fidelity path with no picker, which is what makes it the
    // source used for tuning and for the headless smoke check.
    async useFile(file) {
        await this.ensureContext();
        this.stop();
        const element = new Audio();
        element.src = URL.createObjectURL(file);
        element.loop = true;
        element.crossOrigin = 'anonymous';
        this.element = element;
        this.source = this.ctx.createMediaElementSource(element);
        this.source.connect(this.analyser);
        this.source.connect(this.ctx.destination); // this one we do want to hear
        await element.play();
        this.sourceKind = SOURCES.FILE;
        return this.sourceKind;
    }

    // A wobbling tone plus noise bursts, so the app demonstrates itself with no
    // permissions granted at all.
    async useTestTone() {
        await this.ensureContext();
        this.stop();
        const ctx = this.ctx;
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
        out.connect(this.analyser);
        const monitor = ctx.createGain();
        monitor.gain.value = 0.12;
        out.connect(monitor).connect(ctx.destination);
        for (const node of [bass, lfo, lead, sweep]) node.start();

        this.source = out;
        this.sourceKind = SOURCES.TONE;
        return this.sourceKind;
    }

    //-------FEATURES-------
    // Called once per animation frame. Returns normalized 0-1 values.
    features(now = performance.now()) {
        const silent = {
            bass: 0, mid: 0, treble: 0, level: 0, centroid: 0,
            beat: false, beatStrength: 0,
        };
        if (!this.active) return silent;

        this.analyser.getByteFrequencyData(this.freq);
        this.analyser.getByteTimeDomainData(this.time);

        const binHz = this.ctx.sampleRate / this.analyser.fftSize;
        const bass = bandMean(this.freq, 20, 160, binHz);
        const mid = bandMean(this.freq, 160, 2000, binHz);
        const treble = bandMean(this.freq, 2000, 8000, binHz);

        let sumSquares = 0;
        for (let i = 0; i < this.time.length; i++) {
            const v = (this.time[i] - 128) / 128;
            sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / this.time.length);
        this._level += (rms - this._level) * 0.2;

        // Spectral centroid, normalized against 8kHz rather than Nyquist so the
        // usable range of real music spreads across 0-1 instead of hugging zero.
        let weighted = 0, total = 0;
        for (let i = 0; i < this.freq.length; i++) {
            const m = this.freq[i];
            weighted += m * i * binHz;
            total += m;
        }
        const centroid = total > 0 ? Math.min(1, weighted / total / 8000) : 0;

        this._bassFast += (bass - this._bassFast) * 0.35;
        this._bassSlow += (bass - this._bassSlow) * 0.02;
        let beat = false;
        let beatStrength = 0;
        const ratio = this._bassSlow > 0.01 ? this._bassFast / this._bassSlow : 0;
        if (ratio > 1.35 && this._bassFast > 0.05 && now - this._lastBeat > 180) {
            beat = true;
            beatStrength = Math.min(1, (ratio - 1.35) / 0.8);
            this._lastBeat = now;
        }

        return {
            bass, mid, treble,
            level: Math.min(1, this._level * 3),
            centroid,
            beat,
            beatStrength,
        };
    }
}

function bandMean(freq, loHz, hiHz, binHz) {
    const lo = Math.max(0, Math.floor(loHz / binHz));
    const hi = Math.min(freq.length - 1, Math.ceil(hiHz / binHz));
    if (hi < lo) return 0;
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += freq[i];
    return sum / (hi - lo + 1) / 255;
}
