// audioFilePlayer.js
// The "Audio File" panel: pick a recording of the song from this device (a studio track, a live recording, your own
// take), play it with a waveform and speed buttons, and sync the score to it (see audioSyncUi.js). It is the third
// audio mode next to the synth and YouTube. Files are kept on the device (audioFileStore.js), keyed to the song, and a
// sync record remembers each file's name, length and fingerprint so a missing file can be relinked.

import { getSongKey, pauseYouTube, onYouTubeEvent, toggleYouTubePanel } from '../soundPlayer.js';
import { pauseSynthPlayer, clearSynthHighlights, onTransportEvent } from '../gpProcessor/gpPlayer.js';
import { setActiveAudioMode, updateGlobalAudioControls } from '../utils/navigationUtils.js';
import { createLocalAudioSource } from './localAudioSource.js';
import { createDecodedAudioSource, decodedPlaybackSupported } from './decodedAudioSource.js';
import { decodePeaks } from './peaks.js';
import {
    saveAudioFile, listAudioFilesForSong, getAudioFile, unlinkAudioFile, fingerprintOf, MAX_AUDIO_BYTES,
    setAudioPeaks, relinkAudioFile, recordRemovedAudio
} from './audioFileStore.js';
import { AUDIO_FILES_CHANGED_EVENT } from './audioBackup.js';
import { adoptUnassignedAudio, detachLibraryAudio } from './libraryAudio.js';
import { isJamHosting, JAM_BRIDGE_EVENT } from './jamBridge.js';
import { isRemoveMode, setRecordingsPresent, REC_REMOVE_MODE_EVENT } from './removeMode.js';
import { listRecords, loadRecord, saveRecord, deleteRecord, mediaKey, SYNC_CHANGED_EVENT } from './syncStore.js';
import { listRecordingMeta, forgetRecordingMeta, orderRecordings, roleLabel, tracksNote } from './recordingMeta.js';
import { mountSyncRow } from './audioSyncUi.js';
import { createStemSource, createStreamingStemSource, applyMutes, applyLevels, getMutedIds, setMutedIds, resetMutedIds, defaultMutedIds, getLevels, setLevel, resetLevels, stemsOfMeta, loadRecordingPeaks } from './stemSet.js';
import { getInstrumentMode } from '../utils/tuningUtils.js';

const LAST_FILE_KEY = (songKey) => `audio_file_last_${encodeURIComponent(String(songKey).toLowerCase())}`;
const SLOT_FILE_KEY = (songKey, slot) => `audio_file_${encodeURIComponent(String(songKey).toLowerCase())}_${slot}`;
const LENGTH_TOLERANCE_MS = 1500;

const state = {
    isOpen: false,
    currentSlot: 'original', // 'original' | 'backing'
    files: [],          // stored files for this song (metadata)
    missing: [],        // local recordings the song has sync points for whose file is not on this device
    currentId: null,
    meta: null,         // metadata of the loaded file
    source: null,       // the MediaSource of the loaded file
    stemFallback: false, // true when a stem set fell back to playing the lead file alone
    peaks: null,
    rate: 1,
    relinkTarget: null, // media descriptor being relinked, or null when choosing a new file
    uiTimer: 0,
    armedRemoval: null, // file id waiting for a second press (it has sync points)
    armTimer: 0,
    // A song is known by its file name until its score has been read, then by artist and title. Files added in
    // between are linked to the first and moved to the second.
    songFinal: false,
    pendingAdds: []     // { id, key } of files added while the song's key was still provisional
};

const syncListeners = new Set();
const notifySync = (kind) => syncListeners.forEach((cb) => { try { cb(kind); } catch (e) { console.error('[Audio Sync] listener error:', e); } });

const $ = (id) => document.getElementById(id);

