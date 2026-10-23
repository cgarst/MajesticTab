// gpPlayer.js
// In-app artificial instrument (SoundFont synthesizer) player for Guitar Pro files
import { pauseYouTube, toggleYouTubePanel } from '../youtubePlayer.js';
import { gpState, renderGPPage, applyGpTrackSelection } from './gpHandler.js';
import { getPagesPerView } from '../utils/viewModeUtils.js';
import { updateGlobalRewindButton, setActiveAudioMode } from '../utils/navigationUtils.js';
import { getInstrumentMode, isTrackGuitar, isTrackBass } from '../utils/tuningUtils.js';
import { enableIOSAudioPlayback, pauseIOSAudioPlayback, configureAudioSession, registerAudioContext, resumeTrackedAudioContexts, areTrackedAudioContextsRunning } from '../utils/iosAudioUnlock.js';
import { fretboardController } from '../fretboard/fretboardController.js';
import { applySoundFontsToApi } from '../soundFontStore.js';

const STORAGE_KEY_SYNTH_VOLUME = 'majestic_synth_volume';

let initialSavedVolume = 1.0;
try {
    const storedVol = localStorage.getItem(STORAGE_KEY_SYNTH_VOLUME);
    if (storedVol !== null && !isNaN(parseFloat(storedVol))) {
        initialSavedVolume = Math.max(0, Math.min(1, parseFloat(storedVol)));
    }
} catch (_) {}

let currentApi = null;
let currentScore = null;
let isSeeking = false;

export const synthPlayerState = {
    isOpen: false,
    isPlaying: false,
    isReady: false,
    hasPlayed: false,
    soundFontLoaded: false,
    currentTime: 0,
    endTime: 0,
    playbackSpeed: 1.0,
    metronomeEnabled: false,
    countInEnabled: false,
    masterVolume: initialSavedVolume,
    trackMode: 'fullBand',
    audioSyncAvailable: false,
    audioSyncEnabled: false,
    loopEnabled: false,
    loopStartMeasure: 1,
    loopEndMeasure: 1
};

// --- Output latency compensation -----------------------------------------
// Bluetooth speakers play audio late, so visuals (cursor, scroll, fretboard) are delayed by the
// same amount while playing. Applies to synth and embedded audio; YouTube is not synced.
const STORAGE_KEY_AUDIO_LATENCY = 'majestic.audioLatencyMs';
const MAX_AUDIO_LATENCY_MS = 1000;
let audioLatencyMs = 0;
try {
    const saved = parseInt(localStorage.getItem(STORAGE_KEY_AUDIO_LATENCY), 10);
    if (Number.isFinite(saved)) audioLatencyMs = Math.max(0, Math.min(MAX_AUDIO_LATENCY_MS, saved));
} catch (_) {}
let pendingVisuals = [];

/** Run a visual update now, or after the audio latency while playing. Order is preserved. */
function deferVisual(fn) {
    if (!audioLatencyMs || !synthPlayerState.isPlaying) { fn(); return; }
    const entry = { fn, timer: 0 };
    entry.timer = setTimeout(() => {
        pendingVisuals = pendingVisuals.filter(e => e !== entry);
        fn();
    }, audioLatencyMs);
    pendingVisuals.push(entry);
}

/** Run queued visual updates immediately (pause, stop, latency change) so nothing lands late. */
function flushDeferredVisuals() {
    const queue = pendingVisuals;
    pendingVisuals = [];
    for (const e of queue) { clearTimeout(e.timer); e.fn(); }
}

export function getAudioLatencyMs() { return audioLatencyMs; }

export function setAudioLatencyMs(ms) {
    const v = Math.max(0, Math.min(MAX_AUDIO_LATENCY_MS, Math.round(Number(ms) || 0)));
    flushDeferredVisuals();
    audioLatencyMs = v;
    try { localStorage.setItem(STORAGE_KEY_AUDIO_LATENCY, String(v)); } catch (_) {}
}

// --- Jam Mode hooks -------------------------------------------------------
// Jam code subscribes to transport events and may intercept local transport
// actions (host lead time, controller commands, follower lock) without being
// sprinkled through the playback functions.
const transportListeners = new Set();
let transportInterceptor = null;
// Last known song position (speed independent) and when it was valid, from position events
// and Jam seeks. WebKit fires position events less often, so extrapolate from here.
let lastPositionSongMs = 0;
let lastPositionEventAt = 0;
let jamMuted = false; // Jam host muted guests: synth stays silent regardless of the volume slider
const effectiveVolume = () => (jamMuted ? 0 : synthPlayerState.masterVolume);
let jamAudioTracks = null; // Jam host assigned this device track indices: only those are audible
let jamMuteTracks = null; // Jam host: tracks assigned to others, silenced on this unassigned device
let jamViewTracks = null; // Jam host assigned this device track indices: only those are shown
let jamPrevViewTracks = null; // tracks that were visible before the Jam view restriction
let warmingUp = false; // muted Jam Mode warm-up play in progress; player events are suppressed

// AlphaTab's timePosition is wall-clock time at the current playback speed (it doubles when
// speed halves). Jam Mode syncs on speed-independent song time instead: raw ms x speed.
function currentSpeedFactor() {
    return Number(currentApi?.playbackSpeed) || synthPlayerState.playbackSpeed || 1;
}

function toSongMs(rawMs) {
    return (rawMs || 0) * currentSpeedFactor();
}

/**
 * Subscribe to transport events: 'state' | 'position' | 'speed' | 'loop' | 'metronome' | 'countIn'.
 * Returns an unsubscribe function.
 */
export function onTransportEvent(cb) {
    transportListeners.add(cb);
    return () => transportListeners.delete(cb);
}

function emitTransportEvent(type, detail = {}) {
    transportListeners.forEach((cb) => {
        try { cb({ type, ...detail }); } catch (e) { console.error('[Synth Player] transport listener error:', e); }
    });
}

/**
 * Install (or clear with null) a function `(action, payload) => boolean` that is
 * consulted before local play/pause, seek (ms or beat-click tick), rewind and speed actions. Returning true
 * means the action was handled and the local player must not act on it.
 */
export function setTransportInterceptor(fn) {
    transportInterceptor = typeof fn === 'function' ? fn : null;
}

function interceptTransport(action, payload) {
    if (!transportInterceptor) return false;
    try { return Boolean(transportInterceptor(action, payload)); } catch (e) {
        console.error('[Synth Player] transport interceptor error:', e);
        return false;
    }
}

export function syncSynthTrackModeLabels() {
    const isBass = getInstrumentMode() === 'bass';
    const soloLabel = document.getElementById('synthTrackGuitarsOnlyLabel') || document.querySelector('label[for="synthTrackGuitarsOnly"]');
    const muteLabel = document.getElementById('synthTrackNoGuitarsLabel') || document.querySelector('label[for="synthTrackNoGuitars"]');
    if (soloLabel) soloLabel.textContent = isBass ? 'Bass Only' : 'Guitars Only';
    if (muteLabel) muteLabel.textContent = isBass ? 'No Bass' : 'No Guitars';
}

function applySynthTrackMode() {
    if (!currentApi || !currentScore?.tracks) return;

    syncSynthTrackModeLabels();

    if (jamAudioTracks) {
        const audible = currentScore.tracks.map((_, i) => i).filter(i => jamAudioTracks.includes(i));
        const silent = currentScore.tracks.map((_, i) => i).filter(i => !jamAudioTracks.includes(i));
        if (silent.length) currentApi.changeTrackMute(silent, true);
        if (audible.length) currentApi.changeTrackMute(audible, false);
        applyMixerVolumes();
        return;
    }
    if (jamMuteTracks) {
        const all = currentScore.tracks.map((_, i) => i);
        const silent = all.filter(i => jamMuteTracks.includes(i));
        const audible = all.filter(i => !jamMuteTracks.includes(i));
        if (silent.length) currentApi.changeTrackMute(silent, true);
        if (audible.length) currentApi.changeTrackMute(audible, false);
        applyMixerVolumes();
        return;
    }

    applyMixerToApi();
    syncTrackModeFromMixer();
}

// --- Per-track mixer ------------------------------------------------------
// Volume is a multiplier (1 = the song's level), pan is AlphaTab's 0-16 balance (8 = center).
// The Audio Tracks selector is a preset over the mute flags, so both views stay in step.
const MIXER_DEFAULT = Object.freeze({ volume: 1, pan: 8, mute: false, solo: false });
const mixerListeners = new Set();
let mixerState = new Map(); // track index -> { volume, pan, mute, solo }
let panReloadTimer = null;
// Jam client: the host's mix as { trackIndex: { volume, pan, mute, solo } }, omitting tracks left at default.
// While set, the local mixer is locked and this device's own mix is parked in localMixerBackup.
let jamHostMixer = null;
let localMixerBackup = null;

function mixerFor(index) {
    if (!mixerState.has(index)) {
        // Tracks keep the pan stored in the file as their starting point
        const track = currentScore?.tracks?.[index];
        const pan = track?.playbackInfo?.balance ?? MIXER_DEFAULT.pan;
        const entry = { ...MIXER_DEFAULT, pan, defaultPan: pan };
        const host = jamHostMixer?.[index];
        if (host) {
            Object.assign(entry, hostMixEntry(host, pan));
            if (track && entry.pan !== pan) {
                track.playbackInfo.balance = entry.pan;
                schedulePanReload();
            }
        }
        mixerState.set(index, entry);
    }
    return mixerState.get(index);
}

function hostMixEntry(host, defaultPan) {
    return {
        volume: Math.min(1.5, Math.max(0, Number(host.volume ?? 1))),
        pan: Math.min(16, Math.max(0, Math.round(Number(host.pan ?? defaultPan)))),
        mute: Boolean(host.mute),
        solo: Boolean(host.solo)
    };
}

/** The mix as a sparse { trackIndex: { volume, pan, mute, solo } } holding only tracks that differ from default. */
export function getMixerSnapshot() {
    const snap = {};
    mixerState.forEach((m, i) => {
        if (m.volume !== 1 || m.pan !== m.defaultPan || m.mute || m.solo) {
            snap[i] = { volume: m.volume, pan: m.pan, mute: m.mute, solo: m.solo };
        }
    });
    return snap;
}

/** Jam client: follow the host's mix (null returns to this device's own). The mixer UI is locked meanwhile. */
function setHostMixer(snapshot) {
    let panChanged = false;
    const setPan = (track, pan) => {
        if (track.playbackInfo.balance !== pan) {
            track.playbackInfo.balance = pan;
            panChanged = true;
        }
    };
    if (snapshot) {
        if (!jamHostMixer) localMixerBackup = new Map([...mixerState].map(([k, v]) => [k, { ...v }]));
        jamHostMixer = snapshot;
        (currentScore?.tracks || []).forEach((track, i) => {
            const m = mixerFor(i);
            const host = snapshot[i];
            const next = host ? hostMixEntry(host, m.defaultPan) : { ...MIXER_DEFAULT, pan: m.defaultPan };
            Object.assign(m, next);
            setPan(track, m.pan);
        });
    } else if (jamHostMixer) {
        jamHostMixer = null;
        mixerState = localMixerBackup || new Map();
        localMixerBackup = null;
        (currentScore?.tracks || []).forEach((track, i) => setPan(track, mixerFor(i).pan));
    } else {
        return;
    }
    if (panChanged) schedulePanReload();
    applySynthTrackMode();
    emitMixerChange();
}

function isTargetTrack(track) {
    return getInstrumentMode() === 'bass' ? isTrackBass(track) : isTrackGuitar(track);
}

function emitMixerChange() {
    mixerListeners.forEach((cb) => {
        try { cb(); } catch (e) { console.error('[Synth Player] mixer listener error:', e); }
    });
}

