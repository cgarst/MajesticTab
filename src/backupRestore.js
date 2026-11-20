// backupRestore.js
// Complete single-file Backup and Restore engine for MajesticTab.
// Bundles all settings, custom extensions, downloaded tabs local store, and library hierarchy.

import { collectAudioSync, mergeAudioSync, clearAudioSync, SYNC_CHANGED_EVENT } from './audioSync/syncStore.js';
import { recordStorage, flushSyncRecords } from './audioSync/syncRecordStore.js';
import { entryOf, planShrink, shrunkRestore, stemIsCopy, mediaKeyOf } from './audioSync/syncShrink.js';
import { clearAllAudioFiles } from './audioSync/audioFileStore.js';
import { isAudioChoiceKey, assignRestoredAudioSlot } from './audioSync/libraryAudio.js';
import { isRecordingMetaKey, listRecordingMeta } from './audioSync/recordingMeta.js';
import {
    AUDIO_BACKUP_STORE, iterateAudioBackupEntries, audioBackupPlan, audioBackupOverview, restoreAudioEntry,
    LARGE_AUDIO_UPLOAD_BYTES, SINGLE_FILE_AUDIO_LIMIT
} from './audioSync/audioBackup.js';
import {
    getDB, STORE_NAME, getAllStoredFiles, getStoredFileRecord, clearAllStoredFiles, saveStoredFile,
    arrayBufferToBase64, arrayBufferToBase64Async, base64ToArrayBuffer
} from './fileStore.js';
import {
    ensureDefaultCollection, getAllLibraryData, importLibraryData, clearAllLibraryData,
    reloadAllLibraryMetadata, songsMissingTrackNumber, findOrphanedStoredFiles, deleteOrphanedStoredFiles, getAllSongs, deleteSongFromLibrary, removeTabOptionFromSong, updateTabOptionOnSong, findSongHome, applySongHome, mergeSongInto
} from './libraryStore.js';
import { findMisfiledSongs } from './libraryMixedAlbums.js';
import { getAlbumTracks } from './musicbrainz.js';
import { findDuplicateSongs, findDuplicateTabs } from './libraryDuplicates.js';
import { findMissingTabFiles, findUnreachableTabs, songsWithUnstoredTabs } from './libraryMissingFiles.js';
import { isPackId } from './mpak.js';
import { findTabFiles, restoreTabFiles } from './unreachableRepair.js';
import { sha256 as sha256Bytes } from './mpak/core/index.js';
import { readLibraryAudio } from './audioSync/libraryAudio.js';
import { findPooledSongs, readRememberedKeys, readRebuildMarks, markPacksForRebuild } from './packRepair.js';
import { listAudioFiles } from './audioSync/audioFileStore.js';
import {
    getSaveProviders, saveToProvider, getPreferredStorage
} from './fileProviders.js';
import { showToast } from './utils/toast.js';
import { holdSync } from './autoSync.js';
import { isFolderBackupSupported } from './folderBackup.js';
import { isIcloudDriveSupported } from './icloudDrive.js';
import { refreshAppearance } from './themeEngine.js';
import { setGpDisplayScale } from './gpProcessor/gpProcessor.js';
import {
    STORAGE_KEY_SOUNDFONT_SELECTION, STORAGE_KEY_SOUNDFONT_ORDER, STORAGE_KEY_SOUNDFONT_STRICT, STORAGE_KEY_SOUNDFONT_FORCED, SOUNDFONT_BACKUP_STORE, listSoundFonts, clearAllSoundFonts,
    collectSoundFontBackupEntries, restoreSoundFontEntry
} from './soundFontStore.js';
import {
    CLASSTAB_BACKUP_STORE, collectClasstabBackupEntries, restoreClasstabEntry, listClasstab, deleteClasstab
} from './classtab/backup.js';

let modalElement = null;
let currentBackupFile = null;
let currentParsedBackup = null;
let activeGoogleAuthHandler = null;
let activeDriveAccountHandler = null;

let activeReloadState = {
    running: false,
    abortController: null,
    progress: {
        current: 0,
        total: 0,
        percent: 0,
        phase: '',
        name: '',
        stats: { addedDurations: 0, addedCovers: 0, updatedTunings: 0 }
    },
    listeners: new Set(),
    completionListeners: new Set()
};

const EXCLUDED_SETTINGS_KEYS = [
    'majestictab_theme',
    'majestictab_sheet_mode',
    'gpSheetScale',
    'gpNoteDensity',
    'theme',
    'majestictab_theme_sheet',
    'pageAdvancePages',
    'advanceOnePage',
    'landscapePageLayout',
    'gpDefaultView',
    'pdfDefaultView',
    'txtDefaultView',
    'condensePdfMode',
    'gpNotationMode',
    'majestictab_gp_notation_mode'
];

const BACKUP_SETTINGS_KEYS = [
    'debugMode',
    'majestictab_update_channel',
    'youtubeApiKey',
    'tab_downloader_sources', // legacy name, kept so older backups still restore
    'majestictab_tab_sources',
    'majestictab_tab_sources_deleted',
    'majestictab_classtab_pins', // pinned Classical tab composers and pieces, by name
    'majestictab_pinned_artists', // artists pinned in the library, by name (a pinned song is on its song record)
    'majestictab_custom_tuning_names',
    'gpDefaultStringsGuitar',
    'gpDefaultStringsBass',
    'instrumentMode',
    'majestictab_instrument_mode',
    STORAGE_KEY_SOUNDFONT_SELECTION,
    STORAGE_KEY_SOUNDFONT_ORDER,
    STORAGE_KEY_SOUNDFONT_STRICT,
    STORAGE_KEY_SOUNDFONT_FORCED
];

/**
 * Format bytes to readable string (e.g. 1.2 MB)
 */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatBytes(bytes, decimals = 1) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Escape HTML for safe rendering
 */
export function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Collect all application settings from localStorage
 */
export function collectAllSettings() {
    const settings = {};
    for (const key of BACKUP_SETTINGS_KEYS) {
        const val = localStorage.getItem(key);
        if (val !== null) {
            if (val.startsWith('{') || val.startsWith('[')) {
                try {
                    settings[key] = JSON.parse(val);
                } catch {
                    settings[key] = val;
                }
            } else {
                settings[key] = val;
            }
        }
    }

    // Collect any YouTube cached video IDs or custom user preferences
    const ytCache = {};
    const gpTabStrings = {};
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('yt_track_') || k.startsWith('yt_videos_') || isRecordingMetaKey(k) || isAudioChoiceKey(k))) {
            ytCache[k] = localStorage.getItem(k);
        } else if (k && k.startsWith('gp_tab_strings_')) {
            gpTabStrings[k] = localStorage.getItem(k);
        }
    }
    if (Object.keys(ytCache).length > 0) {
        settings.ytCache = ytCache;
    }
    if (Object.keys(gpTabStrings).length > 0) {
        settings.gpTabStrings = gpTabStrings;
    }
    const audioSync = collectAudioSync();
    if (Object.keys(audioSync).length > 0) {
        settings.audioSync = audioSync;
    }

    return settings;
}

/** Yields the backup JSON in pieces: header, one entry per stored tab, then soundfonts. */
async function* backupTextChunks(onProgress) {
    const [fileMetas, libraryData, soundFonts] = await Promise.all([
        getAllStoredFiles(),
        getAllLibraryData(),
        listSoundFonts()
    ]);
    const classtabEntries = await collectClasstabBackupEntries();

    const settings = collectAllSettings();
    // Audio files that fit in one file; larger ones belong in a snapshot or folder backup
    const audioPlan = await audioBackupPlan();

    const summary = {
        tabsCount: fileMetas.length,
        soundFontsCount: soundFonts.length + classtabEntries.length,
        audioCount: audioPlan.count,
        totalAudioSize: audioPlan.bytes,
        audioTooLargeCount: audioPlan.tooLarge.length,
        totalTabsSize: fileMetas.reduce((acc, f) => acc + (f.size || 0), 0),
        songsCount: libraryData.songs?.length || 0,
        collectionsCount: libraryData.collections?.length || 0,
        recentsCount: libraryData.recents?.length || 0
    };

    const header = {
        app: 'MajesticTab',
        format: 'majestictab_backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        summary,
        settings,
        library: libraryData
    };

    const headerJson = JSON.stringify(header);
    // Slice off closing '}' so we can append fileStore files array
    yield headerJson.slice(0, -1) + ',"fileStore":{"files":[';

    for (let i = 0; i < fileMetas.length; i++) {
        const meta = fileMetas[i];
        const record = await getStoredFileRecord(meta.id);
        let dataBase64 = '';
        if (record && record.data) {
            try {
                dataBase64 = await arrayBufferToBase64Async(record.data);
            } catch {
                dataBase64 = arrayBufferToBase64(record.data);
            }
        }

        const fileEntry = {
            id: meta.id,
            name: meta.name,
            type: meta.type || 'application/octet-stream',
            size: meta.size || (record?.data ? record.data.byteLength : 0),
            providerId: meta.providerId || 'local',
            metadata: meta.metadata || {},
            savedAt: meta.savedAt || Date.now(),
            lastModified: meta.lastModified || Date.now(),
            dataBase64
        };

        yield (i > 0 ? ',' : '') + JSON.stringify(fileEntry);

        if (typeof onProgress === 'function') {
            onProgress(i + 1, fileMetas.length);
        }
    }

    // Soundfonts ride in the same array, tagged with `store`, so restore stays streamable
    const soundFontEntries = await collectSoundFontBackupEntries();
    for (let i = 0; i < soundFontEntries.length; i++) {
        yield (fileMetas.length + i > 0 ? ',' : '') + JSON.stringify(soundFontEntries[i]);
        soundFontEntries[i].dataBase64 = null;
    }

    // The Classical tab archive, tagged `store: 'classtab'`
    for (let i = 0; i < classtabEntries.length; i++) {
        yield (fileMetas.length + soundFontEntries.length + i > 0 ? ',' : '') + JSON.stringify(classtabEntries[i]);
        classtabEntries[i].dataBase64 = null;
    }

    // Audio files too, one at a time, tagged `store: 'audio'`
    let written = fileMetas.length + soundFontEntries.length + classtabEntries.length;
    for await (const entry of iterateAudioBackupEntries()) {
        yield (written > 0 ? ',' : '') + JSON.stringify(entry);
        written++;
    }

    yield ']}}';
}

/**
 * Create a complete single-file backup bundle Blob without holding all binary data in memory simultaneously.
 * @param {function(current: number, total: number): void} [onProgress]
 * @param {object} [options]
 * @param {boolean} [options.compress=true] - Whether to compress with Gzip
 * @returns {Promise<Blob>} Complete backup bundle as Blob (compressed by default)
 */
export async function createBackupBlob(onProgress, { compress = true } = {}) {
    let blobParts = [];
    for await (const text of backupTextChunks(onProgress)) {
        blobParts.push(text);
        if (blobParts.length >= 16) blobParts = [new Blob(blobParts)];
    }
    const jsonBlob = new Blob(blobParts, { type: 'application/json' });
    if (compress) {
        // Stream through CompressionStream first: gzipSync needs the whole JSON as one
        // ArrayBuffer plus its output, which gets the iOS WebView killed on large libraries.
        if (typeof CompressionStream !== 'undefined') {
            try {
                const stream = jsonBlob.stream().pipeThrough(new CompressionStream('gzip'));
                return await new Response(stream).blob();
            } catch (e) {
                console.warn('[Backup] CompressionStream failed, trying fflate:', e);
            }
        }
        const fflateObj = (typeof window !== 'undefined' && window.fflate)
            ? window.fflate
            : (typeof globalThis !== 'undefined' && globalThis.fflate)
                ? globalThis.fflate
                : null;
        if (fflateObj?.gzipSync) {
            try {
                const arrayBuffer = await jsonBlob.arrayBuffer();
                const compressed = fflateObj.gzipSync(new Uint8Array(arrayBuffer));
                return new Blob([compressed], { type: 'application/gzip' });
            } catch (e) {
                console.warn('[Backup] fflate.gzipSync failed, using uncompressed JSON:', e);
            }
        }
    }
    return jsonBlob;
}

/**
 * Read backup file content as text, automatically decompressing if Gzip compressed.
 * @param {Blob|File} file - Backup file
 * @returns {Promise<string>} Uncompressed JSON text
 */
export async function readBackupFileText(file) {
    if (!file) throw new Error('No file provided');

    // Check first 2 bytes for GZIP magic number: 0x1F, 0x8B
    try {
        const slice = file.slice(0, 2);
        const headerBuffer = await slice.arrayBuffer();
        const bytes = new Uint8Array(headerBuffer);
        const isGzip = bytes.length >= 2 && bytes[0] === 0x1F && bytes[1] === 0x8B;

        if (isGzip) {
            // First prefer pure JS fflate if available (safe on iOS WKWebView where native stream decompression causes WebProcess crashes)
            const fflateObj = (typeof window !== 'undefined' && window.fflate)
                ? window.fflate
                : (typeof globalThis !== 'undefined' && globalThis.fflate)
                    ? globalThis.fflate
                    : null;

            if (fflateObj?.gunzipSync) {
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const decompressed = fflateObj.gunzipSync(new Uint8Array(arrayBuffer));
                    if (typeof fflateObj.strFromU8 === 'function') {
                        return fflateObj.strFromU8(decompressed);
                    }
                    return new TextDecoder('utf-8').decode(decompressed);
                } catch (syncErr) {
                    console.warn('[Restore] fflate.gunzipSync failed, trying async fallback:', syncErr);
                }
            }

            if (fflateObj?.gunzip) {
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const decompressed = await new Promise((resolve, reject) => {
                        fflateObj.gunzip(new Uint8Array(arrayBuffer), (err, result) => {
                            if (err) reject(err);
                            else resolve(result);
                        });
                    });
                    if (typeof fflateObj.strFromU8 === 'function') {
                        return fflateObj.strFromU8(decompressed);
                    }
                    return new TextDecoder('utf-8').decode(decompressed);
                } catch (asyncErr) {
                    console.warn('[Restore] fflate.gunzip failed:', asyncErr);
                }
            }

            if (typeof DecompressionStream !== 'undefined') {
                const rawStream = (typeof file.stream === 'function')
                    ? file.stream()
                    : new Response(file).body;

                if (rawStream) {
                    const decompressedStream = rawStream.pipeThrough(new DecompressionStream('gzip'));
                    const reader = decompressedStream.getReader();
                    const decoder = new TextDecoder('utf-8');
                    const chunks = [];
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(decoder.decode(value, { stream: true }));
                    }
                    chunks.push(decoder.decode());
                    return chunks.join('');
                }
            }
        }
    } catch (e) {
        console.warn('[Restore] Decompression attempt failed, falling back to raw text:', e);
    }
    try {
        if (typeof file.text === 'function') {
            return await file.text();
        }
        const buffer = await file.arrayBuffer();
        return new TextDecoder('utf-8').decode(buffer);
    } catch (_) {
        const buffer = await file.arrayBuffer();
        return new TextDecoder('utf-8').decode(buffer);
    }
}

/**
 * Inspect and validate a backup file / string / Blob
 * @param {string|object|Blob|File} fileContent
 * @returns {Promise<object>|object} Inspection summary
 */
export async function inspectBackupFile(fileContent) {
    if (fileContent instanceof Blob || (typeof File !== 'undefined' && fileContent instanceof File)) {
        return await inspectBackupBlob(fileContent);
    }
    return inspectBackupContentSync(fileContent);
}

function inspectBackupContentSync(fileContent) {
    let parsed;
    try {
        parsed = typeof fileContent === 'string' ? JSON.parse(fileContent) : fileContent;
    } catch (err) {
        return { valid: false, error: 'Invalid JSON format in backup file.' };
    }

    if (!parsed || typeof parsed !== 'object') {
        return { valid: false, error: 'Backup content is not a valid object.' };
    }

    // Support both MajesticTab full bundle and legacy fileStore backup
    const isFullBundle = parsed.format === 'majestictab_backup' || parsed.app === 'MajesticTab';
    const files = parsed.fileStore?.files || (Array.isArray(parsed.files) ? parsed.files : []);
    const songs = parsed.library?.songs || [];
    const collections = parsed.library?.collections || [];
    const settings = parsed.settings || {};

    let totalSize = parsed.summary?.totalTabsSize;
    if (totalSize === undefined) {
        totalSize = 0;
        for (const f of files) {
            totalSize += f.size || (f.dataBase64 ? Math.round(f.dataBase64.length * 0.75) : 0);
        }
    }

    let formattedDate = 'Unknown date';
    if (parsed.exportedAt) {
        try {
            const d = new Date(parsed.exportedAt);
            formattedDate = d.toLocaleString(undefined, {
                year: 'numeric', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
        } catch {}
    }

    return {
        valid: true,
        isFullBundle,
        exportedAt: formattedDate,
        rawExportedAt: parsed.exportedAt || null,
        tabsCount: files.filter(f => !f?.store).length,
        audioCount: files.filter(f => f?.store === AUDIO_BACKUP_STORE).length,
        audioBytes: files.filter(f => f?.store === AUDIO_BACKUP_STORE).reduce((acc, f) => acc + (f.size || 0), 0),
        totalTabsSize: totalSize,
        songsCount: songs.length,
        collectionsCount: collections.length,
        settingsCount: Object.keys(settings).length,
        data: parsed
    };
}

async function inspectBackupBlob(file) {
    if (!file) return { valid: false, error: 'No file provided.' };

    try {
        const slice = file.slice(0, 2);
        const headerBuf = await slice.arrayBuffer();
        const headerBytes = new Uint8Array(headerBuf);
        const isGzip = headerBytes.length >= 2 && headerBytes[0] === 0x1F && headerBytes[1] === 0x8B;

        let sampleText = '';
        if (isGzip) {
            const fflateObj = (typeof window !== 'undefined' && window.fflate)
                ? window.fflate
                : (typeof globalThis !== 'undefined' && globalThis.fflate)
                    ? globalThis.fflate
                    : null;

            if (fflateObj?.Gunzip) {
                // Decompress first 512 KB of compressed file
                const sampleSlice = file.slice(0, Math.min(512 * 1024, file.size));
                const compressedSample = await sampleSlice.arrayBuffer();
                let decompressedChunk = null;
                const gunzip = new fflateObj.Gunzip((chunk) => {
                    if (!decompressedChunk) decompressedChunk = chunk;
                });
                try {
                    gunzip.push(new Uint8Array(compressedSample), false);
                } catch (_) {}

                if (decompressedChunk) {
                    if (typeof fflateObj.strFromU8 === 'function') {
                        sampleText = fflateObj.strFromU8(decompressedChunk);
                    } else if (typeof TextDecoder !== 'undefined') {
                        sampleText = new TextDecoder('utf-8').decode(decompressedChunk);
                    }
                }
            }
        } else {
            // Uncompressed: read first 256 KB
            sampleText = await file.slice(0, Math.min(256 * 1024, file.size)).text();
        }

        if (sampleText) {
            const summaryMatch = sampleText.match(/"summary"\s*:\s*(\{[^}]+\})/);
            const dateMatch = sampleText.match(/"exportedAt"\s*:\s*"([^"]+)"/);

            if (summaryMatch) {
                try {
                    const summary = JSON.parse(summaryMatch[1]);
                    const rawExportedAt = dateMatch ? dateMatch[1] : null;
                    let formattedDate = 'Unknown date';
                    if (rawExportedAt) {
                        try {
                            const d = new Date(rawExportedAt);
                            formattedDate = d.toLocaleString(undefined, {
                                year: 'numeric', month: 'short', day: 'numeric',
                                hour: '2-digit', minute: '2-digit'
                            });
                        } catch {}
                    }
                    return {
                        valid: true,
                        isFullBundle: true,
                        exportedAt: formattedDate,
                        rawExportedAt,
                        tabsCount: summary.tabsCount ?? 0,
                        audioCount: summary.audioCount ?? 0,
                        audioBytes: summary.totalAudioSize ?? 0,
                        totalTabsSize: summary.totalTabsSize ?? 0,
                        songsCount: summary.songsCount ?? 0,
                        collectionsCount: summary.collectionsCount ?? 0,
                        file
                    };
                } catch (_) {}
            }
        }
    } catch (e) {
        console.warn('[inspectBackupBlob] Fast scan failed, falling back to full inspection:', e);
    }

    // Fallback: full read for legacy or small backups
    const text = await readBackupFileText(file);
    return inspectBackupContentSync(text);
}

export function applyRestoredSettings(settings, { wipe }) {
    let settingsApplied = 0;
    if (settings && typeof settings === 'object') {
        for (const [key, val] of Object.entries(settings)) {
            if (EXCLUDED_SETTINGS_KEYS.includes(key)) {
                continue;
            }

            if (key === 'ytCache' && typeof val === 'object') {
                for (const [ytKey, ytVal] of Object.entries(val)) {
                    if (wipe || localStorage.getItem(ytKey) === null) {
                        localStorage.setItem(ytKey, String(ytVal));
                    }
                }
                continue;
            }

            if (key === 'audioSync' && val && typeof val === 'object') {
                mergeAudioSync(val, { wipe });
                continue;
            }

            if (key === 'gpTabStrings' && typeof val === 'object') {
                for (const [tabKey, tabVal] of Object.entries(val)) {
                    if (wipe || localStorage.getItem(tabKey) === null) {
                        localStorage.setItem(tabKey, String(tabVal));
                    }
                }
                continue;
            }

            if (BACKUP_SETTINGS_KEYS.includes(key)) {
                const serialized = typeof val === 'object' ? JSON.stringify(val) : String(val);
                localStorage.setItem(key, serialized);
                settingsApplied++;
            }
        }
    }
    return settingsApplied;
}

