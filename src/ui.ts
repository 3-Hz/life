// Control panel and HUD wiring. Owns no state of its own -- it reads and writes
// the app object it is handed.

import { SOURCES } from './audio.js';
import type { AudioSource } from './audio.js';
import { formatDuration } from './audius.js';
import type { AudiusTrack } from './audius.js';
import { RULE_PRESETS } from './automata.js';

interface UiApp {
    autoQuality: boolean;
    autoRevive: boolean;
    breathe: boolean;
    sensitivity: number;
    paused: boolean;
    renderer: { setChromeInsets(insets: { top?: number; right?: number; bottom?: number; left?: number }): void };
    audius: { search(query: string): Promise<AudiusTrack[]> };
    // The element itself, because owning it is the whole point: transport
    // controls are a property set away, where a widget needed a message.
    audio: { element: HTMLAudioElement | null };
    playTrack(track: AudiusTrack, queue?: AudiusTrack[]): Promise<void>;
    seed(): void;
    clear(): void;
    stepOnce(): void;
    togglePause(): void;
    setRule(text: string): boolean;
    setSize(size: number): void;
    setWrap(wrap: boolean): void;
    setQualityLevel(level: number): void;
    selectSource(kind: AudioSource, payload?: File | AudiusTrack): Promise<void>;
}

interface UiElements {
    rule: HTMLSelectElement;
    ruleCustom: HTMLInputElement;
    size: HTMLSelectElement;
    wrap: HTMLInputElement;
    revive: HTMLInputElement;
    breathe: HTMLInputElement;
    autoQuality: HTMLInputElement;
    sensitivity: HTMLInputElement;
    sensitivityLabel: HTMLElement;
    seed: HTMLButtonElement;
    clear: HTMLButtonElement;
    pause: HTMLButtonElement;
    step: HTMLButtonElement;
    trackQuery: HTMLInputElement;
    trackSearch: HTMLButtonElement;
    trackResults: HTMLElement;
    nowPlaying: HTMLElement;
    nowPlayingTitle: HTMLElement;
    trackToggle: HTMLButtonElement;
    fileInput: HTMLInputElement;
    audioStatus: HTMLElement;
    playerNote: HTMLElement;
    hudGen: HTMLElement;
    hudPop: HTMLElement;
    hudDrawn: HTMLElement;
    hudRate: HTMLElement;
    hudFps: HTMLElement;
    hudBeat: HTMLElement;
    hudPerf: HTMLElement;
    perfSim: HTMLElement;
    perfSync: HTMLElement;
    perfFrame: HTMLElement;
    perfQuality: HTMLElement;
    perfLevel: HTMLElement;
    perfFlux: HTMLElement;
    view: HTMLCanvasElement;
    hud: HTMLElement;
    dock: HTMLElement;
    panel: HTMLElement;
    panelTab: HTMLButtonElement;
    quickPause: HTMLButtonElement;
    hudToggle: HTMLButtonElement;
}

export interface PerfHudStats {
    sim: number;
    sync: number;
    frame: number;
}

export interface HudStats {
    generation: number;
    population: number;
    drawn: number;
    tickRate: number;
    fps: number;
    beats: number;
    perf: PerfHudStats | null;
    quality: number;
    level: number;
    flux: number;
}

export interface UiBinding {
    els: UiElements;
    setActiveSource(kind: AudioSource): void;
    setSizeSelection(size: number): void;
    setAudioStatus(text: string, isError?: boolean): void;
    setPlayerNote(text: string): void;
    setTrackResults(tracks: AudiusTrack[]): void;
    setNowPlaying(track: AudiusTrack): void;
    updateHud(stats: HudStats): void;
}

const $ = <T extends HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing UI element: #${id}`);
    return element as T;
};

