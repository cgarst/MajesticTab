// storage/packSync.js
// Two-way sync between this device and a store (contract.js) laid out as packs (see packStore.js, libraryDocs.js).
//
// Items are the things that move whole: a pack per song ("p:<packId>"), a SoundFont ("s:<id>"), the Classtab archive
// ("c:<id>"). Records are the small things merged field by field: collections, songs (as the index sees them), recents,
// setlists and settings. Items and records are both compared three ways: this device, the store, and a baseline saved
// after the last sync, which tells "removed since last time" from "never had it" and which side changed.
//
// Item rules, with L = this device's fingerprint, R = the store's version, B = the baseline's {l, r}:
//   both present   no baseline: merge.  L and R as in B: nothing.  Only L moved: upload.  Only R moved: download.  Both: merge.
//   only here      L as in B: removed in the store, so remove here.  L moved: edited here, removed there: upload (an edit beats a removal).
//                  no baseline: upload, unless the store's tombstone is newer than the item (removed elsewhere before this device first synced).
//   only there     R as in B: removed here, so remove there (and leave a tombstone).  R moved: download.  no baseline: download.
// "Merge" of a pack means: take the store's copy into this device (additive, the way a .mpak is added to a song), then upload
// the result if it holds something the store's copy lacks. Nothing is overwritten blindly: an upload only replaces the exact
// manifest version it was planned against, and a pack is written manifest-last, so a failure leaves the store's copy whole.
//
// `local` is the adapter for this device's data (see LocalAdapter below); `baselines` is { get(location), set(location, value), clear(location) }.
import { createPackStore } from './packStore.js';
import { readStoreInfo } from './storeInfo.js';
import { readIfExists, readJson, writeJson, updateJson, ConflictError, NotFoundError } from './contract.js';
import { toLibraryDoc, fromLibraryDoc, toProfileDoc, fromProfileDoc, portableSong, mergeSong, applyIndexToSong, LIBRARY_PATH, PROFILE_PATH } from './libraryDocs.js';
import { RECORD_ACTION, fingerprintValue, stableStringify, planRecords, TAB_SOURCES_KEY, TAB_SOURCES_DELETED_KEY, readSourceList, readTombstones, mergeSourceLists } from '../recordSync.js';

/**
 * @typedef {object} LocalAdapter   this device's data; the app's version wraps IndexedDB, tests use a fake
 * @property {() => Promise<Map<string, {kind: 'pack'|'soundfont'|'classtab', id: string, name: string, fp: string, time: number, size?: number}>>} items
 *           every item here, by key, with a cheap fingerprint that changes whenever the item's content does
 * @property {(key: string) => Promise<{files: Map<string, Uint8Array>}|{bytes: Uint8Array, name: string, size?: number, addedAt?: number}>} readItem
 *           a pack as the files of its directory form, or a blob item's bytes
 * @property {(packId: string, pack: object) => Promise<void>} applyPack     add the store's pack (a packStore.open handle) to this device, additively
 * @property {(key: string, bytes: Uint8Array, meta: object) => Promise<void>} applyBlob
 * @property {(key: string) => Promise<void>} deleteItem
 * @property {() => Promise<{library: {collections: object[], songs: object[], recents: object[], setlists: object[]}, settings: object}>} records
 * @property {(kind: string, record: object) => Promise<void>} putRecord
 * @property {(kind: string, id: string) => Promise<void>} deleteRecord
 * @property {(key: string, value: any) => Promise<void>} setSetting
 * @property {(key: string) => Promise<void>} removeSetting
 */

export const ITEM_ACTION = Object.freeze({
    UPLOAD: 'upload', DOWNLOAD: 'download', MERGE: 'merge', DELETE_LOCAL: 'delete-local', DELETE_REMOTE: 'delete-remote',
});

export const TOMBSTONES_PATH = 'tombstones.json';
const SOUNDFONT_DIR = 'soundfonts';
const CLASSTAB_DIR = 'classtab';
const PER_SONG_SETTINGS = new Set(['ytCache', 'audioSync']);

export const packKey = (id) => `p:${id}`;
export const blobPath = (key) => `${key.startsWith('s:') ? SOUNDFONT_DIR : CLASSTAB_DIR}/${key.slice(2)}`;
export const kindOfKey = (key) => (key.startsWith('p:') ? 'pack' : key.startsWith('s:') ? 'soundfont' : 'classtab');

