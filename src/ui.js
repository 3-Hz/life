// Control panel and HUD wiring. Owns no state of its own -- it reads and writes
// the app object it is handed.

import { SOURCES } from './audio.js';
import { RULE_PRESETS } from './automata.js';

const $ = (id) => document.getElementById(id);

// The dropdown is the dial: presets in order of how much of the lattice
// survives each step, from breathing to boiling.
function buildRuleOptions(select) {
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

export function bindUI(app) {
    const els = {
        rule: $('rule'),
        ruleCustom: $('ruleCustom'),
        size: $('size'),
        wrap: $('wrap'),
        revive: $('revive'),
        autoQuality: $('autoQuality'),
        sensitivity: $('sensitivity'),
        sensitivityLabel: $('sensitivityLabel'),
        seed: $('seed'),
        clear: $('clear'),
        pause: $('pause'),
        step: $('step'),
        trackUrl: $('trackUrl'),
        loadTrack: $('loadTrack'),
        fileInput: $('fileInput'),
        audioStatus: $('audioStatus'),
        playerNote: $('playerNote'),
        hudGen: $('hudGen'),
        hudPop: $('hudPop'),
        hudDrawn: $('hudDrawn'),
        hudRate: $('hudRate'),
        hudFps: $('hudFps'),
        hudBeat: $('hudBeat'),
        hudPerf: $('hudPerf'),
        perfSim: $('perfSim'),
        perfSync: $('perfSync'),
        perfFrame: $('perfFrame'),
        perfQuality: $('perfQuality'),
        view: $('view'),
        hud: $('hud'),
        dock: $('dock'),
        panel: $('panel'),
        panelTab: $('panelTab'),
        quickPause: $('quickPause'),
        hudToggle: $('hudToggle'),
    };

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
    const setPanelOpen = (open) => {
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

    // The panel clears the dock by the dock's real size. Hard-coding it meant
    // the dock covered the last row of controls, since 44px touch targets plus
    // padding come out taller than any round number guessed in CSS.
    // Portrait clears the dock's height below the panel; landscape insets the
    // panel by its width beside it. Both are measured rather than guessed --
    // 44px touch targets plus padding never match a round number in CSS.
    const syncDockMetrics = () => {
        const box = els.dock.getBoundingClientRect();
        const root = document.documentElement.style;
        root.setProperty('--dock', `${box.height}px`);
        root.setProperty('--dock-w', `${box.width}px`);
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
    let tap = null;
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
    const endTap = (event) => {
        const candidate = tap;
        tap = null;
        if (!candidate || event.pointerId !== candidate.id) return;
        if (performance.now() - candidate.t > TAP_MS) return;
        if (Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > TAP_SLOP_PX) return;
        app.seed();
    };
    els.view.addEventListener('pointerup', endTap);
    els.view.addEventListener('pointercancel', () => { tap = null; });

    // Screen capture does not exist on mobile browsers, so these two sources
    // cannot work there. Detect rather than sniff the platform.
    if (!navigator.mediaDevices?.getDisplayMedia) {
        for (const source of ['system', 'tab']) {
            const button = document.querySelector(`[data-source="${source}"]`);
            if (button) {
                button.disabled = true;
                button.title = 'This browser cannot capture screen or tab audio';
            }
        }
    }

    // Audio source buttons. Each is its own click, because every capture path
    // needs a user gesture and most need a permission prompt.
    for (const button of document.querySelectorAll('[data-source]')) {
        button.addEventListener('click', () => app.selectSource(button.dataset.source));
    }

    els.loadTrack.addEventListener('click', () => {
        const url = els.trackUrl.value.trim();
        if (url) app.player.load(url);
    });

    els.fileInput.addEventListener('change', () => {
        const file = els.fileInput.files?.[0];
        if (file) app.selectSource(SOURCES.FILE, file);
    });

    document.addEventListener('keydown', (event) => {
        if (event.target.matches('input, select, textarea')) return;
        if (event.key === ' ') {
            event.preventDefault();
            togglePause();
        } else if (event.key === 's' || event.key === 'S') app.stepOnce();
        else if (event.key === 'c' || event.key === 'C') app.clear();
        else if (event.key === 'r' || event.key === 'R') app.seed();
    });

    return {
        els,
        setSizeSelection(n) {
            els.size.value = String(n);
        },
        setAudioStatus(text, isError = false) {
            els.audioStatus.textContent = text;
            els.audioStatus.classList.toggle('error', isError);
        },
        setPlayerNote(text) {
            els.playerNote.textContent = text;
        },
        updateHud(stats) {
            els.hudGen.textContent = stats.generation;
            els.hudPop.textContent = stats.population;
            els.hudDrawn.textContent = stats.drawn;
            els.hudRate.textContent = stats.tickRate.toFixed(1);
            els.hudFps.textContent = stats.fps.toFixed(0);
            els.hudBeat.textContent = stats.beats;
            if (!stats.perf) return;
            els.hudPerf.hidden = false;
            els.perfSim.textContent = stats.perf.sim.toFixed(2);
            els.perfSync.textContent = stats.perf.sync.toFixed(2);
            els.perfFrame.textContent = stats.perf.frame.toFixed(1);
            els.perfQuality.textContent = stats.quality;
        },
    };
}

// macOS Chrome offers tab audio but no "share system audio" checkbox, so the
// in-page player is the path that actually works there.
export function isMac() {
    return /Mac/i.test(navigator.platform || navigator.userAgent);
}
