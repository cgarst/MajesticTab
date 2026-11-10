// bulkExportCore.js
// Core export engines for MajesticTab:
// 1. Library metadata CSV (artist, album, song, youtube url, youtube backing url, tunings, tab files, year)
// 1b. Sync data: a ZIP of JSON files, one per song and recording, each naming the video or file it is synced to
// 2. Original tab files (organized into folders as a ZIP archive)
// 3. PDF bulk export (runs all tabs in library through the score PDF export code, bundled into a ZIP archive)

import { listRecords } from '../audioSync/syncStore.js';
import { listHistory } from '../audioSync/videoHistory.js';
import { isIOSDevice } from '../utils/iosAudioUnlock.js';
import { showToast } from '../utils/toast.js';

export function escapeCsvCell(val) {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

export function toCsvRow(cells) {
    return cells.map(escapeCsvCell).join(',');
}

export function safeName(str, fallback = 'Untitled') {
    const cleaned = String(str || '').replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, ' ').trim();
    return cleaned || fallback;
}

export function uniquePath(path, used) {
    if (!used.has(path)) {
        used.add(path);
        return path;
    }
    const dot = path.lastIndexOf('.');
    const base = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
    const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
    let n = 2;
    while (used.has(`${base} (${n})${ext}`)) n++;
    const next = `${base} (${n})${ext}`;
    used.add(next);
    return next;
}

/**
 * Builds candidate keys to search for video associations and sync points for a library song.
 * Tabs can carry different titles, and past sessions record keys under yt_song_keys_{id}.
 */
export function getCandidateKeysForSong(song, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    const candidateKeys = new Set();
    const primaryKey = [song.artist, song.title].filter(Boolean).join(' - ') || song.title || '';
    if (primaryKey) candidateKeys.add(primaryKey);
    if (song.title) candidateKeys.add(song.title);

    if (song.id && storage) {
        try {
            const raw = JSON.parse(storage.getItem(`yt_song_keys_${song.id}`) || '[]');
            for (const item of raw) {
                const k = typeof item === 'string' ? item : item?.key;
                if (k) candidateKeys.add(k);
            }
        } catch { /* optional */ }
    }

    if (Array.isArray(song.tabOptions)) {
        for (const t of song.tabOptions) {
            if (t.name) candidateKeys.add(t.name);
        }
    }

    return Array.from(candidateKeys);
}

/** Every distinct recording's sync record (with points) stored under any of the song's keys. */
function collectSyncRecords(candidateKeys, storage, listRecordsFn) {
    const out = [];
    const seenMedia = new Set();
    if (typeof listRecordsFn !== 'function' || !storage) return out;
    for (const k of candidateKeys) {
        for (const r of listRecordsFn(k, storage)) {
            if (!r.points || !r.points.length) continue;
            const mKey = r.media?.kind === 'youtube'
                ? `yt_${r.media.videoId}`
                : (r.media?.audioId ? `local_${r.media.audioId}` : null);
            if (mKey && !seenMedia.has(mKey)) {
                seenMedia.add(mKey);
                out.push({ record: r, songKey: k });
            }
        }
    }
    return out;
}

/**
 * Exports library metadata as an RFC 4180 CSV string.
 * Columns: artist, album, song, youtube url, youtube backing url, tunings, tab_files, year.
 * Sync points are not in the CSV (they overflow a spreadsheet cell); see buildSyncZipEntries.
 */
