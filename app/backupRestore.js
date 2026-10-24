// backupRestore.js
// Complete single-file Backup and Restore engine for MajesticTab.
// Bundles all settings, custom extensions, downloaded tabs local store, and library hierarchy.

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
import { isFolderBackupSupported } from './folderBackup.js';
import { setTheme, setSheetMode, getCurrentTheme } from './themeEngine.js';
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
    'tab_downloader_sources',
    'gdrive_last_folder',
    'gdrive_tabs_directory',
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

/** Yields the backup JSON in pieces: header, one entry per stored tab, then soundfonts. */
async function* backupTextChunks(onProgress) {
    const [fileMetas, libraryData, soundFonts] = await Promise.all([
        getAllStoredFiles(),
        getAllLibraryData(),
        listSoundFonts()
    ]);

    const settings = collectAllSettings();
    const extensions = collectExtensions();

    const summary = {
        tabsCount: fileMetas.length,
        soundFontsCount: soundFonts.length,
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
        tabsCount: files.filter(f => f?.store !== SOUNDFONT_BACKUP_STORE).length,
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
            finalExtensions = backupExtensions.filter(ext => ext && ext.id && ext.source);
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
            finalExtensions = Array.from(existingMap.values());
        }

        localStorage.setItem('customExtensions', JSON.stringify(finalExtensions));
        try {
            const active = finalExtensions.filter(e => e.enabled);
            installExtensionSources(active.map(({ id, source }) => ({ id, source })));
        } catch (e) {
            console.warn('Could not compile restored extensions:', e);
        }
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
 * @param {object} options - { mode: 'merge' | 'wipe', onProgress?: function(current: number, total: number): void }
 * @returns {Promise<object>} Results of the restore operation
 */
export async function restoreBackup(bundleOrFile, { mode = 'merge', onProgress } = {}) {
    if (!bundleOrFile) {
        throw new Error('Invalid backup bundle provided.');
    }

    if (bundleOrFile instanceof Blob || (typeof File !== 'undefined' && bundleOrFile instanceof File)) {
        return await restoreBackupStream(bundleOrFile, { mode, onProgress });
    }

    const bundle = bundleOrFile.data || bundleOrFile;
    return await restoreBackupObject(bundle, { mode, onProgress });
}

export async function restoreBackupStream(file, { mode = 'merge', onProgress } = {}) {
    const wipe = mode === 'wipe';
    const db = await getDB();

    if (wipe) {
        await clearAllStoredFiles();
        await clearAllSoundFonts();
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

                    totalFilesExpected = (headerObj.summary?.tabsCount || 0) + (headerObj.summary?.soundFontsCount || 0);

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

                    if (item && item.store === SOUNDFONT_BACKUP_STORE && item.id && item.name && item.dataBase64) {
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
        collectionsImported: libraryResults.collectionsCount,
        songsImported: libraryResults.songsCount,
        recentsCount: libraryResults.recentsCount,
        extensionsImported,
        settingsApplied
    };
}

async function restoreBackupObject(bundle, { mode = 'merge', onProgress } = {}) {
    const wipe = mode === 'wipe';
    const db = await getDB();

    if (wipe) {
        await clearAllStoredFiles();
        await clearAllSoundFonts();
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
    }

    let filesImported = 0;
    let filesSkipped = 0;
    let soundFontsImported = 0;

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

    // 4. Reset extensions
    try {
        installExtensionSources([]);
    } catch (e) {
        console.warn('Could not reset extensions:', e);
    }

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
    const theme = localStorage.getItem('majestictab_theme') || 'Mystic Dream';
    const sheetMode = localStorage.getItem('majestictab_sheet_mode') || 'auto';
    setTheme(theme);
    setSheetMode(sheetMode);

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
        modal.setAttribute('aria-labelledby', 'backupModalTitle');
        document.body.appendChild(modal);
    }
    modalElement = modal;
    return modal;
}

/**
 * Open the Data Management modal
 * @param {'backup'|'restore'|'reload'|'delete'} initialTab
 */
export async function openBackupModal(initialTab = 'backup', options = {}) {
    const modal = getOrCreateModal();
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Hide fileMenu offcanvas if open
    const fileMenuEl = document.getElementById('fileMenu');
    if (fileMenuEl) {
        const offcanvas = bootstrap.Offcanvas.getInstance(fileMenuEl);
        offcanvas?.hide();
    }

    await renderModal(modal, initialTab, options);
}

/**
 * Close the Data Management modal
 */
export function closeBackupModal() {
    if (modalElement) {
        modalElement.style.display = 'none';
    }
    document.body.style.overflow = '';
    currentBackupFile = null;
    currentParsedBackup = null;
    if (activeGoogleAuthHandler) {
        window.removeEventListener('googleAuthSuccess', activeGoogleAuthHandler);
        activeGoogleAuthHandler = null;
    }
    activeReloadState.listeners.clear();
    activeReloadState.completionListeners.clear();
}

/** One count tile of the backup/restore change summaries. */
function changeStatHtml(n, label, cls) {
    return `<div class="col-6 col-md-3"><div class="p-2 rounded-2 backup-stat-card"><div class="fw-bold fs-6 ${n ? cls : 'text-white-50'}">${n}</div><div class="text-white-50" style="font-size:0.72rem;">${label}</div></div></div>`;
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
      <!-- Modal Header -->
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          <div class="brand-btn p-2 theme-modal-icon" style="width: 38px; height: 38px;">
            <i class="bi-database-gear text-primary fs-5"></i>
          </div>
          <div class="theme-modal-titles">
            <h5 class="mb-0 fw-bold text-white fs-6" id="backupModalTitle">Data Management</h5>
            <small class="text-muted d-none d-sm-block" style="font-size: 0.75rem;">Backup, restore, reload metadata, or manage stored tabs, library, and settings</small>
          </div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="backupModalCloseBtn" aria-label="Close modal">
            <i class="bi-x-lg"></i>
          </button>
        </div>
      </div>

      <!-- Tab Switcher Navigation -->
      <div class="backup-nav-tabs px-3 pt-2 pb-1 gap-2">
        <button type="button" class="btn btn-sm ${activeTab === 'backup' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1" id="tabBtnBackup">
          <i class="bi-cloud-arrow-up me-2"></i> Create Backup
        </button>
        <button type="button" class="btn btn-sm ${activeTab === 'restore' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1" id="tabBtnRestore">
          <i class="bi-cloud-arrow-down me-2"></i> Restore from Backup
        </button>
        <button type="button" class="btn btn-sm ${activeTab === 'reload' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1" id="tabBtnReload">
          <i class="bi-arrow-repeat me-2"></i> Reload Metadata
        </button>
        <button type="button" class="btn btn-sm ${activeTab === 'orphans' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1" id="tabBtnOrphans">
          <i class="bi-file-earmark-x me-2"></i> Orphaned Files
        </button>
        <button type="button" class="btn btn-sm ${activeTab === 'cache' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1" id="tabBtnCache">
          <i class="bi-brush me-2"></i> Clear Cache
        </button>
        <button type="button" class="btn btn-sm ${activeTab === 'delete' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1" id="tabBtnDelete">
          <i class="bi-trash3 me-2"></i> Delete All Data
        </button>
      </div>

      <!-- Modal Body -->
      <div class="theme-modal-body p-3">
        <!-- TAB 1: CREATE BACKUP -->
        <div id="backupTabContent" style="display: ${activeTab === 'backup' ? 'block' : 'none'};">
          <!-- Bundle Contents Overview -->
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2 d-flex align-items-center gap-2">
              <i class="bi-collection text-info"></i> Data Included in this Bundle
            </div>
            <div class="row g-2 text-white-50 small">
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6">${storedFiles.length}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Stored Tabs (${formatBytes(tabsTotalSize)})</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6">${libraryData.songs?.length || 0}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Library Songs</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6">${extensions.length}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Custom Extensions</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6"><i class="bi-check2 text-success"></i></div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">All App Settings</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Destination Provider Selector -->
          <div class="mb-3">
            <label class="form-label small fw-semibold text-white-50 mb-2 d-block">
              Save Backup Destination:
            </label>
            <div class="d-flex flex-column gap-2" id="backupProviderList">
              ${providers.map((p, idx) => `
                <label class="backup-provider-option p-3 rounded-3 d-flex align-items-center justify-content-between gap-2" style="cursor: pointer;">
                  <div class="d-flex align-items-center gap-3 min-w-0">
                    <input class="form-check-input theme-radio m-0" type="radio" name="backupTargetProvider" value="${escapeHtml(p.id)}" ${p.id === preferredProviderId ? 'checked' : ''}>
                    <div class="provider-mini-icon">
                      <i class="${escapeHtml(p.icon || 'bi-folder')} ${escapeHtml(p.iconColorClass || 'text-primary')} fs-5"></i>
                    </div>
                    <div class="min-w-0">
                      <div class="fw-bold text-white small leading-tight">${escapeHtml(p.name)}</div>
                      <div class="text-muted text-truncate" style="font-size: 0.73rem;">${escapeHtml(p.description || '')}</div>
                    </div>
                  </div>
                  ${p.badge ? `<span class="badge badge-theme-secondary py-0 px-2" style="font-size: 0.65rem;">${escapeHtml(p.badge)}</span>` : ''}
                </label>
              `).join('')}
            </div>
          </div>

          <!-- Backup Format -->
          <div class="mb-3">
            <label class="form-label small fw-semibold text-white-50 mb-2 d-block">Backup Format:</label>
            <div class="d-flex flex-column gap-2">
              <label class="backup-provider-option p-3 rounded-3 d-flex align-items-center gap-3" id="backupFormatIncrementalOption" style="cursor: pointer;">
                <input class="form-check-input theme-radio m-0" type="radio" name="backupFormat" value="incremental">
                <div class="min-w-0">
                  <div class="fw-bold text-white small leading-tight">Incremental snapshots</div>
                  <div class="text-muted" style="font-size: 0.73rem;">Saves only new or changed tabs. Each backup is a restorable snapshot. Works with Google Drive or a local folder.</div>
                  <div class="text-warning" id="backupIncrementalHint" style="font-size: 0.73rem; display: none;"></div>
                </div>
              </label>
              <label class="backup-provider-option p-3 rounded-3 d-flex align-items-center gap-3" id="backupFormatSingleOption" style="cursor: pointer;">
                <input class="form-check-input theme-radio m-0" type="radio" name="backupFormat" value="single">
                <div class="min-w-0">
                  <div class="fw-bold text-white small leading-tight">Single file</div>
                  <div class="text-muted" style="font-size: 0.73rem;">Everything in one portable .mtbackup file.</div>
                </div>
              </label>
            </div>
          </div>

          <!-- Single file: filename -->
          <div class="mb-3" id="backupFilenameGroup">
            <label class="form-label small fw-semibold text-white-50 mb-1" for="backupFilenameInput">Filename:</label>
            <input type="text" class="form-control form-control-sm bg-dark text-white border-secondary" id="backupFilenameInput" value="${escapeHtml(defaultFilename)}">
          </div>

          <!-- Incremental: what this backup will do -->
          <div class="backup-summary-box p-3 rounded-3 mb-3" id="backupIncrementalPreview" style="display:none;" aria-live="polite"></div>

          <!-- Backup Progress Bar -->
          <div id="backupProgressContainer" class="p-2 rounded-2 mb-2" style="display:none; background: rgba(0,0,0,0.25); border: 1px solid var(--border-subtle);">
            <div class="d-flex justify-content-between text-white small mb-1" style="font-size: 0.75rem;">
              <span id="backupProgressText">Preparing backup...</span>
              <span id="backupProgressPercent" class="fw-bold text-info">0%</span>
            </div>
            <div class="progress" style="height: 6px; background: rgba(255,255,255,0.1);">
              <div class="progress-bar progress-bar-striped progress-bar-animated bg-primary" id="backupProgressBar" role="progressbar" style="width: 0%;"></div>
            </div>
          </div>

          <!-- Status / Action -->
          <div id="backupStatusAlert" class="small mb-2" style="display:none;" role="status"></div>

          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="backupCancelBtn">Cancel</button>
            <button type="button" class="btn btn-sm btn-theme-primary px-4 d-flex align-items-center gap-2" id="backupExecuteBtn">
              <i class="bi-cloud-arrow-up"></i> Create &amp; Save Backup
            </button>
          </div>
        </div>

        <!-- TAB 2: RESTORE BACKUP -->
        <div id="restoreTabContent" style="display: ${activeTab === 'restore' ? 'block' : 'none'};">
          <!-- Step 1: File Picker / Dropzone -->
          <div class="backup-dropzone p-4 rounded-3 text-center mb-3" id="restoreDropzone">
            <input type="file" id="restoreFileInput" accept=".mtbackup" class="d-none">
            <i class="bi-file-earmark-arrow-up text-info fs-1 mb-2 d-block"></i>
            <div class="fw-bold text-white small mb-1">Restore from a snapshot or backup file</div>
            <div class="text-white-50 mb-3" style="font-size: 0.74rem;">Pick an incremental snapshot from Google Drive or a backup folder, or open a single .mtbackup file (you can also drop one here)</div>
            <div class="d-flex justify-content-center align-items-center gap-2 flex-wrap">
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-inline-flex align-items-center gap-1" id="restoreBrowseBtn">
                <i class="bi-file-earmark-zip text-primary"></i> <span>Open .mtbackup File</span>
              </button>
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-none align-items-center gap-1" id="restoreFolderBtn">
                <i class="bi-hdd text-primary"></i> <span>Backup Folder</span>
              </button>
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-inline-flex align-items-center gap-1" id="restoreDriveBtn">
                <i class="bi-google text-danger"></i> <span>Google Drive Backups</span>
              </button>
            </div>

            <!-- Inline Google Drive Backup Selector -->
            <div id="restoreDriveContainer" class="mt-3 pt-3 border-top border-secondary-subtle text-start" style="display: none;">
              <div class="d-flex align-items-center justify-content-between mb-2">
                <span class="small fw-semibold text-white d-flex align-items-center gap-1">
                  <i class="bi-google text-danger" id="restoreSourceIcon"></i> <span id="restoreSourceTitle">Google Drive Backups:</span>
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
              </div>
              <div id="restoreDriveLoading" class="py-3 text-center text-white-50 small" style="display: none;">
                <span class="spinner-border spinner-border-sm text-primary me-2" role="status"></span>
                <span>Looking for backups...</span>
              </div>
              <div id="restoreDriveEmpty" class="py-3 text-center text-white-50 small" style="display: none;">
                <i class="bi-archive text-secondary fs-4 d-block mb-1"></i>
                <div id="restoreDriveEmptyText">No backups found.</div>
              </div>
              <div id="restoreDriveError" class="py-2 text-danger small" style="display: none;"></div>
              <div id="restoreDriveList" class="d-flex flex-column gap-2" style="max-height: 220px; overflow-y: auto;"></div>

              <!-- Download Progress -->
              <div id="restoreDriveDownloadProgress" class="mt-2 p-2 rounded-2" style="display:none; background: rgba(0,0,0,0.25); border: 1px solid var(--border-subtle);">
                <div class="d-flex justify-content-between text-white small mb-1" style="font-size: 0.75rem;">
                  <span id="restoreDriveProgressName" class="text-truncate me-2">Downloading backup from Google Drive...</span>
                  <span id="restoreDriveProgressPercent" class="fw-bold text-info flex-shrink-0">0%</span>
                </div>
                <div class="progress" style="height: 6px; background: rgba(255,255,255,0.1);">
                  <div class="progress-bar progress-bar-striped progress-bar-animated bg-info" id="restoreDriveProgressBar" role="progressbar" style="width: 0%;"></div>
                </div>
                <div class="text-white-50 small mt-1" id="restoreDriveProgressBytes" style="font-size: 0.7rem;">0 KB / 0 KB</div>
              </div>
            </div>
          </div>

          <!-- Step 2: Inspection Card (Hidden until file selected) -->
          <div id="restoreInspectionCard" class="p-3 rounded-3 mb-3" style="display:none; background: var(--bg-card); border: 1px solid var(--border-prominent);">
            <div class="d-flex align-items-center justify-content-between mb-2">
              <div class="d-flex align-items-center gap-2">
                <span class="badge badge-theme-primary px-2 py-1" style="font-size: 0.68rem;">
                  <i class="bi-check-circle me-1"></i> Valid Backup
                </span>
                <span class="small text-white-50" id="restoreFilenameLabel" style="font-size: 0.75rem;"></span>
              </div>
              <div class="d-flex align-items-center gap-2">
                <span class="small text-white-50" id="restoreExportedDate" style="font-size: 0.75rem;"></span>
                <button type="button" class="btn btn-sm btn-link p-0 text-info text-decoration-none" id="restoreChangeFileBtn" style="font-size: 0.75rem;">Change</button>
              </div>
            </div>
            <div class="row g-2 text-white-50 small mb-3">
              <div class="col-4">
                <div class="p-2 rounded-2 backup-stat-card text-center">
                  <div class="text-white fw-bold" id="restoreTabsCount">0</div>
                  <div style="font-size:0.7rem;">Tabs</div>
                </div>
              </div>
              <div class="col-4">
                <div class="p-2 rounded-2 backup-stat-card text-center">
                  <div class="text-white fw-bold" id="restoreSongsCount">0</div>
                  <div style="font-size:0.7rem;">Songs</div>
                </div>
              </div>
              <div class="col-4">
                <div class="p-2 rounded-2 backup-stat-card text-center">
                  <div class="text-white fw-bold" id="restoreExtCount">0</div>
                  <div style="font-size:0.7rem;">Extensions</div>
                </div>
              </div>
            </div>

            <!-- Snapshot restore preview (incremental backups only) -->
            <div class="backup-summary-box p-3 rounded-3 mb-3" id="restoreIncrementalPreview" style="display:none;" aria-live="polite"></div>

            <!-- Restore Mode Options -->
            <label class="form-label small fw-semibold text-white-50 mb-2 d-block">Choose Restore Method:</label>
            <div class="d-flex flex-column gap-2 mb-3">
              <!-- Merge Mode Option (Recommended) -->
              <label class="restore-mode-card p-3 rounded-3 d-flex align-items-start gap-3" style="cursor: pointer;">
                <input class="form-check-input theme-radio mt-1" type="radio" name="restoreModeRadio" value="merge" checked>
                <div class="min-w-0">
                  <div class="d-flex align-items-center gap-2 mb-1">
                    <span class="fw-bold text-white small">Merge with Existing Data</span>
                    <span class="badge badge-theme-secondary py-0 px-2" style="font-size:0.62rem;">Recommended</span>
                  </div>
                  <div class="text-muted" style="font-size: 0.73rem; line-height: 1.35;">
                    Safely adds any missing tabs, songs, collections, extensions, and preferences from the backup. Keeps your existing tabs intact.
                  </div>
                </div>
              </label>

              <!-- Wipe & Replace Option -->
              <label class="restore-mode-card p-3 rounded-3 d-flex align-items-start gap-3" style="cursor: pointer;">
                <input class="form-check-input theme-radio mt-1" type="radio" name="restoreModeRadio" value="wipe">
                <div class="min-w-0">
                  <div class="d-flex align-items-center gap-2 mb-1">
                    <span class="fw-bold text-danger-emphasis small">Wipe &amp; Replace Everything</span>
                    <span class="badge bg-danger bg-opacity-25 text-danger border border-danger-subtle py-0 px-2" style="font-size:0.62rem;">Clean Slate</span>
                  </div>
                  <div class="text-muted" style="font-size: 0.73rem; line-height: 1.35;">
                    Erases all current local stored tabs, library entries, extensions, and settings, and replaces them cleanly with this backup.
                  </div>
                </div>
              </label>
            </div>

            <!-- Confirmation notice for wipe -->
            <div id="wipeConfirmContainer" class="form-check mb-3 p-2 rounded-2 bg-danger bg-opacity-10 border border-danger border-opacity-25" style="display:none;">
              <input class="form-check-input ms-0 me-2" type="checkbox" id="wipeConfirmCheckbox">
              <label class="form-check-label small text-danger fw-semibold" for="wipeConfirmCheckbox" style="font-size: 0.75rem;">
                I understand this will erase my current stored tabs and settings before restoring.
              </label>
            </div>
          </div>

          <!-- Status / Action -->
          <div id="restoreStatusAlert" class="small mb-2" style="display:none;" role="status"></div>

          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="restoreCancelBtn">Cancel</button>
            <button type="button" class="btn btn-sm btn-theme-primary px-4 d-flex align-items-center gap-2" id="restoreExecuteBtn" disabled>
              <i class="bi-cloud-arrow-down"></i> Restore Data
            </button>
          </div>
        </div>

        <!-- TAB 3: RELOAD METADATA -->
        <div id="reloadTabContent" style="display: ${activeTab === 'reload' ? 'block' : 'none'};">
          <!-- Library Metadata Status Overview -->
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2 d-flex align-items-center gap-2">
              <i class="bi-music-note-list text-info"></i> Library Metadata Status
            </div>
            <div class="row g-2 text-white-50 small">
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6" id="reloadStatTotalSongs">${libraryData.songs?.length || 0}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Total Songs</div>
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
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Missing Track Times</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6 ${songsMissingCover > 0 ? 'text-warning' : 'text-success'}" id="reloadStatMissingCovers">${songsMissingCover}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Missing Cover Art</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Informational Card -->
          <div class="p-3 rounded-3 mb-3" style="background: var(--bg-card); border: 1px solid var(--border-subtle);">
            <div class="d-flex align-items-start gap-3">
              <i class="bi-info-circle-fill text-info fs-5 flex-shrink-0 mt-1"></i>
              <div>
                <div class="fw-bold text-white small mb-1">Refresh All Metadata from MusicBrainz &amp; Guitar Pro Files</div>
                <div class="text-white-50 small" style="font-size: 0.78rem; line-height: 1.45;">
                  Performs a comprehensive refresh of all library metadata: queries MusicBrainz for canonical <strong>track durations</strong>, official track numbers, release years, and cover artwork, while re-analyzing all stored Guitar Pro tab files to extract accurate guitar &amp; bass tunings and string counts.
                </div>
                <div class="text-white-50 small mt-2 pt-2 border-top border-secondary border-opacity-25" style="font-size: 0.74rem;">
                  <i class="bi-shield-check text-success me-1"></i> Your attached tabs, custom tab assignments, and collections will remain completely intact.
                </div>
              </div>
            </div>
          </div>

          <!-- Live Progress Box (Hidden until running) -->
          <div id="reloadProgressContainer" class="p-3 rounded-3 mb-3" style="display:none; background: var(--bg-card); border: 1px solid var(--border-prominent);">
            <div class="d-flex align-items-center justify-content-between mb-2">
              <span class="small fw-semibold text-white d-flex align-items-center gap-2 min-w-0 me-2" id="reloadCurrentActionLabel">
                <span class="spinner-border spinner-border-sm text-primary flex-shrink-0" role="status"></span>
                <span class="text-truncate">Connecting to MusicBrainz &amp; analyzing tab files...</span>
              </span>
              <span class="small text-white-50 font-monospace flex-shrink-0" id="reloadPercentLabel">0%</span>
            </div>
            <div class="progress mb-2" style="height: 6px; background: rgba(255,255,255,0.1);">
              <div class="progress-bar progress-bar-striped progress-bar-animated bg-primary" id="reloadProgressBar" role="progressbar" style="width: 0%;"></div>
            </div>
            <div class="d-flex justify-content-between text-white-50 small" style="font-size: 0.72rem;">
              <span id="reloadItemsCountLabel">0 / 0</span>
              <span id="reloadStatsLiveLabel">Durations: 0 • Artwork: 0 • Tunings: 0</span>
            </div>
          </div>

          <!-- Status / Results Alert -->
          <div id="reloadStatusAlert" class="small mb-2" style="display:none;" role="status"></div>

          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="reloadCancelBtn">${activeReloadState.running ? 'Stop / Cancel' : 'Cancel'}</button>
            <button type="button" class="btn btn-sm btn-theme-primary px-4 d-flex align-items-center gap-2" id="reloadExecuteBtn" ${(activeReloadState.running || !libraryData.songs || libraryData.songs.length === 0) ? 'disabled' : ''}>
              ${activeReloadState.running ? '<span class="spinner-border spinner-border-sm me-2" role="status"></span> Reloading...' : '<i class="bi-arrow-repeat"></i> Reload Library Metadata'}
            </button>
          </div>
        </div>

        <!-- TAB: ORPHANED FILES -->
        <div id="orphansTabContent" style="display: ${activeTab === 'orphans' ? 'block' : 'none'};">
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2 d-flex align-items-center gap-2">
              <i class="bi-file-earmark-x text-warning"></i> Orphaned Stored Files
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
              <i class="bi-trash3"></i> Delete Selected
            </button>
          </div>

          <div class="backup-summary-box p-3 rounded-3 mt-3">
            <div class="small fw-semibold text-white mb-2 d-flex align-items-center gap-2">
              <i class="bi-clock-history text-warning"></i> Orphaned Files in Incremental Backups
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
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-inline-flex align-items-center gap-2" data-snapshot-orphan-scan="google-drive"><i class="bi-google text-danger"></i> Scan Google Drive</button>
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-inline-flex align-items-center gap-2" data-snapshot-orphan-scan="local"><i class="bi-folder2-open text-primary"></i> Scan Backup Folder</button>
            </div>
            <div id="snapshotOrphansList"></div>
            <div id="snapshotOrphansStatus" class="small mt-2" style="display:none;" role="status"></div>
            <div class="d-flex justify-content-end pt-2">
              <button type="button" class="btn btn-sm btn-theme-danger px-4 d-flex align-items-center gap-2" id="snapshotOrphansDeleteBtn" disabled>
                <i class="bi-trash3"></i> Delete Selected
              </button>
            </div>
          </div>
        </div>

        <!-- TAB: CLEAR CACHE -->
        <div id="cacheTabContent" style="display: ${activeTab === 'cache' ? 'block' : 'none'};">
          <!-- Cache Summary Overview -->
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2 d-flex align-items-center gap-2">
              <i class="bi-brush text-warning"></i> Temporary Cached Data
            </div>
            <div class="text-white-50 small mb-3" style="font-size: 0.78rem; line-height: 1.45;">
              Clearing cached data frees local storage without affecting your stored tab files, songs, collections, playlists, or settings.
            </div>
            <div class="row g-2 text-white-50 small">
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6"><i class="bi-image text-info"></i></div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Album Art Cache</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6"><i class="bi-disc text-primary"></i></div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">MusicBrainz Cache</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6"><i class="bi-youtube text-danger"></i></div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">YouTube Video Cache</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6"><i class="bi-cloud-download text-success"></i></div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Search Query Cache</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Status / Results Alert -->
          <div id="cacheStatusAlert" class="small mb-2" style="display:none;" role="status"></div>

          <div class="d-flex justify-content-end gap-2 pt-1">
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="cacheCancelBtn">Cancel</button>
            <button type="button" class="btn btn-sm btn-theme-primary px-4 d-flex align-items-center gap-2" id="cacheExecuteBtn">
              <i class="bi-brush"></i> Clear Cache
            </button>
          </div>
        </div>

        <!-- TAB 4: DELETE ALL DATA -->
        <div id="deleteTabContent" style="display: ${activeTab === 'delete' ? 'block' : 'none'};">
          <!-- Data Summary Overview -->
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2 d-flex align-items-center gap-2">
              <i class="bi-exclamation-octagon text-danger"></i> Data to be Erased
            </div>
            <div class="row g-2 text-white-50 small">
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6" id="deleteStatTabs">${storedFiles.length}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Stored Tabs (${formatBytes(tabsTotalSize)})</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6" id="deleteStatSongs">${libraryData.songs?.length || 0}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Library Songs</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6" id="deleteStatExt">${extensions.length}</div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">Custom Extensions</div>
                </div>
              </div>
              <div class="col-6 col-md-3">
                <div class="p-2 rounded-2 backup-stat-card">
                  <div class="text-white fw-bold fs-6"><i class="bi-gear text-warning"></i></div>
                  <div class="text-truncate text-white-50" style="font-size:0.72rem;">All Settings &amp; Cache</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Danger Warning Card -->
          <div class="p-3 rounded-3 mb-3" style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.35);">
            <div class="d-flex align-items-start gap-3 mb-2">
              <i class="bi-exclamation-triangle-fill text-danger fs-5 flex-shrink-0 mt-1"></i>
              <div>
                <div class="fw-bold text-white small mb-1">Permanent Data Deletion Warning</div>
                <div class="text-white-50 small" style="font-size: 0.78rem; line-height: 1.45;">
                  This action permanently removes all locally stored tab files, library tracks, playlists, collections, custom extensions, and resets all application settings to factory defaults.
                </div>
              </div>
            </div>
            <div class="text-white-50 small p-2 rounded-2 mt-2" style="background: rgba(0,0,0,0.25); font-size: 0.74rem;">
              <i class="bi-info-circle text-info me-1"></i> Tip: If you want to keep a copy of your current files and settings, create a backup using the <strong>Create Backup</strong> tab first.
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
              <i class="bi-trash3-fill"></i> Delete All Data
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
    // Close button & backdrop click
    modal.querySelector('#backupModalCloseBtn')?.addEventListener('click', closeBackupModal);
    modal.querySelector('#backupCancelBtn')?.addEventListener('click', closeBackupModal);
    modal.querySelector('#restoreCancelBtn')?.addEventListener('click', closeBackupModal);
    modal.querySelector('#cacheCancelBtn')?.addEventListener('click', closeBackupModal);
    modal.querySelector('#deleteCancelBtn')?.addEventListener('click', closeBackupModal);

    let backdropPointerDown = false;
    modal.onpointerdown = (e) => {
        backdropPointerDown = (e.target === modal);
    };
    modal.onclick = (e) => {
        if (e.target === modal && backdropPointerDown) {
            closeBackupModal();
        }
        backdropPointerDown = false;
    };

    // Tab Switchers
    const tabBtnBackup = modal.querySelector('#tabBtnBackup');
    const tabBtnRestore = modal.querySelector('#tabBtnRestore');
    const tabBtnReload = modal.querySelector('#tabBtnReload');
    const tabBtnCache = modal.querySelector('#tabBtnCache');
    const tabBtnOrphans = modal.querySelector('#tabBtnOrphans');
    const orphansContent = modal.querySelector('#orphansTabContent');
    const tabBtnDelete = modal.querySelector('#tabBtnDelete');
    const backupContent = modal.querySelector('#backupTabContent');
    const restoreContent = modal.querySelector('#restoreTabContent');
    const reloadContent = modal.querySelector('#reloadTabContent');
    const cacheContent = modal.querySelector('#cacheTabContent');
    const deleteContent = modal.querySelector('#deleteTabContent');

    const switchTab = (tab) => {
        if (tabBtnBackup) tabBtnBackup.className = `btn btn-sm ${tab === 'backup' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1`;
        if (tabBtnRestore) tabBtnRestore.className = `btn btn-sm ${tab === 'restore' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1`;
        if (tabBtnReload) tabBtnReload.className = `btn btn-sm ${tab === 'reload' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1`;
        if (tabBtnOrphans) tabBtnOrphans.className = `btn btn-sm ${tab === 'orphans' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1`;
        if (orphansContent) orphansContent.style.display = tab === 'orphans' ? 'block' : 'none';
        if (tabBtnCache) tabBtnCache.className = `btn btn-sm ${tab === 'cache' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1`;
        if (tabBtnDelete) tabBtnDelete.className = `btn btn-sm ${tab === 'delete' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1`;

        if (backupContent) backupContent.style.display = tab === 'backup' ? 'block' : 'none';
        if (restoreContent) restoreContent.style.display = tab === 'restore' ? 'block' : 'none';
        if (reloadContent) reloadContent.style.display = tab === 'reload' ? 'block' : 'none';
        if (cacheContent) cacheContent.style.display = tab === 'cache' ? 'block' : 'none';
        if (deleteContent) deleteContent.style.display = tab === 'delete' ? 'block' : 'none';
    };

    tabBtnBackup?.addEventListener('click', () => switchTab('backup'));
    tabBtnRestore?.addEventListener('click', () => switchTab('restore'));
    tabBtnReload?.addEventListener('click', () => switchTab('reload'));
    tabBtnCache?.addEventListener('click', () => switchTab('cache'));
    tabBtnOrphans?.addEventListener('click', () => switchTab('orphans'));

    // --- ORPHANED FILES ---
    const orphansList = modal.querySelector('#orphansList');
    const orphansDeleteBtn = modal.querySelector('#orphansDeleteBtn');
    const orphansStatusAlert = modal.querySelector('#orphansStatusAlert');
    const updateOrphansDeleteBtn = () => {
        const n = orphansList.querySelectorAll('.orphan-check:checked').length;
        orphansDeleteBtn.disabled = n === 0;
        orphansDeleteBtn.innerHTML = `<i class="bi-trash3"></i> Delete Selected${n ? ` (${n})` : ''}`;
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
        orphansDeleteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span> Deleting...';
        try {
            await deleteOrphanedStoredFiles(ids);
            orphansStatusAlert.style.display = 'block';
            orphansStatusAlert.className = 'small mb-2 text-success fw-semibold';
            orphansStatusAlert.innerHTML = `<i class="bi-check-circle-fill me-1"></i> Removed ${ids.length} orphaned ${ids.length === 1 ? 'file' : 'files'}.`;
            showToast('Orphaned files removed', 'success');
        } catch (err) {
            console.error('Failed to delete orphaned files:', err);
            orphansStatusAlert.style.display = 'block';
            orphansStatusAlert.className = 'small mb-2 text-danger fw-semibold';
            orphansStatusAlert.innerHTML = `<i class="bi-exclamation-triangle-fill me-1"></i> Failed: ${escapeHtml(err.message)}`;
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
        snapOrphansStatus.style.display = html ? 'block' : 'none';
        snapOrphansStatus.className = `small mt-2 ${cls}`;
        snapOrphansStatus.innerHTML = html;
    };
    const updateSnapOrphansDeleteBtn = () => {
        const n = snapOrphansList.querySelectorAll('.snapshot-orphan-check:checked').length;
        snapOrphansDeleteBtn.disabled = n === 0;
        snapOrphansDeleteBtn.innerHTML = `<i class="bi-trash3"></i> Delete Selected${n ? ` (${n})` : ''}`;
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
        snapOrphansList.innerHTML = '<div class="small text-white-50"><span class="spinner-border spinner-border-sm me-2" role="status"></span>Scanning snapshots...</div>';
        snapOrphanBackend = null;
        snapOrphanFiles = [];
        updateSnapOrphansDeleteBtn();
        try {
            const target = await resolveIncrementalTarget({ interactive: true, provider });
            if (target.status !== 'ready') {
                snapOrphansList.innerHTML = '';
                return setSnapStatus('text-white-50', `<i class="bi-info-circle me-1"></i> ${target.status === 'needs-auth' ? 'Connect Google Drive from the Create Backup tab first.' : 'Choose a backup folder and allow access to scan it.'}`);
            }
            const { findUnusedBlobs } = await import('./incrementalBackup.js');
            snapOrphanScope = getSnapScope();
            const found = await findUnusedBlobs(target.backend, { scope: snapOrphanScope });
            snapOrphanBackend = target.backend;
            if (!found.snapshotCount) {
                snapOrphansList.innerHTML = '<div class="text-white-50 small">No incremental snapshots found there.</div>';
                return;
            }
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
        snapOrphansDeleteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span> Deleting...';
        try {
            const { deleteBlobs, findUnusedBlobs } = await import('./incrementalBackup.js');
            await deleteBlobs(snapOrphanBackend, chosen);
            setSnapStatus('text-success fw-semibold', `<i class="bi-check-circle-fill me-1"></i> Removed ${chosen.length} ${chosen.length === 1 ? 'file' : 'files'} from incremental backups.`);
            showToast('Backup files removed', 'success');
            renderSnapOrphans(await findUnusedBlobs(snapOrphanBackend, { scope: snapOrphanScope }));
        } catch (err) {
            console.error('Failed to delete snapshot orphans:', err);
            setSnapStatus('text-danger fw-semibold', `<i class="bi-exclamation-triangle-fill me-1"></i> Failed: ${escapeHtml(err.message)}`);
            updateSnapOrphansDeleteBtn();
        }
    });
    tabBtnDelete?.addEventListener('click', () => switchTab('delete'));

    // --- CLEAR CACHE ACTION ---
    const cacheExecuteBtn = modal.querySelector('#cacheExecuteBtn');
    const cacheStatusAlert = modal.querySelector('#cacheStatusAlert');
    cacheExecuteBtn?.addEventListener('click', async () => {
        cacheExecuteBtn.disabled = true;
        cacheExecuteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span> Clearing Cache...';
        try {
            const count = await clearAppCache();
            if (cacheStatusAlert) {
                cacheStatusAlert.style.display = 'block';
                cacheStatusAlert.className = 'small mb-2 text-success fw-semibold';
                cacheStatusAlert.innerHTML = `<i class="bi-check-circle-fill me-1"></i> Cache cleared successfully! Removed ${count} cached items.`;
            }
            cacheExecuteBtn.innerHTML = '<i class="bi-check2"></i> Cleared';
            showToast('Application cache cleared', 'success');
            setTimeout(() => {
                cacheExecuteBtn.disabled = false;
                cacheExecuteBtn.innerHTML = '<i class="bi-brush"></i> Clear Cache';
            }, 3000);
        } catch (err) {
            console.error('Failed to clear cache:', err);
            if (cacheStatusAlert) {
                cacheStatusAlert.style.display = 'block';
                cacheStatusAlert.className = 'small mb-2 text-danger fw-semibold';
                cacheStatusAlert.innerHTML = `<i class="bi-exclamation-triangle-fill me-1"></i> Failed to clear cache: ${escapeHtml(err.message)}`;
            }
            cacheExecuteBtn.disabled = false;
            cacheExecuteBtn.innerHTML = '<i class="bi-brush"></i> Try Again';
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
        if (provider === 'google-drive') {
            const { isTokenValid, ensureFreshToken } = await import('./googleDrive.js');
            await ensureFreshToken();
            if (!isTokenValid()) return { status: 'needs-auth' };
            const { createDriveBackend } = await import('./driveBackup.js');
            return { status: 'ready', backend: createDriveBackend() };
        }
        const folders = await import('./folderBackup.js');
        let handle = await folders.getSavedBackupFolder();
        if (!handle && interactive) handle = await folders.pickBackupFolder();
        if (!handle) return { status: 'needs-folder' };
        const granted = interactive
            ? await folders.ensureFolderPermission(handle)
            : (await folders.queryFolderPermission(handle)) === 'granted';
        if (!granted) return { status: 'needs-permission', folderName: handle.name };
        return { status: 'ready', backend: folders.createFolderBackend(handle) };
    };

    let previewRequest = 0;
    const renderIncrementalPreview = async () => {
        if (!backupIncrementalPreview) return;
        const request = ++previewRequest;
        const isDrive = getBackupProviderId() === 'google-drive';
        const where = isDrive ? 'Google Drive' : 'the backup folder';
        const note = (html) => { if (request === previewRequest) backupIncrementalPreview.innerHTML = html; };
        const actionBtn = (action, icon, label) => `<button type="button" class="btn btn-sm btn-theme-outline px-3 mt-2 d-inline-flex align-items-center gap-1" data-backup-action="${action}"><i class="${icon}"></i> <span>${label}</span></button>`;

        note('<div class="small text-white-50"><span class="spinner-border spinner-border-sm me-2" role="status"></span>Checking for existing backups...</div>');
        try {
            const target = await resolveIncrementalTarget();
            if (target.status === 'needs-auth') {
                return note(`<div class="small text-white-50"><i class="bi-info-circle me-1"></i> Connect Google Drive to back up there and see what changed since your last backup.</div>${actionBtn('connect', 'bi-google text-danger', 'Connect Google Drive')}`);
            }
            if (target.status === 'needs-folder') {
                return note(`<div class="small text-white-50"><i class="bi-info-circle me-1"></i> Choose a folder on this device to keep your backups in.</div>${actionBtn('choose-folder', 'bi-folder2-open text-primary', 'Choose Folder')}`);
            }
            if (target.status === 'needs-permission') {
                return note(`<div class="small text-white-50"><i class="bi-lock me-1"></i> MajesticTab needs permission to use "${escapeHtml(target.folderName)}" again.</div>${actionBtn('allow-folder', 'bi-unlock text-primary', 'Allow Access')} ${actionBtn('choose-folder', 'bi-folder2-open text-primary', 'Choose Another')}`);
            }

            const { previewIncrementalBackup } = await import('./incrementalBackup.js');
            const p = await previewIncrementalBackup(target.backend);
            const when = p.latest ? new Date(p.latest.exportedAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            const head = p.latest
                ? `<i class="bi-check-circle text-success me-1"></i> Last backup ${escapeHtml(when)} (${p.backupCount} saved)`
                : `<i class="bi-exclamation-circle text-warning me-1"></i> No backup in ${where} yet. This will be your first.`;
            const stat = changeStatHtml;
            const nothing = p.latest && !p.added && !p.modified && !p.removed;
            note(`
                <div class="d-flex align-items-start justify-content-between gap-2 mb-2">
                    <div class="min-w-0">
                        <div class="small fw-semibold text-white">${head}</div>
                        <div class="text-white-50 text-truncate" style="font-size:0.72rem;" title="${escapeHtml(target.backend.location)}"><i class="bi-folder2 me-1"></i>${escapeHtml(target.backend.location)}</div>
                    </div>
                    <button type="button" class="btn btn-sm btn-theme-outline px-2 py-1 flex-shrink-0" style="font-size:0.72rem;" data-backup-action="${isDrive ? 'change-drive-folder' : 'choose-folder'}">Change</button>
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
                </div>`);
        } catch (err) {
            note(`<div class="small text-warning"><i class="bi-exclamation-triangle me-1"></i> Could not check ${where}: ${escapeHtml(err.message)}</div>`);
        }
    };

    backupIncrementalPreview?.addEventListener('click', async (e) => {
        const action = e.target.closest('[data-backup-action]')?.dataset.backupAction;
        if (!action) return;
        try {
            if (action === 'connect') {
                const { redirectToGoogleAuth } = await import('./googleDrive.js');
                redirectToGoogleAuth('backup_create');
                return;
            }
            if (action === 'change-drive-folder') {
                const { chooseDriveBackupFolder } = await import('./driveFolderPicker.js');
                const folder = await chooseDriveBackupFolder();
                if (!folder) return;
                const { setDriveBackupFolder } = await import('./driveBackup.js');
                setDriveBackupFolder(folder);
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
        const canIncrement = providerId === 'google-drive' || (providerId === 'local' && isFolderBackupSupported());
        if (incrementalRadio) incrementalRadio.disabled = !canIncrement;
        const hint = modal.querySelector('#backupIncrementalHint');
        if (hint) {
            hint.style.display = canIncrement ? 'none' : 'block';
            hint.textContent = providerId === 'local'
                ? 'Local folders need the desktop app, or Chrome or Edge on a computer. Use Google Drive instead, or save a single file.'
                : 'Choose Google Drive or Local Device to use incremental snapshots.';
        }
        if (incrementalOption) incrementalOption.style.opacity = canIncrement ? '' : '0.5';
        if (providerChanged && canIncrement) incrementalRadio.checked = true;
        if (!canIncrement || !incrementalRadio.checked) singleRadio.checked = true;
        const incremental = getBackupFormat() === 'incremental';
        if (backupFilenameGroup) backupFilenameGroup.style.display = incremental ? 'none' : 'block';
        if (backupIncrementalPreview) backupIncrementalPreview.style.display = incremental ? 'block' : 'none';
        if (backupExecuteBtn) backupExecuteBtn.innerHTML = incremental
            ? '<i class="bi-cloud-arrow-up"></i> Back Up Changes'
            : '<i class="bi-cloud-arrow-up"></i> Create &amp; Save Backup';
        if (incremental && refresh) renderIncrementalPreview();
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

        const backupProgressContainer = modal.querySelector('#backupProgressContainer');
        const backupProgressBar = modal.querySelector('#backupProgressBar');
        const backupProgressText = modal.querySelector('#backupProgressText');
        const backupProgressPercent = modal.querySelector('#backupProgressPercent');

        backupExecuteBtn.disabled = true;
        backupExecuteBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-2" role="status"></span> ${incremental ? 'Backing Up...' : 'Creating Backup...'}`;
        backupStatusAlert.style.display = 'block';
        backupStatusAlert.className = 'small mb-2 text-info';
        backupStatusAlert.textContent = incremental ? 'Comparing with existing backups...' : 'Packaging settings, extensions, and stored tabs...';
        if (backupProgressContainer) {
            backupProgressContainer.style.display = 'block';
            if (backupProgressBar) backupProgressBar.style.width = '0%';
            if (backupProgressPercent) backupProgressPercent.textContent = '0%';
            if (backupProgressText) backupProgressText.textContent = 'Packaging settings and tabs...';
        }

        try {
            const providerLabel = selectedProviderEl?.closest('label')?.querySelector('.leading-tight')?.textContent || providerId;
            let savedBytes = 0;
            let successMessage = null;

            if (incremental) {
                // Only tabs and SoundFonts the destination doesn't already hold are stored
                const target = await resolveIncrementalTarget({ interactive: true });
                if (target.status === 'needs-auth') {
                    const { redirectToGoogleAuth } = await import('./googleDrive.js');
                    redirectToGoogleAuth('backup_create');
                    throw new Error('Please authorize Google Drive to save the backup.');
                }
                if (target.status !== 'ready') throw new Error('Choose a backup folder and allow access to it first.');
                const { createIncrementalBackup } = await import('./incrementalBackup.js');
                const result = await createIncrementalBackup(target.backend, {
                    onProgress: ({ phase, current, total, bytesSent, uploaded = 0, reused = 0, name }) => {
                        const pct = phase === 'manifest' ? 99 : total > 0 ? Math.min(98, Math.round((current / total) * 98)) : 0;
                        const text = phase === 'scan'
                            ? 'Checking what is already backed up...'
                            : phase === 'manifest'
                                ? 'Writing backup manifest...'
                                : `Checked ${current} of ${total}: ${uploaded} saved (${formatBytes(bytesSent)}), ${reused} already backed up${name ? ` - ${name}` : ''}`;
                        if (backupProgressBar) backupProgressBar.style.width = `${pct}%`;
                        if (backupProgressPercent) backupProgressPercent.textContent = `${pct}%`;
                        if (backupProgressText) backupProgressText.textContent = text;
                        backupStatusAlert.textContent = text;
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
                        if (backupProgressBar) backupProgressBar.style.width = `${pct}%`;
                        if (backupProgressPercent) backupProgressPercent.textContent = `${pct}%`;
                        if (backupProgressText) backupProgressText.textContent = `Packaging tab ${current} of ${total}...`;
                        backupStatusAlert.textContent = `Packaging tab ${current} of ${total}...`;
                    }
                });
                savedBytes = blob.size;

                backupStatusAlert.textContent = `Saving to ${providerLabel}...`;
                if (backupProgressBar) backupProgressBar.style.width = '40%';
                if (backupProgressPercent) backupProgressPercent.textContent = '40%';
                if (backupProgressText) backupProgressText.textContent = `Saving to ${providerLabel}...`;

                await saveToProvider(providerId, blob, filename);
            }

            if (backupProgressBar) backupProgressBar.style.width = '100%';
            if (backupProgressPercent) backupProgressPercent.textContent = '100%';
            if (backupProgressText) backupProgressText.textContent = 'Backup completed successfully!';

            backupStatusAlert.className = 'small mb-2 text-success fw-semibold';
            backupStatusAlert.innerHTML = `<i class="bi-check-circle-fill me-1"></i> ${escapeHtml(successMessage || `Backup saved successfully! (${formatBytes(savedBytes)})`)}`;
            backupExecuteBtn.innerHTML = '<i class="bi-check2"></i> Saved';
            setTimeout(() => {
                backupExecuteBtn.disabled = false;
                syncBackupFormat();
                if (backupProgressContainer) backupProgressContainer.style.display = 'none';
            }, 3000);
        } catch (err) {
            console.error('Backup creation failed:', err);
            if (backupProgressContainer) backupProgressContainer.style.display = 'none';
            backupStatusAlert.className = 'small mb-2 text-danger fw-semibold';
            backupStatusAlert.innerHTML = `<i class="bi-exclamation-triangle-fill me-1"></i> Failed to save backup: ${escapeHtml(err.message)}`;
            backupExecuteBtn.disabled = false;
            backupExecuteBtn.innerHTML = '<i class="bi-cloud-arrow-up"></i> Try Again';
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

    const restoreDriveBtn = modal.querySelector('#restoreDriveBtn');
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
    const restoreDriveEmptyText = modal.querySelector('#restoreDriveEmptyText');
    // d-inline-flex is !important, so visibility is toggled by swapping classes rather than inline display
    if (restoreFolderBtn && isFolderBackupSupported()) {
        restoreFolderBtn.classList.remove('d-none');
        restoreFolderBtn.classList.add('d-inline-flex');
    }

    // Which storage the snapshot list currently shows; set by loadGoogleDriveBackups / loadFolderBackups
    let activeSource = { type: 'drive', backend: null };

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
            if (restoreSourceIcon) restoreSourceIcon.className = 'bi-google text-danger';
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

    // Lists snapshots in a local backup folder. Must start from a click (folder access needs a gesture).
    const loadFolderBackups = async ({ pickNew = false } = {}) => {
        const folders = await import('./folderBackup.js');
        try {
            let handle = pickNew ? null : await folders.getSavedBackupFolder();
            if (!handle) handle = await folders.pickBackupFolder();
            if (!handle) return;
            if (!(await folders.ensureFolderPermission(handle))) {
                showToast('Access to the backup folder was not granted.', 'warning');
                return;
            }

            const backend = folders.createFolderBackend(handle);
            activeSource = { type: 'folder', backend };
            if (restoreDriveContainer) restoreDriveContainer.style.display = 'block';
            if (restoreDriveLoading) restoreDriveLoading.style.display = 'block';
            if (restoreDriveEmpty) restoreDriveEmpty.style.display = 'none';
            if (restoreDriveError) restoreDriveError.style.display = 'none';
            if (restoreDriveList) restoreDriveList.innerHTML = '';
            if (restoreSourceIcon) restoreSourceIcon.className = 'bi-hdd text-primary';
            if (restoreSourceTitle) restoreSourceTitle.textContent = 'Backup Folder:';
            if (restoreSourceLocation) restoreSourceLocation.textContent = backend.location;
            if (restoreDriveEmptyText) restoreDriveEmptyText.textContent = 'No snapshots found in this folder.';

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

    restoreFolderBtn?.addEventListener('click', () => loadFolderBackups());
    restoreChangeLocationBtn?.addEventListener('click', async () => {
        if (activeSource.type === 'folder') {
            loadFolderBackups({ pickNew: true });
            return;
        }
        try {
            const { chooseDriveBackupFolder } = await import('./driveFolderPicker.js');
            const folder = await chooseDriveBackupFolder();
            if (!folder) return;
            const { setDriveBackupFolder } = await import('./driveBackup.js');
            setDriveBackupFolder(folder);
            loadGoogleDriveBackups();
        } catch (err) {
            showToast(err.message, 'error');
        }
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
                    ? [plural(b.counts.tabs, 'tab'), b.counts.soundFonts ? plural(b.counts.soundFonts, 'SoundFont') : null].filter(Boolean).join(' • ')
                    : 'Incremental snapshot')
                : `${dateStr} • ${sizeStr}`;

            const item = document.createElement('div');
            item.className = 'drive-backup-item d-flex align-items-center justify-content-between p-2 rounded-2';
            item.style.cursor = 'pointer';
            item.setAttribute('data-file-id', b.id);
            item.setAttribute('data-file-name', b.name);
            item.innerHTML = `
                <div class="d-flex align-items-center gap-2 min-w-0 me-2 text-start">
                    <i class="bi-archive-fill text-info flex-shrink-0 fs-5"></i>
                    <div class="text-truncate">
                        <div class="fw-semibold text-white small text-truncate" title="${escapeHtml(b.name)}">${escapeHtml(title)}</div>
                        <div class="text-white-50" style="font-size: 0.7rem;">${escapeHtml(subtitle)}</div>
                    </div>
                </div>
                <div class="d-flex align-items-center gap-2 flex-shrink-0 ms-2">
                    <button type="button" class="btn btn-sm btn-theme-outline px-2 py-1 d-inline-flex align-items-center gap-1 select-drive-backup-btn" style="font-size: 0.72rem;">
                        <i class="bi-download"></i> <span>Select</span>
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
                    btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> <span class="ms-1">Loading...</span>';
                }

                const dlProgressContainer = modal.querySelector('#restoreDriveDownloadProgress');
                const dlProgressBar = modal.querySelector('#restoreDriveProgressBar');
                const dlProgressPercent = modal.querySelector('#restoreDriveProgressPercent');
                const dlProgressName = modal.querySelector('#restoreDriveProgressName');
                const dlProgressBytes = modal.querySelector('#restoreDriveProgressBytes');

                if (dlProgressContainer) {
                    dlProgressContainer.style.display = 'block';
                    if (dlProgressName) dlProgressName.textContent = `Downloading ${b.name}...`;
                    if (dlProgressBar) dlProgressBar.style.width = '0%';
                    if (dlProgressPercent) dlProgressPercent.textContent = '0%';
                    if (dlProgressBytes) dlProgressBytes.textContent = `0 B / ${formatBytes(b.size || 0)}`;
                }

                try {
                    if (b.incremental) {
                        // Only the small manifest is fetched now; tab data downloads during restore
                        const { loadIncrementalBundle } = await import('./incrementalBackup.js');
                        const bundle = await loadIncrementalBundle(activeSource.backend, b);
                        bundle.name = `Snapshot · ${dateStr}`;
                        bundle.size = bundle.summary?.totalTabsSize || 0;
                        if (dlProgressContainer) dlProgressContainer.style.display = 'none';
                        await handleSelectedBackupFile(bundle, activeSource.type === 'folder' ? 'Backup Folder' : 'Google Drive');
                        return;
                    }
                    const { downloadDriveBackupFile } = await import('./googleDrive.js');
                    const fileObj = await downloadDriveBackupFile(b.id, b.name, ({ loaded, total, percent }) => {
                        if (dlProgressBar) dlProgressBar.style.width = `${percent}%`;
                        if (dlProgressPercent) dlProgressPercent.textContent = `${percent}%`;
                        if (dlProgressBytes) dlProgressBytes.textContent = `${formatBytes(loaded)} / ${formatBytes(total || b.size || loaded)}`;
                        if (btn) btn.innerHTML = `<span class="spinner-border spinner-border-sm" role="status"></span> <span class="ms-1">${percent}%</span>`;
                    });
                    if (dlProgressContainer) dlProgressContainer.style.display = 'none';
                    await handleSelectedBackupFile(fileObj, 'Google Drive');
                } catch (dlErr) {
                    if (dlProgressContainer) dlProgressContainer.style.display = 'none';
                    console.error('Failed to download Drive backup:', dlErr);
                    if (restoreDriveError) {
                        restoreDriveError.style.display = 'block';
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
                            restoreDriveError.textContent = `Failed to download "${b.name}": ${dlErr.message}`;
                        }
                    }
                    restoreDriveList.querySelectorAll('.drive-backup-item').forEach(el => {
                        el.style.pointerEvents = '';
                        el.style.opacity = '';
                    });
                    if (btn) {
                        btn.disabled = false;
                        btn.innerHTML = '<i class="bi-download"></i> <span>Select</span>';
                    }
                }
            };

            item.addEventListener('click', onSelect);
            item.querySelector('.select-drive-backup-btn')?.addEventListener('click', onSelect);

            restoreDriveList.appendChild(item);
        });
    };

    restoreDriveBtn?.addEventListener('click', loadGoogleDriveBackups);
    if (options.autoLoadDrive) {
        loadGoogleDriveBackups();
    }
    restoreDriveCloseBtn?.addEventListener('click', () => {
        if (restoreDriveContainer) restoreDriveContainer.style.display = 'none';
    });

    if (activeGoogleAuthHandler) {
        window.removeEventListener('googleAuthSuccess', activeGoogleAuthHandler);
    }
    activeGoogleAuthHandler = (e) => {
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
    const renderRestorePreview = async () => {
        if (!restoreIncrementalPreview) return;
        const bundle = currentBackupFile;
        const isSnapshot = Array.isArray(bundle?.files) && bundle.files.some(f => f.blob);
        restoreIncrementalPreview.style.display = isSnapshot ? 'block' : 'none';
        if (!isSnapshot) { restorePreviewData = null; return; }

        try {
            if (!restorePreviewData || restorePreviewData.bundle !== bundle) {
                restoreIncrementalPreview.innerHTML = '<div class="small text-white-50"><span class="spinner-border spinner-border-sm me-2" role="status"></span>Comparing with this device...</div>';
                const { previewIncrementalRestore } = await import('./incrementalBackup.js');
                restorePreviewData = { bundle, summary: await previewIncrementalRestore(bundle) };
                if (currentBackupFile !== bundle) return;
            }
            const p = restorePreviewData.summary;
            const wipe = modal.querySelector('input[name="restoreModeRadio"]:checked')?.value === 'wipe';
            const stats = wipe
                ? [changeStatHtml(p.total, 'Tabs restored', 'text-success'), changeStatHtml(p.localOnly, 'Erased from device', 'text-warning')]
                : [changeStatHtml(p.missing, 'Tabs to restore', 'text-success'), changeStatHtml(p.same + p.differs, 'Already on device', 'text-white'), changeStatHtml(p.localOnly, 'Only on device (kept)', 'text-info')];
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

            restoreStatusAlert.style.display = 'block';
            restoreStatusAlert.className = 'small mb-2 text-info text-center';
            restoreStatusAlert.innerHTML = `
                <div class="d-flex align-items-center justify-content-center gap-2 py-2">
                    <span class="spinner-border spinner-border-sm" role="status"></span>
                    <span>Reading and verifying backup (${formatBytes(file.size)})...</span>
                </div>
            `;
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

    // Change File Button
    modal.querySelector('#restoreChangeFileBtn')?.addEventListener('click', () => {
        currentBackupFile = null;
        currentParsedBackup = null;
        restoreInspectionCard.style.display = 'none';
        restoreDropzone.style.display = 'block';
        restoreExecuteBtn.disabled = true;
        restoreFileInput.value = '';
    });

    // Mode Radio Change (Show wipe confirmation)
    const modeRadios = modal.querySelectorAll('input[name="restoreModeRadio"]');
    modeRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.value === 'wipe') {
                wipeConfirmContainer.style.display = 'block';
            } else {
                wipeConfirmContainer.style.display = 'none';
                wipeConfirmCheckbox.checked = false;
            }
            renderRestorePreview();
        });
    });

    // --- RESTORE ACTION ---
    restoreExecuteBtn?.addEventListener('click', async () => {
        if (!currentBackupFile && !currentParsedBackup) return;

        const selectedModeEl = modal.querySelector('input[name="restoreModeRadio"]:checked');
        const mode = selectedModeEl?.value || 'merge';

        if (mode === 'wipe' && !wipeConfirmCheckbox.checked) {
            restoreStatusAlert.style.display = 'block';
            restoreStatusAlert.className = 'small mb-2 text-warning fw-semibold';
            restoreStatusAlert.textContent = 'Please confirm by checking the box before wiping and replacing.';
            return;
        }

        restoreExecuteBtn.disabled = true;
        restoreExecuteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span> Restoring Data...';
        restoreStatusAlert.style.display = 'block';
        restoreStatusAlert.className = 'small mb-2 text-info';
        restoreStatusAlert.textContent = mode === 'wipe' ? 'Wiping and restoring fresh from backup...' : 'Merging missing tabs and settings...';

        try {
            const results = await restoreBackup(currentBackupFile || currentParsedBackup, {
                mode,
                onProgress: (current, total) => {
                    if (total > 0) {
                        restoreStatusAlert.textContent = `Restoring tab ${current} of ${total}...`;
                    }
                }
            });

            currentParsedBackup = null;

            restoreStatusAlert.className = 'small mb-2 text-success fw-semibold';
            const details = [];
            if (results.filesImported > 0) details.push(`${results.filesImported} tabs imported`);
            if (results.soundFontsImported > 0) details.push(`${results.soundFontsImported} SoundFonts imported`);
            if (results.filesSkipped > 0) details.push(`${results.filesSkipped} existing tabs kept`);
            if (results.songsImported > 0) details.push(`${results.songsImported} library songs added/merged`);
            if (results.extensionsImported > 0) details.push(`${results.extensionsImported} extensions updated`);
            if (results.settingsApplied > 0) details.push('preferences restored');

            const summaryStr = details.length > 0 ? details.join(', ') : 'All data up to date';
            restoreStatusAlert.innerHTML = `
              <div class="d-flex align-items-center gap-2 mb-1">
                <i class="bi-check-circle-fill text-success fs-6"></i>
                <strong>Restore Complete! (${mode === 'wipe' ? 'Wipe & Replace' : 'Merged'})</strong>
              </div>
              <div class="text-white-50 small">${escapeHtml(summaryStr)}.</div>
            `;

            // Auto-refresh Tab Library UI
            try {
                const { renderLibraryModal } = await import('./libraryModal.js');
                await renderLibraryModal();
            } catch (e) {
                console.warn('Could not refresh library view:', e);
            }

            restoreExecuteBtn.innerHTML = '<i class="bi-check2"></i> Restored';
            setTimeout(() => {
                restoreExecuteBtn.disabled = false;
                restoreExecuteBtn.innerHTML = '<i class="bi-cloud-arrow-down"></i> Restore Data';
            }, 3000);
        } catch (err) {
            console.error('Restore failed:', err);
            restoreStatusAlert.className = 'small mb-2 text-danger fw-semibold';
            restoreStatusAlert.innerHTML = `<i class="bi-exclamation-triangle-fill me-1"></i> Failed to restore backup: ${escapeHtml(err.message)}`;
            restoreExecuteBtn.disabled = false;
            restoreExecuteBtn.innerHTML = '<i class="bi-cloud-arrow-down"></i> Try Again';
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
        deleteExecuteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span> Deleting All Data...';
        deleteStatusAlert.style.display = 'block';
        deleteStatusAlert.className = 'small mb-2 text-info';
        deleteStatusAlert.textContent = 'Clearing stored tabs, library, extensions, and settings...';

        try {
            await deleteAllAppData();

            deleteStatusAlert.className = 'small mb-2 text-success fw-semibold';
            deleteStatusAlert.innerHTML = '<i class="bi-check-circle-fill me-1"></i> All application data and settings deleted successfully.';
            deleteExecuteBtn.innerHTML = '<i class="bi-check2"></i> Deleted';

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
            deleteStatusAlert.className = 'small mb-2 text-danger fw-semibold';
            deleteStatusAlert.innerHTML = `<i class="bi-exclamation-triangle-fill me-1"></i> Failed to delete data: ${escapeHtml(err.message)}`;
            deleteExecuteBtn.disabled = false;
            deleteExecuteBtn.innerHTML = '<i class="bi-trash3-fill"></i> Delete All Data';
        }
    });

    // --- RELOAD METADATA ACTION ---
    const reloadExecuteBtn = modal.querySelector('#reloadExecuteBtn');
    const reloadCancelBtn = modal.querySelector('#reloadCancelBtn');
    const reloadProgressContainer = modal.querySelector('#reloadProgressContainer');
    const reloadProgressBar = modal.querySelector('#reloadProgressBar');
    const reloadPercentLabel = modal.querySelector('#reloadPercentLabel');
    const reloadCurrentActionLabel = modal.querySelector('#reloadCurrentActionLabel');
    const reloadItemsCountLabel = modal.querySelector('#reloadItemsCountLabel');
    const reloadStatsLiveLabel = modal.querySelector('#reloadStatsLiveLabel');
    const reloadStatusAlert = modal.querySelector('#reloadStatusAlert');

    const updateReloadProgressUI = (progress) => {
        if (!progress) return;
        const { current = 0, total = 0, percent = 0, phase = '', name = '', stats: curStats = {} } = progress;
        if (reloadPercentLabel) reloadPercentLabel.textContent = `${percent}%`;
        if (reloadProgressBar) reloadProgressBar.style.width = `${percent}%`;
        if (reloadCurrentActionLabel) {
            reloadCurrentActionLabel.innerHTML = `
              <span class="spinner-border spinner-border-sm text-primary flex-shrink-0" role="status"></span>
              <span class="text-truncate">${escapeHtml(name || 'Fetching metadata...')}</span>
            `;
        }
        if (reloadItemsCountLabel) {
            const phaseLabel = phase === 'album' ? 'album' : (phase === 'tuning' ? 'tab file' : 'song');
            reloadItemsCountLabel.textContent = `Processed ${current} of ${total} (${phaseLabel})`;
        }
        if (reloadStatsLiveLabel) {
            reloadStatsLiveLabel.textContent = `Durations: ${curStats.addedDurations || 0} • Artwork: ${curStats.addedCovers || 0} • Tunings: ${curStats.updatedTunings || 0}`;
        }
    };

    // Check if reload is already running when opening/rendering modal
    if (activeReloadState.running) {
        if (reloadExecuteBtn) {
            reloadExecuteBtn.disabled = true;
            reloadExecuteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span> Reloading...';
        }
        if (reloadCancelBtn) reloadCancelBtn.textContent = 'Stop / Cancel';
        if (reloadProgressContainer) reloadProgressContainer.style.display = 'block';
        if (reloadStatusAlert) {
            reloadStatusAlert.style.display = 'none';
            reloadStatusAlert.innerHTML = '';
        }
        updateReloadProgressUI(activeReloadState.progress);
    }

    const progressListener = (p) => {
        updateReloadProgressUI(p);
    };
    activeReloadState.listeners.add(progressListener);

    const completionListener = async ({ stats, error, aborted }) => {
        if (reloadProgressContainer) reloadProgressContainer.style.display = 'none';
        if (reloadCancelBtn) reloadCancelBtn.textContent = 'Cancel';

        if (aborted) {
            if (reloadStatusAlert) {
                reloadStatusAlert.style.display = 'block';
                reloadStatusAlert.className = 'small mb-2 text-warning fw-semibold';
                reloadStatusAlert.innerHTML = '<i class="bi-exclamation-triangle-fill me-1"></i> Metadata reload was cancelled by user.';
            }
            if (reloadExecuteBtn) {
                reloadExecuteBtn.disabled = false;
                reloadExecuteBtn.innerHTML = '<i class="bi-arrow-repeat"></i> Reload Library Metadata';
            }
        } else if (error) {
            if (reloadStatusAlert) {
                reloadStatusAlert.style.display = 'block';
                reloadStatusAlert.className = 'small mb-2 text-danger fw-semibold';
                reloadStatusAlert.innerHTML = `<i class="bi-exclamation-triangle-fill me-1"></i> Failed to reload metadata: ${escapeHtml(error.message)}`;
            }
            if (reloadExecuteBtn) {
                reloadExecuteBtn.disabled = false;
                reloadExecuteBtn.innerHTML = '<i class="bi-arrow-repeat"></i> Try Again';
            }
        } else if (stats) {
            if (reloadStatusAlert) {
                reloadStatusAlert.style.display = 'block';
                reloadStatusAlert.className = 'small mb-2 text-success fw-semibold';
                const details = [];
                if (stats.updatedAlbums > 0) details.push(`${stats.updatedAlbums} albums refreshed`);
                if (stats.updatedSongs > 0) details.push(`${stats.updatedSongs} songs updated`);
                const scrubbedCount = stats.scrubbedNonCdTracks || stats.scrubbedDvdTracks || 0;
                if (scrubbedCount > 0) details.push(`${scrubbedCount} non-CD (DVD/Vinyl) tracks removed`);
                if (stats.updatedTunings > 0) details.push(`${stats.updatedTunings} song tunings detected from tab files`);
                if (stats.addedDurations > 0) details.push(`${stats.addedDurations} track durations added`);
                if (stats.addedCovers > 0) details.push(`${stats.addedCovers} album covers added`);
                const summaryText = details.length > 0 ? details.join(', ') : 'All tracks and tab tunings are up to date';

                reloadStatusAlert.innerHTML = `
                  <div class="d-flex align-items-center gap-2 mb-1">
                    <i class="bi-check-circle-fill text-success fs-6"></i>
                    <strong>Metadata Reload Complete!</strong>
                  </div>
                  <div class="text-white-50 small">${escapeHtml(summaryText)}.</div>
                `;
            }

            try {
                const updatedLib = await getAllLibraryData();
                const updatedMissingDur = (updatedLib.songs || []).filter(s => !s.length || s.length <= 0).length;
                const updatedMissingCov = (updatedLib.songs || []).filter(s => !s.coverUrl || s.coverUrl.includes('data:image/svg+xml')).length;

                const statMissingDur = modal.querySelector('#reloadStatMissingDuration');
                const statMissingCov = modal.querySelector('#reloadStatMissingCovers');
                if (statMissingDur) {
                    statMissingDur.textContent = updatedMissingDur;
                    statMissingDur.className = `text-white fw-bold fs-6 ${updatedMissingDur > 0 ? 'text-warning' : 'text-success'}`;
                }
                if (statMissingCov) {
                    statMissingCov.textContent = updatedMissingCov;
                    statMissingCov.className = `text-white fw-bold fs-6 ${updatedMissingCov > 0 ? 'text-warning' : 'text-success'}`;
                }
            } catch {}

            if (reloadExecuteBtn) {
                reloadExecuteBtn.innerHTML = '<i class="bi-check2"></i> Finished';
                setTimeout(() => {
                    if (reloadExecuteBtn) {
                        reloadExecuteBtn.disabled = false;
                        reloadExecuteBtn.innerHTML = '<i class="bi-arrow-repeat"></i> Reload Library Metadata';
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
            name: 'Connecting to MusicBrainz & analyzing tab files...',
            stats: { addedDurations: 0, addedCovers: 0, updatedTunings: 0 }
        };

        reloadExecuteBtn.disabled = true;
        reloadExecuteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span> Reloading...';
        if (reloadCancelBtn) reloadCancelBtn.textContent = 'Stop / Cancel';

        if (reloadProgressContainer) reloadProgressContainer.style.display = 'block';
        if (reloadStatusAlert) {
            reloadStatusAlert.style.display = 'none';
            reloadStatusAlert.innerHTML = '';
        }
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