/**
 * Restore a backup bundle with either 'merge' or 'wipe' mode
 * Supports File/Blob for ultra-low-memory streaming restore, or parsed object.
 * @param {object|Blob|File} bundleOrFile - Backup File/Blob or parsed bundle object
 * @param {object} options - { mode: 'merge' | 'wipe', onProgress?: function(current: number, total: number): void,
 *   } Audio is always restored with the rest
 * @returns {Promise<object>} Results of the restore operation
 */
export async function restoreBackup(bundleOrFile, options = {}) {
    if (!bundleOrFile) {
        throw new Error('Invalid backup bundle provided.');
    }
    // Auto-sync must not run against a half-restored library
    return holdSync(() => restoreBackupHeld(bundleOrFile, options));
}

async function restoreBackupHeld(bundleOrFile, { mode = 'merge', onProgress } = {}) {

    if (bundleOrFile instanceof Blob || (typeof File !== 'undefined' && bundleOrFile instanceof File)) {
        return await restoreBackupStream(bundleOrFile, { mode, onProgress });
    }

    const bundle = bundleOrFile.data || bundleOrFile;
    return await restoreBackupObject(bundle, { mode, onProgress });
}

export async function restoreBackupStream(file, { mode = 'merge', onProgress } = {}) {
    const wipe = mode === 'wipe';
    const db = await getDB();

    if (wipe) await wipeLibraryData();

    let filesImported = 0;
    let filesSkipped = 0;
    let soundFontsImported = 0;
    let audioImported = 0;
    let audioSkipped = 0;
    let libraryResults = { collectionsCount: 0, songsCount: 0, recentsCount: 0 };
    let extensionsImported = 0;
    let settingsApplied = 0;

    let buffer = '';
    let headerParsed = false;
    let inFiles = false;
    let totalFilesExpected = 0;

    const processBuffer = async () => {
        if (!headerParsed) {
            let filesIdx = buffer.indexOf('"fileStore":{"files":[');
            if (filesIdx === -1) filesIdx = buffer.indexOf('"files":[');
            if (filesIdx !== -1) {
                const arrayStart = buffer.indexOf('[', filesIdx);
                let headerJsonStr = buffer.slice(0, filesIdx).trim();
                if (headerJsonStr.endsWith(',')) headerJsonStr = headerJsonStr.slice(0, -1);
                headerJsonStr += '}';
                try {
                    const headerObj = JSON.parse(headerJsonStr);
                    headerParsed = true;
                    inFiles = true;
                    buffer = buffer.slice(arrayStart + 1);

                    totalFilesExpected = (headerObj.summary?.tabsCount || 0) + (headerObj.summary?.soundFontsCount || 0) + (headerObj.summary?.audioCount || 0);

                    if (headerObj.library && typeof headerObj.library === 'object') {
                        libraryResults = await importLibraryData(headerObj.library, { wipe });
                    }

                    if (headerObj.settings && typeof headerObj.settings === 'object') {
                        settingsApplied = applyRestoredSettings(headerObj.settings, { wipe });
                    }
                } catch (e) {
                    // Header might still be buffering across chunk boundary
                }
            }
        }

        if (inFiles) {
            while (buffer.length > 0) {
                let startIdx = 0;
                while (startIdx < buffer.length && (buffer[startIdx] === ' ' || buffer[startIdx] === '\n' || buffer[startIdx] === '\r' || buffer[startIdx] === '\t' || buffer[startIdx] === ',')) {
                    startIdx++;
                }
                if (startIdx > 0) buffer = buffer.slice(startIdx);

                if (buffer.length === 0 || buffer[0] === ']') break;
                if (buffer[0] !== '{') break;

                let depth = 0;
                let inStr = false;
                let esc = false;
                let endIdx = -1;

                for (let j = 0; j < buffer.length; j++) {
                    const c = buffer[j];
                    if (esc) {
                        esc = false;
                        continue;
                    }
                    if (c === '\\') {
                        esc = true;
                        continue;
                    }
                    if (c === '"') {
                        inStr = !inStr;
                        continue;
                    }
                    if (!inStr) {
                        if (c === '{') depth++;
                        else if (c === '}') {
                            depth--;
                            if (depth === 0) {
                                endIdx = j;
                                break;
                            }
                        }
                    }
                }

                if (endIdx !== -1) {
                    const fileJson = buffer.slice(0, endIdx + 1);
                    buffer = buffer.slice(endIdx + 1);
                    const item = JSON.parse(fileJson);

                    if (item && item.store === AUDIO_BACKUP_STORE) {
                        if (item.id && item.name && item.dataBase64 && await restoreAudioEntry(item, { wipe })) audioImported++;
                        else audioSkipped++;
                        if (typeof onProgress === 'function') {
                            onProgress(filesImported + filesSkipped + soundFontsImported + audioImported + audioSkipped, totalFilesExpected);
                        }
                    } else if (item && item.store === CLASSTAB_BACKUP_STORE && item.dataBase64) {
                        if (await restoreClasstabEntry(item, { wipe })) soundFontsImported++;
                        else filesSkipped++;
                        if (typeof onProgress === 'function') {
                            onProgress(filesImported + filesSkipped + soundFontsImported, totalFilesExpected);
                        }
                    } else if (item && item.store === SOUNDFONT_BACKUP_STORE && item.id && item.name && item.dataBase64) {
                        if (await restoreSoundFontEntry(item, { wipe })) soundFontsImported++;
                        else filesSkipped++;
                        if (typeof onProgress === 'function') {
                            onProgress(filesImported + filesSkipped + soundFontsImported, totalFilesExpected);
                        }
                    } else if (item && item.id && item.name && item.dataBase64) {
                        const arrayBuffer = base64ToArrayBuffer(item.dataBase64);
                        item.dataBase64 = null;

                        const record = {
                            id: item.id,
                            name: item.name,
                            type: item.type || 'application/octet-stream',
                            size: item.size || arrayBuffer.byteLength,
                            providerId: item.providerId || 'imported',
                            metadata: item.metadata || {},
                            data: arrayBuffer,
                            savedAt: item.savedAt || Date.now(),
                            lastModified: item.lastModified || Date.now()
                        };

                        await new Promise((resolve, reject) => {
                            const tx = db.transaction(STORE_NAME, 'readwrite');
                            const store = tx.objectStore(STORE_NAME);

                            if (wipe) {
                                const req = store.put(record);
                                req.onsuccess = () => { filesImported++; resolve(); };
                                req.onerror = () => reject(req.error);
                            } else {
                                const checkReq = store.get(item.id);
                                checkReq.onsuccess = () => {
                                    if (!checkReq.result) {
                                        const putReq = store.put(record);
                                        putReq.onsuccess = () => { filesImported++; resolve(); };
                                        putReq.onerror = () => reject(putReq.error);
                                    } else {
                                        filesSkipped++;
                                        resolve();
                                    }
                                };
                                checkReq.onerror = () => reject(checkReq.error);
                            }
                        });

                        if (typeof onProgress === 'function') {
                            onProgress(filesImported + filesSkipped + soundFontsImported, totalFilesExpected);
                        }
                    }
                } else {
                    break;
                }
            }
        }
    };

    if (isGzip && fflateObj?.Gunzip) {
        const gunzip = new fflateObj.Gunzip((chunk) => {
            const text = (typeof fflateObj.strFromU8 === 'function')
                ? fflateObj.strFromU8(chunk)
                : new TextDecoder('utf-8').decode(chunk);
            buffer += text;
        });

        const sliceSize = 1024 * 1024;
        for (let offset = 0; offset < file.size; offset += sliceSize) {
            const slice = file.slice(offset, Math.min(offset + sliceSize, file.size));
            const buf = await slice.arrayBuffer();
            gunzip.push(new Uint8Array(buf), offset + sliceSize >= file.size);
            await processBuffer();
            if (offset % (2 * sliceSize) === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }
    } else {
        const sliceSize = 512 * 1024;
        for (let offset = 0; offset < file.size; offset += sliceSize) {
            const slice = file.slice(offset, Math.min(offset + sliceSize, file.size));
            const textChunk = await slice.text();
            buffer += textChunk;
            await processBuffer();
            if (offset % (2 * sliceSize) === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }
    }

    if (!headerParsed) {
        // Fallback for non-standard legacy format
        const text = await readBackupFileText(file);
        const parsed = JSON.parse(text);
        return await restoreBackupObject(parsed, { mode, onProgress });
    }

    applyRestoredPreferences();

    return {
        mode,
        filesImported,
        filesSkipped,
        soundFontsImported,
        audioImported,
        audioSkipped,
        collectionsImported: libraryResults.collectionsCount,
        songsImported: libraryResults.songsCount,
        recentsCount: libraryResults.recentsCount,
        settingsApplied
    };
}

/** Empties tabs, SoundFonts, audio, the library and the backed-up settings, ready for a restore in wipe mode. */
export function wipeLibraryData() {
    return holdSync(wipeLibraryDataHeld);
}

async function wipeLibraryDataHeld() {
    await clearAllStoredFiles();
    await clearAllSoundFonts();
    await clearAllAudioFiles();
    await clearAllLibraryData();

    for (const key of BACKUP_SETTINGS_KEYS) {
        localStorage.removeItem(key);
    }
    localStorage.removeItem('customExtensions');

    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('yt_track_') || k.startsWith('yt_videos_') || isRecordingMetaKey(k) || isAudioChoiceKey(k))) keysToRemove.push(k);
    }
    for (const k of keysToRemove) localStorage.removeItem(k);
    clearAudioSync();
}

async function restoreBackupObject(bundle, { mode = 'merge', onProgress } = {}) {
    const wipe = mode === 'wipe';
    const db = await getDB();

    if (wipe) {
        await clearAllStoredFiles();
        await clearAllSoundFonts();
        await clearAllAudioFiles();
        await clearAllLibraryData();

        for (const key of BACKUP_SETTINGS_KEYS) {
            localStorage.removeItem(key);
        }
        localStorage.removeItem('customExtensions');

        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && (k.startsWith('yt_track_') || k.startsWith('yt_videos_') || isRecordingMetaKey(k) || isAudioChoiceKey(k))) keysToRemove.push(k);
        }
        for (const k of keysToRemove) localStorage.removeItem(k);
        clearAudioSync();
    }

    let filesImported = 0;
    let filesSkipped = 0;
    let soundFontsImported = 0;
    let audioImported = 0;
    let audioSkipped = 0;
    const restoredAudio = [];

    const files = bundle.fileStore?.files || (Array.isArray(bundle.files) ? bundle.files : []);
    const totalFiles = files.length;
    // Lazy (Drive blob) items are only downloaded when the tab isn't already on this device
    const existingFileIds = wipe ? new Set() : new Set((await getAllStoredFiles()).map(f => f.id));
    for (let i = 0; i < totalFiles; i++) {
        const item = files[i];
        if (!item || !item.id || !item.name || !(item.dataBase64 || item.fetchData)) continue;

        if (typeof onProgress === 'function') {
            onProgress(i + 1, totalFiles);
        }

        if (i > 0 && i % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (item.store === AUDIO_BACKUP_STORE) {
            // The slot choices come with the settings below; only a backup without them is guessed from the names
            if (await restoreAudioEntry(item, { wipe, guessSlot: false })) audioImported++;
            else audioSkipped++;
            restoredAudio.push(item);
            continue;
        }

        if (item.store === CLASSTAB_BACKUP_STORE) {
            if (await restoreClasstabEntry(item, { wipe })) soundFontsImported++;
            else filesSkipped++;
            continue;
        }

        if (item.store === SOUNDFONT_BACKUP_STORE) {
            if (await restoreSoundFontEntry(item, { wipe })) soundFontsImported++;
            else filesSkipped++;
            continue;
        }

        if (item.fetchData && existingFileIds.has(item.id)) {
            filesSkipped++;
            continue;
        }

        const arrayBuffer = item.fetchData ? await item.fetchData() : base64ToArrayBuffer(item.dataBase64);
        item.dataBase64 = null;

        const record = {
            id: item.id,
            name: item.name,
            type: item.type || 'application/octet-stream',
            size: item.size || arrayBuffer.byteLength,
            providerId: item.providerId || 'imported',
            metadata: item.metadata || {},
            data: arrayBuffer,
            savedAt: item.savedAt || Date.now(),
            lastModified: item.lastModified || Date.now()
        };

        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);

            if (wipe) {
                const req = store.put(record);
                req.onsuccess = () => { filesImported++; resolve(); };
                req.onerror = () => reject(req.error);
            } else {
                const checkReq = store.get(item.id);
                checkReq.onsuccess = () => {
                    if (!checkReq.result) {
                        const putReq = store.put(record);
                        putReq.onsuccess = () => { filesImported++; resolve(); };
                        putReq.onerror = () => reject(putReq.error);
                    } else {
                        filesSkipped++;
                        resolve();
                    }
                };
                checkReq.onerror = () => reject(checkReq.error);
            }
        });
    }

    let libraryResults = { collectionsCount: 0, songsCount: 0, recentsCount: 0 };
    if (bundle.library && typeof bundle.library === 'object') {
        libraryResults = await importLibraryData(bundle.library, { wipe });
    }

    let settingsApplied = 0;
    if (bundle.settings && typeof bundle.settings === 'object') {
        settingsApplied = applyRestoredSettings(bundle.settings, { wipe });
        if (!Object.keys(bundle.settings?.ytCache || {}).some(isAudioChoiceKey)) restoredAudio.forEach(assignRestoredAudioSlot);
    }

    applyRestoredPreferences();

    return {
        mode,
        filesImported,
        filesSkipped,
        soundFontsImported,
        audioImported,
        audioSkipped,
        collectionsImported: libraryResults.collectionsCount,
        songsImported: libraryResults.songsCount,
        recentsCount: libraryResults.recentsCount,
        settingsApplied
    };
}

/**
 * Completely delete all local application data, tabs, library, custom extensions, and settings.
 */
export function deleteAllAppData() {
    return holdSync(deleteAllAppDataHeld);
}

async function deleteAllAppDataHeld() {
    // 1. Wipe IndexedDB stored files and library
    await clearAllStoredFiles();
    await clearAllSoundFonts();
    await deleteClasstab();
    await clearAllAudioFiles();
    await clearAllLibraryData();
    await ensureDefaultCollection();

    // 2. Wipe settings and extensions from localStorage (keeping theme and viewing preferences intact)
    for (const key of BACKUP_SETTINGS_KEYS) {
        localStorage.removeItem(key);
    }
    localStorage.removeItem('customExtensions');

    // 3. Wipe caches
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && ((k.startsWith('yt_track_') || k.startsWith('yt_videos_') || isRecordingMetaKey(k)) || k.startsWith('tab_downloader_') || isAudioChoiceKey(k))) {
            keysToRemove.push(k);
        }
    }
    for (const k of keysToRemove) localStorage.removeItem(k);
    clearAudioSync();

    // 4. Reset UI preferences to defaults
    applyRestoredPreferences();
}

/**
 * Clear cached data including persistent album artwork, MusicBrainz queries,
 * YouTube caches, and tab downloader search caches.
 * @returns {Promise<number>} Number of cache items removed
 */
export async function clearAppCache() {
    const { clearArtCache, clearMusicBrainzAnswers } = await import('./musicbrainz.js');
    let totalCleared = await clearArtCache();
    await clearMusicBrainzAnswers();

    // Clear YouTube caches from localStorage
    try {
        const ytKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && (k.startsWith('yt_track_') || k.startsWith('yt_videos_'))) ytKeys.push(k);
        }
        totalCleared += ytKeys.length;
        ytKeys.forEach(k => localStorage.removeItem(k));
    } catch (_) {}

    // Clear tab downloader caches from localStorage
    try {
        const tdKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('tab_downloader_')) tdKeys.push(k);
        }
        totalCleared += tdKeys.length;
        tdKeys.forEach(k => localStorage.removeItem(k));
    } catch (_) {}

    return totalCleared;
}

/**
 * Apply restored preferences to active DOM and modules
 */
export function applyRestoredPreferences() {
    // Theme
    // The restored values are already saved; this applies whichever the current entitlement allows.
    refreshAppearance();

    // GP Scale
    const scaleStr = localStorage.getItem('gpSheetScale');
    if (scaleStr) {
        const scaleVal = parseInt(scaleStr, 10) || 100;
        setGpDisplayScale(scaleVal);
        const scaleInput = document.getElementById('gpSheetScale');
        const scaleValue = document.getElementById('gpSheetScaleValue');
        if (scaleInput) scaleInput.value = String(scaleVal);
        if (scaleValue) scaleValue.textContent = `${scaleVal}%`;
    }

    // View modes
    const gpDefault = localStorage.getItem('gpDefaultView');
    if (gpDefault) {
        const radio = document.querySelector(`input[name="gpDefaultViewRadio"][value="${gpDefault}"]`);
        if (radio) radio.checked = true;
    }

    const pdfDefault = localStorage.getItem('pdfDefaultView');
    if (pdfDefault) {
        const radio = document.querySelector(`input[name="pdfDefaultViewRadio"][value="${pdfDefault}"]`);
        if (radio) radio.checked = true;
    }

    const txtDefault = localStorage.getItem('txtDefaultView');
    if (txtDefault) {
        const radio = document.querySelector(`input[name="txtDefaultViewRadio"][value="${txtDefault}"]`);
        if (radio) radio.checked = true;
    }

    const pageAdvance = localStorage.getItem('pageAdvancePages');
    if (pageAdvance) {
        const radio = document.querySelector(`input[name="pageAdvanceRadio"][value="${pageAdvance}"]`);
        if (radio) radio.checked = true;
    }

    const landscapeLayout = localStorage.getItem('landscapePageLayout');
    if (landscapeLayout) {
        const radio = document.querySelector(`input[name="landscapePageLayoutRadio"][value="${landscapeLayout}"]`);
        if (radio) radio.checked = true;
    }

    const debugMode = document.getElementById('debugMode');
    if (debugMode) {
        import('./utils/debugBuild.js').then((m) => m.applyDebugOverlaySetting());
    }

    const condensePdfMode = document.getElementById('condensePdfMode');
    if (condensePdfMode) {
        condensePdfMode.checked = localStorage.getItem('condensePdfMode') === 'true';
    }

    // Update channel
    const updateChannel = localStorage.getItem('majestictab_update_channel');
    if (updateChannel) {
        const radio = document.querySelector(`input[name="updateChannelRadio"][value="${updateChannel}"]`);
        if (radio) radio.checked = true;
    }

    // Instrument mode
    const instMode = localStorage.getItem('instrumentMode') || localStorage.getItem('majestictab_instrument_mode') || 'guitar';
    const instRadio = document.querySelector(`input[name="instrumentModeRadio"][value="${instMode}"]`);
    if (instRadio) instRadio.checked = true;

    // String count defaults
    const guitarDefault = localStorage.getItem('gpDefaultStringsGuitar');
    if (guitarDefault) {
        const radio = document.querySelector(`input[name="gpDefaultStringsGuitarRadio"][value="${guitarDefault}"]`);
        if (radio) radio.checked = true;
    }
    const bassDefault = localStorage.getItem('gpDefaultStringsBass');
    if (bassDefault) {
        const radio = document.querySelector(`input[name="gpDefaultStringsBassRadio"][value="${bassDefault}"]`);
        if (radio) radio.checked = true;
    }
}

/**
 * Creates or gets the Backup Modal DOM element
 */
function getOrCreateModal() {
    if (modalElement && document.body.contains(modalElement)) {
        return modalElement;
    }

    let modal = document.getElementById('backupModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'backupModal';
        modal.className = 'theme-modal-backdrop';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', 'Data management');
        document.body.appendChild(modal);
    }
    modalElement = modal;
    return modal;
}


/** The slot under a data task's row on the Settings page. Opens the library first when its navigation is not on screen. */
export async function getSettingsDataHost(tab) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!document.getElementById('libraryNavSettingsBtn')) {
        const { openLibraryModal } = await import('./libraryModal.js');
        await openLibraryModal();
        for (let i = 0; i < 30 && !document.getElementById('libraryNavSettingsBtn'); i++) await wait(100);
    }
    const navBtn = document.getElementById('libraryNavSettingsBtn');
    if (!navBtn) return null;
    if (!document.querySelector('#libraryModalContent .setshell.settings-page')) {
        navBtn.click();
        await wait(450);
    }
    // The sync task is in Cloud sync; every other data task is in Data management
    const sectionId = tab === 'sync' ? 'cloud' : 'library';
    for (let i = 0; i < 30 && !document.querySelector(`.setnav [data-section="${sectionId}"]`); i++) await wait(100);
    const section = document.querySelector(`.setnav [data-section="${sectionId}"]`);
    if (section && section.getAttribute('aria-current') !== 'true') section.click();
    return document.querySelector(`.data-task-slot[data-task="${tab}"]`);
}

export function setTaskOpenState(openTab) {
    // One task is open at a time; the sync task lives in its own module and closes itself
    if (openTab !== 'sync') window.dispatchEvent(new CustomEvent('dataTaskOpened', { detail: { task: openTab } }));
    document.querySelectorAll('.data-task-slot').forEach((slot) => {
        const open = slot.dataset.task === openTab;
        slot.hidden = !open;
        slot.previousElementSibling?.querySelector('button[aria-expanded]')?.setAttribute('aria-expanded', String(open));
        const btn = slot.previousElementSibling?.querySelector('button[aria-expanded]');
        if (btn) btn.textContent = open ? 'Close' : (btn.dataset.label || 'Open');
    });
}

async function mountBackupInSettings(host, tab, options) {
    const modal = getOrCreateModal();
    modal.classList.add('is-embedded', 'tool-embedded');
    modal.style.display = 'block';
    setTaskOpenState(tab);
    // Open at once; the screen's counts take a moment to read, so say so instead of showing an empty row
    modal.innerHTML = `<div class="task-status">${waitingHtml('Loading…')}</div>`;
    host.appendChild(modal);
    await renderModal(modal, tab, options);
}

