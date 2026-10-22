// soundFontStore.js
// Persistent store and selection for user-supplied SoundFonts (.sf2 / .sf3).
// Any number can be enabled at once; AlphaTab layers them in load order, so later ones override earlier ones.
import { getDB, STORE_SOUNDFONTS, arrayBufferToBase64Async, arrayBufferToBase64, base64ToArrayBuffer } from './fileStore.js';

export const BUILTIN_SOUNDFONT_ID = 'builtin';
export const BUILTIN_SOUNDFONT_URL = 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/soundfont/sonivox.sf2';
export const STORAGE_KEY_SOUNDFONT_SELECTION = 'majestictab_soundfont_selection';
export const SOUNDFONT_BACKUP_STORE = 'soundfonts';

function request(mode, run) {
    return getDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SOUNDFONTS, mode);
        const req = run(tx.objectStore(STORE_SOUNDFONTS));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }));
}

/** RIFF container with an 'sfbk' form type covers both SF2 and SF3. */
export function isSoundFontData(buffer) {
    if (!buffer || buffer.byteLength < 12) return false;
    const b = new Uint8Array(buffer, 0, 12);
    const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    return tag(0) === 'RIFF' && tag(8) === 'sfbk';
}

/** @returns {Promise<Array<{id:string,name:string,size:number,addedAt:number}>>} Metadata only, oldest first. */
export async function listSoundFonts() {
    const all = await request('readonly', s => s.getAll());
    return (all || [])
        .map(({ id, name, size, addedAt }) => ({ id, name, size, addedAt }))
        .sort((a, b) => a.addedAt - b.addedAt);
}

export async function getSoundFontData(id) {
    const rec = await request('readonly', s => s.get(id));
    return rec?.data || null;
}

export async function addSoundFont(file) {
    const data = await file.arrayBuffer();
    if (!isSoundFontData(data)) {
        throw new Error(`${file.name} is not a valid SoundFont (.sf2 or .sf3) file.`);
    }
    const record = {
        id: `sf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        size: data.byteLength,
        addedAt: Date.now(),
        data
    };
    await request('readwrite', s => s.put(record));
    return { id: record.id, name: record.name, size: record.size, addedAt: record.addedAt };
}

export async function deleteSoundFont(id) {
    await request('readwrite', s => s.delete(id));
    setSelectedSoundFontIds(getSelectedSoundFontIds().filter(x => x !== id));
}

export async function clearAllSoundFonts() {
    await request('readwrite', s => s.clear());
}

/** Enabled ids. Defaults to the built-in SONiVOX font; never empty. */
export function getSelectedSoundFontIds() {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY_SOUNDFONT_SELECTION));
        if (Array.isArray(parsed) && parsed.length > 0) return parsed.filter(x => typeof x === 'string');
    } catch (_) {}
    return [BUILTIN_SOUNDFONT_ID];
}

export function setSelectedSoundFontIds(ids) {
    const next = ids.length > 0 ? ids : [BUILTIN_SOUNDFONT_ID];
    try {
        localStorage.setItem(STORAGE_KEY_SOUNDFONT_SELECTION, JSON.stringify(next));
    } catch (_) {}
    return next;
}

/**
 * Load every enabled SoundFont into an AlphaTab API, built-in first, then uploads oldest to newest.
 * @returns {Promise<number>} number of SoundFonts queued
 */
export async function applySoundFontsToApi(api) {
    if (!api) return 0;
    const selected = new Set(getSelectedSoundFontIds());
    const sources = [];
    if (selected.has(BUILTIN_SOUNDFONT_ID)) sources.push(BUILTIN_SOUNDFONT_URL);
    for (const meta of await listSoundFonts()) {
        if (!selected.has(meta.id)) continue;
        const data = await getSoundFontData(meta.id);
        if (data) sources.push(new Uint8Array(data));
    }
    if (sources.length === 0) sources.push(BUILTIN_SOUNDFONT_URL);
    sources.forEach((src, i) => api.loadSoundFont(src, i > 0));
    return sources.length;
}

/** Backup entries (same shape as stored tab files, tagged with `store`). */
export async function collectSoundFontBackupEntries() {
    const all = await request('readonly', s => s.getAll());
    const entries = [];
    for (const rec of (all || []).sort((a, b) => a.addedAt - b.addedAt)) {
        let dataBase64;
        try {
            dataBase64 = await arrayBufferToBase64Async(rec.data);
        } catch {
            dataBase64 = arrayBufferToBase64(rec.data);
        }
        entries.push({
            store: SOUNDFONT_BACKUP_STORE,
            id: rec.id,
            name: rec.name,
            size: rec.size,
            addedAt: rec.addedAt,
            dataBase64
        });
    }
    return entries;
}

/** @returns {Promise<boolean>} true if written (merge skips ids that already exist) */
export async function restoreSoundFontEntry(item, { wipe = false } = {}) {
    if (!wipe && await request('readonly', s => s.get(item.id))) return false;
    const data = base64ToArrayBuffer(item.dataBase64);
    item.dataBase64 = null;
    await request('readwrite', s => s.put({
        id: item.id,
        name: item.name,
        size: item.size || data.byteLength,
        addedAt: item.addedAt || Date.now(),
        data
    }));
    return true;
}