export function exportMetadataCsv({
    songs = [],
    collections = [],
    storage = (typeof localStorage !== 'undefined' ? localStorage : null),
    listRecordsFn = listRecords,
    listHistoryFn = listHistory
} = {}) {
    const headers = [
        'artist',
        'album',
        'song',
        'youtube url',
        'youtube backing url',
        'tunings',
        'tab_files',
        'year'
    ];

    const rows = [toCsvRow(headers)];
    let songsWithOriginalVideo = 0;
    let songsWithBackingVideo = 0;
    let songsWithSync = 0;

    for (const song of songs) {
        const artist = song.artist || '';
        const album = song.album || '';
        const songTitle = song.title || '';

        const candidateKeys = getCandidateKeysForSong(song, storage);

        // 1. YouTube original recording URL
        let originalVideoId = null;
        if (storage) {
            for (const k of candidateKeys) {
                const vid = storage.getItem(`yt_track_${encodeURIComponent(k.toLowerCase())}_original`);
                if (vid) { originalVideoId = vid; break; }
            }
            if (!originalVideoId && typeof listHistoryFn === 'function') {
                for (const k of candidateKeys) {
                    const hist = listHistoryFn(k, 'original', storage);
                    if (hist.length && hist[0].videoId) { originalVideoId = hist[0].videoId; break; }
                }
            }
        }

        // 2. YouTube backing track URL
        let backingVideoId = null;
        if (storage) {
            for (const k of candidateKeys) {
                const vid = storage.getItem(`yt_track_${encodeURIComponent(k.toLowerCase())}_backing`);
                if (vid) { backingVideoId = vid; break; }
            }
            if (!backingVideoId && typeof listHistoryFn === 'function') {
                for (const k of candidateKeys) {
                    const hist = listHistoryFn(k, 'backing', storage);
                    if (hist.length && hist[0].videoId) { backingVideoId = hist[0].videoId; break; }
                }
            }
        }

        if (originalVideoId) songsWithOriginalVideo++;
        if (backingVideoId) songsWithBackingVideo++;

        // 3. Audio sync data (counted here, exported by buildSyncZipEntries)
        const syncRecords = collectSyncRecords(candidateKeys, storage, listRecordsFn);
        if (syncRecords.length > 0) songsWithSync++;

        const originalUrl = originalVideoId ? `https://www.youtube.com/watch?v=${originalVideoId}` : '';
        const backingUrl = backingVideoId ? `https://www.youtube.com/watch?v=${backingVideoId}` : '';
        const tunings = Array.isArray(song.tunings) ? song.tunings.join('; ') : '';
        const tabFiles = Array.isArray(song.tabOptions)
            ? song.tabOptions.map((t) => t.name || '').filter(Boolean).join('; ')
            : '';
        const year = song.year != null ? String(song.year) : '';

        rows.push(toCsvRow([
            artist,
            album,
            songTitle,
            originalUrl,
            backingUrl,
            tunings,
            tabFiles,
            year
        ]));
    }

    return {
        csvString: rows.join('\r\n'),
        count: songs.length,
        stats: {
            totalSongs: songs.length,
            songsWithOriginalVideo,
            songsWithBackingVideo,
            songsWithSync
        }
    };
}

/**
 * Builds entry map for a ZIP of audio sync data: one JSON file per song and recording.
 * Output structure: [Collection/]Artist/Album/Song - <video id or audio file name>.json
 * Each file names the song, its tab files and the recording it is synced to (YouTube URL, or local audio file
 * name, duration and fingerprint), then carries the sync record itself.
 */