const clock = (ms) => {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function setStatus(text) {
    const el = $('afStatus');
    if (el) {
        el.textContent = text || '';
        el.title = text || '';
    }
}

// --- Public state for the global transport -------------------------------------------------------------------------

/** The loaded audio file as a recording for a tab without bars: `{ source, media }`, or null. */
export function getLocalRecording() {
    return state.source && state.meta ? { source: state.source, media: mediaOf(state.meta) } : null;
}

export function isAudioFileAvailable() {
    return Boolean(state.currentId && state.files.some(f => f.id === state.currentId));
}

export function isAudioFilePlaying() {
    return Boolean(state.source?.isPlaying());
}

let playGeneration = 0;

export function pauseAudioFile() {
    playGeneration++;
    state.source?.pause();
}

export function rewindAudioFile10Seconds() {
    if (!state.source) return;
    state.source.seek(Math.max(0, state.source.getTimeMs() - 10000));
}

export async function playPauseAudioFile() {
    if (state.source?.isPlaying()) {
        pauseAudioFile();
        return;
    }
    const token = ++playGeneration;
    if (!await ensureSource()) {
        toggleAudioFilePanel(true);
        return;
    }
    if (token !== playGeneration) return;
    // One audio mode at a time
    pauseSynthPlayer();
    clearSynthHighlights();
    pauseYouTube();
    setActiveAudioMode('audio');
    try {
        await state.source.play();
    } catch (e) {
        setStatus('Press play again to start the audio');
        console.warn('[Audio File] play blocked:', e);
    }
}

// --- Loading -------------------------------------------------------------------------------------------------------

function destroySource() {
    if (state.source) {
        state.source.destroy();
        state.source = null;
    }
    state.meta = null;
    state.stemFallback = false;
    state.peaks = null;
    cancelAnimationFrame(state.uiTimer);
}

let pendingRefresh = null;

function refreshFiles() {
    const run = (async () => {
        const songKey = getSongKey();
        let files;
        try {
            files = await listAudioFilesForSong(songKey);
        } catch (e) {
            console.warn('[Audio File] could not list files:', e);
            files = [];
        }
        // A song's identity changes once its score has been read; drop a listing made for the earlier one
        if (songKey !== getSongKey()) return;
        state.files = files;
        // Files the song has but no slot uses (for example from a backup made before slots were saved) fill the empty slots
        const adopted = adoptUnassignedAudio(songKey, files);
        if (adopted) window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
        const stored = new Set(state.files.map(f => f.id));
        state.missing = listRecords(songKey)
            .filter(r => r.media.kind === 'local' && !stored.has(r.media.audioId))
            .map(r => r.media);
        if (!state.currentId || !stored.has(state.currentId)) {
            let slotFileId = null;
            const slot = state.currentSlot || 'original';
            try {
                slotFileId = localStorage.getItem(SLOT_FILE_KEY(songKey, slot));
                if (!slotFileId && slot === 'original') {
                    slotFileId = localStorage.getItem(LAST_FILE_KEY(songKey));
                }
            } catch { /* optional */ }
            const next = state.files.find(f => f.id === slotFileId) || (slot === 'original' ? state.files[0] : null) || null;
            if (state.currentId !== (next?.id ?? null)) destroySource();
            state.currentId = next?.id ?? null;
        }
        render();
        updateGlobalAudioControls();
        // The panel can be open before the list arrives (right after the song loads): load the selection then
        if (state.isOpen && state.currentId && !state.source) await ensureSource();
        // A song whose Original is a local file loads it when it opens, so its recording bar is there before the first Play
        else if (state.currentId && !state.source && usesLocalOriginal(songKey)) await ensureSource();
    })();
    pendingRefresh = run;
    run.finally(() => { if (pendingRefresh === run) pendingRefresh = null; });
    return run;
}

/** Resolves once any in-flight file list refresh and initial source load have finished. */
export async function awaitAudioFilesReady() {
    if (pendingRefresh) await pendingRefresh;
    if (loading) await loading;
}

function usesLocalOriginal(songKey) {
    try { return localStorage.getItem(`real_audio_source_${encodeURIComponent(String(songKey).toLowerCase())}_original`) === 'local'; } catch { return false; }
}

const peaksTried = new Set();

async function rebuildPeaks(id, data) {
    const analysed = await decodePeaks(data);
    if (!analysed) return;
    await setAudioPeaks(id, analysed.peaks, analysed.durationMs);
    if (state.currentId === id) {
        const stems = stemsOfFile(id);
        state.peaks = (stems && await loadRecordingPeaks(getSongKey(), { kind: 'local', audioId: id })) || analysed.peaks;
        drawWave();
    }
}

/**
 * Decoded samples first: their clock is exact after a seek, which an audio element's is not for some formats (see
 * decodedAudioSource.js). The audio element is the fallback for a file the webview cannot decode, one too long to hold
 * in memory, or a webview without AudioWorklet. `localStorage.mt_decoded_audio = 'off'` forces the element, for debugging.
 */
export async function openAudioSource(file, { onError } = {}) {
    let forceElement = false;
    try { forceElement = localStorage.getItem('mt_decoded_audio') === 'off'; } catch { /* optional */ }
    if (!forceElement && decodedPlaybackSupported()) {
        const decoded = createDecodedAudioSource(file);
        try {
            await decoded.ready();
            return decoded;
        } catch (e) {
            console.warn('[Audio File] decoded playback unavailable, using the audio element:', e.message);
            decoded.destroy();
        }
    }
    const element = createLocalAudioSource(file);
    try {
        await element.ready();
        return element;
    } catch (e) {
        element.destroy();
        onError?.(e.message);
        return null;
    }
}

/** The parts of the stem set the file leads, or null when it is a file on its own. */
function stemsOfFile(id) {
    return stemsOfMeta(listRecordingMeta(getSongKey())[mediaKey({ kind: 'local', audioId: id })]);
}

/** The mixing source of a stem set, with the parts the current sound mutes switched off; null to fall back to the lead file alone. */
async function openStemSet(rec, stems) {
    const nameOf = (audioId) => stems.find((m) => m.audioId === audioId)?.label || 'Stem';
    const others = [];
    for (const m of stems) {
        if (m.audioId === rec.id) continue;
        const r = await getAudioFile(m.audioId);
        if (r) others.push({ id: m.audioId, name: nameOf(m.audioId), type: r.type, data: r.data, durationMs: r.durationMs });
    }
    if (!others.length) return null;
    const spec = { lead: { id: rec.id, name: nameOf(rec.id), type: rec.type, data: rec.data, durationMs: rec.durationMs }, others };
    const slot = state.currentSlot || 'original';
    const applyState = async (source) => {
        await source.ready();
        applyLevels(source, getLevels(getSongKey(), slot));
        await applyMutes(source, getMutedIds(getSongKey(), slot, stems, getInstrumentMode()));
    };

    let forceElement = false;
    try { forceElement = localStorage.getItem('mt_decoded_audio') === 'off'; } catch { /* optional */ }
    if (!forceElement && decodedPlaybackSupported()) {
        const decoded = createStemSource(spec);
        try {
            await applyState(decoded);
            return decoded;
        } catch (e) {
            console.warn('[Audio File] decoded stems unavailable, using streaming elements:', e.message);
            decoded.destroy();
        }
    }

    const streaming = createStreamingStemSource(spec);
    try {
        await applyState(streaming);
        return streaming;
    } catch (e) {
        console.warn('[Audio File] could not open the stems:', e);
        streaming.destroy();
        setStatus(e.message);
        return null;
    }
}

/** Loads the selected file from storage into a playable source. Resolves true when a source is ready. */
let loading = null;
function ensureSource() {
    if (state.source) return Promise.resolve(true);
    if (!state.currentId) return Promise.resolve(false);
    loading ||= (async () => {
        const id = state.currentId;
        try {
            const rec = await getAudioFile(id);
            if (!rec) {
                await refreshFiles();
                return false;
            }
            const stems = stemsOfFile(id);
            const source = (stems && await openStemSet({ id, ...rec }, stems)) || await openAudioSource(
                { id, name: rec.name, type: rec.type, data: rec.data, durationMs: rec.durationMs },
                { onError: setStatus }
            );
            if (!source) return false;
            const { data, ...meta } = rec;
            const peaks = (stems && await loadRecordingPeaks(getSongKey(), mediaOf(meta))) || rec.peaks || null;
            if (state.currentId !== id) {
                source.destroy();
                return false;
            }
            state.source = source;
            state.stemFallback = Boolean(stems && !source.parts);
            state.meta = meta;
            state.peaks = peaks;
            // A file restored from a backup comes without its waveform; build it once
            if (!rec.peaks && !peaksTried.has(id)) {
                peaksTried.add(id);
                rebuildPeaks(id, rec.data);
            }
            source.setRate(state.rate);
            source.on((e) => {
                if (e.type === 'state') {
                    if (e.playing) startUiLoop();
                    updateGlobalAudioControls();
                    updatePlayIcon();
                    notifySync(e.playing ? 'play' : 'stop');
                } else if (e.type === 'time' || e.type === 'ended') {
                    drawWave();
                } else if (e.type === 'parts' || e.type === 'buffering') {
                    renderStems();
                }
            });
            try { localStorage.setItem(LAST_FILE_KEY(getSongKey()), id); } catch { /* optional */ }
            render();
            notifySync('idle');
            return true;
        } catch (e) {
            console.warn('[Audio File] could not load the file:', e);
            setStatus('Could not open the saved file');
            return false;
        } finally {
            loading = null;
        }
    })();
    return loading;
}

/** A file is being picked or added: make a file the slot's sound (the controller switches the source). */
function useFileSource() {
    window.dispatchEvent(new CustomEvent('majestictab:use-source', { detail: { source: 'local' } }));
}
const fileSourceActive = () => document.getElementById('ytDropdownPanel')?.dataset.recSource === 'local';

async function selectFile(id) {
    useFileSource();
    const songKey = getSongKey();
    const slot = state.currentSlot || 'original';
    try {
        localStorage.setItem(SLOT_FILE_KEY(songKey, slot), id);
        if (slot === 'original') localStorage.setItem(LAST_FILE_KEY(songKey), id);
    } catch { /* optional */ }
    // The Original recording row and the empty-state line in the panel read this attachment
    window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
    if (id === state.currentId && state.source) return;
    destroySource();
    state.currentId = id;
    render();
    await ensureSource();
}

// --- Adding and relinking files ------------------------------------------------------------------------------------

function mediaOf(meta) {
    return { kind: 'local', audioId: meta.id, name: meta.name, durationMs: meta.durationMs ?? null, fingerprint: meta.fingerprint };
}

async function addFile(file, { relink = null } = {}) {
    if (file.size > MAX_AUDIO_BYTES) {
        setStatus(`That file is too large (limit ${Math.round(MAX_AUDIO_BYTES / 1048576)} MB)`);
        return;
    }
    const songKey = getSongKey();
    try {
        setStatus('Reading the file...');
        const data = await file.arrayBuffer();
        if (relink) {
            const fingerprint = await fingerprintOf(data);
            const analysed = await decodePeaks(data);
            const durationMs = analysed?.durationMs ?? null;
            const sameFile = fingerprint === relink.fingerprint;
            const sameLength = durationMs === null || relink.durationMs === null || Math.abs(durationMs - relink.durationMs) <= LENGTH_TOLERANCE_MS;
            if (!sameFile && !sameLength && !confirm('This file is a different length from the one the map points were made with, so they will probably not line up. Use it anyway?')) {
                setStatus('');
                return;
            }
            setStatus('Saving...');
            const meta = await saveAudioFile({
                id: relink.audioId, name: file.name, type: file.type || 'audio/mpeg', data, songKey,
                durationMs, peaks: analysed?.peaks ?? null
            });
            // The record keeps pointing at the same id, with the file that is now on this device
            const rec = loadRecord(songKey, relink);
            if (rec) saveRecord(songKey, mediaOf(meta), rec.points);
            await finishAdd(meta);
            return;
        }
        setStatus('Analysing the waveform...');
        const analysed = await decodePeaks(data);
        setStatus('Saving...');
        const meta = await saveAudioFile({
            name: file.name, type: file.type || 'audio/mpeg', data, songKey,
            durationMs: analysed?.durationMs ?? null, peaks: analysed?.peaks ?? null
        });
        await finishAdd(meta);
    } catch (e) {
        console.warn('[Audio File] could not add the file:', e);
        setStatus(e?.message || 'Could not save that file');
    }
}

async function finishAdd(meta) {
    useFileSource();
    if (!state.songFinal) state.pendingAdds.push({ id: meta.id, key: getSongKey() });
    const slot = state.currentSlot || 'original';
    try {
        localStorage.setItem(SLOT_FILE_KEY(getSongKey(), slot), meta.id);
        if (slot === 'original') localStorage.setItem(LAST_FILE_KEY(getSongKey()), meta.id);
    } catch { /* optional */ }
    destroySource();
    state.currentId = meta.id;
    await refreshFiles();
    const ok = await ensureSource();
    if (!ok) {
        // This platform can't play the format: don't keep a file nobody can use
        await unlinkAudioFile(meta.id, getSongKey());
        state.currentId = null;
        await refreshFiles();
        return;
    }
    setStatus('');
    // The Original recording row and the empty-state line in the panel read this attachment
    window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
}

/** Removes a file from this device and its sync points with it; if it was the loaded one the list shows the next. */
async function removeFile(id) {
    const songKey = getSongKey();
    const meta = state.files.find(f => f.id === id);
    try {
        if (localStorage.getItem(SLOT_FILE_KEY(songKey, 'original')) === id) localStorage.removeItem(SLOT_FILE_KEY(songKey, 'original'));
        if (localStorage.getItem(SLOT_FILE_KEY(songKey, 'backing')) === id) localStorage.removeItem(SLOT_FILE_KEY(songKey, 'backing'));
    } catch { /* optional */ }
    if (id === state.currentId) destroySource();
    detachLibraryAudio(id);
    await unlinkAudioFile(id, songKey);
    if (meta?.name) recordRemovedAudio(songKey, { name: meta.name, size: meta.size || 0 });
    deleteRecord(songKey, { kind: 'local', audioId: id, name: meta?.name || '' });
    forgetRecordingMeta(songKey, { kind: 'local', audioId: id });
    disarm();
    if (state.currentId === id) state.currentId = null;
    window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
    await refreshFiles();
}

/** Sync points of each local recording of this song, by file id. */
function syncedFiles() {
    return listRecords(getSongKey()).filter(r => r.media.kind === 'local' && r.points.length)
        .map(r => ({ audioId: r.media.audioId, count: r.points.length, points: r.points, origin: r.media.origin || null, updatedAt: r.updatedAt }));
}
const pointsLabel = (count) => (count ? `Mapped · ${count} ${count === 1 ? 'point' : 'points'}` : 'Not mapped');

function disarm() { clearTimeout(state.armTimer); state.armedRemoval = null; }
function arm(kind, id) {
    disarm();
    if (kind === 'remove') state.armedRemoval = id;
    state.armTimer = setTimeout(() => { disarm(); render(); }, 4000);
}

// --- Rendering -----------------------------------------------------------------------------------------------------

function fileRow({ title, detail, selected, missing, onSelect, actions = [] }) {
    const row = document.createElement('div');
    row.className = 'vrow';
    if (missing) row.classList.add('is-missing');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', selected ? 'true' : 'false');
    const rd = document.createElement('span'); rd.className = 'rd'; rd.setAttribute('aria-hidden', 'true');
    const t = document.createElement('span'); t.className = 't';
    const b = document.createElement('b'); b.textContent = title; b.title = title;
    const sub = document.createElement('span'); sub.textContent = detail;
    t.append(b, sub);
    btn.append(rd, t);
    if (onSelect) btn.addEventListener('click', onSelect); else btn.disabled = true;
    row.append(btn, ...actions);
    return row;
}

function actionButton(label, text, onClick, className = 'rec-text-btn') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-sm ${className}`;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.textContent = text;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
}

/**
 * The rows for the audio files of one slot, in the order recordingMeta.js defines. `include(file, metas)` says which files the
 * slot lists, `selected(id)` which one it plays, and `beforeSelect` runs before a row is pressed (the Sound panel lists both
 * slots at once, so a row of the other slot first makes that slot the active one).
 */
export function buildFileRows({ include = () => true, selected, beforeSelect = null } = {}) {
    const synced = syncedFiles();
    const countOf = (id) => synced.find(s => s.audioId === id)?.count || 0;
    const removeMode = isRemoveMode();
    // By role first, then the pack's order, then as the store lists them (see recordingMeta.js)
    const metas = listRecordingMeta(getSongKey());
    // The parts of a stem set are chosen in the Stems list below, not listed as recordings of their own
    const inSet = new Set(Object.values(metas).flatMap((m) => (stemsOfMeta(m) || []).map((s) => s.audioId)));
    const leads = new Set(Object.entries(metas).filter(([, m]) => stemsOfMeta(m)).map(([k]) => k));
    const isPart = (f) => !state.stemFallback && inSet.has(f.id) && !leads.has(mediaKey({ kind: 'local', audioId: f.id }));
    const ordered = orderRecordings(state.files.filter((f) => !isPart(f) && include(f, metas)), (f) => mediaKey({ kind: 'local', audioId: f.id }), metas);
    return ordered.map(({ item: f, meta, nested }) => {
        const count = countOf(f.id);
        const detail = [roleLabel(meta), 'Audio file', tracksNote(meta), f.durationMs ? clock(f.durationMs) : 'Unknown length', megabytes(f.size), pointsLabel(count)].filter(Boolean).join(' \u00b7 ');
        let actions;
        if (removeMode) {
            const rm = actionButton('Remove this file', state.armedRemoval === f.id ? `Delete ${count} map points too?` : 'Remove', () => {
                // A file with sync points takes a second press: it would delete them
                if (count > 0 && state.armedRemoval !== f.id) { arm('remove', f.id); render(); return; }
                removeFile(f.id);
            }, 'rec-text-btn vrow-remove');
            if (state.armedRemoval === f.id) rm.classList.add('is-armed');
            actions = [rm];
        } else {
            actions = [];
        }
        const row = fileRow({
            title: meta?.label || f.name, detail, selected: selected ? selected(f.id) : (f.id === state.currentId && fileSourceActive()),
            onSelect: removeMode ? null : () => { beforeSelect?.(); selectFile(f.id); }, actions
        });
        if (nested) row.classList.add('vrow-nested');
        return row;
    });
}

/** The files that were attached on another device and are not here: a row to choose the file again. */
export function buildMissingFileRows() {
    return state.missing.map((m) => fileRow({
        title: m.name || 'Audio file',
        detail: 'Not on this device. Choose the same file to use its map points.',
        missing: true,
        actions: [actionButton('Choose the file again', 'Relink', () => startRelink(m), 'btn-theme-outline')]
    }));
}

function render() {
    const list = $('afFileList');
    if (!list) return;
    const rows = buildFileRows();
    rows.push(...buildMissingFileRows());
    list.replaceChildren(...rows);
    if ($('afFileSection')) $('afFileSection').hidden = rows.length === 0;
    setRecordingsPresent('files', state.files.length > 0);

    renderStems();
    const loaded = Boolean(state.source);
    if ($('afPlayer')) $('afPlayer').hidden = !loaded;
    if ($('afPanelTitle')) $('afPanelTitle').textContent = state.meta?.name || 'Audio File';
    if (loaded) {
        updatePlayIcon();
        drawWave();
    }
}

// --- The stems of a set: which parts are heard -------------------------------------------------------------------

const hasParts = () => Boolean(state.source?.parts && state.source.parts().length > 1);

// One strip per stem, built like the Synth panel's mixer (mixerPanel.js): name, Mute and Solo, then Level.
function stemStrip(p) {
    const box = document.createElement('div');
    box.className = 'track-mix';
    box.dataset.id = p.id;
    const head = document.createElement('div');
    head.className = 'track-mix-head';
    const name = document.createElement('span');
    name.className = 'track-mix-name';
    name.textContent = p.name;
    name.title = p.name;
    const toggles = document.createElement('div');
    toggles.className = 'track-mix-toggles';
    [['mixer-mute-btn', 'Mute', 'M'], ['mixer-solo-btn', 'Solo', 'S']].forEach(([cls, label, letter]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn btn-sm theme-control-btn mixer-toggle ${cls}`;
        btn.textContent = letter;
        btn.title = label;
        btn.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-label', `${label} ${p.name}`);
        toggles.append(btn);
    });
    head.append(name, toggles);
    const sliders = document.createElement('div');
    sliders.className = 'track-mix-sliders';
    const wrap = document.createElement('div');
    wrap.className = 'mixer-slider';
    const label = document.createElement('span');
    label.className = 'mixer-slider-label';
    label.textContent = 'Level';
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'mixer-volume';
    input.min = '0'; input.max = '150'; input.step = '1';
    input.setAttribute('aria-label', `${p.name} level`);
    const badge = document.createElement('span');
    badge.className = 'theme-value-badge mixer-volume-badge';
    wrap.append(label, input, badge);
    sliders.append(wrap);
    box.append(head, sliders);
    return box;
}

