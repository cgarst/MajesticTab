// incrementalBackup.js
// Incremental snapshot backups, independent of where they are stored. A storage backend
// (Google Drive folder, local folder) holds:
//   blobs/<sha256>.bin                      raw bytes of one tab or SoundFont, immutable
//   manifests/manifest-<timestamp>.json     settings, library and a file table pointing at blobs
// A backup only stores blobs the backend doesn't have yet and writes its manifest last, so an
// interrupted run leaves earlier manifests fully restorable.
//
// Backend contract (all async):
//   label: string
//   open({create}) -> boolean            resolves the folders; false when absent and !create
//   listBlobs() -> [{id, name: '<hash>.bin', size, modifiedTime}]
//   putBlob(hash, buffer)
//   readBlob(entry, label) -> ArrayBuffer
//   deleteBlob(entry)
//   listManifests() -> [{id, name, size, modifiedTime, counts?: {tabs, soundFonts}}]
//   putManifest(name, text, counts)
//   readManifest(entry) -> object
//   deleteManifest(entry)
import { getAllStoredFiles, getStoredFileRecord } from './fileStore.js';
import { getAllLibraryData } from './libraryStore.js';
import { listSoundFonts, getSoundFontData, SOUNDFONT_BACKUP_STORE } from './soundFontStore.js';
import { collectAllSettings, collectExtensions } from './backupRestore.js';

export const ROOT_FOLDER_NAME = 'MajesticTab Backup';
export const BLOBS_FOLDER_NAME = 'blobs';
export const MANIFESTS_FOLDER_NAME = 'manifests';
const MANIFEST_PREFIX = 'manifest-';
const MANIFEST_FORMAT_VERSION = 2;
const UPLOAD_CONCURRENCY = 3;
const DELETE_CONCURRENCY = 4;
// Newest manifests kept after each backup; older ones are removed (their blobs wait for a cleanup)
const MANIFEST_RETENTION = 30;
// Blobs younger than this are never swept: a backup in another tab may not have written its manifest yet
const BLOB_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
const HASH_CACHE_KEY = 'majestictab_backup_hash_cache';

export async function withRetry(run, attempts = 3) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await run();
        } catch (err) {
            if (attempt >= attempts - 1 || /authorization expired|not connected|permission/i.test(err.message)) throw err;
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
    }
}

/** Runs `worker` over `items` with at most `limit` in flight; rejects on the first failure. */
export async function runPool(items, limit, worker) {
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            await worker(items[index], index);
        }
    });
    await Promise.all(lanes);
}

const blobHash = (name) => name.replace(/\.bin$/, '');

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

// Cheap change detector shared by the hash cache and the backup preview
export function fileFingerprint(meta) {
    return `${meta.size || 0}:${meta.lastModified || 0}:${meta.savedAt || 0}`;
}

export function soundFontFingerprint(meta) {
    return `${meta.size || 0}:${meta.addedAt || 0}`;
}

// --- manifest names ---

export function manifestNameFor(date) {
    return `${MANIFEST_PREFIX}${date.toISOString().replace(/[:.]/g, '-')}.json`;
}

export function isManifestName(name) {
    return exportedAtFromManifestName(name) !== null;
}

