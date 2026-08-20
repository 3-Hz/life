import { Lattice, parseRule } from './automata.js';
import { mulberry32 } from './rng.js';
import { VoxelRenderer } from './render.js';
import { AudioEngine, SOURCES, SOURCE_LABELS } from './audio.js';
import type { AudioSource } from './audio.js';
import { SoundCloudPlayer } from './player.js';
import { mapToSim, mapToVisual, shiftBirth, densityControl, TARGETS } from './mapping.js';
import { bindUI, isMac } from './ui.js';
import type { PerfHudStats, UiBinding } from './ui.js';
import type { Rule } from './automata.js';

const DEFAULT_RULE = '4733';
const SEED_DENSITY = 0.18;
// Without audio there is no loudness to read, and the audio-driven floor of
// 2 ticks/sec reads as a frozen app. Silence gets its own pace instead.
const SILENT_TICK_RATE = 20;
// Measured across the rule space: from random soup these rules either die out,
// decay slowly, or saturate. Beats keep a decaying lattice blooming, but with
// no audio connected the toy would sit empty -- so it reseeds itself. Life,
// finding a way.
const REVIVE_FRACTION = 0.002;

// Phones get a smaller lattice and a lower pixel-ratio ceiling from the start,
// rather than being walked down to one by the quality controller.
const MOBILE = window.matchMedia?.('(pointer: coarse)').matches ?? false;
const DEFAULT_SIZE = MOBILE ? 32 : 48;

// Quality rungs, cheapest visual cost first. The controller walks down this
// list under load and back up when there is headroom.
const QUALITY_LEVELS = [
    { pixelRatio: 2.0, tickCeiling: 60, sizeCap: null },
    { pixelRatio: 1.5, tickCeiling: 40, sizeCap: null },
    { pixelRatio: 1.0, tickCeiling: 25, sizeCap: null },
    { pixelRatio: 0.75, tickCeiling: 15, sizeCap: 48 },
    { pixelRatio: 0.75, tickCeiling: 15, sizeCap: 32 },
];

interface QualityLevel {
    pixelRatio: number;
    tickCeiling: number;
    sizeCap: number | null;
}

interface TimingStats extends PerfHudStats {
    draws: number;
}
const SLOW_FRAME_MS = 20;   // below ~50fps
const FAST_FRAME_MS = 12;   // comfortably above 60fps
const LEVEL_DWELL_MS = 1500; // hysteresis, so it cannot oscillate
// The first seconds are slow for reasons that say nothing about steady state:
// shaders compile, buffers upload, the first instances are written. Judging
// quality on those frames walks the lattice down a level or three before the
// app has drawn anything — and the size drop is deliberately one-way, so that
// would throw the board away before the viewer ever saw it.
const WARMUP_MS = 4000;

class App {
    rule: Rule;
    lattice: Lattice;
    rng: () => number;
    renderer: VoxelRenderer;
    audio: AudioEngine;
    player: SoundCloudPlayer;
    sensitivity: number;
    autoRevive: boolean;
    breathe: boolean;
    population: number;
    paused: boolean;
    tickRate: number;
    beats: number;
    autoQuality: boolean;
    qualityLevel: number;
    private _levelChangedAt: number;
    chosenSize: number;
    perf: boolean;
    timing: TimingStats;
    private _accumulator: number;
    private _phase: number;
    private _startedAt: number;
    private _last: number;
    private _fps: number;
    private _frameMs: number;
    private _hudDue: number;
    private _dirty: boolean;
    ui: UiBinding;

    constructor() {
        this.rule = parseRule(DEFAULT_RULE);
        this.lattice = new Lattice(DEFAULT_SIZE, { wrap: true });
        this.rng = mulberry32(0xC0FFEE);
        this.renderer = new VoxelRenderer(document.getElementById('view') as HTMLCanvasElement, DEFAULT_SIZE, { mobile: MOBILE });
        this.audio = new AudioEngine();
        this.player = new SoundCloudPlayer(document.getElementById('scPlayer') as HTMLIFrameElement);

        this.sensitivity = 0.6;
        this.autoRevive = true;
        // The other half of "never let it die": never let it pack solid either.
        this.breathe = true;
        this.population = 0;
        this.paused = false;
        this.tickRate = SILENT_TICK_RATE;
        this.beats = 0;

        this.autoQuality = true;
        this.qualityLevel = 0;
        this._levelChangedAt = 0;
        // What the user asked for. The controller may cap below it, never above.
        this.chosenSize = DEFAULT_SIZE;

        // Rolling profile, surfaced in the HUD with ?perf.
        this.perf = new URLSearchParams(location.search).has('perf');
        this.timing = { sim: 0, sync: 0, frame: 0, draws: 0 };

        this._accumulator = 0;
        this._phase = 1;
        this._startedAt = performance.now();
        this._last = this._startedAt;
        this._fps = 60;
        this._frameMs = 16;
        this._hudDue = 0;
        this._dirty = true;

        this.ui = bindUI(this);
        this.seed();
    }

