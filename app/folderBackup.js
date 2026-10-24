// folderBackup.js
// Local-folder storage backend for incremental backups (see incrementalBackup.js for the layout).
// Two ways to reach a folder, with the same interface:
//   - browsers: the File System Access API (Chrome, Edge). The folder handle is kept in IndexedDB.
//   - desktop app: Tauri's native folder dialog and fs plugin. The folder path is kept in localStorage.
import { ROOT_FOLDER_NAME, BLOBS_FOLDER_NAME, MANIFESTS_FOLDER_NAME, isManifestName } from './incrementalBackup.js';

const DB_NAME = 'majestictab_backup_folder';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'backupFolder';
const NATIVE_PATH_KEY = 'majestictab_backup_folder_path';
const STAT_CONCURRENCY = 16;

const hasBrowserPicker = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
// Only registered in desktop builds; phones have no usable folder picker
const hasNativeFolders = () => typeof window !== 'undefined'
    && typeof window.__TAURI__?.dialog?.open === 'function'
    && typeof window.__TAURI__?.fs?.readDir === 'function';

export function isFolderBackupSupported() {
    return hasBrowserPicker() || hasNativeFolders();
}

const isNativeHandle = (handle) => handle?.kind === 'native-path';
const baseName = (path) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const joinPath = (dir, ...parts) => {
    const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
    return [dir.replace(/[\\/]+$/, ''), ...parts].join(sep);
};

// --- remembered folder ---

function openHandleDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function idbRequest(mode, run) {
    const db = await openHandleDb();
    try {
        return await new Promise((resolve, reject) => {
            const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } finally {
        db.close();
    }
}

function nativeHandle(path) {
    return { kind: 'native-path', path, name: baseName(path) };
}

/** The previously chosen backup folder, or null. Access may still need re-granting. */
export async function getSavedBackupFolder() {
    if (hasNativeFolders()) {
        try {
            const path = localStorage.getItem(NATIVE_PATH_KEY);
            return path ? nativeHandle(path) : null;
        } catch (_) { return null; }
    }
    if (!hasBrowserPicker()) return null;
    try { return (await idbRequest('readonly', s => s.get(HANDLE_KEY))) || null; } catch (_) { return null; }
}

/** Ask the user for a backup folder and remember it. Must run from a click. Returns null if cancelled. */
export async function pickBackupFolder({ defaultPath } = {}) {
    if (hasNativeFolders()) {
        // recursive: lets the fs plugin reach the subfolders and files created inside the chosen folder
        const picked = await window.__TAURI__.dialog.open({
            directory: true,
            multiple: false,
            recursive: true,
            title: 'Choose a folder for MajesticTab backups',
            ...(defaultPath ? { defaultPath } : {})
        });
        if (!picked) return null;
        const path = Array.isArray(picked) ? picked[0] : picked;
        try { localStorage.setItem(NATIVE_PATH_KEY, path); } catch (_) {}
        return nativeHandle(path);
    }
    if (!hasBrowserPicker()) {
        throw new Error('This browser cannot open local folders. Use the desktop app, Chrome or Edge, or back up to Google Drive.');
    }
    try {
        const handle = await window.showDirectoryPicker({ id: 'majestictab-backup', mode: 'readwrite' });
        await idbRequest('readwrite', s => s.put(handle, HANDLE_KEY));
        return handle;
    } catch (err) {
        if (err.name === 'AbortError') return null;
        throw err;
    }
}

/** 'granted' | 'prompt' | 'denied' without showing UI. */
export async function queryFolderPermission(handle) {
    if (isNativeHandle(handle)) {
        // Reachable means the fs scope survived the restart; a moved or unauthorized folder fails here
        try { return (await window.__TAURI__.fs.exists(handle.path)) ? 'granted' : 'prompt'; } catch (_) { return 'prompt'; }
    }
    return handle.queryPermission({ mode: 'readwrite' });
}

/** Re-grant access to a saved folder. Must run from a click when permission isn't already granted. */
export async function ensureFolderPermission(handle) {
    if ((await queryFolderPermission(handle)) === 'granted') return true;
    if (isNativeHandle(handle)) return Boolean(await pickBackupFolder({ defaultPath: handle.path }));
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

// --- browser folder backend ---

async function writeFile(dir, name, data) {
    const handle = await dir.getFileHandle(name, { create: true });
    // Content lands in a swap file and replaces the target on close, so no half-written files appear
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
}

function createBrowserFolderBackend(rootHandle) {
    let blobsDir = null;
    let manifestsDir = null;

    return {
        label: 'the backup folder',
        location: `${rootHandle.name} / ${ROOT_FOLDER_NAME}`,

        async open({ create }) {
            try {
                const root = await rootHandle.getDirectoryHandle(ROOT_FOLDER_NAME, { create });
                blobsDir = await root.getDirectoryHandle(BLOBS_FOLDER_NAME, { create });
                manifestsDir = await root.getDirectoryHandle(MANIFESTS_FOLDER_NAME, { create });
                return true;
            } catch (err) {
                if (err.name === 'NotFoundError') return false;
                throw err;
            }
        },

        async listBlobs() {
            const blobs = [];
            for await (const [name, handle] of blobsDir.entries()) {
                if (handle.kind !== 'file' || !name.endsWith('.bin')) continue;
                const file = await handle.getFile();
                blobs.push({ id: name, name, size: file.size, modifiedTime: new Date(file.lastModified).toISOString() });
            }
            return blobs;
        },

        putBlob: (hash, buffer) => writeFile(blobsDir, `${hash}.bin`, buffer),

        async readBlob(entry) {
            return (await (await blobsDir.getFileHandle(entry.id)).getFile()).arrayBuffer();
        },

        deleteBlob: (entry) => blobsDir.removeEntry(entry.id),

        async listManifests() {
            const manifests = [];
            for await (const [name, handle] of manifestsDir.entries()) {
                if (handle.kind !== 'file' || !isManifestName(name)) continue;
                const file = await handle.getFile();
                let counts = null;
                try {
                    const summary = JSON.parse(await file.text()).summary;
                    if (summary) counts = { tabs: summary.tabsCount || 0, soundFonts: summary.soundFontsCount || 0 };
                } catch (_) {}
                manifests.push({ id: name, name, size: file.size, modifiedTime: new Date(file.lastModified).toISOString(), counts });
            }
            return manifests;
        },

        putManifest: (name, text) => writeFile(manifestsDir, name, text),

        async readManifest(entry) {
            return JSON.parse(await (await (await manifestsDir.getFileHandle(entry.id)).getFile()).text());
        },

        deleteManifest: (entry) => manifestsDir.removeEntry(entry.id)
    };
}

// --- desktop app folder backend ---

function createNativeFolderBackend(root) {
    const fs = window.__TAURI__.fs;
    const rootDir = joinPath(root.path, ROOT_FOLDER_NAME);
    const blobsDir = joinPath(rootDir, BLOBS_FOLDER_NAME);
    const manifestsDir = joinPath(rootDir, MANIFESTS_FOLDER_NAME);

    // Written under a temporary name and renamed, so an interrupted write never leaves a partial blob or manifest
    const writeAtomic = async (dir, name, write) => {
        const partial = joinPath(dir, `${name}.part`);
        await write(partial);
        await fs.rename(partial, joinPath(dir, name));
    };

    const statEntry = async (dir, name) => {
        const info = await fs.stat(joinPath(dir, name));
        return { id: name, name, size: info.size || 0, modifiedTime: new Date(info.mtime || 0).toISOString() };
    };

    const statAll = async (dir, names) => {
        const out = new Array(names.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, names.length) }, async () => {
            while (next < names.length) {
                const i = next++;
                out[i] = await statEntry(dir, names[i]);
            }
        }));
        return out;
    };

    return {
        label: 'the backup folder',
        location: `${root.name} / ${ROOT_FOLDER_NAME}`,

        async open({ create }) {
            if (create) {
                await fs.mkdir(blobsDir, { recursive: true });
                await fs.mkdir(manifestsDir, { recursive: true });
                return true;
            }
            return (await fs.exists(blobsDir)) && (await fs.exists(manifestsDir));
        },

        async listBlobs() {
            const names = (await fs.readDir(blobsDir)).filter(e => e.isFile && e.name.endsWith('.bin')).map(e => e.name);
            return statAll(blobsDir, names);
        },

        putBlob: (hash, buffer) => writeAtomic(blobsDir, `${hash}.bin`, path => fs.writeFile(path, new Uint8Array(buffer))),

        async readBlob(entry) {
            const bytes = await fs.readFile(joinPath(blobsDir, entry.id));
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },

        deleteBlob: (entry) => fs.remove(joinPath(blobsDir, entry.id)),

        async listManifests() {
            const names = (await fs.readDir(manifestsDir)).filter(e => e.isFile && isManifestName(e.name)).map(e => e.name);
            const stats = await statAll(manifestsDir, names);
            return Promise.all(stats.map(async (entry) => {
                let counts = null;
                try {
                    const summary = JSON.parse(await fs.readTextFile(joinPath(manifestsDir, entry.id))).summary;
                    if (summary) counts = { tabs: summary.tabsCount || 0, soundFonts: summary.soundFontsCount || 0 };
                } catch (_) {}
                return { ...entry, counts };
            }));
        },

        putManifest: (name, text) => writeAtomic(manifestsDir, name, path => fs.writeTextFile(path, text)),

        async readManifest(entry) {
            return JSON.parse(await fs.readTextFile(joinPath(manifestsDir, entry.id)));
        },

        deleteManifest: (entry) => fs.remove(joinPath(manifestsDir, entry.id))
    };
}

/** Storage backend that keeps backups in "MajesticTab Backup" inside the chosen local folder. */
export function createFolderBackend(handle) {
    return isNativeHandle(handle) ? createNativeFolderBackend(handle) : createBrowserFolderBackend(handle);
}
