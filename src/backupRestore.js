// backupRestore.js
// Complete single-file Backup and Restore engine for MajesticTab.
// Bundles all settings, custom extensions, downloaded tabs local store, and library hierarchy.

import { collectAudioSync, mergeAudioSync, clearAudioSync } from './audioSync/syncStore.js';
import { clearAllAudioFiles } from './audioSync/audioFileStore.js';
import {
    AUDIO_BACKUP_STORE, iterateAudioBackupEntries, audioBackupPlan, audioBackupOverview, restoreAudioEntry,
    isAudioDownloadEnabled, setAudioUploadEnabled, LARGE_AUDIO_UPLOAD_BYTES, SINGLE_FILE_AUDIO_LIMIT
} from './audioSync/audioBackup.js';
import {
    getDB, STORE_NAME, getAllStoredFiles, getStoredFileRecord, clearAllStoredFiles,
    arrayBufferToBase64, arrayBufferToBase64Async, base64ToArrayBuffer
} from './fileStore.js';
import {
    ensureDefaultCollection, getAllLibraryData, importLibraryData, clearAllLibraryData,
    reloadAllLibraryMetadata, findOrphanedStoredFiles, deleteOrphanedStoredFiles
} from './libraryStore.js';
import {
    getSaveProviders, saveToProvider, openFromProvider, getPreferredStorage
} from './fileProviders.js';
import { showToast } from './utils/toast.js';
import { dedupeExtensions } from './extensionDedupe.js';
export { dedupeExtensions };
import { isFolderBackupSupported } from './folderBackup.js';
import { isIcloudDriveSupported } from './icloudDrive.js';
import { refreshAppearance } from './themeEngine.js';
import { setGpDisplayScale } from './gpProcessor/gpProcessor.js';
import { installExtensionSources } from './fileAdapters.js';
import {
    STORAGE_KEY_SOUNDFONT_SELECTION, STORAGE_KEY_SOUNDFONT_ORDER, STORAGE_KEY_SOUNDFONT_STRICT, STORAGE_KEY_SOUNDFONT_FORCED, SOUNDFONT_BACKUP_STORE, listSoundFonts, clearAllSoundFonts,
    collectSoundFontBackupEntries, restoreSoundFontEntry
} from './soundFontStore.js';

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
        if (k && k.startsWith('yt_track_')) {
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

/**
 * Collect all custom extensions from localStorage
 */
export function collectExtensions() {
    try {
        const raw = localStorage.getItem('customExtensions');
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.warn('Could not parse customExtensions:', e);
        return [];
    }
}

/** Removes exact duplicates from the extensions stored on this device. Returns how many were removed. */
export function dedupeStoredExtensions() {
    const stored = collectExtensions();
    const kept = dedupeExtensions(stored);
    if (kept.length === stored.length) return 0;
    localStorage.setItem('customExtensions', JSON.stringify(kept));
    installExtensionSources(kept.filter(e => e.enabled).map(({ id, source }) => ({ id, source })))
        .catch(e => console.warn('Could not reload extensions after removing duplicates:', e));
    return stored.length - kept.length;
}

/** Yields the backup JSON in pieces: header, one entry per stored tab, then soundfonts. */
async function* backupTextChunks(onProgress) {
    const [fileMetas, libraryData, soundFonts] = await Promise.all([
        getAllStoredFiles(),
        getAllLibraryData(),
        listSoundFonts()
    ]);

    const settings = collectAllSettings();
    const extensions = collectExtensions();
    // Audio files that fit in one file; larger ones belong in a snapshot or folder backup
    const audioPlan = await audioBackupPlan();

    const summary = {
        tabsCount: fileMetas.length,
        soundFontsCount: soundFonts.length,
        audioCount: audioPlan.count,
        totalAudioSize: audioPlan.bytes,
        audioTooLargeCount: audioPlan.tooLarge.length,
        totalTabsSize: fileMetas.reduce((acc, f) => acc + (f.size || 0), 0),
        songsCount: libraryData.songs?.length || 0,
        collectionsCount: libraryData.collections?.length || 0,
        recentsCount: libraryData.recents?.length || 0,
        extensionsCount: extensions.length
    };

    const header = {
        app: 'MajesticTab',
        format: 'majestictab_backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        summary,
        settings,
        extensions,
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

    // Audio files too, one at a time, tagged `store: 'audio'`
    let written = fileMetas.length + soundFontEntries.length;
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
 * Create a complete single-file backup bundle object
 * @param {function(current: number, total: number): void} [onProgress]
 * @returns {Promise<object>} Complete backup bundle
 */
export async function createBackupBundle(onProgress) {
    const [fileMetas, libraryData] = await Promise.all([
        getAllStoredFiles(),
        getAllLibraryData()
    ]);

    const settings = collectAllSettings();
    const extensions = collectExtensions();

    const soundFontEntries = await collectSoundFontBackupEntries();
    const files = [];
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
        files.push({
            id: meta.id,
            name: meta.name,
            type: meta.type || 'application/octet-stream',
            size: meta.size || (record?.data ? record.data.byteLength : 0),
            providerId: meta.providerId || 'local',
            metadata: meta.metadata || {},
            savedAt: meta.savedAt || Date.now(),
            lastModified: meta.lastModified || Date.now(),
            dataBase64
        });
        if (typeof onProgress === 'function') {
            onProgress(i + 1, fileMetas.length);
        }
    }

    const tabsCount = files.length;
    files.push(...soundFontEntries);

    const now = new Date();
    const bundle = {
        app: 'MajesticTab',
        format: 'majestictab_backup',
        version: 1,
        exportedAt: now.toISOString(),
        summary: {
            tabsCount,
            soundFontsCount: soundFontEntries.length,
            totalTabsSize: files.slice(0, tabsCount).reduce((acc, f) => acc + (f.size || 0), 0),
            songsCount: libraryData.songs?.length || 0,
            collectionsCount: libraryData.collections?.length || 0,
            recentsCount: libraryData.recents?.length || 0,
            extensionsCount: extensions.length
        },
        settings,
        extensions,
        fileStore: {
            files
        },
        library: libraryData
    };

    return bundle;
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
    const extensions = parsed.extensions || [];
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
        extensionsCount: extensions.length,
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
                        extensionsCount: summary.extensionsCount ?? 0,
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

export function applyRestoredExtensions(backupExtensions, { wipe }) {
    let extensionsImported = 0;
    if (backupExtensions.length > 0 || wipe) {
        let finalExtensions = [];
        if (wipe) {
            finalExtensions = dedupeExtensions(backupExtensions.filter(ext => ext && ext.id && ext.source));
            extensionsImported = finalExtensions.length;
        } else {
            const currentExtensions = collectExtensions();
            const existingMap = new Map(currentExtensions.map(e => [e.id, e]));

            for (const ext of backupExtensions) {
                if (!ext || !ext.id || !ext.source) continue;
                if (!existingMap.has(ext.id)) {
                    existingMap.set(ext.id, ext);
                    extensionsImported++;
                } else {
                    existingMap.set(ext.id, { ...existingMap.get(ext.id), ...ext });
                }
            }
            finalExtensions = dedupeExtensions(Array.from(existingMap.values()));
        }

        localStorage.setItem('customExtensions', JSON.stringify(finalExtensions));
        const active = finalExtensions.filter(e => e.enabled);
        installExtensionSources(active.map(({ id, source }) => ({ id, source })))
            .catch(e => console.warn('Could not load restored extensions:', e));
    }
    return extensionsImported;
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
 *   restoreAudio?: boolean } `restoreAudio` false leaves audio files out of the restore (and out of a wipe)
 * @returns {Promise<object>} Results of the restore operation
 */
export async function restoreBackup(bundleOrFile, { mode = 'merge', onProgress, restoreAudio = isAudioDownloadEnabled() } = {}) {
    if (!bundleOrFile) {
        throw new Error('Invalid backup bundle provided.');
    }

    if (bundleOrFile instanceof Blob || (typeof File !== 'undefined' && bundleOrFile instanceof File)) {
        return await restoreBackupStream(bundleOrFile, { mode, onProgress, restoreAudio });
    }

    const bundle = bundleOrFile.data || bundleOrFile;
    return await restoreBackupObject(bundle, { mode, onProgress, restoreAudio });
}

export async function restoreBackupStream(file, { mode = 'merge', onProgress, restoreAudio = true } = {}) {
    const wipe = mode === 'wipe';
    const db = await getDB();

    if (wipe) {
        await clearAllStoredFiles();
        await clearAllSoundFonts();
        if (restoreAudio) await clearAllAudioFiles();
        await clearAllLibraryData();
        for (const key of BACKUP_SETTINGS_KEYS) {
            localStorage.removeItem(key);
        }
        localStorage.removeItem('customExtensions');
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('yt_track_')) keysToRemove.push(k);
        }
        for (const k of keysToRemove) localStorage.removeItem(k);
        clearAudioSync();
    }

    const fflateObj = (typeof window !== 'undefined' && window.fflate)
        ? window.fflate
        : (typeof globalThis !== 'undefined' && globalThis.fflate)
            ? globalThis.fflate
            : null;

    const slice2 = file.slice(0, 2);
    const headerBuf = await slice2.arrayBuffer();
    const headerBytes = new Uint8Array(headerBuf);
    const isGzip = headerBytes.length >= 2 && headerBytes[0] === 0x1F && headerBytes[1] === 0x8B;

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

                    const backupExtensions = Array.isArray(headerObj.extensions) ? headerObj.extensions : [];
                    if (backupExtensions.length > 0 || wipe) {
                        extensionsImported = applyRestoredExtensions(backupExtensions, { wipe });
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
                        if (restoreAudio && item.id && item.name && item.dataBase64 && await restoreAudioEntry(item, { wipe })) audioImported++;
                        else audioSkipped++;
                        if (typeof onProgress === 'function') {
                            onProgress(filesImported + filesSkipped + soundFontsImported + audioImported + audioSkipped, totalFilesExpected);
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
        extensionsImported,
        settingsApplied
    };
}

async function restoreBackupObject(bundle, { mode = 'merge', onProgress, restoreAudio = true } = {}) {
    const wipe = mode === 'wipe';
    const db = await getDB();

    if (wipe) {
        await clearAllStoredFiles();
        await clearAllSoundFonts();
        if (restoreAudio) await clearAllAudioFiles();
        await clearAllLibraryData();

        for (const key of BACKUP_SETTINGS_KEYS) {
            localStorage.removeItem(key);
        }
        localStorage.removeItem('customExtensions');

        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('yt_track_')) keysToRemove.push(k);
        }
        for (const k of keysToRemove) localStorage.removeItem(k);
        clearAudioSync();
    }

    let filesImported = 0;
    let filesSkipped = 0;
    let soundFontsImported = 0;
    let audioImported = 0;
    let audioSkipped = 0;

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
            if (restoreAudio && await restoreAudioEntry(item, { wipe })) audioImported++;
            else audioSkipped++;
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

    let extensionsImported = 0;
    const backupExtensions = Array.isArray(bundle.extensions) ? bundle.extensions : [];
    if (backupExtensions.length > 0 || wipe) {
        extensionsImported = applyRestoredExtensions(backupExtensions, { wipe });
    }

    let settingsApplied = 0;
    if (bundle.settings && typeof bundle.settings === 'object') {
        settingsApplied = applyRestoredSettings(bundle.settings, { wipe });
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
        extensionsImported,
        settingsApplied
    };
}

