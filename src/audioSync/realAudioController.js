// realAudioController.js
// Coordinates the consolidated "Real Audio" mode, unifying YouTube and Local Audio under a single dock button.
// Manages:
//   - Track slot: 'original' vs 'backing' (both YouTube and Local Audio have slots)
//   - Audio source: 'youtube' vs 'local' (selectable per slot, defaulting to 'youtube')
//   - Dynamic dock icon: bi-youtube vs bi-file-earmark-music
//   - Shared speed control: 0.5x, 0.75x, 1x, 1.25x across both engines
//   - Delegating transport actions (play/pause, rewind, availability) to the active engine

import {
    getSongKey, playerState, isYouTubeAvailable, isYouTubePlaying, playPauseYouTube,
    pauseYouTube, rewindYouTube10Seconds, setYouTubePlaybackRate
} from '../youtubePlayer.js';
import {
    isAudioFileAvailable, isAudioFilePlaying, playPauseAudioFile, pauseAudioFile,
    rewindAudioFile10Seconds, setAudioFileRate, setAudioFileSlot, renderAudioFile
} from './audioFilePlayer.js';
import { updateGlobalAudioControls, setActiveAudioMode } from '../utils/navigationUtils.js';

const SLOT_SOURCE_KEY = (songKey, slot) => `real_audio_source_${encodeURIComponent(String(songKey).toLowerCase())}_${slot}`;

const state = {
    slot: 'original',   // 'original' | 'backing'
    rate: 1,            // playback speed multiplier
    initialized: false
};

const $ = (id) => document.getElementById(id);

/**
 * Returns the preferred source for the given slot ('youtube' or 'local').
 * Defaults to 'youtube' initially for any fresh song/slot.
 */
export function getSlotSource(slot = state.slot) {
    const songKey = getSongKey();
    if (!songKey) return 'youtube';
    try {
        const val = localStorage.getItem(SLOT_SOURCE_KEY(songKey, slot));
        if (val === 'local' || val === 'youtube') return val;
    } catch { /* optional */ }
    return 'youtube';
}

/**
 * Stores the preferred source for the given slot.
 */
export function setSlotSource(source, slot = state.slot) {
    const songKey = getSongKey();
    if (!songKey) return;
    try {
        localStorage.setItem(SLOT_SOURCE_KEY(songKey, slot), source);
    } catch { /* optional */ }
}

export function getRealAudioSlot() {
    return state.slot;
}

export function getRealAudioActiveSource() {
    return getSlotSource(state.slot);
}

export function getRealAudioRate() {
    return state.rate;
}

/**
 * Update the dock buttons (#ytToggleBtn and #mobileYtToggleBtn) to reflect the active source and slot.
 */
export function updateRealAudioDockIcon() {
    const activeSource = getRealAudioActiveSource();
    const isLocal = activeSource === 'local';
    const slotLabel = state.slot === 'backing' ? 'Backing Track' : 'Original Song';

    const desktopBtn = $('ytToggleBtn');
    const mobileBtn = $('mobileYtToggleBtn');
    const badgeIcon = $('realAudioBadgeIcon');
    const titleEl = $('realAudioPanelTitle');

    const iconClass = isLocal ? 'bi-file-earmark-music' : 'bi-youtube';
    const titleText = isLocal
        ? `Real Audio: Local File (${slotLabel})`
        : `Real Audio: YouTube (${slotLabel})`;

    for (const btn of [desktopBtn, mobileBtn]) {
        if (!btn) continue;
        btn.title = titleText;
        btn.setAttribute('aria-label', titleText);
        btn.classList.toggle('btn-source-local', isLocal);
        btn.classList.toggle('btn-source-youtube', !isLocal);
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = iconClass;
        }
    }

    if (badgeIcon) {
        badgeIcon.className = `${iconClass} ${isLocal ? 'text-info' : 'text-danger'}`;
    }
    if (titleEl) {
        titleEl.textContent = isLocal ? 'Real Audio · Local File' : 'Real Audio · YouTube';
    }
}

/**
 * Apply playback speed to both YouTube and Local Audio engines, and update UI pills.
 */
export function setRealAudioRate(rate) {
    state.rate = rate;
    setYouTubePlaybackRate(rate);
    setAudioFileRate(rate);

    document.querySelectorAll('#realAudioRates [data-rate]').forEach((b) => {
        b.classList.toggle('active', Math.abs(Number(b.dataset.rate) - rate) < 0.01);
    });
}

