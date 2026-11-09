// audioFilePlayer.js
// The "Audio File" panel: pick a recording of the song from this device (a studio track, a live recording, your own
// take), play it with a waveform and speed buttons, and sync the score to it (see audioSyncUi.js). It is the third
// audio mode next to the synth and YouTube. Files are kept on the device (audioFileStore.js), keyed to the song, and a
// sync record remembers each file's name, length and fingerprint so a missing file can be relinked.

import { getSongKey, getVideoInfo, lookupVideoInfo, pauseYouTube, onYouTubeEvent, toggleYouTubePanel } from '../youtubePlayer.js';
import { pauseSynthPlayer, clearSynthHighlights, onTransportEvent } from '../gpProcessor/gpPlayer.js';
import { setActiveAudioMode, updateGlobalAudioControls } from '../utils/navigationUtils.js';
import { createLocalAudioSource } from './localAudioSource.js';
import { decodePeaks } from './peaks.js';
import {
    saveAudioFile, listAudioFilesForSong, getAudioFile, unlinkAudioFile, fingerprintOf, MAX_AUDIO_BYTES,
    setAudioExcluded, setAudioPeaks, relinkAudioFile
} from './audioFileStore.js';
import { AUDIO_FILES_CHANGED_EVENT } from './audioBackup.js';
import { isJamHosting, JAM_BRIDGE_EVENT } from './jamBridge.js';
import { listRecords, loadRecord, saveRecord, deleteRecord, mediaKey, SYNC_CHANGED_EVENT } from './syncStore.js';
import { mountSyncRow } from './audioSyncUi.js';

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
    peaks: null,
    rate: 1,
    relinkTarget: null, // media descriptor being relinked, or null when choosing a new file
    uiTimer: 0,
    removeMode: false,  // the list shows Remove beside each file
    armedRemoval: null, // file id waiting for a second press (it has sync points)
    armedCopy: null,    // file id waiting for a second press (it would replace points)
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

export function pauseAudioFile() {
    if (state.source?.isPlaying()) state.source.pause();
}

export function rewindAudioFile10Seconds() {
    if (!state.source) return;
    state.source.seek(Math.max(0, state.source.getTimeMs() - 10000));
}

export async function playPauseAudioFile() {
    if (state.source?.isPlaying()) {
        state.source.pause();
        return;
    }
    if (!await ensureSource()) {
        toggleAudioFilePanel(true);
        return;
    }
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
    state.peaks = null;
    cancelAnimationFrame(state.uiTimer);
}