/**
 * Completely delete all local application data, tabs, library, custom extensions, and settings.
 */
export async function deleteAllAppData() {
    // 1. Wipe IndexedDB stored files and library
    await clearAllStoredFiles();
    await clearAllSoundFonts();
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
        if (k && (k.startsWith('yt_track_') || k.startsWith('tab_downloader_'))) {
            keysToRemove.push(k);
        }
    }
    for (const k of keysToRemove) localStorage.removeItem(k);
    clearAudioSync();

    // 4. Reset extensions
    installExtensionSources([]).catch(e => console.warn('Could not reset extensions:', e));

    // 5. Reset UI preferences to defaults
    applyRestoredPreferences();
}

/**
 * Clear cached data including persistent album artwork, MusicBrainz queries,
 * YouTube caches, and tab downloader search caches.
 * @returns {Promise<number>} Number of cache items removed
 */
export async function clearAppCache() {
    const { clearArtCache } = await import('./musicbrainz.js');
    let totalCleared = await clearArtCache();

    // Clear YouTube caches from localStorage
    try {
        const ytKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('yt_track_')) ytKeys.push(k);
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
        debugMode.checked = localStorage.getItem('debugMode') === 'true';
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
        modal.setAttribute('aria-label', 'Library and backup');
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
    if (!document.body.classList.contains('settings-as-page')) {
        navBtn.click();
        await wait(450);
    }
    for (let i = 0; i < 30 && !document.querySelector('.setnav [data-section="library"]'); i++) await wait(100);
    const section = document.querySelector('.setnav [data-section="library"]');
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
    modal.classList.add('is-embedded');
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
    modal.classList.remove('is-embedded');
    modal.style.display = 'none';
    document.body.appendChild(modal);
    setTaskOpenState(null);
    return true;
}

/**
 * Open the Data Management modal
 * @param {'backup'|'restore'|'reload'|'delete'} initialTab
 */
