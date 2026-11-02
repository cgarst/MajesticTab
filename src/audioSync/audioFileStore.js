// audioFileStore.js
// On-device storage for audio files the user syncs a score to. Kept in its own IndexedDB database so these large
// blobs stay apart from the tab library (fileStore.js) and its backup and wipe code. Records:
//   { id, name, type, size, durationMs, fingerprint, peaks (Uint8Array|null), songKeys: [string], savedAt,
//     excludeFromBackup (true to keep it out of backups and sync), data (ArrayBuffer) }
// The audio is kept as an ArrayBuffer, which every platform webview can store (Blob support in IndexedDB is not
// uniform).

const DB_NAME = 'majestictab_audio';
const DB_VERSION = 1;
const STORE = 'audio_files';

/** Largest file accepted. The whole file is held in memory while it is saved and decoded for its peaks. */
export const MAX_AUDIO_BYTES = 250 * 1024 * 1024;

const FINGERPRINT_BYTES = 1024 * 1024;

let dbPromise = null;

function getDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB is not supported in this environment.'));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
}

async function request(mode, run) {
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

/** Content fingerprint: SHA-256 of the file size and its first megabyte, as hex. Cheap, and stable across renames. */
export async function fingerprintOf(arrayBuffer) {
    const head = new Uint8Array(arrayBuffer, 0, Math.min(arrayBuffer.byteLength, FINGERPRINT_BYTES));
    const sizeBytes = new TextEncoder().encode(`${arrayBuffer.byteLength}:`);
    const joined = new Uint8Array(sizeBytes.length + head.length);
    joined.set(sizeBytes);
    joined.set(head, sizeBytes.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', joined));
    return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

export function newAudioId() {
    return crypto.randomUUID ? crypto.randomUUID() : `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

const stripData = ({ data, ...meta }) => meta;

/**
 * Stores `fileData` for a song. If a file with the same fingerprint is already stored it is reused (and linked to
 * the song) instead of saved twice. `info` carries what the caller measured: `{ durationMs, peaks }`.
 * Returns the metadata record (no audio).
 */
export async function saveAudioFile({ name, type, data, songKey, durationMs = null, peaks = null, id = null }) {
    if (data.byteLength > MAX_AUDIO_BYTES) throw new Error('That audio file is too large');
    const fingerprint = await fingerprintOf(data);
    const existing = (await listAudioFiles()).find(r => r.fingerprint === fingerprint && r.size === data.byteLength);
    if (existing && !id) {
        if (songKey && !existing.songKeys.includes(songKey)) await linkAudioFile(existing.id, songKey);
        return { ...existing, songKeys: songKey && !existing.songKeys.includes(songKey) ? [...existing.songKeys, songKey] : existing.songKeys };
    }
    const record = {
        id: id || newAudioId(), name, type: type || 'audio/mpeg', size: data.byteLength, durationMs, fingerprint,
        peaks: peaks || null, songKeys: songKey ? [songKey] : [], savedAt: Date.now(), data
    };
    await request('readwrite', s => s.put(record));
    return stripData(record);
}

/** Metadata of every stored file (no audio), newest first. */
export async function listAudioFiles() {
    const all = await request('readonly', s => s.getAll());
    return (all || []).map(stripData).sort((a, b) => b.savedAt - a.savedAt);
}

export async function listAudioFilesForSong(songKey) {
    return (await listAudioFiles()).filter(r => r.songKeys.includes(songKey));
}

export async function getAudioMeta(id) {
    const rec = await request('readonly', s => s.get(id));
    return rec ? stripData(rec) : null;
}

/** The full record including `data`, or null. */
export async function getAudioFile(id) {
    return (await request('readonly', s => s.get(id))) || null;
}

export async function linkAudioFile(id, songKey) {
    const rec = await getAudioFile(id);
    if (!rec || rec.songKeys.includes(songKey)) return;
    rec.songKeys = [...rec.songKeys, songKey];
    await request('readwrite', s => s.put(rec));
}

/** Moves a file's link from one song key to another (the file is kept). */
export async function relinkAudioFile(id, fromKey, toKey) {
    const rec = await getAudioFile(id);
    if (!rec) return;
    rec.songKeys = [...new Set([...rec.songKeys.filter(k => k !== fromKey), toKey])];
    await request('readwrite', s => s.put(rec));
}

/** Removes the file for a song; the audio itself is deleted when no song uses it any more. */
export async function unlinkAudioFile(id, songKey) {
    const rec = await getAudioFile(id);
    if (!rec) return;
    rec.songKeys = rec.songKeys.filter(k => k !== songKey);
    if (rec.songKeys.length) await request('readwrite', s => s.put(rec));
    else await request('readwrite', s => s.delete(id));
}

export async function deleteAudioFile(id) {
    await request('readwrite', s => s.delete(id));
}

export async function totalAudioBytes() {
    return (await listAudioFiles()).reduce((sum, r) => sum + r.size, 0);
}

/** Writes a complete record as it is (used when restoring a backup, which keeps the original id). */
export async function putAudioRecord(record) {
    await request('readwrite', s => s.put(record));
}

/** Keeps a file out of (or back in) backups and cloud sync. */
export async function setAudioExcluded(id, excluded) {
    const rec = await getAudioFile(id);
    if (!rec) return;
    if (excluded) rec.excludeFromBackup = true; else delete rec.excludeFromBackup;
    await request('readwrite', s => s.put(rec));
}

/** Stores the waveform of a file that was restored without one. */
export async function setAudioPeaks(id, peaks, durationMs = null) {
    const rec = await getAudioFile(id);
    if (!rec) return;
    rec.peaks = peaks;
    if (durationMs !== null && rec.durationMs == null) rec.durationMs = durationMs;
    await request('readwrite', s => s.put(rec));
}

export async function clearAllAudioFiles() {
    await request('readwrite', s => s.clear());
}

/** Cheap change detector for a file: its fingerprint covers the content, the size guards against truncation. */
export const audioFingerprint = (meta) => `${meta.size || 0}:${meta.fingerprint || ''}`;