function renderStems() {
    const section = $('afStemSection');
    const list = $('afStemList');
    if (!section || !list) return;
    section.hidden = !hasParts();
    if (section.hidden) { list.replaceChildren(); delete list.dataset.key; return; }
    const parts = state.source.parts();
    // Built once per set, then updated in place, so a slider being dragged is not replaced under the finger
    const key = parts.map((p) => p.id).join('|');
    if (list.dataset.key !== key) {
        list.replaceChildren(...parts.map(stemStrip));
        list.dataset.key = key;
    }
    for (const p of parts) {
        const box = list.querySelector(`.track-mix[data-id="${CSS.escape(p.id)}"]`);
        if (!box) continue;
        const mute = box.querySelector('.mixer-mute-btn');
        const solo = box.querySelector('.mixer-solo-btn');
        mute.classList.toggle('active', !p.enabled); mute.setAttribute('aria-pressed', String(!p.enabled));
        const isSolo = p.enabled && parts.every((q) => q === p || !q.enabled) && parts.length > 1;
        solo.classList.toggle('active', isSolo); solo.setAttribute('aria-pressed', String(isSolo));
        box.classList.toggle('is-muted', !p.enabled);
        const vol = box.querySelector('.mixer-volume');
        if (document.activeElement !== vol) vol.value = Math.round(p.level * 100);
        box.querySelector('.mixer-volume-badge').textContent = p.loading ? '…' : `${Math.round(p.level * 100)}%`;
    }
    const stems = stemsOfFile(state.currentId) || [];
    const slot = state.currentSlot || 'original';
    const muted = parts.filter((p) => !p.enabled).map((p) => p.id).sort().join('|');
    const standard = defaultMutedIds(stems, slot, getInstrumentMode()).sort().join('|');
    const levelled = parts.some((p) => p.level !== 1);
    if ($('afStemReset')) $('afStemReset').disabled = muted === standard && !levelled;
    if ($('afStemLabel')) $('afStemLabel').textContent = slot === 'backing' ? 'Stems (backing)' : 'Stems (original)';
}

