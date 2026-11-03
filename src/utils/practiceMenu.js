// practiceMenu.js
// The reader's "Practice" button and panel: how you work on the song. The metronome and the count-in, speed, the parts
// and loop range. The loop and click controls are the original ones from the old Practice panel (their ids and
// handlers are untouched); this file moves them here. Speed acts on whichever sound is playing: the synth, or a recording.
// The dock keeps the transport, the Synth | Recording switch and a Volume popover.

import { showPanel, hidePanel, isShown, placePanel } from './readerPanels.js';

const $ = (id) => document.getElementById(id);

function onRecording() {
    return Boolean($('mobileYtToggleBtn')?.classList.contains('active-audio-mode'));
}

/** Preset buttons of the active sound: [{label, value, button, active}] */
function activePresets() {
    const sel = onRecording() ? '#realAudioRates button[data-rate]' : '#synthSpeedButtons button[data-speed]';
    return [...document.querySelectorAll(sel)].map((b) => ({
        label: b.textContent.trim(), value: parseFloat(b.dataset.rate ?? b.dataset.speed), button: b, active: b.classList.contains('active')
    }));
}

function currentSpeedLabel() {
    if (onRecording()) {
        const a = document.querySelector('#realAudioRates button.active');
        return a ? a.textContent.trim() : '100%';
    }
    const m = ($('synthSpeedBadge')?.textContent || '').match(/\d+(\.\d+)?%/);
    return m ? m[0] : '100%';
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
    menu.replaceChildren(...[head, clickBlock, speed, sections, loopBlock].filter(Boolean));

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
    document.addEventListener('pointerdown', (e) => { if (isOpen() && !menu.contains(e.target) && !btn.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { close(); btn.focus(); } });
    window.addEventListener('resize', () => { if (isOpen()) place(); });

    // ---- Speed ----
    function render() {
        $('practiceSpeedValue').textContent = currentSpeedLabel();
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
        if (onRecording()) {
            const list = activePresets();
            const i = list.findIndex((p) => p.active);
            const start = i < 0 ? list.findIndex((p) => p.value === 1) : i;
            list[Math.max(0, Math.min(list.length - 1, start + dir))]?.button.click();
        } else {
            (dir < 0 ? $('synthSpeedMinusBtn') : $('synthSpeedPlusBtn'))?.click();
        }
        setTimeout(render, 0);
    }
    $('practiceSlower').addEventListener('click', () => step(-1));
    $('practiceFaster').addEventListener('click', () => step(1));
    const watch = (el, opts) => { if (el) new MutationObserver(() => { if (isOpen()) render(); }).observe(el, opts); };
    watch($('synthSpeedBadge'), { childList: true, characterData: true, subtree: true });
    watch($('synthSpeedButtons'), { attributes: true, subtree: true, attributeFilter: ['class'] });
    watch($('realAudioRates'), { attributes: true, subtree: true, attributeFilter: ['class'] });
    watch($('mobileYtToggleBtn'), { attributes: true, attributeFilter: ['class'] });

    // ---- The button shows a dot while a loop or the click is on, so nothing runs unseen ----
    const syncState = () => {
        const on = $('dockLoopBtn')?.getAttribute('aria-pressed') === 'true' || $('dockMetroBtn')?.getAttribute('aria-pressed') === 'true';
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
