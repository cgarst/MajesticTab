// syncEngine.js
// Two-way sync between this device and the newest incremental snapshot (see incrementalBackup.js).
// Tabs and SoundFonts are compared three ways: this device, the snapshot, and a baseline saved after
// the last sync. The baseline tells "deleted since last sync" apart from "never had it", and which
// side changed an item. Library entries merge without losing anything, and settings only fill gaps.
// Applying a plan pulls remote changes into this device, then pushes the result as a new snapshot.
import { getAllStoredFiles, deleteStoredFile, putStoredFileRecord } from './fileStore.js';
import { getAllSongs, getAllLibraryData, importLibraryData, removeTabOptionFromSong } from './libraryStore.js';
import { listSoundFonts, deleteSoundFont, restoreSoundFontEntry } from './soundFontStore.js';
import {
    collectAllSettings, collectExtensions, applyRestoredSettings, applyRestoredExtensions, applyRestoredPreferences
} from './backupRestore.js';
import {
    listIncrementalBackups, loadIncrementalBundle, createIncrementalBackup, fileFingerprint, soundFontFingerprint, runPool
} from './incrementalBackup.js';

const BASE_KEY = 'majestictab_sync_base';
const DOWNLOAD_CONCURRENCY = 3;

export const SYNC_ACTION = {
    UPLOAD: 'upload',
    DOWNLOAD: 'download',
    DELETE_LOCAL: 'delete-local',
    DELETE_REMOTE: 'delete-remote'
};

const locationKey = (backend) => `${backend.label}|${backend.location}`;

// --- baseline from the last completed sync ---

export function getSyncBase() {
    try { return JSON.parse(localStorage.getItem(BASE_KEY)) || null; } catch (_) { return null; }
}

function saveSyncBase(backend, items) {
    try {
        localStorage.setItem(BASE_KEY, JSON.stringify({ location: locationKey(backend), syncedAt: Date.now(), items }));
    } catch (_) {}
}

export function clearSyncBase() {
    try { localStorage.removeItem(BASE_KEY); } catch (_) {}
}

// --- item views ---

const fileKey = (id) => `f:${id}`;
const soundFontKey = (id) => `s:${id}`;

function localItems(fileMetas, soundFonts) {
    const items = new Map();
    for (const m of fileMetas) {
        items.set(fileKey(m.id), {
            kind: 'tab', id: m.id, name: m.name, size: m.size || 0,
            fingerprint: fileFingerprint(m), time: Math.max(m.savedAt || 0, m.lastModified || 0)
        });
    }
    for (const m of soundFonts) {
        items.set(soundFontKey(m.id), {
            kind: 'soundfont', id: m.id, name: m.name, size: m.size || 0,
            fingerprint: soundFontFingerprint(m), time: m.addedAt || 0
        });
    }
    return items;
}

function remoteItems(manifest) {
    const items = new Map();
    for (const f of manifest?.files || []) {
        if (!f.blob) continue;
        if (f.store) {
            items.set(soundFontKey(f.id), {
                kind: 'soundfont', id: f.id, name: f.name, size: f.size || 0,
                fingerprint: soundFontFingerprint(f), time: f.addedAt || 0
            });
        } else {
            items.set(fileKey(f.id), {
                kind: 'tab', id: f.id, name: f.name, size: f.size || 0,
                fingerprint: fileFingerprint(f), time: Math.max(f.savedAt || 0, f.lastModified || 0)
            });
        }
    }
    return items;
}

// --- plan ---

/**
 * Compare this device with the newest snapshot in `backend` without changing anything.
 * @returns {Promise<{
 *   latest: {name: string, exportedAt: string}|null, firstSync: boolean, lastSyncedAt: number|null,
 *   changes: Array<{action: string, kind: 'tab'|'soundfont', id: string, key: string, name: string, size: number,
 *     reason: string, conflict?: boolean}>,
 *   other: {receive: Array<{kind: string, text: string}>, send: Array<{kind: string, text: string}>},
 *   unchanged: number, bytesUp: number, bytesDown: number, needsPush: boolean
 * }>}
 */
function sameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Library entries, settings and extensions that apply would move, in each direction. Library and
 * extensions merge by id and settings only fill gaps here, so a setting that differs on both sides
 * keeps this device's value and goes to the snapshot with the next push.
 */
function compareOther(manifest, localLibrary) {
    const out = { receive: [], send: [] };
    const label = (kind, n) => `${n} ${kind}${n === 1 ? '' : 's'}`;

    const sides = (kind, mine, theirs, idOf) => {
        const mineIds = new Set(mine.map(idOf));
        const theirIds = new Set(theirs.map(idOf));
        const gain = theirs.filter(x => !mineIds.has(idOf(x))).length;
        const lose = mine.filter(x => !theirIds.has(idOf(x))).length;
        if (gain) out.receive.push({ kind, text: `${label(kind, gain)} new in the snapshot` });
        if (lose) out.send.push({ kind, text: `${label(kind, lose)} new on this device` });
    };
    const remoteLib = manifest?.library || {};
    sides('song', localLibrary.songs || [], remoteLib.songs || [], x => x?.id);
    sides('collection', localLibrary.collections || [], remoteLib.collections || [], x => x?.id);
    sides('extension', collectExtensions(), manifest?.extensions || [], x => x?.id);

    const mineSettings = collectAllSettings();
    const theirSettings = manifest?.settings || {};
    const names = (list) => list.slice(0, 6).join(', ') + (list.length > 6 ? `, +${list.length - 6} more` : '');
    const gain = [], lose = [], differ = [];
    for (const key of new Set([...Object.keys(mineSettings), ...Object.keys(theirSettings)])) {
        if (key === 'ytCache' || key === 'gpTabStrings') continue;
        const has = key in mineSettings;
        const there = key in theirSettings;
        if (there && !has) gain.push(key);
        else if (has && !there) lose.push(key);
        else if (!sameValue(mineSettings[key], theirSettings[key])) differ.push(key);
    }
    if (gain.length) out.receive.push({ kind: 'setting', text: `${label('setting', gain.length)} from the snapshot: ${names(gain)}` });
    if (lose.length) out.send.push({ kind: 'setting', text: `${label('setting', lose.length)} new on this device: ${names(lose)}` });
    if (differ.length) {
        out.send.push({ kind: 'setting', text: `${label('setting', differ.length)} differ from the snapshot; this device's values are kept: ${names(differ)}` });
    }
    return out;
}

