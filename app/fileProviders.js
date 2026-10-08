// fileProviders.js
// Abstracted file providers for importing tab files and persisting them into the app file store.

import { saveStoredFile } from './fileStore.js';
import { loadFile } from './main.js';
import { openDriveModal, redirectToGoogleAuth, isTokenValid } from './googleDrive.js';
import { openTabDownloader } from './tabDownloader.js';
import { addTabOptionToSong, mapOpenFileToSong } from './libraryStore.js';
import { inferTuningFromTextOrName } from './utils/tuningUtils.js';

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
 * Get all registered file providers
 * @returns {Array<FileProvider>}
 */
export function getFileProviders() {
    return Array.from(providers.values());
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

// --- Built-in Provider: Local Device ---
export const LocalFileProvider = {
    id: 'local',
    name: 'Local Device',
    icon: 'bi-folder2-open',
    async open(options = {}) {
        return new Promise((resolve) => {
            const existingInput = document.getElementById('localFile');
            if (existingInput) {
                const handleChange = async (e) => {
                    existingInput.removeEventListener('change', handleChange);
                    const file = e.target.files?.[0];
                    if (file) {
                        try {
                            const stored = await saveStoredFile(file, 'local');
                            if (options.songId || options.targetSong?.id) {
                                const targetId = options.songId || options.targetSong.id;
                                await addTabOptionToSong(targetId, {
                                    name: file.name,
                                    providerId: 'local',
                                    relativePath: file.name,
                                    fileStoreId: stored.id,
                                    tuning: inferTuningFromTextOrName(file.name),
                                    fileType: file.name.split('.').pop().toLowerCase()
                                });
                            }
                        } catch (err) {
                            console.warn('Could not persist file to store:', err);
                        }
                        await loadFile(file);
                        resolve(file);
                    } else {
                        resolve(null);
                    }
                };
                existingInput.addEventListener('change', handleChange);
                existingInput.click();
            } else {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.pdf,.gp,.gp3,.gp4,.gp5,.gpx,.txt';
                input.style.display = 'none';
                document.body.appendChild(input);

                input.addEventListener('change', async () => {
                    const file = input.files?.[0];
                    input.remove();
                    if (file) {
                        try {
                            const stored = await saveStoredFile(file, 'local');
                            if (options.songId || options.targetSong?.id) {
                                const targetId = options.songId || options.targetSong.id;
                                await addTabOptionToSong(targetId, {
                                    name: file.name,
                                    providerId: 'local',
                                    relativePath: file.name,
                                    fileStoreId: stored.id,
                                    tuning: inferTuningFromTextOrName(file.name),
                                    fileType: file.name.split('.').pop().toLowerCase()
                                });
                            }
                        } catch (err) {
                            console.warn('Could not persist file to store:', err);
                        }
                        await loadFile(file);
                        resolve(file);
                    } else {
                        resolve(null);
                    }
                });
                input.click();
            }
        });
    }
};

// --- Built-in Provider: Google Drive ---
export const GoogleDriveFileProvider = {
    id: 'google-drive',
    name: 'Google Drive',
    icon: 'bi-google',
    async open(options = {}) {
        const searchQuery = options.query || options.songName || '';
        if (isTokenValid()) {
            openDriveModal();
            if (searchQuery) {
                const driveSearchInput = document.getElementById('driveSearchInput');
                if (driveSearchInput) {
                    driveSearchInput.value = searchQuery;
                    driveSearchInput.dispatchEvent(new Event('input'));
                }
            }
        } else {
            redirectToGoogleAuth();
        }
    }
};

// --- Built-in Provider: Tab Downloader (Native / Web) ---
export const TabDownloaderNativeProvider = {
    id: 'tab-downloader',
    name: 'Tab Downloader',
    icon: 'bi-cloud-arrow-down',
    async open(options = {}) {
        return openTabDownloader(options);
    }
};

export const TabDownloaderWebProvider = {
    id: 'tab-downloader-web',
    name: 'Tab Downloader (Web)',
    icon: 'bi-cloud-arrow-down',
    async open(options = {}) {
        return openTabDownloader(options);
    }
};

// Register built-in providers
registerFileProvider(LocalFileProvider);
registerFileProvider(GoogleDriveFileProvider);

registerFileProvider(TabDownloaderNativeProvider);
registerFileProvider(TabDownloaderWebProvider);