/** One item's decision. `time` is when the item was added here, for the tombstone rule. Returns null when nothing moves. */
export function decideItem({ l, r, base, tombstoneAt = 0, time = 0 }) {
    const hasL = l !== undefined, hasR = r !== undefined;
    if (hasL && hasR) {
        if (!base) return { action: ITEM_ACTION.MERGE };
        const lc = base.l !== l, rc = base.r !== r;
        if (!lc && !rc) return null;
        if (lc && !rc) return { action: ITEM_ACTION.UPLOAD };
        if (!lc && rc) return { action: ITEM_ACTION.DOWNLOAD };
        return { action: ITEM_ACTION.MERGE, conflict: true };
    }
    if (hasL) {
        if (base) return base.l === l ? { action: ITEM_ACTION.DELETE_LOCAL } : { action: ITEM_ACTION.UPLOAD, conflict: true };
        return tombstoneAt > time ? { action: ITEM_ACTION.DELETE_LOCAL } : { action: ITEM_ACTION.UPLOAD };
    }
    if (hasR) {
        if (base) return base.r === r ? { action: ITEM_ACTION.DELETE_REMOTE } : { action: ITEM_ACTION.DOWNLOAD, conflict: true };
        return { action: ITEM_ACTION.DOWNLOAD };
    }
    return null;
}

// --- reading the store ---

async function readRemote(store) {
    const info = await readStoreInfo(store);
    if (!info) return null;
    const packs = createPackStore(store);
    const remote = new Map();
    for (const p of await packs.listPacks()) remote.set(packKey(p.packId), { kind: 'pack', id: p.packId, version: p.version, size: p.size });
    const profile = (await readIfExists(store, PROFILE_PATH)) ? fromProfileDoc(await readJson(store, PROFILE_PATH)) : { settings: {}, soundFonts: [] };
    const fontMeta = new Map(profile.soundFonts.map((f) => [f.id, f]));
    for (const [prefix, dir, kind] of [['s', SOUNDFONT_DIR, 'soundfont'], ['c', CLASSTAB_DIR, 'classtab']]) {
        for (const e of await store.list(`${dir}/`)) {
            const id = e.path.slice(dir.length + 1);
            if (id.includes('/')) continue;
            remote.set(`${prefix}:${id}`, { kind, id, version: e.version, size: e.size, name: fontMeta.get(id)?.name || id, addedAt: fontMeta.get(id)?.addedAt });
        }
    }
    const tombstones = (await readIfExists(store, TOMBSTONES_PATH)) ? await readJson(store, TOMBSTONES_PATH) : { version: 1, items: {} };
    return { remote, tombstones, profile };
}

// --- plan ---

/**
 * What a sync would do, without changing anything.
 * @returns {Promise<{ firstSync: boolean, items: Array<{key, kind, id, name, action, conflict?: boolean, size: number}>, unchanged: number, notAStore?: boolean }>}
 */
export async function planPackSync({ store, local, baselines, location, hybrid = false }) {
    const read = await readRemote(store);
    if (!read) return { notAStore: true, firstSync: true, items: [], unchanged: 0 };
    return planFrom(read, await local.items(), baselines.get(location), { hybrid });
}

function planFrom(read, mine, base, { hybrid = false } = {}) {
    const items = [];
    let unchanged = 0;
    for (const key of new Set([...mine.keys(), ...read.remote.keys()])) {
        const m = mine.get(key), r = read.remote.get(key);
        const d = decideItem({ l: m?.fp, r: r?.version, base: base?.items?.[key], tombstoneAt: read.tombstones.items?.[key]?.at || 0, time: m?.time || 0 });
        if (!d) { unchanged++; continue; }
        // In hybrid mode, SoundFonts that have never been downloaded stay remote-only until requested on demand
        if (hybrid && key.startsWith('s:') && d.action === ITEM_ACTION.DOWNLOAD) continue;
        items.push({ key, kind: (m || r).kind, id: (m || r).id, name: (m || r).name || (m || r).id, size: (m || r).size || 0, ...d });
    }
    return { firstSync: !base, items, unchanged };
}

// --- records ---