/** Subscribe to mixer changes (including ones made through the Audio Tracks selector). */
export function onMixerChange(cb) {
    mixerListeners.add(cb);
    return () => mixerListeners.delete(cb);
}

/** Tracks with their current mixer settings, or [] when no score is loaded. */
export function getMixerTracks() {
    return (currentScore?.tracks || []).map((t, i) => ({
        index: i,
        name: t.name || `Track ${i + 1}`,
        isTarget: isTargetTrack(t),
        ...mixerFor(i)
    }));
}

function applyMixerVolumes() {
    (currentScore?.tracks || []).forEach((track, i) => {
        try { currentApi.changeTrackVolume([track], mixerFor(i).volume); } catch (_) {}
    });
}

function applyMixerToApi() {
    if (!currentApi || !currentScore?.tracks) return;
    const api = currentApi;
    currentScore.tracks.forEach((track, i) => {
        const m = mixerFor(i);
        try {
            api.changeTrackMute([track], m.mute);
            api.changeTrackSolo([track], m.solo);
            api.changeTrackVolume([track], m.volume);
        } catch (e) {
            console.warn('[Synth Player] mixer apply failed:', e);
        }
    });
}

function syncTrackModeFromMixer() {
    const tracks = currentScore?.tracks || [];
    const targets = tracks.map((t, i) => i).filter(i => isTargetTrack(tracks[i]));
    const others = tracks.map((_, i) => i).filter(i => !targets.includes(i));
    const anySolo = tracks.some((_, i) => mixerFor(i).solo);
    const allMuted = (list) => list.length > 0 && list.every(i => mixerFor(i).mute);
    const noneMuted = (list) => list.every(i => !mixerFor(i).mute);
    let mode = null; // null = custom mix, no preset highlighted
    if (!anySolo) {
        if (noneMuted(targets) && noneMuted(others)) mode = 'fullBand';
        else if (allMuted(targets) && noneMuted(others)) mode = 'noGuitars';
        else if (allMuted(others) && noneMuted(targets)) mode = 'guitarsOnly';
    }
    synthPlayerState.trackMode = mode || 'custom';
    document.querySelectorAll('input[name="synthTrackMode"]').forEach(radio => {
        radio.checked = radio.value === mode;
    });
}

/** Audio Tracks selector: set the mute flags for a preset (clears solos). */
function applyTrackModePreset(mode) {
    if (jamHostMixer) { syncTrackModeFromMixer(); return; }
    (currentScore?.tracks || []).forEach((track, i) => {
        const m = mixerFor(i);
        const target = isTargetTrack(track);
        m.solo = false;
        m.mute = mode === 'noGuitars' ? target : mode === 'guitarsOnly' ? !target : false;
    });
    applySynthTrackMode();
    emitMixerChange();
}

/** Change one track's mixer settings: any of { volume, pan, mute, solo }. */
export function setTrackMixer(index, patch) {
    const track = currentScore?.tracks?.[index];
    if (!track || jamAudioTracks || jamMuteTracks || jamHostMixer) return;
    const m = mixerFor(index);
    if (patch.volume !== undefined) m.volume = Math.min(1.5, Math.max(0, patch.volume));
    if (patch.mute !== undefined) m.mute = Boolean(patch.mute);
    if (patch.solo !== undefined) m.solo = Boolean(patch.solo);
    if (patch.pan !== undefined) {
        m.pan = Math.min(16, Math.max(0, Math.round(patch.pan)));
        track.playbackInfo.balance = m.pan;
        schedulePanReload();
    }
    applySynthTrackMode();
    emitMixerChange();
}

/** Clear every track back to full volume, centered, unmuted and unsoloed. */
export function resetMixer() {
    if (jamHostMixer) return;
    let panChanged = false;
    (currentScore?.tracks || []).forEach((track, i) => {
        const { defaultPan } = mixerFor(i);
        if (mixerFor(i).pan !== defaultPan) {
            track.playbackInfo.balance = defaultPan;
            panChanged = true;
        }
        mixerState.set(i, { ...MIXER_DEFAULT, pan: defaultPan, defaultPan });
    });
    if (panChanged) schedulePanReload();
    applySynthTrackMode();
    emitMixerChange();
}

// Pan is baked into the generated MIDI, so a change regenerates it. Keep the playhead and
// play state across the reload, then reapply the rest of the mix.
function schedulePanReload() {
    clearTimeout(panReloadTimer);
    panReloadTimer = setTimeout(() => {
        const api = currentApi;
        if (!api || typeof api.loadMidiForScore !== 'function') return;
        const tick = api.tickPosition;
        const wasPlaying = synthPlayerState.isPlaying;
        if (wasPlaying) { try { api.pause(); } catch (_) {} }
        api.loadMidiForScore();
        const restore = () => {
            if (currentApi !== api) return;
            applyMixerToApi();
            try { api.tickPosition = tick; } catch (_) {}
            if (wasPlaying) api.play();
        };
        // Not midiLoaded.on: AlphaTab 1.8.4 recurses forever in its loadedMidiInfo getter once a MIDI is loaded.
        setTimeout(restore, 400);
    }, 250);
}

/**
 * Toggle the soundfont between full band and muting the guitars (or bass in bass mode).
 * Returns the new track mode, or null when the synth isn't available.
 */
export function toggleSynthNoGuitars() {
    if (!currentApi || !currentScore?.tracks || jamAudioTracks || jamMuteTracks || jamHostMixer) return null;
    applyTrackModePreset(synthPlayerState.trackMode === 'noGuitars' ? 'fullBand' : 'noGuitars');
    return synthPlayerState.trackMode;
}

/** Applies (or lifts) the Jam host's "only show assigned tracks" restriction on the rendered score. */
export function reapplyJamTrackView() {
    const api = currentApi;
    if (!api?.score?.tracks) return;
    const valid = (jamViewTracks || []).filter(i => api.score.tracks[i]);
    if (valid.length) {
        if (!jamPrevViewTracks) jamPrevViewTracks = (api.tracks || []).map(t => t.index);
        applyGpTrackSelection(valid);
    } else if (jamPrevViewTracks) {
        const prev = jamPrevViewTracks.filter(i => api.score.tracks[i]);
        jamPrevViewTracks = null;
        if (prev.length) applyGpTrackSelection(prev);
    }
}

function isWithinLoopRange() {
    if (!currentApi || !currentScore?.masterBars?.length) return false;
    const firstBar = currentScore.masterBars[synthPlayerState.loopStartMeasure - 1];
    const lastBar = currentScore.masterBars[synthPlayerState.loopEndMeasure - 1];
    if (!firstBar || !lastBar) return false;
    const startTick = firstBar.start;
    const endTick = lastBar.start + lastBar.calculateDuration();
    const currentTick = currentApi.tickPosition ?? 0;
    return currentTick >= startTick && currentTick < endTick;
}

function seekToLoopStart() {
    const firstBar = currentScore?.masterBars?.[synthPlayerState.loopStartMeasure - 1];
    if (currentApi && firstBar) {
        currentApi.tickPosition = firstBar.start;
    }
}

export function applyLoopSettings() {
    if (!currentApi) return;
    emitTransportEvent('loop', {
        enabled: synthPlayerState.loopEnabled,
        startMeasure: synthPlayerState.loopStartMeasure,
        endMeasure: synthPlayerState.loopEndMeasure
    });
    if (synthPlayerState.loopEnabled && currentScore?.masterBars?.length) {
        const firstBar = currentScore.masterBars[synthPlayerState.loopStartMeasure - 1];
        const lastBar = currentScore.masterBars[synthPlayerState.loopEndMeasure - 1];
        if (firstBar && lastBar) {
            const startTick = firstBar.start;
            const endTick = lastBar.start + lastBar.calculateDuration();
            currentApi.playbackRange = { startTick, endTick };
            currentApi.isLooping = true;
            return;
        }
    }
    currentApi.isLooping = false;
    currentApi.playbackRange = null;
}

/**
 * Format milliseconds into M:SS or MM:SS string
 */
