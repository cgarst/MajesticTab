// storage/libraryDocs.js
// The two small documents that sit beside the packs in a sync store, and the functions that move data between them
// and the app's records. Nothing here touches IndexedDB or a store; callers pass records in and get records out.
//
//   library.json   what a pack cannot hold: collections, recents, setlists, and for each song the fields the pack has no
//                  place for (pinned, addedAt, lastOpenedAt, collection, default tab, hidden tunings, cover, per-tab provenance).
//                  It also carries the pack's own fields (title, artist ...), as a copy, so the library lists without
//                  opening a pack. The pack stays the authority for those: rebuildSongsFromPacks reads them back from it.
//   profile.json   settings and the SoundFont list. Per-song settings that packs carry (recordings, sync points) are left out.
//
// Both have a `format` and a `version`. A reader refuses a newer version and keeps fields it does not know, so an older app
// does not strip what a newer one wrote. Device-local ids (file store ids, Drive file ids) never leave the device.

import { updateJson, readIfExists, readJson } from './contract.js';

export const LIBRARY_FORMAT = 'majestictab_library';
export const PROFILE_FORMAT = 'majestictab_profile';
export const DOC_VERSION = 1;

const TAB_LOCAL_FIELDS = ['fileStoreId', 'driveFileId'];
const SETTING_KEYS_IN_PACKS = ['ytCache', 'audioSync'];

export class DocError extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkEnvelope(doc, format) {
    if (!isObject(doc) || doc.format !== format) throw new DocError(`Not a ${format} document`);
    if (typeof doc.version !== 'number' || doc.version < 1) throw new DocError('Missing version');
    if (doc.version > DOC_VERSION) throw new DocError(`This ${format} document is from a newer version of MajesticTab (v${doc.version})`);
}

// --- library.json ---

/** A tab as the index keeps it: no ids that only mean something on this device. */
export function portableTab(tab) {
    const out = { ...tab };
    for (const k of TAB_LOCAL_FIELDS) delete out[k];
    return out;
}

/** A song as the index keeps it. `packId` is the folder of its pack; a song whose id is a valid pack id is its own pack. */
export function portableSong(song) {
    const out = { ...song, tabOptions: (song.tabOptions || []).map(portableTab) };
    if (out.packId == null) delete out.packId;
    return out;
}

/** @param {{collections?: object[], songs?: object[], recents?: object[], setlists?: object[]}} data  what getAllLibraryData returns */
export function toLibraryDoc(data, { now = Date.now() } = {}) {
    return {
        format: LIBRARY_FORMAT, version: DOC_VERSION, updatedAt: now,
        collections: (data.collections || []).map((c) => ({ ...c })),
        songs: (data.songs || []).map(portableSong),
        recents: (data.recents || []).map((r) => ({ ...r })),
        setlists: (data.setlists || []).map((s) => ({ ...s })),
    };
}

export function libraryDocErrors(doc) {
    const errors = [];
    try { checkEnvelope(doc, LIBRARY_FORMAT); } catch (e) { return [e.message]; }
    for (const kind of ['collections', 'songs', 'recents', 'setlists']) {
        if (doc[kind] === undefined) continue;
        if (!Array.isArray(doc[kind])) { errors.push(`${kind} must be a list`); continue; }
        const seen = new Set();
        doc[kind].forEach((rec, i) => {
            if (!isObject(rec) || typeof rec.id !== 'string' || !rec.id) errors.push(`${kind}[${i}] has no id`);
            else if (seen.has(rec.id)) errors.push(`${kind}: duplicate id ${rec.id}`);
            else seen.add(rec.id);
        });
    }
    return errors;
}

/** Validates and returns the records, with fields this version does not know left in place. Throws DocError. */
export function fromLibraryDoc(doc) {
    const errors = libraryDocErrors(doc);
    if (errors.length) throw new DocError(errors.join('; '));
    return {
        collections: doc.collections || [], songs: (doc.songs || []).map((s) => ({ ...s, tabOptions: Array.isArray(s.tabOptions) ? s.tabOptions : [] })),
        recents: doc.recents || [], setlists: doc.setlists || [],
    };
}

