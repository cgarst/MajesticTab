// backupRestore.js
// Complete single-file Backup and Restore engine for MajesticTab.
// Bundles all settings, custom extensions, downloaded tabs local store, and library hierarchy.

import {
    getDB, STORE_NAME, getAllStoredFilesWithData, clearAllStoredFiles,
    arrayBufferToBase64, base64ToArrayBuffer
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

const APP_SETTINGS_KEYS = [
    'majestictab_theme',
    'majestictab_sheet_mode',
    'gpSheetScale',
    'pageAdvancePages',
    'gpDefaultView',
    'pdfDefaultView',
    'txtDefaultView',
    'debugMode',
    'condensePdfMode',
    'majestictab_update_channel',
    'youtubeApiKey',
    'tab_downloader_sources',
    'gdrive_last_folder',
    'gdrive_tabs_directory'
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
    for (const key of APP_SETTINGS_KEYS) {
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
 * Create a complete single-file backup bundle object
 * @returns {Promise<object>} Complete backup bundle
 */
export async function createBackupBundle() {
    const [storedFilesWithData, libraryData] = await Promise.all([
        getAllStoredFilesWithData(),
        getAllLibraryData()
    ]);

    const settings = collectAllSettings();
    const extensions = collectExtensions();

    // Map files with base64 encoded binary data
    const files = storedFilesWithData.map(file => ({
        id: file.id,
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size || (file.data ? file.data.byteLength : 0),
        providerId: file.providerId || 'local',
        metadata: file.metadata || {},
        savedAt: file.savedAt || Date.now(),
        lastModified: file.lastModified || Date.now(),
        dataBase64: file.data ? arrayBufferToBase64(file.data) : ''
    }));

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
 * @param {object} options - { mode: 'merge' | 'wipe' }
 * @returns {Promise<object>} Results of the restore operation
 */
export async function restoreBackup(bundle, { mode = 'merge' } = {}) {
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
    for (const item of files) {
        if (!item || !item.id || !item.name || !item.dataBase64) continue;

        const arrayBuffer = base64ToArrayBuffer(item.dataBase64);
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
            if (key === 'ytCache' && typeof val === 'object') {
                for (const [ytKey, ytVal] of Object.entries(val)) {
                    if (wipe || localStorage.getItem(ytKey) === null) {
                        localStorage.setItem(ytKey, String(ytVal));
                    }
                }
                continue;
            }

            if (APP_SETTINGS_KEYS.includes(key)) {
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

    // 2. Wipe settings and extensions from localStorage
    for (const key of APP_SETTINGS_KEYS) {
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
}

/**
 * Renders the Data Management Modal content
 */
async function renderModal(modal, activeTab = 'backup') {
    const providers = getSaveProviders();
    const today = new Date().toISOString().split('T')[0];
    const defaultFilename = `MajesticTab-backup-${today}.json`;

    // Live counts for backup / reload / delete summary
    const [storedFiles, libraryData] = await Promise.all([
        getAllStoredFilesWithData(),
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
            <input type="file" id="restoreFileInput" accept=".json,.majestictab,application/json" class="d-none">
            <i class="bi-file-earmark-arrow-up text-info fs-1 mb-2 d-block"></i>
            <div class="fw-bold text-white small mb-1">Select or drop a MajesticTab backup file (.json)</div>
            <div class="text-white-50 mb-3" style="font-size: 0.74rem;">Single-file backup bundle exported from MajesticTab or stored in Google Drive</div>
            <div class="d-flex justify-content-center align-items-center gap-2 flex-wrap">
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-inline-flex align-items-center gap-1" id="restoreBrowseBtn">
                <i class="bi-folder2-open text-primary"></i> <span>Browse Local File</span>
              </button>
              <button type="button" class="btn btn-sm btn-theme-outline px-3 d-inline-flex align-items-center gap-1" id="restoreDriveBtn">
                <i class="bi-google text-danger"></i> <span>Load from Google Drive</span>
              </button>
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
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="reloadCancelBtn">Cancel</button>
            <button type="button" class="btn btn-sm btn-theme-primary px-4 d-flex align-items-center gap-2" id="reloadExecuteBtn" ${(!libraryData.songs || libraryData.songs.length === 0) ? 'disabled' : ''}>
              <i class="bi-arrow-repeat"></i> Reload Library Metadata
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
        if (!filename) filename = `MajesticTab-backup-${new Date().toISOString().split('T')[0]}.json`;
        if (!filename.endsWith('.json') && !filename.endsWith('.majestictab')) {
            filename += '.json';
        }

        backupExecuteBtn.disabled = true;
        backupExecuteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span> Creating Backup...';
        backupStatusAlert.style.display = 'block';
        backupStatusAlert.className = 'small mb-2 text-info';
        backupStatusAlert.textContent = 'Packaging settings, extensions, and stored tabs...';

        try {
            const bundle = await createBackupBundle();
            const jsonStr = JSON.stringify(bundle, null, 2);
            const blob = new Blob([jsonStr], { type: 'application/json' });

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
    restoreDriveBtn?.addEventListener('click', () => {
        openFromProvider('google-drive', {
            onFileSelected: ({ file, name }) => {
                if (file) handleSelectedBackupFile(file, 'Google Drive');
            }
        });
    });

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
            const text = await file.text();
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
            const results = await restoreBackup(currentParsedBackup, { mode });

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
    let activeReloadAbortController = null;
    const reloadExecuteBtn = modal.querySelector('#reloadExecuteBtn');
    const reloadCancelBtn = modal.querySelector('#reloadCancelBtn');
    const reloadProgressContainer = modal.querySelector('#reloadProgressContainer');
    const reloadProgressBar = modal.querySelector('#reloadProgressBar');
    const reloadPercentLabel = modal.querySelector('#reloadPercentLabel');
    const reloadCurrentActionLabel = modal.querySelector('#reloadCurrentActionLabel');
    const reloadItemsCountLabel = modal.querySelector('#reloadItemsCountLabel');
    const reloadStatsLiveLabel = modal.querySelector('#reloadStatsLiveLabel');
    const reloadStatusAlert = modal.querySelector('#reloadStatusAlert');

    reloadCancelBtn?.addEventListener('click', () => {
        if (activeReloadAbortController) {
            activeReloadAbortController.abort();
            activeReloadAbortController = null;
            if (reloadCancelBtn) reloadCancelBtn.textContent = 'Cancel';
        } else {
            closeBackupModal();
        }
    });

    reloadExecuteBtn?.addEventListener('click', async () => {
        activeReloadAbortController = new AbortController();
        reloadExecuteBtn.disabled = true;
        reloadExecuteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span> Reloading...';
        if (reloadCancelBtn) reloadCancelBtn.textContent = 'Stop / Cancel';

        if (reloadProgressContainer) reloadProgressContainer.style.display = 'block';
        if (reloadStatusAlert) {
            reloadStatusAlert.style.display = 'none';
            reloadStatusAlert.innerHTML = '';
        }

        try {
            const stats = await reloadAllLibraryMetadata({
                onProgress: ({ current, total, percent, phase, name, stats: curStats }) => {
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
                        reloadStatsLiveLabel.textContent = `Durations: ${curStats.addedDurations} • Artwork: ${curStats.addedCovers} • Tunings: ${curStats.updatedTunings || 0}`;
                    }
                },
                signal: activeReloadAbortController.signal,
                forceRefresh: true
            });

            if (reloadProgressContainer) reloadProgressContainer.style.display = 'none';

            if (activeReloadAbortController?.signal?.aborted) {
                if (reloadStatusAlert) {
                    reloadStatusAlert.style.display = 'block';
                    reloadStatusAlert.className = 'small mb-2 text-warning fw-semibold';
                    reloadStatusAlert.innerHTML = '<i class="bi-exclamation-triangle-fill me-1"></i> Metadata reload was cancelled by user.';
                }
            } else {
                if (reloadStatusAlert) {
                    reloadStatusAlert.style.display = 'block';
                    reloadStatusAlert.className = 'small mb-2 text-success fw-semibold';
                    const details = [];
                    if (stats.updatedAlbums > 0) details.push(`${stats.updatedAlbums} albums refreshed`);
                    if (stats.updatedSongs > 0) details.push(`${stats.updatedSongs} songs updated`);
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

                // Update live modal stats
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
            }

            reloadExecuteBtn.innerHTML = '<i class="bi-check2"></i> Finished';
            setTimeout(() => {
                reloadExecuteBtn.disabled = false;
                reloadExecuteBtn.innerHTML = '<i class="bi-arrow-repeat"></i> Reload Library Metadata';
            }, 3000);
        } catch (err) {
            console.error('Metadata reload failed:', err);
            if (reloadProgressContainer) reloadProgressContainer.style.display = 'none';
            if (reloadStatusAlert) {
                reloadStatusAlert.style.display = 'block';
                reloadStatusAlert.className = 'small mb-2 text-danger fw-semibold';
                reloadStatusAlert.innerHTML = `<i class="bi-exclamation-triangle-fill me-1"></i> Failed to reload metadata: ${escapeHtml(err.message)}`;
            }
            reloadExecuteBtn.disabled = false;
            reloadExecuteBtn.innerHTML = '<i class="bi-arrow-repeat"></i> Try Again';
        } finally {
            activeReloadAbortController = null;
            if (reloadCancelBtn) reloadCancelBtn.textContent = 'Cancel';
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