function formatTime(ms) {
    if (!ms || isNaN(ms) || ms < 0) return '0:00';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Update the Top Bar and Panel UI elements
 */
export function updateSynthUI() {
    const metronomeQuickBtn = document.getElementById('synthMetronomeQuickBtn');
    const metronomeSwitch = document.getElementById('synthMetronomeSwitch');
    const countInSwitch = document.getElementById('synthCountInSwitch');
    const timeDisplay = document.getElementById('synthTimeDisplay');
    const currentTimeText = document.getElementById('synthCurrentTimeText');
    const totalTimeText = document.getElementById('synthTotalTimeText');
    const seekSlider = document.getElementById('synthSeekSlider');
    const positionPercent = document.getElementById('synthPositionPercent');
    const speedBadge = document.getElementById('synthSpeedBadge');
    const loopSwitch = document.getElementById('synthLoopSwitch');
    const loopStartInput = document.getElementById('synthLoopStartMeasure');
    const loopEndInput = document.getElementById('synthLoopEndMeasure');
    const hasScore = Boolean(currentApi);
    const canPlay = Boolean(currentApi && (synthPlayerState.isReady || synthPlayerState.soundFontLoaded || currentApi?.isReadyForPlayback || currentApi?.isSoundFontLoaded));
    const measureCount = currentScore?.masterBars?.length || 1;

    updateGlobalRewindButton();

    if (metronomeQuickBtn) {
        metronomeQuickBtn.disabled = !canPlay;
        if (synthPlayerState.metronomeEnabled) {
            metronomeQuickBtn.classList.add('active');
        } else {
            metronomeQuickBtn.classList.remove('active');
        }
    }

    if (metronomeSwitch) {
        metronomeSwitch.checked = synthPlayerState.metronomeEnabled;
    }

    if (countInSwitch) {
        countInSwitch.checked = synthPlayerState.countInEnabled;
    }

    if (timeDisplay) {
        timeDisplay.textContent = `${formatTime(synthPlayerState.currentTime)} / ${formatTime(synthPlayerState.endTime)}`;
    }

    if (currentTimeText) {
        currentTimeText.textContent = formatTime(synthPlayerState.currentTime);
    }

    if (totalTimeText) {
        totalTimeText.textContent = formatTime(synthPlayerState.endTime);
    }

    const pct = synthPlayerState.endTime > 0 
        ? Math.min(100, Math.max(0, (synthPlayerState.currentTime / synthPlayerState.endTime) * 100))
        : 0;

    if (positionPercent) {
        positionPercent.textContent = `${Math.round(pct)}%`;
    }

    if (seekSlider && !isSeeking) {
        seekSlider.value = pct * 10; // 0 to 1000 range
        seekSlider.disabled = !canPlay || synthPlayerState.endTime <= 0;
    }

    if (speedBadge) {
        speedBadge.textContent = `${Math.round(synthPlayerState.playbackSpeed * 100)}%`;
    }

    if (loopSwitch) {
        loopSwitch.checked = synthPlayerState.loopEnabled;
        loopSwitch.disabled = !hasScore;
    }

    if (loopStartInput && loopEndInput) {
        synthPlayerState.loopStartMeasure = Math.min(measureCount, Math.max(1, synthPlayerState.loopStartMeasure));
        synthPlayerState.loopEndMeasure = Math.min(measureCount, Math.max(1, synthPlayerState.loopEndMeasure));
        loopStartInput.min = '1';
        loopStartInput.max = String(measureCount);
        loopStartInput.value = String(synthPlayerState.loopStartMeasure);
        loopStartInput.disabled = !hasScore;
        loopEndInput.min = '1';
        loopEndInput.max = String(measureCount);
        loopEndInput.value = String(synthPlayerState.loopEndMeasure);
        loopEndInput.disabled = !hasScore;
    }

    // Update speed button active classes
    const speedButtons = document.querySelectorAll('#synthSpeedButtons button');
    speedButtons.forEach(btn => {
        const speedVal = parseFloat(btn.dataset.speed);
        if (Math.abs(speedVal - synthPlayerState.playbackSpeed) < 0.005) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // Update Embedded Audio Sync switch and description
    const audioSyncSection = document.getElementById('synthAudioSyncSection');
    const audioSyncSwitch = document.getElementById('synthAudioSyncSwitch');
    const audioSyncDesc = document.getElementById('synthAudioSyncDesc');
    const trackModeContainer = document.getElementById('synthTrackModeContainer');
    const trackModeRadios = document.querySelectorAll('input[name="synthTrackMode"]');

    if (audioSyncSwitch) {
        audioSyncSwitch.disabled = !synthPlayerState.audioSyncAvailable || !hasScore;
        audioSyncSwitch.checked = synthPlayerState.audioSyncAvailable && synthPlayerState.audioSyncEnabled;
    }
    if (audioSyncSection) {
        if (synthPlayerState.audioSyncAvailable && hasScore) {
            audioSyncSection.classList.remove('opacity-50');
            if (audioSyncDesc) {
                audioSyncDesc.textContent = synthPlayerState.audioSyncEnabled
                    ? 'Guitar Pro 8 synced audio track active'
                    : 'SoundFont MIDI synthesizer active';
            }
        } else {
            audioSyncSection.classList.add('opacity-50');
            if (audioSyncDesc) {
                audioSyncDesc.textContent = 'Not provided in this tab';
            }
        }
    }
    if (trackModeContainer) {
        if (synthPlayerState.audioSyncAvailable && synthPlayerState.audioSyncEnabled) {
            trackModeContainer.classList.add('opacity-50');
            trackModeRadios.forEach(r => r.disabled = true);
        } else {
            trackModeContainer.classList.remove('opacity-50');
            trackModeRadios.forEach(r => r.disabled = !canPlay);
        }
    }

    const volumeSlider = document.getElementById('synthVolumeSlider');
    const volumeBadge = document.getElementById('synthVolumeBadge');
    if (volumeSlider) {
        volumeSlider.value = String(Math.round(synthPlayerState.masterVolume * 100));
        volumeSlider.disabled = !canPlay;
    }
    if (volumeBadge) {
        volumeBadge.textContent = `${Math.round(synthPlayerState.masterVolume * 100)}%`;
    }
}

const playedBeatState = { beat: null, shownBeat: null };

export const READER_CURSOR_WIDTH = 20;

/**
 * Build SVG path for a vertically oriented pill/stadium with a pointed V-shaped bottom
 */
export function buildPillVPath(w, h) {
    const r = w / 2;
    const v = Math.min(12, Math.max(8, h * 0.12));
    return `M ${r} 1 A ${r - 1} ${r - 1} 0 0 1 ${w - 1} ${r} L ${w - 1} ${h - v} L ${r + 2} ${h - 3} Q ${r} ${h - 1} ${r - 2} ${h - 3} L 1 ${h - v} L 1 ${r} A ${r - 1} ${r - 1} 0 0 1 ${r} 1 Z`;
}

/**
 * Get AlphaTab's MidiTickLookup instance if available
 */
export function getMidiTickLookup(api) {
    if (!api) return null;
    if (api.tickLookup) return api.tickLookup;
    if (typeof alphaTab !== 'undefined' && alphaTab.midi?.MidiTickLookup) {
        for (const k in api) {
            try {
                if (api[k] instanceof alphaTab.midi.MidiTickLookup) return api[k];
            } catch (_) {}
        }
    }
    return api.Qw || null;
}

/**
 * Get the exact playback tick in the MIDI timeline for a beat, accounting for repeats
 */
export function getPlaybackTickForBeat(beat, api) {
    if (!beat) return 0;
    const lookup = getMidiTickLookup(api);
    if (lookup && typeof lookup.getBeatStart === 'function') {
        try {
            const tick = lookup.getBeatStart(beat);
            if (typeof tick === 'number' && !isNaN(tick)) {
                return tick;
            }
        } catch (_) {}
    }
    const masterBar = beat.voice?.bar?.masterBar;
    const masterBarStart = masterBar?.start ?? 0;
    return masterBarStart + (beat.playbackStart ?? 0);
}

// Manual scrolling (incl. inertial momentum) takes priority over playback follow, otherwise both write scrollTop and the sheet jitters
const USER_SCROLL_IDLE_MS = 150;
const USER_SCROLL_GRACE_MS = 2000;
let userScrollingUntil = 0;
let userScrollHeld = false;
let autoScrollWrite = false;
let userScrollOutput = null;

function bumpUserScroll(ms) {
    userScrollingUntil = Math.max(userScrollingUntil, performance.now() + ms);
}

function watchUserScroll(output) {
    if (userScrollOutput === output) return;
    userScrollOutput = output;
    const hold = () => { userScrollHeld = true; bumpUserScroll(USER_SCROLL_IDLE_MS); };
    const release = () => { userScrollHeld = false; bumpUserScroll(USER_SCROLL_GRACE_MS); };
    output.addEventListener('wheel', () => bumpUserScroll(USER_SCROLL_IDLE_MS), { passive: true });
    output.addEventListener('touchstart', hold, { passive: true });
    output.addEventListener('touchend', release, { passive: true });
    output.addEventListener('touchcancel', release, { passive: true });
    output.addEventListener('scroll', () => {
        if (autoScrollWrite) return;
        // Momentum scrolls keep firing scroll events after the finger lifts; extend until they stop
        bumpUserScroll(userScrollHeld ? USER_SCROLL_IDLE_MS : USER_SCROLL_GRACE_MS);
    }, { passive: true });
}

/**
 * Handle auto-scrolling with quick snap and read-ahead in Continuous Mode
 * Adjusts scrolling to consider the virtual fretboard dock so that current stave group is entirely visible
 */
export function updateContinuousPlaybackScroll(currentTick, force = false, targetBeat = null) {
    if (!currentApi || !currentScore || (!synthPlayerState.isPlaying && !force)) return;

    const pageModeRadio = document.getElementById('pageModeRadio');
    const isPageMode = pageModeRadio ? pageModeRadio.checked : false;
    if (isPageMode) return;

    const output = document.getElementById('output');
    if (!output) return;

    watchUserScroll(output);
    if (!force && performance.now() < userScrollingUntil) return;

    const fretboardDock = document.getElementById('fretboardDock');
    const isFretboardOpen = document.body.classList.contains('fretboard-open') && fretboardDock && fretboardDock.style.display !== 'none';
    const fretboardHeight = isFretboardOpen ? (fretboardDock.offsetHeight || 165) : 0;

    const viewportHeight = output.clientHeight;
    if (viewportHeight <= 0) return;

    // Available visible height above the bottom dock
    const visibleViewportHeight = Math.max(100, viewportHeight - fretboardHeight);

    const TOP_PADDING = 12;
    const outputRect = output.getBoundingClientRect();

    // 1. Staff system bounds lookup from renderer
    const boundsLookup = currentApi.renderer?.boundsLookup;
    let targetStaffSystem = null;
    let sysY = 0;
    let sysH = 140;

    if (boundsLookup?.staffSystems?.length && currentScore?.masterBars?.length) {
        let activeMasterBarIndex = targetBeat?.voice?.bar?.masterBar?.index ?? -1;
        if (activeMasterBarIndex === -1) {
            const lookup = getMidiTickLookup(currentApi);
            if (lookup && typeof lookup.eg === 'function') {
                try {
                    const entry = lookup.eg(currentTick);
                    if (entry?.masterBar?.index !== undefined) {
                        activeMasterBarIndex = entry.masterBar.index;
                    }
                } catch (_) {}
            }
        }
        if (activeMasterBarIndex === -1) {
            const masterBars = currentScore.masterBars;
            for (let i = 0; i < masterBars.length; i++) {
                const mb = masterBars[i];
                const barStart = mb.start;
                const barEnd = barStart + mb.calculateDuration();
                if (currentTick >= barStart && currentTick < barEnd) {
                    activeMasterBarIndex = i;
                    break;
                }
            }
            if (activeMasterBarIndex === -1 && masterBars.length > 0) {
                if (currentTick >= masterBars[masterBars.length - 1].start) {
                    activeMasterBarIndex = masterBars.length - 1;
                }
            }
        }
        if (activeMasterBarIndex >= 0) {
            for (let s = 0; s < boundsLookup.staffSystems.length; s++) {
                const sys = boundsLookup.staffSystems[s];
                if (sys.bars && sys.bars.some(b => b.index === activeMasterBarIndex)) {
                    targetStaffSystem = sys;
                    break;
                }
            }
            if (targetStaffSystem) {
                const container = gpState.canvases[0]?.container;
                const containerTop = container ? container.offsetTop : 0;
                const sysRealY = targetStaffSystem.realBounds?.y ?? targetStaffSystem.visualBounds?.y ?? 0;
                sysH = targetStaffSystem.realBounds?.h ?? targetStaffSystem.visualBounds?.h ?? 140;
                sysY = containerTop + sysRealY;
            }
        }
    }

    // 2. Cursor element bounds if placed and visible
    const cursorEl = document.querySelector('.gp-reader-cursor') || document.querySelector('.at-cursor-beat') || document.querySelector('.at-cursor-bar');
    const cursorRect = (cursorEl && cursorEl.style.display !== 'none') ? cursorEl.getBoundingClientRect() : null;
    const hasValidCursor = cursorRect && cursorRect.height > 0;

    const cursorVisualTop = hasValidCursor ? (cursorRect.top - outputRect.top) : (sysY > 0 ? (sysY - output.scrollTop) : 0);
    const cursorVisualBottom = hasValidCursor ? (cursorRect.bottom - outputRect.top) : (cursorVisualTop + sysH);
    const cursorDocY = cursorVisualTop + output.scrollTop;

    const visualTop = (sysY > 0) ? (sysY - output.scrollTop) : cursorVisualTop;
    const visualBottom = visualTop + sysH;

    // 3. Occlusion and read-ahead checks
    const isAboveTop = visualTop < 0 || (hasValidCursor && cursorVisualTop < 0);
    const isHidingBehindFretboard = isFretboardOpen && (Math.max(visualBottom, cursorVisualBottom) > (visibleViewportHeight - 16));
    const isBelowThreshold = synthPlayerState.isPlaying && (visualTop > (visibleViewportHeight * 0.60) || (hasValidCursor && cursorVisualTop > (visibleViewportHeight * 0.60)));

    if (isAboveTop || isHidingBehindFretboard || isBelowThreshold) {
        const maxScroll = output.scrollHeight - output.clientHeight;
        const isFirstSystem = boundsLookup?.staffSystems?.length && targetStaffSystem === boundsLookup.staffSystems[0];
        const anchorY = (sysY > 0) ? sysY : cursorDocY;
        const targetScrollTop = (isFirstSystem || anchorY < 160)
            ? 0
            : Math.max(0, Math.min(maxScroll, anchorY - TOP_PADDING));
        if (Math.abs(output.scrollTop - targetScrollTop) > 5) {
            autoScrollWrite = true;
            output.scrollTop = targetScrollTop;
            // scroll events fire asynchronously; clear the flag after they've been dispatched
            requestAnimationFrame(() => requestAnimationFrame(() => { autoScrollWrite = false; }));
        }
    }
}

if (typeof window !== 'undefined') {
    window.__majesticUpdateContinuousPlaybackScroll = updateContinuousPlaybackScroll;
}

/**
 * Apply cursor position and active notes from a clicked beat before or during playback
 */
export function applyCursorPositionFromBeat(beat) {
    if (!beat || !currentApi) return;

    const pageModeRadio = document.getElementById('pageModeRadio');
    const isPageMode = pageModeRadio ? pageModeRadio.checked : false;

    const masterBar = beat.voice?.bar?.masterBar;

    // Calculate beat playback tick in the MIDI timeline (accounting for repeats)
    const beatTick = getPlaybackTickForBeat(beat, currentApi);
    if (interceptTransport('seekTick', { tick: beatTick })) return;

    // Set playback position
    currentApi.tickPosition = beatTick;
    synthPlayerState.currentTime = currentApi.timePosition || 0;

    // Enable visual cursor display
    document.body.classList.add('synth-playback-started');

    // Position custom line reader cursor
    const boundsLookup = currentApi.renderer?.boundsLookup;
    let beatBounds = boundsLookup?.findBeat(beat);
    if (!beatBounds && boundsLookup?.staffSystems?.length && masterBar) {
        for (const sys of boundsLookup.staffSystems) {
            for (const mb of (sys.bars || [])) {
                if (mb.index === masterBar.index) {
                    for (const tb of (mb.bars || [])) {
                        if (tb.beats && tb.beats.length > 0) {
                            let closest = tb.beats[0];
                            let minDiff = Infinity;
                            for (const bb of tb.beats) {
                                const diff = Math.abs((bb.beat?.playbackStart ?? 0) - (beat.playbackStart ?? 0));
                                if (diff < minDiff) {
                                    minDiff = diff;
                                    closest = bb;
                                }
                            }
                            if (closest) {
                                beatBounds = closest;
                                break;
                            }
                        }
                    }
                    break;
                }
            }
            if (beatBounds) break;
        }
    }
    if (beatBounds) {
        const startBeatX = beatBounds.visualBounds?.x ?? beatBounds.realBounds?.x ?? 0;
        currentApi.customCursorHandler?.placeBeatCursor(null, beatBounds, startBeatX);
    }

    // Update fretboard notes visualizer
    fretboardController.showBeatsAtCursor(beat);

    // Update time display in top bar / panel
    updateSynthUI();

    // Adjust scrolling in continuous mode so stave group is entirely visible above fretboard
    if (!isPageMode) {
        updateContinuousPlaybackScroll(beatTick, true, beat);
    }
}

/**
 * Create a custom cursor handler for AlphaTab in Scroll and Page Modes
 * - Suppresses the whole-measure highlight box
 * - Replaces the beat line with a Line Reader tool shape
 *   (vertically oriented stadium / pill outline with pointed V-shaped bottom)
 * - Restricts bounds to physical staff lines to prevent bleeding into adjacent systems
 * - Handles smooth transitions between measures and across multi-track scores in Page Mode
 */
export function createCustomCursorHandler(api) {
    let readerEl = null;
    let svgPathEl = null;
    let lastH = 0;

    function getOrCreateReader() {
        const container = gpState.canvases[0]?.container;
        const wrapper = api?._cursorWrapper?.element || container?.querySelector('.at-cursors') || document.querySelector('.at-cursors') || container;
        if (!wrapper) return null;
        if (!readerEl || !wrapper.contains(readerEl)) {
            readerEl = wrapper.querySelector('.gp-reader-cursor');
            if (!readerEl) {
                readerEl = document.createElement('div');
                readerEl.className = 'gp-reader-cursor';
                readerEl.innerHTML = `<svg class="gp-reader-svg" width="${READER_CURSOR_WIDTH}" height="100" viewBox="0 0 ${READER_CURSOR_WIDTH} 100"><path class="gp-reader-path" fill="none" d="" /></svg>`;
                wrapper.appendChild(readerEl);
            }
            svgPathEl = readerEl.querySelector('.gp-reader-path');
        }
        return readerEl;
    }

    function updateReaderDimensions(h) {
        if (!readerEl || Math.abs(h - lastH) < 1) return;
        lastH = h;
        const svg = readerEl.querySelector('svg');
        if (svg) {
            svg.setAttribute('width', `${READER_CURSOR_WIDTH}`);
            svg.setAttribute('height', `${h}`);
            svg.setAttribute('viewBox', `0 0 ${READER_CURSOR_WIDTH} ${h}`);
        }
        if (!svgPathEl) svgPathEl = readerEl.querySelector('.gp-reader-path');
        if (svgPathEl) {
            svgPathEl.setAttribute('d', buildPillVPath(READER_CURSOR_WIDTH, h));
        }
    }

    function getPageCursorContext(beatBounds) {
        const masterBounds = beatBounds?.barBounds?.masterBarBounds;
        if (!masterBounds) return null;

        const sysBounds = masterBounds.staffSystemBounds?.realBounds 
                       || masterBounds.staffSystemBounds?.visualBounds;
        const sysY = sysBounds?.y ?? 0;

        const originalBlocks = gpState.canvases[0]?.container 
            ? Array.from(gpState.canvases[0].container.querySelectorAll('div.at-surface.at > div')) 
            : [];
        let matchedBlockIndex = -1;
        if (originalBlocks.length > 0) {
            let minDiff = Infinity;
            originalBlocks.forEach((b, bIdx) => {
                const bTop = parseFloat(b.style.top || '0');
                const diff = Math.abs(bTop - sysY);
                if (diff < minDiff) {
                    minDiff = diff;
                    matchedBlockIndex = bIdx;
                }
            });
        }
        if (matchedBlockIndex < 0) return null;

        // Auto-advance page if necessary
        if (gpState.pages && gpState.pages.length) {
            let targetPage = -1;
            for (let p = 0; p < gpState.pages.length; p++) {
                if (gpState.pages[p].some(b => b.dataset.blockIndex === String(matchedBlockIndex))) {
                    targetPage = p;
                    break;
                }
            }
            if (targetPage >= 0) {
                const pagesPerView = getPagesPerView(true);
                if (targetPage < gpState.currentPageIndex || targetPage >= gpState.currentPageIndex + pagesPerView) {
                    gpState.currentPageIndex = targetPage;
                    const output = document.getElementById('output');
                    const continuousModeRadio = document.getElementById('continuousModeRadio');
                    renderGPPage(output, true, continuousModeRadio);
                }
            }
        }

        const visibleBlock = document.querySelector(`.alphaTab-gp-content div[data-block-index="${matchedBlockIndex}"]`);
        if (!visibleBlock) return null;

        // Remove stale page cursors on other blocks
        document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => {
            if (!visibleBlock.contains(el)) el.remove();
        });

        let cursorBeat = visibleBlock.querySelector('.gp-page-cursor-beat');
        let isNew = false;
        if (!cursorBeat) {
            cursorBeat = document.createElement('div');
            cursorBeat.className = 'gp-page-cursor-beat gp-reader-cursor';
            visibleBlock.appendChild(cursorBeat);
            isNew = true;
        }

        const svg = visibleBlock.querySelector('svg');
        const blockRect = visibleBlock.getBoundingClientRect();
        const svgRect = svg ? svg.getBoundingClientRect() : null;
        const svgLeftOffset = (svgRect && blockRect.width > 0) ? (svgRect.left - blockRect.left) : 0;
        const svgTopOffset = (svgRect && blockRect.height > 0) ? (svgRect.top - blockRect.top) : parseFloat(visibleBlock.style.paddingTop || '0');

        let staffTopY = visibleBlock._cachedStaffTopY;
        let staffHeight = visibleBlock._cachedStaffHeight;
        if (staffTopY === undefined && svg) {
            const staffElements = [];
            svg.querySelectorAll('rect, line, path').forEach(el => {
                try {
                    const b = el.getBBox ? el.getBBox() : null;
                    if (b && b.width > 50 && b.height <= 5) {
                        staffElements.push(b);
                    }
                } catch (e) {}
            });
            if (staffElements.length >= 2) {
                const minSvgY = Math.min(...staffElements.map(b => b.y));
                const maxSvgY = Math.max(...staffElements.map(b => b.y + b.height));
                staffTopY = svgTopOffset + minSvgY - 4;
                staffHeight = (maxSvgY - minSvgY) + 8;
            } else {
                staffTopY = null;
                staffHeight = null;
            }
            visibleBlock._cachedStaffTopY = staffTopY;
            visibleBlock._cachedStaffHeight = staffHeight;
        }

        const lineBounds = masterBounds.lineAlignedBounds || masterBounds.visualBounds;
        const sysRealY = sysBounds?.y ?? 0;
        const defaultBarY = svgTopOffset + ((lineBounds?.y ?? 0) - sysRealY);
        const barY = (staffTopY !== null && staffTopY !== undefined) ? staffTopY : defaultBarY;
        const barH = (staffHeight !== null && staffHeight !== undefined) ? staffHeight : (lineBounds?.h ?? 100);

        const topPadding = 15;
        const bottomPadding = 12;
        const cursorY = barY - topPadding;
        const cursorH = barH + topPadding + bottomPadding;

        let cursorSvg = cursorBeat.querySelector('svg');
        if (!cursorSvg) {
            cursorBeat.innerHTML = `<svg class="gp-reader-svg" width="${READER_CURSOR_WIDTH}" height="${cursorH}" viewBox="0 0 ${READER_CURSOR_WIDTH} ${cursorH}"><path class="gp-reader-path" fill="none" d="" /></svg>`;
            cursorSvg = cursorBeat.querySelector('svg');
        }
        const path = cursorBeat.querySelector('.gp-reader-path');
        if (path && (!cursorBeat._lastH || Math.abs(cursorBeat._lastH - cursorH) >= 1)) {
            cursorBeat._lastH = cursorH;
            cursorSvg.setAttribute('width', `${READER_CURSOR_WIDTH}`);
            cursorSvg.setAttribute('height', `${cursorH}`);
            cursorSvg.setAttribute('viewBox', `0 0 ${READER_CURSOR_WIDTH} ${cursorH}`);
            path.setAttribute('d', buildPillVPath(READER_CURSOR_WIDTH, cursorH));
        }

        cursorBeat.style.top = `${cursorY}px`;
        cursorBeat.style.width = `${READER_CURSOR_WIDTH}px`;
        cursorBeat.style.height = `${cursorH}px`;
        cursorBeat.style.display = 'block';

        const scaleX = (svgRect && svg?.viewBox?.baseVal?.width > 0)
            ? (svgRect.width / svg.viewBox.baseVal.width)
            : 1;

        return { cursorBeat, svgLeftOffset, scaleX, isNew };
    }

    return {
        onAttach(cursors) {
            getOrCreateReader();
        },
        onDetach(cursors) {
            if (readerEl) {
                readerEl.remove();
                readerEl = null;
            }
            document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => el.remove());
        },
        reset() {
            if (readerEl) {
                readerEl.style.display = 'none';
            }
            document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => el.remove());
        },
        placeBarCursor(barCursor, beatBounds) {
            // Measure highlight box is removed in favor of the line reader tool
            if (barCursor) {
                barCursor.setBounds(0, 0, 0, 0);
            }
        },
        placeBeatCursor(beatCursor, beatBounds, startBeatX) {
            if (beatBounds?.beat && !synthPlayerState.isPlaying) {
                fretboardController.showBeatsAtCursor(beatBounds.beat);
            }

            const pageModeRadio = document.getElementById('pageModeRadio');
            const isPageMode = pageModeRadio ? pageModeRadio.checked : false;

            if (isPageMode) {
                if (readerEl) readerEl.style.display = 'none';
                const ctx = getPageCursorContext(beatBounds);
                if (ctx) {
                    const posX = ctx.svgLeftOffset + (startBeatX * ctx.scaleX);
                    ctx.cursorBeat.style.transition = 'none';
                    ctx.cursorBeat.style.left = `${posX}px`;
                    void ctx.cursorBeat.offsetWidth; // Force reflow
                    ctx.cursorBeat._placed = true;
                }
                return;
            }

            document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => el.remove());

            const masterBounds = beatBounds?.barBounds?.masterBarBounds;
            // Use lineAlignedBounds to strictly bound to physical staff lines
            const lineBounds = masterBounds?.lineAlignedBounds 
                || masterBounds?.visualBounds 
                || beatBounds?.barBounds?.visualBounds;

            if (lineBounds) {
                const topPadding = 15;
                const bottomPadding = 12;
                let cursorY = lineBounds.y - topPadding;
                let cursorH = lineBounds.h + topPadding + bottomPadding;

                // Safety guard: clamp to staff system bounds to prevent bleeding into next system
                const sysBounds = masterBounds?.staffSystemBounds?.visualBounds 
                               || masterBounds?.staffSystemBounds?.realBounds;
                if (sysBounds && sysBounds.h > 0) {
                    const maxBottom = sysBounds.y + sysBounds.h;
                    if (cursorY + cursorH > maxBottom) {
                        cursorH = Math.max(30, maxBottom - cursorY);
                    }
                }

                const reader = getOrCreateReader();
                if (reader) {
                    updateReaderDimensions(cursorH);
                    reader.style.transition = 'none';
                    reader.style.left = `${startBeatX}px`;
                    reader.style.top = `${cursorY}px`;
                    reader.style.height = `${cursorH}px`;
                    reader.style.display = 'block';
                    void reader.offsetWidth; // Force reflow so transition starts cleanly
                }

                if (beatCursor) {
                    beatCursor.transitionToX(0, startBeatX);
                    beatCursor.setBounds(startBeatX, cursorY, 1, cursorH);
                }
            }
        },
        transitionBeatCursor(beatCursor, beatBounds, startBeatX, nextBeatX, duration, cursorMode) {
            const pageModeRadio = document.getElementById('pageModeRadio');
            const isPageMode = pageModeRadio ? pageModeRadio.checked : false;

            const factor = (cursorMode === alphaTab.midi?.MidiTickLookupFindBeatResultCursorMode?.ToNextBext) ? 2 : 1;
            const targetX = startBeatX + (nextBeatX - startBeatX) * factor;
            const animDuration = duration * factor;

            if (isPageMode) {
                if (readerEl) readerEl.style.display = 'none';
                const ctx = getPageCursorContext(beatBounds);
                if (ctx) {
                    const posX = ctx.svgLeftOffset + (targetX * ctx.scaleX);
                    if (!ctx.cursorBeat._placed || ctx.isNew) {
                        const startX = ctx.svgLeftOffset + (startBeatX * ctx.scaleX);
                        ctx.cursorBeat.style.transition = 'none';
                        ctx.cursorBeat.style.left = `${startX}px`;
                        void ctx.cursorBeat.offsetWidth;
                        ctx.cursorBeat._placed = true;
                    }
                    ctx.cursorBeat.style.transition = `left ${animDuration}ms linear`;
                    ctx.cursorBeat.style.left = `${posX}px`;
                }
                return;
            }

            const reader = getOrCreateReader();
            if (reader) {
                reader.style.transition = `left ${animDuration}ms linear`;
                reader.style.left = `${targetX}px`;
            }

            if (beatCursor) {
                beatCursor.transitionToX(animDuration, targetX);
            }
        }
    };
}