async function setStemMuted(muted) {
    const source = state.source;
    if (!hasParts()) return;
    setMutedIds(getSongKey(), state.currentSlot || 'original', [...muted]);
    try { await applyMutes(source, muted); } catch (e) { setStatus(e.message); }
    renderStems();
}

function onStemClick(e) {
    const btn = e.target.closest('.mixer-toggle');
    const box = e.target.closest('.track-mix');
    if (!btn || !box || !hasParts()) return;
    const parts = state.source.parts();
    const muted = new Set(parts.filter((p) => !p.enabled).map((p) => p.id));
    const id = box.dataset.id;
    if (btn.classList.contains('mixer-mute-btn')) {
        if (muted.has(id)) muted.delete(id); else muted.add(id);
    } else if (btn.getAttribute('aria-pressed') === 'true') {
        muted.clear(); // a solo pressed again brings every stem back
    } else {
        parts.forEach((p) => { if (p.id !== id) muted.add(p.id); }); muted.delete(id);
    }
    setStemMuted(muted);
}

function onStemLevel(e) {
    const box = e.target.closest('.track-mix');
    if (!box || !e.target.classList.contains('mixer-volume') || !hasParts()) return;
    const level = Number(e.target.value) / 100;
    state.source.setPartLevel(box.dataset.id, level);
    setLevel(getSongKey(), state.currentSlot || 'original', box.dataset.id, level);
}

