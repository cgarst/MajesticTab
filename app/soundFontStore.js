// soundFontStore.js
// Persistent store and selection for user-supplied SoundFonts (.sf2 / .sf3).
// Any number can be enabled at once; AlphaTab layers them in load order, so later ones override earlier ones.
import { parseSoundFontPresets, mergePresetSets, applyProgramMapping } from './soundFontProgramMap.js';
import { clampNegativeAttenuation } from './soundFontSanitize.js';
import { getDB, STORE_SOUNDFONTS, arrayBufferToBase64Async, arrayBufferToBase64, base64ToArrayBuffer } from './fileStore.js';

export const BUILTIN_SOUNDFONT_ID = 'builtin';
export const BUILTIN_SOUNDFONT_URL = 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/soundfont/sonivox.sf2';
export const STORAGE_KEY_SOUNDFONT_SELECTION = 'majestictab_soundfont_selection';
export const STORAGE_KEY_SOUNDFONT_ORDER = 'majestictab_soundfont_order';
export const STORAGE_KEY_SOUNDFONT_STRICT = 'majestictab_soundfont_strict';
export const SOUNDFONT_BACKUP_STORE = 'soundfonts';

const BUILTIN_PRESETS = () => ({
    melodic: new Set(Array.from({ length: 128 }, (_, i) => i)),
    drumKits: new Set([0])
});

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
    setSoundFontOrder(getSoundFontOrder().filter(x => x !== id));
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

export function getSoundFontOrder() {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY_SOUNDFONT_ORDER));
        if (Array.isArray(parsed)) return parsed.filter(x => typeof x === 'string');
    } catch (_) {}
    return [];
}

export function setSoundFontOrder(ids) {
    try {
        localStorage.setItem(STORAGE_KEY_SOUNDFONT_ORDER, JSON.stringify(ids));
    } catch (_) {}
}

/** Strict mode plays each track's exact GM program only; tracks the enabled fonts lack stay silent. Off by default. */
export function getSoundFontStrict() {
    try {
        return localStorage.getItem(STORAGE_KEY_SOUNDFONT_STRICT) === '1';
    } catch (_) {
        return false;
    }
}

export function setSoundFontStrict(strict) {
    try {
        localStorage.setItem(STORAGE_KEY_SOUNDFONT_STRICT, strict ? '1' : '0');
    } catch (_) {}
}

/** Built-in plus uploads in load order: saved order first, anything unsaved after (built-in, then oldest upload first). */
export async function listOrderedSoundFonts() {
    const entries = [
        { id: BUILTIN_SOUNDFONT_ID, name: 'SONiVOX (built-in)', builtin: true },
        ...(await listSoundFonts())
    ];
    const rank = new Map(getSoundFontOrder().map((id, i) => [id, i]));
    const unsaved = entries.length;
    return entries
        .map((e, i) => ({ e, key: rank.has(e.id) ? rank.get(e.id) : unsaved + i }))
        .sort((a, b) => a.key - b.key)
        .map(({ e }) => e);
}

/**
 * Load every enabled SoundFont into an AlphaTab API in the user's order (later ones override earlier ones).
 * @returns {Promise<number>} number of SoundFonts queued
 */
export async function applySoundFontsToApi(api) {
    if (!api) return 0;
    const selected = new Set(getSelectedSoundFontIds());
    const sources = [];
    const presetSets = [];
    let hasBuiltin = false;
    for (const entry of await listOrderedSoundFonts()) {
        if (!selected.has(entry.id)) continue;
        if (entry.builtin) {
            sources.push(BUILTIN_SOUNDFONT_URL);
            presetSets.push(BUILTIN_PRESETS());
            hasBuiltin = true;
            continue;
        }
        const data = await getSoundFontData(entry.id);
        if (data) {
            const bytes = new Uint8Array(data);
            clampNegativeAttenuation(bytes);
            sources.push(bytes);
            presetSets.push(parseSoundFontPresets(data));
        }
    }
    if (sources.length === 0) {
        sources.push(BUILTIN_SOUNDFONT_URL);
        presetSets.push(BUILTIN_PRESETS());
        hasBuiltin = true;
    }
    // The built-in font alone defines every GM program, so nothing needs remapping. Layered with custom fonts it
    // counts as a full layer: each custom font above it substitutes its closest program first, so it is heard
    // instead of the built-in font merely being the only one with the exact program.
    const builtinOnly = hasBuiltin && sources.length === 1;
    api.soundFontPresets = builtinOnly || getSoundFontStrict() ? null : mergePresetSets(presetSets);
    if (applyProgramMapping(api.score, api.soundFontPresets)) api.loadMidiForScore();
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
