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
    getSongKey, playerState, getVideoInfo, jamYouTubeControl, onYouTubeEvent, isYouTubeAvailable, isYouTubePlaying, playPauseYouTube,
    pauseYouTube, rewindYouTube10Seconds, setYouTubePlaybackRate, setYouTubeTrackMode, cancelYouTubeSearch, showYouTubeSource
} from '../youtubePlayer.js';
import {
    isAudioFileAvailable, isAudioFilePlaying, playPauseAudioFile, pauseAudioFile,
    rewindAudioFile10Seconds, setAudioFileRate, setAudioFileSlot, renderAudioFile, getLocalRecording, openAudioSource
} from './audioFilePlayer.js';
import { createYouTubeSource } from './mediaSource.js';
import { closeSheet } from '../ytSheet.js';
import { preferredSlot, rememberLastSlot } from './libraryAudio.js';
import { setActiveAudioMode, updateGlobalAudioControls } from '../utils/navigationUtils.js';
import {
    loadRecord, SYNC_CHANGED_EVENT, setSlotMediaResolver,
    isSyncSharedFromOriginal, setSyncSharedFromOriginal
} from './syncStore.js';
import { buildTimelineModel } from './timelineModel.js';
import { playedBarsFromLookup, buildScoreTimeline } from './scorePositions.js';
import {
    getMidiTickLookup, synthPlayerState, playClick, pauseSynthPlayer, clearSynthHighlights, isSynthPlaying, onTransportEvent
} from '../gpProcessor/gpPlayer.js';
import { startAudioSync, stopAudioSync, getAudioSyncSession } from './audioSyncController.js';

const SLOT_SOURCE_KEY = (songKey, slot) => `real_audio_source_${encodeURIComponent(String(songKey).toLowerCase())}_${slot}`;

const state = {
    slot: 'original',   // 'original' | 'backing'
    rate: 1,            // playback speed multiplier
    initialized: false
};

const embedded = {
    score: null,
    source: null,
    points: [],
    loading: null,
    playGen: 0
};

const $ = (id) => document.getElementById(id);

/**
 * Returns the preferred source for the given slot ('youtube' or 'local').
 * Defaults to 'youtube' initially for any fresh song/slot.
 */
/** True when the open Guitar Pro file carries its own audio track (an Original source, not part of the Synth). */
export function hasEmbeddedAudio() {
    return Boolean(synthPlayerState.audioSyncAvailable);
}

/** Sync points stored inside the Guitar Pro file (`exportFlatSyncPoints`), shaped like a saved sync record's points. */
export function getEmbeddedSyncPoints(score = window.gpApi?.score) {
    try {
        return (score?.exportFlatSyncPoints?.() || []).map((p) => ({
            id: `e_${p.barIndex}_${p.barOccurence}_${Math.round(p.barPosition * 1000)}`,
            barIndex: p.barIndex,
            occurrence: p.barOccurence,
            pos: p.barPosition,
            timeMs: Math.max(0, p.millisecondOffset),
            source: 'auto'
        }));
    } catch { return []; }
}

function destroyEmbeddedSource() {
    embedded.playGen++;
    if (embedded.source) {
        if (getAudioSyncSession()?.source === embedded.source) stopAudioSync();
        embedded.source.destroy();
        embedded.source = null;
    }
    embedded.score = null;
    embedded.points = [];
    embedded.loading = null;
}

function syncEmbeddedFollower(kind = 'idle', originalSelected = $('ytToggleBtn')?.classList.contains('active-audio-mode')) {
    const session = getAudioSyncSession();
    const mine = Boolean(session && embedded.source && session.source === embedded.source);
    const wanted = Boolean(originalSelected)
        && getRealAudioActiveSource() === 'embedded'
        && Boolean(embedded.source)
        && embedded.points.length > 0
        && !isSynthPlaying();
    if (!wanted) {
        if (mine) stopAudioSync();
        return;
    }
    if (mine) {
        session.setPoints(embedded.points);
        return;
    }
    if (kind === 'stop') return;
    startAudioSync({ source: embedded.source, points: embedded.points, alignToCursor: true });
}