/** The current sound's own start: its default mutes and levels, or the person's choice for it. Used when the sound changes. */
async function reapplyMutes({ reset = false } = {}) {
    if (!hasParts()) return;
    const slot = state.currentSlot || 'original';
    const songKey = getSongKey();
    if (reset) { resetMutedIds(songKey, slot); resetLevels(songKey, slot); }
    const stems = stemsOfFile(state.currentId) || [];
    applyLevels(state.source, getLevels(songKey, slot));
    try { await applyMutes(state.source, getMutedIds(songKey, slot, stems, getInstrumentMode())); } catch (e) { setStatus(e.message); }
    renderStems();
}

function updatePlayIcon() {
    const icon = $('afPlayIcon');
    if (icon) icon.className = state.source?.isPlaying() ? 'bi-pause-fill' : 'bi-play-fill';
}

function updateRateButtons() {
    document.querySelectorAll('#afRates [data-af-rate]').forEach((b) => b.classList.toggle('active', Number(b.dataset.afRate) === state.rate));
}

function drawWave() {
    const canvas = $('afWave');
    if (!canvas || !state.source || canvas.offsetParent === null) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    const css = getComputedStyle(canvas);
    const played = css.getPropertyValue('--accent-primary').trim() || '#a855f7';
    const rest = css.getPropertyValue('--text-dim').trim() || '#64748b';
    const head = css.getPropertyValue('--accent-secondary').trim() || '#10b981';
    ctx.clearRect(0, 0, w, h);
    const duration = state.source.durationMs || 1;
    const t = state.source.getTimeMs();
    const playedX = Math.min(w, Math.max(0, (t / duration) * w));
    const peaks = state.peaks;
    if (peaks?.length) {
        const mid = h / 2;
        for (let x = 0; x < w; x++) {
            const from = Math.floor((x / w) * peaks.length);
            const to = Math.max(from + 1, Math.floor(((x + 1) / w) * peaks.length));
            let peak = 0;
            for (let i = from; i < to && i < peaks.length; i++) if (peaks[i] > peak) peak = peaks[i];
            const half = Math.max(1, (peak / 255) * (mid - 2));
            ctx.fillStyle = x <= playedX ? played : rest;
            ctx.fillRect(x, mid - half, 1, half * 2);
        }
    } else {
        ctx.fillStyle = rest;
        ctx.fillRect(0, h / 2, w, 1);
    }
    ctx.fillStyle = head;
    ctx.fillRect(Math.round(playedX), 0, Math.max(1, Math.round(dpr)), h);
    const time = $('afTime');
    if (time) time.textContent = `${clock(t)} / ${clock(duration)}`;
}

