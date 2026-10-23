// driveBackup.js
// Incremental Google Drive backups. Layout under the tabs directory (or Drive root):
//   MajesticTab Backup/
//     blobs/<sha256>.bin                      raw bytes of one tab or SoundFont, immutable
//     manifests/manifest-<timestamp>.json     settings, library and a file table pointing at blobs
// A backup only uploads blobs Drive doesn't have yet and writes its manifest last, so an
// interrupted run leaves earlier manifests fully restorable.
import { driveFetch, getBackupParentFolderId } from './googleDrive.js';
import { getAllStoredFiles, getStoredFileRecord } from './fileStore.js';
import { getAllLibraryData } from './libraryStore.js';
import { listSoundFonts, getSoundFontData, SOUNDFONT_BACKUP_STORE } from './soundFontStore.js';
import { collectAllSettings, collectExtensions } from './backupRestore.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_FOLDER_NAME = 'MajesticTab Backup';
const BLOBS_FOLDER_NAME = 'blobs';
const MANIFESTS_FOLDER_NAME = 'manifests';
const MANIFEST_PREFIX = 'manifest-';
const MANIFEST_FORMAT_VERSION = 2;
const MULTIPART_LIMIT = 8 * 1024 * 1024;
const RESUMABLE_PIECE = 16 * 1024 * 1024; // must be a multiple of 256 KiB
const UPLOAD_CONCURRENCY = 3;
const DELETE_CONCURRENCY = 4;
// Newest manifests kept after each backup; older ones are removed (their blobs wait for a cleanup)
const MANIFEST_RETENTION = 30;
// Blobs younger than this are never swept: a backup in another tab may not have written its manifest yet
const BLOB_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
const HASH_CACHE_KEY = 'majestictab_backup_hash_cache';

async function driveJson(url, options) {
    const res = await driveFetch(url, options);
    if (!res.ok) {
        let detail = res.statusText;
        try { detail = (await res.json()).error?.message || detail; } catch (_) {}
        throw new Error(`Google Drive API error (${res.status}): ${detail}`);
    }
    return res.json();
}

async function withRetry(run, attempts = 3) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await run();
        } catch (err) {
            if (attempt >= attempts - 1 || /authorization expired|not connected/.test(err.message)) throw err;
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
    }
}

/** Runs `worker` over `items` with at most `limit` in flight; rejects on the first failure. */
async function runPool(items, limit, worker) {
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            await worker(items[index], index);
        }
    });
    await Promise.all(lanes);
}

async function listChildren(parentId, extraQuery = '') {
    const files = [];
    let pageToken = null;
    do {
        const params = new URLSearchParams({
            q: `trashed = false and '${parentId}' in parents${extraQuery}`,
            fields: 'nextPageToken,files(id,name,size,modifiedTime)',
            pageSize: '1000'
        });
        if (pageToken) params.set('pageToken', pageToken);
        const data = await driveJson(`${DRIVE_API}?${params}`);
        files.push(...(data.files || []));
        pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
}

async function findOrCreateFolder(name, parentId, { create = true } = {}) {
    const found = await listChildren(parentId, ` and mimeType = '${FOLDER_MIME}' and name = '${name}'`);
    if (found.length) return found[0].id;
    if (!create) return null;
    const folder = await driveJson(DRIVE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
    });
    return folder.id;
}

async function resolveBackupFolders({ create }) {
    const rootId = await findOrCreateFolder(ROOT_FOLDER_NAME, getBackupParentFolderId(), { create });
    if (!rootId) return null;
    const [blobsId, manifestsId] = await Promise.all([
        findOrCreateFolder(BLOBS_FOLDER_NAME, rootId, { create }),
        findOrCreateFolder(MANIFESTS_FOLDER_NAME, rootId, { create })
    ]);
    if (!blobsId || !manifestsId) return null;
    return { rootId, blobsId, manifestsId };
}

// --- hashing ---

async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function loadHashCache() {
    try { return JSON.parse(localStorage.getItem(HASH_CACHE_KEY)) || {}; } catch (_) { return {}; }
}

function saveHashCache(cache) {
    try { localStorage.setItem(HASH_CACHE_KEY, JSON.stringify(cache)); } catch (_) {}
}

