// backupRestore.js
// Complete single-file Backup and Restore engine for MajesticTab.
// Bundles all settings, custom extensions, downloaded tabs local store, and library hierarchy.

import {
    getDB, STORE_NAME, getAllStoredFiles, getStoredFileRecord, clearAllStoredFiles,
    arrayBufferToBase64, arrayBufferToBase64Async, base64ToArrayBuffer
} from './fileStore.js';
import {
    ensureDefaultCollection, getAllLibraryData, importLibraryData, clearAllLibraryData,
    reloadAllLibraryMetadata
} from './libraryStore.js';
import {
    getSaveProviders, saveToProvider, openFromProvider
} from './fileProviders.js';
import { setTheme, setSheetMode, getCurrentTheme } from './themeEngine.js';
import { setGpDisplayScale } from './gpProcessor/gpProcessor.js';
import { installExtensionSources } from './fileAdapters.js';

let modalElement = null;
let currentBackupFile = null;
let currentParsedBackup = null;

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
    'instrumentMode',
    'majestictab_instrument_mode'
];

/**
 * Format bytes to readable string (e.g. 1.2 MB)
 */
function formatBytes(bytes, decimals = 1) {
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
function escapeHtml(str) {
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
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('yt_cache_')) {
            ytCache[k] = localStorage.getItem(k);
        }
    }
    if (Object.keys(ytCache).length > 0) {
        settings.ytCache = ytCache;
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

/**
 * Create a complete single-file backup bundle Blob without holding all binary data in memory simultaneously.
 * @param {function(current: number, total: number): void} [onProgress]
 * @param {object} [options]
 * @param {boolean} [options.compress=true] - Whether to compress with Gzip
 * @returns {Promise<Blob>} Complete backup bundle as Blob (compressed by default)
 */
export async function createBackupBlob(onProgress, { compress = true } = {}) {
    const [fileMetas, libraryData] = await Promise.all([
        getAllStoredFiles(),
        getAllLibraryData()
    ]);

    const settings = collectAllSettings();
    const extensions = collectExtensions();

    const summary = {
        tabsCount: fileMetas.length,
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
    const prefix = headerJson.slice(0, -1) + ',"fileStore":{"files":[';
    const blobParts = [prefix];

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

        const fileJson = (i > 0 ? ',' : '') + JSON.stringify(fileEntry);
        blobParts.push(fileJson);

        if (typeof onProgress === 'function') {
            onProgress(i + 1, fileMetas.length);
        }
    }

    blobParts.push(']}}');
    const jsonBlob = new Blob(blobParts, { type: 'application/json' });
    if (compress && typeof CompressionStream !== 'undefined') {
        try {
            const stream = jsonBlob.stream().pipeThrough(new CompressionStream('gzip'));
            return await new Response(stream).blob();
        } catch (e) {
            console.warn('[Backup] CompressionStream failed, using uncompressed JSON:', e);
            return jsonBlob;
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

        if (isGzip && typeof DecompressionStream !== 'undefined') {
            const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
            const response = new Response(stream);
            return await response.text();
        }
    } catch (e) {
        console.warn('[Restore] DecompressionStream attempt failed, falling back to raw text:', e);
    }
    return await file.text();
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

    const now = new Date();
    const bundle = {
        app: 'MajesticTab',
        format: 'majestictab_backup',
        version: 1,
        exportedAt: now.toISOString(),
        summary: {
            tabsCount: files.length,
            totalTabsSize: files.reduce((acc, f) => acc + (f.size || 0), 0),
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
 * Inspect and validate a backup file / string
 * @param {string|object} fileContent
 * @returns {object} Inspection summary
 */
export function inspectBackupFile(fileContent) {
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

    let totalSize = 0;
    for (const f of files) {
        totalSize += f.size || (f.dataBase64 ? Math.round(f.dataBase64.length * 0.75) : 0);
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
        tabsCount: files.length,
        totalTabsSize: totalSize,
        songsCount: songs.length,
        collectionsCount: collections.length,
        extensionsCount: extensions.length,
        settingsCount: Object.keys(settings).length,
        data: parsed
    };
}

/**
 * Restore a backup bundle with either 'merge' or 'wipe' mode
 * @param {object} bundle - Parsed backup bundle
 * @param {object} options - { mode: 'merge' | 'wipe', onProgress?: function(current: number, total: number): void }
 * @returns {Promise<object>} Results of the restore operation
 */
export async function restoreBackup(bundle, { mode = 'merge', onProgress } = {}) {
    if (!bundle || typeof bundle !== 'object') {
        throw new Error('Invalid backup bundle provided.');
    }

    const wipe = mode === 'wipe';
    const db = await getDB();

    // 1. If Wipe mode, clear everything first
    if (wipe) {
        await clearAllStoredFiles();
        await clearAllLibraryData();

        // Clear settings
        for (const key of APP_SETTINGS_KEYS) {
            localStorage.removeItem(key);
        }
        localStorage.removeItem('customExtensions');

        // Clear YouTube cache keys
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('yt_cache_')) keysToRemove.push(k);
        }
        for (const k of keysToRemove) localStorage.removeItem(k);
    }

    let filesImported = 0;
    let filesSkipped = 0;

    // 2. Restore / Merge File Store (Stored Tabs)
    const files = bundle.fileStore?.files || (Array.isArray(bundle.files) ? bundle.files : []);
    const totalFiles = files.length;
    for (let i = 0; i < totalFiles; i++) {
        const item = files[i];
        if (!item || !item.id || !item.name || !item.dataBase64) continue;

        if (typeof onProgress === 'function') {
            onProgress(i + 1, totalFiles);
        }

        const arrayBuffer = base64ToArrayBuffer(item.dataBase64);
        // Dereference base64 string immediately so garbage collection can free it
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
                // Merge mode: check if file already exists
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

    // 3. Restore / Merge Library (Collections, Songs, Recents)
    let libraryResults = { collectionsCount: 0, songsCount: 0, recentsCount: 0 };
    if (bundle.library && typeof bundle.library === 'object') {
        libraryResults = await importLibraryData(bundle.library, { wipe });
    }

    // 4. Restore / Merge Custom Extensions
    let extensionsImported = 0;
    const backupExtensions = Array.isArray(bundle.extensions) ? bundle.extensions : [];
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
                    // Update if existing version differs
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

    // 5. Restore / Merge Settings
    let settingsApplied = 0;
    if (bundle.settings && typeof bundle.settings === 'object') {
        for (const [key, val] of Object.entries(bundle.settings)) {
            // Strictly exclude appearance/theme and viewing preferences
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

            if (BACKUP_SETTINGS_KEYS.includes(key)) {
                const serialized = typeof val === 'object' ? JSON.stringify(val) : String(val);
                localStorage.setItem(key, serialized);
                settingsApplied++;
            }
        }
    }

    // 6. Synchronize runtime UI elements and active preferences
    applyRestoredPreferences();

    return {
        mode,
        filesImported,
        filesSkipped,
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
        if (k && (k.startsWith('yt_cache_') || k.startsWith('tab_downloader_'))) {
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
 * Apply restored preferences to active DOM and modules
 */
function applyRestoredPreferences() {
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
export async function openBackupModal(initialTab = 'backup') {
    const modal = getOrCreateModal();
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Hide fileMenu offcanvas if open
    const fileMenuEl = document.getElementById('fileMenu');
    if (fileMenuEl) {
        const offcanvas = bootstrap.Offcanvas.getInstance(fileMenuEl);
        offcanvas?.hide();
    }

    await renderModal(modal, initialTab);
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
    activeReloadState.listeners.clear();
    activeReloadState.completionListeners.clear();
}

/**
 * Renders the Data Management Modal content
 */
async function renderModal(modal, activeTab = 'backup') {
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
      <div class="backup-nav-tabs px-3 pt-2 pb-1 d-flex flex-wrap gap-2">
        <button type="button" class="btn btn-sm ${activeTab === 'backup' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1" id="tabBtnBackup">
          <i class="bi-cloud-arrow-up me-2"></i> Create Backup
        </button>
        <button type="button" class="btn btn-sm ${activeTab === 'restore' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1" id="tabBtnRestore">
          <i class="bi-cloud-arrow-down me-2"></i> Restore from Backup
        </button>
        <button type="button" class="btn btn-sm ${activeTab === 'reload' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1" id="tabBtnReload">
          <i class="bi-arrow-repeat me-2"></i> Reload Metadata
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
                    <input class="form-check-input theme-radio m-0" type="radio" name="backupTargetProvider" value="${escapeHtml(p.id)}" ${idx === 0 ? 'checked' : ''}>
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

          <!-- Filename Input -->
          <div class="mb-3">
            <label class="form-label small fw-semibold text-white-50 mb-1" for="backupFilenameInput">Filename:</label>
            <input type="text" class="form-control form-control-sm bg-dark text-white border-secondary" id="backupFilenameInput" value="${escapeHtml(defaultFilename)}">
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
            <div class="fw-bold text-white small mb-1">Select or drop a MajesticTab backup file (.mtbackup)</div>
            <div class="text-white-50 mb-3" style="font-size: 0.74rem;">Single-file backup bundle exported from MajesticTab or stored in Google Drive</div>
            <div class="d-flex justify-content-center align-items-center gap-2 flex-wrap">
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-inline-flex align-items-center gap-1" id="restoreBrowseBtn">
                <i class="bi-folder2-open text-primary"></i> <span>Browse Local File</span>
              </button>
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-inline-flex align-items-center gap-1" id="restoreDriveBtn">
                <i class="bi-google text-danger"></i> <span>Load from Google Drive</span>
              </button>
            </div>

            <!-- Inline Google Drive Backup Selector -->
            <div id="restoreDriveContainer" class="mt-3 pt-3 border-top border-secondary-subtle text-start" style="display: none;">
              <div class="d-flex align-items-center justify-content-between mb-2">
                <span class="small fw-semibold text-white d-flex align-items-center gap-1">
                  <i class="bi-google text-danger"></i> <span>Google Drive Backups:</span>
                </span>
                <button type="button" class="btn btn-sm btn-link p-0 text-white-50 text-decoration-none" id="restoreDriveCloseBtn" title="Close" aria-label="Close Google Drive backups">
                  <i class="bi-x-lg"></i>
                </button>
              </div>
              <div id="restoreDriveLoading" class="py-3 text-center text-white-50 small" style="display: none;">
                <span class="spinner-border spinner-border-sm text-primary me-2" role="status"></span>
                <span>Searching Google Drive for .mtbackup files...</span>
              </div>
              <div id="restoreDriveEmpty" class="py-3 text-center text-white-50 small" style="display: none;">
                <i class="bi-archive text-secondary fs-4 d-block mb-1"></i>
                <div>No <code>.mtbackup</code> files found in your Google Drive.</div>
              </div>
              <div id="restoreDriveError" class="py-2 text-danger small" style="display: none;"></div>
              <div id="restoreDriveList" class="d-flex flex-column gap-2" style="max-height: 220px; overflow-y: auto;"></div>
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
    attachModalHandlers(modal);
}

/**
 * Attach interactive handlers to the Data Management modal
 */
function attachModalHandlers(modal) {
    // Close button & backdrop click
    modal.querySelector('#backupModalCloseBtn')?.addEventListener('click', closeBackupModal);
    modal.querySelector('#backupCancelBtn')?.addEventListener('click', closeBackupModal);
    modal.querySelector('#restoreCancelBtn')?.addEventListener('click', closeBackupModal);
    modal.querySelector('#deleteCancelBtn')?.addEventListener('click', closeBackupModal);
    modal.onclick = (e) => {
        if (e.target === modal) closeBackupModal();
    };

    // Tab Switchers
    const tabBtnBackup = modal.querySelector('#tabBtnBackup');
    const tabBtnRestore = modal.querySelector('#tabBtnRestore');
    const tabBtnReload = modal.querySelector('#tabBtnReload');
    const tabBtnDelete = modal.querySelector('#tabBtnDelete');
    const backupContent = modal.querySelector('#backupTabContent');
    const restoreContent = modal.querySelector('#restoreTabContent');
    const reloadContent = modal.querySelector('#reloadTabContent');
    const deleteContent = modal.querySelector('#deleteTabContent');

    const switchTab = (tab) => {
        if (tabBtnBackup) tabBtnBackup.className = `btn btn-sm ${tab === 'backup' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1`;
        if (tabBtnRestore) tabBtnRestore.className = `btn btn-sm ${tab === 'restore' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1`;
        if (tabBtnReload) tabBtnReload.className = `btn btn-sm ${tab === 'reload' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1`;
        if (tabBtnDelete) tabBtnDelete.className = `btn btn-sm ${tab === 'delete' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1`;

        if (backupContent) backupContent.style.display = tab === 'backup' ? 'block' : 'none';
        if (restoreContent) restoreContent.style.display = tab === 'restore' ? 'block' : 'none';
        if (reloadContent) reloadContent.style.display = tab === 'reload' ? 'block' : 'none';
        if (deleteContent) deleteContent.style.display = tab === 'delete' ? 'block' : 'none';
    };

    tabBtnBackup?.addEventListener('click', () => switchTab('backup'));
    tabBtnRestore?.addEventListener('click', () => switchTab('restore'));
    tabBtnReload?.addEventListener('click', () => switchTab('reload'));
    tabBtnDelete?.addEventListener('click', () => switchTab('delete'));

    // --- CREATE BACKUP ACTION ---
    const backupExecuteBtn = modal.querySelector('#backupExecuteBtn');
    const backupStatusAlert = modal.querySelector('#backupStatusAlert');
    const backupFilenameInput = modal.querySelector('#backupFilenameInput');

    backupExecuteBtn?.addEventListener('click', async () => {
        const selectedProviderEl = modal.querySelector('input[name="backupTargetProvider"]:checked');
        const providerId = selectedProviderEl?.value || 'local';
        let filename = (backupFilenameInput?.value || '').trim();
        if (!filename) filename = `MajesticTab-backup-${new Date().toISOString().split('T')[0]}.mtbackup`;
        if (filename.toLowerCase().endsWith('.json')) {
            filename = filename.slice(0, -5) + '.mtbackup';
        }
        if (!filename.toLowerCase().endsWith('.mtbackup')) {
            filename += '.mtbackup';
        }

        backupExecuteBtn.disabled = true;
        backupExecuteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span> Creating Backup...';
        backupStatusAlert.style.display = 'block';
        backupStatusAlert.className = 'small mb-2 text-info';
        backupStatusAlert.textContent = 'Packaging settings, extensions, and stored tabs...';

        try {
            const blob = await createBackupBlob((current, total) => {
                if (total > 0) {
                    backupStatusAlert.textContent = `Packaging tab ${current} of ${total}...`;
                }
            });

            backupStatusAlert.textContent = `Saving to ${selectedProviderEl?.closest('label')?.querySelector('.leading-tight')?.textContent || providerId}...`;
            const saveResult = await saveToProvider(providerId, blob, filename);

            backupStatusAlert.className = 'small mb-2 text-success fw-semibold';
            backupStatusAlert.innerHTML = `<i class="bi-check-circle-fill me-1"></i> Backup saved successfully! (${formatBytes(blob.size)})`;
            backupExecuteBtn.innerHTML = '<i class="bi-check2"></i> Saved';
            setTimeout(() => {
                backupExecuteBtn.disabled = false;
                backupExecuteBtn.innerHTML = '<i class="bi-cloud-arrow-up"></i> Create &amp; Save Backup';
            }, 3000);
        } catch (err) {
            console.error('Backup creation failed:', err);
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

    const loadGoogleDriveBackups = async () => {
        const { isTokenValid, redirectToGoogleAuth, fetchDriveBackups } = await import('./googleDrive.js');

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
            const backups = await fetchDriveBackups();
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

            const item = document.createElement('div');
            item.className = 'drive-backup-item d-flex align-items-center justify-content-between p-2 rounded-2';
            item.style.cursor = 'pointer';
            item.setAttribute('data-file-id', b.id);
            item.setAttribute('data-file-name', b.name);
            item.innerHTML = `
                <div class="d-flex align-items-center gap-2 min-w-0 me-2 text-start">
                    <i class="bi-archive-fill text-info flex-shrink-0 fs-5"></i>
                    <div class="text-truncate">
                        <div class="fw-semibold text-white small text-truncate" title="${escapeHtml(b.name)}">${escapeHtml(b.name)}</div>
                        <div class="text-white-50" style="font-size: 0.7rem;">${dateStr} • ${sizeStr}</div>
                    </div>
                </div>
                <button type="button" class="btn btn-sm btn-theme-outline px-2 py-1 flex-shrink-0 d-inline-flex align-items-center gap-1 select-drive-backup-btn" style="font-size: 0.72rem;">
                    <i class="bi-download"></i> <span>Select</span>
                </button>
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

                try {
                    const { downloadDriveBackupFile } = await import('./googleDrive.js');
                    const fileObj = await downloadDriveBackupFile(b.id, b.name);
                    await handleSelectedBackupFile(fileObj, 'Google Drive');
                } catch (dlErr) {
                    console.error('Failed to download Drive backup:', dlErr);
                    if (restoreDriveError) {
                        restoreDriveError.style.display = 'block';
                        restoreDriveError.textContent = `Failed to download "${b.name}": ${dlErr.message}`;
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
    restoreDriveCloseBtn?.addEventListener('click', () => {
        if (restoreDriveContainer) restoreDriveContainer.style.display = 'none';
    });

    const onAuthSuccess = (e) => {
        if (e.detail?.state === 'restore_backup') {
            loadGoogleDriveBackups();
        }
    };
    window.addEventListener('googleAuthSuccess', onAuthSuccess);

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

    const handleSelectedBackupFile = async (file, source = 'Local Device') => {
        try {
            if (!file.name.toLowerCase().endsWith('.mtbackup')) {
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

            const text = await readBackupFileText(file);
            const inspection = inspectBackupFile(text);
            if (!inspection.valid) {
                restoreStatusAlert.style.display = 'block';
                restoreStatusAlert.className = 'small mb-2 text-danger fw-semibold';
                restoreStatusAlert.textContent = inspection.error;
                restoreInspectionCard.style.display = 'none';
                restoreExecuteBtn.disabled = true;
                return;
            }

            currentBackupFile = file;
            currentParsedBackup = inspection.data;

            // Populate Inspection Card
            const filenameLabel = modal.querySelector('#restoreFilenameLabel');
            if (filenameLabel) {
                filenameLabel.textContent = `${source === 'Google Drive' ? 'Drive: ' : ''}${file.name || 'Backup file'}`;
            }
            modal.querySelector('#restoreExportedDate').textContent = inspection.exportedAt;
            modal.querySelector('#restoreTabsCount').textContent = inspection.tabsCount;
            modal.querySelector('#restoreSongsCount').textContent = inspection.songsCount;
            modal.querySelector('#restoreExtCount').textContent = inspection.extensionsCount;

            restoreDropzone.style.display = 'none';
            restoreStatusAlert.style.display = 'none';
            restoreInspectionCard.style.display = 'block';
            restoreExecuteBtn.disabled = false;
        } catch (err) {
            restoreStatusAlert.style.display = 'block';
            restoreStatusAlert.className = 'small mb-2 text-danger fw-semibold';
            restoreStatusAlert.textContent = `Could not read backup file: ${err.message}`;
            restoreInspectionCard.style.display = 'none';
            restoreDropzone.style.display = 'block';
            restoreExecuteBtn.disabled = true;
        }
    };

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
        });
    });

    // --- RESTORE ACTION ---
    restoreExecuteBtn?.addEventListener('click', async () => {
        if (!currentParsedBackup) return;

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
            const results = await restoreBackup(currentParsedBackup, {
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
    document.getElementById('deleteAllDataBtn')?.addEventListener('click', () => openBackupModal('delete'));
}