function recordMap(library, settings) {
    const records = new Map();
    const add = (key, kind, id, label, value, time) => records.set(key, { key, kind, id, label, fp: fingerprintValue(value), value, time });
    for (const c of library.collections || []) add(`col:${c.id}`, 'collection', c.id, c.name, c);
    for (const s of library.songs || []) { const v = portableSong(s); add(`song:${s.id}`, 'song', s.id, s.title, v); }
    for (const r of library.recents || []) add(`rec:${r.id}`, 'recent', r.id, r.title || r.name, r);
    for (const s of library.setlists || []) add(`sl:${s.id}`, 'setlist', s.id, s.name, s);
    for (const [k, v] of Object.entries(settings || {})) if (!PER_SONG_SETTINGS.has(k) && k !== TAB_SOURCES_KEY && k !== TAB_SOURCES_DELETED_KEY) add(`set:${k}`, 'setting', k, k, v);
    return records;
}

/**
 * Merges the library and settings with the store and applies the result here. library.json and profile.json are updated with a
 * version check, so another device writing at the same moment is re-read and merged, not overwritten.
 * @returns {Promise<{ pulled: number, pushed: number, removedHere: number, removedThere: number, conflicts: number, fps: object }>}
 */
async function syncRecords({ store, local, base, freshPackIds = new Set() }) {
    const stats = { pulled: 0, pushed: 0, removedHere: 0, removedThere: 0, conflicts: 0 };
    await renameImportedSongs({ store, local });
    const mine = await local.records();
    // A song this sync has just created from a pack has only what the pack holds. Its record here is not an edit: the store's
    // record, which carries what the pack cannot (pinned, collection, tab names), is taken instead and laid over it.
    const isFresh = (s) => freshPackIds.has(s.packId || s.id);
    const mineMap = recordMap({ ...mine.library, songs: (mine.library.songs || []).filter((s) => !isFresh(s)) }, mine.settings);
    let decisions = [], theirMap = new Map();
    const baseRecords = base?.records;

    // One document at a time would do for the remote writes; two keep each file's size down and its retries independent
    let remoteLibrary = null, remoteSettings = null;
    await updateJson(store, LIBRARY_PATH, (cur) => {
        remoteLibrary = cur ? fromLibraryDoc(cur) : { collections: [], songs: [], recents: [], setlists: [] };
        theirMap = recordMap(remoteLibrary, {});
        const libMine = new Map([...mineMap].filter(([, v]) => v.kind !== 'setting'));
        decisions = planRecords(libMine, theirMap, baseRecords, new Set());
        const out = {};
        for (const kind of ['collection', 'song', 'recent', 'setlist']) out[kind] = new Map();
        for (const [, t] of theirMap) out[t.kind].set(t.id, t.value);
        for (const d of decisions) {
            const m = mineMap.get(d.key);
            if (d.action === RECORD_ACTION.PUSH) {
                const t = theirMap.get(d.key);
                out[d.kind].set(d.id, d.kind === 'song' && d.conflict && t ? mergeSong(m.value, t.value) : m.value);
            } else if (d.action === RECORD_ACTION.DELETE_REMOTE) out[d.kind].delete(d.id);
        }
        return toLibraryDoc({
            collections: [...out.collection.values()], songs: [...out.song.values()], recents: [...out.recent.values()], setlists: [...out.setlist.values()],
        });
    });

    // Apply to this device
    const songsHere = new Map((mine.library.songs || []).map((s) => [s.id, s]));
    for (const d of decisions) {
        const t = theirMap.get(d.key);
        if (d.conflict) stats.conflicts++;
        if (d.action === RECORD_ACTION.PULL && t) {
            const value = d.kind === 'song' ? applyIndexToSong(songsHere.get(d.id) || { id: d.id, tabOptions: [] }, t.value) : t.value;
            await local.putRecord(d.kind, value);
            stats.pulled++;
        } else if (d.action === RECORD_ACTION.PUSH) {
            if (d.conflict && d.kind === 'song' && t && songsHere.has(d.id)) await local.putRecord('song', applyIndexToSong(songsHere.get(d.id), mergeSong(portableSong(songsHere.get(d.id)), t.value)));
            stats.pushed++;
        } else if (d.action === RECORD_ACTION.DELETE_LOCAL) { await local.deleteRecord(d.kind, d.id); stats.removedHere++; }
        else if (d.action === RECORD_ACTION.DELETE_REMOTE) stats.removedThere++;
    }

    // Settings, through profile.json
    const setMine = new Map([...mineMap].filter(([, v]) => v.kind === 'setting'));
    const mineSources = readSourceList(mine.settings?.[TAB_SOURCES_KEY]);
    const mineTombs = readTombstones(mine.settings?.[TAB_SOURCES_DELETED_KEY]);
    let setDecisions = [], setTheirs = new Map();
    let mergedSources = null, hadRemoteSources = false, remoteSourcesChanged = false;
    await updateJson(store, PROFILE_PATH, (cur) => {
        remoteSettings = cur ? fromProfileDoc(cur) : { settings: {}, soundFonts: [] };
        setTheirs = recordMap({}, remoteSettings.settings);
        setDecisions = planRecords(setMine, setTheirs, baseRecords, new Set());
        const next = { ...remoteSettings.settings };
        for (const d of setDecisions) {
            if (d.action === RECORD_ACTION.PUSH) next[d.id] = setMine.get(d.key).value;
            else if (d.action === RECORD_ACTION.DELETE_REMOTE) delete next[d.id];
        }
        const theirSources = readSourceList(remoteSettings.settings?.[TAB_SOURCES_KEY]);
        const theirTombs = readTombstones(remoteSettings.settings?.[TAB_SOURCES_DELETED_KEY]);
        hadRemoteSources = theirSources.length > 0 || Object.keys(theirTombs).length > 0;
        if (mineSources.length || hadRemoteSources || Object.keys(mineTombs).length) {
            mergedSources = mergeSourceLists(mineSources, theirSources, mineTombs, theirTombs);
            if (mergedSources.sources.length) next[TAB_SOURCES_KEY] = mergedSources.sources;
            else delete next[TAB_SOURCES_KEY];
            if (Object.keys(mergedSources.tombs).length) next[TAB_SOURCES_DELETED_KEY] = mergedSources.tombs;
            else delete next[TAB_SOURCES_DELETED_KEY];
            remoteSourcesChanged = stableStringify(mergedSources.sources) !== stableStringify(theirSources)
                || stableStringify(mergedSources.tombs) !== stableStringify(theirTombs);
        } else {
            mergedSources = null;
            remoteSourcesChanged = false;
        }
        return toProfileDoc({ settings: next, soundFonts: remoteSettings.soundFonts });
    });
    for (const d of setDecisions) {
        const t = setTheirs.get(d.key);
        if (d.action === RECORD_ACTION.PULL && t) { await local.setSetting(d.id, t.value); stats.pulled++; }
        else if (d.action === RECORD_ACTION.DELETE_LOCAL) { await local.removeSetting(d.id); stats.removedHere++; }
        else if (d.action === RECORD_ACTION.PUSH) stats.pushed++;
        else if (d.action === RECORD_ACTION.DELETE_REMOTE) stats.removedThere++;
    }
    if (mergedSources) {
        if (mergedSources.sources.length && stableStringify(mergedSources.sources) !== stableStringify(mineSources)) {
            await local.setSetting(TAB_SOURCES_KEY, mergedSources.sources);
            stats.pulled++;
        } else if (!mergedSources.sources.length && mineSources.length) {
            await local.removeSetting(TAB_SOURCES_KEY);
            stats.removedHere++;
        }
        if (Object.keys(mergedSources.tombs).length && stableStringify(mergedSources.tombs) !== stableStringify(mineTombs)) {
            await local.setSetting(TAB_SOURCES_DELETED_KEY, mergedSources.tombs);
        }
        if (remoteSourcesChanged) stats.pushed++;
    }

    // What the baseline should say now: the fingerprints of every record as it stands on both sides after this sync
    const after = await local.records();
    const afterMap = recordMap(after.library, after.settings);
    const fps = {};
    for (const [k, v] of afterMap) fps[k] = v.fp;
    return { ...stats, fps };
}