// --- upload ---

async function uploadBlob(blobsId, hash, buffer) {
    const name = `${hash}.bin`;
    await withRetry(async () => {
        if (buffer.byteLength <= MULTIPART_LIMIT) {
            const boundary = `mt${crypto.randomUUID().replace(/-/g, '')}`;
            const meta = JSON.stringify({ name, parents: [blobsId], mimeType: 'application/octet-stream' });
            const body = new Blob([
                `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
                `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
                buffer,
                `\r\n--${boundary}--`
            ]);
            const res = await driveFetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
                method: 'POST',
                headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
                body
            });
            if (!res.ok) throw new Error(`Google Drive upload failed (${res.status}) for ${name}`);
            return;
        }

        const init = await driveFetch(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Type': 'application/octet-stream',
                'X-Upload-Content-Length': String(buffer.byteLength)
            },
            body: JSON.stringify({ name, parents: [blobsId] })
        });
        const sessionUrl = init.headers.get('Location');
        if (!init.ok || !sessionUrl) throw new Error(`Google Drive upload failed (${init.status}) for ${name}`);

        const total = buffer.byteLength;
        for (let start = 0; start < total; start += RESUMABLE_PIECE) {
            const end = Math.min(start + RESUMABLE_PIECE, total);
            // The session URL is pre-authorized, so this is a plain fetch
            const res = await fetch(sessionUrl, {
                method: 'PUT',
                headers: { 'Content-Range': `bytes ${start}-${end - 1}/${total}` },
                body: buffer.slice(start, end)
            });
            if (res.status !== 308 && !res.ok) throw new Error(`Google Drive upload failed (${res.status}) for ${name}`);
        }
    });
}

function manifestNameFor(date) {
    return `${MANIFEST_PREFIX}${date.toISOString().replace(/[:.]/g, '-')}.json`;
}