    //-------SIM CONTROL-------
    seed(): void {
        this.lattice.seedRandom(SEED_DENSITY, this.rng, { margin: Math.floor(this.lattice.n / 4) });
        this.population = this.lattice.population();
        this.markDirty();
    }

    clear(): void {
        this.lattice.clear();
        this.population = 0;
        this.markDirty();
    }

    togglePause(): void {
        this.paused = !this.paused;
        this.markDirty();
    }

    stepOnce(): void {
        this.paused = true;
        this.population = this.lattice.step(this.rule);
        this.markDirty();
    }

    private markDirty(): void {
        this._dirty = true;
    }

    setRule(text: string): boolean {
        try {
            this.rule = parseRule(text);
            return true;
        } catch {
            return false;
        }
    }

    setSize(n: number, { userChoice = true }: { userChoice?: boolean } = {}): void {
        if (userChoice) this.chosenSize = n;
        if (n === this.lattice.n) return;
        const wrap = this.lattice.wrap;
        this.lattice = new Lattice(n, { wrap });
        this.renderer.setLatticeSize(n);
        this.seed();
    }

    setWrap(wrap: boolean): void {
        const cells = this.lattice.cells.slice();
        const age = this.lattice.age.slice();
        this.lattice = new Lattice(this.lattice.n, { wrap });
        this.lattice.cells.set(cells);
        this.lattice.age.set(age);
        this.markDirty();
    }

    //-------AUDIO-------
    async selectSource(kind: AudioSource, payload?: File): Promise<void> {
        this.ui.setActiveSource(kind);
        try {
            this.ui.setAudioStatus(`connecting ${SOURCE_LABELS[kind]}...`);
            if (kind === SOURCES.SYSTEM) await this.audio.useDisplayMedia({ preferCurrentTab: false });
            else if (kind === SOURCES.TAB) await this.audio.useDisplayMedia({ preferCurrentTab: true });
            else if (kind === SOURCES.MIC) await this.audio.useMicrophone();
            else if (kind === SOURCES.FILE) {
                if (!payload) throw new Error('choose an audio file first');
                await this.audio.useFile(payload);
            }
            else if (kind === SOURCES.TONE) await this.audio.useTestTone();
            this.ui.setAudioStatus(`listening: ${SOURCE_LABELS[kind]}`);
        } catch (err) {
            // Denied permissions and cancelled pickers both land here; neither
            // is worth more than a line of text.
            const message = err instanceof Error ? err.message : String(err);
            this.ui.setAudioStatus(`${SOURCE_LABELS[kind]} failed — ${message}`, true);
        }
    }

    async initPlayer(): Promise<void> {
        const ok = await this.player.init();
        if (!ok) {
            this.ui.setPlayerNote(`SoundCloud unavailable (${this.player.error}) — the other sources still work.`);
            const tab = document.querySelector<HTMLButtonElement>('[data-source="tab"]');
            if (tab) tab.disabled = true;
        } else if (isMac()) {
            this.ui.setPlayerNote('On macOS, Chrome shares tab audio but not system audio — play a track here and capture this tab.');
        }
    }

    //-------QUALITY-------
    // Frame time decides, not frame rate: a 20ms frame is a dropped frame
    // whether or not the average still looks acceptable.
    private updateQuality(now: number): void {
        if (!this.autoQuality) return;
        if (now - this._startedAt < WARMUP_MS) return;
        if (now - this._levelChangedAt < LEVEL_DWELL_MS) return;

        if (this._frameMs > SLOW_FRAME_MS && this.qualityLevel < QUALITY_LEVELS.length - 1) {
            this.setQualityLevel(this.qualityLevel + 1, now);
        } else if (this._frameMs < FAST_FRAME_MS && this.qualityLevel > 0) {
            this.setQualityLevel(this.qualityLevel - 1, now);
        }
    }

    setQualityLevel(level: number, now = performance.now()): void {
        const previous = this.qualityLevel;
        this.qualityLevel = level;
        this._levelChangedAt = now;
        this.renderer.setPixelRatio(QUALITY_LEVELS[level].pixelRatio);

        // Shrinking the lattice reallocates it, which means a reseed -- it
        // throws away whatever the viewer was watching. So it is the last
        // resort, and it does not reverse itself: recovering would reseed a
        // second time, and a machine that just struggled will likely struggle
        // again. The user can raise it back whenever they want.
        const cap = QUALITY_LEVELS[level].sizeCap;
        if (level > previous && cap !== null && this.lattice.n > cap) {
            this.setSize(cap, { userChoice: false });
            this.ui.setSizeSelection(cap);
            this.ui.setAudioStatus(`frames were slipping — dropped to ${cap}³ to keep up`);
        }
    }

