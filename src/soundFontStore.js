// soundFontStore.js
// Persistent store and selection for user-supplied SoundFonts (.sf2 / .sf3).
// Any number can be enabled at once; AlphaTab layers them in load order, so later ones override earlier ones.
import { parseSoundFontPresets, mergePresetSets, applyProgramMapping, GM_PROGRAM_NAMES } from './soundFontProgramMap.js';
import { clampNegativeAttenuation, convertStereoSamplesToMono } from './soundFontSanitize.js';
import { hasSupporter } from './channel.js';
import { getDB, STORE_SOUNDFONTS, arrayBufferToBase64Async, arrayBufferToBase64, base64ToArrayBuffer } from './fileStore.js';

export const BUILTIN_SOUNDFONT_ID = 'builtin';
export const BUILTIN_SOUNDFONT_URL = 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/soundfont/sonivox.sf2';
export const STORAGE_KEY_SOUNDFONT_SELECTION = 'majestictab_soundfont_selection';
export const STORAGE_KEY_SOUNDFONT_ORDER = 'majestictab_soundfont_order';
export const STORAGE_KEY_SOUNDFONT_STRICT = 'majestictab_soundfont_strict';
export const STORAGE_KEY_SOUNDFONT_FORCED = 'majestictab_soundfont_forced';
export const SOUNDFONT_BACKUP_STORE = 'soundfonts';

const changeListeners = new Set();
const emitChange = () => changeListeners.forEach(cb => { try { cb(); } catch (_) {} });

/** Subscribe to changes of the enabled set, its order or strict mode (not to uploads alone). */
export function onSoundFontSelectionChange(cb) {
    changeListeners.add(cb);
    return () => changeListeners.delete(cb);
}

// A Jam client plays the host's SoundFonts instead of its own selection while following.
// { fonts: [{ builtin: true } | { name, data: ArrayBuffer }], strict } in load order, or null.
let sessionSoundFonts = null;

export function setSessionSoundFonts(next) {
    sessionSoundFonts = next || null;
}

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
    setSelectedSoundFontIds(getSavedSoundFontIds().filter(x => x !== id));
    setSoundFontOrder(getSoundFontOrder().filter(x => x !== id));
}

export async function clearAllSoundFonts() {
    await request('readwrite', s => s.clear());
}

/** The user's saved selection, whatever the entitlement. Defaults to the built-in SONiVOX font; never empty. */
export function getSavedSoundFontIds() {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY_SOUNDFONT_SELECTION));
        if (Array.isArray(parsed) && parsed.length > 0) return parsed.filter(x => typeof x === 'string');
    } catch (_) {}
    return [BUILTIN_SOUNDFONT_ID];
}

/** Enabled ids in effect: the saved selection for Supporters, otherwise just the built-in font (uploads stay saved). */
export function getSelectedSoundFontIds() {
    return hasSupporter() ? getSavedSoundFontIds() : [BUILTIN_SOUNDFONT_ID];
}

export function setSelectedSoundFontIds(ids) {
    const next = ids.length > 0 ? ids : [BUILTIN_SOUNDFONT_ID];
    try {
        localStorage.setItem(STORAGE_KEY_SOUNDFONT_SELECTION, JSON.stringify(next));
    } catch (_) {}
    emitChange();
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
    emitChange();
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
    emitChange();
}

/**
 * Forced preset: every non-percussion track plays this one bank-0 program of one uploaded font.
 * @returns {{id:string, program:number}|null}
 */
export function getForcedPreset() {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY_SOUNDFONT_FORCED));
        if (parsed && typeof parsed.id === 'string' && Number.isInteger(parsed.program)) {
            return { id: parsed.id, program: parsed.program };
        }
    } catch (_) {}
    return null;
}

export function setForcedPreset(forced) {
    try {
        if (forced) localStorage.setItem(STORAGE_KEY_SOUNDFONT_FORCED, JSON.stringify({ id: forced.id, program: forced.program }));
        else localStorage.removeItem(STORAGE_KEY_SOUNDFONT_FORCED);
    } catch (_) {}
    emitChange();
}