/**
 * Attach AlphaTab API to the synth player
 */
function applyPlayerState(api, state) {
    synthPlayerState.isPlaying = (state === 1);
    if (state !== 1) flushDeferredVisuals();
    if (state === 1) {
        synthPlayerState.hasPlayed = true;
        document.body.classList.add('synth-playback-started');
        pauseYouTube();
        setActiveAudioMode('synth');
        enableIOSAudioPlayback();
    } else {
        pauseIOSAudioPlayback();
    }
    updateSynthUI();
    emitTransportEvent('state', { playing: state === 1, timeMs: toSongMs(api.timePosition) });
}

// Resume playback after the app returns from the background (iOS suspends/interrupts audio)
let resumeAfterBackground = false;

document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
        resumeAfterBackground = Boolean(synthPlayerState.isPlaying);
        return;
    }
    if (!resumeAfterBackground) return;
    resumeAfterBackground = false;
    if (!currentApi) return;

    configureAudioSession();
    await resumeTrackedAudioContexts();
    // Give AlphaTab a moment to publish any state change caused by the interruption
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!currentApi) return;

    if (synthPlayerState.isPlaying && areTrackedAudioContextsRunning()) return;
    if (synthPlayerState.isPlaying) {
        // AlphaTab thinks it is playing but the audio output died: restart it
        try { currentApi.pause(); } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    playPauseSynthLocal(true);
});

