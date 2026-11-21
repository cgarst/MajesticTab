// practiceMenu.js
// The reader's "Practice" button and panel: how you work on the song. The metronome and the count-in, speed, the parts
// and loop range. The loop and click controls are the original ones from the old Practice panel (their ids and
// handlers are untouched); this file moves them here. Speed acts on whichever sound is playing: the synth, or a recording.
// The dock keeps the transport, the Synth | Recording switch and a Volume popover.

import { showPanel, hidePanel, isShown, placePanel, outsideTapCloses } from './readerPanels.js';
import { isTabletop } from '../foldState.js';
import { getRealAudioActiveSource, getRealAudioRate, setRealAudioRate, isRealAudioAvailable } from '../audioSync/realAudioController.js';
import { nextPercentRate } from './practiceSpeed.js';
import { practiceCaps } from './practiceCaps.js';
import { hasAttachedScore } from '../gpProcessor/gpPlayer.js';
import { isAutoScrollAvailable, getAutoPace, stepAutoPace, formatPace, AUTO_EVENT } from './autoScroll.js';
import { isFreeClick, getFreeTempo, stepBpm, setBeats, tap, BEAT_CHOICES, FREE_EVENT } from './freeClick.js';

const $ = (id) => document.getElementById(id);

function onRecording() {
    return Boolean($('mobileYtToggleBtn')?.classList.contains('active-audio-mode'));
}

/** Preset buttons of the active sound: [{label, value, button, active}] */
function activePresets() {
    if (isAutoScrollAvailable()) return [];
    const sel = onRecording() ? '#realAudioRates button[data-rate]' : '#synthSpeedButtons button[data-speed]';
    return [...document.querySelectorAll(sel)].map((b) => ({
        label: b.textContent.trim(), value: parseFloat(b.dataset.rate ?? b.dataset.speed), button: b, active: b.classList.contains('active')
    }));
}

/**
 * A local audio file (or audio stored inside the Guitar Pro file) can play at any speed, so its plus and minus move one
 * percent. YouTube only plays the speeds it offers (it snaps to the nearest), so a video keeps stepping through the presets.
 */
function onLocalRecording() {
    if (!onRecording()) return false;
    const src = getRealAudioActiveSource();
    return src === 'local' || src === 'embedded';
}

/** What the panel can offer for what is open now (see practiceCaps.js). */
function readCaps() {
    const kind = getRealAudioActiveSource();
    const rec = onRecording();
    return practiceCaps({
        hasScore: hasAttachedScore(),
        auto: isAutoScrollAvailable(),
        freeClick: isFreeClick(),
        onRecording: rec,
        originalKind: kind === 'local' || kind === 'embedded' || kind === 'youtube' ? kind : null,
        originalAttached: rec && isRealAudioAvailable(),
        hasPresets: document.querySelectorAll('#realAudioRates button[data-rate]').length > 0
    });
}

function currentSpeedLabel() {
    if (isAutoScrollAvailable()) return formatPace(getAutoPace());
    if (onLocalRecording()) return `${Math.round(getRealAudioRate() * 100)}%`;
    if (onRecording()) {
        const a = document.querySelector('#realAudioRates button.active');
        return a ? a.textContent.trim() : '100%';
    }
    const badgeText = ($('synthSpeedBadge')?.textContent || '').trim();
    if (badgeText) return badgeText;
    return '100%';
}