export function buildSyncZipEntries({
    songs = [],
    collections = [],
    storage = (typeof localStorage !== 'undefined' ? localStorage : null),
    listRecordsFn = listRecords,
    listHistoryFn = listHistory,
    exportedAt = new Date().toISOString()
} = {}) {
    const collectionNames = new Map(collections.map((c) => [c.id, c.name]));
    const multipleCollections = collections.length > 1;
    const entries = {};
    const usedPaths = new Set();
    const encoder = new TextEncoder();
    let songCount = 0;
    let count = 0;

    const slotVideoId = (candidateKeys, slot) => {
        if (!storage) return null;
        for (const k of candidateKeys) {
            const vid = storage.getItem(`yt_track_${encodeURIComponent(k.toLowerCase())}_${slot}`);
            if (vid) return vid;
        }
        if (typeof listHistoryFn === 'function') {
            for (const k of candidateKeys) {
                const hist = listHistoryFn(k, slot, storage);
                if (hist.length && hist[0].videoId) return hist[0].videoId;
            }
        }
        return null;
    };

    for (const song of songs) {
        const candidateKeys = getCandidateKeysForSong(song, storage);
        const found = collectSyncRecords(candidateKeys, storage, listRecordsFn);
        if (!found.length) continue;
        songCount++;

        const originalId = slotVideoId(candidateKeys, 'original');
        const backingId = slotVideoId(candidateKeys, 'backing');
        const tabFiles = Array.isArray(song.tabOptions)
            ? song.tabOptions.map((t) => t.name || '').filter(Boolean)
            : [];

        for (const { record, songKey } of found) {
            const m = record.media;
            let media;
            let label;
            let slot = null;
            if (m.kind === 'youtube') {
                media = {
                    kind: 'youtube',
                    videoId: m.videoId,
                    url: `https://www.youtube.com/watch?v=${m.videoId}`,
                    ...(m.label ? { title: m.label } : {})
                };
                if (m.videoId === originalId) slot = 'original';
                else if (m.videoId === backingId) slot = 'backing';
                label = m.videoId;
            } else {
                media = {
                    kind: 'local',
                    fileName: m.name || '',
                    durationMs: m.durationMs ?? null,
                    fingerprint: m.fingerprint || '',
                    audioId: m.audioId
                };
                label = m.name || m.audioId;
            }

            const doc = {
                format: 'majestictab-sync',
                version: 1,
                exportedAt,
                song: {
                    artist: song.artist || '',
                    album: song.album || '',
                    title: song.title || '',
                    songKey,
                    tabFiles
                },
                recording: { ...(slot ? { slot } : {}), ...media },
                updatedAt: record.updatedAt || 0,
                points: record.points
            };

            const parts = [];
            if (multipleCollections && song.collectionId) {
                parts.push(safeName(collectionNames.get(song.collectionId), 'Library'));
            }
            parts.push(safeName(song.artist, 'Unknown Artist'));
            if (song.album) parts.push(safeName(song.album));
            parts.push(`${safeName(song.title, 'Untitled')} - ${safeName(label, 'recording')}.json`);
            const path = uniquePath(parts.join('/'), usedPaths);
            entries[path] = [encoder.encode(JSON.stringify(doc, null, 2)), { level: 6 }];
            count++;
        }
    }

    return { entries, count, songCount };
}

/**
 * Builds entry map for creating an uncompressed or compressed ZIP of all original tab files.
 * Output structure: [Collection/]Artist/Album/filename
 */