export function attachAlphaTabApi(api) {
    currentApi = api;
    currentScore = api.score;
    clearTimeout(panReloadTimer);
    mixerState = new Map();
    if (jamHostMixer) localMixerBackup = new Map();
    emitMixerChange();

    if (!api.customCursorHandler) {
        api.customCursorHandler = createCustomCursorHandler(api);
        const handler = api.customCursorHandler;
        for (const name of ['placeBeatCursor', 'transitionBeatCursor']) {
            const orig = handler[name].bind(handler);
            handler[name] = (...args) => deferVisual(() => orig(...args));
        }
    }

    if (api?.player) {
        if (api.player.context) registerAudioContext(api.player.context);
        if (api.player._audioContext) registerAudioContext(api.player._audioContext);
        if (api.player.synth?.context) registerAudioContext(api.player.synth.context);
    }

    try {
        api.masterVolume = effectiveVolume();
    } catch (_) {}

    synthPlayerState.loopEnabled = false;
    synthPlayerState.loopStartMeasure = 1;
    synthPlayerState.loopEndMeasure = Math.max(1, currentScore?.masterBars?.length || 1);
    applyLoopSettings();

    synthPlayerState.isPlaying = false;
    synthPlayerState.hasPlayed = false;
    synthPlayerState.currentTime = 0;
    synthPlayerState.endTime = 0;
    synthPlayerState.isReady = false;
    synthPlayerState.soundFontLoaded = false;
    document.body.classList.remove('synth-playback-started');

    // Update song title in panel
    const titleEl = document.getElementById('synthPanelTitle');
    if (titleEl && api.score) {
        const title = api.score.title || 'Instrument Playback';
        const artist = api.score.artist ? ` - ${api.score.artist}` : '';
        titleEl.textContent = `${title}${artist}`;
    }

    // Check if player or soundfont is already loaded
    if (api.isSoundFontLoaded || api.player?.isSoundFontLoaded) {
        synthPlayerState.soundFontLoaded = true;
    }
    if (api.isReadyForPlayback || api.isReady || api.player?.isReadyForPlayback) {
        synthPlayerState.isReady = true;
    }

    const hasAudioSync = Boolean(currentScore?.backingTrack?.rawAudioFile);
    synthPlayerState.audioSyncAvailable = hasAudioSync;
    synthPlayerState.audioSyncEnabled = hasAudioSync && (
        api.settings?.player?.playerMode === alphaTab.PlayerMode.EnabledBackingTrack ||
        api.settings?.player?.playerMode === alphaTab.PlayerMode.EnabledAutomatic
    );

    if (!synthPlayerState.audioSyncEnabled) {
        applySynthTrackMode();
    }

    fretboardController.attachAlphaTabApi(api);

    // SoundFont Loaded Event
    api.soundFontLoaded.on(() => {
        console.log('[Synth Player] SoundFont loaded successfully');
        synthPlayerState.soundFontLoaded = true;
        updateSynthUI();
    });

    // SoundFont Load Failed Event
    api.soundFontLoadFailed?.on((err) => {
        console.error('[Synth Player] SoundFont load failed:', err);
        synthPlayerState.soundFontLoaded = false;
        synthPlayerState.isReady = false;
        updateSynthUI();
    });

    // Player Ready Event
    api.playerReady.on(() => {
        console.log('[Synth Player] Audio player is ready');
        synthPlayerState.isReady = true;
        // Apply existing preferences
        api.playbackSpeed = synthPlayerState.playbackSpeed;
        api.metronomeVolume = synthPlayerState.metronomeEnabled ? 1.0 : 0.0;
        api.countInVolume = synthPlayerState.countInEnabled ? 1.0 : 0.0;
        if (!synthPlayerState.audioSyncEnabled) {
            applySynthTrackMode();
        }
        updateSynthUI();
    });

    if (api.playerReadyForPlayback) {
        api.playerReadyForPlayback.on(() => {
            synthPlayerState.isReady = true;
            synthPlayerState.soundFontLoaded = true;
            updateSynthUI();
            emitTransportEvent('ready');
        });
    }

    // Player State Changed (0: Stopped, 1: Playing, 2: Paused)
    api.playerStateChanged.on((args) => {
        if (warmingUp) return;
        applyPlayerState(api, args.state);
    });

    // Multi-track active beats synchronization for fretboard visualizer
    if (api.activeBeatsChanged) {
        api.activeBeatsChanged.on((args) => {
            if (warmingUp) return;
            if (args?.activeBeats) {
                const active = args.activeBeats;
                deferVisual(() => fretboardController.onActiveBeatsChanged(active));
            }
        });
    }

    api.playedBeatChanged.on((beat) => {
        if (warmingUp) return;
        playedBeatState.beat = beat;
        if (!api.activeBeatsChanged) {
            deferVisual(() => fretboardController.onBeatChanged(beat));
        }
    });

    if (api.beatMouseDown) {
        api.beatMouseDown.on((beat) => {
            const pageModeRadio = document.getElementById('pageModeRadio');
            const isPageMode = pageModeRadio ? pageModeRadio.checked : false;
            if (isPageMode) {
                if (beat) {
                    applyCursorPositionFromBeat(beat);
                }
            } else {
                // In scroll (continuous) mode, let the click listener handle cursor placement
                // to prevent mousedown/click races, unwanted scroll jumps during mousedown,
                // and accidental seeks while dragging/swiping to scroll.
                if (beat) {
                    fretboardController.showBeatsAtCursor(beat);
                }
            }
        });
    }

    // Player Position Changed
    api.playerPositionChanged.on((args) => {
        if (warmingUp) return;
        synthPlayerState.currentTime = args.currentTime;
        lastPositionSongMs = toSongMs(args.currentTime);
        lastPositionEventAt = performance.now();
        synthPlayerState.endTime = args.endTime;

        if (synthPlayerState.loopEnabled && synthPlayerState.isPlaying && currentScore?.masterBars?.length) {
            const firstBar = currentScore.masterBars[synthPlayerState.loopStartMeasure - 1];
            const lastBar = currentScore.masterBars[synthPlayerState.loopEndMeasure - 1];
            const loopEndTick = lastBar.start + lastBar.calculateDuration();
            if (firstBar && args.currentTick >= loopEndTick) {
                currentApi.tickPosition = firstBar.start;
            }
        }

        updateSynthUI();
        const posTick = args.currentTick;
        deferVisual(() => updateContinuousPlaybackScroll(posTick));
        emitTransportEvent('position', {
            timeMs: toSongMs(args.currentTime),
            tick: args.currentTick,
            endMs: toSongMs(args.endTime),
            playing: synthPlayerState.isPlaying
        });
    });

    // Show Synth Player UI
    showSynthPlayer();
    updateSynthUI();
    emitTransportEvent('attached');
}

/**
 * Clear visual playback highlight and reset hasPlayed state
 */
export function clearSynthHighlights() {
    synthPlayerState.hasPlayed = false;
    playedBeatState.beat = null;
    playedBeatState.shownBeat = null;
    document.body.classList.remove('synth-playback-started');
    document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => el.remove());
    if (currentApi?.customCursorHandler?.reset) {
        currentApi.customCursorHandler.reset();
    } else {
        document.querySelectorAll('.gp-reader-cursor').forEach(el => { el.style.display = 'none'; });
    }
    fretboardController.clearActiveNotes();
}

/**
 * Detach AlphaTab API and hide player
 */
