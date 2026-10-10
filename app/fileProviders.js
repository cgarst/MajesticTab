// fileProviders.js
// Abstracted file providers for importing tab files and persisting them into the app file store.

import { saveStoredFile } from './fileStore.js';
import { loadFile } from './main.js';
import { openDriveModal, redirectToGoogleAuth, isTokenValid } from './googleDrive.js';
import { openTabDownloader } from './tabDownloader.js';
import { addTabOptionToSong, addTabOptionToAlbum, mapOpenFileToSong } from './libraryStore.js';
import { inferTuningFromTextOrName, detectFileMetadata } from './utils/tuningUtils.js';
import { isSupportedTabFile } from './utils/fileHandlingUtils.js';
import { showToast } from './utils/toast.js';

const providers = new Map();

/**
 * Base Provider interface
 * @typedef {Object} FileProvider
 * @property {string} id - Unique identifier
 * @property {string} name - Display name
 * @property {string} [icon] - Bootstrap icon class
 * @property {function(Object=): Promise<File|void>} open - Handles user interaction and importing
 */

/**
 * Register a file provider
 * @param {FileProvider} provider
 */
export function registerFileProvider(provider) {
    if (!provider || !provider.id || typeof provider.open !== 'function') {
        throw new TypeError('Provider must have an id and open() function.');
    }
    providers.set(provider.id, provider);
}

/**
 * Get a provider by ID
 * @param {string} id
 * @returns {FileProvider|undefined}
 */
export function getFileProvider(id) {
    if (providers.has(id)) {
        return providers.get(id);
    }
    if (id === 'tab-downloader' && providers.has('tab-downloader-web')) {
        return providers.get('tab-downloader-web');
    }
    if (id === 'tab-downloader-web' && providers.has('tab-downloader')) {
        return providers.get('tab-downloader');
    }
    return undefined;
}

/**
 * Get all registered file providers (filtered for current environment)
 * @returns {Array<FileProvider>}
 */
export function getFileProviders() {
    const isTauri = typeof window !== 'undefined' && Boolean(window.__TAURI__);
    const result = [];
    const seen = new Set();

    for (const [id, provider] of providers.entries()) {
        if (id === 'tab-downloader-web' && isTauri) continue;
        if (id === 'tab-downloader' && !isTauri && providers.has('tab-downloader-web')) continue;

        const canonicalId = (id === 'tab-downloader-web') ? 'tab-downloader' : id;
        if (!seen.has(canonicalId)) {
            seen.add(canonicalId);
            result.push(provider);
        }
    }
    return result;
}

/**
 * Execute the open action for a specific provider
 * @param {string} id
 * @param {Object} [options]
 */
export async function openFromProvider(id, options = {}) {
    const provider = getFileProvider(id);
    if (!provider) {
        console.error(`File provider "${id}" not found.`);
        return;
    }
    return provider.open(options);
}

/**
 * Get all registered file providers that support saving (excludes tab downloader)
 * @returns {Array<FileProvider>}
 */
export function getSaveProviders() {
    return getFileProviders().filter(p => !p.id.startsWith('tab-downloader') && typeof p.save === 'function');
}

/**
 * Save a file/blob to a specific provider
 * @param {string} id - Provider ID
 * @param {Blob|File} fileBlob
 * @param {string} filename
 * @param {Object} [options]
 */
export async function saveToProvider(id, fileBlob, filename, options = {}) {
    const provider = getFileProvider(id);
    if (!provider) {
        throw new Error(`File provider "${id}" not found.`);
    }
    if (provider.id.startsWith('tab-downloader')) {
        throw new Error('Tab Downloader does not support saving files.');
    }
    if (typeof provider.save !== 'function') {
        throw new Error(`Provider "${provider.name}" does not support saving files.`);
    }
    return provider.save(fileBlob, filename, options);
}