    //-------LOOP-------
    frame(now: number): void {
        const frameStart = now;
        const dt = Math.min((now - this._last) / 1000, 0.25);
        this._last = now;
        this._fps += (1 / Math.max(dt, 0.001) - this._fps) * 0.1;

        const features = this.audio.features(dt);
        // How full the lattice is decides how hard the controller pushes back,
        // so it is read once and handed to both mappings.
        const density = densityControl(this.population / this.lattice.size, this.breathe);
        const sim = mapToSim(features, this.sensitivity, TARGETS, density);
        const visual = mapToVisual(features, this.sensitivity, TARGETS, density);
        const ceiling = QUALITY_LEVELS[this.qualityLevel].tickCeiling;
        this.tickRate = Math.min(this.audio.active ? sim.tickRate : SILENT_TICK_RATE, ceiling);

        if (features.beat) this.beats++;
        if (sim.burst && !this.paused) {
            const n = this.lattice.n;
            // Height comes from the spectrum, the rest is scattered. A little
            // jitter on the height keeps a steady mix from stacking every burst
            // into the same flat slab.
            const x = Math.floor(this.rng() * n);
            const z = Math.floor(this.rng() * n);
            const y = Math.max(0, Math.min(n - 1, Math.round(
                sim.burst.height * (n - 1) + (this.rng() - 0.5) * n * 0.15,
            )));
            this.lattice.injectSphere(x, y, z, sim.burst.radius, sim.burst.density, this.rng);
            // The shell and the cells it woke share an origin, so the wave reads
            // as coming from the hit rather than from nowhere.
            this.renderer.spawnShock(x, y, z, features.beatStrength);
            this.population = this.lattice.population();
            this.markDirty();
        }

        let ticks = 0;
        const simStart = performance.now();
        if (!this.paused) {
            this._accumulator += dt;
            const interval = 1 / this.tickRate;
            // Capped so a backgrounded tab does not return and run a hundred
            // generations in one frame.
            const thinning = { birthChance: sim.birthChance, rng: this.rng };
            while (this._accumulator >= interval && ticks < 4) {
                this.population = this.lattice.step(shiftBirth(this.rule, sim.birthShift), thinning);
                this._accumulator -= interval;
                ticks++;
                this._dirty = true;
            }
            // Whatever the tick cap left behind is dropped, so a stall cannot
            // build a backlog that runs forever.
            if (this._accumulator > interval) this._accumulator = interval;
            // How far along we are toward the next generation. Births and deaths
            // animate across this, so the lattice moves continuously between
            // steps instead of holding one frozen image for several frames.
            this._phase = Math.min(this._accumulator / interval, 1);
        } else {
            this._phase = 1; // paused: show the current generation settled
        }
        const simMs = performance.now() - simStart;

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

        let syncMs = 0;
        if (this._dirty) {
            const syncStart = performance.now();
            this.renderer.syncLattice(this.lattice);
            syncMs = performance.now() - syncStart;
            this._dirty = false;
        }

        // Draw only when something moved. While running, the in-between
        // animation is itself movement, so every frame counts; paused, with no
        // audio and the camera at rest, there is nothing new to put on screen.
        this.renderer.applyVisual(visual);
        this.renderer.updateShocks(dt);
        this.renderer.setPhase(this._phase);
        const cameraMoved = this.renderer.updateControls();
        const audioLive = this.audio.active;
        if (!this.paused || ticks > 0 || syncMs > 0 || cameraMoved || audioLive) {
            this.renderer.render();
            this.timing.draws++;
        }

        const frameMs = performance.now() - frameStart;
        this._frameMs += (frameMs - this._frameMs) * 0.1;
        if (simMs) this.timing.sim += (simMs - this.timing.sim) * 0.2;
        if (syncMs) this.timing.sync += (syncMs - this.timing.sync) * 0.2;
        this.timing.frame = this._frameMs;
        this.updateQuality(now);

        if (now > this._hudDue) {
            this._hudDue = now + 250;
            this.ui.updateHud({
                generation: this.lattice.generation,
                population: this.population,
                drawn: this.renderer.drawn,
                tickRate: this.tickRate,
                fps: this._fps,
                beats: this.beats,
                perf: this.perf ? this.timing : null,
                quality: this.qualityLevel,
                // The two numbers that say whether the audio side is alive.
                // Either one sitting at 1.00 is the failure this is watching for.
                level: features.level,
                flux: features.flux,
            });
        }

        requestAnimationFrame((t) => this.frame(t));
    }
}

const app = new App();
window.addEventListener('resize', () => app.renderer.resize());
app.initPlayer();
app.ui.setAudioStatus('no audio source — pick one above');
// Phones start at 32³, and nothing told the dropdown, so it read 48³ while the
// app ran 32³. The select follows the lattice, never the markup's default.
app.ui.setSizeSelection(app.lattice.n);
requestAnimationFrame((t) => app.frame(t));

// Exposed for the headless smoke check, which drives the app without a picker.
window.__life = app;