/** Re-layer the enabled SoundFonts onto the loaded song; playback resumes from the same spot if it was playing. */
export async function reloadSynthSoundFonts() {
    const api = currentApi;
    if (!api) return;
    const wasPlaying = synthPlayerState.isPlaying;
    const tick = api.tickPosition;
    try { api.pause(); } catch (_) {}
    const loaded = new Promise(resolve => {
        const off = api.soundFontLoaded.on(() => { off?.(); resolve(); });
        api.soundFontLoadFailed?.on(() => resolve());
        setTimeout(resolve, 15000);
    });
    await applySoundFontsToApi(api);
    await loaded;
    if (api !== currentApi) return;
    // The synth restarts its sound bank on load; regenerating the MIDI re-feeds it, otherwise the transport
    // runs silently until a manual pause/resume.
    const restore = () => {
        if (currentApi !== api) return;
        applyMixerToApi();
        try { api.tickPosition = tick; } catch (_) {}
        if (wasPlaying) api.play();
    };
    // Not midiLoaded.on: with a MIDI already loaded, AlphaTab 1.8.4 recurses forever in its loadedMidiInfo getter.
    api.loadMidiForScore();
    setTimeout(restore, 400);
}

export function detachAlphaTabApi() {
    pauseIOSAudioPlayback();
    warmingUp = false;
    jamPrevViewTracks = null;
    emitTransportEvent('detached');
    if (currentApi) {
        try {
            currentApi.stop();
        } catch (e) {
            // ignore
        }
        // stop() alone leaves the synth worker and AudioContext alive; they pile up across songs
        // and the next song's player can stall waiting on them.
        try {
            currentApi.destroy();
        } catch (e) {
            // ignore
        }
        if (window.gpApi === currentApi) window.gpApi = null;
    }
    currentApi = null;
    currentScore = null;
    synthPlayerState.isPlaying = false;
    synthPlayerState.isReady = false;
    synthPlayerState.soundFontLoaded = false;
    synthPlayerState.audioSyncAvailable = false;
    synthPlayerState.audioSyncEnabled = false;
    synthPlayerState.currentTime = 0;
    synthPlayerState.endTime = 0;

    clearSynthHighlights();
    fretboardController.onScoreClosed();
    toggleSynthPanel(false);
    hideSynthPlayer();
    updateSynthUI();
}

/**
 * Enable or disable embedded audio sync backing track for Guitar Pro 8 files
 * @param {boolean} enabled
 */
export function setAudioSyncEnabled(enabled) {
    if (!currentApi || !synthPlayerState.audioSyncAvailable) return;
    synthPlayerState.audioSyncEnabled = enabled;

    const wasPlaying = synthPlayerState.isPlaying;
    if (wasPlaying) {
        pauseSynthPlayer();
    }

    currentApi.settings.player.playerMode = enabled
        ? alphaTab.PlayerMode.EnabledBackingTrack
        : alphaTab.PlayerMode.EnabledSynthesizer;

    currentApi.updateSettings();
    if (typeof currentApi.loadMidiForScore === 'function') {
        currentApi.loadMidiForScore();
    }

    currentApi.playbackSpeed = synthPlayerState.playbackSpeed;
    if (!enabled) {
        applySynthTrackMode();
    }
    updateSynthUI();
}

/**
 * Toggle play / pause
 */
export function playPauseSynth() {
    if (!currentApi) return;
    if (interceptTransport('playPause', { playing: synthPlayerState.isPlaying })) return;
    playPauseSynthLocal();
}

function playPauseSynthLocal(forcePlay = false) {
    if (!currentApi) return;
    try {
        pauseYouTube();
        applyLoopSettings();
        if (!synthPlayerState.isPlaying) {
            enableIOSAudioPlayback();
        }
        if (!synthPlayerState.isPlaying && synthPlayerState.loopEnabled) {
            if (!isWithinLoopRange()) {
                seekToLoopStart();
            }
        }
        // Jam starts must not toggle: a pause issued moments earlier may not have reached the
        // synth worker yet, and playPause() would then pause instead of play.
        if (forcePlay) currentApi.play();
        else currentApi.playPause();
    } catch (e) {
        console.error('[Synth Player] Play/Pause error:', e);
    }
}

export function isSynthAvailable() {
    const synthBtn = document.getElementById('synthToggleBtn');
    return Boolean(synthBtn && synthBtn.style.display !== 'none' && currentApi);
}

export function isSynthPlaying() {
    return Boolean(synthPlayerState.isPlaying);
}

/**
 * Pause Synth playback
 */
export function pauseSynthPlayer() {
    pauseIOSAudioPlayback();
    if (!currentApi) return;
    try {
        currentApi.pause();
    } catch (e) {
        console.error('[Synth Player] Pause error:', e);
    }
    if (synthPlayerState.isPlaying) {
        synthPlayerState.isPlaying = false;
        updateSynthUI();
    }
}

/**
 * Rewind to start
 */
export function rewindSynth() {
    if (!currentApi) return;
    if (interceptTransport('seekMs', { timeMs: 0 })) return;
    try {
        currentApi.timePosition = 0;
        synthPlayerState.currentTime = 0;
        updateSynthUI();
    } catch (e) {
        console.error('[Synth Player] Rewind error:', e);
    }
}

/**
 * Seek back 10 seconds (or to 0 if within first 10s)
 */
export function rewindSynth10Seconds() {
    if (!currentApi) return;
    try {
        const currentMs = (synthPlayerState.currentTime !== undefined && synthPlayerState.currentTime !== null)
            ? synthPlayerState.currentTime
            : (currentApi.timePosition || 0);
        const targetMs = Math.max(0, currentMs - 10000);
        if (interceptTransport('seekMs', { timeMs: toSongMs(targetMs) })) return;
        currentApi.timePosition = targetMs;
        synthPlayerState.currentTime = targetMs;
        updateSynthUI();
    } catch (e) {
        console.error('[Synth Player] Back 10s error:', e);
    }
}

/**
 * Seek to a percentage position (0 to 1)
 */
export function seekSynthPercent(percent) {
    if (!currentApi || synthPlayerState.endTime <= 0) return;
    const targetMs = Math.floor(percent * synthPlayerState.endTime);
    if (interceptTransport('seekMs', { timeMs: toSongMs(targetMs) })) return;
    try {
        currentApi.timePosition = targetMs;
        synthPlayerState.currentTime = targetMs;
        updateSynthUI();
    } catch (e) {
        console.error('[Synth Player] Seek error:', e);
    }
}

/**
 * Set playback speed
 */
export function setPlaybackSpeed(speed) {
    if (interceptTransport('speed', { speed })) return;
    setPlaybackSpeedLocal(speed);
}

function setPlaybackSpeedLocal(speed) {
    synthPlayerState.playbackSpeed = speed;
    if (currentApi) {
        try {
            currentApi.playbackSpeed = speed;
        } catch (e) {
            console.error('[Synth Player] Set speed error:', e);
        }
    }
    emitTransportEvent('speed', { speed });
    updateSynthUI();
}

/**
 * Toggle metronome
 */
export function toggleMetronome(force = null) {
    const newState = force !== null ? force : !synthPlayerState.metronomeEnabled;
    synthPlayerState.metronomeEnabled = newState;
    if (currentApi) {
        try {
            currentApi.metronomeVolume = newState ? 1.0 : 0.0;
        } catch (e) {
            console.error('[Synth Player] Metronome error:', e);
        }
    }
    updateSynthUI();
}

/**
 * Toggle count-in
 */
export function toggleCountIn(force = null) {
    const newState = force !== null ? force : !synthPlayerState.countInEnabled;
    synthPlayerState.countInEnabled = newState;
    if (currentApi) {
        try {
            currentApi.countInVolume = newState ? 1.0 : 0.0;
        } catch (e) {
            console.error('[Synth Player] Count-in error:', e);
        }
    }
    updateSynthUI();
}

export const scoreOptionsState = {
    isOpen: false,
    isAvailable: false
};

/**
 * Show / Enable top bar Score Options button (when notation options are available)
 */
export function showScoreOptions(fileType = 'gp') {
    scoreOptionsState.isAvailable = true;
    const btn = document.getElementById('topBarSongTitleBtn');
    const chevron = btn?.querySelector('.song-title-chevron');
    const notationSection = document.getElementById('scoreOptionsNotationStyleSection');
    const stringCountSection = document.getElementById('scoreOptionsStringCountSection');
    const tracksSection = document.getElementById('synthTrackVisibilitySection');
    const pdfSection = document.getElementById('scoreOptionsPdfSection');
    const exportPdfBtn = document.getElementById('exportPDFBtn');
    const exportSourceBtn = document.getElementById('exportSourceTabBtn');

    if (btn) {
        btn.classList.remove('disabled', 'is-static');
        btn.removeAttribute('disabled');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-disabled', 'false');
        const songTitleEl = document.getElementById('topBarSongTitle');
        const displayName = songTitleEl?.textContent || '';
        btn.title = displayName ? `${displayName} - Notation Options` : 'Notation Options';
    }
    if (chevron) {
        chevron.style.display = '';
    }

    if (fileType === 'gp') {
        if (notationSection) notationSection.style.display = '';
        if (stringCountSection) stringCountSection.style.display = '';
        if (pdfSection) pdfSection.style.display = 'none';
        if (exportPdfBtn) exportPdfBtn.style.display = '';
        fretboardController.setScoreAvailable(true);
    } else if (fileType === 'pdf') {
        if (notationSection) notationSection.style.display = 'none';
        if (stringCountSection) stringCountSection.style.display = 'none';
        if (tracksSection) tracksSection.style.display = 'none';
        if (pdfSection) pdfSection.style.display = '';
        const condensePdfCheckbox = document.getElementById('condensePdfMode');
        if (exportPdfBtn) exportPdfBtn.style.display = (condensePdfCheckbox && condensePdfCheckbox.checked) ? '' : 'none';
        fretboardController.setScoreAvailable(false);
    } else {
        // txt or other
        if (notationSection) notationSection.style.display = 'none';
        if (stringCountSection) stringCountSection.style.display = 'none';
        if (tracksSection) tracksSection.style.display = 'none';
        if (pdfSection) pdfSection.style.display = 'none';
        if (exportPdfBtn) exportPdfBtn.style.display = 'none';
        fretboardController.setScoreAvailable(false);
    }
    if (exportSourceBtn) {
        exportSourceBtn.style.display = '';
    }
}

/**
 * Hide / Disable top bar Score Options (when no file is loaded)
 */
export function hideScoreOptions() {
    scoreOptionsState.isAvailable = false;
    toggleScoreOptionsPanel(false);
    const adaptSection = document.getElementById('scoreOptionsAdaptSection');
    if (adaptSection) adaptSection.style.display = 'none';
    const btn = document.getElementById('topBarSongTitleBtn');
    const chevron = btn?.querySelector('.song-title-chevron');
    const notationSection = document.getElementById('scoreOptionsNotationStyleSection');
    const stringCountSection = document.getElementById('scoreOptionsStringCountSection');
    const tracksSection = document.getElementById('synthTrackVisibilitySection');
    const pdfSection = document.getElementById('scoreOptionsPdfSection');
    const exportPdfBtn = document.getElementById('exportPDFBtn');
    const exportSourceBtn = document.getElementById('exportSourceTabBtn');

    if (btn) {
        btn.classList.add('disabled', 'is-static');
        btn.removeAttribute('aria-expanded');
        btn.setAttribute('aria-disabled', 'true');
        const songTitleEl = document.getElementById('topBarSongTitle');
        const displayName = songTitleEl?.textContent || '';
        btn.title = displayName || '';
    }
    if (chevron) {
        chevron.style.display = 'none';
    }
    if (notationSection) {
        notationSection.style.display = 'none';
    }
    if (stringCountSection) {
        stringCountSection.style.display = 'none';
    }
    fretboardController.setScoreAvailable(false);
    if (tracksSection) {
        tracksSection.style.display = 'none';
    }
    if (pdfSection) {
        pdfSection.style.display = 'none';
    }
    if (exportPdfBtn) {
        exportPdfBtn.style.display = 'none';
    }
    if (exportSourceBtn) {
        exportSourceBtn.style.display = 'none';
    }
}