const union = (a = [], b = []) => [...new Set([...a, ...b])];

/**
 * Two versions of one song, changed on both sides since they were last the same. Never loses a tab: the tabs of both are
 * kept (ours win on the same id), as are both lists of tunings and the later open time. Everything else is ours.
 */
export function mergeSong(mine, theirs) {
    const tabs = new Map();
    for (const t of theirs.tabOptions || []) tabs.set(t.id, t);
    for (const t of mine.tabOptions || []) tabs.set(t.id, t);
    const merged = {
        ...theirs, ...mine,
        tabOptions: [...tabs.values()],
        tunings: union(mine.tunings, theirs.tunings),
        hiddenTunings: union(mine.hiddenTunings, theirs.hiddenTunings),
        lastOpenedAt: Math.max(mine.lastOpenedAt || 0, theirs.lastOpenedAt || 0) || null,
        addedAt: Math.min(mine.addedAt || Infinity, theirs.addedAt || Infinity) === Infinity ? null : Math.min(mine.addedAt || Infinity, theirs.addedAt || Infinity),
    };
    if (!tabs.has(merged.defaultTabId)) merged.defaultTabId = merged.tabOptions[0]?.id ?? null;
    return merged;
}

const tabFromScore = (s, createdAt) => ({
    id: s.id, name: s.label || s.path?.split('/').pop() || s.externalPath?.split('/').pop() || 'Tab', providerId: 'local',
    relativePath: s.path || s.externalPath || '', tuning: s.tuning || null, tunings: s.tuning ? [s.tuning] : [], tuningSource: s.tuning ? 'user' : null,
    stringCount: null, fileType: s.format, startPage: Number.isInteger(s.startPage) ? s.startPage : null,
    endPage: Number.isInteger(s.endPage) ? s.endPage : null, isAlbumRange: false, isDefault: false,
    sourceUrl: null, sourceWebsite: null, sha256: s.sha256 || null, addedAt: createdAt,
});

/**
 * A song record from a pack's manifest alone: the way back to a library when library.json is missing or damaged, and the way
 * a pack that someone dropped into the folder (or edited there) joins the library. `packId` is the folder name.
 */
export function songFromManifest(packId, manifest, { collectionId = 'default', now = Date.now() } = {}) {
    const m = manifest.song || {};
    const created = Date.parse(manifest.createdAt) || now;
    const scores = (manifest.scores || []);
    const tabs = scores.flatMap((s) => [s, ...(s.alternates || [])]).map((s) => tabFromScore(s, created));
    if (tabs[0]) tabs[0].isDefault = true;
    return {
        id: packId, packId: manifest.id === packId ? null : packId, collectionId,
        title: m.title || 'Untitled Song', artist: m.artist || 'Unknown Artist', artistMbid: m.artistMbid || null,
        album: m.album || 'Unknown Album', albumMbid: m.albumMbid || null, year: m.year ?? null, length: m.length ?? null,
        trackNumber: m.trackNumber ?? null, mediumNumber: m.mediumNumber || 1, mediumTitle: null, mediumFormat: null,
        recordingMbid: m.recordingMbid || null, coverUrl: null, tunings: [], hiddenTunings: [], stringCount: null,
        tabOptions: tabs, defaultTabId: tabs[0]?.id ?? null, pinned: false, isCustom: false, folderPath: null,
        isAlbumTabContainer: false, addedAt: created, lastOpenedAt: null,
    };
}

/**
 * Brings a library document in line with the packs actually in the store.
 * @param doc   a library doc (or null)
 * @param packs [{ packId, manifest }]  the packs found
 * @returns {{ doc, added: string[], orphaned: string[] }}  songs added from packs the index did not know; songs whose pack is not there
 * Nothing is removed: a song whose pack is absent may be remote-only or still uploading, so it is reported, not dropped.
 */