function startUiLoop() {
    cancelAnimationFrame(state.uiTimer);
    const tick = () => {
        if (!state.source) return;
        if (state.isOpen) drawWave();
        if (state.source.isPlaying()) state.uiTimer = requestAnimationFrame(tick);
    };
    state.uiTimer = requestAnimationFrame(tick);
}

function startRelink(media) {
    state.relinkTarget = media;
    $('afFileInput').click();
}

// --- Panel & Exports -----------------------------------------------------------------------------------------------

/**
 * Playing a stem set and switching to the other sound keeps the same stem set: the other slot takes the set's lead file
 * (the sound then applies its own mutes) unless it already holds a file of its own that is not part of this set.
 * Returns true when the slot now holds the set.
 */
export function carryStemSetToSlot(slot) {
    const songKey = getSongKey();
    const id = state.currentId;
    if (!songKey || !id || (slot !== 'original' && slot !== 'backing') || slot === state.currentSlot) return false;
    const stems = stemsOfFile(id);
    if (!stems) return false;
    try {
        const held = localStorage.getItem(SLOT_FILE_KEY(songKey, slot));
        if (held && held !== id && !stems.some((m) => m.audioId === held)) return false;
        localStorage.setItem(SLOT_FILE_KEY(songKey, slot), id);
    } catch { return false; }
    return true;
}