export function updateScoreOptionsPanelPosition() {
    const panel = document.getElementById('scoreOptionsDropdownPanel');
    const toggleBtn = document.getElementById('topBarSongTitleBtn');
    if (!panel || !toggleBtn || !scoreOptionsState.isOpen) return;

    const rect = toggleBtn.getBoundingClientRect();
    if (window.innerWidth <= 576) {
        panel.style.position = 'fixed';
        panel.style.top = `${rect.bottom + 8}px`;
        panel.style.left = '0.5rem';
        panel.style.right = '0.5rem';
        panel.style.width = 'auto';
        panel.style.transform = 'none';
        return;
    }

    panel.style.position = 'fixed';
    panel.style.top = `${rect.bottom + 8}px`;
    panel.style.right = 'auto';
    panel.style.width = '';
    const centerX = rect.left + rect.width / 2;
    const halfPanelWidth = Math.min(185, (window.innerWidth - 24) / 2);
    const clampedLeft = Math.max(halfPanelWidth + 12, Math.min(window.innerWidth - halfPanelWidth - 12, centerX));
    panel.style.left = `${clampedLeft}px`;
    panel.style.transform = 'translateX(-50%)';
}

/**
 * Toggle collapsible score & notation options panel
 */
export function toggleScoreOptionsPanel(forceState = null) {
    const panel = document.getElementById('scoreOptionsDropdownPanel');
    const toggleBtn = document.getElementById('topBarSongTitleBtn');

    if (!panel) return;

    if (!scoreOptionsState.isAvailable && forceState !== false) {
        panel.style.display = 'none';
        toggleBtn?.classList.remove('active');
        toggleBtn?.setAttribute('aria-expanded', 'false');
        scoreOptionsState.isOpen = false;
        return;
    }

    const newState = forceState !== null ? forceState : !scoreOptionsState.isOpen;
    scoreOptionsState.isOpen = newState;

    if (newState) {
        // Close other panels if open, without interrupting audio playback
        toggleSynthPanel(false);
        toggleYouTubePanel(false);
        document.getElementById('pdfBookmarksPanelCloseBtn')?.click();

        document.dispatchEvent(new CustomEvent('scoreoptions:open'));
        updateScoreOptionsPanelPosition();
        panel.style.display = 'block';
        toggleBtn?.classList.add('active');
        toggleBtn?.setAttribute('aria-expanded', 'true');
    } else {
        panel.style.display = 'none';
        toggleBtn?.classList.remove('active');
        toggleBtn?.setAttribute('aria-expanded', 'false');
    }
}

/**
 * Initialize all DOM event listeners for the Score Options Panel
 */
export function initScoreOptionsPanel() {
    hideScoreOptions();
    const toggleBtn = document.getElementById('topBarSongTitleBtn');
    const closeBtn = document.getElementById('scoreOptionsPanelCloseBtn');

    toggleBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!scoreOptionsState.isAvailable) return;
        toggleScoreOptionsPanel();
    });

    closeBtn?.addEventListener('click', () => {
        toggleScoreOptionsPanel(false);
    });

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
        const panel = document.getElementById('scoreOptionsDropdownPanel');
        const toggleBtn = document.getElementById('topBarSongTitleBtn');

        if (scoreOptionsState.isOpen && panel && !panel.contains(e.target) && !toggleBtn?.contains(e.target)) {
            toggleScoreOptionsPanel(false);
        }
    });

    window.addEventListener('resize', updateScoreOptionsPanelPosition);
    document.addEventListener('fullscreenchange', updateScoreOptionsPanelPosition);
}

/**
 * Show / Hide top bar Synth container
 */
export function showSynthPlayer() {
    const btn = document.getElementById('synthToggleBtn');
    if (btn) btn.style.display = 'inline-flex';
    updateGlobalRewindButton();
}

export function hideSynthPlayer() {
    const btn = document.getElementById('synthToggleBtn');
    if (btn) btn.style.display = 'none';
    updateGlobalRewindButton();
}

export function updateSynthPanelPosition() {
    const panel = document.getElementById('synthDropdownPanel');
    const toggleBtn = document.getElementById('synthToggleBtn');
    if (!panel || !synthPlayerState.isOpen) return;

    const mobileDock = document.getElementById('mobilePlaybackDock');
    const isMobileDockActive = window.innerWidth <= 576 || (mobileDock && window.getComputedStyle(mobileDock).display !== 'none');

    if (isMobileDockActive && mobileDock) {
        panel.classList.add('popup-from-bottom');
        const dockRect = mobileDock.getBoundingClientRect();
        const bottomOffset = dockRect.top > 0 ? Math.max(12, Math.round(window.innerHeight - dockRect.top + 8)) : 76;
        panel.style.position = 'fixed';
        panel.style.top = 'auto';
        panel.style.bottom = `${bottomOffset}px`;
        panel.style.left = '50%';
        panel.style.transform = 'translateX(-50%)';
        return;
    }

    panel.classList.remove('popup-from-bottom');
    panel.style.bottom = 'auto';
    if (!toggleBtn) return;
    const rect = toggleBtn.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.top = `${rect.bottom + 8}px`;
    const centerX = rect.left + rect.width / 2;
    const halfPanelWidth = Math.min(185, (window.innerWidth - 24) / 2);
    const clampedLeft = Math.max(halfPanelWidth + 12, Math.min(window.innerWidth - halfPanelWidth - 12, centerX));
    panel.style.left = `${clampedLeft}px`;
    panel.style.transform = 'translateX(-50%)';
}

/**
 * Toggle collapsible synth settings panel
 */
export function toggleSynthPanel(forceState = null) {
    const panel = document.getElementById('synthDropdownPanel');
    const toggleBtn = document.getElementById('synthToggleBtn');
    const mobileBtn = document.getElementById('mobileSynthToggleBtn');

    if (!panel) return;

    const newState = forceState !== null ? forceState : !synthPlayerState.isOpen;
    synthPlayerState.isOpen = newState;

    if (newState) {
        setActiveAudioMode('synth');
        // Ensure YouTube panel and Score Options panel are closed and YouTube playback paused when opening synth panel
        toggleYouTubePanel(false);
        toggleScoreOptionsPanel(false);
        document.getElementById('pdfBookmarksPanelCloseBtn')?.click();
        pauseYouTube();

        updateSynthPanelPosition();
        panel.style.display = 'block';
        toggleBtn?.classList.add('active');
        mobileBtn?.classList.add('active');
    } else {
        panel.style.display = 'none';
        panel.classList.remove('popup-from-bottom');
        toggleBtn?.classList.remove('active');
        mobileBtn?.classList.remove('active');
    }
}

/**
 * Initialize all DOM event listeners for the Synth Player
 */