/** Collapses the open data task in Settings and puts the modal element back out of the way. */
function leaveEmbeddedBackup() {
    const modal = modalElement;
    if (!modal?.classList.contains('is-embedded')) return false;
    modal.classList.remove('is-embedded', 'tool-embedded');
    modal.style.display = 'none';
    document.body.appendChild(modal);
    setTaskOpenState(null);
    return true;
}

/**
 * Open the Data Management modal
 * @param {'backup'|'restore'|'reload'|'orphans'|'duplicates'|'mixedalbums'|'dupetabs'|'missing'|'syncshrink'|'rebuild'|'cache'|'delete'} initialTab
 */
export async function openBackupModal(initialTab = 'backup', options = {}) {
    // Data management lives in Settings, on the Data management page. There is no popup.
    const host = await getSettingsDataHost(initialTab);
    if (host) return mountBackupInSettings(host, initialTab, options);
    console.warn('[Data] Settings is not available; cannot open', initialTab);
}

/**
 * Close the Data Management modal
 */
export function closeBackupModal() {
    leaveEmbeddedBackup();
    currentBackupFile = null;
    currentParsedBackup = null;
    if (activeGoogleAuthHandler) {
        window.removeEventListener('googleAuthSuccess', activeGoogleAuthHandler);
        activeGoogleAuthHandler = null;
    }
    if (activeDriveAccountHandler) {
        window.removeEventListener('googleAuthChanged', activeDriveAccountHandler);
        activeDriveAccountHandler = null;
    }
    activeReloadState.listeners.clear();
    activeReloadState.completionListeners.clear();
}

/** One count tile of the backup/restore change summaries. */
function changeStatHtml(n, label, cls) {
    return `<div class="col-6 col-md-3"><div class="p-2 rounded-2 backup-stat-card"><div class="fw-bold fs-6 ${n ? cls : 'text-white-50'}">${n}</div><div class="text-white-50" style="font-size:0.72rem;">${label}</div></div></div>`;
}

/** The flat progress component with no known amount, for places that fill in later by innerHTML. */
function waitingHtml(label) {
    const text = escapeHtml(label);
    return `<div class="task-progress"><div class="task-progress-text"><span class="task-progress-label">${text}</span></div>`
        + `<div class="task-progress-track is-indeterminate" role="progressbar" aria-label="${text}"><div class="task-progress-fill"></div></div></div>`;
}

/**
 * Flat progress inside a status element (styled by .task-progress in design.css). `value` is 0 to 100, or null
 * while the amount is unknown, which shows a moving segment instead of a fill. The element is the one place a
 * task reports on itself, so a result replaces the progress where it was.
 */
function showTaskProgress(el, { label, detail = '', value = null }) {
    if (!el) return;
    if (!el.querySelector(':scope > .task-progress')) {
        el.innerHTML = '<div class="task-progress"><div class="task-progress-text"><span class="task-progress-label"></span><span class="task-progress-detail"></span></div>'
            + '<div class="task-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="task-progress-fill"></div></div></div>';
    }
    el.style.display = 'block';
    el.className = 'task-status';
    el.setAttribute('role', 'status');
    const box = el.querySelector('.task-progress');
    const track = box.querySelector('.task-progress-track');
    box.querySelector('.task-progress-label').textContent = label;
    box.querySelector('.task-progress-detail').textContent = detail;
    const known = typeof value === 'number';
    const pct = known ? Math.max(0, Math.min(100, value)) : 0;
    track.classList.toggle('is-indeterminate', !known);
    track.setAttribute('aria-label', label);
    if (known) track.setAttribute('aria-valuenow', String(Math.round(pct)));
    else track.removeAttribute('aria-valuenow');
    box.querySelector('.task-progress-fill').style.transform = known ? `scaleX(${pct / 100})` : '';
}