export async function buildOriginalsZipEntries({
    songs = [],
    collections = [],
    allStoredFiles = [],
    getStoredFile,
    includeUnlinked = true,
    onProgress,
    abortSignal
} = {}) {
    const collectionNames = new Map(collections.map((c) => [c.id, c.name]));
    const multipleCollections = collections.length > 1;
    const entries = {};
    const usedPaths = new Set();
    const seenFileIds = new Set();
    let count = 0;

    const totalTabs = songs.reduce((n, song) => n + (Array.isArray(song.tabOptions) ? song.tabOptions.length : 0), 0);
    let doneTabs = 0;

    for (const song of songs) {
        if (abortSignal?.aborted) return null;
        const tabs = Array.isArray(song.tabOptions) ? song.tabOptions : [];
        for (const t of tabs) {
            if (abortSignal?.aborted) return null;
            doneTabs++;
            onProgress?.(doneTabs, totalTabs, `Reading ${doneTabs} of ${totalTabs}...`);
            if (!t.fileStoreId || typeof getStoredFile !== 'function') continue;
            const stored = await getStoredFile(t.fileStoreId);
            if (!stored?.file) continue;

            const dedupeKey = `${song.id}_${t.fileStoreId}`;
            if (seenFileIds.has(dedupeKey)) continue;
            seenFileIds.add(dedupeKey);

            const parts = [];
            if (multipleCollections && song.collectionId) {
                parts.push(safeName(collectionNames.get(song.collectionId), 'Library'));
            }
            parts.push(safeName(song.artist, 'Unknown Artist'));
            if (song.album) parts.push(safeName(song.album));
            parts.push(safeName(stored.file.name || t.name, 'tab'));
            const path = uniquePath(parts.join('/'), usedPaths);

            const arrayBuffer = await stored.file.arrayBuffer();
            entries[path] = [new Uint8Array(arrayBuffer), { level: 0 }];
            count++;
        }
    }

    if (includeUnlinked && Array.isArray(allStoredFiles) && typeof getStoredFile === 'function') {
        for (const fileMeta of allStoredFiles) {
            if (abortSignal?.aborted) return null;
            if (!fileMeta?.id) continue;
            const alreadyIncluded = Array.from(seenFileIds).some((key) => key.endsWith(`_${fileMeta.id}`));
            if (alreadyIncluded) continue;

            const ext = (fileMeta.name || '').split('.').pop().toLowerCase();
            if (!['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'pdf', 'txt'].includes(ext)) continue;

            const stored = await getStoredFile(fileMeta.id);
            if (!stored?.file) continue;
            const path = uniquePath(`Unsorted/${safeName(stored.file.name || fileMeta.name, 'tab')}`, usedPaths);
            const arrayBuffer = await stored.file.arrayBuffer();
            entries[path] = [new Uint8Array(arrayBuffer), { level: 0 }];
            count++;
        }
    }

    return { entries, count };
}

/**
 * Builds entry map for creating a ZIP of all library tabs rendered to PDF.
 * Output structure: [Collection/]Artist/Album/filename.pdf
 */
export async function buildLibraryPdfsZipEntries({
    songs = [],
    collections = [],
    allStoredFiles = [],
    getStoredFile,
    renderTabToPdfFn,
    includeUnlinked = false,
    onProgress,
    abortSignal
} = {}) {
    const collectionNames = new Map(collections.map((c) => [c.id, c.name]));
    const multipleCollections = collections.length > 1;
    const entries = {};
    const usedPaths = new Set();
    const seenFileIds = new Set();
    let count = 0;

    const totalTabs = songs.reduce((n, song) => n + (Array.isArray(song.tabOptions) ? song.tabOptions.length : 0), 0);
    let doneTabs = 0;

    for (const song of songs) {
        if (abortSignal?.aborted) return null;
        const tabs = Array.isArray(song.tabOptions) ? song.tabOptions : [];
        for (const t of tabs) {
            if (abortSignal?.aborted) return null;
            doneTabs++;
            onProgress?.(doneTabs, totalTabs, `Exporting PDF ${doneTabs} of ${totalTabs}: ${song.title || t.name}…`);
            if (!t.fileStoreId || typeof getStoredFile !== 'function') continue;

            const dedupeKey = `${song.id}_${t.fileStoreId}`;
            if (seenFileIds.has(dedupeKey)) continue;
            seenFileIds.add(dedupeKey);

            const stored = await getStoredFile(t.fileStoreId);
            if (!stored?.file) continue;

            const fileObj = stored.file;
            if (!fileObj.songTitle && song.title) fileObj.songTitle = song.title;
            if (!fileObj.artist && song.artist) fileObj.artist = song.artist;
            if (!fileObj.tabName && t.name) fileObj.tabName = t.name;

            let pdfBytes = null;
            if (typeof renderTabToPdfFn === 'function') {
                try {
                    pdfBytes = await renderTabToPdfFn(fileObj, { abortSignal });
                } catch (tabErr) {
                    console.error(`[BulkExport] Error rendering PDF for ${t.name}:`, tabErr);
                }
            }

            if (abortSignal?.aborted) return null;
            if (!pdfBytes) continue;

            const parts = [];
            if (multipleCollections && song.collectionId) {
                parts.push(safeName(collectionNames.get(song.collectionId), 'Library'));
            }
            parts.push(safeName(song.artist, 'Unknown Artist'));
            if (song.album) parts.push(safeName(song.album));

            const rawBase = (t.name || fileObj.name || song.title || 'Tab').replace(/\.[^/.]+$/, '');
            const pdfFileName = `${safeName(rawBase, 'Tab')}.pdf`;
            parts.push(pdfFileName);

            const path = uniquePath(parts.join('/'), usedPaths);
            entries[path] = [pdfBytes, { level: 0 }];
            count++;
        }
    }

    if (includeUnlinked && Array.isArray(allStoredFiles) && typeof getStoredFile === 'function') {
        for (const fileMeta of allStoredFiles) {
            if (abortSignal?.aborted) return null;
            if (!fileMeta?.id) continue;
            const alreadyIncluded = Array.from(seenFileIds).some((key) => key.endsWith(`_${fileMeta.id}`));
            if (alreadyIncluded) continue;

            const ext = (fileMeta.name || '').split('.').pop().toLowerCase();
            if (!['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'pdf', 'txt'].includes(ext)) continue;

            const stored = await getStoredFile(fileMeta.id);
            if (!stored?.file) continue;

            let pdfBytes = null;
            if (typeof renderTabToPdfFn === 'function') {
                try {
                    pdfBytes = await renderTabToPdfFn(stored.file, { abortSignal });
                } catch (tabErr) {
                    console.error(`[BulkExport] Error rendering PDF for unsorted ${fileMeta.name}:`, tabErr);
                }
            }

            if (abortSignal?.aborted) return null;
            if (!pdfBytes) continue;

            const rawBase = (stored.file.name || fileMeta.name || 'Tab').replace(/\.[^/.]+$/, '');
            const path = uniquePath(`Unsorted/${safeName(rawBase, 'Tab')}.pdf`, usedPaths);
            entries[path] = [pdfBytes, { level: 0 }];
            count++;
        }
    }

    return { entries, count };
}

/**
 * Creates a zip binary using fflate.
 */
export function createZip(entries) {
    const fflateObj = (typeof window !== 'undefined' && window.fflate)
        ? window.fflate
        : (typeof globalThis !== 'undefined' && globalThis.fflate ? globalThis.fflate : null);
    if (!fflateObj?.zipSync) throw new Error('ZIP library (fflate) not available');
    return fflateObj.zipSync(entries);
}

/**
 * Resolve standard MIME type for export formats.
 */
export function getMimeType(filename, defaultType = '') {
    const ext = String(filename || '').split('.').pop()?.toLowerCase();
    if (ext === 'csv') return 'text/csv';
    if (ext === 'zip') return 'application/zip';
    if (ext === 'pdf') return 'application/pdf';
    if (ext === 'txt') return 'text/plain';
    return defaultType || 'application/octet-stream';
}

/**
 * Format bytes into human-readable string.
 */
export function formatBytes(bytes, decimals = 1) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Shows a user-gesture prompt modal for iOS to trigger navigator.share().
 * On iOS, WebKit rejects navigator.share() if not invoked synchronously within a direct user tap.
 */
export async function showIOSSharePrompt(file, filename) {
    if (typeof document === 'undefined') return false;

    return new Promise((resolve) => {
        const existing = document.getElementById('iosBulkShareModal');
        if (existing) existing.remove();

        const backdrop = document.createElement('div');
        backdrop.id = 'iosBulkShareModal';
        backdrop.className = 'theme-modal-backdrop';
        backdrop.style.display = 'flex';
        backdrop.style.zIndex = '10050';

        const sizeStr = formatBytes(file.size);

        backdrop.innerHTML = `
          <div class="theme-modal-card p-4" style="max-width: 420px; width: 90%;">
            <div class="theme-modal-header d-flex align-items-center justify-content-between mb-3">
              <div class="d-flex align-items-center gap-2">
                <i class="bi-file-earmark-arrow-down text-primary fs-4"></i>
                <h3 class="theme-modal-title m-0" style="font-size: 17px; font-weight: 600; color: var(--ink);">Export ready</h3>
              </div>
              <button type="button" class="brand-btn theme-modal-close-btn p-1" id="iosBulkShareCloseBtn" aria-label="Close">
                <i class="bi-x-lg"></i>
              </button>
            </div>
            <div class="theme-modal-body mb-4">
              <p style="color: var(--ink2); font-size: 13.5px; margin-bottom: 12px;">Your export is ready to save to your iPhone or share:</p>
              <div style="background: var(--s2); border-radius: var(--r-control); padding: 10px 14px; color: var(--ink); font-weight: 500; font-size: 13.5px;" class="text-truncate">
                ${safeName(filename)} <span style="color: var(--ink2); font-weight: 400; font-size: 12px; margin-left: 6px;">(${sizeStr})</span>
              </div>
            </div>
            <div class="theme-modal-footer d-flex gap-2 justify-content-end">
              <button type="button" class="btn btn-theme-outline btn-sm px-3" id="iosBulkShareCancelBtn">Cancel</button>
              <button type="button" class="btn btn-theme-primary btn-sm px-3 d-flex align-items-center gap-2" id="iosBulkShareActionBtn">
                <i class="bi-share"></i> Save / Share
              </button>
            </div>
          </div>
        `;

        document.body.appendChild(backdrop);

        const cleanup = () => {
            backdrop.classList.add('is-closing');
            setTimeout(() => backdrop.remove(), 200);
        };

        backdrop.querySelector('#iosBulkShareCloseBtn')?.addEventListener('click', () => {
            cleanup();
            resolve(false);
        });
        backdrop.querySelector('#iosBulkShareCancelBtn')?.addEventListener('click', () => {
            cleanup();
            resolve(false);
        });

        backdrop.querySelector('#iosBulkShareActionBtn')?.addEventListener('click', async () => {
            // This click handler is a direct synchronous user interaction on iOS
            if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
                try {
                    let shareFile = file;
                    if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [shareFile] })) {
                        shareFile = new File([file], filename, { type: 'application/octet-stream' });
                    }
                    await navigator.share({
                        files: [shareFile],
                        title: filename
                    });
                    cleanup();
                    showToast(`Saved ${filename}`, 'success');
                    resolve(true);
                    return;
                } catch (err) {
                    if (err?.name === 'AbortError') {
                        cleanup();
                        resolve(false);
                        return;
                    }
                    console.warn('[BulkExport] Native share failed:', err);
                }
            }

            // Fallback for environments where share is not supported
            try {
                const url = URL.createObjectURL(file);
                window.open(url, '_blank');
                setTimeout(() => URL.revokeObjectURL(url), 60000);
                cleanup();
                resolve(true);
            } catch (e) {
                cleanup();
                resolve(false);
            }
        });
    });
}

