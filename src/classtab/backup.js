// classtab/backup.js
// The Classical tab archive (the ZIP kept in its own IndexedDB) as a backup and sync item, next to tabs, SoundFonts
// and audio. One item with id 'archive', tagged `store: 'classtab'`. Pins and audio sync points are settings and
// travel with those; songs added from the archive to the library are ordinary tabs.

import { getArchiveBackupMeta, getArchiveBytes, installArchive, removeArchive, hasArchive } from './archive.js';
import { arrayBufferToBase64Async, arrayBufferToBase64, base64ToArrayBuffer } from '../fileStore.js';

export const CLASSTAB_BACKUP_STORE = 'classtab';

export const isClasstabItem = (item) => item?.store === CLASSTAB_BACKUP_STORE;
export const classtabFingerprint = (meta) => `${meta.size || 0}:${meta.addedAt || 0}`;

export { getArchiveBackupMeta as getClasstabMeta };

/** Meta for the installed archive as a list (empty when none is installed). */
export async function listClasstab() {
    const meta = await getArchiveBackupMeta();
    return meta ? [meta] : [];
}

export async function getClasstabData() {
    const bytes = await getArchiveBytes();
    if (!bytes) return null;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** The backup entry (with base64 data) for a single-file backup, as an array of zero or one. */
export async function collectClasstabBackupEntries() {
    const meta = await getArchiveBackupMeta();
    const data = meta && await getClasstabData();
    if (!data) return [];
    let dataBase64;
    try { dataBase64 = await arrayBufferToBase64Async(data); } catch { dataBase64 = arrayBufferToBase64(data); }
    return [{ store: CLASSTAB_BACKUP_STORE, ...meta, dataBase64 }];
}

/** @returns {Promise<boolean>} true if installed (merge keeps an archive already on the device) */
export async function restoreClasstabEntry(item, { wipe = false } = {}) {
    if (!wipe && await hasArchive()) return false;
    try {
        const data = item.fetchData ? await item.fetchData() : base64ToArrayBuffer(item.dataBase64);
        item.dataBase64 = null;
        await installArchive(new Uint8Array(data));
        return true;
    } catch (e) {
        console.warn('[Classtab] Could not restore the archive:', e);
        return false;
    }
}

export async function deleteClasstab() {
    await removeArchive();
}