async function refreshFiles() {
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
    if (state.isOpen && state.currentId && !state.source) ensureSource();
    // A song whose Original is a local file loads it when it opens, so its recording bar is there before the first Play
    else if (state.currentId && !state.source && usesLocalOriginal(songKey)) ensureSource();
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
        state.peaks = analysed.peaks;
        drawWave();
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
            const source = createLocalAudioSource({ id, name: rec.name, type: rec.type, data: rec.data, durationMs: rec.durationMs });
            try {
                await source.ready();
            } catch (e) {
                source.destroy();
                setStatus(e.message);
                return false;
            }
            if (state.currentId !== id) {
                source.destroy();
                return false;
            }
            const { data, ...meta } = rec;
            state.source = source;
            state.meta = meta;
            state.peaks = rec.peaks || null;
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

async function selectFile(id) {
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
            if (!sameFile && !sameLength && !confirm('This file is a different length from the one the sync points were made with, so they will probably not line up. Use it anyway?')) {
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

async function toggleExcluded(file) {
    await setAudioExcluded(file.id, !file.excludeFromBackup);
    await refreshFiles();
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
    await unlinkAudioFile(id, songKey);
    deleteRecord(songKey, { kind: 'local', audioId: id, name: meta?.name || '' });
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
const pointsLabel = (count) => (count ? `Synced · ${count} ${count === 1 ? 'point' : 'points'}` : 'Not synced');

function disarm() { clearTimeout(state.armTimer); state.armedRemoval = null; state.armedCopy = null; }
function arm(kind, id) {
    disarm();
    if (kind === 'remove') state.armedRemoval = id; else state.armedCopy = id;
    state.armTimer = setTimeout(() => { disarm(); render(); }, 4000);
}

/** Copies the sync points of another file of this song onto the loaded one (the times are copied as they are). */
function copyPointsBetweenFiles(fromKey) {
    const songKey = getSongKey();
    const from = listRecords(songKey).find(r => mediaKey(r.media) === fromKey);
    if (!songKey || !state.meta || !from) return;
    const origin = from.media.kind === 'local'
        ? { fromAudioId: from.media.audioId, fromAudioName: from.media.name, fromSongKey: songKey, copiedAt: Date.now() }
        : { fromVideoId: from.media.videoId, fromSongKey: songKey, copiedAt: Date.now() };
    const media = { ...mediaOf(state.meta), origin };
    if (saveRecord(songKey, media, from.points)) {
        window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
        if ($('afCopyPicker')) $('afCopyPicker').hidden = true;
        $('afCopyBetweenBtn')?.setAttribute('aria-expanded', 'false');
        render();
    }
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

function render() {
    const list = $('afFileList');
    if (!list) return;
    const synced = syncedFiles();
    const countOf = (id) => synced.find(s => s.audioId === id)?.count || 0;
    const rows = state.files.map(f => {
        const count = countOf(f.id);
        const detail = [f.durationMs ? clock(f.durationMs) : 'Unknown length', megabytes(f.size), pointsLabel(count)].join(' · ');
        let actions;
        if (state.removeMode) {
            const rm = actionButton('Remove this file', state.armedRemoval === f.id ? `Delete ${count} sync points too?` : 'Remove', () => {
                // A file with sync points takes a second press: it would delete them
                if (count > 0 && state.armedRemoval !== f.id) { arm('remove', f.id); render(); return; }
                removeFile(f.id);
            }, 'rec-text-btn vrow-remove');
            if (state.armedRemoval === f.id) rm.classList.add('is-armed');
            actions = [rm];
        } else {
            actions = [actionButton(
                f.excludeFromBackup ? 'Kept out of backups and sync. Press to include it.' : 'Included in backups and sync. Press to keep it out.',
                f.excludeFromBackup ? 'Local only' : 'In backups', () => toggleExcluded(f)
            )];
        }
        return fileRow({ title: f.name, detail, selected: f.id === state.currentId, onSelect: state.removeMode ? null : () => selectFile(f.id), actions });
    });
    for (const m of state.missing) {
        rows.push(fileRow({
            title: m.name || 'Audio file',
            detail: 'Not on this device. Choose the same file to use its sync points.',
            missing: true,
            actions: [actionButton('Choose the file again', 'Relink', () => startRelink(m), 'btn-theme-outline')]
        }));
    }
    list.replaceChildren(...rows);
    if ($('afFileSection')) $('afFileSection').hidden = rows.length === 0;
    const editBtn = $('afEditFilesBtn');
    if (editBtn) {
        editBtn.hidden = state.files.length === 0;
        editBtn.textContent = state.removeMode ? 'Done' : 'Remove files…';
        editBtn.setAttribute('aria-pressed', state.removeMode ? 'true' : 'false');
    }
    if (state.files.length === 0) state.removeMode = false;

    const mine = state.currentId ? synced.find(s => s.audioId === state.currentId) : null;
    const origin = $('afOriginInfo');
    if (origin) {
        const o = mine?.origin;
        const fromName = o?.fromAudioId ? (state.files.find(f => f.id === o.fromAudioId)?.name || o.fromAudioName) : null;
        origin.hidden = !o;
        origin.textContent = o
            ? (o.fromAudioId ? `Sync points copied from ${fromName || 'another file'}`
                : o.fromVideoId ? `Sync points copied from ${getVideoInfo(o.fromVideoId)?.title || 'a video'}`
                    : `Copied from tab: ${o.fromTabName || o.fromSongKey || ''}`)
            : '';
    }
    // Copy sync points between this song's files: into the loaded one, from another that has points
    // From any recording of the song with points: another file or a YouTube video
    const sources = listRecords(getSongKey()).filter(r => r.points.length && mediaKey(r.media) !== `local_${state.currentId}`);
    const showCopy = Boolean(state.currentId) && sources.length > 0;
    if ($('afCopyBetweenBtn')) $('afCopyBetweenBtn').hidden = !showCopy;
    const picker = $('afCopyPicker');
    if (picker && !showCopy) picker.hidden = true;
    const pickerList = $('afCopyPickerList');
    if (pickerList && picker && !picker.hidden) {
        pickerList.replaceChildren(...sources.map((r) => {
            const key = mediaKey(r.media);
            const isLocal = r.media.kind === 'local';
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'slot vrow-copy';
            row.dataset.copyFrom = key;
            const t = document.createElement('span'); t.className = 't';
            const b = document.createElement('b');
            b.textContent = state.armedCopy === key ? `Replace ${mine?.count || 0} sync points?` : (isLocal ? (r.media.name || 'Audio file') : (getVideoInfo(r.media.videoId)?.title || 'Loading…'));
            const sub = document.createElement('span');
            sub.textContent = `${isLocal ? 'Audio file' : 'YouTube video'} · ${r.points.length} ${r.points.length === 1 ? 'point' : 'points'}`;
            t.append(b, sub);
            row.append(t);
            if (state.armedCopy === key) row.classList.add('is-armed');
            if (!isLocal && !getVideoInfo(r.media.videoId)) lookupVideoInfo(r.media.videoId);
            return row;
        }));
    }

    const loaded = Boolean(state.source);
    if ($('afPlayer')) $('afPlayer').hidden = !loaded;
    if ($('afPanelTitle')) $('afPanelTitle').textContent = state.meta?.name || 'Audio File';
    if (loaded) {
        updatePlayIcon();
        drawWave();
    }
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
    }
    render();
}

export function setAudioFileRate(rate) {
    if (!Number.isFinite(rate)) return;
    state.rate = rate;
    state.source?.setRate(rate);
}

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
    const section = $('realAudioLocalSection');
    if (!section) return;
    const input = $('afFileInput');

    $('afChooseBtn')?.addEventListener('click', () => { state.relinkTarget = null; input.click(); });
    input?.addEventListener('change', () => {
        const file = input.files?.[0];
        const relink = state.relinkTarget;
        state.relinkTarget = null;
        input.value = '';
        if (file) addFile(file, { relink });
    });
    $('afPlayBtn')?.addEventListener('click', () => playPauseAudioFile());
    $('afEditFilesBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        state.removeMode = !state.removeMode;
        disarm();
        render();
    });
    $('afCopyBetweenBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const picker = $('afCopyPicker');
        if (!picker) return;
        picker.hidden = !picker.hidden;
        e.currentTarget.setAttribute('aria-expanded', picker.hidden ? 'false' : 'true');
        disarm();
        render();
    });
    $('afCopyPickerList')?.addEventListener('click', (e) => {
        const row = e.target.closest('[data-copy-from]');
        if (!row) return;
        e.stopPropagation();
        const id = row.dataset.copyFrom;
        const mine = syncedFiles().find(f => f.audioId === state.currentId);
        if (mine?.count > 0 && state.armedCopy !== id) { arm('copy', id); render(); return; }
        disarm();
        copyPointsBetweenFiles(id);
    });
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