export function initSynthPlayer() {
    hideSynthPlayer();
    syncSynthTrackModeLabels();
    const toggleBtn = document.getElementById('synthToggleBtn');
    const closeBtn = document.getElementById('synthPanelCloseBtn');
    const metronomeQuickBtn = document.getElementById('synthMetronomeQuickBtn');
    const metronomeSwitch = document.getElementById('synthMetronomeSwitch');
    const countInSwitch = document.getElementById('synthCountInSwitch');
    const seekSlider = document.getElementById('synthSeekSlider');
    const speedButtons = document.querySelectorAll('#synthSpeedButtons button');
    const trackModeRadios = document.querySelectorAll('input[name="synthTrackMode"]');
    const loopSwitch = document.getElementById('synthLoopSwitch');
    const loopStartInput = document.getElementById('synthLoopStartMeasure');
    const loopEndInput = document.getElementById('synthLoopEndMeasure');

    toggleBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        pauseYouTube();
        toggleSynthPanel();
    });

    window.addEventListener('resize', () => {
        if (!synthPlayerState.isOpen) return;
        updateSynthPanelPosition();
    });

    closeBtn?.addEventListener('click', () => {
        toggleSynthPanel(false);
    });

    metronomeQuickBtn?.addEventListener('click', () => {
        toggleMetronome();
    });

    metronomeSwitch?.addEventListener('change', (e) => {
        toggleMetronome(e.target.checked);
    });

    countInSwitch?.addEventListener('change', (e) => {
        toggleCountIn(e.target.checked);
    });

    const audioSyncSwitch = document.getElementById('synthAudioSyncSwitch');
    audioSyncSwitch?.addEventListener('change', (e) => {
        setAudioSyncEnabled(e.target.checked);
    });

    trackModeRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            applyTrackModePreset(radio.value);
        });
    });

    loopSwitch?.addEventListener('change', () => {
        synthPlayerState.loopEnabled = loopSwitch.checked;
        applyLoopSettings();
        if (synthPlayerState.loopEnabled && !isWithinLoopRange()) {
            seekToLoopStart();
        }
        updateSynthUI();
    });

    const handleLoopStartChange = () => {
        const measureCount = currentScore?.masterBars?.length || 1;
        const value = Number.parseInt(loopStartInput.value, 10);
        if (Number.isFinite(value) && value >= 1) {
            const clampedStart = Math.min(measureCount, Math.max(1, value));
            synthPlayerState.loopStartMeasure = clampedStart;
            if (synthPlayerState.loopEndMeasure < clampedStart) {
                synthPlayerState.loopEndMeasure = clampedStart;
            }
            synthPlayerState.loopEnabled = true;
            applyLoopSettings();
            updateSynthUI();
        }
    };

    loopStartInput?.addEventListener('input', handleLoopStartChange);
    loopStartInput?.addEventListener('change', handleLoopStartChange);

    const handleLoopEndChange = () => {
        const measureCount = currentScore?.masterBars?.length || 1;
        const value = Number.parseInt(loopEndInput.value, 10);
        if (Number.isFinite(value) && value >= 1) {
            const clampedEnd = Math.min(measureCount, Math.max(1, value));
            synthPlayerState.loopEndMeasure = clampedEnd;
            if (synthPlayerState.loopStartMeasure > clampedEnd) {
                synthPlayerState.loopStartMeasure = clampedEnd;
            }
            synthPlayerState.loopEnabled = true;
            applyLoopSettings();
            updateSynthUI();
        }
    };

    loopEndInput?.addEventListener('input', handleLoopEndChange);
    loopEndInput?.addEventListener('change', handleLoopEndChange);

    const speedMinusBtn = document.getElementById('synthSpeedMinusBtn');
    const speedPlusBtn = document.getElementById('synthSpeedPlusBtn');

    speedMinusBtn?.addEventListener('click', () => {
        const currentPct = Math.round(synthPlayerState.playbackSpeed * 100);
        const newPct = Math.max(10, currentPct - 1);
        setPlaybackSpeed(newPct / 100);
    });

    speedPlusBtn?.addEventListener('click', () => {
        const currentPct = Math.round(synthPlayerState.playbackSpeed * 100);
        const newPct = Math.min(200, currentPct + 1);
        setPlaybackSpeed(newPct / 100);
    });

    // Speed button handlers
    speedButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const speed = parseFloat(btn.dataset.speed);
            if (!isNaN(speed)) {
                setPlaybackSpeed(speed);
            }
        });
    });

    // Seek slider handlers
    seekSlider?.addEventListener('input', (e) => {
        isSeeking = true;
        const val = parseFloat(e.target.value);
        const pct = val / 1000;
        const tempMs = Math.floor(pct * synthPlayerState.endTime);
        const currentTimeText = document.getElementById('synthCurrentTimeText');
        const positionPercent = document.getElementById('synthPositionPercent');
        if (currentTimeText) currentTimeText.textContent = formatTime(tempMs);
        if (positionPercent) positionPercent.textContent = `${Math.round(pct * 100)}%`;
    });

    seekSlider?.addEventListener('change', (e) => {
        isSeeking = false;
        const val = parseFloat(e.target.value);
        seekSynthPercent(val / 1000);
    });

    // Close panel when clicking outside
    const handleOutsideSynthClick = (e) => {
        const panel = document.getElementById('synthDropdownPanel');
        const sourcePill = document.getElementById('audioSourcePill');
        const mobileDock = document.getElementById('mobilePlaybackDock');

        if (synthPlayerState.isOpen && panel && !panel.contains(e.target) && !sourcePill?.contains(e.target) && !mobileDock?.contains(e.target)) {
            toggleSynthPanel(false);
        }
    };
    document.addEventListener('click', handleOutsideSynthClick);
    document.addEventListener('pointerdown', handleOutsideSynthClick);

    const volumeSlider = document.getElementById('synthVolumeSlider');
    const volumeBadge = document.getElementById('synthVolumeBadge');
    volumeSlider?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        const vol = Math.max(0, Math.min(100, isNaN(val) ? 100 : val)) / 100;
        synthPlayerState.masterVolume = vol;
        if (currentApi) {
            try {
                currentApi.masterVolume = jamMuted ? 0 : vol;
            } catch (_) {}
        }
        if (volumeBadge) {
            volumeBadge.textContent = `${Math.round(vol * 100)}%`;
        }
        try {
            localStorage.setItem(STORAGE_KEY_SYNTH_VOLUME, String(vol));
        } catch (_) {}
    });

    // Allow user to click to position cursor before or during playback in scroll mode
    const output = document.getElementById('output');
    output?.addEventListener('click', (e) => {
        if (!output.classList.contains('continuous-mode')) return;
        if (e.target && e.target.closest && e.target.closest('button, input, textarea, select, .fretboard-dock, .hud-pill-group, .track-select-pill, .modal')) return;
        if (!currentApi || !currentScore) return;

        const container = gpState.canvases[0]?.container;
        if (!container) return;
        if (e.target !== output && !container.contains(e.target)) return;

        const boundsLookup = currentApi.renderer?.boundsLookup;
        if (!boundsLookup || !boundsLookup.staffSystems || !boundsLookup.staffSystems.length) return;

        const rect = container.getBoundingClientRect();
        const relX = e.clientX - rect.left;
        const relY = e.clientY - rect.top;

        let beat = boundsLookup.getBeatAtPos(relX, relY);

        if (!beat && boundsLookup.staffSystems) {
            let bestSys = null;
            let minSysDist = Infinity;
            for (const sys of boundsLookup.staffSystems) {
                const top = sys.realBounds?.y ?? sys.visualBounds?.y ?? 0;
                const h = sys.realBounds?.h ?? sys.visualBounds?.h ?? 120;
                const bottom = top + h;
                if (relY >= top && relY <= bottom) {
                    bestSys = sys;
                    minSysDist = 0;
                    break;
                }
                const dist = relY < top ? (top - relY) : (relY - bottom);
                if (dist < minSysDist) {
                    minSysDist = dist;
                    bestSys = sys;
                }
            }

            if (bestSys) {
                const masterBar = bestSys.findBarAtPos(relX);
                if (masterBar) {
                    // In multi-track bars, find track bar closest vertically to click position
                    if (masterBar.bars && masterBar.bars.length > 0) {
                        let bestTrackBar = masterBar.bars[0];
                        let minTrackDist = Infinity;
                        for (const tb of masterBar.bars) {
                            const tbY = tb.realBounds?.y ?? tb.visualBounds?.y ?? 0;
                            const tbH = tb.realBounds?.h ?? tb.visualBounds?.h ?? 60;
                            const tbBottom = tbY + tbH;
                            const dist = (relY >= tbY && relY <= tbBottom) ? 0 : (relY < tbY ? (tbY - relY) : (relY - tbBottom));
                            if (dist < minTrackDist) {
                                minTrackDist = dist;
                                bestTrackBar = tb;
                            }
                        }

                        if (bestTrackBar && bestTrackBar.beats && bestTrackBar.beats.length > 0) {
                            let closest = bestTrackBar.beats[0];
                            let minDist = Infinity;
                            for (const b of bestTrackBar.beats) {
                                const bBounds = boundsLookup.findBeat(b.beat);
                                const bX = bBounds ? (bBounds.visualBounds?.x ?? bBounds.realBounds?.x ?? 0) : 0;
                                const d = Math.abs(relX - bX);
                                if (d < minDist) {
                                    minDist = d;
                                    closest = b;
                                }
                            }
                            if (closest?.beat) {
                                beat = closest.beat;
                            }
                        }
                    }

                    if (!beat && typeof masterBar.findBeatAtPos === 'function') {
                        beat = masterBar.findBeatAtPos(relX);
                    }
                }
            }
        }

        if (beat) {
            applyCursorPositionFromBeat(beat);
        }
    });

    window.addEventListener('resize', updateSynthPanelPosition);
    document.addEventListener('fullscreenchange', updateSynthPanelPosition);

    updateSynthUI();
}


// --- Jam Mode remote control ----------------------------------------------
// These bypass the transport interceptor so remote-driven actions never loop
// back into the jam layer.
export const jamPlayerControl = {
    hasPlayer() {
        return Boolean(currentApi);
    },
    isReady() {
        return Boolean(currentApi && (synthPlayerState.isReady || synthPlayerState.soundFontLoaded || currentApi.isReadyForPlayback));
    },
    /**
     * Current song time in ms (speed independent). AlphaTab only updates timePosition on
     * position events, so extrapolate from the last one while playing (capped) to keep sync
     * measurements tight.
     */
    timeMs() {
        if (!synthPlayerState.isPlaying || !lastPositionEventAt) {
            return toSongMs(currentApi?.timePosition ?? synthPlayerState.currentTime ?? 0);
        }
        const elapsed = Math.min(250, Math.max(0, performance.now() - lastPositionEventAt));
        return lastPositionSongMs + elapsed * currentSpeedFactor();
    },
    /** Playback speed the synth is actually running at (includes any drift nudge). */
    actualSpeed() {
        return currentSpeedFactor();
    },
    snapshot() {
        return {
            playing: synthPlayerState.isPlaying,
            timeMs: jamPlayerControl.timeMs(),
            tick: currentApi?.tickPosition ?? 0,
            speed: synthPlayerState.playbackSpeed,
            loop: {
                enabled: synthPlayerState.loopEnabled,
                startMeasure: synthPlayerState.loopStartMeasure,
                endMeasure: synthPlayerState.loopEndMeasure
            },
            metronome: synthPlayerState.metronomeEnabled,
            countIn: synthPlayerState.countInEnabled
        };
    },
    /** Seek to song time `ms` (speed independent, as returned by timeMs()). */
    seekMs(ms) {
        if (!currentApi) return;
        const target = Math.max(0, ms) / currentSpeedFactor();
        try {
            currentApi.timePosition = target;
            lastPositionSongMs = Math.max(0, ms);
            lastPositionEventAt = performance.now();
            synthPlayerState.currentTime = target;
            updateSynthUI();
        } catch (e) {
            console.error('[Jam] seek error:', e);
        }
    },
    seekTick(tick) {
        if (!currentApi) return;
        try {
            currentApi.tickPosition = Math.max(0, tick);
            synthPlayerState.currentTime = currentApi.timePosition || 0;
            lastPositionEventAt = 0; // unknown until the next position event
            updateSynthUI();
        } catch (e) {
            console.error('[Jam] seek error:', e);
        }
    },
    play() {
        if (!currentApi) return;
        if (warmingUp) {
            // A real start arrived mid warm-up: the synth is already running, so keep it going
            // (the caller has just seeked) and surface the playing state that was suppressed.
            warmingUp = false;
            currentApi.masterVolume = effectiveVolume();
            applyPlayerState(currentApi, 1);
            return;
        }
        if (synthPlayerState.isPlaying) return;
        playPauseSynthLocal(true);
    },
    /**
     * Muted play/pause so the audio output, synth worker and buffers are running before the
     * first real start. Without it the first start lands ~80 ms late. Returns true if it ran.
     */
    async warmUp(durationMs = 300) {
        const api = currentApi;
        if (!api || warmingUp || synthPlayerState.isPlaying || !jamPlayerControl.isReady()) return false;
        warmingUp = true;
        const restoreRaw = api.timePosition || 0;
        try {
            api.masterVolume = 0;
            api.play();
            await new Promise((r) => setTimeout(r, durationMs));
            if (!warmingUp || currentApi !== api) return true; // aborted by a real play() or song change
            api.pause();
            await new Promise((r) => setTimeout(r, 60));
            if (!warmingUp || currentApi !== api) return true;
            api.timePosition = restoreRaw;
        } catch (e) {
            console.warn('[Jam] warm-up failed:', e);
        } finally {
            if (warmingUp && currentApi === api) {
                api.masterVolume = effectiveVolume();
                warmingUp = false;
            }
        }
        return true;
    },
    /** Jam host's "mute guests" option: silences the synth without touching the saved volume. */
    setMuted(on) {
        jamMuted = Boolean(on);
        if (currentApi) {
            try { currentApi.masterVolume = warmingUp ? 0 : effectiveVolume(); } catch (_) {}
        }
    },
    /** Track indices in the loaded score, for the host's assignment UI. `isTarget` marks guitar (or bass, in bass mode) tracks. */
    listTracks() {
        const bass = getInstrumentMode() === 'bass';
        return (currentScore?.tracks || []).map((t, i) => ({
            index: i,
            name: t.name || `Track ${i + 1}`,
            isTarget: bass ? isTrackBass(t) : isTrackGuitar(t)
        }));
    },
    /** Jam client: follow the host's per-track mix (see getMixerSnapshot), or null to hand the mixer back. */
    setHostMixer,
    /** Jam track assignment: `audio` / `view` are index arrays, or null for no restriction. */
    setTrackPolicy({ audio = null, view = null, mute = null } = {}) {
        const norm = (a) => (Array.isArray(a) && a.length ? a : null);
        jamAudioTracks = norm(audio);
        jamViewTracks = norm(view);
        jamMuteTracks = norm(mute);
        if (!currentApi) return;
        applySynthTrackMode();
        reapplyJamTrackView();
    },
    pause() {
        if (!currentApi || !synthPlayerState.isPlaying) return;
        pauseSynthPlayer();
    },
    setSpeed(speed) {
        setPlaybackSpeedLocal(speed);
    },
    /** Temporarily scale playback speed for gentle drift correction (does not touch UI state). */
    nudgeSpeed(factor) {
        if (!currentApi) return;
        try {
            currentApi.playbackSpeed = synthPlayerState.playbackSpeed * factor;
        } catch (e) {
            console.error('[Jam] nudge error:', e);
        }
    },
    setLoop({ enabled, startMeasure, endMeasure }) {
        synthPlayerState.loopEnabled = Boolean(enabled);
        const count = Math.max(1, currentScore?.masterBars?.length || 1);
        synthPlayerState.loopStartMeasure = Math.min(count, Math.max(1, startMeasure || 1));
        synthPlayerState.loopEndMeasure = Math.min(count, Math.max(1, endMeasure || count));
        applyLoopSettings();
        updateSynthUI();
    },
    setMetronome(enabled) {
        if (synthPlayerState.metronomeEnabled !== Boolean(enabled)) toggleMetronome(Boolean(enabled));
    },
    setCountIn(enabled) {
        if (synthPlayerState.countInEnabled !== Boolean(enabled)) toggleCountIn(Boolean(enabled));
    }
};
