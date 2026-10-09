// backupRestore.js
// Complete single-file Backup and Restore engine for MajesticTab.
// Bundles all settings, custom extensions, downloaded tabs local store, and library hierarchy.

import {
    getDB, STORE_NAME, getAllStoredFilesWithData, clearAllStoredFiles,
    arrayBufferToBase64, base64ToArrayBuffer
} from './fileStore.js';
import {
    getAllLibraryData, importLibraryData, clearAllLibraryData
} from './libraryStore.js';
import {
    getSaveProviders, saveToProvider
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
 * Open the Backup / Restore modal
 * @param {'backup'|'restore'} initialTab
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
 * Close the Backup / Restore modal
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
 * Renders the Backup & Restore Modal content
 */
async function renderModal(modal, activeTab = 'backup') {
    const providers = getSaveProviders();
    const today = new Date().toISOString().split('T')[0];
    const defaultFilename = `MajesticTab-backup-${today}.json`;

    // Live counts for backup summary
    const [storedFiles, libraryData] = await Promise.all([
        getAllStoredFilesWithData(),
        getAllLibraryData()
    ]);
    const extensions = collectExtensions();
    const tabsTotalSize = storedFiles.reduce((acc, f) => acc + (f.size || 0), 0);

    modal.innerHTML = `
    <div class="theme-modal-card backup-modal-card">
      <!-- Modal Header -->
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          <div class="brand-btn p-2 theme-modal-icon" style="width: 38px; height: 38px;">
            <i class="bi-shield-check text-primary fs-5"></i>
          </div>
          <div class="theme-modal-titles">
            <h5 class="mb-0 fw-bold text-white fs-6" id="backupModalTitle">Backup &amp; Restore</h5>
            <small class="text-muted d-none d-sm-block" style="font-size: 0.75rem;">Single-file bundle for all settings, extensions, tabs, and library</small>
          </div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="backupModalCloseBtn" aria-label="Close modal">
            <i class="bi-x-lg"></i>
          </button>
        </div>
      </div>

      <!-- Tab Switcher Navigation -->
      <div class="backup-nav-tabs px-3 pt-2 pb-1 d-flex gap-2">
        <button type="button" class="btn btn-sm ${activeTab === 'backup' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1.5" id="tabBtnBackup">
          <i class="bi-cloud-arrow-up me-1.5"></i> Create Backup
        </button>
        <button type="button" class="btn btn-sm ${activeTab === 'restore' ? 'btn-theme-primary' : 'btn-theme-outline'} flex-grow-1 py-1.5" id="tabBtnRestore">
          <i class="bi-cloud-arrow-down me-1.5"></i> Restore from Backup
        </button>
      </div>

      <!-- Modal Body -->
      <div class="theme-modal-body p-3">
        <!-- TAB 1: CREATE BACKUP -->
        <div id="backupTabContent" style="display: ${activeTab === 'backup' ? 'block' : 'none'};">
          <!-- Bundle Contents Overview -->
          <div class="backup-summary-box p-3 rounded-3 mb-3">
            <div class="small fw-semibold text-white mb-2 d-flex align-items-center gap-1.5">
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
            <label class="form-label small fw-semibold text-white-50 mb-1.5 d-block">
              Save Backup Destination:
            </label>
            <div class="d-flex flex-column gap-2" id="backupProviderList">
              ${providers.map((p, idx) => `
                <label class="backup-provider-option p-2.5 rounded-3 d-flex align-items-center justify-content-between gap-2" style="cursor: pointer;">
                  <div class="d-flex align-items-center gap-2.5 min-w-0">
                    <input class="form-check-input theme-radio m-0" type="radio" name="backupTargetProvider" value="${escapeHtml(p.id)}" ${idx === 0 ? 'checked' : ''}>
                    <div class="provider-mini-icon">
                      <i class="${escapeHtml(p.icon || 'bi-folder')} ${escapeHtml(p.iconColorClass || 'text-primary')} fs-5"></i>
                    </div>
                    <div class="min-w-0">
                      <div class="fw-bold text-white small leading-tight">${escapeHtml(p.name)}</div>
                      <div class="text-muted text-truncate" style="font-size: 0.73rem;">${escapeHtml(p.description || '')}</div>
                    </div>
                  </div>
                  ${p.badge ? `<span class="badge badge-theme-secondary py-0.5 px-2" style="font-size: 0.65rem;">${escapeHtml(p.badge)}</span>` : ''}
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
            <div class="text-white-50 mb-3" style="font-size: 0.74rem;">Single-file backup bundle exported from MajesticTab</div>
            <button type="button" class="btn btn-sm btn-theme-outline px-3" id="restoreBrowseBtn">
              <i class="bi-folder2-open me-1"></i> Browse Backup File
            </button>
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
            <label class="form-label small fw-semibold text-white-50 mb-1.5 d-block">Choose Restore Method:</label>
            <div class="d-flex flex-column gap-2 mb-3">
              <!-- Merge Mode Option (Recommended) -->
              <label class="restore-mode-card p-2.5 rounded-3 d-flex align-items-start gap-2.5" style="cursor: pointer;">
                <input class="form-check-input theme-radio mt-1" type="radio" name="restoreModeRadio" value="merge" checked>
                <div class="min-w-0">
                  <div class="d-flex align-items-center gap-1.5 mb-0.5">
                    <span class="fw-bold text-white small">Merge with Existing Data</span>
                    <span class="badge badge-theme-secondary py-0.2 px-1.5" style="font-size:0.62rem;">Recommended</span>
                  </div>
                  <div class="text-muted" style="font-size: 0.73rem; line-height: 1.35;">
                    Safely adds any missing tabs, songs, collections, extensions, and preferences from the backup. Keeps your existing tabs intact.
                  </div>
                </div>
              </label>

              <!-- Wipe & Replace Option -->
              <label class="restore-mode-card p-2.5 rounded-3 d-flex align-items-start gap-2.5" style="cursor: pointer;">
                <input class="form-check-input theme-radio mt-1" type="radio" name="restoreModeRadio" value="wipe">
                <div class="min-w-0">
                  <div class="d-flex align-items-center gap-1.5 mb-0.5">
                    <span class="fw-bold text-danger-emphasis small">Wipe &amp; Replace Everything</span>
                    <span class="badge bg-danger bg-opacity-25 text-danger border border-danger-subtle py-0.2 px-1.5" style="font-size:0.62rem;">Clean Slate</span>
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
      </div>
    </div>
    `;

    // Attach Event Handlers
    attachModalHandlers(modal);
}

/**
 * Attach interactive handlers to the Backup & Restore modal
 */
function attachModalHandlers(modal) {
    // Close button & backdrop click
    modal.querySelector('#backupModalCloseBtn')?.addEventListener('click', closeBackupModal);
    modal.querySelector('#backupCancelBtn')?.addEventListener('click', closeBackupModal);
    modal.querySelector('#restoreCancelBtn')?.addEventListener('click', closeBackupModal);
    modal.onclick = (e) => {
        if (e.target === modal) closeBackupModal();
    };

    // Tab Switchers
    const tabBtnBackup = modal.querySelector('#tabBtnBackup');
    const tabBtnRestore = modal.querySelector('#tabBtnRestore');
    const backupContent = modal.querySelector('#backupTabContent');
    const restoreContent = modal.querySelector('#restoreTabContent');

    const switchTab = (tab) => {
        if (tab === 'backup') {
            tabBtnBackup.className = 'btn btn-sm btn-theme-primary flex-grow-1 py-1.5';
            tabBtnRestore.className = 'btn btn-sm btn-theme-outline flex-grow-1 py-1.5';
            backupContent.style.display = 'block';
            restoreContent.style.display = 'none';
        } else {
            tabBtnBackup.className = 'btn btn-sm btn-theme-outline flex-grow-1 py-1.5';
            tabBtnRestore.className = 'btn btn-sm btn-theme-primary flex-grow-1 py-1.5';
            backupContent.style.display = 'none';
            restoreContent.style.display = 'block';
        }
    };

    tabBtnBackup?.addEventListener('click', () => switchTab('backup'));
    tabBtnRestore?.addEventListener('click', () => switchTab('restore'));

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
        backupExecuteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1.5" role="status"></span> Creating Backup...';
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
        if (file) handleSelectedBackupFile(file);
    });

    restoreFileInput?.addEventListener('change', () => {
        const file = restoreFileInput.files?.[0];
        if (file) handleSelectedBackupFile(file);
    });

    const handleSelectedBackupFile = async (file) => {
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
            if (filenameLabel) filenameLabel.textContent = file.name || 'Backup file';
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
        restoreExecuteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1.5" role="status"></span> Restoring Data...';
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
              <div class="d-flex align-items-center gap-1.5 mb-1">
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
}

/**
 * Initialize Backup & Restore triggers in UI
 */
export function initBackupRestore() {
    document.getElementById('backupDataBtn')?.addEventListener('click', () => openBackupModal('backup'));
    document.getElementById('restoreDataBtn')?.addEventListener('click', () => openBackupModal('restore'));
}