/**
 * A pack that came from a song whose id is not a valid pack id is imported under the pack id (mpak.js). The store's library
 * still knows that song by its own id, with the pack id beside it, so the imported song takes that id back: otherwise the
 * library would hold the song twice and sync would send the duplicate on.
 */
async function renameImportedSongs({ store, local }) {
    if (!(await readIfExists(store, LIBRARY_PATH))) return;
    const remote = fromLibraryDoc(await readJson(store, LIBRARY_PATH));
    const here = (await local.records()).library.songs || [];
    const byId = new Map(here.map((s) => [s.id, s]));
    for (const theirs of remote.songs) {
        if (!theirs.packId || theirs.packId === theirs.id || byId.has(theirs.id)) continue;
        const imported = byId.get(theirs.packId);
        if (!imported) continue;
        await local.deleteRecord('song', imported.id);
        await local.putRecord('song', { ...imported, id: theirs.id, packId: theirs.packId });
    }
}

// --- apply ---

/**
 * Runs a sync. Items first (downloads and merges, then uploads, then removals), then records, then the baseline.
 * Resolves to { uploaded, downloaded, merged, removedHere, removedThere, skipped, records, failed: [{key, reason}] }.
 * An item that fails is left as it was and not recorded in the baseline, so the next sync tries it again.
 */