/**
 * Handles exporting on iOS via the native system Share Sheet (Save to Files, AirDrop, etc.).
 */
export async function exportIOSFile(file, filename, { forcePrompt = false } = {}) {
    if (!forcePrompt && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        const canShare = typeof navigator.canShare === 'function' ? navigator.canShare({ files: [file] }) : true;
        if (canShare) {
            try {
                await navigator.share({ files: [file], title: filename });
                showToast(`Saved ${filename}`, 'success');
                return true;
            } catch (err) {
                if (err?.name === 'AbortError') return false;
                console.warn('[BulkExport] Direct share failed (gesture expired), opening prompt modal:', err);
            }
        }
    }

    return await showIOSSharePrompt(file, filename);
}

/**
 * Saves a Blob through the platform's appropriate channel:
 * - iOS: Web Share API (Save to Files / AirDrop) or synchronous share prompt modal
 * - Desktop Tauri: Native file save dialog
 * - Web / Android: Browser download link
 */
export async function saveOrDownloadBlob(blobOrFile, filename, { forcePrompt = false } = {}) {
    const mime = blobOrFile.type || getMimeType(filename);
    const file = (typeof File !== 'undefined' && blobOrFile instanceof File)
        ? blobOrFile
        : (typeof File !== 'undefined' ? new File([blobOrFile], filename, { type: mime }) : null);

    // 1. iOS device (iPhone, iPad): WebKit blocks <a download> for blobs. Use native Share Sheet.
    if (isIOSDevice() && file) {
        return await exportIOSFile(file, filename, { forcePrompt });
    }

    // 2. Desktop Tauri: Native file save dialog
    if (typeof window !== 'undefined' && window.__TAURI__?.dialog?.save && window.__TAURI__?.fs?.writeFile && !/Android/i.test(navigator.userAgent)) {
        try {
            const path = await window.__TAURI__.dialog.save({ defaultPath: filename });
            if (!path) return false;
            await window.__TAURI__.fs.writeFile(path, new Uint8Array(await blobOrFile.arrayBuffer()));
            showToast(`Saved to ${path}`, 'success');
            return true;
        } catch (e) {
            console.warn('[BulkExport] Native save failed, using browser download:', e);
        }
    }

    // 3. Fallback: browser download link
    if (typeof document === 'undefined') return false;

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blobOrFile);
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    showToast(`Exported ${filename}`, 'success');
    return true;
}