/** A finished task's outcome, in the same place the progress was. kind: 'done' | 'warn' | 'error'. */
function showTaskResult(el, kind, content, { html = false } = {}) {
    if (!el) return;
    el.style.display = 'block';
    el.className = `task-status task-status-${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    if (html) el.innerHTML = content;
    else el.textContent = content;
}

/** Hides a status element and clears what it showed. */
function clearTaskStatus(el) {
    if (!el) return;
    el.style.display = 'none';
    el.className = 'task-status';
    el.textContent = '';
}

/**
 * Renders the Data Management Modal content
 */
async function renderModal(modal, activeTab = 'backup', options = {}) {
    const providers = getSaveProviders();
    const today = new Date().toISOString().split('T')[0];
    const defaultFilename = `MajesticTab-backup-${today}.mtbackup`;

    // Live counts for backup / reload / delete summary
    const [storedFiles, libraryData] = await Promise.all([
        getAllStoredFiles(),
        getAllLibraryData()
    ]);
    const tabsTotalSize = storedFiles.reduce((acc, f) => acc + (f.size || 0), 0);

    const songsMissingDuration = (libraryData.songs || []).filter(s => !s.length || s.length <= 0).length;
    const songsMissingCover = (libraryData.songs || []).filter(s => !s.coverUrl || s.coverUrl.includes('data:image/svg+xml')).length;
    const songsMissingTracks = songsMissingTrackNumber(libraryData.songs).length;
    const uniqueAlbumsCount = new Set((libraryData.songs || []).map(s => `${(s.artist || '').toLowerCase().trim()}:::${(s.album || '').toLowerCase().trim()}`).filter(Boolean)).size;

    // A backup is a file the user keeps; it defaults to this device and is independent of the location chosen for Sync
    const wanted = options.provider || 'local';
    const preferredProviderId = providers.some(p => p.id === wanted) ? wanted : providers[0]?.id;

    modal.innerHTML = `
    <div class="theme-modal-card backup-modal-card">
      <!-- Linked Google account (shown only while connected) -->
      <!-- @googleDrive:begin -->
      <div id="driveAccountRow" class="px-3 pt-2 d-none align-items-center justify-content-between gap-2">
        <span class="small text-white-50 text-truncate"><i class="icon-gdrive me-1"></i> Google Drive is connected on this device</span>
        <button type="button" class="btn btn-sm btn-theme-outline px-2 py-1 flex-shrink-0" id="driveDisconnectBtn" style="font-size:0.72rem;">
          <i class="bi-box-arrow-right me-1"></i> Disconnect
        </button>
      </div>
      <!-- @googleDrive:end -->

      <!-- Modal Body -->
      <div class="theme-modal-body p-3">
        <!-- TAB 1: CREATE BACKUP -->
        <div id="backupTabContent" style="display: ${activeTab === 'backup' ? 'block' : 'none'};">
          <!-- Bundle Contents Overview -->
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2">In this backup</div>
            <div class="text-white-50 small">
              <span class="text-white fw-medium">${libraryData.songs?.length || 0}</span> songs · <span class="text-white fw-medium">${storedFiles.length}</span> tabs (${formatBytes(tabsTotalSize)}) · setlists and app settings
            </div>
            <div class="text-white-50 small mt-1" style="font-size: 0.75rem;">One .mtbackup file. Each song is a standard .mpak inside it, with its recordings and sync points.</div>
            <div class="text-white-50 small mt-2" id="backupLastLine" style="font-size: 0.75rem;"></div>
          </div>

          <!-- Filename -->
          <div class="mb-3" id="backupFilenameGroup">
            <label class="form-label small fw-semibold text-white-50 mb-1" for="backupFilenameInput">Filename</label>
            <input type="text" class="form-control form-control-sm" id="backupFilenameInput" value="${escapeHtml(defaultFilename)}">
          </div>

          <!-- Where the file goes: one button per save destination, matching Restore -->
          <div class="mb-3">
            <div class="small fw-semibold text-white-50 mb-2">Save backup</div>
            <div class="d-flex align-items-center gap-2 flex-wrap" id="backupProviderButtons">
              ${providers.map((p) => {
                  const label = p.id === 'local' ? 'To file…'
                      : p.id === 's3' ? 'To S3 bucket'
                      : p.id === 'webdav' ? 'To WebDAV'
                      : p.id === 'google-drive' ? 'To Google Drive'
                      : p.id === 'icloud-drive' ? 'To iCloud Drive'
                      : `To ${p.name}`;
                  return `<button type="button" class="btn btn-sm btn-theme-outline px-3" data-backup-provider="${escapeHtml(p.id)}" data-provider-name="${escapeHtml(p.name)}">${escapeHtml(label)}</button>`;
              }).join('')}
            </div>
          </div>

          <!-- Status / Action -->
          <div id="backupStatusAlert" class="small mb-2" style="display:none;" role="status"></div>

          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="backupCancelBtn">Cancel</button>
          </div>
        </div>

        <!-- TAB 2: RESTORE BACKUP -->
        <div id="restoreTabContent" style="display: ${activeTab === 'restore' ? 'block' : 'none'};">
          <!-- Step 1: File Picker / Dropzone -->
          <div class="backup-dropzone p-4 rounded-3 text-center mb-3" id="restoreDropzone">
            <input type="file" id="restoreFileInput" accept=".mtbackup" class="d-none">
            <div class="fw-semibold text-white small mb-1">Restore from a backup file</div>
            <div class="text-white-50 mb-3" style="font-size: 0.74rem;">Open a .mtbackup file<span class="restore-drop-hint"> (you can also drop one here)</span>. Snapshots made by older versions in Google Drive, an S3 bucket, a WebDAV server or a backup folder can still be restored from the buttons below.</div>
            <div class="d-flex justify-content-center align-items-center gap-2 flex-wrap">
              <button type="button" class="btn btn-sm btn-theme-outline px-3" id="restoreBrowseBtn">
                <span>From file…</span>
              </button>
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-none" id="restoreFolderBtn">
                <span>From local folder</span>
              </button>
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-none" id="restoreIcloudBtn">
                <span>From iCloud Drive</span>
              </button>
              <button type="button" class="btn btn-sm btn-theme-outline px-3" id="restoreS3Btn">
                <span>From S3 bucket</span>
              </button>
              <button type="button" class="btn btn-sm btn-theme-outline px-3" id="restoreWebDavBtn">
                <span>From WebDAV</span>
              </button>
              <!-- @googleDrive:begin -->
              <button type="button" class="btn btn-sm btn-theme-outline px-3" id="restoreDriveBtn">
                <span>From Google Drive</span>
              </button>
              <!-- @googleDrive:end -->
            </div>

            <!-- Inline Google Drive Backup Selector -->
            <div id="restoreDriveContainer" class="mt-3 pt-3 text-start" style="display: none;">
              <div class="d-flex align-items-center justify-content-between mb-2">
                <span class="small fw-semibold text-white d-flex align-items-center gap-1">
                  <span id="restoreSourceTitle">Backups</span>
                </span>
                <div class="d-flex align-items-center gap-2">
                  <button type="button" class="btn btn-sm btn-link p-0 text-white-50 text-decoration-none" id="restoreDriveCloseBtn" title="Close" aria-label="Close backups">
                    <i class="bi-x-lg"></i>
                  </button>
                </div>
              </div>
              <div class="d-flex align-items-center justify-content-between gap-2 mb-2">
                <span class="text-white-50 text-truncate" id="restoreSourceLocation" style="font-size: 0.72rem;"></span>
                <button type="button" class="btn btn-sm btn-theme-outline px-2 py-1 flex-shrink-0" id="restoreChangeLocationBtn" style="font-size: 0.72rem;">Change</button>
                <!-- @googleDrive:begin -->
                <button type="button" class="btn btn-sm btn-theme-outline px-2 py-1 flex-shrink-0 d-none" id="restoreDrivePickBtn" style="font-size: 0.72rem;">Pick a different file…</button>
                <!-- @googleDrive:end -->
              </div>
              <div id="restoreDriveLoading" class="py-3" style="display: none;">
                <div class="task-progress"><div class="task-progress-text"><span class="task-progress-label">Looking for backups…</span></div><div class="task-progress-track is-indeterminate" role="progressbar" aria-label="Looking for backups"><div class="task-progress-fill"></div></div></div>
              </div>
              <div id="restoreDriveEmpty" class="py-3 text-center text-white-50 small" style="display: none;">
                <div id="restoreDriveEmptyText">No backups found.</div>
              </div>
              <div id="restoreDriveError" class="py-2 text-danger small" style="display: none;"></div>
              <div id="restoreDriveList" class="d-flex flex-column gap-2" style="max-height: 220px; overflow-y: auto;"></div>

              <!-- Download progress -->
              <div id="restoreDriveDownloadProgress" class="task-status mt-2" style="display:none;" role="status"></div>
            </div>
          </div>

          <!-- Step 2: Inspection Card (Hidden until file selected) -->
          <div id="restoreInspectionCard" class="p-3 rounded-3 mb-3" style="display:none;">
            <div class="restore-inspect-head d-flex align-items-center justify-content-between flex-wrap gap-1 mb-2">
              <div class="d-flex align-items-center gap-2 min-w-0 flex-wrap">
                <span class="small fw-semibold text-white">Valid backup</span>
                <span class="small text-white-50 text-break" id="restoreFilenameLabel" style="font-size: 0.75rem;"></span>
              </div>
              <div class="d-flex align-items-center gap-2 flex-wrap">
                <span class="small text-white-50" id="restoreExportedDate" style="font-size: 0.75rem;"></span>
                <button type="button" class="btn btn-sm btn-link p-0 text-white-50 text-decoration-none" id="restoreChangeFileBtn" style="font-size: 0.75rem;">Change</button>
              </div>
            </div>
            <div class="text-white-50 small mb-3">
              <span id="restoreCountsLegacy"><span class="text-white fw-medium" id="restoreTabsCount">0</span> tabs · <span class="text-white fw-medium" id="restoreSongsCount">0</span> songs</span>
              <span id="restoreCountsPacks" style="display:none;"></span>
            </div>

            <!-- Snapshot restore preview (incremental backups only) -->
            <div class="backup-summary-box p-3 rounded-3 mb-3" id="restoreIncrementalPreview" style="display:none;" aria-live="polite"></div>
            <div class="backup-summary-box p-3 rounded-3 mb-3" id="restoreAudioBox" style="display:none;" aria-live="polite"></div>

            <!-- Restore Mode Options -->
            <label class="form-label small fw-semibold text-white-50 mb-2 d-block">How should this be restored?</label>
            <div class="d-flex flex-column gap-2 mb-3">
              <!-- Merge Mode Option (Recommended) -->
              <label class="restore-mode-card p-3 rounded-3 d-flex align-items-start gap-3" style="cursor: pointer;">
                <input class="form-check-input theme-radio mt-1" type="radio" name="restoreModeRadio" value="merge" checked>
                <div class="min-w-0">
                  <div class="d-flex align-items-center gap-2 mb-1">
                    <span class="fw-semibold text-white small">Add missing items</span>
                    <span class="small text-white-50">Recommended</span>
                  </div>
                  <div class="text-muted" style="font-size: 0.73rem; line-height: 1.35;">
                    Keeps everything you have and adds any tabs, songs, collections, and settings that are missing from the backup.
                  </div>
                </div>
              </label>

              <!-- Wipe & Replace Option -->
              <label class="restore-mode-card p-3 rounded-3 d-flex align-items-start gap-3" style="cursor: pointer;">
                <input class="form-check-input theme-radio mt-1" type="radio" name="restoreModeRadio" value="wipe">
                <div class="min-w-0">
                  <div class="d-flex align-items-center gap-2 mb-1">
                    <span class="fw-semibold text-danger small">Replace all data</span>
                  </div>
                  <div class="text-muted" style="font-size: 0.73rem; line-height: 1.35;">
                    Erases all current local stored tabs, library entries, settings and audio files, and replaces them cleanly with this backup.
                  </div>
                </div>
              </label>
            </div>

            <!-- Confirmation notice for wipe -->
            <div id="wipeConfirmContainer" class="confirm-check mb-3" style="display:none;">
              <input class="form-check-input" type="checkbox" id="wipeConfirmCheckbox">
              <label for="wipeConfirmCheckbox">I understand this will erase my current stored tabs and settings before restoring.</label>
            </div>
          </div>

          <!-- Status / Action -->
          <div id="restoreStatusAlert" class="small mb-2" style="display:none;" role="status"></div>

          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="restoreCancelBtn">Cancel</button>
            <button type="button" class="btn btn-sm btn-theme-primary px-4 d-flex align-items-center gap-2" id="restoreExecuteBtn" disabled>
              Restore backup
            </button>
          </div>
        </div>

        <!-- TAB 3: RELOAD METADATA -->
        <div id="reloadTabContent" style="display: ${activeTab === 'reload' ? 'block' : 'none'};">
          <!-- Library status Overview -->
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2 d-flex align-items-center gap-2">
              <i class="bi-music-note-list text-info"></i> Library status
            </div>
            <div class="row g-2 text-white-50 small">
              <div class="col-6 col-md">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6" id="reloadStatTotalSongs">${libraryData.songs?.length || 0}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Songs</div>
                </div>
              </div>
              <div class="col-6 col-md">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6" id="reloadStatAlbums">${uniqueAlbumsCount}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Albums</div>
                </div>
              </div>
              <div class="col-6 col-md">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6 ${songsMissingDuration > 0 ? 'text-warning' : 'text-success'}" id="reloadStatMissingDuration">${songsMissingDuration}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Missing track times</div>
                </div>
              </div>
              <div class="col-6 col-md">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6 ${songsMissingCover > 0 ? 'text-warning' : 'text-success'}" id="reloadStatMissingCovers">${songsMissingCover}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Missing cover art</div>
                </div>
              </div>
              <div class="col-6 col-md">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6 ${songsMissingTracks > 0 ? 'text-warning' : 'text-success'}" id="reloadStatMissingTracks">${songsMissingTracks}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Missing track numbers</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Informational Card -->
          <div class="p-3 rounded-3 mb-3" style="background: var(--bg-card); border: 1px solid var(--border-subtle);">
            <div class="d-flex align-items-start gap-3">
              <i class="bi-info-circle-fill text-info fs-5 flex-shrink-0 mt-1"></i>
              <div>
                <div class="fw-bold text-white small mb-1">Refresh metadata from MusicBrainz and your Guitar Pro files</div>
                <div class="text-white-50 small" style="font-size: 0.78rem; line-height: 1.45;">
                  Performs a comprehensive refresh of all library metadata: queries MusicBrainz for canonical <strong>track durations</strong>, official track numbers, release years, and cover artwork, while re-analyzing all stored Guitar Pro tab files to extract accurate guitar and bass tunings and string counts.
                </div>
                <div class="text-white-50 small mt-2" style="font-size: 0.78rem; line-height: 1.45;">
                  <strong>Fill in missing only</strong> fills what is blank, such as track numbers, times and covers, and changes nothing that is already set. It removes no songs and does not read your tab files again.
                </div>
                <div class="text-white-50 small mt-2 pt-2 border-top border-secondary border-opacity-25" style="font-size: 0.74rem;">
                  <i class="bi-shield-check text-success me-1"></i> Your attached tabs, custom tab assignments, and collections will remain completely intact.
                </div>
              </div>
            </div>
          </div>

          <!-- Status / Results Alert -->
          <div id="reloadStatusAlert" class="small mb-2" style="display:none;" role="status"></div>

          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="reloadCancelBtn">${activeReloadState.running ? 'Stop' : 'Cancel'}</button>
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="reloadFillBtn" title="Fill in what is blank and change nothing else" ${(activeReloadState.running || !libraryData.songs || libraryData.songs.length === 0) ? 'disabled' : ''}>
              Fill in missing only
            </button>
            <button type="button" class="btn btn-sm btn-theme-primary px-4 d-flex align-items-center gap-2" id="reloadExecuteBtn" ${(activeReloadState.running || !libraryData.songs || libraryData.songs.length === 0) ? 'disabled' : ''}>
              ${activeReloadState.running ? 'Reloading…' : 'Reload metadata'}
            </button>
          </div>
        </div>

        <!-- TAB: ORPHANED FILES -->
        <div id="orphansTabContent" style="display: ${activeTab === 'orphans' ? 'block' : 'none'};">
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2 d-flex align-items-center gap-2">
              <i class="bi-file-earmark-x text-warning"></i> Stored files no song uses
            </div>
            <div class="text-white-50 small mb-3" style="font-size: 0.78rem; line-height: 1.45;">
              These stored files are not attached to any song or album in your library. Removing them frees space and does not affect your songs, collections, or settings. Related Recents entries are removed too.
            </div>
            <div id="orphansList"></div>
          </div>
          <div id="orphansStatusAlert" class="small mb-2" style="display:none;" role="status"></div>
          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="orphansCancelBtn">Close</button>
            <button type="button" class="btn btn-sm btn-theme-danger px-4 d-flex align-items-center gap-2" id="orphansDeleteBtn" disabled>
              Delete selected
            </button>
          </div>

          <div class="backup-summary-box p-3 rounded-3 mt-3">
            <div class="small fw-semibold text-white mb-2">
              Unused files in cloud storage
            </div>
            <div class="text-white-50 small mb-3" style="font-size: 0.78rem; line-height: 1.45;">
              Orphaned packs, SoundFonts, or unused application data in a sync location that you can remove to free space.
            </div>
            <div class="d-flex flex-wrap gap-2 mb-2">
              <!-- @googleDrive:begin -->
              <button type="button" class="btn btn-sm btn-theme-outline px-3" data-remote-orphan-scan="google-drive">Scan Google Drive</button>
              <!-- @googleDrive:end -->
              <button type="button" class="btn btn-sm btn-theme-outline px-3" data-remote-orphan-scan="s3">Scan S3 bucket</button>
              <button type="button" class="btn btn-sm btn-theme-outline px-3" data-remote-orphan-scan="webdav">Scan WebDAV</button>
              <button type="button" class="btn btn-sm btn-theme-outline px-3" data-remote-orphan-scan="folder">Scan backup folder</button>
            </div>
            <div id="remoteOrphansList"></div>
            <div id="remoteOrphansStatus" class="small mt-2" style="display:none;" role="status"></div>
            <div class="d-flex justify-content-end pt-2">
              <button type="button" class="btn btn-sm btn-theme-danger px-4 d-flex align-items-center gap-2" id="remoteOrphansDeleteBtn" disabled>
                Delete selected
              </button>
            </div>
          </div>
        </div>

        <!-- TAB: DUPLICATE SONGS -->
        <div id="duplicatesTabContent" style="display: ${activeTab === 'duplicates' ? 'block' : 'none'};">
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2">Songs listed more than once</div>
            <div class="text-white-50 small mb-3" style="font-size: 0.78rem; line-height: 1.45;">
              Songs with the same artist, album and title. A copy with no tabs, no pack and no audio is removed. A copy that holds tabs, audio, a pin or a pack is merged into the one that stays: its tabs and audio move over, then it is removed. The change reaches your other devices at the next sync.
            </div>
            <div id="duplicatesList"></div>
          </div>
          <div id="duplicatesStatusAlert" class="small mb-2" style="display:none;" role="status"></div>
          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="duplicatesCancelBtn">Close</button>
            <button type="button" class="btn btn-sm btn-theme-danger px-4" id="duplicatesDeleteBtn" disabled>Apply selected</button>
          </div>
        </div>

        <!-- TAB: MIXED-UP ALBUMS -->
        <div id="mixedalbumsTabContent" style="display: ${activeTab === 'mixedalbums' ? 'block' : 'none'};">
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2">Songs filed under the wrong album</div>
            <div class="text-white-50 small mb-3" style="font-size: 0.78rem; line-height: 1.45;">
              A song that shares its recording with a differently named song on the same album, and is not on that album's track list. Each is looked up again by its title and moved to the album it belongs to. Tabs, audio and pins stay as they are. The change reaches your other devices at the next sync.
            </div>
            <div id="mixedalbumsList"></div>
          </div>
          <div id="mixedalbumsStatusAlert" class="small mb-2" style="display:none;" role="status"></div>
          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="mixedalbumsCancelBtn">Close</button>
            <button type="button" class="btn btn-sm btn-theme-primary px-4" id="mixedalbumsApplyBtn" disabled>Move selected</button>
          </div>
        </div>

        <!-- TAB: DUPLICATE TABS -->
        <div id="dupetabsTabContent" style="display: ${activeTab === 'dupetabs' ? 'block' : 'none'};">
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2">Tabs stored more than once</div>
            <div class="text-white-50 small mb-3" style="font-size: 0.78rem; line-height: 1.45;">
              A song with two or more tabs that are the same file, whatever they are called. One copy stays, the song's default tab first. The removal reaches your other devices at the next sync.
            </div>
            <div id="duplicateTabsList"></div>
          </div>
          <div id="dupetabsStatusAlert" class="small mb-2" style="display:none;" role="status"></div>
          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="dupetabsCancelBtn">Close</button>
            <button type="button" class="btn btn-sm btn-theme-danger px-4" id="dupetabsDeleteBtn" disabled>Remove selected</button>
          </div>
        </div>

        <!-- TAB: MISSING FILES -->
        <div id="missingTabContent" style="display: ${activeTab === 'missing' ? 'block' : 'none'};">
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2">Tabs whose file is missing</div>
            <div class="text-white-50 small mb-3" style="font-size: 0.78rem; line-height: 1.45;">
              Tabs that list a file this device no longer holds, so they cannot open. With hybrid sync on, cloud storage is checked too: a tab whose file is still there is left unselected, and a tab kept only in cloud storage is listed only when its pack is gone from there, or when the pack no longer lists its score. Removing an entry leaves the song in your library.
            </div>
            <div id="missingList"></div>
          </div>
          <div id="missingStatusAlert" class="small mb-2" style="display:none;" role="status"></div>
          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="missingCancelBtn">Close</button>
            <button type="button" class="btn btn-sm btn-theme-primary px-4" id="missingRestoreBtn" style="display:none;">Find files in cloud storage</button>
            <button type="button" class="btn btn-sm btn-theme-danger px-4" id="missingDeleteBtn" disabled>Remove selected</button>
          </div>
        </div>

        <!-- TAB: MAP RECORDS -->
        <div id="syncshrinkTabContent" style="display: ${activeTab === 'syncshrink' ? 'block' : 'none'};">
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2">Map records stored twice</div>
            <div class="text-white-50 small mb-3" style="font-size: 0.78rem; line-height: 1.45;">
              Older imports saved a pack's map points twice in each record, and once more for every stem of a stem set. This keeps one copy. Nothing you edited changes, and a stem still plays with its parent's points. Create a backup first.
            </div>
            <div id="syncshrinkList"></div>
          </div>
          <div id="syncshrinkStatusAlert" class="small mb-2" style="display:none;" role="status"></div>
          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="syncshrinkCancelBtn">Close</button>
            <button type="button" class="btn btn-sm btn-theme-danger px-4" id="syncshrinkBtn" disabled>Shrink selected</button>
          </div>
        </div>

        <!-- TAB: PACKS WITH EXTRA AUDIO -->
        <div id="rebuildTabContent" style="display: ${activeTab === 'rebuild' ? 'block' : 'none'};">
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2">Packs with extra audio</div>
            <div class="text-white-50 small mb-3" style="font-size: 0.78rem; line-height: 1.45;">
              Songs that remember a name another song remembers too, with audio filed under it. Their packs took in audio of the other songs. Rebuilding sends each pack again with only its own audio at the next sync. The old files stay in your sync storage until you remove them under Orphaned files.
            </div>
            <div id="rebuildList"></div>
          </div>
          <div id="rebuildStatusAlert" class="small mb-2" style="display:none;" role="status"></div>
          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="rebuildCancelBtn">Close</button>
            <button type="button" class="btn btn-sm btn-theme-primary px-4" id="rebuildBtn" disabled>Rebuild selected</button>
          </div>
        </div>

        <!-- TAB: CLEAR CACHE -->
        <div id="cacheTabContent" style="display: ${activeTab === 'cache' ? 'block' : 'none'};">
          <!-- Cache Summary Overview -->
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2 d-flex align-items-center gap-2">
              Temporary cached data
            </div>
            <div class="text-white-50 small mb-3" style="font-size: 0.78rem; line-height: 1.45;">
              Clearing cached data frees local storage without affecting your stored tab files, songs, collections, playlists, or settings.
            </div>
            <div class="row g-2 text-white-50 small">
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6"><i class="bi-image text-info"></i></div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Album art</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6"><i class="bi-disc text-primary"></i></div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">MusicBrainz</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6"><i class="bi-youtube text-danger"></i></div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">YouTube video</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6"><i class="bi-cloud-download text-success"></i></div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Search queries</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Status / Results Alert -->
          <div id="cacheStatusAlert" class="small mb-2" style="display:none;" role="status"></div>

          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="cacheCancelBtn">Cancel</button>
            <button type="button" class="btn btn-sm btn-theme-primary px-4 d-flex align-items-center gap-2" id="cacheExecuteBtn">
              Clear cache
            </button>
          </div>
        </div>

        <!-- TAB 4: DELETE ALL DATA -->
        <div id="deleteTabContent" style="display: ${activeTab === 'delete' ? 'block' : 'none'};">
          <!-- Data Summary Overview -->
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2 d-flex align-items-center gap-2">
              <i class="bi-exclamation-octagon text-danger"></i> What will be erased
            </div>
            <div class="row g-2 text-white-50 small">
              <div class="col-4">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6" id="deleteStatTabs">${storedFiles.length}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Stored tabs (${formatBytes(tabsTotalSize)})</div>
                </div>
              </div>
              <div class="col-4">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6" id="deleteStatSongs">${libraryData.songs?.length || 0}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Library songs</div>
                </div>
              </div>
              <div class="col-4">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6"><i class="bi-gear text-warning"></i></div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Settings and cache</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Danger Warning Card -->
          <div class="p-3 rounded-3 mb-3" style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.35);">
            <div class="d-flex align-items-start gap-3 mb-2">
              <i class="bi-exclamation-triangle-fill text-danger fs-5 flex-shrink-0 mt-1"></i>
              <div>
                <div class="fw-bold text-white small mb-1">This cannot be undone</div>
                <div class="text-white-50 small" style="font-size: 0.78rem; line-height: 1.45;">
                  This action permanently removes all locally stored tab files, library tracks, playlists, collections, and resets all application settings to factory defaults.
                </div>
              </div>
            </div>
            <div class="text-white-50 small p-2 rounded-2 mt-2" style="background: rgba(0,0,0,0.25); font-size: 0.74rem;">
              <i class="bi-info-circle text-info me-1"></i> Tip: If you want to keep a copy of your current files and settings, create a backup using <strong>Create a backup</strong> first.
            </div>
          </div>

          <!-- Confirmation Checkbox -->
          <div class="confirm-check mb-3">
            <input class="form-check-input" type="checkbox" id="deleteAllConfirmCheckbox">
            <label for="deleteAllConfirmCheckbox">I understand this action is permanent and cannot be undone. Delete all my data.</label>
          </div>

          <!-- Status / Action -->
          <div id="deleteStatusAlert" class="small mb-2" style="display:none;" role="status"></div>

          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="deleteCancelBtn">Cancel</button>
            <button type="button" class="btn btn-sm btn-theme-danger px-4 d-flex align-items-center gap-2" id="deleteExecuteBtn" disabled>
              Delete all data
            </button>
          </div>
        </div>
      </div>
    </div>
    `;

    // Attach Event Handlers
    attachModalHandlers(modal, options);
}

/**
 * Attach interactive handlers to the Data Management modal
 */
function attachModalHandlers(modal, options = {}) {
    // Cancel buttons
    modal.querySelector('#backupCancelBtn')?.addEventListener('click', closeBackupModal);
    modal.querySelector('#restoreCancelBtn')?.addEventListener('click', closeBackupModal);
    modal.querySelector('#cacheCancelBtn')?.addEventListener('click', closeBackupModal);
    modal.querySelector('#deleteCancelBtn')?.addEventListener('click', closeBackupModal);



    // --- ORPHANED FILES ---
    const orphansList = modal.querySelector('#orphansList');
    const orphansDeleteBtn = modal.querySelector('#orphansDeleteBtn');
    const orphansStatusAlert = modal.querySelector('#orphansStatusAlert');
    const updateOrphansDeleteBtn = () => {
        const n = orphansList.querySelectorAll('.orphan-check:checked').length;
        orphansDeleteBtn.disabled = n === 0;
        orphansDeleteBtn.textContent = `Delete selected${n ? ` · ${n}` : ''}`;
    };
    const renderOrphans = async () => {
        let orphans = [];
        try {
            orphans = (await findOrphanedStoredFiles()).sort((a, b) => (b.size || 0) - (a.size || 0));
        } catch (err) {
            console.error('Failed to scan for orphaned files:', err);
            orphansList.innerHTML = `<div class="text-danger small">Failed to scan: ${escapeHtml(err.message)}</div>`;
            return;
        }
        if (orphans.length === 0) {
            orphansList.innerHTML = '<div class="text-success small"><i class="bi-check-circle-fill me-1"></i> No orphaned files found.</div>';
            updateOrphansDeleteBtn();
            return;
        }
        const total = orphans.reduce((acc, f) => acc + (f.size || 0), 0);
        orphansList.innerHTML = `
          <div class="d-flex align-items-center justify-content-between mb-2 small">
            <label class="d-flex align-items-center gap-2 text-white mb-0">
              <input type="checkbox" class="form-check-input theme-switch" id="orphansSelectAll" checked>
              Select all (${orphans.length} files, ${formatBytes(total)})
            </label>
          </div>
          <div class="d-flex flex-column gap-2" style="max-height: 45vh; overflow-y: auto;">
            ${orphans.map(f => `
              <label class="d-flex align-items-center gap-3 p-2 rounded-2 backup-stat-card mb-0" style="cursor: pointer;">
                <input type="checkbox" class="form-check-input orphan-check flex-shrink-0" data-id="${escapeHtml(f.id)}" checked>
                <span class="flex-grow-1 text-truncate text-white small" title="${escapeHtml(f.name || f.id)}">${escapeHtml(f.name || f.id)}</span>
                <span class="flex-shrink-0 text-white-50 small">${formatBytes(f.size || 0)}</span>
              </label>`).join('')}
          </div>`;
        orphansList.querySelector('#orphansSelectAll').addEventListener('change', (e) => {
            orphansList.querySelectorAll('.orphan-check').forEach(cb => { cb.checked = e.target.checked; });
            updateOrphansDeleteBtn();
        });
        orphansList.querySelectorAll('.orphan-check').forEach(cb => cb.addEventListener('change', updateOrphansDeleteBtn));
        updateOrphansDeleteBtn();
    };
    modal.querySelector('#orphansCancelBtn')?.addEventListener('click', closeBackupModal);
    orphansDeleteBtn?.addEventListener('click', async () => {
        const ids = [...orphansList.querySelectorAll('.orphan-check:checked')].map(cb => cb.dataset.id);
        if (ids.length === 0) return;
        orphansDeleteBtn.disabled = true;
        orphansDeleteBtn.textContent = 'Deleting…';
        showTaskProgress(orphansStatusAlert, { label: 'Deleting orphaned files…', detail: `${ids.length} selected` });
        try {
            await deleteOrphanedStoredFiles(ids);
            showTaskResult(orphansStatusAlert, 'done', `Removed ${ids.length} orphaned ${ids.length === 1 ? 'file' : 'files'}`);
        } catch (err) {
            console.error('Failed to delete orphaned files:', err);
            showTaskResult(orphansStatusAlert, 'error', `Could not delete the files. ${err.message}`);
        }
        await renderOrphans();
    });
    renderOrphans();

    // --- DUPLICATE SONGS ---
    const duplicatesList = modal.querySelector('#duplicatesList');
    const duplicatesDeleteBtn = modal.querySelector('#duplicatesDeleteBtn');
    const duplicatesStatusAlert = modal.querySelector('#duplicatesStatusAlert');
    const updateDuplicatesBtn = () => {
        const n = duplicatesList.querySelectorAll('.dupe-check:checked, .dupe-merge-check:checked').length;
        duplicatesDeleteBtn.disabled = n === 0;
        duplicatesDeleteBtn.textContent = `Apply selected${n ? ` · ${n}` : ''}`;
    };
    const renderDuplicates = async () => {
        duplicatesList.innerHTML = '<div class="text-white-50 small">Scanning your library…</div>';
        let groups = [];
        try {
            groups = findDuplicateSongs(await getAllSongs(), { hasAudio: (s) => readLibraryAudio(s.id).length > 0 });
        } catch (err) {
            console.error('Failed to scan for duplicate songs:', err);
            duplicatesList.innerHTML = `<div class="text-danger small">Failed to scan: ${escapeHtml(err.message)}</div>`;
            return;
        }
        if (groups.length === 0) {
            duplicatesList.innerHTML = '<div class="text-white-50 small">No song is listed more than once.</div>';
            updateDuplicatesBtn();
            return;
        }
        duplicatesList.innerHTML = `
          <div class="d-flex flex-column gap-2" style="max-height: 45vh; overflow-y: auto;">
            ${groups.map((g) => `
              <div class="p-2 rounded-2 backup-stat-card">
                <div class="small text-white text-truncate">${escapeHtml(g.title)}<span class="text-white-50"> · ${escapeHtml(g.artist)} · ${escapeHtml(g.album)}</span></div>
                ${g.merge.map((s) => `
                  <label class="d-flex align-items-center gap-2 mb-0 mt-1" style="cursor: pointer;">
                    <input type="checkbox" class="form-check-input dupe-merge-check flex-shrink-0" data-keep="${escapeHtml(g.keep.id)}" data-id="${escapeHtml(s.id)}" checked>
                    <span class="small text-white-50">Merge the copy on ${escapeHtml(s.mediumFormat || 'disc')} ${s.mediumNumber || 1}${s.trackNumber ? `, track ${escapeHtml(String(s.trackNumber))}` : ''} into the one that stays (${(s.tabOptions || []).length} ${(s.tabOptions || []).length === 1 ? 'tab' : 'tabs'}${s.pinned ? ', pinned' : ''})</span>
                  </label>`).join('')}
                ${g.remove.map((s) => `
                  <label class="d-flex align-items-center gap-2 mb-0 mt-1" style="cursor: pointer;">
                    <input type="checkbox" class="form-check-input dupe-check flex-shrink-0" data-id="${escapeHtml(s.id)}" checked>
                    <span class="small text-white-50">Remove the copy on ${escapeHtml(s.mediumFormat || 'disc')} ${s.mediumNumber || 1}${s.trackNumber ? `, track ${escapeHtml(String(s.trackNumber))}` : ''} (no tabs)</span>
                  </label>`).join('')}
              </div>`).join('')}
          </div>`;
        duplicatesList.querySelectorAll('.dupe-check, .dupe-merge-check').forEach((cb) => cb.addEventListener('change', updateDuplicatesBtn));
        updateDuplicatesBtn();
    };
    // --- MIXED-UP ALBUMS ---
    const mixedList = modal.querySelector('#mixedalbumsList');
    const mixedApplyBtn = modal.querySelector('#mixedalbumsApplyBtn');
    const mixedStatusAlert = modal.querySelector('#mixedalbumsStatusAlert');
    let mixedPlan = [];
    const updateMixedBtn = () => {
        const n = mixedList.querySelectorAll('.mixed-check:checked').length;
        mixedApplyBtn.disabled = n === 0;
        mixedApplyBtn.textContent = `Move selected${n ? ` · ${n}` : ''}`;
    };
    const renderMixedAlbums = async () => {
        mixedList.innerHTML = '<div class="text-white-50 small">Checking albums… this asks MusicBrainz for track lists, so it can take a moment.</div>';
        mixedApplyBtn.disabled = true;
        mixedPlan = [];
        try {
            const found = await findMisfiledSongs(await getAllSongs(), async (mbid) => {
                const album = await getAlbumTracks(mbid);
                return album ? (album.tracks || []).map((t) => t.title) : null;
            });
            for (const f of found) {
                let home = null;
                try { home = await findSongHome(f.song); } catch (_) { home = null; }
                mixedPlan.push({ ...f, home });
            }
        } catch (err) {
            console.error('Failed to scan for mixed-up albums:', err);
            mixedList.innerHTML = `<div class="text-danger small">Failed to scan: ${escapeHtml(err.message)}</div>`;
            return;
        }
        if (mixedPlan.length === 0) {
            mixedList.innerHTML = '<div class="text-white-50 small">No song is filed under the wrong album.</div>';
            updateMixedBtn();
            return;
        }
        const yr = (y) => (y ? ` (${escapeHtml(String(y))})` : '');
        mixedList.innerHTML = `
          <div class="d-flex flex-column gap-2" style="max-height: 45vh; overflow-y: auto;">
            ${mixedPlan.map((p, i) => `
              <div class="p-2 rounded-2 backup-stat-card">
                <div class="small text-white text-truncate">${escapeHtml(p.song.title)}<span class="text-white-50"> · ${escapeHtml(p.song.artist)}</span></div>
                ${p.home ? `
                  <label class="d-flex align-items-center gap-2 mb-0 mt-1" style="cursor: pointer;">
                    <input type="checkbox" class="form-check-input mixed-check flex-shrink-0" data-i="${i}" checked>
                    <span class="small text-white-50">Move from ${escapeHtml(p.album)}${yr(p.year)} to ${escapeHtml(p.home.album)}${yr(p.home.year)}</span>
                  </label>`
                : `<div class="small text-white-50">On ${escapeHtml(p.album)}${yr(p.year)}, but no other album was found for it. Change it by hand from the library.</div>`}
              </div>`).join('')}
          </div>`;
        mixedList.querySelectorAll('.mixed-check').forEach((cb) => cb.addEventListener('change', updateMixedBtn));
        updateMixedBtn();
    };
    modal.querySelector('#mixedalbumsCancelBtn')?.addEventListener('click', closeBackupModal);
    mixedApplyBtn?.addEventListener('click', async () => {
        const picked = [...mixedList.querySelectorAll('.mixed-check:checked')].map((cb) => mixedPlan[Number(cb.dataset.i)]).filter(Boolean);
        if (picked.length === 0) return;
        mixedApplyBtn.disabled = true;
        mixedApplyBtn.textContent = 'Moving…';
        showTaskProgress(mixedStatusAlert, { label: 'Moving songs…', detail: `${picked.length} selected` });
        try {
            for (const p of picked) await applySongHome(p.song.id, p.home);
            showTaskResult(mixedStatusAlert, 'done', `Moved ${picked.length} ${picked.length === 1 ? 'song' : 'songs'}`);
        } catch (err) {
            console.error('Failed to move songs:', err);
            showTaskResult(mixedStatusAlert, 'error', `Could not move the songs. ${err.message}`);
        }
        await renderMixedAlbums();
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
    });
    // The scan asks MusicBrainz, so it runs only when its own task is the one open
    if (modal.querySelector('#mixedalbumsTabContent')?.style.display !== 'none') renderMixedAlbums();

    const duplicateTabsList = modal.querySelector('#duplicateTabsList');
    const dupetabsDeleteBtn = modal.querySelector('#dupetabsDeleteBtn');
    const dupetabsStatusAlert = modal.querySelector('#dupetabsStatusAlert');
    const updateDupeTabsBtn = () => {
        const n = duplicateTabsList.querySelectorAll('.dupe-tab-check:checked').length;
        dupetabsDeleteBtn.disabled = n === 0;
        dupetabsDeleteBtn.textContent = `Remove selected${n ? ` · ${n}` : ''}`;
    };
    const tabHashes = new Map(); // stored file id -> { size, hash }
    const storedInfo = async (tab) => {
        if (!tab.fileStoreId) return null;
        if (!tabHashes.has(tab.fileStoreId)) {
            const rec = await getStoredFileRecord(tab.fileStoreId).catch(() => null);
            tabHashes.set(tab.fileStoreId, { size: rec?.data ? (rec.size ?? rec.data.byteLength) : null, hash: tab.sha256 || null });
        }
        return tabHashes.get(tab.fileStoreId);
    };
    const renderDuplicateTabs = async () => {
        duplicateTabsList.innerHTML = '<div class="text-white-50 small">Scanning tabs… this reads every song that has more than one tab, so it can take a moment.</div>';
        let found = [];
        try {
            found = await findDuplicateTabs(await getAllSongs(), {
                sizeOf: async (tab) => (await storedInfo(tab))?.size ?? null,
                hashOf: async (tab) => {
                    const info = await storedInfo(tab);
                    if (!info || info.size == null) return null;
                    if (!info.hash) { // read again rather than keep every file in memory
                        const rec = await getStoredFileRecord(tab.fileStoreId).catch(() => null);
                        if (rec?.data) info.hash = await sha256Bytes(new Uint8Array(rec.data));
                    }
                    return info.hash;
                }
            });
        } catch (err) {
            console.error('Failed to scan for duplicate tabs:', err);
            duplicateTabsList.innerHTML = `<div class="text-danger small">Failed to scan: ${escapeHtml(err.message)}</div>`;
            return;
        }
        tabHashes.clear(); // the files are large; do not hold them
        if (found.length === 0) {
            duplicateTabsList.innerHTML = '<div class="text-white-50 small">No song has the same tab stored twice.</div>';
            updateDupeTabsBtn();
            return;
        }
        duplicateTabsList.innerHTML = `
          <div class="d-flex flex-column gap-2" style="max-height: 45vh; overflow-y: auto;">
            ${found.map((g) => `
              <div class="p-2 rounded-2 backup-stat-card">
                <div class="small text-white text-truncate">${escapeHtml(g.song.title)}<span class="text-white-50"> · ${escapeHtml(g.song.artist)} · keeps ${escapeHtml(g.keep.name || 'a tab')}</span></div>
                ${g.remove.map((t) => `
                  <label class="d-flex align-items-center gap-2 mb-0 mt-1" style="cursor: pointer;">
                    <input type="checkbox" class="form-check-input dupe-tab-check flex-shrink-0" data-song="${escapeHtml(g.song.id)}" data-tab="${escapeHtml(t.id)}" checked>
                    <span class="small text-white-50 text-truncate">Remove ${escapeHtml(t.name || 'a tab')}</span>
                  </label>`).join('')}
              </div>`).join('')}
          </div>`;
        duplicateTabsList.querySelectorAll('.dupe-tab-check').forEach((cb) => cb.addEventListener('change', updateDupeTabsBtn));
        updateDupeTabsBtn();
    };
    modal.querySelector('#duplicatesCancelBtn')?.addEventListener('click', closeBackupModal);
    duplicatesDeleteBtn?.addEventListener('click', async () => {
        const ids = [...duplicatesList.querySelectorAll('.dupe-check:checked')].map((cb) => cb.dataset.id);
        const merges = [...duplicatesList.querySelectorAll('.dupe-merge-check:checked')].map((cb) => ({ keep: cb.dataset.keep, id: cb.dataset.id }));
        if (ids.length + merges.length === 0) return;
        duplicatesDeleteBtn.disabled = true;
        duplicatesDeleteBtn.textContent = 'Working…';
        showTaskProgress(duplicatesStatusAlert, { label: 'Updating duplicate songs…', detail: `${ids.length + merges.length} selected` });
        try {
            for (const id of ids) await deleteSongFromLibrary(id);
            for (const m of merges) await mergeSongInto(m.keep, m.id);
            const parts = [];
            if (ids.length) parts.push(`removed ${ids.length}`);
            if (merges.length) parts.push(`merged ${merges.length}`);
            const text = parts.join(' and ');
            showTaskResult(duplicatesStatusAlert, 'done', text.charAt(0).toUpperCase() + text.slice(1) + (ids.length + merges.length === 1 ? ' song' : ' songs'));
        } catch (err) {
            console.error('Failed to update duplicate songs:', err);
            showTaskResult(duplicatesStatusAlert, 'error', `Could not update the songs. ${err.message}`);
        }
        await renderDuplicates();
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
    });
    modal.querySelector('#dupetabsCancelBtn')?.addEventListener('click', closeBackupModal);
    dupetabsDeleteBtn?.addEventListener('click', async () => {
        const tabs = [...duplicateTabsList.querySelectorAll('.dupe-tab-check:checked')].map((cb) => ({ song: cb.dataset.song, tab: cb.dataset.tab }));
        if (tabs.length === 0) return;
        dupetabsDeleteBtn.disabled = true;
        dupetabsDeleteBtn.textContent = 'Removing…';
        showTaskProgress(dupetabsStatusAlert, { label: 'Removing duplicate tabs…', detail: `${tabs.length} selected` });
        try {
            for (const t of tabs) await removeTabOptionFromSong(t.song, t.tab);
            showTaskResult(dupetabsStatusAlert, 'done', `Removed ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`);
        } catch (err) {
            console.error('Failed to remove duplicate tabs:', err);
            showTaskResult(dupetabsStatusAlert, 'error', `Could not remove the tabs. ${err.message}`);
        }
        await renderDuplicateTabs();
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
    });
    renderDuplicates();
    // The tab scan reads files, so it runs only when its own task is the one open
    if (modal.querySelector('#dupetabsTabContent')?.style.display !== 'none') renderDuplicateTabs();

    const missingList = modal.querySelector('#missingList');
    const missingDeleteBtn = modal.querySelector('#missingDeleteBtn');
    const missingStatusAlert = modal.querySelector('#missingStatusAlert');
    const missingRestoreBtn = modal.querySelector('#missingRestoreBtn');
    // Tabs the cloud pack no longer lists: where to look for their files, and what the last search found
    let restoreCtx = null;
    let restoreFound = null;
    const updateMissingBtn = () => {
        const n = missingList.querySelectorAll('.missing-check:checked').length;
        missingDeleteBtn.disabled = n === 0;
        missingDeleteBtn.textContent = `Remove selected${n ? ` · ${n}` : ''}`;
    };
    // With hybrid sync the files may live only in cloud storage, so that copy is checked too. Null when hybrid is off,
    // the location cannot be reached without asking, or it holds no synced library; `note` says why.
    const readRemotePacks = async () => {
        const { isHybridSyncEnabled } = await import('./packSyncLocal.js');
        if (!isHybridSyncEnabled()) return { packs: null, note: '' };
        const { getTarget, openSyncStore } = await import('./syncBackend.js');
        const target = getTarget();
        if (!target) return { packs: null, note: '' };
        try {
            const opened = await openSyncStore(target, { interactive: false });
            if (opened.status !== 'ready') return { packs: null, note: 'Cloud storage could not be reached, so only this device was checked.' };
            const { probeLocation, LOCATION } = await import('./storage/upgrade.js');
            const probe = await probeLocation({ legacy: opened.legacy, current: opened.store });
            if (probe.state !== LOCATION.CURRENT && probe.state !== LOCATION.BOTH) {
                return { packs: null, note: 'Cloud storage holds no synced library yet, so only this device was checked.' };
            }
            const packs = new Set();
            for (const e of await opened.store.list('packs/')) {
                const m = /^packs\/([^/]+)\/manifest\.json$/.exec(e.path);
                if (m) packs.add(m[1]);
            }
            return { packs, store: opened.store, note: '' };
        } catch (err) {
            console.warn('[Data] Missing files: cloud check failed', err);
            return { packs: null, note: 'Cloud storage could not be reached, so only this device was checked.' };
        }
    };
    const updateRestoreBtn = () => {
        if (!missingRestoreBtn) return;
        const n = restoreCtx ? restoreCtx.groups.reduce((c, g) => c + g.tabs.length, 0) : 0;
        missingRestoreBtn.style.display = n ? '' : 'none';
        missingRestoreBtn.disabled = false;
        missingRestoreBtn.textContent = restoreFound ? `Restore ${restoreFound.found.length} ${restoreFound.found.length === 1 ? 'tab' : 'tabs'}` : `Find files in cloud storage · ${n}`;
    };
    // First press searches cloud storage and says what it found; the second restores what was found
    missingRestoreBtn?.addEventListener('click', async () => {
        if (!restoreCtx) return;
        missingRestoreBtn.disabled = true;
        try {
            if (!restoreFound) {
                showTaskProgress(missingStatusAlert, { label: 'Looking for the files in cloud storage…' });
                restoreFound = await findTabFiles(restoreCtx.store, restoreCtx.groups, {
                    packIdOf: restoreCtx.packIdOf,
                    onProgress: ({ current, total }) => showTaskProgress(missingStatusAlert, { label: 'Looking for the files in cloud storage…', detail: `${current} of ${total}`, value: total ? (current / total) * 100 : null }),
                });
                const { found: ok, notFound } = restoreFound;
                showTaskResult(missingStatusAlert, ok.length ? 'done' : 'error', `${ok.length} ${ok.length === 1 ? 'file' : 'files'} found${notFound.length ? `, ${notFound.length} not found` : ''}.${ok.length ? ' Restore them to this device, then sync to fix the cloud copy.' : ''}`);
                if (!ok.length) restoreFound = null;
                updateRestoreBtn();
                if (!ok.length) missingRestoreBtn.disabled = false;
                return;
            }
            const todo = restoreFound.found;
            showTaskProgress(missingStatusAlert, { label: 'Restoring files…', detail: `0 of ${todo.length}` });
            const res = await restoreTabFiles(todo, {
                saveFile: saveStoredFile,
                linkTab: updateTabOptionOnSong,
                onProgress: ({ current, total }) => showTaskProgress(missingStatusAlert, { label: 'Restoring files…', detail: `${current} of ${total}`, value: total ? (current / total) * 100 : null }),
            });
            restoreFound = null;
            window.dispatchEvent(new CustomEvent('libraryDataChanged'));
            await renderMissing();
            showTaskResult(missingStatusAlert, res.failed.length ? 'error' : 'done', `Restored ${res.restored} ${res.restored === 1 ? 'tab' : 'tabs'}${res.failed.length ? `, ${res.failed.length} failed. ${res.failed[0].reason}` : '. Sync to send them to cloud storage'}`);
        } catch (err) {
            console.error('Failed to restore tab files:', err);
            restoreFound = null;
            showTaskResult(missingStatusAlert, 'error', `Could not restore the files. ${err.message}`);
            updateRestoreBtn();
        }
    });
    const renderMissing = async () => {
        missingList.innerHTML = '<div class="text-white-50 small">Checking your tabs…</div>';
        let found = [];
        let note = '';
        try {
            const stored = await getAllStoredFiles();
            const remote = await readRemotePacks();
            note = remote.note;
            restoreCtx = null;
            restoreFound = null;
            const songs = await getAllSongs();
            const packIdOf = (s) => (isPackId(s.id) ? s.id : (isPackId(s.packId) ? s.packId : null));
            found = findMissingTabFiles(songs, new Set(stored.map((f) => f.id)), { remotePackIds: remote.packs, packIdOf });
            // A tab with no local file is fine only while the cloud pack still lists its score
            if (remote.packs && remote.store) {
                const hashes = new Map();
                for (const s of songsWithUnstoredTabs(songs, packIdOf)) {
                    const pid = packIdOf(s);
                    if (!remote.packs.has(pid) || hashes.has(pid)) continue;
                    try {
                        const manifest = JSON.parse(new TextDecoder().decode(await remote.store.read(`packs/${pid}/manifest.json`)));
                        hashes.set(pid, new Set((manifest.scores || []).flatMap((t) => [t, ...(t.alternates || [])]).map((x) => x.sha256).filter(Boolean)));
                    } catch (err) { console.warn('[Data] Missing files: could not read the manifest of', pid, err); }
                }
                const unreachable = findUnreachableTabs(songs, hashes, { packIdOf });
                if (unreachable.length) restoreCtx = { store: remote.store, groups: unreachable, packIdOf };
                found = [...found, ...unreachable]
                    .sort((a, b) => `${a.song.artist} ${a.song.album} ${a.song.title}`.localeCompare(`${b.song.artist} ${b.song.album} ${b.song.title}`));
            }
        } catch (err) {
            console.error('Failed to scan for missing files:', err);
            missingList.innerHTML = `<div class="text-danger small">Failed to scan: ${escapeHtml(err.message)}</div>`;
            return;
        }
        const noteHtml = note ? `<div class="small text-white-50 mb-2">${escapeHtml(note)}</div>` : '';
        if (found.length === 0) {
            missingList.innerHTML = `${noteHtml}<div class="text-white-50 small">Every tab has its file.</div>`;
            updateMissingBtn();
            updateRestoreBtn();
            return;
        }
        // Gone on the device and in cloud storage is checked; a copy still in cloud storage, or a guess, is not
        const why = (g) => (g.kind === 'unreachable' ? 'cloud storage no longer lists this score and this device does not hold it. Add the file to the song again, then sync. Removing the entry loses it'
            : g.inCloud ? 'a copy is in cloud storage, so sync can bring it back'
            : g.kind === 'cloud' ? 'not on this device or in cloud storage'
                : g.tabs.length === g.songTabCount ? 'no tab left after removal' : '');
        missingList.innerHTML = `${noteHtml}
          <div class="d-flex flex-column gap-2" style="max-height: 45vh; overflow-y: auto;">
            ${found.map((g) => `
              <div class="p-2 rounded-2 backup-stat-card">
                <div class="small text-white text-truncate">${escapeHtml(g.song.title || 'Untitled')}<span class="text-white-50"> · ${escapeHtml(g.song.artist || '')}</span></div>
                ${why(g) ? `<div class="small text-white-50">${escapeHtml(why(g)[0].toUpperCase() + why(g).slice(1))}</div>` : ''}
                ${g.tabs.map((t) => `
                  <label class="d-flex align-items-center gap-2 mb-0 mt-1" style="cursor: pointer;">
                    <input type="checkbox" class="form-check-input missing-check flex-shrink-0" data-song="${escapeHtml(g.song.id)}" data-tab="${escapeHtml(t.id)}" ${g.inCloud || g.kind === 'unreachable' ? '' : 'checked'}>
                    <span class="small text-white-50 text-truncate">Remove ${escapeHtml(t.name || 'a tab')}</span>
                  </label>`).join('')}
              </div>`).join('')}
          </div>`;
        missingList.querySelectorAll('.missing-check').forEach((cb) => cb.addEventListener('change', updateMissingBtn));
        updateMissingBtn();
        updateRestoreBtn();
    };
    modal.querySelector('#missingCancelBtn')?.addEventListener('click', closeBackupModal);
    missingDeleteBtn?.addEventListener('click', async () => {
        const tabs = [...missingList.querySelectorAll('.missing-check:checked')].map((cb) => ({ song: cb.dataset.song, tab: cb.dataset.tab }));
        if (tabs.length === 0) return;
        missingDeleteBtn.disabled = true;
        missingDeleteBtn.textContent = 'Removing…';
        showTaskProgress(missingStatusAlert, { label: 'Removing tabs with no file…', detail: `${tabs.length} selected` });
        try {
            for (const t of tabs) await removeTabOptionFromSong(t.song, t.tab);
            showTaskResult(missingStatusAlert, 'done', `Removed ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`);
        } catch (err) {
            console.error('Failed to remove tabs with no file:', err);
            showTaskResult(missingStatusAlert, 'error', `Could not remove the tabs. ${err.message}`);
        }
        await renderMissing();
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
    });
    if (modal.querySelector('#missingTabContent')?.style.display !== 'none') renderMissing();

    // --- MAP RECORDS ---
    const syncshrinkList = modal.querySelector('#syncshrinkList');
    const syncshrinkBtn = modal.querySelector('#syncshrinkBtn');
    const syncshrinkStatusAlert = modal.querySelector('#syncshrinkStatusAlert');
    const SYNC_PREFIX = 'audio_sync_';
    const syncKeys = () => {
        const out = [];
        for (let i = 0; i < recordStorage.length; i++) {
            const k = recordStorage.key(i);
            if (k && k.startsWith(SYNC_PREFIX) && !k.startsWith(`${SYNC_PREFIX}share_`)) out.push(k);
        }
        return out;
    };
    // The recording a stem was split from, from what the pack said about it (kept under the song key, without a score's prefix)
    const metaByKey = new Map();
    const stemParentOf = (entry) => {
        const mk = mediaKeyOf(entry.media);
        if (!mk || !entry.key.endsWith(`_${mk}`)) return null;
        let song;
        try { song = decodeURIComponent(entry.key.slice(SYNC_PREFIX.length, entry.key.length - mk.length - 1)); } catch { return null; }
        song = song.replace(/^score:[^:]*:/, '').replace(/^text:/, '');
        if (!metaByKey.has(song)) metaByKey.set(song, listRecordingMeta(song));
        return metaByKey.get(song)[mk]?.stemOf || null;
    };
    const scanSyncShrink = async () => {
        metaByKey.clear();
        const entries = [];
        let n = 0;
        for (const k of syncKeys()) {
            const text = recordStorage.getItem(k);
            const entry = typeof text === 'string' ? entryOf(k, text) : null;
            if (entry) entries.push(entry);
            if (++n % 100 === 0) await new Promise((r) => setTimeout(r, 0)); // let the page draw while the library is read
        }
        return planShrink(entries, { stemParentOf });
    };
    let syncshrinkPlan = null;
    const updateSyncshrinkBtn = () => {
        const n = syncshrinkList.querySelectorAll('.syncshrink-check:checked').length;
        syncshrinkBtn.disabled = n === 0;
    };
    const renderSyncshrink = async () => {
        syncshrinkList.innerHTML = '<div class="text-white-50 small">Scanning map records… this reads every record, so it can take a moment.</div>';
        syncshrinkBtn.disabled = true;
        try {
            syncshrinkPlan = await scanSyncShrink();
        } catch (err) {
            console.error('Failed to scan map records:', err);
            syncshrinkList.innerHTML = `<div class="text-danger small">Failed to scan: ${escapeHtml(err.message)}</div>`;
            return;
        }
        const { restore, stems, restoreBytes, stemBytes } = syncshrinkPlan;
        if (!restore.length && !stems.length) {
            syncshrinkList.innerHTML = '<div class="text-white-50 small">No map record is stored twice.</div>';
            updateSyncshrinkBtn();
            return;
        }
        const row = (kind, count, bytes, one, many, note) => count ? `
          <label class="d-flex align-items-start gap-2 mb-0 mt-1 p-2 rounded-2 backup-stat-card" style="cursor: pointer;">
            <input type="checkbox" class="form-check-input syncshrink-check flex-shrink-0 mt-1" data-kind="${kind}" checked>
            <span class="small text-white-50"><span class="text-white">${count} ${count === 1 ? one : many}</span> · ${formatBytes(bytes)}<br>${note}</span>
          </label>` : '';
        syncshrinkList.innerHTML = `
          <div class="d-flex flex-column gap-2">
            ${row('restore', restore.length, restoreBytes, 'record', 'records', 'Holds the pack\'s points a second time as its restore point. Restore original still works.')}
            ${row('stems', stems.length, stemBytes, 'stem record', 'stem records', 'A stem with exactly its parent\'s points. It plays with the parent\'s.')}
          </div>`;
        syncshrinkList.querySelectorAll('.syncshrink-check').forEach((cb) => cb.addEventListener('change', updateSyncshrinkBtn));
        updateSyncshrinkBtn();
    };
    modal.querySelector('#syncshrinkCancelBtn')?.addEventListener('click', closeBackupModal);
    syncshrinkBtn?.addEventListener('click', async () => {
        const kinds = new Set([...syncshrinkList.querySelectorAll('.syncshrink-check:checked')].map((cb) => cb.dataset.kind));
        if (!kinds.size) return;
        syncshrinkBtn.disabled = true;
        syncshrinkBtn.textContent = 'Shrinking…';
        showTaskProgress(syncshrinkStatusAlert, { label: 'Shrinking map records…', detail: 'Checking each record before it changes' });
        let shrunk = 0, removed = 0, skipped = 0;
        try {
            // Read again: the list may be old, and each record is checked point for point before it is touched
            const plan = await scanSyncShrink();
            let n = 0;
            if (kinds.has('stems')) {
                for (const s of plan.stems) {
                    const raw = (() => { try { return JSON.parse(recordStorage.getItem(s.key)); } catch { return null; } })();
                    const parent = (() => { try { return JSON.parse(recordStorage.getItem(s.parentKey)); } catch { return null; } })();
                    if (stemIsCopy(raw, parent)) { recordStorage.removeItem(s.key); removed++; } else skipped++;
                    if (++n % 50 === 0) await new Promise((r) => setTimeout(r, 0));
                }
            }
            if (kinds.has('restore')) {
                for (const r of plan.restore) {
                    const text = recordStorage.getItem(r.key);
                    if (typeof text !== 'string') continue; // a stem copy removed above
                    let next = null;
                    try { next = shrunkRestore(JSON.parse(text)); } catch { next = null; }
                    if (next) { recordStorage.setItem(r.key, JSON.stringify(next)); shrunk++; } else skipped++;
                    if (++n % 50 === 0) await new Promise((r2) => setTimeout(r2, 0));
                }
            }
            await flushSyncRecords();
            window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
            window.dispatchEvent(new CustomEvent('majestictab:data-changed'));
            const parts = [];
            if (shrunk) parts.push(`${shrunk} ${shrunk === 1 ? 'record' : 'records'} shrunk`);
            if (removed) parts.push(`${removed} stem ${removed === 1 ? 'record' : 'records'} removed`);
            if (skipped) parts.push(`${skipped} left as they are`);
            showTaskResult(syncshrinkStatusAlert, 'done', parts.join(' · ') || 'Nothing to change');
        } catch (err) {
            console.error('Failed to shrink map records:', err);
            showTaskResult(syncshrinkStatusAlert, 'error', `Could not shrink the map records. ${err.message}`);
        }
        syncshrinkBtn.textContent = 'Shrink selected';
        await renderSyncshrink();
    });
    // The scan reads every record, so it runs only when its own task is the one open
    if (modal.querySelector('#syncshrinkTabContent')?.style.display !== 'none') renderSyncshrink();

    // --- PACKS WITH EXTRA AUDIO ---
    const rebuildList = modal.querySelector('#rebuildList');
    const rebuildBtn = modal.querySelector('#rebuildBtn');
    const rebuildStatusAlert = modal.querySelector('#rebuildStatusAlert');
    const updateRebuildBtn = () => {
        const n = rebuildList.querySelectorAll('.rebuild-check:checked').length;
        rebuildBtn.disabled = n === 0;
        rebuildBtn.textContent = `Rebuild selected${n ? ` · ${n}` : ''}`;
    };
    const renderRebuild = async () => {
        let found = [];
        try {
            found = findPooledSongs({ songs: await getAllSongs(), audioFiles: await listAudioFiles(), keysBySong: readRememberedKeys(), rebuildMarks: readRebuildMarks() });
        } catch (err) {
            console.error('Failed to scan for packs with extra audio:', err);
            rebuildList.innerHTML = `<div class="text-danger small">Failed to scan: ${escapeHtml(err.message)}</div>`;
            return;
        }
        if (found.length === 0) {
            rebuildList.innerHTML = '<div class="text-white-50 small">No pack holds audio of other songs.</div>';
            updateRebuildBtn();
            return;
        }
        rebuildList.innerHTML = `
          <label class="d-flex align-items-center gap-2 mb-2 small text-white" style="cursor: pointer;">
            <input type="checkbox" class="form-check-input" id="rebuildSelectAll" checked>
            Select all (${found.length} songs)
          </label>
          <div class="d-flex flex-column gap-1" style="max-height: 45vh; overflow-y: auto;">
            ${found.map((f) => `
              <label class="d-flex align-items-center gap-2 mb-0" style="cursor: pointer;">
                <input type="checkbox" class="form-check-input rebuild-check flex-shrink-0" data-id="${escapeHtml(f.song.id)}" checked>
                <span class="small text-white text-truncate">${escapeHtml(f.song.title)}<span class="text-white-50"> · ${escapeHtml(f.song.artist)} · ${f.files} files</span></span>
              </label>`).join('')}
          </div>`;
        rebuildList.querySelector('#rebuildSelectAll').addEventListener('change', (e) => {
            rebuildList.querySelectorAll('.rebuild-check').forEach((cb) => { cb.checked = e.target.checked; });
            updateRebuildBtn();
        });
        rebuildList.querySelectorAll('.rebuild-check').forEach((cb) => cb.addEventListener('change', updateRebuildBtn));
        updateRebuildBtn();
    };
    modal.querySelector('#rebuildCancelBtn')?.addEventListener('click', closeBackupModal);
    rebuildBtn?.addEventListener('click', () => {
        const ids = [...rebuildList.querySelectorAll('.rebuild-check:checked')].map((cb) => cb.dataset.id);
        if (ids.length === 0) return;
        const n = markPacksForRebuild(ids);
        showTaskResult(rebuildStatusAlert, n ? 'done' : 'error', n
            ? `Marked ${n} ${n === 1 ? 'pack' : 'packs'}. Sync to send ${n === 1 ? 'it' : 'them'} again.`
            : 'Could not mark the packs. Storage is not available.');
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
    });
    renderRebuild();

    // --- ORPHANED FILES IN CLOUD STORAGE ---
    const remoteOrphansList = modal.querySelector('#remoteOrphansList');
    const remoteOrphansStatus = modal.querySelector('#remoteOrphansStatus');
    const remoteOrphansDeleteBtn = modal.querySelector('#remoteOrphansDeleteBtn');
    let remoteOrphanTarget = null;
    let remoteOrphanItems = [];
    const setRemoteStatus = (kind, text) => {
        if (!text) return clearTaskStatus(remoteOrphansStatus);
        showTaskResult(remoteOrphansStatus, kind, text);
    };
    const updateRemoteOrphansDeleteBtn = () => {
        const n = remoteOrphansList.querySelectorAll('.remote-orphan-check:checked').length;
        remoteOrphansDeleteBtn.disabled = n === 0;
        remoteOrphansDeleteBtn.textContent = `Delete selected${n ? ` · ${n}` : ''}`;
    };
    const renderRemoteOrphans = (found) => {
        remoteOrphanItems = found.items;
        if (!found.items.length) {
            remoteOrphansList.innerHTML = '<div class="text-success small">Everything in this location is in use.</div>';
            return updateRemoteOrphansDeleteBtn();
        }
        remoteOrphansList.innerHTML = `
          <div class="d-flex align-items-center justify-content-between mb-2 small">
            <label class="d-flex align-items-center gap-2 text-white mb-0">
              <input type="checkbox" class="form-check-input theme-switch" id="remoteOrphansSelectAll">
              Select all (${found.items.length} ${found.items.length === 1 ? 'item' : 'items'}, ${formatBytes(found.totalBytes)})
            </label>
          </div>
          <div class="d-flex flex-column gap-2" style="max-height: 35vh; overflow-y: auto;">
            ${found.items.map(item => `
              <label class="d-flex align-items-center gap-3 p-2 rounded-2 backup-stat-card mb-0" style="cursor: pointer;">
                <input type="checkbox" class="form-check-input remote-orphan-check flex-shrink-0" data-key="${escapeHtml(item.key)}">
                <span class="flex-grow-1 text-truncate text-white small" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}<span class="text-white-50"> · ${escapeHtml(item.detail)}</span></span>
                <span class="flex-shrink-0 text-white-50 small">${formatBytes(item.size)}</span>
              </label>`).join('')}
          </div>`;
        remoteOrphansList.querySelector('#remoteOrphansSelectAll').addEventListener('change', (e) => {
            remoteOrphansList.querySelectorAll('.remote-orphan-check').forEach(cb => { cb.checked = e.target.checked; });
            updateRemoteOrphansDeleteBtn();
        });
        remoteOrphansList.querySelectorAll('.remote-orphan-check').forEach(cb => cb.addEventListener('change', updateRemoteOrphansDeleteBtn));
        updateRemoteOrphansDeleteBtn();
    };
    modal.querySelectorAll('[data-remote-orphan-scan]').forEach(btn => btn.addEventListener('click', async () => {
        const provider = btn.dataset.remoteOrphanScan;
        setRemoteStatus('', '');
        remoteOrphansList.innerHTML = '';
        showTaskProgress(remoteOrphansStatus, { label: 'Scanning cloud storage…' });
        remoteOrphanTarget = null;
        remoteOrphanItems = [];
        updateRemoteOrphansDeleteBtn();
        try {
            const [{ openSyncStore }, { findRemoteOrphans }, { LOCATION }] = await Promise.all([
                import('./syncBackend.js'),
                import('./storage/orphans.js'),
                import('./storage/upgrade.js'),
            ]);
            const opened = await openSyncStore(provider, { interactive: true });
            if (opened.status !== 'ready') {
                remoteOrphansList.innerHTML = '';
                const msg = opened.status === 'needs-auth' ? 'Connect Google Drive in Sync first.'
                    : opened.status === 'needs-s3' ? 'Connect an S3 bucket in Sync first.'
                        : opened.status === 'needs-webdav' ? 'Connect a WebDAV server in Sync first.'
                            : opened.status === 'needs-icloud' ? 'Choose an iCloud Drive folder in Sync first.'
                                : 'Choose a backup folder and allow access to scan it.';
                return setRemoteStatus('info', msg);
            }
            const found = await findRemoteOrphans({ store: opened.store, legacy: opened.legacy });
            remoteOrphanTarget = { store: opened.store, legacy: opened.legacy };
            if (found.state === LOCATION.NONE) {
                remoteOrphansList.innerHTML = '';
                return setRemoteStatus('info', 'No synced library found there.');
            }
            if (found.state === LOCATION.LEGACY) {
                remoteOrphansList.innerHTML = '';
                return setRemoteStatus('info', 'This location uses the older backup format. Upgrade it in Sync before cleaning up.');
            }
            setRemoteStatus('', '');
            renderRemoteOrphans(found);
        } catch (err) {
            console.error('Cloud storage orphan scan failed:', err);
            remoteOrphansList.innerHTML = '';
            setRemoteStatus('error', `Failed to scan: ${err.message}`);
        }
    }));
    remoteOrphansDeleteBtn?.addEventListener('click', async () => {
        const keys = new Set([...remoteOrphansList.querySelectorAll('.remote-orphan-check:checked')].map(cb => cb.dataset.key));
        const chosen = remoteOrphanItems.filter(it => keys.has(it.key));
        if (!chosen.length || !remoteOrphanTarget) return;
        remoteOrphansDeleteBtn.disabled = true;
        remoteOrphansDeleteBtn.textContent = 'Deleting…';
        showTaskProgress(remoteOrphansStatus, { label: 'Deleting unused files…', detail: `${chosen.length} selected` });
        try {
            const { findRemoteOrphans, deleteRemoteOrphans } = await import('./storage/orphans.js');
            await deleteRemoteOrphans(remoteOrphanTarget, chosen);
            setRemoteStatus('done', `Removed ${chosen.length} ${chosen.length === 1 ? 'item' : 'items'} from cloud storage.`);
            renderRemoteOrphans(await findRemoteOrphans(remoteOrphanTarget));
        } catch (err) {
            console.error('Failed to delete cloud storage orphans:', err);
            setRemoteStatus('error', `Failed: ${err.message}`);
            updateRemoteOrphansDeleteBtn();
        }
    });

    // --- CLEAR CACHE ACTION ---
    const cacheExecuteBtn = modal.querySelector('#cacheExecuteBtn');
    const cacheStatusAlert = modal.querySelector('#cacheStatusAlert');
    cacheExecuteBtn?.addEventListener('click', async () => {
        cacheExecuteBtn.disabled = true;
        cacheExecuteBtn.textContent = 'Clearing…';
        showTaskProgress(cacheStatusAlert, { label: 'Clearing cached data…' });
        try {
            const count = await clearAppCache();
            showTaskResult(cacheStatusAlert, 'done', `Cache cleared · ${count} cached ${count === 1 ? 'item' : 'items'} removed`);
            cacheExecuteBtn.textContent = 'Cleared';
            setTimeout(() => {
                cacheExecuteBtn.disabled = false;
                cacheExecuteBtn.textContent = 'Clear cache';
            }, 3000);
        } catch (err) {
            console.error('Failed to clear cache:', err);
            showTaskResult(cacheStatusAlert, 'error', `Could not clear the cache. ${err.message}`);
            cacheExecuteBtn.disabled = false;
            cacheExecuteBtn.textContent = 'Try again';
        }
    });

    // --- CREATE BACKUP ACTION ---
    const backupProviderBtns = Array.from(modal.querySelectorAll('[data-backup-provider]'));
    const backupStatusAlert = modal.querySelector('#backupStatusAlert');
    const backupFilenameInput = modal.querySelector('#backupFilenameInput');
    const backupFilenameGroup = modal.querySelector('#backupFilenameGroup');
    // Backups are one .mtbackup file; incremental snapshots belong to Sync
    const getBackupFormat = () => 'single';
    const getBackupProviderId = () => 'local';

    // Resolves where an incremental backup would be stored. `interactive` calls must come from a click,
    // since choosing a folder and re-granting access both need a user gesture.
    const resolveIncrementalTarget = async ({ interactive = false, provider = getBackupProviderId() } = {}) => {
        // @googleDrive:begin
        if (provider === 'google-drive') {
            const { isTokenValid, ensureFreshToken } = await import('./googleDrive.js');
            await ensureFreshToken();
            if (!isTokenValid()) return { status: 'needs-auth' };
            const { createDriveBackend } = await import('./driveBackup.js');
            return { status: 'ready', backend: createDriveBackend() };
        }
        // @googleDrive:end
        if (provider === 's3') {
            const { createS3Backend } = await import('./s3Backup.js');
            const backend = createS3Backend();
            return backend ? { status: 'ready', backend } : { status: 'needs-s3' };
        }
        if (provider === 'webdav') {
            const { createWebDavBackend } = await import('./webdavBackup.js');
            const backend = createWebDavBackend();
            return backend ? { status: 'ready', backend } : { status: 'needs-webdav' };
        }
        const folders = await import('./folderBackup.js');
        if (provider === 'icloud-drive') {
            const handle = await folders.getIcloudBackupFolder();
            return handle ? { status: 'ready', backend: folders.createFolderBackend(handle) } : { status: 'needs-icloud' };
        }
        let handle = await folders.getSavedBackupFolder();
        if (!handle && interactive) handle = await folders.pickBackupFolder();
        if (!handle) return { status: 'needs-folder' };
        const granted = interactive
            ? await folders.ensureFolderPermission(handle)
            : (await folders.queryFolderPermission(handle)) === 'granted';
        if (!granted) return { status: 'needs-permission', folderName: handle.name };
        return { status: 'ready', backend: folders.createFolderBackend(handle) };
    };

    const LAST_BACKUP_KEY = 'majestictab_last_backup_at';
    const lastBackupLine = modal.querySelector('#backupLastLine');
    const showLastBackup = () => {
        if (!lastBackupLine) return;
        let at = 0;
        try { at = Number(localStorage.getItem(LAST_BACKUP_KEY)) || 0; } catch { /* storage unavailable */ }
        lastBackupLine.textContent = at
            ? `Last backup ${new Date(at).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
            : 'No backup made on this device yet';
    };
    showLastBackup();

    const runBackupToProvider = async (btn, providerId, providerLabel) => {
        let filename = (backupFilenameInput?.value || '').trim();
        if (!filename) filename = `MajesticTab-backup-${new Date().toISOString().split('T')[0]}.mtbackup`;
        if (filename.toLowerCase().endsWith('.json')) {
            filename = filename.slice(0, -5) + '.mtbackup';
        }
        if (!filename.toLowerCase().endsWith('.mtbackup')) {
            filename += '.mtbackup';
        }

        const origText = btn.textContent;
        backupProviderBtns.forEach((b) => { b.disabled = true; });
        btn.textContent = 'Backing up…';
        showTaskProgress(backupStatusAlert, { label: 'Packaging songs…' });

        try {
            const { createMtBackup } = await import('./mtbackup.js');
            const made = await createMtBackup({
                onProgress: ({ phase, current, total, name }) => {
                    if (phase === 'songs' && total > 0) {
                        showTaskProgress(backupStatusAlert, { label: 'Packaging songs…', detail: `${current} of ${total}${name ? ` · ${name}` : ''}`, value: Math.round((current / total) * 80) });
                    } else if (phase === 'cloud' && total > 0) {
                        showTaskProgress(backupStatusAlert, { label: 'Downloading songs kept in the cloud…', detail: `${current} of ${total}${name ? ` · ${name}` : ''}`, value: 80 + Math.round((current / total) * 10) });
                    } else if (phase === 'writing') {
                        showTaskProgress(backupStatusAlert, { label: 'Writing the backup file…', value: 90 });
                    }
                }
            });
            const savedBytes = made.blob.size;

            showTaskProgress(backupStatusAlert, { label: `Saving to ${providerLabel}…`, detail: formatBytes(savedBytes) });
            // A browser download keeps reading the file after saveToProvider returns, so its temporary files go later
            try { await saveToProvider(providerId, made.blob, filename); } finally { if (providerId === 'local') setTimeout(() => made.release?.(), 30 * 60 * 1000); else await made.release?.(); }

            try { localStorage.setItem(LAST_BACKUP_KEY, String(Date.now())); } catch { /* storage unavailable */ }
            showLastBackup();
            const note = made.skipped.length ? ` · ${made.skipped.length} song${made.skipped.length === 1 ? '' : 's'} could not be packed: ${made.skipped.slice(0, 3).map(x => x.title).join(', ')}${made.skipped.length > 3 ? '…' : ''}` : '';
            showTaskResult(backupStatusAlert, made.skipped.length ? 'warn' : 'done', `Backup saved (${formatBytes(savedBytes)}) · ${made.summary.packs} song${made.summary.packs === 1 ? '' : 's'}${note}`);
            btn.textContent = 'Saved';
            setTimeout(() => {
                backupProviderBtns.forEach((b) => { b.disabled = false; });
                btn.textContent = origText;
            }, 3000);
        } catch (err) {
            console.error('Backup creation failed:', err);
            showTaskResult(backupStatusAlert, 'error', `Could not save the backup. ${err.message}`);
            backupProviderBtns.forEach((b) => { b.disabled = false; });
            btn.textContent = origText;
        }
    };

    backupProviderBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            const providerId = btn.dataset.backupProvider || 'local';
            const providerLabel = btn.dataset.providerName || providerId;
            runBackupToProvider(btn, providerId, providerLabel);
        });
    });

    // --- RESTORE FILE PICKING & INSPECTION ---
    const restoreFileInput = modal.querySelector('#restoreFileInput');
    const restoreBrowseBtn = modal.querySelector('#restoreBrowseBtn');
    const restoreDropzone = modal.querySelector('#restoreDropzone');
    const restoreInspectionCard = modal.querySelector('#restoreInspectionCard');
    const restoreExecuteBtn = modal.querySelector('#restoreExecuteBtn');
    const restoreStatusAlert = modal.querySelector('#restoreStatusAlert');
    const wipeConfirmContainer = modal.querySelector('#wipeConfirmContainer');
    const wipeConfirmCheckbox = modal.querySelector('#wipeConfirmCheckbox');

    restoreBrowseBtn?.addEventListener('click', () => restoreFileInput?.click());

    // @googleDrive:begin
    const restoreDriveBtn = modal.querySelector('#restoreDriveBtn');
    // @googleDrive:end
    const restoreDriveContainer = modal.querySelector('#restoreDriveContainer');
    const restoreDriveCloseBtn = modal.querySelector('#restoreDriveCloseBtn');
    const restoreDriveLoading = modal.querySelector('#restoreDriveLoading');
    const restoreDriveEmpty = modal.querySelector('#restoreDriveEmpty');
    const restoreDriveError = modal.querySelector('#restoreDriveError');
    const restoreDriveList = modal.querySelector('#restoreDriveList');

    const restoreFolderBtn = modal.querySelector('#restoreFolderBtn');
    const restoreSourceIcon = modal.querySelector('#restoreSourceIcon');
    const restoreSourceTitle = modal.querySelector('#restoreSourceTitle');
    const restoreSourceLocation = modal.querySelector('#restoreSourceLocation');
    const restoreChangeLocationBtn = modal.querySelector('#restoreChangeLocationBtn');
    // @googleDrive:begin
    const restoreDrivePickBtn = modal.querySelector('#restoreDrivePickBtn');
    // @googleDrive:end
    const restoreDriveEmptyText = modal.querySelector('#restoreDriveEmptyText');
    // d-inline-flex is !important, so visibility is toggled by swapping classes rather than inline display
    if (restoreFolderBtn && isFolderBackupSupported()) {
        restoreFolderBtn.classList.remove('d-none');
        restoreFolderBtn.classList.add('d-inline-flex');
    }

    const restoreIcloudBtn = modal.querySelector('#restoreIcloudBtn');
    if (restoreIcloudBtn && isIcloudDriveSupported()) {
        restoreIcloudBtn.classList.remove('d-none');
        restoreIcloudBtn.classList.add('d-inline-flex');
    }

    // Which storage the snapshot list currently shows; set by loadGoogleDriveBackups / loadFolderBackups
    let activeSource = { type: 'drive', backend: null };

    // @googleDrive:begin
    const loadGoogleDriveBackups = async () => {
        const { isTokenValid, ensureFreshToken, redirectToGoogleAuth, fetchDriveBackups } = await import('./googleDrive.js');

        await ensureFreshToken();
        if (!isTokenValid()) {
            redirectToGoogleAuth('restore_backup');
            return;
        }

        if (restoreDriveContainer) restoreDriveContainer.style.display = 'block';
        if (restoreDriveLoading) restoreDriveLoading.style.display = 'block';
        if (restoreDriveEmpty) restoreDriveEmpty.style.display = 'none';
        if (restoreDriveError) restoreDriveError.style.display = 'none';
        if (restoreDriveList) restoreDriveList.innerHTML = '';
        if (restoreDriveBtn) restoreDriveBtn.disabled = true;

        try {
            const { createDriveBackend } = await import('./driveBackup.js');
            const { listIncrementalBackups } = await import('./incrementalBackup.js');
            const backend = createDriveBackend();
            activeSource = { type: 'drive', backend };
            restoreChangeLocationBtn?.classList.add('d-none');
            restoreDrivePickBtn?.classList.remove('d-none');
            if (restoreSourceIcon) restoreSourceIcon.className = 'icon-gdrive';
            if (restoreSourceTitle) restoreSourceTitle.textContent = 'Google Drive Backups:';
            if (restoreSourceLocation) restoreSourceLocation.textContent = backend.location;
            if (restoreDriveEmptyText) restoreDriveEmptyText.textContent = 'No backups found in this Google Drive folder.';
            const [legacyBackups, incrementalBackups] = await Promise.all([
                fetchDriveBackups(),
                listIncrementalBackups(backend).catch(err => {
                    console.warn('Could not list incremental Drive backups:', err);
                    return [];
                })
            ]);
            const backups = [
                ...incrementalBackups.map(b => ({ ...b, incremental: true, modifiedTime: b.exportedAt })),
                ...legacyBackups
            ].sort((a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0));
            if (restoreDriveLoading) restoreDriveLoading.style.display = 'none';
            if (restoreDriveBtn) restoreDriveBtn.disabled = false;

            if (!backups || backups.length === 0) {
                if (restoreDriveEmpty) restoreDriveEmpty.style.display = 'block';
                return;
            }

            renderDriveBackupsList(backups);
        } catch (err) {
            console.error('Failed to fetch Drive backups:', err);
            if (restoreDriveLoading) restoreDriveLoading.style.display = 'none';
            if (restoreDriveBtn) restoreDriveBtn.disabled = false;
            if (restoreDriveError) {
                restoreDriveError.style.display = 'block';
                restoreDriveError.textContent = `Could not load backups from Google Drive: ${err.message}`;
            }
        }
    };
    // @googleDrive:end

    // Lists snapshots in a local backup folder. Must start from a click (folder access needs a gesture).
    const loadFolderBackups = async ({ pickNew = false, icloud = false } = {}) => {
        const folders = await import('./folderBackup.js');
        try {
            let handle;
            if (icloud) {
                handle = await folders.getIcloudBackupFolder();
                if (!handle) {
                    showToast('iCloud Drive is not available. Turn it on in Settings > Apple Account > iCloud.', 'warning');
                    return;
                }
            } else {
                handle = pickNew ? null : await folders.getSavedBackupFolder();
                if (!handle) handle = await folders.pickBackupFolder();
            }
            if (!handle) return;
            if (!icloud && !(await folders.ensureFolderPermission(handle))) {
                showToast('Access to the backup folder was not granted.', 'warning');
                return;
            }

            const backend = folders.createFolderBackend(handle);
            activeSource = { type: icloud ? 'icloud' : 'folder', backend };
            restoreChangeLocationBtn?.classList.toggle('d-none', icloud);
            restoreDrivePickBtn?.classList.add('d-none');
            if (restoreDriveContainer) restoreDriveContainer.style.display = 'block';
            if (restoreDriveLoading) restoreDriveLoading.style.display = 'block';
            if (restoreDriveEmpty) restoreDriveEmpty.style.display = 'none';
            if (restoreDriveError) restoreDriveError.style.display = 'none';
            if (restoreDriveList) restoreDriveList.innerHTML = '';
            if (restoreSourceIcon) restoreSourceIcon.className = icloud ? 'bi-cloud text-info' : 'bi-hdd text-primary';
            if (restoreSourceTitle) restoreSourceTitle.textContent = icloud ? 'iCloud Drive:' : 'Backup Folder:';
            if (restoreSourceLocation) restoreSourceLocation.textContent = backend.location;
            if (restoreDriveEmptyText) restoreDriveEmptyText.textContent = icloud ? 'No snapshots found in iCloud Drive.' : 'No snapshots found in this folder.';

            const { listIncrementalBackups } = await import('./incrementalBackup.js');
            const backups = (await listIncrementalBackups(backend))
                .map(b => ({ ...b, incremental: true, modifiedTime: b.exportedAt }));
            if (restoreDriveLoading) restoreDriveLoading.style.display = 'none';
            if (!backups.length) {
                if (restoreDriveEmpty) restoreDriveEmpty.style.display = 'block';
                return;
            }
            renderDriveBackupsList(backups);
        } catch (err) {
            console.error('Failed to read backup folder:', err);
            if (restoreDriveLoading) restoreDriveLoading.style.display = 'none';
            if (restoreDriveError) {
                restoreDriveError.style.display = 'block';
                restoreDriveError.textContent = `Could not read the backup folder: ${err.message}`;
            }
        }
    };

    // Not connected yet: show the connection form in the restore list instead of sending the user elsewhere
    const showRestoreConnectForm = async (kind, reload) => {
        const isS3 = kind === 's3';
        const ui = isS3 ? await import('./s3Ui.js') : await import('./webdavUi.js');
        restoreChangeLocationBtn?.classList.add('d-none');
        restoreDrivePickBtn?.classList.add('d-none');
        if (restoreDriveContainer) restoreDriveContainer.style.display = 'block';
        if (restoreDriveLoading) restoreDriveLoading.style.display = 'none';
        if (restoreDriveEmpty) restoreDriveEmpty.style.display = 'none';
        if (restoreDriveError) restoreDriveError.style.display = 'none';
        if (restoreSourceIcon) restoreSourceIcon.className = isS3 ? 'bi-hdd-network text-warning' : 'bi-hdd-rack text-info';
        if (restoreSourceTitle) restoreSourceTitle.textContent = isS3 ? 'S3 Bucket:' : 'WebDAV:';
        if (restoreSourceLocation) restoreSourceLocation.textContent = 'Not connected';
        if (!restoreDriveList) return;
        restoreDriveList.innerHTML = `<div class="small text-white-50 mb-2">${isS3 ? 'Enter your S3 bucket details to see its backups.' : 'Enter your WebDAV server details to see its backups.'}</div>${isS3 ? ui.s3ConfigFormHtml({}) : ui.webdavConfigFormHtml({})}<div class="small text-warning mt-2" data-restore-connect-error style="display:none;"></div><div class="mt-2"><button type="button" class="btn btn-sm btn-theme-primary px-3" data-restore-connect>Connect and view backups</button></div>`;
        const errEl = restoreDriveList.querySelector('[data-restore-connect-error]');
        const btn = restoreDriveList.querySelector('[data-restore-connect]');
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            errEl.style.display = 'none';
            try {
                if (isS3) await ui.saveS3ConfigFromForm(restoreDriveList);
                else await ui.saveWebDavConfigFromForm(restoreDriveList);
                await reload();
            } catch (err) {
                errEl.textContent = err?.message || 'Could not connect';
                errEl.style.display = 'block';
                btn.disabled = false;
            }
        });
    };

    // Lists snapshots in the connected S3 bucket
    const loadS3Backups = async () => {
        try {
            const { createS3Backend } = await import('./s3Backup.js');
            const backend = createS3Backend();
            if (!backend) {
                await showRestoreConnectForm('s3', loadS3Backups);
                return;
            }
            activeSource = { type: 's3', backend };
            restoreChangeLocationBtn?.classList.add('d-none');
            restoreDrivePickBtn?.classList.add('d-none');
            if (restoreDriveContainer) restoreDriveContainer.style.display = 'block';
            if (restoreDriveLoading) restoreDriveLoading.style.display = 'block';
            if (restoreDriveEmpty) restoreDriveEmpty.style.display = 'none';
            if (restoreDriveError) restoreDriveError.style.display = 'none';
            if (restoreDriveList) restoreDriveList.innerHTML = '';
            if (restoreSourceIcon) restoreSourceIcon.className = 'bi-hdd-network text-warning';
            if (restoreSourceTitle) restoreSourceTitle.textContent = 'S3 Bucket:';
            if (restoreSourceLocation) restoreSourceLocation.textContent = backend.location;
            if (restoreDriveEmptyText) restoreDriveEmptyText.textContent = 'No snapshots found in this bucket.';

            const { listIncrementalBackups } = await import('./incrementalBackup.js');
            const backups = (await listIncrementalBackups(backend))
                .map(b => ({ ...b, incremental: true, modifiedTime: b.exportedAt }));
            if (restoreDriveLoading) restoreDriveLoading.style.display = 'none';
            if (!backups.length) {
                if (restoreDriveEmpty) restoreDriveEmpty.style.display = 'block';
                return;
            }
            renderDriveBackupsList(backups);
        } catch (err) {
            console.error('Failed to read S3 backups:', err);
            if (restoreDriveLoading) restoreDriveLoading.style.display = 'none';
            if (restoreDriveError) {
                restoreDriveError.style.display = 'block';
                restoreDriveError.textContent = `Could not read the bucket: ${err.message}`;
            }
        }
    };

    // Lists snapshots in the connected WebDAV server
    const loadWebDavBackups = async () => {
        try {
            const { createWebDavBackend } = await import('./webdavBackup.js');
            const backend = createWebDavBackend();
            if (!backend) {
                await showRestoreConnectForm('webdav', loadWebDavBackups);
                return;
            }
            activeSource = { type: 'webdav', backend };
            restoreChangeLocationBtn?.classList.add('d-none');
            restoreDrivePickBtn?.classList.add('d-none');
            if (restoreDriveContainer) restoreDriveContainer.style.display = 'block';
            if (restoreDriveLoading) restoreDriveLoading.style.display = 'block';
            if (restoreDriveEmpty) restoreDriveEmpty.style.display = 'none';
            if (restoreDriveError) restoreDriveError.style.display = 'none';
            if (restoreDriveList) restoreDriveList.innerHTML = '';
            if (restoreSourceIcon) restoreSourceIcon.className = 'bi-hdd-rack text-info';
            if (restoreSourceTitle) restoreSourceTitle.textContent = 'WebDAV:';
            if (restoreSourceLocation) restoreSourceLocation.textContent = backend.location;
            if (restoreDriveEmptyText) restoreDriveEmptyText.textContent = 'No snapshots found on this server.';

            const { listIncrementalBackups } = await import('./incrementalBackup.js');
            const backups = (await listIncrementalBackups(backend))
                .map(b => ({ ...b, incremental: true, modifiedTime: b.exportedAt }));
            if (restoreDriveLoading) restoreDriveLoading.style.display = 'none';
            if (!backups.length) {
                if (restoreDriveEmpty) restoreDriveEmpty.style.display = 'block';
                return;
            }
            renderDriveBackupsList(backups);
        } catch (err) {
            console.error('Failed to read WebDAV backups:', err);
            if (restoreDriveLoading) restoreDriveLoading.style.display = 'none';
            if (restoreDriveError) {
                restoreDriveError.style.display = 'block';
                restoreDriveError.textContent = `Could not read the server: ${err.message}`;
            }
        }
    };

    restoreFolderBtn?.addEventListener('click', () => loadFolderBackups());
    modal.querySelector('#restoreS3Btn')?.addEventListener('click', loadS3Backups);
    modal.querySelector('#restoreWebDavBtn')?.addEventListener('click', loadWebDavBackups);
    restoreIcloudBtn?.addEventListener('click', () => loadFolderBackups({ icloud: true }));
    restoreChangeLocationBtn?.addEventListener('click', async () => {
        if (activeSource.type === 'folder') loadFolderBackups({ pickNew: true });
    });

    const renderDriveBackupsList = (backups) => {
        if (!restoreDriveList) return;
        restoreDriveList.innerHTML = '';

        backups.forEach(b => {
            const dateStr = b.modifiedTime
                ? new Date(b.modifiedTime).toLocaleString(undefined, {
                    year: 'numeric', month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                })
                : 'Unknown date';
            const sizeStr = formatBytes(b.size);
            const title = b.incremental ? `Snapshot · ${dateStr}` : b.name;
            const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
            const subtitle = b.incremental
                ? (b.counts
                    ? [plural(b.counts.tabs, 'tab'), b.counts.soundFonts ? plural(b.counts.soundFonts, 'SoundFont') : null, b.counts.audio ? plural(b.counts.audio, 'audio file') : null].filter(Boolean).join(' • ')
                    : 'Incremental snapshot')
                : `${dateStr} • ${sizeStr}`;

            const item = document.createElement('div');
            item.className = 'drive-backup-item d-flex align-items-center justify-content-between p-2 rounded-2';
            item.style.cursor = 'pointer';
            item.setAttribute('data-file-id', b.id);
            item.setAttribute('data-file-name', b.name);
            item.innerHTML = `
                <div class="d-flex align-items-center gap-2 min-w-0 me-2 text-start">
                    <div class="text-truncate">
                        <div class="fw-semibold text-white small text-truncate" title="${escapeHtml(b.name)}">${escapeHtml(title)}</div>
                        <div class="text-white-50" style="font-size: 0.7rem;">${escapeHtml(subtitle)}</div>
                    </div>
                </div>
                <div class="d-flex align-items-center gap-2 flex-shrink-0 ms-2">
                    <button type="button" class="btn btn-sm btn-theme-outline px-2 py-1 select-drive-backup-btn" style="font-size: 0.72rem;">
                        Select
                    </button>
                </div>
            `;

            const onSelect = async (e) => {
                e.stopPropagation();
                restoreDriveList.querySelectorAll('.drive-backup-item').forEach(el => {
                    el.style.pointerEvents = 'none';
                    el.style.opacity = '0.6';
                });
                const btn = item.querySelector('.select-drive-backup-btn');
                if (btn) {
                    btn.disabled = true;
                    btn.textContent = 'Loading…';
                }

                const dlProgress = modal.querySelector('#restoreDriveDownloadProgress');
                showTaskProgress(dlProgress, { label: `Downloading ${b.name}…`, detail: `0 B of ${formatBytes(b.size || 0)}`, value: 0 });

                try {
                    if (b.incremental) {
                        // Only the small manifest is fetched now; tab data downloads during restore
                        const { loadIncrementalBundle } = await import('./incrementalBackup.js');
                        const bundle = await loadIncrementalBundle(activeSource.backend, b);
                        bundle.name = `Snapshot · ${dateStr}`;
                        bundle.size = bundle.summary?.totalTabsSize || 0;
                        clearTaskStatus(dlProgress);
                        await handleSelectedBackupFile(bundle, activeSource.type === 'folder' ? 'Backup Folder' : activeSource.type === 'icloud' ? 'iCloud Drive' : activeSource.type === 's3' ? 'S3 Bucket' : activeSource.type === 'webdav' ? 'WebDAV' : 'Google Drive');
                        return;
                    }
                    // @googleDrive:begin
                    const { downloadDriveBackupFile } = await import('./googleDrive.js');
                    const fileObj = await downloadDriveBackupFile(b.id, b.name, ({ loaded, total, percent }) => {
                        showTaskProgress(dlProgress, { label: `Downloading ${b.name}…`, detail: `${formatBytes(loaded)} of ${formatBytes(total || b.size || loaded)}`, value: percent });
                        if (btn) btn.textContent = `${percent}%`;
                    });
                    clearTaskStatus(dlProgress);
                    await handleSelectedBackupFile(fileObj, 'Google Drive');
                    // @googleDrive:end
                } catch (dlErr) {
                    clearTaskStatus(dlProgress);
                    console.error('Failed to download Drive backup:', dlErr);
                    if (restoreDriveError) {
                        restoreDriveError.style.display = 'block';
                        // @googleDrive:begin
                        const isAuthError = dlErr.message.includes('authorization') || dlErr.message.includes('expired') || dlErr.message.includes('connect');
                        if (isAuthError) {
                            restoreDriveError.innerHTML = `
                                <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                                    <span>Failed to download "${escapeHtml(b.name)}": ${escapeHtml(dlErr.message)}</span>
                                    <button type="button" class="btn btn-sm btn-theme-outline" id="restoreDriveReconnectBtn">
                                        <i class="bi-box-arrow-in-right me-1"></i> Reconnect Google Drive
                                    </button>
                                </div>
                            `;
                            modal.querySelector('#restoreDriveReconnectBtn')?.addEventListener('click', async () => {
                                const { redirectToGoogleAuth } = await import('./googleDrive.js');
                                redirectToGoogleAuth('restore_backup');
                            });
                        } else {
                        // @googleDrive:end
                            restoreDriveError.textContent = `Failed to download "${b.name}": ${dlErr.message}`;
                        // @googleDrive:begin
                        }
                        // @googleDrive:end
                    }
                    restoreDriveList.querySelectorAll('.drive-backup-item').forEach(el => {
                        el.style.pointerEvents = '';
                        el.style.opacity = '';
                    });
                    if (btn) {
                        btn.disabled = false;
                        btn.textContent = 'Select';
                    }
                }
            };

            item.addEventListener('click', onSelect);
            item.querySelector('.select-drive-backup-btn')?.addEventListener('click', onSelect);

            restoreDriveList.appendChild(item);
        });
    };

    // @googleDrive:begin
    restoreDriveBtn?.addEventListener('click', loadGoogleDriveBackups);

    // A .mtbackup file the app didn't save itself: the user hands it over through the Google Picker
    restoreDrivePickBtn?.addEventListener('click', async () => {
        const { isTokenValid, ensureFreshToken, redirectToGoogleAuth, pickDriveFile, downloadDriveBackupFile } = await import('./googleDrive.js');
        try {
            await ensureFreshToken();
            if (!isTokenValid()) {
                redirectToGoogleAuth('restore_backup');
                return;
            }
            const doc = await pickDriveFile({ title: 'Select a .mtbackup file from Google Drive' });
            if (!doc) return;
            if (!doc.name.toLowerCase().endsWith('.mtbackup')) {
                showToast(`"${doc.name}" is not a .mtbackup file.`, 'warning');
                return;
            }
            await handleSelectedBackupFile(await downloadDriveBackupFile(doc.id, doc.name), 'Google Drive');
        } catch (err) {
            console.error('Failed to pick Drive backup:', err);
            showToast(err.message, 'error');
        }
    });
    if (options.autoLoadDrive) {
        loadGoogleDriveBackups();
    }
    // @googleDrive:end
    restoreDriveCloseBtn?.addEventListener('click', () => {
        if (restoreDriveContainer) restoreDriveContainer.style.display = 'none';
    });

    // @googleDrive:begin
    if (activeGoogleAuthHandler) {
        window.removeEventListener('googleAuthSuccess', activeGoogleAuthHandler);
    }
    const driveAccountRow = modal.querySelector('#driveAccountRow');
    const refreshDriveAccountRow = async () => {
        const { isGoogleDriveConnected } = await import('./googleDrive.js');
        const connected = await isGoogleDriveConnected();
        driveAccountRow?.classList.toggle('d-none', !connected);
        driveAccountRow?.classList.toggle('d-flex', connected);
    };
    refreshDriveAccountRow();
    if (activeDriveAccountHandler) window.removeEventListener('googleAuthChanged', activeDriveAccountHandler);
    activeDriveAccountHandler = () => {
        refreshDriveAccountRow();
    };
    window.addEventListener('googleAuthChanged', activeDriveAccountHandler);
    modal.querySelector('#driveDisconnectBtn')?.addEventListener('click', async () => {
        const { disconnectGoogleDrive } = await import('./googleDrive.js');
        disconnectGoogleDrive();
        showToast('Disconnected Google Drive on this device.', 'info');
    });

    activeGoogleAuthHandler = (e) => {
        refreshDriveAccountRow();
        if (e.detail?.state === 'restore_backup') {
            if (currentParsedBackup) return;
            loadGoogleDriveBackups();
        }
    };
    window.addEventListener('googleAuthSuccess', activeGoogleAuthHandler);
    // @googleDrive:end

    // Drag and drop handlers
    ['dragenter', 'dragover'].forEach(eventName => {
        restoreDropzone?.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            restoreDropzone.classList.add('drag-over');
        });
    });

    ['dragleave', 'drop'].forEach(eventName => {
        restoreDropzone?.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            restoreDropzone.classList.remove('drag-over');
        });
    });

    restoreDropzone?.addEventListener('drop', (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (file) handleSelectedBackupFile(file, 'Local Device');
    });

    restoreFileInput?.addEventListener('change', () => {
        const file = restoreFileInput.files?.[0];
        if (file) handleSelectedBackupFile(file, 'Local Device');
    });

    // For snapshot restores, show what this device would gain or lose; follows the Merge / Wipe choice
    const restoreIncrementalPreview = modal.querySelector('#restoreIncrementalPreview');
    let restorePreviewData = null;
    let restoreInspection = null;
    let restoreIsZip = false;   // the file is the ZIP format (mtbackup.js), not the older single JSON document
    const restoreAudioBox = modal.querySelector('#restoreAudioBox');
    // What the backup holds in audio, for the older snapshot formats whose summary does not show it. Audio is always restored.
    const renderRestoreAudioBox = (info) => {
        if (!restoreAudioBox) return;
        if (!info || !info.count) { restoreAudioBox.style.display = 'none'; return; }
        restoreAudioBox.style.display = 'block';
        const detail = `${plural(info.count, 'audio file')}, ${formatBytes(info.bytes)}${info.onDevice ? ` (${info.onDevice} already on this device)` : ''}`;
        restoreAudioBox.innerHTML = `
            <div class="small fw-semibold text-white"><i class="bi-file-earmark-music text-info me-1"></i> Audio files</div>
            <div class="small text-white-50 mt-1" style="font-size:0.75rem;">${escapeHtml(detail)}. They are restored with the rest.</div>`;
    };
    const renderRestorePreview = async () => {
        if (!restoreIncrementalPreview) return;
        const bundle = currentBackupFile;
        const isSnapshot = Array.isArray(bundle?.files) && bundle.files.some(f => f.blob);
        restoreIncrementalPreview.style.display = isSnapshot ? 'block' : 'none';
        if (!isSnapshot) {
            restorePreviewData = null;
            renderRestoreAudioBox(restoreInspection?.audioCount ? { count: restoreInspection.audioCount, bytes: restoreInspection.audioBytes || 0, onDevice: 0 } : null);
            return;
        }

        try {
            if (!restorePreviewData || restorePreviewData.bundle !== bundle) {
                restoreIncrementalPreview.innerHTML = waitingHtml('Comparing with this device…');
                const { previewIncrementalRestore } = await import('./incrementalBackup.js');
                restorePreviewData = { bundle, summary: await previewIncrementalRestore(bundle) };
                if (currentBackupFile !== bundle) return;
            }
            const p = restorePreviewData.summary;
            const wipe = modal.querySelector('input[name="restoreModeRadio"]:checked')?.value === 'wipe';
            const stats = wipe
                ? [changeStatHtml(p.total, 'Tabs restored', 'text-success'), changeStatHtml(p.localOnly, 'Erased from device', 'text-warning')]
                : [changeStatHtml(p.missing, 'Tabs to restore', 'text-success'), changeStatHtml(p.same + p.differs, 'Already on device', 'text-white'), changeStatHtml(p.localOnly, 'Only on device (kept)', 'text-info')];
            const a = p.audio;
            renderRestoreAudioBox(a.total ? {
                count: wipe ? a.total : a.missing, bytes: wipe ? a.totalBytes : a.missingBytes, onDevice: wipe ? 0 : a.same
            } : null);
            const bytes = wipe ? p.totalBytes : p.missingBytes;
            const note = wipe
                ? `About ${formatBytes(bytes)} to restore. Everything currently stored on this device is replaced.`
                : p.missing
                    ? `About ${formatBytes(bytes)} to download. Tabs already on this device are left as they are${p.differs ? ` (${p.differs} differ from the snapshot)` : ''}.`
                    : 'Nothing to download. Library and settings are still merged from the snapshot.';
            restoreIncrementalPreview.innerHTML = `
                <div class="small fw-semibold text-white mb-2"><i class="bi-clock-history text-info me-1"></i> What restoring this snapshot would do</div>
                <div class="row g-2">${stats.join('')}</div>
                <div class="small text-white-50 mt-2" style="font-size:0.75rem;">${note}</div>`;
        } catch (err) {
            restoreIncrementalPreview.innerHTML = `<div class="small text-warning"><i class="bi-exclamation-triangle me-1"></i> Could not compare with this device: ${escapeHtml(err.message)}</div>`;
        }
    };

    const handleSelectedBackupFile = async (file, source = 'Local Device') => {
        try {
            const fileName = file?.name || 'backup.mtbackup';
            if (file?.format !== 'majestictab_backup' && !fileName.toLowerCase().endsWith('.mtbackup')) {
                restoreStatusAlert.style.display = 'block';
                restoreStatusAlert.className = 'small mb-2 text-danger fw-semibold text-center';
                restoreStatusAlert.textContent = 'Only .mtbackup backup files are supported.';
                restoreInspectionCard.style.display = 'none';
                restoreDropzone.style.display = 'block';
                restoreExecuteBtn.disabled = true;
                return;
            }

            showTaskProgress(restoreStatusAlert, { label: 'Reading and verifying the backup…', detail: formatBytes(file.size) });
            restoreInspectionCard.style.display = 'none';
            restoreExecuteBtn.disabled = true;

            // Allow UI to render spinner before decompressing/parsing
            await new Promise(resolve => setTimeout(resolve, 50));

            restoreIsZip = false;
            const mt = await import('./mtbackup.js');
            const isZip = (await mt.backupKindOfFile(file)) === 'zip';
            let inspection;
            if (isZip) {
                try {
                    const info = await mt.inspectMtBackup(file);
                    inspection = { valid: true, zip: true, info, exportedAt: info.exportedAt ? new Date(info.exportedAt).toLocaleString() : 'Unknown date' };
                } catch (err) {
                    inspection = { valid: false, error: err.message };
                }
            } else {
                inspection = await inspectBackupFile(file);
            }

            if (!inspection.valid) {
                restoreStatusAlert.style.display = 'block';
                restoreStatusAlert.className = 'small mb-2 text-danger fw-semibold';
                restoreStatusAlert.textContent = inspection.error;
                restoreInspectionCard.style.display = 'none';
                restoreExecuteBtn.disabled = true;
                try { showToast(`Backup verification failed: ${inspection.error}`, 'error'); } catch (_) {}
                return;
            }

            currentBackupFile = file;
            currentParsedBackup = inspection.zip ? null : (inspection.data || inspection);
            restoreInspection = inspection;
            restoreIsZip = Boolean(inspection.zip);
            const legacyCounts = modal.querySelector('#restoreCountsLegacy');
            const packCounts = modal.querySelector('#restoreCountsPacks');
            if (legacyCounts) legacyCounts.style.display = restoreIsZip ? 'none' : '';
            if (packCounts) {
                packCounts.style.display = restoreIsZip ? '' : 'none';
                if (restoreIsZip) {
                    const i = inspection.info;
                    const parts = [`<span class="text-white fw-medium">${i.songs}</span> song${i.songs === 1 ? '' : 's'}`];
                    if (i.soundFonts) parts.push(`<span class="text-white fw-medium">${i.soundFonts}</span> SoundFont${i.soundFonts === 1 ? '' : 's'}`);
                    if (i.setlists) parts.push(`<span class="text-white fw-medium">${i.setlists}</span> setlist${i.setlists === 1 ? '' : 's'}`);
                    parts.push(formatBytes(i.bytes || 0));
                    packCounts.innerHTML = parts.join(' · ') + (i.missing?.length ? `<div class="text-warning mt-1">${i.missing.length} file${i.missing.length === 1 ? ' is' : 's are'} missing from this backup. The rest can be restored.</div>` : '');
                }
            }

            // Populate Inspection Card
            const filenameLabel = modal.querySelector('#restoreFilenameLabel');
            if (filenameLabel) {
                filenameLabel.textContent = `${source !== 'Local Device' ? `${source}: ` : ''}${fileName}`;
            }
            const expDateEl = modal.querySelector('#restoreExportedDate');
            if (expDateEl) expDateEl.textContent = inspection.exportedAt || 'Unknown date';
            const tabsCountEl = modal.querySelector('#restoreTabsCount');
            if (tabsCountEl) tabsCountEl.textContent = inspection.tabsCount ?? 0;
            const songsCountEl = modal.querySelector('#restoreSongsCount');
            if (songsCountEl) songsCountEl.textContent = inspection.songsCount ?? 0;

            renderRestorePreview();

            requestAnimationFrame(() => {
                restoreDropzone.style.display = 'none';
                restoreStatusAlert.style.display = 'none';
                restoreInspectionCard.style.display = 'block';
                restoreExecuteBtn.disabled = false;
                updateRestoreBtnState();
            });
        } catch (err) {
            console.error('Failed to read or verify backup file:', err);
            restoreStatusAlert.style.display = 'block';
            restoreStatusAlert.className = 'small mb-2 text-danger fw-semibold';
            restoreStatusAlert.textContent = `Could not read backup file: ${err.message}`;
            restoreInspectionCard.style.display = 'none';
            restoreDropzone.style.display = 'block';
            restoreExecuteBtn.disabled = true;
            try { showToast(`Could not read backup file: ${err.message}`, 'error'); } catch (_) {}
        }
    };
    modal._handleSelectedBackupFile = handleSelectedBackupFile;

    // Mode Radio Change (Show wipe confirmation)
    const modeRadios = modal.querySelectorAll('input[name="restoreModeRadio"]');
    const updateRestoreBtnState = () => {
        const isWipe = modal.querySelector('input[name="restoreModeRadio"]:checked')?.value === 'wipe';
        if (restoreExecuteBtn && !restoreExecuteBtn.disabled) {
            if (isWipe) {
                restoreExecuteBtn.classList.remove('btn-theme-primary');
                restoreExecuteBtn.classList.add('btn-theme-danger');
                restoreExecuteBtn.textContent = 'Erase and restore';
            } else {
                restoreExecuteBtn.classList.remove('btn-theme-danger');
                restoreExecuteBtn.classList.add('btn-theme-primary');
                restoreExecuteBtn.textContent = 'Restore backup';
            }
        }
    };
    modeRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.value === 'wipe') {
                wipeConfirmContainer.style.display = 'flex';
            } else {
                wipeConfirmContainer.style.display = 'none';
                wipeConfirmCheckbox.checked = false;
            }
            updateRestoreBtnState();
            renderRestorePreview();
        });
    });

    // Change File Button
    modal.querySelector('#restoreChangeFileBtn')?.addEventListener('click', () => {
        currentBackupFile = null;
        currentParsedBackup = null;
        restoreIsZip = false;
        restoreInspectionCard.style.display = 'none';
        restoreDropzone.style.display = 'block';
        restoreExecuteBtn.disabled = true;
        restoreExecuteBtn.classList.remove('btn-theme-danger');
        restoreExecuteBtn.classList.add('btn-theme-primary');
        restoreExecuteBtn.textContent = 'Restore backup';
        restoreFileInput.value = '';
    });

    // --- RESTORE ACTION ---
    restoreExecuteBtn?.addEventListener('click', async () => {
        if (!currentBackupFile && !currentParsedBackup) return;

        const selectedModeEl = modal.querySelector('input[name="restoreModeRadio"]:checked');
        const mode = selectedModeEl?.value || 'merge';

        if (mode === 'wipe' && !wipeConfirmCheckbox.checked) {
            showTaskResult(restoreStatusAlert, 'warn', 'Tick the box to confirm before wiping and replacing.');
            return;
        }

        restoreExecuteBtn.disabled = true;
        restoreExecuteBtn.textContent = 'Restoring…';
        const restoreLabel = mode === 'wipe' ? 'Wiping and restoring from the backup…' : 'Merging missing tabs and settings…';
        showTaskProgress(restoreStatusAlert, { label: restoreLabel });

        try {
            if (restoreIsZip && currentBackupFile instanceof Blob) {
                const { restoreMtBackup } = await import('./mtbackup.js');
                const r = await restoreMtBackup(currentBackupFile, {
                    mode,
                    onProgress: ({ current, total, name }) => {
                        if (total > 0) showTaskProgress(restoreStatusAlert, { label: 'Restoring songs…', detail: `${current} of ${total}${name ? ` · ${name}` : ''}`, value: (current / total) * 100 });
                    }
                });
                const parts = [];
                if (r.songs) parts.push(`${r.songs} song${r.songs === 1 ? '' : 's'} restored`);
                if (r.skippedSongs) parts.push(`${r.skippedSongs} already here, kept`);
                if (r.soundFonts) parts.push(`${r.soundFonts} SoundFont${r.soundFonts === 1 ? '' : 's'}`);
                if (r.setlists) parts.push(`${r.setlists} setlist${r.setlists === 1 ? '' : 's'}`);
                if (r.failed.length) parts.push(`${r.failed.length} could not be restored`);
                if (r.missing.length) parts.push(`${r.missing.length} missing from the file`);
                showTaskResult(restoreStatusAlert, r.failed.length || r.missing.length ? 'warn' : 'done',
                    `<strong>${mode === 'wipe' ? 'Restored, replacing what was here' : 'Restored and merged'}</strong><span class="task-status-detail">${escapeHtml(parts.join(' · ') || 'Everything was already up to date')}</span>`,
                    { html: true });
                try { const { renderLibraryModal } = await import('./libraryModal.js'); await renderLibraryModal(); } catch (e) { console.warn('Could not refresh library view:', e); }
                restoreExecuteBtn.textContent = 'Restored';
                setTimeout(() => { restoreExecuteBtn.disabled = false; restoreExecuteBtn.textContent = 'Restore backup'; }, 3000);
                return;
            }
            const results = await restoreBackup(currentBackupFile || currentParsedBackup, {
                mode,
                onProgress: (current, total) => {
                    if (total > 0) {
                        showTaskProgress(restoreStatusAlert, { label: 'Restoring files…', detail: `${current} of ${total}`, value: (current / total) * 100 });
                    }
                }
            });

            currentParsedBackup = null;

            const details = [];
            if (results.filesImported > 0) details.push(`${results.filesImported} tabs imported`);
            if (results.soundFontsImported > 0) details.push(`${results.soundFontsImported} SoundFonts imported`);
            if (results.audioImported > 0) details.push(`${results.audioImported} audio files imported`);
            if (results.filesSkipped > 0) details.push(`${results.filesSkipped} existing tabs kept`);
            if (results.songsImported > 0) details.push(`${results.songsImported} library songs added/merged`);
            if (results.settingsApplied > 0) details.push('settings restored');

            const summaryStr = details.length > 0 ? details.join(' · ') : 'Everything was already up to date';
            showTaskResult(restoreStatusAlert, 'done',
                `<strong>${mode === 'wipe' ? 'Restored, replacing what was here' : 'Restored and merged'}</strong><span class="task-status-detail">${escapeHtml(summaryStr)}</span>`,
                { html: true });

            // Auto-refresh Tab Library UI
            try {
                const { renderLibraryModal } = await import('./libraryModal.js');
                await renderLibraryModal();
            } catch (e) {
                console.warn('Could not refresh library view:', e);
            }

            restoreExecuteBtn.textContent = 'Restored';
            setTimeout(() => {
                restoreExecuteBtn.disabled = false;
                restoreExecuteBtn.textContent = 'Restore backup';
            }, 3000);
        } catch (err) {
            console.error('Restore failed:', err);
            showTaskResult(restoreStatusAlert, 'error', `Could not restore the backup. ${err.message}`);
            restoreExecuteBtn.disabled = false;
            restoreExecuteBtn.textContent = 'Try again';
        }
    });

    // --- DELETE ALL DATA ACTION ---
    const deleteAllConfirmCheckbox = modal.querySelector('#deleteAllConfirmCheckbox');
    const deleteExecuteBtn = modal.querySelector('#deleteExecuteBtn');
    const deleteStatusAlert = modal.querySelector('#deleteStatusAlert');

    deleteAllConfirmCheckbox?.addEventListener('change', () => {
        if (deleteExecuteBtn) {
            deleteExecuteBtn.disabled = !deleteAllConfirmCheckbox.checked;
        }
    });

    deleteExecuteBtn?.addEventListener('click', async () => {
        if (!deleteAllConfirmCheckbox?.checked) return;

        deleteExecuteBtn.disabled = true;
        deleteExecuteBtn.textContent = 'Deleting…';
        showTaskProgress(deleteStatusAlert, { label: 'Clearing tabs, library, and settings…' });

        try {
            await deleteAllAppData();

            showTaskResult(deleteStatusAlert, 'done', 'All data and settings were deleted');
            deleteExecuteBtn.textContent = 'Deleted';

            // Refresh live stat numbers to 0
            const statTabs = modal.querySelector('#deleteStatTabs');
            const statSongs = modal.querySelector('#deleteStatSongs');
            if (statTabs) statTabs.textContent = '0';
            if (statSongs) statSongs.textContent = '0';

            setTimeout(() => {
                closeBackupModal();
                window.location.reload();
            }, 1200);
        } catch (err) {
            console.error('Delete all data failed:', err);
            showTaskResult(deleteStatusAlert, 'error', `Could not delete the data. ${err.message}`);
            deleteExecuteBtn.disabled = false;
            deleteExecuteBtn.textContent = 'Delete all data';
        }
    });

    // --- RELOAD METADATA ACTION ---
    const reloadExecuteBtn = modal.querySelector('#reloadExecuteBtn');
    const reloadFillBtn = modal.querySelector('#reloadFillBtn');
    const reloadCancelBtn = modal.querySelector('#reloadCancelBtn');
    const reloadStatusAlert = modal.querySelector('#reloadStatusAlert');

    const updateReloadProgressUI = (progress) => {
        if (!progress) return;
        const { current = 0, total = 0, percent = 0, phase = '', name = '' } = progress;
        const unit = phase === 'album' ? 'albums' : (phase === 'tuning' ? 'tab files' : 'songs');
        showTaskProgress(reloadStatusAlert, {
            label: phase === 'start' ? 'Connecting to MusicBrainz and reading tab files…' : 'Refreshing library metadata…',
            detail: total > 0 ? `${current} of ${total} ${unit}${name ? ` · ${name}` : ''}` : '',
            value: total > 0 ? percent : null
        });
    };

    // Check if reload is already running when opening/rendering modal
    if (activeReloadState.running) {
        if (reloadExecuteBtn) {
            reloadExecuteBtn.disabled = true;
            reloadExecuteBtn.textContent = 'Reloading…';
        }
        if (reloadFillBtn) reloadFillBtn.disabled = true;
        if (reloadCancelBtn) reloadCancelBtn.textContent = 'Stop';
        updateReloadProgressUI(activeReloadState.progress);
    }

    const progressListener = (p) => {
        updateReloadProgressUI(p);
    };
    activeReloadState.listeners.add(progressListener);

    const completionListener = async ({ stats, error, aborted }) => {
        if (reloadCancelBtn) reloadCancelBtn.textContent = 'Cancel';

        if (aborted) {
            showTaskResult(reloadStatusAlert, 'warn', 'Stopped. Nothing more was changed');
            if (reloadExecuteBtn) {
                reloadExecuteBtn.disabled = false;
                reloadExecuteBtn.textContent = 'Reload metadata';
            }
            if (reloadFillBtn) reloadFillBtn.disabled = false;
        } else if (error) {
            showTaskResult(reloadStatusAlert, 'error', `Could not reload metadata. ${error.message}`);
            if (reloadExecuteBtn) {
                reloadExecuteBtn.disabled = false;
                reloadExecuteBtn.textContent = 'Try again';
            }
            if (reloadFillBtn) reloadFillBtn.disabled = false;
        } else if (stats) {
            if (reloadStatusAlert) {
                const details = [];
                if (stats.updatedAlbums > 0) details.push(`${stats.updatedAlbums} albums refreshed`);
                if (stats.updatedSongs > 0) details.push(`${stats.updatedSongs} songs updated`);
                const scrubbedCount = stats.scrubbedNonCdTracks || stats.scrubbedDvdTracks || 0;
                if (scrubbedCount > 0) details.push(`${scrubbedCount} non-CD (DVD/Vinyl) tracks removed`);
                if (stats.addedTrackNumbers > 0) details.push(`${stats.addedTrackNumbers} track numbers filled in`);
                if (stats.updatedTunings > 0) details.push(`${stats.updatedTunings} song tunings detected from tab files`);
                if (stats.addedDurations > 0) details.push(`${stats.addedDurations} track durations added`);
                if (stats.addedCovers > 0) details.push(`${stats.addedCovers} album covers added`);
                const summaryText = details.length > 0 ? details.join(' · ') : 'Everything was already up to date';

                showTaskResult(reloadStatusAlert, 'done',
                    `<strong>${activeReloadState.fillOnly ? 'Missing data filled in' : 'Metadata reloaded'}</strong><span class="task-status-detail">${escapeHtml(summaryText)}</span>`,
                    { html: true });
            }

            try {
                const updatedLib = await getAllLibraryData();
                const updatedMissingDur = (updatedLib.songs || []).filter(s => !s.length || s.length <= 0).length;
                const updatedMissingCov = (updatedLib.songs || []).filter(s => !s.coverUrl || s.coverUrl.includes('data:image/svg+xml')).length;

                const statMissingDur = modal.querySelector('#reloadStatMissingDuration');
                const statMissingCov = modal.querySelector('#reloadStatMissingCovers');
                const statMissingTracks = modal.querySelector('#reloadStatMissingTracks');
                if (statMissingTracks) {
                    statMissingTracks.textContent = songsMissingTrackNumber(updatedLib.songs).length;
                    statMissingTracks.className = 'text-white fw-bold fs-6';
                }
                if (statMissingDur) {
                    statMissingDur.textContent = updatedMissingDur;
                    statMissingDur.className = 'text-white fw-bold fs-6';
                }
                if (statMissingCov) {
                    statMissingCov.textContent = updatedMissingCov;
                    statMissingCov.className = 'text-white fw-bold fs-6';
                }
            } catch {}

            if (reloadExecuteBtn) {
                reloadExecuteBtn.textContent = 'Finished';
                setTimeout(() => {
                    if (reloadExecuteBtn) {
                        reloadExecuteBtn.disabled = false;
                        reloadExecuteBtn.textContent = 'Reload metadata';
                    }
                    if (reloadFillBtn) reloadFillBtn.disabled = false;
                }, 3000);
            }
        }
    };
    activeReloadState.completionListeners.add(completionListener);

    reloadCancelBtn?.addEventListener('click', () => {
        if (activeReloadState.running && activeReloadState.abortController) {
            activeReloadState.abortController.abort();
            if (reloadCancelBtn) reloadCancelBtn.textContent = 'Cancel';
        } else {
            closeBackupModal();
        }
    });

    const runReload = async (fillOnly) => {
        if (activeReloadState.running) return;

        activeReloadState.running = true;
        activeReloadState.fillOnly = fillOnly;
        activeReloadState.abortController = new AbortController();
        activeReloadState.progress = {
            current: 0,
            total: 0,
            percent: 0,
            phase: 'start',
            name: '',
            stats: { addedDurations: 0, addedCovers: 0, updatedTunings: 0 }
        };

        reloadExecuteBtn.disabled = true;
        reloadExecuteBtn.textContent = 'Reloading…';
        if (reloadFillBtn) reloadFillBtn.disabled = true;
        if (reloadCancelBtn) reloadCancelBtn.textContent = 'Stop';
        updateReloadProgressUI(activeReloadState.progress);

        try {
            const stats = await reloadAllLibraryMetadata({
                onProgress: (p) => {
                    activeReloadState.progress = p;
                    for (const l of activeReloadState.listeners) {
                        try { l(p); } catch {}
                    }
                },
                signal: activeReloadState.abortController.signal,
                forceRefresh: true,
                fillOnly
            });

            const aborted = Boolean(activeReloadState.abortController?.signal?.aborted);
            for (const cl of activeReloadState.completionListeners) {
                try { cl({ stats, aborted }); } catch {}
            }
        } catch (err) {
            console.error('Metadata reload failed:', err);
            const aborted = Boolean(activeReloadState.abortController?.signal?.aborted);
            for (const cl of activeReloadState.completionListeners) {
                try { cl({ error: err, aborted }); } catch {}
            }
        } finally {
            activeReloadState.running = false;
            activeReloadState.abortController = null;
        }
    };
    reloadExecuteBtn?.addEventListener('click', () => runReload(false));
    reloadFillBtn?.addEventListener('click', () => runReload(true));
}

/**
 * Initialize Data Management triggers in UI
 */
export function initBackupRestore() {
    document.getElementById('backupDataBtn')?.addEventListener('click', () => openBackupModal('backup'));
    document.getElementById('restoreDataBtn')?.addEventListener('click', () => openBackupModal('restore'));
    document.getElementById('reloadLibraryMetadataBtn')?.addEventListener('click', () => openBackupModal('reload'));
    document.getElementById('orphanedFilesBtn')?.addEventListener('click', () => openBackupModal('orphans'));
    document.getElementById('clearCacheBtn')?.addEventListener('click', () => openBackupModal('cache'));
    document.getElementById('deleteAllDataBtn')?.addEventListener('click', () => openBackupModal('delete'));
}