export async function planSync(backend, onStatus) {
    const say = (text) => { if (typeof onStatus === 'function') onStatus(text); };
    say('Reading this device\'s library and listing snapshots...');
    const [backups, fileMetas, soundFonts] = await Promise.all([
        listIncrementalBackups(backend),
        getAllStoredFiles(),
        listSoundFonts()
    ]);
    const local = localItems(fileMetas, soundFonts);
    const latest = backups[0] ? { name: backups[0].name, exportedAt: backups[0].exportedAt } : null;
    say(latest ? `Downloading the latest snapshot (${backups.length} found)...` : 'No snapshot found; this is a first sync.');
    const manifest = latest ? await backend.readManifest(backups[0]) : null;
    say('Comparing tabs, SoundFonts and settings...');
    const remote = latest ? remoteItems(manifest) : new Map();
    const other = latest ? compareOther(manifest, await getAllLibraryData()) : { receive: [], send: [] };

    const savedBase = getSyncBase();
    const base = savedBase?.location === locationKey(backend) ? savedBase.items : null;

    const changes = [];
    let unchanged = 0;
    const add = (action, item, reason, extra = {}) => changes.push({
        action, kind: item.kind, id: item.id, key: item.kind === 'tab' ? fileKey(item.id) : soundFontKey(item.id),
        name: item.name, size: item.size, reason, ...extra
    });

    for (const key of new Set([...local.keys(), ...remote.keys()])) {
        const mine = local.get(key);
        const theirs = remote.get(key);
        const was = base ? base[key] : undefined;

        if (mine && theirs) {
            if (mine.fingerprint === theirs.fingerprint) { unchanged++; continue; }
            const changedHere = was !== mine.fingerprint;
            const changedThere = was !== theirs.fingerprint;
            if (changedHere && !changedThere) add(SYNC_ACTION.UPLOAD, mine, 'Changed on this device');
            else if (changedThere && !changedHere) add(SYNC_ACTION.DOWNLOAD, theirs, 'Changed in the snapshot');
            else if (mine.time >= theirs.time) add(SYNC_ACTION.UPLOAD, mine, 'Changed in both places; this device is newer', { conflict: true });
            else add(SYNC_ACTION.DOWNLOAD, theirs, 'Changed in both places; the snapshot is newer', { conflict: true });
        } else if (mine) {
            if (was === undefined) add(SYNC_ACTION.UPLOAD, mine, 'New on this device');
            else if (was === mine.fingerprint) add(SYNC_ACTION.DELETE_LOCAL, mine, 'Removed in the snapshot since the last sync');
            else add(SYNC_ACTION.UPLOAD, mine, 'Changed here after it was removed from the snapshot; keeping it', { conflict: true });
        } else {
            if (was === undefined) add(SYNC_ACTION.DOWNLOAD, theirs, 'New in the snapshot');
            else if (was === theirs.fingerprint) add(SYNC_ACTION.DELETE_REMOTE, theirs, 'Removed from this device since the last sync');
            else add(SYNC_ACTION.DOWNLOAD, theirs, 'Changed in the snapshot after it was removed here; keeping it', { conflict: true });
        }
    }

    const sum = (action) => changes.filter(c => c.action === action).reduce((acc, c) => acc + c.size, 0);
    const order = { [SYNC_ACTION.DELETE_LOCAL]: 0, [SYNC_ACTION.DELETE_REMOTE]: 1, [SYNC_ACTION.DOWNLOAD]: 2, [SYNC_ACTION.UPLOAD]: 3 };
    changes.sort((a, b) => order[a.action] - order[b.action] || a.name.localeCompare(b.name));

    return {
        latest,
        firstSync: !base,
        lastSyncedAt: base ? savedBase.syncedAt : null,
        changes,
        unchanged,
        other,
        bytesUp: sum(SYNC_ACTION.UPLOAD),
        bytesDown: sum(SYNC_ACTION.DOWNLOAD),
        // Uploads and snapshot-side removals only exist in a new snapshot; a new device also needs its first one
        needsPush: !latest || other.send.length > 0 || changes.some(c => c.action === SYNC_ACTION.UPLOAD || c.action === SYNC_ACTION.DELETE_REMOTE)
    };
}

// --- apply ---

async function removeLocalTab(id) {
    // Take the tab off its songs first so none is left pointing at a missing file
    for (const song of await getAllSongs()) {
        for (const tab of song.tabOptions || []) {
            if (tab.fileStoreId === id) await removeTabOptionFromSong(song.id, tab.id);
        }
    }
    await deleteStoredFile(id);
}

function mergeRemoteLibrary(library, droppedFileIds) {
    if (!library) return Promise.resolve();
    // Tabs removed on this device are still in the snapshot's library until the new snapshot replaces it
    const songs = [];
    for (const song of library.songs || []) {
        const original = song.tabOptions || [];
        const kept = original.filter(t => !droppedFileIds.has(t.fileStoreId));
        if (original.length && !kept.length) continue;
        songs.push({ ...song, tabOptions: kept });
    }
    return importLibraryData({ ...library, songs }, { wipe: false });
}

