// audioBackup.js
// Audio files in backups and cloud sync. They ride beside tabs and SoundFonts, tagged `store: 'audio'`, and only
// ever go to the user's own destinations (their backup file, Drive, S3, iCloud, a folder). Three controls keep that
// in the user's hands: a switch for sending audio at all, a switch for receiving it, and a per-file exclude (set in
// the Audio File panel). A snapshot item carries the file's name, length and fingerprint, so a device that doesn't
// take the audio can still relink it later. The waveform peaks are not stored; they are rebuilt when a file is opened.

import { arrayBufferToBase64, arrayBufferToBase64Async, base64ToArrayBuffer } from '../fileStore.js';
import {
    listAudioFiles, getAudioFile, getAudioMeta, putAudioRecord, linkAudioFile, fingerprintOf, audioFingerprint
} from './audioFileStore.js';

export const AUDIO_BACKUP_STORE = 'audio';
export const AUDIO_FILES_CHANGED_EVENT = 'audiofiles:changed';

/** Largest file written into a single-file (.mtbackup) backup, which holds every file as base64 in one JSON document. */
export const SINGLE_FILE_AUDIO_LIMIT = 100 * 1024 * 1024;

/** Sending this much audio in one go gets a warning in the backup dialog. */
export const LARGE_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024;

const UPLOAD_KEY = 'audio_backup_upload';
const DOWNLOAD_KEY = 'audio_backup_download';

function readFlag(key) {
    try { return localStorage.getItem(key) !== '0'; } catch { return true; }
}

function writeFlag(key, on) {
    try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* per-device convenience only */ }
}

/** Whether this device sends its audio files to backups and sync. On unless turned off. */
export const isAudioUploadEnabled = () => readFlag(UPLOAD_KEY);
export const setAudioUploadEnabled = (on) => writeFlag(UPLOAD_KEY, on);

/** Whether this device receives audio files from backups and sync. On unless turned off. */
export const isAudioDownloadEnabled = () => readFlag(DOWNLOAD_KEY);
export const setAudioDownloadEnabled = (on) => writeFlag(DOWNLOAD_KEY, on);

export const isAudioItem = (item) => item?.store === AUDIO_BACKUP_STORE;

/** Stored files that would go into a backup now: nothing when sending is off, and never an excluded file. */
export async function listAudioForBackup() {
    if (!isAudioUploadEnabled()) return [];
    return (await listAudioFiles()).filter(m => !m.excludeFromBackup);
}

/** What the backup dialog shows: how many files and how much, and how many are held back. */
export async function audioBackupOverview() {
    const all = await listAudioFiles();
    const included = isAudioUploadEnabled() ? all.filter(m => !m.excludeFromBackup) : [];
    return {
        enabled: isAudioUploadEnabled(),
        total: all.length,
        count: included.length,
        bytes: included.reduce((sum, m) => sum + (m.size || 0), 0),
        excluded: all.length - (isAudioUploadEnabled() ? included.length : 0)
    };
}

/** A snapshot's entry for a stored file. */
export function audioManifestEntry(meta, blobHash) {
    return {
        store: AUDIO_BACKUP_STORE,
        id: meta.id,
        name: meta.name,
        type: meta.type || 'audio/mpeg',
        size: meta.size || 0,
        durationMs: meta.durationMs ?? null,
        fingerprint: meta.fingerprint || '',
        songKeys: meta.songKeys || [],
        savedAt: meta.savedAt || Date.now(),
        // Set on a file the app made from another one (a backing track), so a restore still knows it may replace it
        ...(meta.generatedFrom ? { generatedFrom: meta.generatedFrom } : {}),
        blob: blobHash
    };
}

export { audioFingerprint as audioItemFingerprint };

/** The actions sync can take on an audio file. They match `SYNC_ACTION` in syncEngine.js, and there is no local delete. */
export const AUDIO_SYNC_ACTION = { UPLOAD: 'upload', DOWNLOAD: 'download', DELETE_REMOTE: 'delete-remote' };