export async function applyPackSync({ store, local, baselines, location, hybrid = false, onProgress = () => {} }) {
    const read = await readRemote(store);
    if (!read) throw new Error('This location is not a MajesticTab library');
    const base = baselines.get(location);
    const packs = createPackStore(store);
    const mine = await local.items();
    const plan = planFrom(read, mine, base, { hybrid }).items;
    const nextItems = { ...(base?.items || {}) };
    const out = { uploaded: 0, downloaded: 0, merged: 0, removedHere: 0, removedThere: 0, conflicts: 0, failed: [] };
    const tombstones = { version: 1, items: { ...(read.tombstones.items || {}) } };
    let tombstonesChanged = false;

    const remoteVersion = async (key) => {
        if (key.startsWith('p:')) return (await store.stat(`packs/${key.slice(2)}/manifest.json`))?.version;
        return (await store.stat(blobPath(key)))?.version;
    };
    const freshPackIds = new Set();   // packs taken in for a song this device did not have
    const needsFp = new Set();   // keys whose local fingerprint is read once, after all the work, from a single scan

    const upload = async (item, expectRemote) => {
        const data = await local.readItem(item.key);
        if (item.kind === 'pack') {
            if (hybrid && expectRemote !== undefined) await preserveRemoteAudio(packs, item.id, data);
            await packs.write(item.id, Object.fromEntries(data.files), { manifestIfVersion: expectRemote ?? null });
        } else {
            await store.write(blobPath(item.key), data.bytes, expectRemote === undefined ? { ifVersion: null } : { ifVersion: expectRemote });
            if (item.kind === 'soundfont') await updateJson(store, PROFILE_PATH, (cur) => {
                const p = cur ? fromProfileDoc(cur) : { settings: {}, soundFonts: [] };
                const list = p.soundFonts.filter((f) => f.id !== item.id);
                list.push({ id: item.id, name: data.name, size: data.size ?? data.bytes.length, addedAt: data.addedAt ?? Date.now() });
                return toProfileDoc({ settings: p.settings, soundFonts: list });
            });
        }
    };

    const download = async (item) => {
        if (item.kind === 'pack') {
            if (!mine.has(item.key)) freshPackIds.add(item.id);
            await local.applyPack(item.id, await packs.open(item.id), { includeAudio: !hybrid });
        } else if (!hybrid) {
            const meta = read.remote.get(item.key);
            await local.applyBlob(item.key, await store.read(blobPath(item.key)), { name: meta.name, size: meta.size, addedAt: meta.addedAt });
        }
    };

    const order = [ITEM_ACTION.DOWNLOAD, ITEM_ACTION.MERGE, ITEM_ACTION.UPLOAD, ITEM_ACTION.DELETE_LOCAL, ITEM_ACTION.DELETE_REMOTE];
    const sorted = [...plan].sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
    let n = 0;
    for (const item of sorted) {
        onProgress({ current: ++n, total: sorted.length, name: item.name, action: item.action });
        const rVersion = read.remote.get(item.key)?.version;
        try {
            if (item.conflict) out.conflicts++;
            if (item.action === ITEM_ACTION.DOWNLOAD) {
                await download(item);
                nextItems[item.key] = { l: undefined, r: rVersion }; needsFp.add(item.key);
                out.downloaded++;
            } else if (item.action === ITEM_ACTION.MERGE) {
                await download(item);
                // The store's copy is in here now; send the result back only if it holds something the store's copy lacks
                if (item.kind === 'pack' && await differsFromStore(local, packs, item, { hybrid })) {
                    await upload(item, rVersion);
                    nextItems[item.key] = { l: undefined, r: await remoteVersion(item.key) };
                } else nextItems[item.key] = { l: undefined, r: rVersion };
                needsFp.add(item.key);
                out.merged++;
            } else if (item.action === ITEM_ACTION.UPLOAD) {
                await upload(item, rVersion);
                nextItems[item.key] = { l: undefined, r: await remoteVersion(item.key) }; needsFp.add(item.key);
                out.uploaded++;
            } else if (item.action === ITEM_ACTION.DELETE_LOCAL) {
                await local.deleteItem(item.key);
                delete nextItems[item.key];
                out.removedHere++;
            } else if (item.action === ITEM_ACTION.DELETE_REMOTE) {
                if (item.kind === 'pack') await packs.remove(item.id); else await store.delete(blobPath(item.key));
                tombstones.items[item.key] = { at: Date.now() };
                tombstonesChanged = true;
                delete nextItems[item.key];
                out.removedThere++;
            }
        } catch (err) {
            // A conflict means another device wrote this pack since the plan: leave it for the next sync, which will merge
            out.failed.push({ key: item.key, reason: err instanceof ConflictError ? 'changed elsewhere during the sync' : err.message });
        }
    }
    if (tombstonesChanged) await updateJson(store, TOMBSTONES_PATH, (cur) => ({ version: 1, items: { ...(cur?.items || {}), ...tombstones.items } }));

    // Records go first: taking in a song's record changes the song here (tab names, hashes), and the baseline must be the
    // fingerprint of the item as it stands when this sync ends, or the next sync would see its own work as a change.
    const records = await syncRecords({ store, local, base, freshPackIds });
    const remoteNow = await readRemote(store);
    const mineNow = await local.items();
    for (const key of needsFp) if (nextItems[key]) nextItems[key].l = mineNow.get(key)?.fp;
    for (const key of Object.keys(nextItems)) if (!mineNow.has(key) && !remoteNow.remote.has(key)) delete nextItems[key];
    // Items on both sides that were never mentioned (unchanged, or first seen as equal) keep or get a baseline
    for (const key of mineNow.keys()) if (!nextItems[key] && remoteNow.remote.has(key) && !out.failed.some((f) => f.key === key)) {
        nextItems[key] = { l: mineNow.get(key).fp, r: remoteNow.remote.get(key).version };
    }

    baselines.set(location, { syncedAt: Date.now(), items: nextItems, records: records.fps });
    const { fps, ...recordStats } = records;
    return { ...out, records: recordStats };
}