function fillMissingPreferences(manifest) {
    const settings = {};
    for (const [key, val] of Object.entries(manifest.settings || {})) {
        // ytCache and gpTabStrings are per-key maps that the restore code already fills without overwriting
        if (key === 'ytCache' || key === 'gpTabStrings' || localStorage.getItem(key) === null) settings[key] = val;
    }
    applyRestoredSettings(settings, { wipe: false });
    const known = new Set(collectExtensions().map(e => e.id));
    applyRestoredExtensions((manifest.extensions || []).filter(e => e && !known.has(e.id)), { wipe: false });
    applyRestoredPreferences();
}

/**
 * Carry out a plan from planSync: pull the snapshot's changes into this device, then save the
 * combined result as a new snapshot when this device has something to add.
 * @param {object} backend
 * @param {object} plan From planSync
 * @param {function({phase: string, current: number, total: number, text: string}): void} [onProgress]
 * @returns {Promise<{downloaded: number, uploaded: number, removedLocal: number, removedRemote: number, bytesSent: number, pushed: boolean}>}
 */
export async function applySync(backend, plan, onProgress) {
    const report = (phase, current, total, text) => { if (typeof onProgress === 'function') onProgress({ phase, current, total, text }); };

    // Someone else may have synced while the plan was on screen
    const newest = (await listIncrementalBackups(backend))[0] || null;
    if ((newest?.name || null) !== (plan.latest?.name || null)) {
        throw new Error('The backup changed while you were reviewing. Sync again to see the updated changes.');
    }

    const result = { downloaded: 0, uploaded: 0, removedLocal: 0, removedRemote: 0, bytesSent: 0, pushed: false };
    const of = (action) => plan.changes.filter(c => c.action === action);
    const downloads = of(SYNC_ACTION.DOWNLOAD);

    if (plan.latest) {
        const bundle = await loadIncrementalBundle(backend, newest);
        const remoteById = new Map((bundle.files || []).map(f => [f.store ? soundFontKey(f.id) : fileKey(f.id), f]));

        let done = 0;
        await runPool(downloads, DOWNLOAD_CONCURRENCY, async (change) => {
            const item = remoteById.get(change.key);
            if (item) {
                if (change.kind === 'soundfont') {
                    await restoreSoundFontEntry(item, { wipe: true });
                } else {
                    const data = await item.fetchData();
                    await putStoredFileRecord({
                        id: item.id,
                        name: item.name,
                        type: item.type || 'application/octet-stream',
                        size: item.size || data.byteLength,
                        providerId: item.providerId || 'imported',
                        metadata: item.metadata || {},
                        data,
                        savedAt: item.savedAt || Date.now(),
                        lastModified: item.lastModified || Date.now()
                    });
                }
                result.downloaded++;
            }
            report('pull', ++done, downloads.length, `Receiving ${change.name}`);
        });

        for (const change of of(SYNC_ACTION.DELETE_LOCAL)) {
            if (change.kind === 'soundfont') await deleteSoundFont(change.id);
            else await removeLocalTab(change.id);
            result.removedLocal++;
        }

        const droppedFileIds = new Set(of(SYNC_ACTION.DELETE_REMOTE).filter(c => c.kind === 'tab').map(c => c.id));
        await mergeRemoteLibrary(bundle.library, droppedFileIds);
        fillMissingPreferences(bundle);
    }

    if (plan.needsPush) {
        const pushed = await createIncrementalBackup(backend, {
            onProgress: ({ phase, current, total, name }) => report(
                'push', current, total,
                phase === 'manifest' ? 'Saving the new snapshot' : name ? `Sending ${name}` : 'Checking what the backup already holds'
            )
        });
        result.pushed = true;
        result.uploaded = pushed.uploaded;
        result.bytesSent = pushed.bytesSent;
    }
    result.removedRemote = of(SYNC_ACTION.DELETE_REMOTE).length;

    // The baseline is whatever this device holds now, which matches the snapshot after a push or pull
    const settled = localItems(await getAllStoredFiles(), await listSoundFonts());
    saveSyncBase(backend, Object.fromEntries([...settled].map(([key, item]) => [key, item.fingerprint])));
    return result;
}