/**
 * What sync does with one audio file, from this device's copy (`mine`), the snapshot's (`theirs`) and the
 * fingerprint at the last sync (`was`). Audio only adds: nothing here deletes a file from this device, and a file
 * the snapshot no longer lists is simply put back by the next push. A device that doesn't take audio
 * (`downloadAllowed` false) never downloads, and its pushes carry the snapshot's audio forward.
 * @returns {{action: string, reason: string, conflict?: boolean}|null} null when there is nothing to do
 */
export function audioSyncDecision(mine, theirs, was, downloadAllowed) {
    const { UPLOAD, DOWNLOAD, DELETE_REMOTE } = AUDIO_SYNC_ACTION;
    if (mine && theirs) {
        if (mine.fingerprint === theirs.fingerprint) return null;
        // The same file id holds different audio on each side (it was relinked with another take): the newer one wins
        if (mine.time >= theirs.time || !downloadAllowed) return { action: UPLOAD, reason: 'Changed on this device', conflict: true };
        return { action: DOWNLOAD, reason: 'Changed in the snapshot', conflict: true };
    }
    if (mine) return { action: UPLOAD, reason: was === undefined ? 'New on this device' : 'Not in the snapshot' };
    if (was === theirs.fingerprint) return { action: DELETE_REMOTE, reason: 'Left out of the next snapshot: it was removed from this device' };
    return downloadAllowed ? { action: DOWNLOAD, reason: 'New in the snapshot' } : null;
}

/**
 * One file at a time as single-file backup entries (`dataBase64` set), so the backup never holds them all. Files
 * over `maxBytes` are not written; ask `audioBackupSkipped` for those.
 */
export async function* iterateAudioBackupEntries({ maxBytes = SINGLE_FILE_AUDIO_LIMIT } = {}) {
    for (const meta of await listAudioForBackup()) {
        if (meta.size > maxBytes) continue;
        const rec = await getAudioFile(meta.id);
        if (!rec?.data) continue;
        let dataBase64;
        try {
            dataBase64 = await arrayBufferToBase64Async(rec.data);
        } catch {
            dataBase64 = arrayBufferToBase64(rec.data);
        }
        yield { ...audioManifestEntry(meta, undefined), blob: undefined, dataBase64 };
    }
}

/** What a single-file backup takes and leaves out, for its header and the dialog. */
export async function audioBackupPlan({ maxBytes = SINGLE_FILE_AUDIO_LIMIT } = {}) {
    const eligible = await listAudioForBackup();
    const taken = eligible.filter(m => m.size <= maxBytes);
    return {
        count: taken.length,
        bytes: taken.reduce((sum, m) => sum + (m.size || 0), 0),
        tooLarge: eligible.filter(m => m.size > maxBytes).map(m => ({ name: m.name, size: m.size }))
    };
}

/**
 * Puts a backed-up file on this device, keeping its original id so sync points that name it still find it.
 * `item` carries `dataBase64` (single-file backups) or `fetchData` (snapshots).
 * @returns {Promise<boolean>} true if written; a file already here is left alone (its song links are merged), unless `wipe`
 */
export async function restoreAudioEntry(item, { wipe = false } = {}) {
    const existing = wipe ? null : await getAudioMeta(item.id);
    if (existing) {
        for (const key of item.songKeys || []) await linkAudioFile(item.id, key);
        return false;
    }
    const data = item.fetchData ? await item.fetchData() : base64ToArrayBuffer(item.dataBase64);
    item.dataBase64 = null;
    await putAudioRecord({
        id: item.id,
        name: item.name,
        type: item.type || 'audio/mpeg',
        size: data.byteLength,
        durationMs: item.durationMs ?? null,
        fingerprint: item.fingerprint || await fingerprintOf(data),
        peaks: null, // rebuilt when the file is opened
        songKeys: item.songKeys || [],
        savedAt: item.savedAt || Date.now(),
        ...(item.generatedFrom ? { generatedFrom: item.generatedFrom } : {}),
        data
    });
    window.dispatchEvent(new CustomEvent(AUDIO_FILES_CHANGED_EVENT));
    return true;
}
