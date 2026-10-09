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

// --- Built-in Provider: Local Device ---
export const LocalFileProvider = {
    id: 'local',
    name: 'Local Device',
    icon: 'bi-folder2-open',
    iconColorClass: 'text-primary',
    description: 'Browse Guitar Pro (.gp, .gpx, .gp3–5), PDF, or TXT tabs from your device',
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
                try {
                    const stored = await saveStoredFile(file, 'local');
                    const targetId = options.songId || options.targetSong?.id;
                    if (targetId) {
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
            }
        });

        // Synchronously trigger file picker in user event
        input.click();
    }
};

// --- Built-in Provider: Google Drive ---
export const GoogleDriveFileProvider = {
    id: 'google-drive',
    name: 'Google Drive',
    icon: 'bi-google',
    iconColorClass: 'text-danger',
    description: 'Access and load tab files directly from your Google Drive account',
    badge: 'Cloud',
    actionLabel: 'Connect & Open',
    async open(options = {}) {
        if (isTokenValid()) {
            openDriveModal();
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


