import { Lattice, parseRule } from './automata.js';
import { mulberry32 } from './rng.js';
import { VoxelRenderer } from './render.js';
import { AudioEngine, SOURCES, SOURCE_LABELS } from './audio.js';
import { SoundCloudPlayer } from './player.js';
import { mapToSim, mapToVisual, shiftBirth, TARGETS } from './mapping.js';
import { bindUI, isMac } from './ui.js';

const DEFAULT_SIZE = 48;
const DEFAULT_RULE = 'S7-12/B9-12';
const SEED_DENSITY = 0.18;
// Without audio there is no loudness to read, and the audio-driven floor of
// 2 ticks/sec reads as a frozen app. Silence gets its own pace instead.
const SILENT_TICK_RATE = 8;
// Measured across the rule space: from random soup these rules either die out,
// decay slowly, or saturate. Beats keep a decaying lattice blooming, but with
// no audio connected the toy would sit empty -- so it reseeds itself. Life,
// finding a way.
const REVIVE_FRACTION = 0.002;

class App {
    constructor() {
        this.rule = parseRule(DEFAULT_RULE);
        this.lattice = new Lattice(DEFAULT_SIZE, { wrap: true });
        this.rng = mulberry32(0xC0FFEE);
        this.renderer = new VoxelRenderer(document.getElementById('view'), DEFAULT_SIZE);
        this.audio = new AudioEngine();
        this.player = new SoundCloudPlayer(document.getElementById('scPlayer'));

        this.sensitivity = 0.6;
        this.autoRevive = true;
        this.population = 0;
        this.paused = false;
        this.tickRate = 8;
        this.beats = 0;
        this._accumulator = 0;
        this._last = performance.now();
        this._fps = 60;
        this._hudDue = 0;
        this._dirty = true;

        this.ui = bindUI(this);
        this.seed();
    }

    //-------SIM CONTROL-------
    seed() {
        this.lattice.seedRandom(SEED_DENSITY, this.rng, { margin: Math.floor(this.lattice.n / 4) });
        this.population = this.lattice.population();
        this.markDirty();
    }

    clear() {
        this.lattice.clear();
        this.population = 0;
        this.markDirty();
    }

    togglePause() {
        this.paused = !this.paused;
    }

    stepOnce() {
        this.paused = true;
        this.lattice.step(this.rule);
        this.population = this.lattice.population();
        this.markDirty();
    }

    markDirty() {
        this._dirty = true;
    }

    setRule(text) {
        try {
            this.rule = parseRule(text);
            return true;
        } catch {
            return false;
        }
    }

    setSize(n) {
        const wrap = this.lattice.wrap;
        this.lattice = new Lattice(n, { wrap });
        this.renderer.setLatticeSize(n);
        this.seed();
    }

    setWrap(wrap) {
        const cells = this.lattice.cells.slice();
        const age = this.lattice.age.slice();
        this.lattice = new Lattice(this.lattice.n, { wrap });
        this.lattice.cells.set(cells);
        this.lattice.age.set(age);
        this.markDirty();
    }

    //-------AUDIO-------
    async selectSource(kind, payload) {
        try {
            this.ui.setAudioStatus(`connecting ${SOURCE_LABELS[kind]}...`);
            if (kind === SOURCES.SYSTEM) await this.audio.useDisplayMedia({ preferCurrentTab: false });
            else if (kind === SOURCES.TAB) await this.audio.useDisplayMedia({ preferCurrentTab: true });
            else if (kind === SOURCES.MIC) await this.audio.useMicrophone();
            else if (kind === SOURCES.FILE) await this.audio.useFile(payload);
            else if (kind === SOURCES.TONE) await this.audio.useTestTone();
            this.ui.setAudioStatus(`listening: ${SOURCE_LABELS[kind]}`);
        } catch (err) {
            // Denied permissions and cancelled pickers both land here; neither
            // is worth more than a line of text.
            this.ui.setAudioStatus(`${SOURCE_LABELS[kind]} failed — ${err.message}`, true);
        }
    }

    async initPlayer() {
        const ok = await this.player.init();
        if (!ok) {
            this.ui.setPlayerNote(`SoundCloud unavailable (${this.player.error}) — the other sources still work.`);
            document.querySelector('[data-source="tab"]').disabled = true;
        } else if (isMac()) {
            this.ui.setPlayerNote('On macOS, Chrome shares tab audio but not system audio — play a track here and capture this tab.');
        }
    }

    //-------LOOP-------
    frame(now) {
        const dt = Math.min((now - this._last) / 1000, 0.25);
        this._last = now;
        this._fps += (1 / Math.max(dt, 0.001) - this._fps) * 0.1;

        const features = this.audio.features(now);
        const sim = mapToSim(features, this.sensitivity, TARGETS);
        const visual = mapToVisual(features, this.sensitivity, TARGETS);
        this.tickRate = this.audio.active ? sim.tickRate : SILENT_TICK_RATE;

        if (features.beat) this.beats++;
        if (sim.burst && !this.paused) {
            const n = this.lattice.n;
            this.lattice.injectSphere(
                Math.floor(this.rng() * n), Math.floor(this.rng() * n), Math.floor(this.rng() * n),
                sim.burst.radius, sim.burst.density, this.rng,
            );
            this.markDirty();
        }

        let ticks = 0;
        if (!this.paused) {
            this._accumulator += dt;
            const interval = 1 / this.tickRate;
            // Capped so a backgrounded tab does not return and run a hundred
            // generations in one frame.
            while (this._accumulator >= interval && ticks < 4) {
                this.lattice.step(shiftBirth(this.rule, sim.birthShift));
                this._accumulator -= interval;
                ticks++;
                this._dirty = true;
            }
            // Whatever the tick cap left behind is dropped, so a stall cannot
            // build a backlog that runs forever.
            if (this._accumulator > interval) this._accumulator = interval;
        }

        if (ticks > 0 || this._dirty) this.population = this.lattice.population();

        // Nothing to watch is worse than the wrong thing to watch.
        if (this.autoRevive && !this.paused && this.population < this.lattice.size * REVIVE_FRACTION) {
            const n = this.lattice.n;
            this.lattice.injectSphere(
                Math.floor(this.rng() * n), Math.floor(this.rng() * n), Math.floor(this.rng() * n),
                5, 0.5, this.rng,
            );
            this.population = this.lattice.population();
            this.markDirty();
        }

        if (this._dirty) {
            this.renderer.syncLattice(this.lattice, visual);
            this._dirty = false;
        }
        this.renderer.applyVisual(visual);
        this.renderer.render();

        if (now > this._hudDue) {
            this._hudDue = now + 250;
            this.ui.updateHud({
                generation: this.lattice.generation,
                population: this.population,
                drawn: this.renderer.drawn,
                tickRate: this.tickRate,
                fps: this._fps,
                beats: this.beats,
            });
        }

        requestAnimationFrame((t) => this.frame(t));
    }
}

const app = new App();
window.addEventListener('resize', () => app.renderer.resize());
app.initPlayer();
app.ui.setAudioStatus('no audio source — pick one above');
requestAnimationFrame((t) => app.frame(t));

// Exposed for the headless smoke check, which drives the app without a picker.
window.__life = app;