function ensureEmbeddedSource() {
    const score = window.gpApi?.score;
    const raw = score?.backingTrack?.rawAudioFile;
    if (!raw?.byteLength) {
        destroyEmbeddedSource();
        return Promise.resolve(false);
    }
    if (embedded.source && embedded.score === score) return Promise.resolve(true);
    if (embedded.score && embedded.score !== score) destroyEmbeddedSource();
    embedded.loading ||= (async () => {
        embedded.score = score;
        embedded.points = getEmbeddedSyncPoints(score);
        const data = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
        const source = await openAudioSource({ id: 'embedded', name: 'In the file', type: 'audio/mpeg', data, durationMs: null });
        if (!source || window.gpApi?.score !== score) {
            source?.destroy();
            return false;
        }
        embedded.source = source;
        source.setRate(state.rate);
        source.on((e) => {
            if (e.type === 'state') {
                updateGlobalAudioControls();
                syncEmbeddedFollower(e.playing ? 'play' : 'stop');
            }
        });
        syncEmbeddedFollower('idle');
        updateGlobalAudioControls();
        return true;
    })().finally(() => { embedded.loading = null; });
    return embedded.loading;
}

export function getSlotSource(slot = state.slot) {
    const songKey = getSongKey();
    if (!songKey) return 'youtube';
    const embedded = slot === 'original' && hasEmbeddedAudio();
    try {
        const val = localStorage.getItem(SLOT_SOURCE_KEY(songKey, slot));
        if (val === 'local' || val === 'youtube') return val;
        if (val === 'embedded' && embedded) return val;
        // Nothing chosen yet: a local audio file attached to the slot wins over a YouTube video
        const key = encodeURIComponent(String(songKey).toLowerCase());
        const localFile = localStorage.getItem(`audio_file_${key}_${slot}`)
            || (slot === 'original' && localStorage.getItem(`audio_file_last_${key}`));
        if (localFile) return 'local';
        // Otherwise the file's own audio is the recording unless a video is already attached
        if (embedded && !localStorage.getItem(`yt_track_${key}_${slot}`)) return 'embedded';
    } catch { /* optional */ }
    return 'youtube';
}

/**
 * The file's embedded audio is decoded and followed through `startAudioSync` (just like a local audio file) while
 * Original is the selected sound and its source is "In the file"; the Synth, or any other source, turns it off.
 * `originalSelected` is passed by the caller that just changed the sound.
 */
