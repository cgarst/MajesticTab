// soundSwitch.js
// The two axes of sound in the reader, kept apart:
//   - What you play, in the dock: Full band | Backing. The same words for the Synth and for the Original recording.
//     Synth: Backing is the mix without the guitars (without the bass in bass mode). Original: Backing is the Backing slot,
//     which for a set of stems is the same set with the guitars muted.
//   - Where it comes from, in the Sound panel: Synth | Original, a segmented control at the top of both panels.
// Both only press the controls that already hold the state (the track-mode radios, the slot rows and the hidden Synth and
// Original buttons that carry `active-audio-mode`), so the code that reads those keeps working.

import { onMixerChange, setSoundOff, isSoundOff, isSynthAvailable } from '../gpProcessor/gpPlayer.js';
import { switchRealAudioSlot, getActiveRecording } from '../audioSync/realAudioController.js';
import { isShown } from './readerPanels.js';
import { initSlotRecordings } from '../audioSync/slotRecordings.js';

const $ = (id) => document.getElementById(id);
const shown = (el) => Boolean(el) && el.style.display !== 'none';
const watch = (el, filter, cb) => { if (el) new MutationObserver(cb).observe(el, { attributes: true, attributeFilter: filter }); };

// Sound Off: the Synth keeps driving the cursor and the page, silently. Temporary: it ends when another file opens.
export const SOUND_OFF_EVENT = 'majestictab:sound-off';
function applySoundOff(on) {
    if (isSoundOff() === on) return;
    setSoundOff(on);
    document.body.classList.toggle('sound-off', on);
    const label = $('soundToggleBtn')?.querySelector('.bar-btn-label');
    if (label) label.textContent = on ? 'Sound off' : 'Sound';
    window.dispatchEvent(new CustomEvent(SOUND_OFF_EVENT, { detail: { off: on } }));
}

export function initSoundSwitch() {
    window.addEventListener('majestictab:file-loaded', () => applySoundOff(false));
    initSourceSwitch();
    initPartToggle();
    initSlotRecordings();
    initGuitarsOnly();
}

// ---- Synth | Original, at the top of each Sound panel ----
function initSourceSwitch() {
    const synthBtn = $('mobileSynthToggleBtn');
    const originalBtn = $('mobileYtToggleBtn');
    if (!synthBtn || !originalBtn) return;

    const groups = [];
    [['synthDropdownPanel', '.synth-panel-header'], ['ytDropdownPanel', '.yt-panel-header']].forEach(([panelId, headerSel]) => {
        const panel = $(panelId);
        const header = panel?.querySelector(headerSel);
        if (!header) return;
        const group = document.createElement('div');
        group.className = 'hud-pill-group sound-source';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', 'Sound');
        [['synth', 'Synth', synthBtn], ['original', 'Original', originalBtn], ['off', 'Off', null]].forEach(([kind, label, legacy]) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-sm';
            btn.dataset.source = kind;
            btn.textContent = label;
            // The hidden dock button owns the switch (selectSound): the open panel follows the selection
            btn.addEventListener('click', () => {
                if (btn.getAttribute('aria-pressed') === 'true') return;
                if (kind === 'off') {
                    // Off is the Synth made silent: Original stops (its video sheet closes) and the Synth takes the transport
                    if (!synthBtn.classList.contains('active-audio-mode')) synthBtn.click();
                    applySoundOff(true);
                    sync();
                    return;
                }
                applySoundOff(false);
                // The two panels hang from the same bottom edge but differ in height, so the sheet's top edge (and the score
                // behind it) jumped on every switch. The panel that takes over keeps the height of the one it replaces.
                const open = groups.find(({ panel }) => panel.offsetHeight > 0 && getComputedStyle(panel).display !== 'none');
                if (open) groups.forEach(({ panel }) => { panel.style.minHeight = `${open.panel.offsetHeight}px`; });
                legacy.click();
            });
            group.append(btn);
        });
        header.insertBefore(group, header.firstElementChild);
        if (panelId === 'synthDropdownPanel') {
            const note = document.createElement('p');
            note.id = 'soundOffNote';
            note.className = 'small text-muted mb-0';
            note.textContent = 'No sound. Play scrolls the tab and moves the cursor. The click still sounds.';
            panel.querySelector('.synth-panel-body')?.prepend(note);
        }
        groups.push({ group, panel });
    });

    const sync = () => {
        const synthOn = synthBtn.classList.contains('active-audio-mode');
        const originalOn = originalBtn.classList.contains('active-audio-mode');
        if (originalOn && isSoundOff()) applySoundOff(false);
        const selected = isSoundOff() ? 'off' : originalOn ? 'original' : synthOn ? 'synth' : (shown(synthBtn) ? 'synth' : 'original');
        groups.forEach(({ group, panel }) => {
            group.querySelectorAll('button').forEach((btn) => {
                const kind = btn.dataset.source;
                btn.setAttribute('aria-pressed', String(kind === selected));
                btn.disabled = kind === 'off' ? !(shown(synthBtn) && isSynthAvailable()) : !shown(kind === 'synth' ? synthBtn : originalBtn);
            });
            window.refreshSlidingPills?.(panel, true);
        });
    };
    [synthBtn, originalBtn].forEach((el) => watch(el, ['style', 'class'], sync));
    onMixerChange(sync);
    // The held height only lasts while the panel stays open
    groups.forEach(({ panel }) => watch(panel, ['style', 'class'], () => {
        if (panel.style.minHeight && getComputedStyle(panel).display === 'none') panel.style.minHeight = '';
    }));
    // A panel that opens measures its pill then
    groups.forEach(({ panel }) => watch(panel, ['style', 'class'], () => window.refreshSlidingPills?.(panel, true)));
    sync();
}

