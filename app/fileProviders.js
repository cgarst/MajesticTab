// fileProviders.js
// Abstracted file providers for importing tab files and persisting them into the app file store.

import { saveStoredFile } from './fileStore.js';
import { loadFile } from './main.js';
import { openDriveModal, redirectToGoogleAuth, isTokenValid } from './googleDrive.js';

const providers = new Map();

/**
 * Base Provider interface
 * @typedef {Object} FileProvider
 * @property {string} id - Unique identifier
 * @property {string} name - Display name
 * @property {string} [icon] - Bootstrap icon class
 * @property {function(): Promise<File|void>} open - Handles user interaction and importing
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
    return providers.get(id);
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
 */
export async function openFromProvider(id) {
    const provider = getFileProvider(id);
    if (!provider) {
        console.error(`File provider "${id}" not found.`);
        return;
    }
    return provider.open();
}

// --- Built-in Provider: Local Device ---
export const LocalFileProvider = {
    id: 'local',
    name: 'Local Device',
    icon: 'bi-folder2-open',
    async open() {
        return new Promise((resolve) => {
            const existingInput = document.getElementById('localFile');
            if (existingInput) {
                const handleChange = async (e) => {
                    existingInput.removeEventListener('change', handleChange);
                    const file = e.target.files?.[0];
                    if (file) {
                        try {
                            await saveStoredFile(file, 'local');
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
                            await saveStoredFile(file, 'local');
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
    async open() {
        if (isTokenValid()) {
            openDriveModal();
        } else {
            redirectToGoogleAuth();
        }
    }
};

// Register built-in providers
registerFileProvider(LocalFileProvider);
registerFileProvider(GoogleDriveFileProvider);