export function initPracticeMenu() {
    const btn = $('practiceToggleBtn');
    const menu = $('practiceMenu');
    if (!btn || !menu || !$('synthSpeedBadge')) return;

    // ---- Contents ----
    const head = document.createElement('div');
    head.innerHTML = '<div class="practice-title">Practice</div>';

    const speed = document.createElement('div');
    speed.innerHTML = '<div class="practice-speed-head">'
        + '<button type="button" class="btn practice-step" id="practiceSlower" aria-label="Slower">&minus;</button>'
        + '<div><div class="practice-label">Speed</div><div class="practice-speed-value" id="practiceSpeedValue">100%</div></div>'
        + '<button type="button" class="btn practice-step" id="practiceFaster" aria-label="Faster">+</button></div>'
        + '<div class="practice-presets" id="practicePresets"></div>';

    const loopBlock = $('synthLoopSwitch')?.closest('.mb-3');
    const clickBlock = $('synthMetronomeSwitch')?.closest('.d-flex');
    const sections = $('synthSectionsContainer');
    const sectionsLabel = sections?.querySelector('label.form-label');
    if (sectionsLabel) sectionsLabel.textContent = 'Parts';
    // The free click's tempo: only while nothing has a tempo of its own (a PDF, text with no MIDI, a recording with no map)
    const tempo = document.createElement('div');
    tempo.id = 'practiceTempo';
    tempo.innerHTML = '<div class="practice-speed-head">'
        + '<button type="button" class="btn practice-step" id="practiceTempoDown" aria-label="Slower tempo">&minus;</button>'
        + '<div><div class="practice-label">Tempo</div><div class="practice-speed-value" id="practiceTempoValue">100</div></div>'
        + '<button type="button" class="btn practice-step" id="practiceTempoUp" aria-label="Faster tempo">+</button></div>'
        + '<div class="practice-presets practice-tempo-row" id="practiceTempoRow">'
        + '<button type="button" class="btn btn-sm practice-preset" id="practiceTap">Tap</button>'
        + BEAT_CHOICES.map((n) => `<button type="button" class="btn btn-sm practice-preset" data-beats="${n}">${n} beats</button>`).join('')
        + '</div><div class="practice-sub">Steady click. Tap along to line it up.</div>';
    menu.replaceChildren(...[head, clickBlock, tempo, speed, sections, loopBlock].filter(Boolean));
    const blocks = { speed, loopBars: loopBlock, parts: sections, tempo };
    /** Hides what does not apply to what is open (data-cap-hidden, see design.css). */
    function applyCaps() {
        const caps = readCaps();
        for (const [key, el] of Object.entries(blocks)) {
            if (!el) continue;
            const on = key === 'speed' ? Boolean(caps.speed) : caps[key];
            if (on) el.removeAttribute('data-cap-hidden'); else el.setAttribute('data-cap-hidden', '');
        }
        return caps;
    }

    // ---- Open, close, placement ----
    const isOpen = () => isShown(menu);
    const place = () => placePanel(menu, btn);
    function open() {
        showPanel(menu);
        render();
        place();
        btn.setAttribute('aria-expanded', 'true');
        window.refreshSlidingPills?.(menu, true);
    }
    function close() {
        if (!isOpen()) return;
        hidePanel(menu);
        btn.setAttribute('aria-expanded', 'false');
    }
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (isOpen()) close(); else open(); });
    document.addEventListener('pointerdown', (e) => { if (outsideTapCloses() && isOpen() && !menu.contains(e.target) && !btn.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { close(); btn.focus(); } });
    window.addEventListener('resize', () => { if (isOpen()) place(); });

    // ---- Speed ----
    let presetKey = '';
    function renderTempo() {
        const t = getFreeTempo();
        $('practiceTempoValue').textContent = String(t.bpm);
        tempo.querySelectorAll('[data-beats]').forEach((b) => b.classList.toggle('active', Number(b.dataset.beats) === t.beats));
    }
    function render() {
        applyCaps();
        renderTempo();
        $('practiceSpeedValue').textContent = currentSpeedLabel();
        // While playing, the speed readout updates constantly; rebuilding identical buttons would swallow a click between press and release.
        const key = activePresets().map((p) => p.label + (p.active ? '*' : '')).join('|');
        if (key === presetKey && $('practicePresets').childElementCount) return;
        presetKey = key;
        $('practicePresets').replaceChildren(...activePresets().map((p) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn btn-sm practice-preset' + (p.active ? ' active' : '');
            b.textContent = p.label;
            b.addEventListener('click', () => { p.button.click(); setTimeout(render, 0); });
            return b;
        }));
    }
    function step(dir) {
        if (isAutoScrollAvailable()) {
            stepAutoPace(dir);
        } else if (onLocalRecording()) {
            setRealAudioRate(nextPercentRate(getRealAudioRate(), dir));
        } else if (onRecording()) {
            const list = activePresets();
            const i = list.findIndex((p) => p.active);
            const start = i < 0 ? list.findIndex((p) => p.value === 1) : i;
            list[Math.max(0, Math.min(list.length - 1, start + dir))]?.button.click();
        } else {
            (dir < 0 ? $('synthSpeedMinusBtn') : $('synthSpeedPlusBtn'))?.click();
        }
        setTimeout(render, 0);
    }
    $('practiceTempoDown').addEventListener('click', () => stepBpm(-1));
    $('practiceTempoUp').addEventListener('click', () => stepBpm(1));
    $('practiceTap').addEventListener('click', () => tap());
    tempo.querySelectorAll('[data-beats]').forEach((b) => b.addEventListener('click', () => setBeats(Number(b.dataset.beats))));
    window.addEventListener(AUTO_EVENT, () => { if (isOpen()) render(); });
    window.addEventListener(FREE_EVENT, () => { if (isOpen()) render(); });
    $('practiceSlower').addEventListener('click', () => step(-1));
    $('practiceFaster').addEventListener('click', () => step(1));
    const watch = (el, opts) => { if (el) new MutationObserver(() => { if (isOpen()) render(); }).observe(el, opts); };
    watch($('synthSpeedBadge'), { childList: true, characterData: true, subtree: true });
    watch($('synthSpeedButtons'), { attributes: true, subtree: true, attributeFilter: ['class'] });
    watch($('realAudioRates'), { attributes: true, subtree: true, attributeFilter: ['class'] });
    watch($('mobileYtToggleBtn'), { attributes: true, attributeFilter: ['class'] });

    // ---- The button shows a dot while a loop or the click is on, so nothing runs unseen ----
    const syncState = () => {
        const on = (hasAttachedScore() && $('dockLoopBtn')?.getAttribute('aria-pressed') === 'true') || $('dockMetroBtn')?.getAttribute('aria-pressed') === 'true';
        btn.classList.toggle('has-state', on);
    };
    ['dockLoopBtn', 'dockMetroBtn'].forEach((id) => {
        if ($(id)) new MutationObserver(syncState).observe($(id), { attributes: true, attributeFilter: ['aria-pressed', 'class'] });
    });
    syncState();

    initVolumePopover();
}