// --- Built-in Provider: Local Device ---
export const LocalFileProvider = {
    id: 'local',
    name: 'Local Device',
    icon: 'bi-folder2-open',
    iconColorClass: 'text-primary',
    description: 'Save or browse files on your local computer or device',
    badge: 'Device',
    actionLabel: 'Browse Files',
    open(options = {}) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf,.gp,.gp3,.gp4,.gp5,.gpx,.txt';
        input.style.position = 'fixed';
        input.style.top = '-9999px';
        input.style.left = '-9999px';
        input.style.opacity = '0';
        document.body.appendChild(input);

        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            input.remove();
            if (file) {
                if (typeof options.onFileSelected === 'function' || options.songId || options.targetSong?.id || options.isAlbumTab) {
                    if (!(await isSupportedTabFile(file))) {
                        showToast(`"${file.name}" is not a supported tab file (.gp, .gp3, .gp4, .gp5, .gpx, .pdf, .txt)`, 'warning');
                        return;
                    }
                }

                if (typeof options.onFileSelected === 'function') {
                    try {
                        const meta = await detectFileMetadata(file, file.name);
                        const stored = await saveStoredFile(file, 'local');
                        options.onFileSelected({ file, providerId: 'local', fileStoreId: stored.id, name: file.name, meta });
                    } catch (err) {
                        console.warn('Could not persist file to store:', err);
                        showToast('Error attaching tab file', 'error');
                    }
                    return;
                }

                const targetId = options.songId || options.targetSong?.id;
                const isAlbumTab = Boolean(options.isAlbumTab && options.albumTitle);

                if (targetId) {
                    try {
                        const meta = await detectFileMetadata(file, file.name);
                        const stored = await saveStoredFile(file, 'local');
                        await addTabOptionToSong(targetId, {
                            name: file.name,
                            providerId: 'local',
                            relativePath: file.name,
                            fileStoreId: stored.id,
                            tuning: meta.primaryTuning,
                            tunings: meta.tunings,
                            stringCount: meta.stringCount,
                            fileType: file.name.split('.').pop().toLowerCase()
                        });
                        showToast(`Added "${file.name}" to song`, 'success');
                        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
                    } catch (err) {
                        console.warn('Could not persist file to store:', err);
                        showToast('Error attaching tab file', 'error');
                    }
                    return; // Do not auto-open when adding a tab to a song
                }

                if (isAlbumTab) {
                    try {
                        const meta = await detectFileMetadata(file, file.name);
                        const stored = await saveStoredFile(file, 'local');
                        await addTabOptionToAlbum(options.collectionId, options.artistName, options.albumTitle, {
                            name: file.name,
                            providerId: 'local',
                            relativePath: file.name,
                            fileStoreId: stored.id,
                            tuning: meta.primaryTuning,
                            tunings: meta.tunings,
                            stringCount: meta.stringCount,
                            fileType: file.name.split('.').pop().toLowerCase()
                        });
                        showToast(`Added "${file.name}" to album`, 'success');
                        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
                    } catch (err) {
                        console.warn('Could not persist album tab to store:', err);
                        showToast('Error attaching album tab file', 'error');
                    }
                    return; // Do not auto-open when adding a tab to an album
                }

                await loadFile(file);
            }
        });

        // Synchronously trigger file picker in user event
        input.click();
    },
    async save(fileBlob, filename = 'MajesticTab-backup.mtbackup') {
        const url = URL.createObjectURL(fileBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.position = 'fixed';
        a.style.top = '-9999px';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return { success: true, name: filename, providerId: 'local' };
    }
};

// --- Built-in Provider: Google Drive ---
export const GoogleDriveFileProvider = {
    id: 'google-drive',
    name: 'Google Drive',
    icon: 'bi-google',
    iconColorClass: 'text-danger',
    description: 'Save or load tab files and backups directly to your Google Drive account',
    badge: 'Cloud',
    actionLabel: 'Connect & Open',
    async open(options = {}) {
        if (isTokenValid()) {
            openDriveModal(options);
        } else {
            redirectToGoogleAuth();
        }
    },
    async save(fileBlob, filename = 'MajesticTab-backup.mtbackup', options = {}) {
        const { saveFileToDrive, isTokenValid: checkToken, redirectToGoogleAuth: authDrive } = await import('./googleDrive.js');
        if (!checkToken()) {
            authDrive();
            throw new Error('Please authorize Google Drive to save the file.');
        }
        const result = await saveFileToDrive(fileBlob, filename, options.folderId);
        return { success: true, name: filename, id: result.id, providerId: 'google-drive' };
    }
};

// --- Built-in Provider: Tab Downloader (Native / Web) ---
export const TabDownloaderNativeProvider = {
    id: 'tab-downloader',
    name: 'Tab Downloader',
    icon: 'bi-cloud-arrow-down',
    iconColorClass: 'text-info',
    description: 'Search and download guitar tabs from online archives',
    badge: 'Online',
    actionLabel: 'Search Tabs',
    async open(options = {}) {
        return openTabDownloader(options);
    }
};

export const TabDownloaderWebProvider = {
    id: 'tab-downloader-web',
    name: 'Tab Downloader',
    icon: 'bi-cloud-arrow-down',
    iconColorClass: 'text-info',
    description: 'Search and download guitar tabs from online archives',
    badge: 'Online',
    actionLabel: 'Search Tabs',
    async open(options = {}) {
        return openTabDownloader(options);
    }
};

// Register built-in providers
registerFileProvider(LocalFileProvider);
registerFileProvider(GoogleDriveFileProvider);

registerFileProvider(TabDownloaderNativeProvider);
registerFileProvider(TabDownloaderWebProvider);



