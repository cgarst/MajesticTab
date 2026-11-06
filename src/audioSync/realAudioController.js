// realAudioController.js
// Coordinates the consolidated "Real Audio" mode, unifying YouTube and Local Audio under a single dock button.
// Manages:
//   - Track slot: 'original' vs 'backing' (both YouTube and Local Audio have slots)
//   - Audio source: 'youtube' vs 'local' (selectable per slot, defaulting to 'youtube')
//   - Dynamic dock icon: bi-youtube vs bi-file-earmark-music
//   - Shared speed control: 0.5x, 0.75x, 1x, 1.25x across both engines
//   - Delegating transport actions (play/pause, rewind, availability) to the active engine

import {
    applySyncedDefaults, renderSyncedVideos,
    getSongKey, playerState, jamYouTubeControl, onYouTubeEvent, isYouTubeAvailable, isYouTubePlaying, playPauseYouTube,
    pauseYouTube, rewindYouTube10Seconds, setYouTubePlaybackRate, setYouTubeTrackMode
} from '../youtubePlayer.js';
import {
    isAudioFileAvailable, isAudioFilePlaying, playPauseAudioFile, pauseAudioFile,
    rewindAudioFile10Seconds, setAudioFileRate, setAudioFileSlot, renderAudioFile, getLocalRecording
} from './audioFilePlayer.js';
import { createYouTubeSource } from './mediaSource.js';
import { updateGlobalAudioControls } from '../utils/navigationUtils.js';
import {
    loadRecord, SYNC_CHANGED_EVENT, setSlotMediaResolver,
    isSyncSharedFromOriginal, setSyncSharedFromOriginal
} from './syncStore.js';
import { buildTimelineModel } from './timelineModel.js';
import { playedBarsFromLookup, buildScoreTimeline } from './scorePositions.js';
import { getMidiTickLookup, synthPlayerState, playClick } from '../gpProcessor/gpPlayer.js';
import { getAudioSyncSession } from './audioSyncController.js';

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

export function getRealAudioActiveSource() {
    return getSlotSource(state.slot);
}

/**
 * Update the dock buttons (#ytToggleBtn and #mobileYtToggleBtn) to reflect the active source and slot.
 */