// ---- Full band | Backing, in the dock ----
function initPartToggle() {
    const full = $('dockFullBandBtn');
    const back = $('dockBackingBtn');
    const synthBtn = $('mobileSynthToggleBtn');
    const originalBtn = $('mobileYtToggleBtn');
    if (!full || !back || !synthBtn || !originalBtn) return;

    const originalOn = () => originalBtn.classList.contains('active-audio-mode');
    const backingSlot = () => $('slotRowBacking')?.getAttribute('aria-checked') === 'true';

    const sync = () => {
        const any = shown(synthBtn) || shown(originalBtn);
        full.hidden = back.hidden = !any;
        let part = 'full';
        let enabled = true;
        let backingName = 'the guitars';
        if (originalOn()) {
            part = backingSlot() ? 'backing' : 'full';
        } else {
            const noGuitars = $('synthTrackNoGuitars');
            const fullBand = $('synthTrackFullBand');
            // Backing is the synth without its guitar tracks: only a Guitar Pro file has them
            enabled = document.body.classList.contains('gp-file-active') && Boolean(noGuitars) && !noGuitars.disabled;
            part = noGuitars?.checked ? 'backing' : fullBand?.checked ? 'full' : null;
            const label = $('synthTrackNoGuitarsLabel')?.textContent || '';
            if (/bass/i.test(label)) backingName = 'the bass';
        }
        full.setAttribute('aria-pressed', String(part === 'full'));
        back.setAttribute('aria-pressed', String(part === 'backing'));
        full.disabled = isSoundOff() || (!enabled && !originalOn());
        back.disabled = isSoundOff() || (!enabled && !originalOn());
        full.title = 'Play the full band';
        back.title = originalOn() ? 'Play the backing' : `Play the backing, without ${backingName}`;
    };

    const press = (part) => {
        if (originalOn()) {
            switchRealAudioSlot(part === 'backing' ? 'backing' : 'original');
            // A backing nothing is attached to: open the Sound panel, where one is added
            if (part === 'backing' && !getActiveRecording() && !isShown($('ytDropdownPanel'))) $('soundToggleBtn')?.click();
            return;
        }
        $(part === 'backing' ? 'synthTrackNoGuitars' : 'synthTrackFullBand')?.click();
    };
    full.addEventListener('click', () => press('full'));
    back.addEventListener('click', () => press('backing'));

    [synthBtn, originalBtn].forEach((el) => watch(el, ['style', 'class'], sync));
    ['slotRowOriginal', 'slotRowBacking'].forEach((id) => watch($(id), ['aria-checked'], sync));
    document.querySelectorAll('input[name="synthTrackMode"]').forEach((radio) => {
        radio.addEventListener('change', sync);
        watch(radio, ['disabled'], sync);
    });
    watch(document.body, ['class'], sync);
    window.addEventListener(SOUND_OFF_EVENT, sync);
    onMixerChange(sync);
    sync();
}

// ---- Guitars only: a mix preset in the Synth mixer's header (Full band and Backing are in the dock) ----
function initGuitarsOnly() {
    const btn = $('synthGuitarsOnlyBtn');
    const radio = $('synthTrackGuitarsOnly');
    if (!btn || !radio) return;
    const sync = () => {
        const label = ($('synthTrackGuitarsOnlyLabel')?.textContent || 'Guitars only').trim();
        btn.textContent = label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
        btn.hidden = false;
        btn.disabled = radio.disabled;
        btn.setAttribute('aria-pressed', String(radio.checked));
    };
    btn.addEventListener('click', () => radio.click());
    radio.addEventListener('change', sync);
    watch(radio, ['disabled'], sync);
    onMixerChange(sync);
    sync();
}