/**
 * Preserves remote-only audio files when a hybrid device uploads an edited pack whose audio it never downloaded.
 */
async function preserveRemoteAudio(packs, packId, data) {
    let remote;
    try { remote = await packs.open(packId); } catch (_) { return; }
    const missing = remote.audioInfo().filter((a) => a.present && !data.files.has(a.path));
    if (!missing.length) return;
    const manifest = JSON.parse(new TextDecoder().decode(data.files.get('manifest.json')));
    manifest.entries = manifest.entries || {};
    manifest.recordings = manifest.recordings || [];
    for (const a of missing) {
        data.files.set(a.path, await remote.audio(a.path));
        if (remote.manifest.entries?.[a.path]) manifest.entries[a.path] = remote.manifest.entries[a.path];
        const rec = (remote.manifest.recordings || []).find((r) => (r.sources || []).some((s) => s.path === a.path));
        if (rec && !manifest.recordings.some((r) => r.id === rec.id)) manifest.recordings.push(rec);
    }
    data.files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
}

/**
 * Whether this device's version of a pack holds something the store's copy lacks: a score or recording source with a hash the
 * store's copy does not have, or a different set of sync files.
 */
async function differsFromStore(local, packs, item, { hybrid = false } = {}) {
    const mine = JSON.parse(new TextDecoder().decode((await local.readItem(item.key)).files.get('manifest.json')));
    const theirs = (await packs.open(item.id)).manifest;
    const hashes = (m) => new Set([
        ...(m.scores || []).flatMap((s) => [s, ...(s.alternates || [])]).map((s) => s.sha256),
        ...(m.recordings || []).flatMap((r) => (r.sources || [])
            .filter((x) => !(hybrid && x.type === 'file'))
            .map((x) => x.sha256 || x.videoId || x.type)),
    ]);
    const have = hashes(theirs);
    if ([...hashes(mine)].some((h) => !have.has(h))) return true;
    const syncs = (m) => JSON.stringify(Object.entries(m.entries || {})
        .filter(([p]) => !(hybrid && p.startsWith('audio/')))
        .map(([p, e]) => [p, e.sha256]).sort());
    return syncs(mine) !== syncs(theirs);
}

