// Control panel and HUD wiring. Owns no state of its own -- it reads and writes
// the app object it is handed.

import { SOURCES } from './audio.js';

const $ = (id) => document.getElementById(id);

export function bindUI(app) {
    const els = {
        rule: $('rule'),
        ruleCustom: $('ruleCustom'),
        size: $('size'),
        wrap: $('wrap'),
        occlusion: $('occlusion'),
        revive: $('revive'),
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
    };

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
    els.occlusion.addEventListener('change', () => {
        app.renderer.occlusionCull = els.occlusion.checked;
        app.markDirty();
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
    els.pause.addEventListener('click', () => {
        app.togglePause();
        els.pause.textContent = app.paused ? 'PLAY' : 'PAUSE';
    });

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
            app.togglePause();
            els.pause.textContent = app.paused ? 'PLAY' : 'PAUSE';
        } else if (event.key === 's' || event.key === 'S') app.stepOnce();
        else if (event.key === 'c' || event.key === 'C') app.clear();
        else if (event.key === 'r' || event.key === 'R') app.seed();
    });

    return {
        els,
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
        },
    };
}

// macOS Chrome offers tab audio but no "share system audio" checkbox, so the
// in-page player is the path that actually works there.
export function isMac() {
    return /Mac/i.test(navigator.platform || navigator.userAgent);
}