export function applyEmbeddedAudioMode(originalSelected = $('ytToggleBtn')?.classList.contains('active-audio-mode')) {
    if (!hasEmbeddedAudio()) {
        destroyEmbeddedSource();
        return;
    }
    const wanted = Boolean(originalSelected) && getRealAudioActiveSource() === 'embedded';
    if (!wanted) {
        embedded.playGen++;
        embedded.source?.pause();
        syncEmbeddedFollower('stop', false);
        return;
    }
    if (embedded.source && embedded.score === window.gpApi?.score) {
        syncEmbeddedFollower('idle', true);
    } else {
        ensureEmbeddedSource();
    }
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
    const isEmbedded = activeSource === 'embedded';
    const slotLabel = state.slot === 'backing' ? 'backing track' : 'original song';
    const attached = isEmbedded || Boolean(getMediaForSlot(state.slot));

    const desktopBtn = $('ytToggleBtn');
    const mobileBtn = $('mobileYtToggleBtn');
    const badgeIcon = $('realAudioBadgeIcon');
    const titleEl = $('realAudioPanelTitle');

    const iconClass = (isLocal || isEmbedded) ? 'bi-file-earmark-music' : 'bi-youtube';
    const titleText = attached
        ? `Original audio: ${isEmbedded ? 'in the file' : isLocal ? 'local file' : 'YouTube'} (${slotLabel})`
        : 'Original audio, not set up';

    for (const btn of [desktopBtn, mobileBtn]) {
        if (!btn) continue;
        btn.title = titleText;
        btn.setAttribute('aria-label', titleText);
        btn.classList.toggle('btn-source-local', isLocal || isEmbedded);
        btn.classList.toggle('btn-source-youtube', !isLocal && !isEmbedded);
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
/** The speed of the recording that is playing, as a multiplier (1 = normal). */
export function getRealAudioRate() {
    return state.rate;
}

export function setRealAudioRate(rate) {
    state.rate = rate;
    setYouTubePlaybackRate(rate);
    setAudioFileRate(rate);
    embedded.source?.setRate(rate);

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
/** The media attached to the Original slot (YouTube, local file, or audio in the file), even when its player is not loaded yet; null when none. */
export function getActiveMedia() {
    if (state.slot === 'original' && getSlotSource('original') === 'embedded') return { kind: 'embedded' };
    return getMediaForSlot(state.slot);
}

export function getActiveRecording() {
    if (getRealAudioActiveSource() === 'embedded') {
        return embedded.source ? { source: embedded.source, media: { kind: 'embedded' }, kind: 'embedded' } : null;
    }
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
    if (emptyHint) emptyHint.hidden = Boolean(getMediaForSlot('original') || getMediaForSlot('backing')) || getRealAudioActiveSource() === 'embedded';

    // Update the two slot rows
    ['original', 'backing'].forEach(slot => {
        const row = $(slot === 'original' ? 'slotRowOriginal' : 'slotRowBacking');
        const srcLine = $(slot === 'original' ? 'slotSourceOriginal' : 'slotSourceBacking');
        const chip = $(slot === 'original' ? 'slotChipOriginal' : 'slotChipBacking');
        if (!row || !srcLine || !chip) return;

        row.setAttribute('aria-checked', state.slot === slot ? 'true' : 'false');

        if (slot === 'original' && getSlotSource(slot) === 'embedded') {
            srcLine.textContent = 'Guitar Pro file · audio stored in the file';
            chip.className = 'chip ok';
            chip.textContent = 'Synced';
            return;
        }

        const media = getMediaForSlot(slot);
        if (!media) {
            srcLine.textContent = slot === 'original' ? 'No original recording attached' : 'No backing track attached';
            chip.className = 'chip';
            chip.textContent = 'Not synced';
            return;
        }

        const rec = songKey ? loadRecord(songKey, media) : null;
        const srcType = media.kind === 'youtube' ? 'YouTube' : 'This device';
        const found = media.kind === 'youtube' ? getVideoInfo(media.videoId) : null;
        const title = found?.title || playerState.title || (media.kind === 'youtube' ? 'YouTube Video' : 'Audio File');
        srcLine.textContent = found?.author ? `${srcType} · ${title} · ${found.author}` : `${srcType} · ${title}`;

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
    const isEmbedded = activeSource === 'embedded';

    const ytSection = $('realAudioYtSection');
    const localSection = $('realAudioLocalSection');

    if (ytSection) ytSection.hidden = isLocal || isEmbedded;
    if (localSection) localSection.hidden = !isLocal;

    // Update source toggle pills
    const ytPill = $('realAudioSourceYt');
    const localPill = $('realAudioSourceLocal');
    const embeddedPill = $('realAudioSourceEmbedded');
    if (ytPill) ytPill.classList.toggle('active', !isLocal && !isEmbedded);
    if (localPill) localPill.classList.toggle('active', isLocal);
    if (embeddedPill) {
        embeddedPill.hidden = !(hasEmbeddedAudio() && state.slot === 'original');
        embeddedPill.classList.toggle('active', isEmbedded);
    }

    // Update track mode radio checks
    const origRadio = $('ytTrackOriginal');
    const backingRadio = $('ytTrackBacking');
    if (origRadio) origRadio.checked = state.slot === 'original';
    if (backingRadio) backingRadio.checked = state.slot === 'backing';

    // Update dock icon and panel title
    updateRealAudioDockIcon();

    // Render local file view if local section is visible
    if (isLocal) {
        closeSheet(); // the video sheet belongs to YouTube playback: a local file has no video (closing pauses)
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
    rememberLastSlot(getSongKey(), slot);

    // Notify YouTube of track mode change: updates the search string and searches again
    setYouTubeTrackMode(slot);

    // Notify Local Audio of slot change
    setAudioFileSlot(slot);

    applyEmbeddedAudioMode();
    if (getRealAudioActiveSource() !== 'embedded') window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));

    // Update panel view and dock icon
    updateRealAudioPanelView();
    updateGlobalAudioControls();
}

/**
 * Handle user switching between YouTube and Local Audio sources.
 */
export function switchRealAudioSource(source) {
    if (source !== 'youtube' && source !== 'local' && source !== 'embedded') return;
    if (source === 'embedded' && !hasEmbeddedAudio()) return;

    // Pause whichever was currently playing before swapping
    pauseYouTube();
    pauseAudioFile();
    embedded.playGen++;
    embedded.source?.pause();

    setSlotSource(source, state.slot);
    if (source !== 'youtube') cancelYouTubeSearch(); // a search under way stops: the slot plays its own audio now
    else showYouTubeSource();
    if (source === 'embedded') closeSheet(); // the file's audio has no video (closing pauses)
    applyEmbeddedAudioMode();
    if (source !== 'embedded') window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
    updateRealAudioPanelView();
    setRealAudioRate(state.rate);
    updateGlobalAudioControls();
}

/** Puts the dock on Original (the synced recording) the way pressing it would, on every platform. */
export async function switchToOriginalSound() {
    try {
        switchRealAudioSlot('original');
        const { toggleYouTubePanel } = await import('../youtubePlayer.js');
        if (typeof setActiveAudioMode === 'function') setActiveAudioMode('youtube');
        if (typeof toggleYouTubePanel === 'function') toggleYouTubePanel(false);
        if (typeof pauseSynthPlayer === 'function') pauseSynthPlayer();
        if (typeof clearSynthHighlights === 'function') clearSynthHighlights();
    } catch (e) {
        console.warn('[Real Audio] Could not switch to original audio:', e);
    }
}

// --- Transport Delegation -----------------------------------------------------------------------------------------

export function isRealAudioAvailable() {
    const source = getRealAudioActiveSource();
    if (source === 'embedded') return hasEmbeddedAudio();
    return source === 'local' ? isAudioFileAvailable() : isYouTubeAvailable();
}

export function isRealAudioPlaying() {
    return isYouTubePlaying() || isAudioFilePlaying() || Boolean(embedded.source?.isPlaying());
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

export function pauseRealAudio() {
    if (countingIn) { clearTimeout(countingIn); countingIn = null; }
    pauseYouTube();
    pauseAudioFile();
    embedded.playGen++;
    embedded.source?.pause();
}

async function playPauseEmbeddedAudio() {
    if (embedded.source?.isPlaying()) {
        embedded.playGen++;
        embedded.source.pause();
        return;
    }
    const token = ++embedded.playGen;
    if (!await ensureEmbeddedSource()) return;
    if (token !== embedded.playGen) return;
    pauseSynthPlayer();
    clearSynthHighlights();
    pauseYouTube();
    pauseAudioFile();
    setActiveAudioMode('real');
    syncEmbeddedFollower('play', true);
    try {
        await embedded.source.play();
    } catch (e) {
        console.warn('[Real Audio] embedded play blocked:', e);
    }
}

function startRealAudio() {
    if (getRealAudioActiveSource() === 'embedded') {
        playPauseEmbeddedAudio();
    } else if (getRealAudioActiveSource() === 'local') {
        playPauseAudioFile();
    } else {
        playPauseYouTube();
    }
}

export function rewindRealAudio10Seconds() {
    if (getRealAudioActiveSource() === 'embedded') {
        if (embedded.source) embedded.source.seek(Math.max(0, embedded.source.getTimeMs() - 10000));
    } else if (getRealAudioActiveSource() === 'local') {
        rewindAudioFile10Seconds();
    } else {
        rewindYouTube10Seconds();
    }
}

/**
 * Called when a new song/score is loaded.
 */
export function updateSongForRealAudio() {
    state.slot = preferredSlot(getSongKey());
    setAudioFileSlot(state.slot);
    updateRealAudioPanelView();
    updateRealAudioDockIcon();
    setRealAudioRate(1);
    updateGlobalAudioControls();
    // A file with its own audio opens on it (its sync points are in the file), as a recording with sync points does
    if (state.slot === 'original' && getRealAudioActiveSource() === 'embedded') {
        setActiveAudioMode('real');
        return;
    }
    applyEmbeddedAudioMode();
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
    $('realAudioSourceEmbedded')?.addEventListener('click', (e) => {
        e.stopPropagation();
        switchRealAudioSource('embedded');
    });

    // Whether the open file carries audio is known only once its player is set up (and is false again when it closes)
    window.addEventListener('majestictab:embedded-audio', () => {
        if (!hasEmbeddedAudio()) destroyEmbeddedSource();
        else applyEmbeddedAudioMode();
        updateRealAudioPanelView();
        updateGlobalAudioControls();
    });

    // The player reports a video's title and channel once it has loaded: the slot rows name the video
    onYouTubeEvent((e) => {
        if (e.type === 'info') updateRecordingSlots();
        else if (e.type === 'state' && e.playing) { embedded.playGen++; embedded.source?.pause(); }
    });
    onTransportEvent((e) => {
        if (e.type === 'state') {
            if (e.playing) { embedded.playGen++; embedded.source?.pause(); }
            syncEmbeddedFollower('stop');
        } else if (e.type === 'ready' || e.type === 'attached') {
            applyEmbeddedAudioMode();
        } else if (e.type === 'detached') {
            destroyEmbeddedSource();
        }
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

// A recording's speed, like the synth's, is a practice setting: each song opens at 100%
if (typeof window !== 'undefined') {
    window.addEventListener('majestictab:file-loaded', () => { if (state.rate !== 1) setRealAudioRate(1); });
}