export function setAudioFileSlot(slot) {
    if (slot !== 'original' && slot !== 'backing') return;
    state.currentSlot = slot;
    const songKey = getSongKey();
    let slotFileId = null;
    try {
        slotFileId = localStorage.getItem(SLOT_FILE_KEY(songKey, slot));
        if (!slotFileId && slot === 'original') {
            slotFileId = localStorage.getItem(LAST_FILE_KEY(songKey));
        }
    } catch { /* optional */ }

    const targetId = (slotFileId && state.files.some(f => f.id === slotFileId)) ? slotFileId : null;
    if (state.currentId !== targetId) {
        destroySource();
        state.currentId = targetId;
        if (targetId) ensureSource();
    } else {
        reapplyMutes(); // the same stems in the other sound: only what is muted changes
    }
    render();
}

export function setAudioFileRate(rate) {
    if (!Number.isFinite(rate)) return;
    state.rate = rate;
    state.source?.setRate(rate);
}

/** Redraws the files in the list (the list shows them whichever sound is selected). */
export const renderAudioFileList = () => render();

export function renderAudioFile() {
    render();
    if (state.currentId && !state.source) ensureSource();
}

export function toggleAudioFilePanel(force = null) {
    toggleYouTubePanel(force);
}

/**
 * Called when a song is loaded: forget the previous song's file and list this song's. Called again with
 * `{ final: true }` once the score has been read and the song's key is its artist and title.
 */
