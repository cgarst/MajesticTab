// audioFilePlayer.js
// The "Audio File" panel: pick a recording of the song from this device (a studio track, a live recording, your own
// take), play it with a waveform and speed buttons, and sync the score to it (see audioSyncUi.js). It is the third
// audio mode next to the synth and YouTube. Files are kept on the device (audioFileStore.js), keyed to the song, and a
// sync record remembers each file's name, length and fingerprint so a missing file can be relinked.

import { getSongKey, pauseYouTube, onYouTubeEvent, toggleYouTubePanel } from '../youtubePlayer.js';
import { pauseSynthPlayer, clearSynthHighlights, onTransportEvent, toggleSynthPanel, toggleScoreOptionsPanel } from '../gpProcessor/gpPlayer.js';
import { setActiveAudioMode, updateGlobalAudioControls } from '../utils/navigationUtils.js';
import { createLocalAudioSource } from './localAudioSource.js';
import { decodePeaks } from './peaks.js';
import {
    saveAudioFile, listAudioFilesForSong, getAudioFile, unlinkAudioFile, fingerprintOf, MAX_AUDIO_BYTES,
    setAudioExcluded, setAudioPeaks, relinkAudioFile
} from './audioFileStore.js';
import { AUDIO_FILES_CHANGED_EVENT } from './audioBackup.js';
import { isJamHosting, JAM_BRIDGE_EVENT } from './jamBridge.js';
import { listRecords, loadRecord, saveRecord } from './syncStore.js';
import { mountSyncRow } from './audioSyncUi.js';
import { formatTime } from './syncEdit.js';

const LAST_FILE_KEY = (songKey) => `audio_file_last_${encodeURIComponent(String(songKey).toLowerCase())}`;
const LENGTH_TOLERANCE_MS = 1500;

const state = {
    isOpen: false,
    files: [],          // stored files for this song (metadata)
    missing: [],        // local recordings the song has sync points for whose file is not on this device
    currentId: null,
    meta: null,         // metadata of the loaded file
    source: null,       // the MediaSource of the loaded file
    peaks: null,
    rate: 1,
    relinkTarget: null, // media descriptor being relinked, or null when choosing a new file
    uiTimer: 0,
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
        let last = null;
        try { last = localStorage.getItem(LAST_FILE_KEY(songKey)); } catch { /* optional */ }
        const next = state.files.find(f => f.id === last) || state.files[0] || null;
        if (state.currentId !== (next?.id ?? null)) destroySource();
        state.currentId = next?.id ?? null;
    }
    render();
    updateGlobalAudioControls();
    // The panel can be open before the list arrives (right after the song loads): load the selection then
    if (state.isOpen && state.currentId && !state.source) ensureSource();
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
}

async function toggleExcluded(file) {
    await setAudioExcluded(file.id, !file.excludeFromBackup);
    await refreshFiles();
}

async function removeFile(id) {
    if (!confirm('Remove this audio file from this device? Its sync points are kept.')) return;
    if (id === state.currentId) destroySource();
    await unlinkAudioFile(id, getSongKey());
    if (state.currentId === id) state.currentId = null;
    await refreshFiles();
}

// --- Rendering -----------------------------------------------------------------------------------------------------

function fileRow({ title, detail, selected, missing, onSelect, actions }) {
    const row = document.createElement('div');
    row.className = 'af-file-row';
    if (selected) row.classList.add('is-selected');
    if (missing) row.classList.add('is-missing');
    const main = document.createElement('div');
    main.className = 'af-file-main';
    const name = document.createElement('div');
    name.className = 'small fw-semibold text-white text-truncate';
    name.textContent = title;
    name.title = title;
    const sub = document.createElement('div');
    sub.className = 'text-white-50 text-truncate';
    sub.style.fontSize = '0.72rem';
    sub.textContent = detail;
    main.append(name, sub);
    const acts = document.createElement('div');
    acts.className = 'af-file-actions';
    acts.append(...actions);
    row.append(main, acts);
    if (onSelect) row.addEventListener('click', onSelect);
    return row;
}

