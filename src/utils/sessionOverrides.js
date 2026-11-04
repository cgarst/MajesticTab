// sessionOverrides.js
// Temporary choices for the song that is open: the notation, the string count and how the tab is fitted to the guitar
// in your hands (tuning, capo). Nothing here is saved. The values reset when the song closes, and a different song never
// sees them. The saved starting values live in Settings, Defaults (notation, strings, usual guitar).

let current = { key: null };

/** The id a tab is stored under: library tab, stored file, Drive file or file name. */
export function getTabStorageId(file) {
    if (!file) return null;
    if (typeof file === 'string') return file;
    if (file.librarySongId && file.tabId) return `${file.librarySongId}_tab_${file.tabId}`;
    if (file.tabId) return file.tabId;
    if (file.fileStoreId) return file.fileStoreId;
    if (file.driveFileId) return file.driveFileId;
    if (file.name) return file.name;
    return null;
}

function notify() {
    try { document.dispatchEvent(new CustomEvent('guitar:overrides-changed')); } catch (_) { /* no DOM in tests */ }
}

/** Call when a song opens. A different song starts with no overrides. */
export function beginSong(file) {
    const key = getTabStorageId(file);
    if (key !== current.key) {
        current = { key };
        notify();
    }
}

/** Call when the song closes. */
export function clearOverrides() {
    if (current.key === null && Object.keys(current).length === 1) return;
    current = { key: null };
    notify();
}

/** The override for this file, or undefined when there is none. `null` is a real value: "as written". */
export function getOverride(file, field) {
    if (!file || current.key === null || current.key !== getTabStorageId(file)) return undefined;
    return current[field];
}

export function setOverride(file, field, value) {
    const key = getTabStorageId(file);
    if (!key) return;
    if (current.key !== key) current = { key };
    current[field] = value;
    notify();
}

/** The notation override has no file argument: it belongs to whichever song is open. */
export function getNotationOverride() {
    return current.key === null ? undefined : current.notation;
}

export function setNotationOverride(mode) {
    if (current.key === null) return;
    current.notation = mode;
    notify();
}
