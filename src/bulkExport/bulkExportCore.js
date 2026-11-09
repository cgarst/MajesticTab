// bulkExportCore.js
// Core export engines for MajesticTab:
// 1. Library metadata CSV (artist, album, song, youtube url, youtube backing url, sync data)
// 2. Original tab files (organized into folders as a ZIP archive)
// 3. PDF bulk export (condensed printable A4 pages via pdfProcessor and pdf-lib)

import { listRecords } from '../audioSync/syncStore.js';
import { listHistory } from '../audioSync/videoHistory.js';

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

/**
 * Exports library metadata as an RFC 4180 CSV string.
 * Columns: artist, album, song, youtube url, youtube backing url, sync data, tunings, tab_files, year
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
        'sync data',
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

        // 3. Audio sync data
        const syncRecords = [];
        const seenMedia = new Set();
        if (typeof listRecordsFn === 'function' && storage) {
            for (const k of candidateKeys) {
                const records = listRecordsFn(k, storage);
                for (const r of records) {
                    if (!r.points || !r.points.length) continue;
                    const mKey = r.media?.kind === 'youtube'
                        ? `yt_${r.media.videoId}`
                        : (r.media?.audioId ? `local_${r.media.audioId}` : null);
                    if (mKey && !seenMedia.has(mKey)) {
                        seenMedia.add(mKey);
                        syncRecords.push(r);
                    }
                }
            }
        }

        const syncDataStr = syncRecords.length > 0 ? JSON.stringify(syncRecords) : '';
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
            syncDataStr,
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
 * Ensures PDFLib is loaded in the window, injecting the CDN script if needed.
 */
export async function ensurePdfLib() {
    if (typeof window !== 'undefined' && window.PDFLib) return window.PDFLib;
    if (typeof globalThis !== 'undefined' && globalThis.PDFLib) return globalThis.PDFLib;

    if (typeof document === 'undefined') {
        throw new Error('PDFLib cannot be dynamically loaded in non-DOM environment');
    }

    return new Promise((resolve, reject) => {
        const existing = document.querySelector('script[src*="pdf-lib"]');
        if (existing) {
            existing.addEventListener('load', () => resolve(window.PDFLib));
            existing.addEventListener('error', () => reject(new Error('Failed to load PDFLib script')));
            return;
        }

        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
        script.onload = () => resolve(window.PDFLib);
        script.onerror = () => reject(new Error('Failed to load PDFLib script'));
        document.head.appendChild(script);
    });
}

/**
 * Re-lays out and condenses a single PDF into A4 pages using pdfProcessor and pdf-lib.
 * Returns Uint8Array of the resulting PDF file.
 */
export async function renderCondensedPdf({
    file,
    scale = 1.5,
    PDFLibModule,
    processPDFFn,
    onProgress,
    abortSignal
} = {}) {
    const PDFLib = PDFLibModule || (await ensurePdfLib());
    const condensedCanvases = [];
    const processFn = processPDFFn || (await import('../pdfProcessor/pdfProcessor.js')).processPDF;

    await processFn(file, {
        debugMode: { checked: false },
        originalMode: { checked: false },
        condensedCanvases,
        startPage: file.startPage,
        endPage: file.endPage,
        onCanvasRendered: () => {},
        onProgress: (pct, msg) => onProgress?.(pct, msg),
        abortSignal,
        scale
    });

    if (abortSignal?.aborted) return null;

    const pdfDoc = await PDFLib.PDFDocument.create();
    const A4_WIDTH = 595.276;
    const A4_HEIGHT = 841.890;
    const PAGE_MARGIN = 0;
    const TOP_MARGIN = 30;
    const SPACING = 5;

    let currentPage = null;
    let yOffset = A4_HEIGHT - TOP_MARGIN;

    for (let i = 0; i < condensedCanvases.length; i++) {
        if (abortSignal?.aborted) return null;
        const canvas = condensedCanvases[i];
        if (canvas._lazy?.index != null) {
            const { getActiveLazy } = await import('../pdfProcessor/lazyPages.js');
            await getActiveLazy()?.materialize(canvas._lazy.index);
        }

        const pngData = canvas.toDataURL('image/png');
        const pngImage = await pdfDoc.embedPng(pngData);

        const imgScale = (A4_WIDTH - 2 * PAGE_MARGIN) / pngImage.width;
        const scaledWidth = pngImage.width * imgScale;
        const scaledHeight = pngImage.height * imgScale;

        if (!currentPage || yOffset - scaledHeight < PAGE_MARGIN) {
            currentPage = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
            yOffset = A4_HEIGHT - TOP_MARGIN;
        }

        currentPage.drawImage(pngImage, {
            x: PAGE_MARGIN,
            y: yOffset - scaledHeight,
            width: scaledWidth,
            height: scaledHeight
        });

        yOffset -= (scaledHeight + SPACING);

        if (canvas._lazy?.index != null) {
            const { getActiveLazy } = await import('../pdfProcessor/lazyPages.js');
            getActiveLazy()?.release(canvas._lazy.index);
        }
    }

    const pdfBytes = await pdfDoc.save();
    return pdfBytes;
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
 * Saves a Blob through Tauri native dialog when available, else falls back to browser download.
 */
export async function saveOrDownloadBlob(blob, filename) {
    if (typeof window !== 'undefined' && window.__TAURI__?.dialog?.save && window.__TAURI__?.fs?.writeFile && !/Android/i.test(navigator.userAgent)) {
        try {
            const path = await window.__TAURI__.dialog.save({ defaultPath: filename });
            if (!path) return false;
            await window.__TAURI__.fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
            return true;
        } catch (e) {
            console.warn('[BulkExport] Native save failed, using browser download:', e);
        }
    }

    if (typeof document === 'undefined') return false;

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 15000);
    return true;
}