function actionButton(label, icon, text, onClick, themed = 'btn-theme-icon') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-sm ${themed}`;
    b.title = label;
    b.setAttribute('aria-label', label);
    if (icon) b.innerHTML = `<i class="${icon}"></i>`;
    if (text) b.textContent = text;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
}

function render() {
    const list = $('afFileList');
    if (!list) return;
    const rows = state.files.map(f => fileRow({
        title: f.name,
        detail: `${f.durationMs ? clock(f.durationMs) : 'Unknown length'} · ${megabytes(f.size)}`,
        selected: f.id === state.currentId,
        onSelect: () => selectFile(f.id),
        actions: [
            actionButton(
                f.excludeFromBackup ? 'Kept out of backups and sync. Click to include it.' : 'Included in backups and sync. Click to keep it out.',
                f.excludeFromBackup ? 'bi-cloud-slash' : 'bi-cloud-check', null, () => toggleExcluded(f)
            ),
            actionButton('Remove this file', 'bi-trash', null, () => removeFile(f.id))
        ]
    }));
    for (const m of state.missing) {
        rows.push(fileRow({
            title: m.name || 'Audio file',
            detail: 'Not on this device. Choose the same file to use its sync points.',
            missing: true,
            actions: [actionButton('Choose the file again', null, 'Relink', () => startRelink(m), 'btn-theme-outline')]
        }));
    }
    list.replaceChildren(...rows);
    $('afHint').hidden = rows.length > 0;
    const loaded = Boolean(state.source);
    $('afPlayer').hidden = !loaded;
    $('afPanelTitle').textContent = state.meta?.name || 'Audio File';
    if (loaded) {
        updatePlayIcon();
        updateRateButtons();
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

// --- Panel ---------------------------------------------------------------------------------------------------------

function positionPanel() {
    const panel = $('audioFileDropdownPanel');
    const toggleBtn = $('audioFileToggleBtn');
    if (!panel || !state.isOpen) return;
    const mobileDock = $('mobilePlaybackDock');
    const mobileActive = window.innerWidth <= 576 || (mobileDock && getComputedStyle(mobileDock).display !== 'none');
    if (mobileActive && mobileDock) {
        panel.classList.add('popup-from-bottom');
        const dockRect = mobileDock.getBoundingClientRect();
        const bottomOffset = dockRect.top > 0 ? Math.max(12, Math.round(window.innerHeight - dockRect.top + 8)) : 76;
        Object.assign(panel.style, { position: 'fixed', top: 'auto', bottom: `${bottomOffset}px`, left: '50%', transform: 'translateX(-50%)' });
        return;
    }
    panel.classList.remove('popup-from-bottom');
    panel.style.bottom = 'auto';
    if (!toggleBtn) return;
    const rect = toggleBtn.getBoundingClientRect();
    const half = Math.min(190, (window.innerWidth - 24) / 2);
    const centerX = rect.left + rect.width / 2;
    Object.assign(panel.style, {
        position: 'fixed',
        top: `${rect.bottom + 8}px`,
        left: `${Math.max(half + 12, Math.min(window.innerWidth - half - 12, centerX))}px`,
        transform: 'translateX(-50%)'
    });
}

export function toggleAudioFilePanel(force = null) {
    const panel = $('audioFileDropdownPanel');
    if (!panel) return;
    const open = force !== null ? force : !state.isOpen;
    state.isOpen = open;
    $('audioFileToggleBtn')?.classList.toggle('active', open);
    $('mobileAudioFileToggleBtn')?.classList.toggle('active', open);
    if (open) {
        toggleYouTubePanel(false);
        toggleSynthPanel(false);
        toggleScoreOptionsPanel(false);
        setActiveAudioMode('audio');
        positionPanel();
        panel.style.display = 'block';
        render();
        ensureSource();
        if (state.source?.isPlaying()) startUiLoop();
    } else {
        panel.style.display = 'none';
        panel.classList.remove('popup-from-bottom');
    }
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
    const btn = $('audioFileToggleBtn');
    if (btn) btn.style.display = 'inline-flex';
    refreshFiles();
    updateGlobalAudioControls();
}

export function initAudioFilePlayer() {
    const panel = $('audioFileDropdownPanel');
    if (!panel) return;
    const input = $('afFileInput');

    $('audioFileToggleBtn')?.addEventListener('click', () => toggleAudioFilePanel());
    $('afPanelCloseBtn')?.addEventListener('click', () => toggleAudioFilePanel(false));
    $('afChooseBtn')?.addEventListener('click', () => { state.relinkTarget = null; input.click(); });
    input?.addEventListener('change', () => {
        const file = input.files?.[0];
        const relink = state.relinkTarget;
        state.relinkTarget = null;
        input.value = '';
        if (file) addFile(file, { relink });
    });
    $('afPlayBtn')?.addEventListener('click', () => playPauseAudioFile());
    document.querySelectorAll('#afRates [data-af-rate]').forEach((b) => b.addEventListener('click', () => {
        state.rate = Number(b.dataset.afRate);
        state.source?.setRate(state.rate);
        updateRateButtons();
    }));

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
    onYouTubeEvent((e) => { if (e.type === 'state' && e.playing) pauseAudioFile(); });
    onTransportEvent((e) => { if (e.type === 'state' && e.playing) pauseAudioFile(); });
    for (const id of ['ytToggleBtn', 'synthToggleBtn', 'mobileYtToggleBtn', 'mobileSynthToggleBtn']) {
        $(id)?.addEventListener('click', () => { if (state.isOpen) toggleAudioFilePanel(false); });
    }
    window.addEventListener('resize', () => { positionPanel(); drawWave(); });
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
        prepareSync: () => toggleAudioFilePanel(false),
        getPeaks: () => state.peaks,
        getAudioData: async () => (state.currentId ? (await getAudioFile(state.currentId))?.data || null : null),
        subscribe: (cb) => syncListeners.add(cb)
    });
}