export function reconcileLibrary(doc, packs, { now = Date.now() } = {}) {
    const base = doc ? fromLibraryDoc(doc) : { collections: [], songs: [], recents: [], setlists: [] };
    const known = new Set(base.songs.map((s) => s.packId || s.id));
    const have = new Set(packs.map((p) => p.packId));
    const added = [];
    const songs = [...base.songs];
    for (const { packId, manifest } of packs) {
        if (known.has(packId)) continue;
        songs.push(songFromManifest(packId, manifest, { now }));
        added.push(packId);
    }
    const orphaned = base.songs.filter((s) => !have.has(s.packId || s.id)).map((s) => s.id);
    return { doc: toLibraryDoc({ ...base, songs }, { now }), added, orphaned };
}

/**
 * A song the app made from a pack (saveMpakToLibrary) with what library.json says about it laid over it: the index's
 * fields win, the tabs are the index's tabs, each given the stored file the imported tab of the same score has. Tabs the
 * pack has and the index lacks are kept. Tabs match by score hash, then by id, then by name.
 * @param imported  the song record as the import left it (its tabs carry this device's fileStoreId)
 * @param indexed   the song record from library.json
 */
export function applyIndexToSong(imported, indexed) {
    const have = [...(imported.tabOptions || [])];
    const take = (pred) => { const i = have.findIndex(pred); return i < 0 ? null : have.splice(i, 1)[0]; };
    const tabs = (indexed.tabOptions || []).map((t) => {
        const match = (t.sha256 && take((h) => h.sha256 === t.sha256)) || take((h) => h.id === t.id) || take((h) => h.name === t.name);
        return { ...t, fileStoreId: match?.fileStoreId ?? null, driveFileId: null };
    });
    const out = { ...imported, ...indexed, id: imported.id, tabOptions: [...tabs, ...have] };
    if (!out.tabOptions.some((t) => t.id === out.defaultTabId)) out.defaultTabId = out.tabOptions[0]?.id ?? null;
    return out;
}

// --- profile.json ---

/**
 * @param settings   what collectAllSettings returns
 * @param soundFonts [{ id, name, size, addedAt, sha256? }]  the list, never the bytes
 */
export function toProfileDoc({ settings = {}, soundFonts = [] } = {}, { now = Date.now() } = {}) {
    const kept = Object.fromEntries(Object.entries(settings).filter(([k]) => !SETTING_KEYS_IN_PACKS.includes(k)));
    return {
        format: PROFILE_FORMAT, version: DOC_VERSION, updatedAt: now, settings: kept,
        soundFonts: soundFonts.map(({ id, name, size, addedAt, sha256 }) => ({ id, name, size, addedAt, ...(sha256 ? { sha256 } : {}) })),
    };
}

export function fromProfileDoc(doc) {
    checkEnvelope(doc, PROFILE_FORMAT);
    if (doc.settings !== undefined && !isObject(doc.settings)) throw new DocError('settings must be an object');
    return { settings: doc.settings || {}, soundFonts: Array.isArray(doc.soundFonts) ? doc.soundFonts : [] };
}

/** Settings only fill gaps: a key this device already has is kept. Returns the keys to write. */
export function settingsToFill(local, remote) {
    return Object.fromEntries(Object.entries(remote).filter(([k]) => !(k in local)));
}

// --- on a store ---

export const LIBRARY_PATH = 'library.json';
export const PROFILE_PATH = 'profile.json';
const EMPTY = () => ({ collections: [], songs: [], recents: [], setlists: [] });

/** The library records in the store, or empty ones when there is no library.json yet. */
export async function readLibrary(store) {
    return (await readIfExists(store, LIBRARY_PATH)) ? fromLibraryDoc(await readJson(store, LIBRARY_PATH)) : EMPTY();
}

/**
 * Changes the library in the store. `change(records)` returns the new records. Two devices doing this at once do not
 * overwrite each other: the second one's write is refused, it reads the first one's result and applies `change` again.
 */
export function updateLibrary(store, change, options) {
    return updateJson(store, LIBRARY_PATH, async (current) => toLibraryDoc(await change(current ? fromLibraryDoc(current) : EMPTY())), options);
}