/** Bank-0 presets of a font (General MIDI names for the built-in one), sorted by program: [{program, name}]. */
export async function listSoundFontPresets(id) {
    if (id === BUILTIN_SOUNDFONT_ID) return GM_PROGRAM_NAMES.map((name, program) => ({ program, name }));
    const data = await getSoundFontData(id);
    if (!data) return [];
    const { names } = parseSoundFontPresets(data);
    return [...names].map(([program, name]) => ({ program, name })).sort((a, b) => a.program - b.program);
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

/** Enabled SoundFonts in load order, without their data: what a Jam host tells its clients to play. */
export async function describeActiveSoundFonts() {
    const selected = new Set(getSelectedSoundFontIds());
    const sizes = new Map((await listSoundFonts()).map(f => [f.id, f.size]));
    const fonts = [];
    for (const entry of await listOrderedSoundFonts()) {
        if (!selected.has(entry.id)) continue;
        fonts.push(entry.builtin
            ? { id: entry.id, name: entry.name, builtin: true }
            : { id: entry.id, name: entry.name, size: sizes.get(entry.id) || 0 });
    }
    if (fonts.length === 0) fonts.push({ id: BUILTIN_SOUNDFONT_ID, name: 'SONiVOX (built-in)', builtin: true });
    const forced = getForcedPreset();
    const forcedIndex = forced ? fonts.findIndex(f => f.id === forced.id) : -1;
    return {
        fonts,
        strict: getSoundFontStrict(),
        forced: forcedIndex >= 0 ? { index: forcedIndex, program: forced.program } : null
    };
}

/**
 * Load every enabled SoundFont into an AlphaTab API in the user's order (later ones override earlier ones).
 * @returns {Promise<number>} number of SoundFonts queued
 */
export async function applySoundFontsToApi(api) {
    if (!api) return 0;
    let sources = [];
    let presetSets = [];
    const ids = []; // parallel to sources: store id (own selection) or index (Jam session), to find the forced font
    let hasBuiltin = false;
    const addBuiltin = (key) => {
        sources.push(BUILTIN_SOUNDFONT_URL);
        presetSets.push(BUILTIN_PRESETS());
        ids.push(key);
        hasBuiltin = true;
    };
    const addData = (data, key) => {
        const bytes = new Uint8Array(data.slice(0));
        clampNegativeAttenuation(bytes);
        convertStereoSamplesToMono(bytes);
        sources.push(bytes);
        presetSets.push(parseSoundFontPresets(data));
        ids.push(key);
    };
    let strict = getSoundFontStrict();
    let forced = null; // { key, program }
    if (sessionSoundFonts) {
        strict = Boolean(sessionSoundFonts.strict);
        sessionSoundFonts.fonts.forEach((font, i) => {
            if (font.builtin) addBuiltin(i); else addData(font.data, i);
        });
        if (sessionSoundFonts.forced) forced = { key: sessionSoundFonts.forced.index, program: sessionSoundFonts.forced.program };
    } else {
        const own = getForcedPreset();
        if (own) forced = { key: own.id, program: own.program };
        const selected = new Set(getSelectedSoundFontIds());
        for (const entry of await listOrderedSoundFonts()) {
            if (!selected.has(entry.id)) continue;
            if (entry.builtin) { addBuiltin(entry.id); continue; }
            const data = await getSoundFontData(entry.id);
            if (data) addData(data, entry.id);
        }
    }
    if (sources.length === 0) addBuiltin(BUILTIN_SOUNDFONT_ID);
    // The forced font goes on top so its preset wins over any other font defining the same program.
    const forcedAt = forced ? ids.indexOf(forced.key) : -1;
    if (forcedAt >= 0 && !(forcedAt === sources.length - 1)) {
        const move = (arr) => arr.push(arr.splice(forcedAt, 1)[0]);
        move(sources); move(presetSets); move(ids);
    }
    // The built-in font alone defines every GM program, so nothing needs remapping. Layered with custom fonts it
    // counts as a full layer: each custom font above it substitutes its closest program first, so it is heard
    // instead of the built-in font merely being the only one with the exact program.
    const builtinOnly = hasBuiltin && sources.length === 1;
    if (forcedAt >= 0) {
        api.soundFontPresets = { ...mergePresetSets(presetSets), forcedProgram: forced.program };
    } else {
        api.soundFontPresets = builtinOnly || strict ? null : mergePresetSets(presetSets);
    }
    if (applyProgramMapping(api.score, api.soundFontPresets)) api.loadMidiForScore();
    // AlphaTab stacks fonts in the order they finish loading, and a URL resolves after raw bytes, which would put
    // the built-in font on top of everything. Resolve every source to bytes first so the user's order holds.
    const resolved = await Promise.all(sources.map(async src => {
        if (typeof src !== 'string') return src;
        const res = await fetch(src);
        if (!res.ok) throw new Error(`SoundFont download failed (${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
    }));
    resolved.forEach((src, i) => api.loadSoundFont(src, i > 0));
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
    // `fetchData` backs incremental Drive backups, which carry a blob reference instead of base64
    const data = item.fetchData ? await item.fetchData() : base64ToArrayBuffer(item.dataBase64);
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