export async function openBackupModal(initialTab = 'backup', options = {}) {
    // Data management lives in Settings, on the Library and backup page. There is no popup.
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
    const extensions = collectExtensions();
    const tabsTotalSize = storedFiles.reduce((acc, f) => acc + (f.size || 0), 0);

    const songsMissingDuration = (libraryData.songs || []).filter(s => !s.length || s.length <= 0).length;
    const songsMissingCover = (libraryData.songs || []).filter(s => !s.coverUrl || s.coverUrl.includes('data:image/svg+xml')).length;
    const uniqueAlbumsCount = new Set((libraryData.songs || []).map(s => `${(s.artist || '').toLowerCase().trim()}:::${(s.album || '').toLowerCase().trim()}`).filter(Boolean)).size;

    // The location chosen for Sync is the default here too ('folder' is the Local Device provider)
    const preferred = getPreferredStorage() === 'folder' ? 'local' : getPreferredStorage();
    const wanted = options.provider || preferred;
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
              <span class="text-white fw-medium">${storedFiles.length}</span> tabs (${formatBytes(tabsTotalSize)}) · <span class="text-white fw-medium">${libraryData.songs?.length || 0}</span> songs · <span class="text-white fw-medium">${extensions.length}</span> file converters · App settings
            </div>
          </div>

          <!-- Destination Provider Selector -->
          <div class="mb-3">
            <label class="form-label small fw-semibold text-white-50 mb-2 d-block">
              Save to
            </label>
            <div class="d-flex flex-column gap-2" id="backupProviderList">
              ${providers.map((p, idx) => `
                <label class="backup-provider-option p-3 rounded-3 d-flex align-items-center justify-content-between gap-2" style="cursor: pointer;">
                  <div class="d-flex align-items-center gap-3 min-w-0">
                    <input class="form-check-input theme-radio m-0" type="radio" name="backupTargetProvider" value="${escapeHtml(p.id)}" ${p.id === preferredProviderId ? 'checked' : ''}>
                    <div class="min-w-0">
                      <div class="fw-semibold text-white small leading-tight">${escapeHtml(p.name)}</div>
                      <div class="text-muted text-truncate" style="font-size: 0.73rem;">${escapeHtml(p.saveDescription || p.description || '')}</div>
                    </div>
                  </div>
                </label>
              `).join('')}
            </div>
          </div>

          <!-- Backup Format -->
          <div class="mb-3">
            <label class="form-label small fw-semibold text-white-50 mb-2 d-block">Format</label>
            <div class="d-flex flex-column gap-2">
              <label class="backup-provider-option p-3 rounded-3 d-flex align-items-center gap-3" id="backupFormatIncrementalOption" style="cursor: pointer;">
                <input class="form-check-input theme-radio m-0" type="radio" name="backupFormat" value="incremental">
                <div class="min-w-0">
                  <div class="fw-semibold text-white small leading-tight">Incremental snapshots</div>
                  <div class="text-muted" style="font-size: 0.73rem;">Saves only new or changed tabs. Each backup is a restorable snapshot. Works with Google Drive, an S3 bucket, a WebDAV server or a local folder.</div>
                  <div class="text-warning" id="backupIncrementalHint" style="font-size: 0.73rem; display: none;"></div>
                </div>
              </label>
              <label class="backup-provider-option p-3 rounded-3 d-flex align-items-center gap-3" id="backupFormatSingleOption" style="cursor: pointer;">
                <input class="form-check-input theme-radio m-0" type="radio" name="backupFormat" value="single">
                <div class="min-w-0">
                  <div class="fw-semibold text-white small leading-tight">Single file</div>
                  <div class="text-muted" style="font-size: 0.73rem;">Everything in one portable .mtbackup file.</div>
                </div>
              </label>
            </div>
          </div>

          <!-- Single file: filename -->
          <div class="mb-3" id="backupFilenameGroup">
            <label class="form-label small fw-semibold text-white-50 mb-1" for="backupFilenameInput">Filename</label>
            <input type="text" class="form-control form-control-sm" id="backupFilenameInput" value="${escapeHtml(defaultFilename)}">
          </div>

          <!-- Incremental: what this backup will do -->
          <div class="backup-summary-box p-3 rounded-3 mb-3" id="backupIncrementalPreview" style="display:none;" aria-live="polite"></div>

          <!-- Audio files: whether they go with the backup -->
          <div class="backup-summary-box p-3 rounded-3 mb-3" id="backupAudioBox" style="display:none;" aria-live="polite"></div>

          <!-- Status / Action -->
          <div id="backupStatusAlert" class="small mb-2" style="display:none;" role="status"></div>

          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="backupCancelBtn">Cancel</button>
            <button type="button" class="btn btn-sm btn-theme-primary px-4 d-flex align-items-center gap-2" id="backupExecuteBtn">
              Create and save backup
            </button>
          </div>
        </div>

        <!-- TAB 2: RESTORE BACKUP -->
        <div id="restoreTabContent" style="display: ${activeTab === 'restore' ? 'block' : 'none'};">
          <!-- Step 1: File Picker / Dropzone -->
          <div class="backup-dropzone p-4 rounded-3 text-center mb-3" id="restoreDropzone">
            <input type="file" id="restoreFileInput" accept=".mtbackup" class="d-none">
            <div class="fw-semibold text-white small mb-1">Restore from a snapshot or a backup file</div>
            <div class="text-white-50 mb-3" style="font-size: 0.74rem;">Pick an incremental snapshot from Google Drive, an S3 bucket, a WebDAV server or a backup folder, or open a single .mtbackup file (you can also drop one here)</div>
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
            <div class="d-flex align-items-center justify-content-between mb-2">
              <div class="d-flex align-items-center gap-2">
                <span class="small fw-semibold text-white">Valid backup</span>
                <span class="small text-white-50" id="restoreFilenameLabel" style="font-size: 0.75rem;"></span>
              </div>
              <div class="d-flex align-items-center gap-2">
                <span class="small text-white-50" id="restoreExportedDate" style="font-size: 0.75rem;"></span>
                <button type="button" class="btn btn-sm srow-ghost px-2 py-0" id="restoreChangeFileBtn" style="font-size: 0.75rem;">Change</button>
              </div>
            </div>
            <div class="text-white-50 small mb-3">
              <span class="text-white fw-medium" id="restoreTabsCount">0</span> tabs · <span class="text-white fw-medium" id="restoreSongsCount">0</span> songs · <span class="text-white fw-medium" id="restoreExtCount">0</span> file converters
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
                    Keeps everything you have and adds any tabs, songs, collections, file converters, and settings that are missing from the backup.
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
                    Erases all current local stored tabs, library entries, file converters, settings and audio files (unless you leave audio out above), and replaces them cleanly with this backup.
                  </div>
                </div>
              </label>
            </div>

            <!-- Confirmation notice for wipe -->
            <div id="wipeConfirmContainer" class="form-check mb-3 p-3 rounded-2" style="display:none; background: color-mix(in srgb, var(--danger, #f87171) 12%, var(--s2));">
              <input class="form-check-input ms-0 me-2" type="checkbox" id="wipeConfirmCheckbox">
              <label class="form-check-label small" for="wipeConfirmCheckbox" style="color: var(--danger, #f87171); font-weight: 600; font-size: 0.75rem;">
                I understand this will erase my current stored tabs and settings before restoring.
              </label>
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
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6" id="reloadStatTotalSongs">${libraryData.songs?.length || 0}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Songs</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6" id="reloadStatAlbums">${uniqueAlbumsCount}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Albums</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6 ${songsMissingDuration > 0 ? 'text-warning' : 'text-success'}" id="reloadStatMissingDuration">${songsMissingDuration}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Missing track times</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6 ${songsMissingCover > 0 ? 'text-warning' : 'text-success'}" id="reloadStatMissingCovers">${songsMissingCover}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Missing cover art</div>
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
            <div class="small fw-semibold text-white mb-2 d-flex align-items-center gap-2">
              <i class="bi-clock-history text-warning"></i> Unused files in snapshots
            </div>
            <div class="text-white-50 small mb-3" style="font-size: 0.78rem; line-height: 1.45;">
              Saved tabs and SoundFonts in a Google Drive or folder backup that you can remove to free space. Files newer than 24 hours are kept.
            </div>
            <div class="d-flex flex-column gap-2 mb-3">
              <label class="d-flex align-items-start gap-2 text-white small mb-0" style="cursor: pointer;">
                <input class="form-check-input theme-radio mt-1 flex-shrink-0" type="radio" name="snapshotOrphanScope" value="all" checked>
                <span>Not used by any snapshot<br><span class="text-white-50" style="font-size: 0.73rem;">Left over from deleted or pruned snapshots. Safe to remove.</span></span>
              </label>
              <label class="d-flex align-items-start gap-2 text-white small mb-0" style="cursor: pointer;">
                <input class="form-check-input theme-radio mt-1 flex-shrink-0" type="radio" name="snapshotOrphanScope" value="latest">
                <span>Not used by the most recent snapshot<br><span class="text-white-50" style="font-size: 0.73rem;">Older snapshots may still use these, so they can no longer restore them in full.</span></span>
              </label>
            </div>
            <div class="d-flex flex-wrap gap-2 mb-2">
              <!-- @googleDrive:begin -->
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-inline-flex align-items-center gap-2" data-snapshot-orphan-scan="google-drive"><i class="icon-gdrive"></i> Scan Google Drive</button>
              <!-- @googleDrive:end -->
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-inline-flex align-items-center gap-2" data-snapshot-orphan-scan="s3"><i class="bi-hdd-network text-warning"></i> Scan S3 Bucket</button>
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-inline-flex align-items-center gap-2" data-snapshot-orphan-scan="webdav"><i class="bi-hdd-rack text-info"></i> Scan WebDAV</button>
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-inline-flex align-items-center gap-2" data-snapshot-orphan-scan="local"><i class="bi-folder2-open text-primary"></i> Scan Backup Folder</button>
            </div>
            <div id="snapshotOrphansList"></div>
            <div id="snapshotOrphansStatus" class="small mt-2" style="display:none;" role="status"></div>
            <div class="d-flex justify-content-end pt-2">
              <button type="button" class="btn btn-sm btn-theme-danger px-4 d-flex align-items-center gap-2" id="snapshotOrphansDeleteBtn" disabled>
                Delete selected
              </button>
            </div>
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
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6" id="deleteStatTabs">${storedFiles.length}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Stored tabs (${formatBytes(tabsTotalSize)})</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6" id="deleteStatSongs">${libraryData.songs?.length || 0}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Library songs</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6" id="deleteStatExt">${extensions.length}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">File converters</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
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
                  This action permanently removes all locally stored tab files, library tracks, playlists, collections, file converters, and resets all application settings to factory defaults.
                </div>
              </div>
            </div>
            <div class="text-white-50 small p-2 rounded-2 mt-2" style="background: rgba(0,0,0,0.25); font-size: 0.74rem;">
              <i class="bi-info-circle text-info me-1"></i> Tip: If you want to keep a copy of your current files and settings, create a backup using <strong>Create a backup</strong> first.
            </div>
          </div>

          <!-- Confirmation Checkbox -->
          <div class="form-check mb-3 p-3 rounded-2 bg-danger bg-opacity-10 border border-danger border-opacity-25">
            <input class="form-check-input ms-0 me-2" type="checkbox" id="deleteAllConfirmCheckbox">
            <label class="form-check-label small text-danger fw-semibold" for="deleteAllConfirmCheckbox" style="font-size: 0.78rem; cursor: pointer;">
              I understand this action is permanent and cannot be undone. Delete all my data.
            </label>
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

    // --- ORPHANED FILES IN INCREMENTAL BACKUPS ---
    const snapOrphansList = modal.querySelector('#snapshotOrphansList');
    const snapOrphansStatus = modal.querySelector('#snapshotOrphansStatus');
    const snapOrphansDeleteBtn = modal.querySelector('#snapshotOrphansDeleteBtn');
    let snapOrphanBackend = null;
    let snapOrphanFiles = [];
    let snapOrphanScope = 'all';
    const getSnapScope = () => modal.querySelector('input[name="snapshotOrphanScope"]:checked')?.value || 'all';
    const setSnapStatus = (cls, html) => {
        if (!html) return clearTaskStatus(snapOrphansStatus);
        const kind = cls.includes('danger') ? 'error' : cls.includes('success') ? 'done' : 'info';
        // Messages are built from our own strings and escaped values; icons are not part of the design
        showTaskResult(snapOrphansStatus, kind, html.replace(/<i class="[^"]*"><\/i>\s*/g, ''), { html: true });
    };
    const updateSnapOrphansDeleteBtn = () => {
        const n = snapOrphansList.querySelectorAll('.snapshot-orphan-check:checked').length;
        snapOrphansDeleteBtn.disabled = n === 0;
        snapOrphansDeleteBtn.textContent = `Delete selected${n ? ` · ${n}` : ''}`;
    };
    const renderSnapOrphans = (found) => {
        snapOrphanFiles = found.unused;
        const recentNote = found.recent ? ` ${found.recent} newer file${found.recent === 1 ? ' is' : 's are'} kept for now.` : '';
        if (!found.unused.length) {
            snapOrphansList.innerHTML = `<div class="text-success small"><i class="bi-check-circle-fill me-1"></i> ${snapOrphanScope === 'latest' ? 'Every file is used by your most recent snapshot.' : 'Every file is used by at least one snapshot.'}${recentNote}</div>`;
            return updateSnapOrphansDeleteBtn();
        }
        const sorted = [...found.unused].sort((a, b) => b.size - a.size);
        snapOrphansList.innerHTML = `
          <div class="d-flex align-items-center justify-content-between mb-2 small">
            <label class="d-flex align-items-center gap-2 text-white mb-0">
              <input type="checkbox" class="form-check-input theme-switch" id="snapshotOrphansSelectAll">
              Select all (${sorted.length} files, ${formatBytes(found.freedBytes)})
            </label>
          </div>
          <div class="d-flex flex-column gap-2" style="max-height: 35vh; overflow-y: auto;">
            ${sorted.map(f => {
                const title = f.label || `${f.name.replace(/\.bin$/, '').slice(0, 12)}…`;
                const used = f.snapshots ? `${f.snapshots} older snapshot${f.snapshots === 1 ? '' : 's'}` : 'no snapshot';
                return `
              <label class="d-flex align-items-center gap-3 p-2 rounded-2 backup-stat-card mb-0" style="cursor: pointer;">
                <input type="checkbox" class="form-check-input snapshot-orphan-check flex-shrink-0" data-name="${escapeHtml(f.name)}">
                <span class="flex-grow-1 text-truncate text-white small" title="${escapeHtml(title)}">${escapeHtml(title)}<span class="text-white-50"> · used by ${used}</span></span>
                <span class="flex-shrink-0 text-white-50 small">${formatBytes(f.size)}</span>
              </label>`;
            }).join('')}
          </div>
          <div class="text-white-50 mt-2" style="font-size:0.72rem;">${recentNote.trim()}</div>`;
        snapOrphansList.querySelector('#snapshotOrphansSelectAll').addEventListener('change', (e) => {
            snapOrphansList.querySelectorAll('.snapshot-orphan-check').forEach(cb => { cb.checked = e.target.checked; });
            updateSnapOrphansDeleteBtn();
        });
        snapOrphansList.querySelectorAll('.snapshot-orphan-check').forEach(cb => cb.addEventListener('change', updateSnapOrphansDeleteBtn));
        updateSnapOrphansDeleteBtn();
    };
    modal.querySelectorAll('[data-snapshot-orphan-scan]').forEach(btn => btn.addEventListener('click', async () => {
        const provider = btn.dataset.snapshotOrphanScan;
        setSnapStatus('', '');
        snapOrphansList.innerHTML = '';
        showTaskProgress(snapOrphansStatus, { label: 'Scanning snapshots…' });
        snapOrphanBackend = null;
        snapOrphanFiles = [];
        updateSnapOrphansDeleteBtn();
        try {
            const target = await resolveIncrementalTarget({ interactive: true, provider });
            if (target.status !== 'ready') {
                snapOrphansList.innerHTML = '';
                return setSnapStatus('text-white-50', `<i class="bi-info-circle me-1"></i> ${target.status === 'needs-auth' ? 'Connect Google Drive from the Create Backup tab first.' : target.status === 'needs-s3' ? 'Connect an S3 bucket from the Create Backup tab first.' : target.status === 'needs-webdav' ? 'Connect a WebDAV server from the Create Backup tab first.' : 'Choose a backup folder and allow access to scan it.'}`);
            }
            const { findUnusedBlobs } = await import('./incrementalBackup.js');
            snapOrphanScope = getSnapScope();
            const found = await findUnusedBlobs(target.backend, { scope: snapOrphanScope });
            snapOrphanBackend = target.backend;
            if (!found.snapshotCount) {
                snapOrphansList.innerHTML = '';
                return setSnapStatus('text-white-50', 'No incremental snapshots found there.');
            }
            setSnapStatus('', '');
            renderSnapOrphans(found);
        } catch (err) {
            console.error('Snapshot orphan scan failed:', err);
            snapOrphansList.innerHTML = '';
            setSnapStatus('text-danger', `<i class="bi-exclamation-triangle-fill me-1"></i> Failed to scan: ${escapeHtml(err.message)}`);
        }
    }));
    snapOrphansDeleteBtn?.addEventListener('click', async () => {
        const names = new Set([...snapOrphansList.querySelectorAll('.snapshot-orphan-check:checked')].map(cb => cb.dataset.name));
        const chosen = snapOrphanFiles.filter(f => names.has(f.name));
        if (!chosen.length || !snapOrphanBackend) return;
        snapOrphansDeleteBtn.disabled = true;
        snapOrphansDeleteBtn.textContent = 'Deleting…';
        showTaskProgress(snapOrphansStatus, { label: 'Deleting backup files…', detail: `${chosen.length} selected` });
        try {
            const { deleteBlobs, findUnusedBlobs } = await import('./incrementalBackup.js');
            await deleteBlobs(snapOrphanBackend, chosen);
            setSnapStatus('text-success fw-semibold', `<i class="bi-check-circle-fill me-1"></i> Removed ${chosen.length} ${chosen.length === 1 ? 'file' : 'files'} from incremental backups.`);
            renderSnapOrphans(await findUnusedBlobs(snapOrphanBackend, { scope: snapOrphanScope }));
        } catch (err) {
            console.error('Failed to delete snapshot orphans:', err);
            setSnapStatus('text-danger fw-semibold', `<i class="bi-exclamation-triangle-fill me-1"></i> Failed: ${escapeHtml(err.message)}`);
            updateSnapOrphansDeleteBtn();
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
    const backupExecuteBtn = modal.querySelector('#backupExecuteBtn');
    const backupStatusAlert = modal.querySelector('#backupStatusAlert');
    const backupFilenameInput = modal.querySelector('#backupFilenameInput');
    const backupFilenameGroup = modal.querySelector('#backupFilenameGroup');
    const backupIncrementalPreview = modal.querySelector('#backupIncrementalPreview');
    const incrementalRadio = modal.querySelector('input[name="backupFormat"][value="incremental"]');
    const singleRadio = modal.querySelector('input[name="backupFormat"][value="single"]');
    const incrementalOption = modal.querySelector('#backupFormatIncrementalOption');
    const getBackupFormat = () => modal.querySelector('input[name="backupFormat"]:checked')?.value || 'single';
    const getBackupProviderId = () => modal.querySelector('input[name="backupTargetProvider"]:checked')?.value || 'local';

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

    // Audio files are the big part of a backup, so say how much goes and let the user keep it all on this device
    const backupAudioBox = modal.querySelector('#backupAudioBox');
    const renderAudioBox = async () => {
        if (!backupAudioBox) return;
        const o = await audioBackupOverview();
        if (!o.total) { backupAudioBox.style.display = 'none'; return; }
        backupAudioBox.style.display = 'block';
        const single = getBackupFormat() === 'single';
        const plan = single && o.enabled ? await audioBackupPlan() : null;
        const lines = [];
        if (!o.enabled) {
            lines.push('Audio files stay on this device and are not backed up.');
        } else {
            lines.push(`${plural(o.count, 'audio file')} (${formatBytes(o.bytes)}) will be included${o.excluded ? `, ${o.excluded} kept out` : ''}. Audio goes only to the backup destination you choose here, never to MajesticTab.`);
            if (plan?.tooLarge.length) lines.push(`${plural(plan.tooLarge.length, 'file')} over ${formatBytes(SINGLE_FILE_AUDIO_LIMIT)} cannot go into a single file. Use incremental snapshots to include ${plan.tooLarge.length === 1 ? 'it' : 'them'}.`);
            if (o.bytes >= LARGE_AUDIO_UPLOAD_BYTES) lines.push('That is a lot to send the first time. Later backups send only new or changed audio.');
            if (o.count < o.total && o.excluded) lines.push('Choose which files to keep out in the Audio File panel.');
        }
        backupAudioBox.innerHTML = `
            <div class="d-flex align-items-start justify-content-between gap-2">
                <div class="min-w-0">
                    <div class="small fw-semibold text-white"><i class="bi-file-earmark-music text-info me-1"></i> Audio files</div>
                    ${lines.map(l => `<div class="small text-white-50 mt-1" style="font-size:0.75rem;">${escapeHtml(l)}</div>`).join('')}
                </div>
                <div class="form-check form-switch mb-0 flex-shrink-0">
                    <input class="form-check-input theme-switch" type="checkbox" id="backupAudioSwitch" ${o.enabled ? 'checked' : ''} aria-label="Include audio files in backups">
                </div>
            </div>`;
    };
    backupAudioBox?.addEventListener('change', (e) => {
        if (e.target.id !== 'backupAudioSwitch') return;
        setAudioUploadEnabled(e.target.checked);
        renderAudioBox();
        if (getBackupFormat() === 'incremental') renderIncrementalPreview();
    });

    let previewRequest = 0;
    const renderIncrementalPreview = async () => {
        if (!backupIncrementalPreview) return;
        const request = ++previewRequest;
        const isDrive = getBackupProviderId() === 'google-drive';
        const isIcloud = getBackupProviderId() === 'icloud-drive';
        const isS3 = getBackupProviderId() === 's3';
        const isWebDav = getBackupProviderId() === 'webdav';
        const where = isDrive ? 'Google Drive' : isIcloud ? 'iCloud Drive' : isS3 ? 'your S3 bucket' : isWebDav ? 'your WebDAV server' : 'the backup folder';
        const note = (html) => { if (request === previewRequest) backupIncrementalPreview.innerHTML = html; };
        const actionBtn = (action, icon, label) => `<button type="button" class="btn btn-sm btn-theme-outline px-3 mt-2" data-backup-action="${action}"><span>${label}</span></button>`;

        note(waitingHtml('Checking for existing backups…'));
        try {
            const target = await resolveIncrementalTarget();
            // @googleDrive:begin
            if (target.status === 'needs-auth') {
                return note(`<div class="small text-white-50">Connect Google Drive to back up there and see what changed since your last backup.</div>${actionBtn('connect', '', 'Connect Google Drive')}`);
            }
            // @googleDrive:end
            if (target.status === 'needs-icloud') {
                return note(`<div class="small text-white-50">iCloud Drive is not available. Turn it on in Settings > Apple Account > iCloud, and make sure MajesticTab is allowed to use it.</div>`);
            }
            if (target.status === 'needs-s3') {
                const { s3ConfigFormHtml } = await import('./s3Ui.js');
                return note(`<div class="small text-white-50 mb-2">Connect an S3 bucket to keep your backups there.</div>${s3ConfigFormHtml()}<div id="backupS3Error" class="small text-warning mt-2" style="display:none;"></div>${actionBtn('save-s3', '', 'Save and connect')}`);
            }
            if (target.status === 'needs-webdav') {
                const { webdavConfigFormHtml } = await import('./webdavUi.js');
                return note(`<div class="small text-white-50 mb-2">Connect a WebDAV server to keep your backups there.</div>${webdavConfigFormHtml()}<div id="backupWebDavError" class="small text-warning mt-2" style="display:none;"></div>${actionBtn('save-webdav', '', 'Save and connect')}`);
            }
            if (target.status === 'needs-folder') {
                return note(`<div class="small text-white-50">Choose a folder on this device to keep your backups in.</div>${actionBtn('choose-folder', '', 'Choose folder')}`);
            }
            if (target.status === 'needs-permission') {
                return note(`<div class="small text-white-50">MajesticTab needs permission to use "${escapeHtml(target.folderName)}" again.</div>${actionBtn('allow-folder', '', 'Allow access')} ${actionBtn('choose-folder', '', 'Choose another')}`);
            }

            const { previewIncrementalBackup } = await import('./incrementalBackup.js');
            const p = await previewIncrementalBackup(target.backend);
            const when = p.latest ? new Date(p.latest.exportedAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            const head = p.latest
                ? `Last backup ${escapeHtml(when)} (${p.backupCount} saved)`
                : `No backup in ${where} yet. This will be your first.`;
            const stat = changeStatHtml;
            const nothing = p.latest && !p.added && !p.modified && !p.removed && !p.audio.added && !p.audio.modified;
            const audioLine = p.audio.count
                ? `<div class="small text-white-50 mt-1" style="font-size:0.75rem;">${p.audio.added + p.audio.modified
                    ? `${plural(p.audio.added + p.audio.modified, 'audio file')} new or changed (${formatBytes(p.audio.bytesToSend)} to send)`
                    : 'No new audio'}${p.audio.unchanged ? `, ${p.audio.unchanged} already backed up` : ''}.</div>`
                : '';
            note(`
                <div class="d-flex align-items-start justify-content-between gap-2 mb-2">
                    <div class="min-w-0">
                        <div class="small fw-semibold text-white">${head}</div>
                        <div class="text-white-50 text-truncate" style="font-size:0.72rem;" title="${escapeHtml(target.backend.location)}">${escapeHtml(target.backend.location)}</div>
                    </div>
                    ${isDrive || isIcloud ? '' : isS3 ? '<button type="button" class="btn btn-sm btn-theme-outline px-2 py-1 flex-shrink-0" style="font-size:0.72rem;" data-backup-action="edit-s3">Bucket settings</button>' : isWebDav ? '<button type="button" class="btn btn-sm btn-theme-outline px-2 py-1 flex-shrink-0" style="font-size:0.72rem;" data-backup-action="edit-webdav">Server settings</button>' : '<button type="button" class="btn btn-sm btn-theme-outline px-2 py-1 flex-shrink-0" style="font-size:0.72rem;" data-backup-action="choose-folder">Change</button>'}
                </div>
                <div class="row g-2">
                    ${stat(p.added, 'New tabs', 'text-success')}
                    ${stat(p.modified, 'Changed', 'text-info')}
                    ${stat(p.removed, 'Removed locally', 'text-warning')}
                    ${stat(p.unchanged, 'Unchanged', 'text-white')}
                </div>
                <div class="small text-white-50 mt-2" style="font-size:0.75rem;">
                    ${nothing ? 'No tab changes. Library and settings are still saved as a new snapshot.' : `About ${formatBytes(p.bytesToSend)} to save. Library and settings are saved with every snapshot.`}
                    ${p.removed ? ' Removed tabs stay in older snapshots.' : ''}
                </div>
                ${audioLine}`);
        } catch (err) {
            note(`<div class="small text-warning">Could not check ${where}: ${escapeHtml(err.message)}</div>`);
        }
    };

    backupIncrementalPreview?.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-backup-action]')?.dataset.backupAction;
        if (!action) return;
        try {
            // @googleDrive:begin
            if (action === 'connect') {
                const { redirectToGoogleAuth } = await import('./googleDrive.js');
                redirectToGoogleAuth('backup_create');
                return;
            }
            // @googleDrive:end
            if (action === 'edit-s3') {
                const { s3ConfigFormHtml } = await import('./s3Ui.js');
                backupIncrementalPreview.innerHTML = `${s3ConfigFormHtml()}<div id="backupS3Error" class="small text-warning mt-2" style="display:none;"></div><button type="button" class="btn btn-sm btn-theme-outline px-3 mt-2" data-backup-action="save-s3"><span>Save and connect</span></button>`;
                return;
            }
            if (action === 'edit-webdav') {
                const { webdavConfigFormHtml } = await import('./webdavUi.js');
                backupIncrementalPreview.innerHTML = `${webdavConfigFormHtml()}<div id="backupWebDavError" class="small text-warning mt-2" style="display:none;"></div><button type="button" class="btn btn-sm btn-theme-outline px-3 mt-2" data-backup-action="save-webdav"><span>Save and connect</span></button>`;
                return;
            }
            if (action === 'save-webdav') {
                const btn = e.target.closest('[data-backup-action]');
                const errorEl = backupIncrementalPreview.querySelector('#backupWebDavError');
                if (errorEl) errorEl.style.display = 'none';
                btn.disabled = true;
                try {
                    const { saveWebDavConfigFromForm } = await import('./webdavUi.js');
                    await saveWebDavConfigFromForm(backupIncrementalPreview);
                } catch (err) {
                    btn.disabled = false;
                    if (errorEl) { errorEl.textContent = err.message; errorEl.style.display = 'block'; }
                    return;
                }
            } else if (action === 'save-s3') {
                const btn = e.target.closest('[data-backup-action]');
                const errorEl = backupIncrementalPreview.querySelector('#backupS3Error');
                if (errorEl) errorEl.style.display = 'none';
                btn.disabled = true;
                try {
                    const { saveS3ConfigFromForm } = await import('./s3Ui.js');
                    await saveS3ConfigFromForm(backupIncrementalPreview);
                } catch (err) {
                    btn.disabled = false;
                    if (errorEl) { errorEl.textContent = err.message; errorEl.style.display = 'block'; }
                    return;
                }
            } else if (action === 'choose-folder') {
                const { pickBackupFolder } = await import('./folderBackup.js');
                if (!(await pickBackupFolder())) return;
            } else if (action === 'allow-folder') {
                const { getSavedBackupFolder, ensureFolderPermission } = await import('./folderBackup.js');
                const handle = await getSavedBackupFolder();
                if (handle) await ensureFolderPermission(handle);
            }
        } catch (err) {
            showToast(err.message, 'error');
        }
        renderIncrementalPreview();
    });

    // Incremental works with Google Drive or (where the browser can open folders) a local folder;
    // keep the format and destination consistent
    const syncBackupFormat = ({ providerChanged = false, refresh = true } = {}) => {
        const providerId = getBackupProviderId();
        const canIncrement = providerId === 'google-drive' || providerId === 'icloud-drive' || providerId === 's3' || providerId === 'webdav' || (providerId === 'local' && isFolderBackupSupported());
        if (incrementalRadio) incrementalRadio.disabled = !canIncrement;
        const hint = modal.querySelector('#backupIncrementalHint');
        if (hint) {
            hint.style.display = canIncrement ? 'none' : 'block';
            hint.textContent = providerId === 'local'
                ? 'Local folders need the desktop app, or Chrome or Edge on a computer. Use Google Drive instead, or save a single file.'
                : 'Choose Google Drive, iCloud Drive, S3 Bucket, WebDAV or Local Device to use incremental snapshots.';
        }
        if (incrementalOption) incrementalOption.style.opacity = canIncrement ? '' : '0.5';
        if (providerChanged && canIncrement) incrementalRadio.checked = true;
        if (!canIncrement || !incrementalRadio.checked) singleRadio.checked = true;
        const incremental = getBackupFormat() === 'incremental';
        if (backupFilenameGroup) backupFilenameGroup.style.display = incremental ? 'none' : 'block';
        if (backupIncrementalPreview) backupIncrementalPreview.style.display = incremental ? 'block' : 'none';
        if (backupExecuteBtn) backupExecuteBtn.textContent = incremental ? 'Back up changes' : 'Create and save backup';
        if (incremental && refresh) renderIncrementalPreview();
        renderAudioBox();
    };
    modal.querySelectorAll('input[name="backupTargetProvider"]').forEach(el =>
        el.addEventListener('change', () => syncBackupFormat({ providerChanged: true })));
    modal.querySelectorAll('input[name="backupFormat"]').forEach(el =>
        el.addEventListener('change', () => syncBackupFormat()));
    syncBackupFormat({ providerChanged: true });

    backupExecuteBtn?.addEventListener('click', async () => {
        const selectedProviderEl = modal.querySelector('input[name="backupTargetProvider"]:checked');
        const providerId = selectedProviderEl?.value || 'local';
        const incremental = getBackupFormat() === 'incremental';
        let filename = (backupFilenameInput?.value || '').trim();
        if (!filename) filename = `MajesticTab-backup-${new Date().toISOString().split('T')[0]}.mtbackup`;
        if (filename.toLowerCase().endsWith('.json')) {
            filename = filename.slice(0, -5) + '.mtbackup';
        }
        if (!filename.toLowerCase().endsWith('.mtbackup')) {
            filename += '.mtbackup';
        }

        backupExecuteBtn.disabled = true;
        backupExecuteBtn.textContent = incremental ? 'Backing up…' : 'Creating backup…';
        showTaskProgress(backupStatusAlert, { label: incremental ? 'Comparing with existing backups…' : 'Packaging settings and tabs…' });

        try {
            const providerLabel = selectedProviderEl?.closest('label')?.querySelector('.leading-tight')?.textContent || providerId;
            let savedBytes = 0;
            let successMessage = null;

            if (incremental) {
                // Only tabs and SoundFonts the destination doesn't already hold are stored
                const target = await resolveIncrementalTarget({ interactive: true });
                // @googleDrive:begin
                if (target.status === 'needs-auth') {
                    const { redirectToGoogleAuth } = await import('./googleDrive.js');
                    redirectToGoogleAuth('backup_create');
                    throw new Error('Please authorize Google Drive to save the backup.');
                }
                // @googleDrive:end
                if (target.status === 'needs-icloud') throw new Error('iCloud Drive is not available. Turn it on in Settings > Apple Account > iCloud.');
                if (target.status === 'needs-s3') throw new Error('Connect your S3 bucket first.');
                if (target.status === 'needs-webdav') throw new Error('Connect your WebDAV server first.');
                if (target.status !== 'ready') throw new Error('Choose a backup folder and allow access to it first.');
                const { createIncrementalBackup } = await import('./incrementalBackup.js');
                const result = await createIncrementalBackup(target.backend, {
                    onProgress: ({ phase, current, total, bytesSent, uploaded = 0, reused = 0, name }) => {
                        const pct = phase === 'manifest' ? 99 : total > 0 ? Math.min(98, Math.round((current / total) * 98)) : 0;
                        const known = phase !== 'scan' && total > 0;
                        showTaskProgress(backupStatusAlert, {
                            label: phase === 'scan' ? 'Checking what is already backed up…' : phase === 'manifest' ? 'Writing the backup manifest…' : 'Backing up…',
                            detail: known && phase !== 'manifest' ? `${current} of ${total} checked · ${uploaded} saved (${formatBytes(bytesSent)}) · ${reused} already backed up` : '',
                            value: known ? pct : null
                        });
                    }
                });
                savedBytes = result.bytesSent;
                successMessage = result.uploaded
                    ? `Snapshot saved: ${result.uploaded} new or changed file${result.uploaded === 1 ? '' : 's'} saved (${formatBytes(result.bytesSent)}), ${result.reused} unchanged skipped`
                    : `Snapshot saved: nothing new to save, ${result.reused} file${result.reused === 1 ? '' : 's'} already backed up`;
                if (result.pruned) successMessage += `. ${result.pruned} oldest snapshot${result.pruned === 1 ? '' : 's'} removed`;
            } else {
                const blob = await createBackupBlob((current, total) => {
                    if (total > 0) {
                        const pct = Math.round((current / total) * 40); // 0-40% packaging
                        showTaskProgress(backupStatusAlert, { label: 'Packaging tabs…', detail: `${current} of ${total}`, value: pct });
                    }
                });
                savedBytes = blob.size;

                showTaskProgress(backupStatusAlert, { label: `Saving to ${providerLabel}…`, detail: formatBytes(savedBytes) });

                await saveToProvider(providerId, blob, filename);
            }

            showTaskResult(backupStatusAlert, 'done', successMessage || `Backup saved (${formatBytes(savedBytes)})`);
            backupExecuteBtn.textContent = 'Saved';
            setTimeout(() => {
                backupExecuteBtn.disabled = false;
                syncBackupFormat();
            }, 3000);
        } catch (err) {
            console.error('Backup creation failed:', err);
            showTaskResult(backupStatusAlert, 'error', `Could not save the backup. ${err.message}`);
            backupExecuteBtn.disabled = false;
            backupExecuteBtn.textContent = 'Try again';
        }
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

    // Lists snapshots in the connected S3 bucket
    const loadS3Backups = async () => {
        try {
            const { createS3Backend } = await import('./s3Backup.js');
            const backend = createS3Backend();
            if (!backend) {
                showToast('Connect an S3 bucket first, from the Create Backup tab or Sync.', 'warning');
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
                showToast('Connect an WebDAV server first, from the Create Backup tab or Sync.', 'warning');
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
        if (getBackupProviderId() === 'google-drive' && getBackupFormat() === 'incremental') renderIncrementalPreview();
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
        // Signed in while the backup tab is open (or via another window): replace the "Connect" prompt
        if (getBackupProviderId() === 'google-drive' && getBackupFormat() === 'incremental') {
            renderIncrementalPreview();
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
    // Audio can be left out of a restore (for example when the device is short of space): sync points are kept
    // either way, and the files can be relinked later
    let restoreAudioChoice = isAudioDownloadEnabled();
    let restoreInspection = null;
    let restoreAudioInfo = null;
    const restoreAudioBox = modal.querySelector('#restoreAudioBox');
    const renderRestoreAudioBox = (info) => {
        restoreAudioInfo = info;
        if (!restoreAudioBox) return;
        if (!info || !info.count) { restoreAudioBox.style.display = 'none'; return; }
        restoreAudioBox.style.display = 'block';
        const detail = `${plural(info.count, 'audio file')}, ${formatBytes(info.bytes)}${info.onDevice ? ` (${info.onDevice} already on this device)` : ''}`;
        restoreAudioBox.innerHTML = `
            <div class="d-flex align-items-start justify-content-between gap-2">
                <div class="min-w-0">
                    <div class="small fw-semibold text-white"><i class="bi-file-earmark-music text-info me-1"></i> Restore audio files</div>
                    <div class="small text-white-50 mt-1" style="font-size:0.75rem;">${escapeHtml(detail)}. ${restoreAudioChoice
                        ? 'They are downloaded with the rest.'
                        : 'They are left out. Sync points are kept, and you can choose the files again later from the Audio File panel.'}</div>
                </div>
                <div class="form-check form-switch mb-0 flex-shrink-0">
                    <input class="form-check-input theme-switch" type="checkbox" id="restoreAudioSwitch" ${restoreAudioChoice ? 'checked' : ''} aria-label="Restore audio files">
                </div>
            </div>`;
    };
    restoreAudioBox?.addEventListener('change', (e) => {
        if (e.target.id !== 'restoreAudioSwitch') return;
        restoreAudioChoice = e.target.checked;
        renderRestoreAudioBox(restoreAudioInfo);
    });
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

            const inspection = await inspectBackupFile(file);

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
            currentParsedBackup = inspection.data || inspection;
            restoreInspection = inspection;

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
            const extCountEl = modal.querySelector('#restoreExtCount');
            if (extCountEl) extCountEl.textContent = inspection.extensionsCount ?? 0;

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
                wipeConfirmContainer.style.display = 'block';
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
            const results = await restoreBackup(currentBackupFile || currentParsedBackup, {
                mode,
                restoreAudio: restoreAudioChoice,
                onProgress: (current, total) => {
                    if (total > 0) {
                        showTaskProgress(restoreStatusAlert, { label: 'Restoring tabs…', detail: `${current} of ${total}`, value: (current / total) * 100 });
                    }
                }
            });

            currentParsedBackup = null;

            const details = [];
            if (results.filesImported > 0) details.push(`${results.filesImported} tabs imported`);
            if (results.soundFontsImported > 0) details.push(`${results.soundFontsImported} SoundFonts imported`);
            if (results.audioImported > 0) details.push(`${results.audioImported} audio files imported`);
            if (results.audioSkipped > 0 && !restoreAudioChoice) details.push(`${results.audioSkipped} audio files left out`);
            if (results.filesSkipped > 0) details.push(`${results.filesSkipped} existing tabs kept`);
            if (results.songsImported > 0) details.push(`${results.songsImported} library songs added/merged`);
            if (results.extensionsImported > 0) details.push(`${results.extensionsImported} file converters updated`);
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
        showTaskProgress(deleteStatusAlert, { label: 'Clearing tabs, library, file converters and settings…' });

        try {
            await deleteAllAppData();

            showTaskResult(deleteStatusAlert, 'done', 'All data and settings were deleted');
            deleteExecuteBtn.textContent = 'Deleted';

            // Refresh live stat numbers to 0
            const statTabs = modal.querySelector('#deleteStatTabs');
            const statSongs = modal.querySelector('#deleteStatSongs');
            const statExt = modal.querySelector('#deleteStatExt');
            if (statTabs) statTabs.textContent = '0';
            if (statSongs) statSongs.textContent = '0';
            if (statExt) statExt.textContent = '0';

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
        } else if (error) {
            showTaskResult(reloadStatusAlert, 'error', `Could not reload metadata. ${error.message}`);
            if (reloadExecuteBtn) {
                reloadExecuteBtn.disabled = false;
                reloadExecuteBtn.textContent = 'Try again';
            }
        } else if (stats) {
            if (reloadStatusAlert) {
                const details = [];
                if (stats.updatedAlbums > 0) details.push(`${stats.updatedAlbums} albums refreshed`);
                if (stats.updatedSongs > 0) details.push(`${stats.updatedSongs} songs updated`);
                const scrubbedCount = stats.scrubbedNonCdTracks || stats.scrubbedDvdTracks || 0;
                if (scrubbedCount > 0) details.push(`${scrubbedCount} non-CD (DVD/Vinyl) tracks removed`);
                if (stats.updatedTunings > 0) details.push(`${stats.updatedTunings} song tunings detected from tab files`);
                if (stats.addedDurations > 0) details.push(`${stats.addedDurations} track durations added`);
                if (stats.addedCovers > 0) details.push(`${stats.addedCovers} album covers added`);
                const summaryText = details.length > 0 ? details.join(' · ') : 'Everything was already up to date';

                showTaskResult(reloadStatusAlert, 'done',
                    `<strong>Metadata reloaded</strong><span class="task-status-detail">${escapeHtml(summaryText)}</span>`,
                    { html: true });
            }

            try {
                const updatedLib = await getAllLibraryData();
                const updatedMissingDur = (updatedLib.songs || []).filter(s => !s.length || s.length <= 0).length;
                const updatedMissingCov = (updatedLib.songs || []).filter(s => !s.coverUrl || s.coverUrl.includes('data:image/svg+xml')).length;

                const statMissingDur = modal.querySelector('#reloadStatMissingDuration');
                const statMissingCov = modal.querySelector('#reloadStatMissingCovers');
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

    reloadExecuteBtn?.addEventListener('click', async () => {
        if (activeReloadState.running) return;

        activeReloadState.running = true;
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
                forceRefresh: true
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
    });
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