/**
 * Switch the visible content inside the consolidated panel between YouTube and Local Audio views.
 */
export function updateRealAudioPanelView() {
    const activeSource = getRealAudioActiveSource();
    const isLocal = activeSource === 'local';

    const ytSection = $('realAudioYtSection');
    const localSection = $('realAudioLocalSection');

    if (ytSection) ytSection.hidden = isLocal;
    if (localSection) localSection.hidden = !isLocal;

    // Update source toggle pills
    const ytPill = $('realAudioSourceYt');
    const localPill = $('realAudioSourceLocal');
    if (ytPill) ytPill.classList.toggle('active', !isLocal);
    if (localPill) localPill.classList.toggle('active', isLocal);

    // Update track mode radio checks
    const origRadio = $('ytTrackOriginal');
    const backingRadio = $('ytTrackBacking');
    if (origRadio) origRadio.checked = state.slot === 'original';
    if (backingRadio) backingRadio.checked = state.slot === 'backing';

    // Update dock icon and panel title
    updateRealAudioDockIcon();

    // Render local file view if local section is visible
    if (isLocal) {
        renderAudioFile();
    }
}

/**
 * Handle switching between 'original' and 'backing' slots.
 */
export function switchRealAudioSlot(slot) {
    if (slot !== 'original' && slot !== 'backing') return;
    state.slot = slot;

    // Notify YouTube of track mode change
    playerState.trackMode = slot;

    // Notify Local Audio of slot change
    setAudioFileSlot(slot);

    // Update panel view and dock icon
    updateRealAudioPanelView();
    updateGlobalAudioControls();
}

/**
 * Handle user switching between YouTube and Local Audio sources.
 */
export function switchRealAudioSource(source) {
    if (source !== 'youtube' && source !== 'local') return;

    // Pause whichever was currently playing before swapping
    if (source === 'local') {
        pauseYouTube();
    } else {
        pauseAudioFile();
    }

    setSlotSource(source, state.slot);
    updateRealAudioPanelView();
    setRealAudioRate(state.rate);
    updateGlobalAudioControls();
}

// --- Transport Delegation -----------------------------------------------------------------------------------------

export function isRealAudioAvailable() {
    return getRealAudioActiveSource() === 'local' ? isAudioFileAvailable() : isYouTubeAvailable();
}

export function isRealAudioPlaying() {
    return isYouTubePlaying() || isAudioFilePlaying();
}

export function playPauseRealAudio() {
    if (getRealAudioActiveSource() === 'local') {
        playPauseAudioFile();
    } else {
        playPauseYouTube();
    }
}

export function rewindRealAudio10Seconds() {
    if (getRealAudioActiveSource() === 'local') {
        rewindAudioFile10Seconds();
    } else {
        rewindYouTube10Seconds();
    }
}

/**
 * Called when a new song/score is loaded.
 */
export function updateSongForRealAudio() {
    state.slot = 'original';
    setAudioFileSlot('original');
    updateRealAudioPanelView();
    updateRealAudioDockIcon();
    setRealAudioRate(1);
    updateGlobalAudioControls();
}

/**
 * Initialize event listeners for the consolidated Real Audio panel.
 */
export function initRealAudioController() {
    if (state.initialized) return;
    state.initialized = true;

    // Source switcher pills
    $('realAudioSourceYt')?.addEventListener('click', (e) => {
        e.stopPropagation();
        switchRealAudioSource('youtube');
    });
    $('realAudioSourceLocal')?.addEventListener('click', (e) => {
        e.stopPropagation();
        switchRealAudioSource('local');
    });

    // Track Slot radio buttons
    $('ytTrackOriginal')?.addEventListener('change', () => {
        if ($('ytTrackOriginal')?.checked) switchRealAudioSlot('original');
    });
    $('ytTrackBacking')?.addEventListener('change', () => {
        if ($('ytTrackBacking')?.checked) switchRealAudioSlot('backing');
    });

    // Speed pills
    document.querySelectorAll('#realAudioRates [data-rate]').forEach((b) => {
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            setRealAudioRate(Number(b.dataset.rate));
        });
    });

    updateRealAudioDockIcon();
}