/**
 * Writes everything on this device into `store` (all packs, SoundFonts, Classtab files) without comparing: the export half of
 * an upgrade from the old layout. Files already in the store with the same size are not sent twice, so an interrupted
 * upgrade resumes. Resolves to what upgradeLocation wants: { packIds, records, settings, soundFonts }.
 */
export async function exportLocalToStore(store, local, onProgress = () => {}) {
    const packs = createPackStore(store);
    const items = [...(await local.items()).values()];
    const packIds = [], soundFonts = [];
    let n = 0;
    for (const item of items) {
        onProgress({ current: ++n, total: items.length, name: item.name });
        const key = item.kind === 'pack' ? packKey(item.id) : `${item.kind === 'soundfont' ? 's' : 'c'}:${item.id}`;
        const data = await local.readItem(key);
        if (item.kind === 'pack') {
            await packs.write(item.id, Object.fromEntries(data.files), { skipSameSize: true });
            packIds.push(item.id);
        } else {
            const existing = await store.stat(blobPath(key));
            if (!existing || existing.size !== data.bytes.length) await store.write(blobPath(key), data.bytes);
            if (item.kind === 'soundfont') soundFonts.push({ id: item.id, name: data.name, size: data.size ?? data.bytes.length, addedAt: data.addedAt ?? Date.now() });
        }
    }
    const { library, settings } = await local.records();
    return { packIds, records: library, settings, soundFonts };
}

/**
 * Records, as the baseline for `location`, that this device and the store hold the same version of every item they both
 * have. Called right after an upgrade, so the first sync does not read every pack back to compare it.
 */
export async function seedItemBaselines({ store, local, baselines, location }) {
    const read = await readRemote(store);
    if (!read) return;
    const mine = await local.items();
    const items = {};
    for (const [key, m] of mine) {
        const r = read.remote.get(key);
        if (r) items[key] = { l: m.fp, r: r.version };
    }
    baselines.set(location, { syncedAt: Date.now(), items });
}

/**
 * Replaces the store's contents with this device's library: uploads every local item (skipping same-size files),
 * overwrites library.json and profile.json with this device's state, removes any remote items not on this device
 * (recording tombstones for removed packs), and seeds the baseline so the next sync has nothing to move.
 */
export async function replaceRemoteFromLocal({ store, local, baselines, location, onProgress = () => {} }) {
    const read = await readRemote(store);
    const mine = await local.items();
    const toRemove = read ? [...read.remote.keys()].filter((k) => !mine.has(k)) : [];
    const total = mine.size + toRemove.length;
    let done = 0;

    const { packIds, records, settings, soundFonts } = await exportLocalToStore(store, local, (p) => {
        done = p.current;
        onProgress({ current: done, total, name: p.name, action: ITEM_ACTION.UPLOAD });
    });

    const packs = createPackStore(store);
    const tombstones = { version: 1, items: { ...(read?.tombstones?.items || {}) } };
    const now = Date.now();
    for (const key of toRemove) {
        const entry = read.remote.get(key);
        onProgress({ current: ++done, total, name: entry?.name || key, action: ITEM_ACTION.DELETE_REMOTE });
        if (key.startsWith('p:')) {
            await packs.remove(key.slice(2));
            tombstones.items[key] = { at: now };
        } else {
            await store.delete(blobPath(key));
        }
    }

    await writeJson(store, LIBRARY_PATH, toLibraryDoc(records));
    await writeJson(store, PROFILE_PATH, toProfileDoc({ settings, soundFonts }));
    await writeJson(store, TOMBSTONES_PATH, tombstones);

    const remoteNow = await readRemote(store);
    const items = {};
    for (const [key, m] of mine) {
        const r = remoteNow?.remote.get(key);
        if (r) items[key] = { l: m.fp, r: r.version };
    }
    const fps = {};
    for (const [k, v] of recordMap(records, settings)) fps[k] = v.fp;
    baselines.set(location, { syncedAt: now, items, records: fps });
    return { uploaded: packIds.length, removedThere: toRemove.length };
}