export async function updateSongForAudioFile({ final = false } = {}) {
    if (!final) {
        state.songFinal = false;
        state.pendingAdds = [];
    } else {
        state.songFinal = true;
        const key = getSongKey();
        for (const add of state.pendingAdds) {
            if (add.key !== key) await relinkAudioFile(add.id, add.key, key);
        }
        state.pendingAdds = [];
    }
    destroySource();
    state.files = [];
    state.missing = [];
    state.currentId = null;
    setStatus('');
    await refreshFiles();
    updateGlobalAudioControls();
}

export function initAudioFilePlayer() {
    if (!$('afFileList')) return;
    const input = $('afFileInput');

    $('afChooseBtn')?.addEventListener('click', () => { state.relinkTarget = null; input.click(); });
    $('afStemReset')?.addEventListener('click', () => reapplyMutes({ reset: true }));
    $('afStemList')?.addEventListener('click', onStemClick);
    $('afStemList')?.addEventListener('input', onStemLevel);
    $('afStemList')?.addEventListener('dblclick', (e) => {
        if (!e.target.classList.contains('mixer-volume') || !hasParts()) return;
        e.target.value = '100';
        onStemLevel(e);
        renderStems();
    });
    input?.addEventListener('change', () => {
        const file = input.files?.[0];
        const relink = state.relinkTarget;
        state.relinkTarget = null;
        input.value = '';
        if (file) addFile(file, { relink });
    });
    $('afPlayBtn')?.addEventListener('click', () => playPauseAudioFile());
    window.addEventListener(REC_REMOVE_MODE_EVENT, () => { disarm(); render(); });
    window.addEventListener(SYNC_CHANGED_EVENT, () => render());

    const wave = $('afWave');
    const seekFromEvent = (e) => {
        if (!state.source) return;
        const rect = wave.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        state.source.seek(frac * (state.source.durationMs || 0));
        drawWave();
    };
    wave?.addEventListener('pointerdown', (e) => { wave.setPointerCapture(e.pointerId); seekFromEvent(e); });
    wave?.addEventListener('pointermove', (e) => { if (e.buttons) seekFromEvent(e); });

    // Another audio mode starting stops this one; another panel opening closes this one
    onYouTubeEvent((e) => { if (e.type === 'state' && e.playing) pauseAudioFile(); else if (e.type === 'info') render(); });
    onTransportEvent((e) => { if (e.type === 'state' && e.playing) pauseAudioFile(); });
    window.addEventListener('resize', () => { drawWave(); });
    // A restore or sync can bring files in
    window.addEventListener(AUDIO_FILES_CHANGED_EVENT, () => refreshFiles());
    // A host is told that guests cannot hear a local file
    const updateJamNote = () => { $('afJamNote').hidden = !isJamHosting(); };
    window.addEventListener(JAM_BRIDGE_EVENT, updateJamNote);
    updateJamNote();

    mountSyncRow({
        prefix: 'af',
        getSource: () => state.source,
        getMedia: () => (state.meta ? mediaOf(state.meta) : null),
        prepareSync: () => toggleYouTubePanel(false),
        getPeaks: () => state.peaks,
        getAudioData: async () => (state.currentId ? (await getAudioFile(state.currentId))?.data || null : null),
        subscribe: (cb) => syncListeners.add(cb)
    });
}