// The dropdown is the dial: presets in order of how much of the lattice
// survives each step, from breathing to boiling.
function buildRuleOptions(select: HTMLSelectElement): void {
    for (const preset of RULE_PRESETS) {
        const option = document.createElement('option');
        option.value = preset.rule;
        option.textContent = preset.persists === undefined
            ? `${preset.rule} — ${preset.label}`
            : `${preset.rule} — ${preset.persists}% persists, ${preset.label}`;
        if (preset.default) option.selected = true;
        select.appendChild(option);
    }
    const custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'custom…';
    select.appendChild(custom);
}

export function bindUI(app: UiApp): UiBinding {
    const els = {
        rule: $<HTMLSelectElement>('rule'),
        ruleCustom: $<HTMLInputElement>('ruleCustom'),
        size: $<HTMLSelectElement>('size'),
        wrap: $<HTMLInputElement>('wrap'),
        revive: $<HTMLInputElement>('revive'),
        breathe: $<HTMLInputElement>('breathe'),
        autoQuality: $<HTMLInputElement>('autoQuality'),
        sensitivity: $<HTMLInputElement>('sensitivity'),
        sensitivityLabel: $<HTMLElement>('sensitivityLabel'),
        seed: $<HTMLButtonElement>('seed'),
        clear: $<HTMLButtonElement>('clear'),
        pause: $<HTMLButtonElement>('pause'),
        step: $<HTMLButtonElement>('step'),
        trackQuery: $<HTMLInputElement>('trackQuery'),
        trackSearch: $<HTMLButtonElement>('trackSearch'),
        trackResults: $<HTMLElement>('trackResults'),
        nowPlaying: $<HTMLElement>('nowPlaying'),
        nowPlayingTitle: $<HTMLElement>('nowPlayingTitle'),
        trackToggle: $<HTMLButtonElement>('trackToggle'),
        fileInput: $<HTMLInputElement>('fileInput'),
        audioStatus: $<HTMLElement>('audioStatus'),
        playerNote: $<HTMLElement>('playerNote'),
        hudGen: $<HTMLElement>('hudGen'),
        hudPop: $<HTMLElement>('hudPop'),
        hudDrawn: $<HTMLElement>('hudDrawn'),
        hudRate: $<HTMLElement>('hudRate'),
        hudFps: $<HTMLElement>('hudFps'),
        hudBeat: $<HTMLElement>('hudBeat'),
        hudPerf: $<HTMLElement>('hudPerf'),
        perfSim: $<HTMLElement>('perfSim'),
        perfSync: $<HTMLElement>('perfSync'),
        perfFrame: $<HTMLElement>('perfFrame'),
        perfQuality: $<HTMLElement>('perfQuality'),
        perfLevel: $<HTMLElement>('perfLevel'),
        perfFlux: $<HTMLElement>('perfFlux'),
        view: $<HTMLCanvasElement>('view'),
        hud: $<HTMLElement>('hud'),
        dock: $<HTMLElement>('dock'),
        panel: $<HTMLElement>('panel'),
        panelTab: $<HTMLButtonElement>('panelTab'),
        quickPause: $<HTMLButtonElement>('quickPause'),
        hudToggle: $<HTMLButtonElement>('hudToggle'),
    } satisfies UiElements;

    // Screen capture does not exist on mobile browsers, so that source cannot
    // work there. Detect rather than sniff the platform. Removing it beats
    // disabling it now that MUSIC covers the same want on every device -- and
    // it has to happen before the tab list is read, or the roving-focus arrays
    // would keep pointing at a detached button.
    if (!navigator.mediaDevices?.getDisplayMedia) {
        for (const element of Array.from(document.querySelectorAll('[data-source="system"], [data-source-panel="system"]'))) {
            element.remove();
        }
    }

    const sourceTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"][data-source]'));
    const sourcePanels = Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"][data-source-panel]'));

    buildRuleOptions(els.rule);

    els.rule.addEventListener('change', () => {
        if (els.rule.value === 'custom') {
            els.ruleCustom.hidden = false;
            els.ruleCustom.focus();
        } else {
            els.ruleCustom.hidden = true;
            app.setRule(els.rule.value);
        }
    });

    els.ruleCustom.addEventListener('change', () => {
        const ok = app.setRule(els.ruleCustom.value);
        els.ruleCustom.classList.toggle('invalid', !ok);
    });

    els.size.addEventListener('change', () => app.setSize(Number(els.size.value)));
    els.wrap.addEventListener('change', () => app.setWrap(els.wrap.checked));
    els.autoQuality.addEventListener('change', () => {
        app.autoQuality = els.autoQuality.checked;
        // Someone who switches this off wants the quality they picked, so go
        // back to full rather than leaving them wherever the controller landed.
        if (!els.autoQuality.checked) app.setQualityLevel(0);
    });

    els.revive.addEventListener('change', () => {
        app.autoRevive = els.revive.checked;
    });

    // Its opposite number: revive stops the lattice emptying out, this stops it
    // filling in until the outside is all anyone can see.
    els.breathe.addEventListener('change', () => {
        app.breathe = els.breathe.checked;
    });

    els.sensitivity.addEventListener('input', () => {
        app.sensitivity = Number(els.sensitivity.value) / 100;
        els.sensitivityLabel.textContent = els.sensitivity.value;
    });

    els.seed.addEventListener('click', () => app.seed());
    els.clear.addEventListener('click', () => app.clear());
    els.step.addEventListener('click', () => app.stepOnce());
    const syncPause = () => {
        els.pause.textContent = app.paused ? 'PLAY' : 'PAUSE';
        els.quickPause.textContent = app.paused ? '▶' : '❚❚';
    };
    const togglePause = () => {
        app.togglePause();
        syncPause();
    };
    els.pause.addEventListener('click', togglePause);
    els.quickPause.addEventListener('click', togglePause);

    //-------PANEL-------
    // The tab is the only thing that opens and closes the panel. A tap on the
    // canvas re-seeds, so it deliberately does not double as a dismiss.
    const setPanelOpen = (open: boolean): void => {
        document.body.classList.toggle('panel-closed', !open);
        els.panelTab.setAttribute('aria-expanded', String(open));
    };
    // Open by default only where there is room for it. A rail costs a desktop
    // almost nothing, but on a landscape phone it still eats 40% of the screen,
    // and a portrait sheet eats most of it.
    setPanelOpen(window.matchMedia('(min-width: 900px) and (orientation: landscape)').matches);
    els.panelTab.addEventListener('click', () => {
        setPanelOpen(document.body.classList.contains('panel-closed'));
    });

    els.hudToggle.addEventListener('click', () => {
        const showing = els.hud.hidden;
        els.hud.hidden = !showing;
        els.hudToggle.setAttribute('aria-pressed', String(showing));
    });

    // Audio sources are modes, not a row of unrelated actions. Tabs only
    // reveal a mode; the action inside each panel still owns the user gesture
    // needed by permission prompts and AudioContext.
    const activateSourceTab = (kind: AudioSource, { focus = false }: { focus?: boolean } = {}): void => {
        const tab = sourceTabs.find((candidate) => candidate.dataset.source === kind);
        if (!tab || tab.disabled) return;

        for (const candidate of sourceTabs) {
            const selected = candidate === tab;
            candidate.setAttribute('aria-selected', String(selected));
            candidate.tabIndex = selected ? 0 : -1;
        }
        for (const panel of sourcePanels) {
            panel.hidden = panel.dataset.sourcePanel !== kind;
        }
        if (focus) tab.focus();
    };

    const moveSourceTab = (event: KeyboardEvent): void => {
        const enabled = sourceTabs.filter((tab) => !tab.disabled);
        const current = enabled.indexOf(event.currentTarget as HTMLButtonElement);
        if (current < 0) return;
        let next = current;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % enabled.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + enabled.length) % enabled.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = enabled.length - 1;
        else return;
        event.preventDefault();
        activateSourceTab(enabled[next].dataset.source as AudioSource, { focus: true });
    };

    for (const tab of sourceTabs) {
        tab.addEventListener('click', () => activateSourceTab(tab.dataset.source as AudioSource));
        tab.addEventListener('keydown', moveSourceTab);
    }
    activateSourceTab(SOURCES.STREAM);

    // Everything that has to clear the dock reads its measured size: the panel
    // sits beside or above it, and the renderer centres the lattice on what it
    // leaves. Hard-coding it put the dock on top of the panel's last row, since
    // 44px touch targets plus padding never match a round number in CSS.
    const syncDockMetrics = () => {
        const box = els.dock.getBoundingClientRect();
        const root = document.documentElement.style;
        root.setProperty('--dock', `${box.height}px`);
        root.setProperty('--dock-w', `${box.width}px`);
        // The renderer centres the lattice on what the dock leaves visible,
        // mirroring where the CSS puts the dock in each orientation.
        const portrait = window.matchMedia('(orientation: portrait)').matches;
        app.renderer.setChromeInsets(portrait ? { bottom: box.height } : { right: box.width });
    };
    syncDockMetrics();
    window.addEventListener('resize', syncDockMetrics);
    window.addEventListener('orientationchange', syncDockMetrics);
    if (window.ResizeObserver) new ResizeObserver(syncDockMetrics).observe(els.dock);

    //-------CANVAS GESTURES-------
    // Tap re-seeds; drag rotates; pinch zooms. Re-seeding throws the board away,
    // so the discrimination errs toward "that was a drag": a rotate misread as a
    // tap destroys what you were watching, while a tap misread as a drag costs
    // nothing.
    const TAP_SLOP_PX = 12;
    const TAP_MS = 300;
    let tap: { x: number; y: number; t: number; id: number } | null | undefined = null;
    els.view.addEventListener('pointerdown', (event) => {
        // A second finger means pinch-zoom, never a tap.
        tap = tap === null && event.isPrimary
            ? { x: event.clientX, y: event.clientY, t: performance.now(), id: event.pointerId }
            : undefined;
    });
    els.view.addEventListener('pointermove', (event) => {
        if (!tap || event.pointerId !== tap.id) return;
        if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TAP_SLOP_PX) tap = undefined;
    });
    const endTap = (event: PointerEvent): void => {
        const candidate = tap;
        tap = null;
        if (!candidate || event.pointerId !== candidate.id) return;
        if (performance.now() - candidate.t > TAP_MS) return;
        if (Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > TAP_SLOP_PX) return;
        app.seed();
    };
    els.view.addEventListener('pointerup', endTap);
    els.view.addEventListener('pointercancel', () => { tap = null; });

    // Each source action remains its own click because every capture path needs
    // a user gesture and most need a permission prompt.
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-connect-source]'))) {
        button.addEventListener('click', () => app.selectSource(button.dataset.connectSource as AudioSource));
    }

    //-------MUSIC-------
    // The list the buttons were built from. Clicking one plays it *and* hands
    // over the rest, so the track that follows is the one below it on screen.
    let results: AudiusTrack[] = [];

    const renderResults = (tracks: AudiusTrack[]): void => {
        results = tracks;
        els.trackResults.textContent = '';
        if (!tracks.length) {
            els.playerNote.textContent = 'nothing found';
            return;
        }
        els.playerNote.textContent = '';
        for (const track of tracks) {
            const item = document.createElement('li');
            const button = document.createElement('button');
            button.className = 'track-result';
            const name = document.createElement('span');
            name.className = 'track-name';
            // textContent rather than innerHTML: these strings are other
            // people's track titles, and they arrive over the network.
            name.textContent = `${track.artist} — ${track.title}`;
            button.appendChild(name);
            // The full title is worth having somewhere, since the row clips it.
            button.title = `${track.artist} — ${track.title}`;
            const time = document.createElement('span');
            time.className = 'track-time';
            time.textContent = formatDuration(track.duration);
            button.appendChild(time);
            button.addEventListener('click', () => app.playTrack(track, results));
            item.appendChild(button);
            els.trackResults.appendChild(item);
        }
    };

    let searchToken = 0;
    const runSearch = async (): Promise<void> => {
        const token = ++searchToken;
        els.playerNote.textContent = 'searching...';
        try {
            const found = await app.audius.search(els.trackQuery.value);
            // A slow first search must not overwrite a fast second one.
            if (token === searchToken) renderResults(found);
        } catch (err) {
            if (token !== searchToken) return;
            els.playerNote.textContent = err instanceof Error ? err.message : String(err);
        }
    };

    els.trackSearch.addEventListener('click', () => { void runSearch(); });
    els.trackQuery.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        void runSearch();
    });

    // Transport, which owning the element makes trivial. Reading paused off the
    // element rather than tracking it here keeps the label honest when playback
    // stops for reasons we did not initiate.
    const syncTransport = (): void => {
        const element = app.audio.element;
        const playing = Boolean(element) && !element!.paused;
        els.trackToggle.textContent = playing ? '❚❚' : '▶';
        els.trackToggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    };
    els.trackToggle.addEventListener('click', () => {
        const element = app.audio.element;
        if (!element) return;
        if (element.paused) void element.play(); else element.pause();
        syncTransport();
    });

    els.fileInput.addEventListener('change', () => {
        const file = els.fileInput.files?.[0];
        if (file) app.selectSource(SOURCES.FILE, file);
    });

    document.addEventListener('keydown', (event) => {
        if (event.target instanceof Element && event.target.matches('input, select, textarea')) return;
        if (event.key === ' ') {
            event.preventDefault();
            togglePause();
        } else if (event.key === 's' || event.key === 'S') app.stepOnce();
        else if (event.key === 'c' || event.key === 'C') app.clear();
        else if (event.key === 'r' || event.key === 'R') app.seed();
    });

    const ui: UiBinding = {
        els,
        setActiveSource(kind: AudioSource): void {
            activateSourceTab(kind);
        },
        setSizeSelection(n: number): void {
            els.size.value = String(n);
        },
        setAudioStatus(text: string, isError = false): void {
            els.audioStatus.textContent = text;
            els.audioStatus.classList.toggle('error', isError);
        },
        setPlayerNote(text: string): void {
            els.playerNote.textContent = text;
        },
        setTrackResults(tracks: AudiusTrack[]): void {
            renderResults(tracks);
        },
        setNowPlaying(track: AudiusTrack): void {
            els.nowPlaying.hidden = false;
            els.nowPlayingTitle.textContent = `${track.artist} — ${track.title}`;
            // Follow the element rather than assuming: playback can stop for
            // reasons we did not initiate, and a label that lies about it is
            // worse than no label. The element is replaced per track, so these
            // listeners go with it.
            const element = app.audio.element;
            if (element) {
                element.addEventListener('play', syncTransport);
                element.addEventListener('pause', syncTransport);
            }
            syncTransport();
        },
        updateHud(stats: HudStats): void {
            els.hudGen.textContent = String(stats.generation);
            els.hudPop.textContent = String(stats.population);
            els.hudDrawn.textContent = String(stats.drawn);
            els.hudRate.textContent = stats.tickRate.toFixed(1);
            els.hudFps.textContent = stats.fps.toFixed(0);
            els.hudBeat.textContent = String(stats.beats);
            if (!stats.perf) return;
            els.hudPerf.hidden = false;
            els.perfSim.textContent = stats.perf.sim.toFixed(2);
            els.perfSync.textContent = stats.perf.sync.toFixed(2);
            els.perfFrame.textContent = stats.perf.frame.toFixed(1);
            els.perfQuality.textContent = String(stats.quality);
            els.perfLevel.textContent = stats.level.toFixed(2);
            els.perfFlux.textContent = stats.flux.toFixed(2);
        },
    };
    return ui;
}