// ---- Volume: a small popover above the dock's speaker button ----
function initVolumePopover() {
    const trigger = $('dockVolumeBtn');
    const slider = $('synthVolumeSlider');
    if (!trigger || !slider) return;
    const pop = document.createElement('div');
    pop.className = 'dock-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Volume');
    pop.hidden = true;
    pop.classList.add('dock-pop-volume');
    // Vertical: level on top, the slider standing, speaker glyph at the foot
    const section = slider.closest('.mb-3');
    const badge = $('synthVolumeBadge');
    section.replaceChildren();
    section.append(badge, slider);
    pop.append(section);
    document.body.appendChild(pop);

    // Phones: the volume lives in the sound panel (Synth or Original, whichever is open) and the dock has no speaker
    const phone = window.matchMedia('(max-width: 640px), (pointer: coarse) and (orientation: landscape) and (max-height: 500px)');
    const panelBody = (id, sel) => document.querySelector(`#${id} ${sel}`);
    const placeVolume = () => {
        if (!phone.matches && !isTabletop()) {
            if (section.parentNode !== pop) pop.append(section);
            section.classList.remove('panel-volume');
            return;
        }
        section.classList.add('panel-volume');
        const yt = $('ytDropdownPanel');
        const ytOpen = yt && yt.style.display !== 'none' && getComputedStyle(yt).display !== 'none';
        const host = ytOpen ? panelBody('ytDropdownPanel', '.yt-panel-body') : panelBody('synthDropdownPanel', '.synth-panel-body');
        // Output sits last in the panel: the volume, then the audio latency
        const latency = host?.querySelector('#synthLatencySection, #ytLatencySection');
        if (host && (section.parentNode !== host || section.nextElementSibling !== (latency || null))) host.insertBefore(section, latency || null);
    };
    ['synthDropdownPanel', 'ytDropdownPanel'].forEach((id) => {
        const el = $(id);
        if (el) new MutationObserver(placeVolume).observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    });
    phone.addEventListener?.('change', placeVolume);
    window.addEventListener('foldchange', placeVolume);
    placeVolume();

    let open = false;
    const close = () => {
        if (!open) return;
        open = false;
        pop.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
        setTimeout(() => { if (!open) pop.hidden = true; }, 160);
    };
    trigger.addEventListener('pointerdown', (e) => e.stopPropagation());
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (open) return close();
        pop.hidden = false;
        const r = trigger.getBoundingClientRect();
        const w = pop.offsetWidth || 300;
        pop.style.setProperty('left', `${Math.max(8, Math.min(window.innerWidth - w - 8, Math.round(r.left + r.width / 2 - w / 2)))}px`, 'important');
        pop.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
        requestAnimationFrame(() => pop.classList.add('is-open'));
        trigger.setAttribute('aria-expanded', 'true');
        open = true;
    });
    document.addEventListener('pointerdown', (e) => { if (open && !pop.contains(e.target) && !trigger.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { close(); trigger.focus(); } });
}