function exportedAtFromManifestName(name) {
    const m = /^manifest-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/.exec(name);
    return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

// --- backup ---

/**
 * Back up to `backend`, storing only blobs it doesn't have.
 * @param {object} backend
 * @param {object} [options]
 * @param {function({phase: string, current: number, total: number, bytesSent: number, uploaded?: number, reused?: number, name?: string}): void} [options.onProgress]
 * @returns {Promise<{manifestName: string, uploaded: number, reused: number, bytesSent: number, pruned: number}>}
 */
export async function createIncrementalBackup(backend, { onProgress } = {}) {
    const report = (info) => { if (typeof onProgress === 'function') onProgress(info); };

    report({ phase: 'scan', current: 0, total: 0, bytesSent: 0 });
    await backend.open({ create: true });
    const remote = await backend.listBlobs();
    const remoteHashes = new Set(remote.map(f => blobHash(f.name)));

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
            fingerprint: fileFingerprint(meta),
            read: async () => (await getStoredFileRecord(meta.id))?.data || null
        })),
        ...soundFonts.map(meta => ({
            kind: 'soundfont',
            meta,
            cacheKey: `s:${meta.id}`,
            fingerprint: soundFontFingerprint(meta),
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
                    await withRetry(() => backend.putBlob(hash, buffer));
                    uploaded++;
                    bytesSent += buffer.byteLength;
                }
            }
        }
        source.hash = hash;

        current++;
        report({ phase: 'upload', current, total: sources.length, bytesSent, uploaded, reused, name: source.meta.name });
    });

    saveHashCache(nextCache);

    const files = [];
    const soundFontEntries = [];
    for (const source of sources) {
        if (!source.hash) continue;
        const meta = source.meta;
        if (source.kind === 'file') {
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
    const counts = { tabs: files.length, soundFonts: soundFontEntries.length, songs: manifest.summary.songsCount };
    await withRetry(() => backend.putManifest(manifestName, JSON.stringify(manifest), counts));

    let pruned = 0;
    try {
        pruned = await pruneOldManifests(backend);
    } catch (err) {
        console.warn('[IncrementalBackup] Could not prune old manifests:', err);
    }

    return { manifestName, uploaded, reused, bytesSent, pruned };
}

/**
 * Compare local tabs and SoundFonts with the newest snapshot without writing anything.
 * Files are matched by id and judged changed when their size/date fingerprint differs.
 * @returns {Promise<{latest: {name: string, exportedAt: string}|null, added: number, modified: number,
 *   removed: number, unchanged: number, bytesToSend: number, backupCount: number}>}
 */
export async function previewIncrementalBackup(backend) {
    const [backups, fileMetas, soundFonts] = await Promise.all([
        listIncrementalBackups(backend),
        getAllStoredFiles(),
        listSoundFonts()
    ]);
    const local = [
        ...fileMetas.map(m => ({ key: `f:${m.id}`, fingerprint: fileFingerprint(m), size: m.size || 0 })),
        ...soundFonts.map(m => ({ key: `s:${m.id}`, fingerprint: soundFontFingerprint(m), size: m.size || 0 }))
    ];
    const summary = { latest: null, added: 0, modified: 0, removed: 0, unchanged: 0, bytesToSend: 0, backupCount: backups.length };

    if (!backups.length) {
        summary.added = local.length;
        summary.bytesToSend = local.reduce((acc, f) => acc + f.size, 0);
        return summary;
    }

    const manifest = await backend.readManifest(backups[0]);
    summary.latest = { name: backups[0].name, exportedAt: backups[0].exportedAt };

    const previous = new Map((manifest.files || []).map(item => [
        item.store ? `s:${item.id}` : `f:${item.id}`,
        item.store ? soundFontFingerprint(item) : fileFingerprint(item)
    ]));
    for (const item of local) {
        if (!previous.has(item.key)) { summary.added++; summary.bytesToSend += item.size; }
        else if (previous.get(item.key) !== item.fingerprint) { summary.modified++; summary.bytesToSend += item.size; }
        else summary.unchanged++;
        previous.delete(item.key);
    }
    summary.removed = previous.size;
    return summary;
}

/**
 * Compare a loaded snapshot with what is on this device, for the restore preview.
 * Merge skips tabs already on the device, so only `missing` is restored; wipe replaces everything.
 * @param {{files?: Array}} bundle From loadIncrementalBundle
 * @returns {Promise<{total: number, totalBytes: number, missing: number, missingBytes: number,
 *   same: number, differs: number, localOnly: number}>}
 */
export async function previewIncrementalRestore(bundle) {
    const [fileMetas, soundFonts] = await Promise.all([getAllStoredFiles(), listSoundFonts()]);
    const local = new Map([
        ...fileMetas.map(m => [`f:${m.id}`, fileFingerprint(m)]),
        ...soundFonts.map(m => [`s:${m.id}`, soundFontFingerprint(m)])
    ]);
    const summary = { total: 0, totalBytes: 0, missing: 0, missingBytes: 0, same: 0, differs: 0, localOnly: 0 };
    for (const item of (bundle.files || []).filter(f => f.blob)) {
        const key = item.store ? `s:${item.id}` : `f:${item.id}`;
        const fingerprint = item.store ? soundFontFingerprint(item) : fileFingerprint(item);
        summary.total++;
        summary.totalBytes += item.size || 0;
        if (!local.has(key)) { summary.missing++; summary.missingBytes += item.size || 0; }
        else if (local.get(key) === fingerprint) summary.same++;
        else summary.differs++;
        local.delete(key);
    }
    summary.localOnly = local.size;
    return summary;
}

/**
 * @returns {Promise<Array<{id: string, name: string, size: number, modifiedTime: string, exportedAt: string, counts: {tabs: number, soundFonts: number}|null}>>}
 *   Snapshots in `backend`, newest first.
 */
export async function listIncrementalBackups(backend) {
    if (!(await backend.open({ create: false }))) return [];
    const manifests = await backend.listManifests();
    return manifests
        .filter(f => isManifestName(f.name))
        .map(f => ({ ...f, size: Number(f.size) || 0, exportedAt: exportedAtFromManifestName(f.name), counts: f.counts || null }))
        .sort((a, b) => b.exportedAt.localeCompare(a.exportedAt));
}

/** Delete manifests beyond the newest `keep`. Blobs are untouched; see findUnusedBlobs. */
export async function pruneOldManifests(backend, keep = MANIFEST_RETENTION) {
    const backups = await listIncrementalBackups(backend);
    const stale = backups.slice(keep);
    await runPool(stale, DELETE_CONCURRENCY, backup => withRetry(() => backend.deleteManifest(backup)));
    return stale.length;
}

/**
 * Find blobs that no snapshot references, without deleting anything. Throws if any manifest
 * can't be read, since a missed manifest would make live blobs look unused.
 * @returns {Promise<{unused: Array, freedBytes: number, kept: number, recent: number, snapshotCount: number}>}
 *   `unused` is what deleteBlobs should remove; `recent` counts unreferenced blobs spared by the grace period.
 */
export async function findUnusedBlobs(backend) {
    const empty = { unused: [], freedBytes: 0, kept: 0, recent: 0, snapshotCount: 0 };
    if (!(await backend.open({ create: false }))) return empty;

    const manifests = await listIncrementalBackups(backend);
    const referenced = new Set();
    await runPool(manifests, UPLOAD_CONCURRENCY, async (backup) => {
        let manifest;
        try { manifest = await backend.readManifest(backup); } catch (err) {
            throw new Error(`Cleanup stopped: could not read ${backup.name} (${err.message}).`);
        }
        for (const item of manifest.files || []) {
            if (item.blob) referenced.add(item.blob);
        }
    });

    // Listed after reading manifests so blobs written in the meantime are seen as recent
    const blobs = await backend.listBlobs();
    const cutoff = Date.now() - BLOB_SWEEP_GRACE_MS;
    const unreferenced = blobs.filter(f => !referenced.has(blobHash(f.name)));
    const unused = unreferenced.filter(f => new Date(f.modifiedTime).getTime() < cutoff);
    return {
        unused,
        freedBytes: unused.reduce((acc, f) => acc + (Number(f.size) || 0), 0),
        kept: blobs.length - unused.length,
        recent: unreferenced.length - unused.length,
        snapshotCount: manifests.length
    };
}

/** Delete the blobs findUnusedBlobs returned. */
export async function deleteBlobs(backend, blobs) {
    await runPool(blobs, DELETE_CONCURRENCY, f => withRetry(() => backend.deleteBlob(f)));
}

/**
 * Read one manifest and return it as a restore bundle. Items carry `fetchData`, which
 * reads that blob on demand, so restore holds one file at a time rather than the library.
 * @param {object} backend
 * @param {{id: string}} backup Entry from listIncrementalBackups
 */
export async function loadIncrementalBundle(backend, backup) {
    if (!(await backend.open({ create: false }))) {
        throw new Error(`No MajesticTab backup folder was found in ${backend.label}.`);
    }

    const [manifest, blobFiles] = await Promise.all([backend.readManifest(backup), backend.listBlobs()]);

    const blobEntries = new Map(blobFiles.map(f => [blobHash(f.name), f]));
    const missing = (manifest.files || []).filter(f => f.blob && !blobEntries.has(f.blob));
    if (missing.length) {
        throw new Error(`Backup is incomplete: ${missing.length} file(s) are missing from ${backend.label} (${missing[0].name}).`);
    }

    for (const item of manifest.files || []) {
        if (!item.blob) continue;
        const entry = blobEntries.get(item.blob);
        item.fetchData = () => withRetry(() => backend.readBlob(entry, item.name));
    }
    return manifest;
}