export function updateRealAudioDockIcon() {
    const activeSource = getRealAudioActiveSource();
    const isLocal = activeSource === 'local';
    const slotLabel = state.slot === 'backing' ? 'backing track' : 'original song';
    const attached = Boolean(getMediaForSlot(state.slot));

    const desktopBtn = $('ytToggleBtn');
    const mobileBtn = $('mobileYtToggleBtn');
    const badgeIcon = $('realAudioBadgeIcon');
    const titleEl = $('realAudioPanelTitle');

    const iconClass = isLocal ? 'bi-file-earmark-music' : 'bi-youtube';
    const titleText = attached
        ? `Original audio: ${isLocal ? 'local file' : 'YouTube'} (${slotLabel})`
        : 'Original audio, not set up';

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
        titleEl.textContent = 'Original';
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
function getScoreTimeline() {
    try {
        const api = window.gpApi || window.gpState?.canvases?.[0]?.api;
        if (!api) return null;
        const lookup = getMidiTickLookup(api);
        const played = playedBarsFromLookup(lookup);
        return played.length ? buildScoreTimeline(played) : null;
    } catch {
        return null;
    }
}

function getMediaForSlot(slot) {
    const songKey = getSongKey();
    if (!songKey) return null;
    const src = getSlotSource(slot);
    if (src === 'local') {
        const slotFileKey = `audio_file_${encodeURIComponent(songKey.toLowerCase())}_${slot}`;
        let fileId = null;
        try { fileId = localStorage.getItem(slotFileKey); } catch {}
        if (!fileId && slot === 'original') {
            try { fileId = localStorage.getItem(`audio_file_last_${encodeURIComponent(songKey.toLowerCase())}`); } catch {}
        }
        if (fileId) return { kind: 'local', audioId: fileId };
        return null;
    } else {
        const ytKey = `yt_track_${encodeURIComponent(songKey.toLowerCase())}_${slot}`;
        let videoId = null;
        try { videoId = localStorage.getItem(ytKey); } catch {}
        if (videoId) return { kind: 'youtube', videoId };
        return null;
    }
}

// Built on first use: youtubePlayer.js imports this file, so its exports are not ready while this one loads
let ytSource = null;

/**
 * The recording the Original button plays now, as `{ source, media, kind }`, or null when the slot has nothing loaded.
 * The media descriptor is the one the sync points are stored under.
 */
export function getActiveRecording() {
    if (!getMediaForSlot(state.slot)) return null;
    if (getRealAudioActiveSource() === 'local') {
        const local = getLocalRecording();
        return local ? { ...local, kind: 'local' } : null;
    }
    ytSource ||= createYouTubeSource(jamYouTubeControl, onYouTubeEvent);
    return ytSource.id ? { source: ytSource, media: { kind: 'youtube', videoId: ytSource.id }, kind: 'youtube' } : null;
}

setSlotMediaResolver(() => ({ original: getMediaForSlot('original'), backing: getMediaForSlot('backing') }));

export function updateRecordingSlots() {
    const songKey = getSongKey();
    const timeline = getScoreTimeline();

    updateRealAudioDockIcon();
    const emptyHint = $('realAudioEmptyHint');
    if (emptyHint) emptyHint.hidden = Boolean(getMediaForSlot('original') || getMediaForSlot('backing'));

    // Update the two slot rows
    ['original', 'backing'].forEach(slot => {
        const row = $(slot === 'original' ? 'slotRowOriginal' : 'slotRowBacking');
        const srcLine = $(slot === 'original' ? 'slotSourceOriginal' : 'slotSourceBacking');
        const chip = $(slot === 'original' ? 'slotChipOriginal' : 'slotChipBacking');
        if (!row || !srcLine || !chip) return;

        row.setAttribute('aria-checked', state.slot === slot ? 'true' : 'false');

        const media = getMediaForSlot(slot);
        if (!media) {
            srcLine.textContent = slot === 'original' ? 'No original recording attached' : 'No backing track attached';
            chip.className = 'chip';
            chip.textContent = 'Not synced';
            return;
        }

        const rec = songKey ? loadRecord(songKey, media) : null;
        const srcType = media.kind === 'youtube' ? 'YouTube' : 'This device';
        const title = playerState.title || (media.kind === 'youtube' ? 'YouTube Video' : 'Audio File');
        srcLine.textContent = `${srcType} · ${title}`;

        if (!rec || !rec.points?.length) {
            chip.className = 'chip';
            chip.textContent = 'Not synced';
        } else if (timeline) {
            const view = buildTimelineModel({ timeline, points: rec.points, axis: 'bars' });
            if (view.gaps.length === 0) {
                chip.className = 'chip ok';
                chip.textContent = 'Synced';
            } else {
                chip.className = 'chip warn';
                chip.textContent = 'Partly synced';
            }
        } else {
            chip.className = 'chip ok';
            chip.textContent = 'Synced';
        }
    });

    // The shared-points option only applies to a backing track
    const shareRow = $('realAudioShareSyncRow');
    if (shareRow) {
        shareRow.hidden = state.slot !== 'backing';
        const shareSwitch = $('realAudioShareSyncSwitch');
        if (shareSwitch) shareSwitch.checked = Boolean(songKey) && isSyncSharedFromOriginal(songKey);
    }
}

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

    // Update the slot rows
    updateRecordingSlots();
}

/**
 * Handle switching between 'original' and 'backing' slots.
 */
export function switchRealAudioSlot(slot) {
    if (slot !== 'original' && slot !== 'backing') return;
    state.slot = slot;

    // Notify YouTube of track mode change: updates the search string and searches again
    setYouTubeTrackMode(slot);

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

let countingIn = null;

export function playPauseRealAudio() {
    if (countingIn) { clearTimeout(countingIn); countingIn = null; return; }
    // With sync data and the count-in on, a bar of clicks at the recording's tempo comes before it starts
    if (synthPlayerState.countInEnabled && !isRealAudioPlaying()) {
        const plan = getAudioSyncSession()?.usable?.() ? getAudioSyncSession().countInPlan?.() : null;
        if (plan) {
            let n = 0;
            const tick = () => {
                if (n >= plan.beats) { countingIn = null; startRealAudio(); return; }
                playClick(n === 0);
                n++;
                countingIn = setTimeout(tick, plan.intervalMs);
            };
            tick();
            return;
        }
    }
    startRealAudio();
}

function startRealAudio() {
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

    // Slot rows
    $('slotRowOriginal')?.addEventListener('click', () => switchRealAudioSlot('original'));
    $('slotRowBacking')?.addEventListener('click', () => switchRealAudioSlot('backing'));

    // Backing track uses the original recording's sync points
    $('realAudioShareSyncSwitch')?.addEventListener('change', () => {
        const songKey = getSongKey();
        if (!songKey) return;
        setSyncSharedFromOriginal(songKey, $('realAudioShareSyncSwitch').checked);
        window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
    });

    window.addEventListener(SYNC_CHANGED_EVENT, () => {
        applySyncedDefaults();
        renderSyncedVideos();
        updateRecordingSlots();
    });

    updateRealAudioDockIcon();
    updateRecordingSlots();
}
