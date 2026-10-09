// fileStore.js
// IndexedDB-backed persistent file store for MajesticTab tab files across all platforms.

export const DB_NAME = 'majestictab_db';
export const DB_VERSION = 2;
export const STORE_NAME = 'stored_files';
export const STORE_SONGS = 'library_songs';
export const STORE_COLLECTIONS = 'library_collections';
export const STORE_RECENTS = 'library_recents';

let dbPromise = null;

export function getDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB is not supported in this environment.'));
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('name', 'name', { unique: false });
                store.createIndex('providerId', 'providerId', { unique: false });
                store.createIndex('savedAt', 'savedAt', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_SONGS)) {
                const songStore = db.createObjectStore(STORE_SONGS, { keyPath: 'id' });
                songStore.createIndex('collectionId', 'collectionId', { unique: false });
                songStore.createIndex('artist', 'artist', { unique: false });
                songStore.createIndex('album', 'album', { unique: false });
                songStore.createIndex('addedAt', 'addedAt', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_COLLECTIONS)) {
                db.createObjectStore(STORE_COLLECTIONS, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORE_RECENTS)) {
                const recentsStore = db.createObjectStore(STORE_RECENTS, { keyPath: 'id' });
                recentsStore.createIndex('openedAt', 'openedAt', { unique: false });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    return dbPromise;
}

export function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * Save a File or Blob into the persistent store.
 * @param {File|Blob} file
 * @param {string} providerId (e.g. 'local', 'google-drive', 'tab-downloader')
 * @param {object} [metadata]
 * @returns {Promise<object>} Stored record
 */
export async function saveStoredFile(file, providerId = 'local', metadata = {}) {
    const db = await getDB();
    const arrayBuffer = await file.arrayBuffer();
    const name = file.name || metadata.name || 'Untitled';
    const id = metadata.id || `${providerId}_${name}_${Date.now()}`;
    const record = {
        id,
        name,
        type: file.type || metadata.type || 'application/octet-stream',
        size: file.size || arrayBuffer.byteLength,
        providerId,
        metadata,
        data: arrayBuffer,
        savedAt: Date.now(),
        lastModified: file.lastModified || Date.now()
    };

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(record);

        req.onsuccess = () => resolve(record);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Retrieve a stored record by ID and construct a File object.
 * @param {string} id
 * @returns {Promise<{ record: object, file: File }|null>}
 */
export async function getStoredFile(id) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(id);

        req.onsuccess = () => {
            const record = req.result;
            if (!record) {
                resolve(null);
                return;
            }
            const blob = new Blob([record.data], { type: record.type });
            const file = new File([blob], record.name, {
                type: record.type,
                lastModified: record.lastModified
            });
            resolve({ record, file });
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Get all stored file records (without loading large binary data into memory).
 * @returns {Promise<Array<object>>}
 */
export async function getAllStoredFiles() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.openCursor();
        const results = [];

        req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                const { data, ...meta } = cursor.value;
                results.push(meta);
                cursor.continue();
            } else {
                resolve(results);
            }
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Delete a file record from the store by ID.
 * @param {string} id
 */
export async function deleteStoredFile(id) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(id);

        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Clear all file records from the store.
 */
export async function clearAllStoredFiles() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.clear();
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Get all stored file records with their raw binary data.
 * @returns {Promise<Array<object>>}
 */
export async function getAllStoredFilesWithData() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Export all files in the file store to a portable JSON string for easy transfer between platforms.
 * @returns {Promise<string>}
 */
export async function exportFileStore() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();

        req.onsuccess = () => {
            const records = req.result.map(rec => ({
                ...rec,
                dataBase64: arrayBufferToBase64(rec.data),
                data: undefined
            }));
            resolve(JSON.stringify({ version: 1, exportedAt: Date.now(), files: records }, null, 2));
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Import files from an exported portable JSON string/object.
 * @param {string|object} exportedData
 * @returns {Promise<number>} Count of imported files
 */
export async function importFileStore(exportedData) {
    const parsed = typeof exportedData === 'string' ? JSON.parse(exportedData) : exportedData;
    if (!parsed || !Array.isArray(parsed.files)) {
        throw new Error('Invalid file store backup format.');
    }

    const db = await getDB();
    let count = 0;

    for (const item of parsed.files) {
        if (!item.id || !item.name || !item.dataBase64) continue;
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
            const req = store.put(record);
            req.onsuccess = () => { count++; resolve(); };
            req.onerror = () => reject(req.error);
        });
    }

    return count;
}