function exportedAtFromManifestName(name) {
    const m = /^manifest-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/.exec(name);
    return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

/**
 * Back up to the Drive folder layout, uploading only blobs Drive doesn't have.
 * @param {object} [options]
 * @param {function({phase: string, current: number, total: number, bytesSent: number, name?: string}): void} [options.onProgress]
 * @returns {Promise<{manifestName: string, uploaded: number, reused: number, bytesSent: number}>}
 */
export async function createIncrementalDriveBackup({ onProgress } = {}) {
    const report = (info) => { if (typeof onProgress === 'function') onProgress(info); };

    report({ phase: 'scan', current: 0, total: 0, bytesSent: 0 });
    const { blobsId, manifestsId } = await resolveBackupFolders({ create: true });
    const remote = await listChildren(blobsId);
    const remoteHashes = new Set(remote.map(f => f.name.replace(/\.bin$/, '')));

    const [fileMetas, libraryData, soundFonts] = await Promise.all([
        getAllStoredFiles(),
        getAllLibraryData(),
        listSoundFonts()
    ]);

    // Each source knows how to read its bytes lazily and which cache key proves they're unchanged
    const sources = [
        ...fileMetas.map(meta => ({
            kind: 'file',
            meta,
            cacheKey: `f:${meta.id}`,
            fingerprint: `${meta.size || 0}:${meta.lastModified || 0}:${meta.savedAt || 0}`,
            read: async () => (await getStoredFileRecord(meta.id))?.data || null
        })),
        ...soundFonts.map(meta => ({
            kind: 'soundfont',
            meta,
            cacheKey: `s:${meta.id}`,
            fingerprint: `${meta.size || 0}:${meta.addedAt || 0}`,
            read: async () => getSoundFontData(meta.id)
        }))
    ];

    const hashCache = loadHashCache();
    const nextCache = {};
    const queuedHashes = new Set();
    let current = 0;
    let uploaded = 0;
    let reused = 0;
    let bytesSent = 0;

    await runPool(sources, UPLOAD_CONCURRENCY, async (source) => {
        let hash = hashCache[source.cacheKey]?.fingerprint === source.fingerprint
            ? hashCache[source.cacheKey].hash
            : null;
        let buffer = null;

        if (!hash) {
            buffer = await source.read();
            if (buffer) hash = await sha256Hex(buffer);
        }

        if (hash) {
            nextCache[source.cacheKey] = { fingerprint: source.fingerprint, hash };
            if (remoteHashes.has(hash) || queuedHashes.has(hash)) {
                reused++;
            } else {
                queuedHashes.add(hash);
                buffer = buffer || await source.read();
                if (buffer) {
                    await uploadBlob(blobsId, hash, buffer);
                    uploaded++;
                    bytesSent += buffer.byteLength;
                }
            }
        }
        source.hash = hash;

        current++;
        report({ phase: 'upload', current, total: sources.length, bytesSent, name: source.meta.name });
    });

    saveHashCache(nextCache);

    const files = [];
    const soundFontEntries = [];
    for (const source of sources) {
        if (!source.hash) continue;
        if (source.kind === 'file') {
            const meta = source.meta;
            files.push({
                id: meta.id,
                name: meta.name,
                type: meta.type || 'application/octet-stream',
                size: meta.size || 0,
                providerId: meta.providerId || 'local',
                metadata: meta.metadata || {},
                savedAt: meta.savedAt || Date.now(),
                lastModified: meta.lastModified || Date.now(),
                blob: source.hash
            });
        } else {
            const meta = source.meta;
            soundFontEntries.push({
                store: SOUNDFONT_BACKUP_STORE,
                id: meta.id,
                name: meta.name,
                size: meta.size,
                addedAt: meta.addedAt,
                blob: source.hash
            });
        }
    }

    const extensions = collectExtensions();
    const exportedAt = new Date();
    const manifest = {
        app: 'MajesticTab',
        format: 'majestictab_backup',
        version: MANIFEST_FORMAT_VERSION,
        exportedAt: exportedAt.toISOString(),
        summary: {
            tabsCount: files.length,
            soundFontsCount: soundFontEntries.length,
            totalTabsSize: files.reduce((acc, f) => acc + (f.size || 0), 0),
            songsCount: libraryData.songs?.length || 0,
            collectionsCount: libraryData.collections?.length || 0,
            recentsCount: libraryData.recents?.length || 0,
            extensionsCount: extensions.length
        },
        settings: collectAllSettings(),
        extensions,
        library: libraryData,
        files: [...files, ...soundFontEntries]
    };

    // Written last: until it lands, the previous manifest remains the newest restorable state
    report({ phase: 'manifest', current: sources.length, total: sources.length, bytesSent });
    const manifestName = manifestNameFor(exportedAt);
    await withRetry(async () => {
        const boundary = `mt${crypto.randomUUID().replace(/-/g, '')}`;
        const meta = JSON.stringify({ name: manifestName, parents: [manifestsId], mimeType: 'application/json' });
        const body = new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
            `--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
            JSON.stringify(manifest),
            `\r\n--${boundary}--`
        ]);
        const res = await driveFetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
            body
        });
        if (!res.ok) throw new Error(`Google Drive upload failed (${res.status}) for ${manifestName}`);
    });

    let pruned = 0;
    try {
        pruned = await pruneOldManifests();
    } catch (err) {
        console.warn('[DriveBackup] Could not prune old manifests:', err);
    }

    return { manifestName, uploaded, reused, bytesSent, pruned };
}

async function deleteDriveFile(fileId) {
    const res = await driveFetch(`${DRIVE_API}/${fileId}`, { method: 'DELETE' });
    // 404 means it is already gone, which is the outcome we wanted
    if (!res.ok && res.status !== 404) throw new Error(`Could not delete from Google Drive (${res.status}).`);
}

/** Delete manifests beyond the newest `keep`. Blobs are untouched; see cleanUpUnusedDriveBlobs. */
export async function pruneOldManifests(keep = MANIFEST_RETENTION) {
    const backups = await listIncrementalDriveBackups();
    const stale = backups.slice(keep);
    await runPool(stale, DELETE_CONCURRENCY, backup => withRetry(() => deleteDriveFile(backup.id)));
    return stale.length;
}

/** Delete one timestamped backup. Its blobs stay until cleanUpUnusedDriveBlobs finds them unreferenced. */
export async function deleteIncrementalDriveBackup(backup) {
    await withRetry(() => deleteDriveFile(backup.id));
}

/**
 * Delete blobs that no manifest references. Aborts without deleting anything if any manifest
 * can't be read, since a missed manifest would make live blobs look unused.
 * @returns {Promise<{deleted: number, freedBytes: number, kept: number}>}
 */
export async function cleanUpUnusedDriveBlobs() {
    const folders = await resolveBackupFolders({ create: false });
    if (!folders) return { deleted: 0, freedBytes: 0, kept: 0 };

    const manifests = await listIncrementalDriveBackups();
    const referenced = new Set();
    await runPool(manifests, UPLOAD_CONCURRENCY, async (backup) => {
        const res = await driveFetch(`${DRIVE_API}/${backup.id}?alt=media`);
        if (!res.ok) throw new Error(`Cleanup stopped: could not read ${backup.name} (${res.status}).`);
        let manifest;
        try { manifest = await res.json(); } catch (_) { throw new Error(`Cleanup stopped: ${backup.name} is not valid JSON.`); }
        for (const item of manifest.files || []) {
            if (item.blob) referenced.add(item.blob);
        }
    });

    // Re-listed after reading manifests so blobs uploaded in the meantime are seen as recent
    const blobs = await listChildren(folders.blobsId);
    const cutoff = Date.now() - BLOB_SWEEP_GRACE_MS;
    const unused = blobs.filter(f =>
        !referenced.has(f.name.replace(/\.bin$/, '')) && new Date(f.modifiedTime).getTime() < cutoff);

    await runPool(unused, DELETE_CONCURRENCY, f => withRetry(() => deleteDriveFile(f.id)));
    return {
        deleted: unused.length,
        freedBytes: unused.reduce((acc, f) => acc + (Number(f.size) || 0), 0),
        kept: blobs.length - unused.length
    };
}

/**
 * @returns {Promise<Array<{id: string, name: string, size: number, modifiedTime: string, exportedAt: string|null}>>}
 *   Incremental backups on Drive, newest first.
 */
export async function listIncrementalDriveBackups() {
    const folders = await resolveBackupFolders({ create: false });
    if (!folders) return [];
    const manifests = await listChildren(folders.manifestsId, ` and name contains '${MANIFEST_PREFIX}'`);
    return manifests
        .filter(f => exportedAtFromManifestName(f.name))
        .map(f => ({ ...f, size: Number(f.size) || 0, exportedAt: exportedAtFromManifestName(f.name) }))
        .sort((a, b) => b.exportedAt.localeCompare(a.exportedAt));
}

/**
 * Download one manifest and return it as a restore bundle. Items carry `fetchData`, which
 * downloads that blob on demand, so restore holds one file at a time rather than the library.
 * @param {{id: string}} backup Entry from listIncrementalDriveBackups
 */
export async function loadIncrementalDriveBundle(backup) {
    const folders = await resolveBackupFolders({ create: false });
    if (!folders) throw new Error('No MajesticTab backup folder was found in Google Drive.');

    const [manifestRes, blobFiles] = await Promise.all([
        driveFetch(`${DRIVE_API}/${backup.id}?alt=media`),
        listChildren(folders.blobsId)
    ]);
    if (!manifestRes.ok) throw new Error(`Could not download backup manifest (${manifestRes.status}).`);
    const manifest = await manifestRes.json();

    const blobIds = new Map(blobFiles.map(f => [f.name.replace(/\.bin$/, ''), f.id]));
    const missing = (manifest.files || []).filter(f => f.blob && !blobIds.has(f.blob));
    if (missing.length) {
        throw new Error(`Backup is incomplete: ${missing.length} file(s) are missing from Google Drive (${missing[0].name}).`);
    }

    for (const item of manifest.files || []) {
        if (!item.blob) continue;
        const fileId = blobIds.get(item.blob);
        item.fetchData = () => withRetry(async () => {
            const res = await driveFetch(`${DRIVE_API}/${fileId}?alt=media`);
            if (!res.ok) throw new Error(`Could not download ${item.name} (${res.status}).`);
            return res.arrayBuffer();
        });
    }
    return manifest;
}
