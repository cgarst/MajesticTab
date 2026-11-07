// syncEngine.js
// Two-way sync between this device and the newest incremental snapshot (see incrementalBackup.js).
// Tabs, SoundFonts and audio files are compared three ways: this device, the snapshot, and a baseline saved after
// the last sync. The baseline tells "deleted since last sync" apart from "never had it", and which
// side changed an item. Library entries merge without losing anything, and settings only fill gaps.
// Applying a plan pulls remote changes into this device, then pushes the result as a new snapshot.
// Audio files only ever add: sync never deletes one from this device, because a file kept out of the backup on
// one device would otherwise disappear from the others. Audio this device chose not to download stays in the
// snapshot (it is carried into the next one).
import { getAllStoredFiles, deleteStoredFile, putStoredFileRecord } from './fileStore.js';
import { getAllSongs, getAllLibraryData, importLibraryData, removeTabOptionFromSong, putLibraryRecord, deleteLibraryRecord } from './libraryStore.js';
import { listSoundFonts, deleteSoundFont, restoreSoundFontEntry } from './soundFontStore.js';
import { CLASSTAB_BACKUP_STORE, isClasstabItem, classtabFingerprint, listClasstab, restoreClasstabEntry, deleteClasstab } from './classtab/backup.js';
import { mergeAudioSync, AUDIO_SYNC_PREFIX } from './audioSync/syncStore.js';
import { listAudioFiles } from './audioSync/audioFileStore.js';
import {
    listAudioForBackup, restoreAudioEntry, isAudioItem, isAudioDownloadEnabled, audioItemFingerprint, audioSyncDecision
} from './audioSync/audioBackup.js';
import {
    collectAllSettings, applyRestoredSettings, applyRestoredPreferences
} from './backupRestore.js';
import { RECORD_ACTION, fingerprintValue, planRecords, describeRecords } from './recordSync.js';
import {
    listIncrementalBackups, loadIncrementalBundle, createIncrementalBackup, fileFingerprint, soundFontFingerprint, runPool, itemKey
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

function saveSyncBase(backend, items, records) {
    try {
        localStorage.setItem(BASE_KEY, JSON.stringify({ location: locationKey(backend), syncedAt: Date.now(), items, records }));
    } catch (_) {}
}

export function clearSyncBase() {
    try { localStorage.removeItem(BASE_KEY); } catch (_) {}
}

// --- item views ---

const fileKey = (id) => `f:${id}`;
const soundFontKey = (id) => `s:${id}`;
const audioKey = (id) => `a:${id}`;
const classtabKey = (id) => `c:${id}`;
const keyOf = (item) => (item.kind === 'tab' ? fileKey(item.id) : item.kind === 'audio' ? audioKey(item.id) : item.kind === 'classtab' ? classtabKey(item.id) : soundFontKey(item.id));

function localItems(fileMetas, soundFonts, audioMetas = [], classtabMetas = []) {
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
    for (const m of classtabMetas) {
        items.set(classtabKey(m.id), {
            kind: 'classtab', id: m.id, name: m.name, size: m.size || 0,
            fingerprint: classtabFingerprint(m), time: m.addedAt || 0
        });
    }
    for (const m of audioMetas) {
        items.set(audioKey(m.id), {
            kind: 'audio', id: m.id, name: m.name, size: m.size || 0,
            fingerprint: audioItemFingerprint(m), time: m.savedAt || 0
        });
    }
    return items;
}

function remoteItems(manifest) {
    const items = new Map();
    for (const f of manifest?.files || []) {
        if (!f.blob) continue;
        if (isAudioItem(f)) {
            items.set(audioKey(f.id), {
                kind: 'audio', id: f.id, name: f.name, size: f.size || 0,
                fingerprint: audioItemFingerprint(f), time: f.savedAt || 0
            });
        } else if (isClasstabItem(f)) {
            items.set(classtabKey(f.id), {
                kind: 'classtab', id: f.id, name: f.name, size: f.size || 0,
                fingerprint: classtabFingerprint(f), time: f.addedAt || 0
            });
        } else if (f.store) {
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
 *   changes: Array<{action: string, kind: 'tab'|'soundfont'|'audio', id: string, key: string, name: string, size: number,
 *     reason: string, conflict?: boolean}>,
 *   other: {receive: Array<{kind: string, text: string}>, send: Array<{kind: string, text: string}>},
 *   unchanged: number, bytesUp: number, bytesDown: number, needsPush: boolean
 * }>}
 */
// The downloader's source list is written on first use, so "fill gaps" would never bring in sources
// added on another device. It merges by id instead: the copy with the newer updatedAt wins, and a
// deletion (a tombstone with its time) wins over any copy that was last edited before it.
const TAB_SOURCES_KEY = 'majestictab_tab_sources';
const TAB_SOURCES_DELETED_KEY = 'majestictab_tab_sources_deleted';

function readSourceList(value) {
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return []; }
    }
    return Array.isArray(value) ? value.filter(s => s && s.id) : [];
}

function readTombstones(value) {
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return {}; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function mergeSourceLists(mine, theirs, mineTombs, theirTombs) {
    const tombs = { ...theirTombs };
    for (const [id, at] of Object.entries(mineTombs)) tombs[id] = Math.max(Number(tombs[id]) || 0, Number(at) || 0);
    const theirById = new Map(theirs.map(x => [x.id, x]));
    const mineIds = new Set(mine.map(x => x.id));
    const sources = [];
    for (const x of [...mine, ...theirs.filter(t => !mineIds.has(t.id))]) {
        const other = theirById.get(x.id);
        const pick = other && mineIds.has(x.id) && (other.updatedAt || 0) > (x.updatedAt || 0) ? other : x;
        if (!pick.isSeed && (Number(tombs[pick.id]) || 0) > (pick.updatedAt || 0)) continue;
        sources.push(pick);
    }
    return { sources, tombs };
}

/** What moving from one source list to another adds, changes and removes, by id. */
function diffSourceLists(from, to) {
    const fromById = new Map(from.map(x => [x.id, x]));
    const toIds = new Set(to.map(x => x.id));
    let added = 0, changed = 0;
    for (const x of to) {
        if (!fromById.has(x.id)) added++;
        else if (!sameValue(fromById.get(x.id), x)) changed++;
    }
    return { added, changed, removed: from.filter(x => !toIds.has(x.id)).length };
}

function describeSourceDiff(d) {
    const parts = [];
    if (d.added) parts.push(`${d.added} added`);
    if (d.changed) parts.push(`${d.changed} edited`);
    if (d.removed) parts.push(`${d.removed} removed`);
    return parts.length ? `tab sources ${parts.join(', ')}` : '';
}

function sameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// --- records: settings, collections, songs, recents and setlists ---

const SETTING_SPECIAL = new Set([TAB_SOURCES_KEY, TAB_SOURCES_DELETED_KEY, 'audioSync']);

/**
 * Key, kind, label, fingerprint and value for each record a backup carries other than files. The tab source list
 * and audio sync records merge by their own rules (see fillMissingPreferences), so they are not here.
 * `present` names the kinds the source actually holds: a snapshot from an older version lacks some.
 */
/** A readable name for a sync point record from its storage key: the song, as it was written in the key. */
function syncPointLabel(key) {
    const m = /^audio_sync_(?:share_)?(.*?)(?:_(?:yt|local)_[^_]*)?$/.exec(key);
    try { return m ? decodeURIComponent(m[1]) : ''; } catch { return m ? m[1] : ''; }
}

function recordViews({ settings, library }) {
    const records = new Map();
    const present = new Set();
    const add = (key, kind, id, label, value, time) => records.set(key, { key, kind, id, label, fp: fingerprintValue(value), value, time });

    if (settings && typeof settings === 'object') {
        present.add('setting');
        for (const [key, val] of Object.entries(settings)) {
            if (SETTING_SPECIAL.has(key)) continue;
            if ((key === 'ytCache' || key === 'gpTabStrings') && val && typeof val === 'object') {
                const prefix = key === 'ytCache' ? 'yt' : 'gts';
                for (const [name, v] of Object.entries(val)) add(`${prefix}:${name}`, 'setting', name, '', v);
            } else {
                add(`set:${key}`, 'setting', key, key, val);
            }
        }
        // Audio sync points: one record per song and recording, so a change shows in the plan and moves by itself
        present.add('syncpoints');
        if (settings.audioSync && typeof settings.audioSync === 'object') {
            for (const [key, val] of Object.entries(settings.audioSync)) {
                if (!key.startsWith(AUDIO_SYNC_PREFIX)) continue;
                add(`sp:${key}`, 'syncpoints', key, syncPointLabel(key), val, Number.isFinite(val?.updatedAt) ? val.updatedAt : undefined);
            }
        }
    }
    const lib = library || {};
    const groups = [['collections', 'collection', 'col', c => c.name], ['songs', 'song', 'song', x => x.title || x.name],
        ['recents', 'recent', 'rec', x => x.title || x.name || x.fileName], ['setlists', 'setlist', 'sl', x => x.name]];
    for (const [field, kind, prefix, labelOf] of groups) {
        if (!Array.isArray(lib[field])) continue;
        present.add(kind);
        for (const x of lib[field]) if (x && x.id) add(`${prefix}:${x.id}`, kind, x.id, labelOf(x) || '', x);
    }
    return { records, present };
}

async function localRecordViews() {
    return recordViews({ settings: collectAllSettings(), library: await getAllLibraryData() });
}

/** The records that apply would move, in each direction, with what each one does. */
function compareRecords(manifest, local, base) {
    const theirs = recordViews({ settings: manifest?.settings, library: manifest?.library });
    const skip = new Set(['setting', 'syncpoints', 'collection', 'song', 'recent', 'setlist'].filter(k => !theirs.present.has(k)));
    const records = planRecords(local.records, theirs.records, base, skip).map(({ value, ...d }) => d);
    return { records, other: describeRecords(records) };
}

function localKeyOf(key) {
    if (key.startsWith('set:')) return key.slice(4);
    if (key.startsWith('yt:')) return key.slice(3);
    if (key.startsWith('gts:')) return key.slice(4);
    if (key.startsWith('sp:')) return key.slice(3);
    return key;
}

/** Carry out the record decisions of a plan on this device. Returns how many records changed here. */
async function applyRecordDecisions(bundle, decisions, droppedFileIds) {
    const theirs = recordViews({ settings: bundle.settings, library: bundle.library }).records;
    let changed = 0;
    for (const d of decisions) {
        const t = theirs.get(d.key);
        if (d.kind === 'syncpoints') {
            if (d.action === RECORD_ACTION.PULL && t) {
                mergeAudioSync({ [localKeyOf(d.key)]: t.value }, { wipe: true });
                changed++;
            } else if (d.action === RECORD_ACTION.DELETE_LOCAL) {
                localStorage.removeItem(localKeyOf(d.key));
                changed++;
            }
            continue;
        }
        if (d.kind === 'setting') {
            if (d.action === RECORD_ACTION.PULL && t) {
                if (d.key.startsWith('yt:') || d.key.startsWith('gts:')) localStorage.setItem(localKeyOf(d.key), String(t.value));
                else applyRestoredSettings({ [localKeyOf(d.key)]: t.value }, { wipe: false });
                changed++;
            } else if (d.action === RECORD_ACTION.DELETE_LOCAL) {
                localStorage.removeItem(localKeyOf(d.key));
                changed++;
            }
            continue;
        }
        if (d.action === RECORD_ACTION.PULL && t) {
            let value = t.value;
            if (d.kind === 'song') {
                // Tabs removed on this device are still in the snapshot's songs until the new snapshot replaces it
                const original = value.tabOptions || [];
                const kept = original.filter(x => !droppedFileIds.has(x.fileStoreId));
                if (original.length && !kept.length) continue;
                value = { ...value, tabOptions: kept };
            }
            await putLibraryRecord(d.kind, value);
            changed++;
        } else if (d.action === RECORD_ACTION.DELETE_LOCAL) {
            await deleteLibraryRecord(d.kind, d.id);
            changed++;
        } else if (d.action === RECORD_ACTION.PUSH && d.conflict && d.kind === 'song' && t) {
            // Changed on both sides: this device's copy stays, and tabs only the snapshot has are added to it
            const original = t.value.tabOptions || [];
            const kept = original.filter(x => !droppedFileIds.has(x.fileStoreId));
            if (kept.length) await importLibraryData({ songs: [{ ...t.value, tabOptions: kept }] }, { wipe: false });
        }
    }
    return changed;
}

export async function planSync(backend, onStatus) {
    const say = (text) => { if (typeof onStatus === 'function') onStatus(text); };
    say('Reading this device\'s library and listing snapshots...');
    const [backups, fileMetas, soundFonts, audioMetas, classtabMetas] = await Promise.all([
        listIncrementalBackups(backend),
        getAllStoredFiles(),
        listSoundFonts(),
        listAudioForBackup(),
        listClasstab()
    ]);
    const local = localItems(fileMetas, soundFonts, audioMetas, classtabMetas);
    const downloadAudio = isAudioDownloadEnabled();
    const latest = backups[0] ? { name: backups[0].name, exportedAt: backups[0].exportedAt } : null;
    say(latest ? `Downloading the latest snapshot (${backups.length} found)...` : 'No snapshot found; this is a first sync.');
    const manifest = latest ? await backend.readManifest(backups[0]) : null;
    say('Comparing tabs, SoundFonts, audio files and settings...');
    const remote = latest ? remoteItems(manifest) : new Map();
    const savedBase = getSyncBase();
    const base = savedBase?.location === locationKey(backend) ? savedBase.items : null;
    const recordBase = base ? (savedBase.records || {}) : null;
    const { records, other } = latest ? compareRecords(manifest, await localRecordViews(), recordBase) : { records: [], other: { receive: [], send: [] } };

    const changes = [];
    let unchanged = 0;
    const add = (action, item, reason, extra = {}) => changes.push({
        action, kind: item.kind, id: item.id, key: keyOf(item),
        name: item.name, size: item.size, reason, ...extra
    });

    for (const key of new Set([...local.keys(), ...remote.keys()])) {
        const mine = local.get(key);
        const theirs = remote.get(key);
        const was = base ? base[key] : undefined;

        if ((mine || theirs).kind === 'audio') {
            const decision = audioSyncDecision(mine, theirs, was, downloadAudio);
            if (!decision) unchanged++;
            else add(decision.action, decision.action === SYNC_ACTION.UPLOAD ? mine : theirs, decision.reason, decision.conflict ? { conflict: true } : {});
            continue;
        }

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
        records,
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

function fillMissingPreferences(manifest) {
    // ytCache and gpTabStrings fill in by key, audio sync points are records (applyRecordDecisions)
    const settings = {};
    const theirSources = readSourceList(manifest.settings?.[TAB_SOURCES_KEY]);
    const theirTombs = readTombstones(manifest.settings?.[TAB_SOURCES_DELETED_KEY]);
    if (theirSources.length || Object.keys(theirTombs).length) {
        const merged = mergeSourceLists(
            readSourceList(localStorage.getItem(TAB_SOURCES_KEY)), theirSources,
            readTombstones(localStorage.getItem(TAB_SOURCES_DELETED_KEY)), theirTombs
        );
        if (merged.sources.length) settings[TAB_SOURCES_KEY] = merged.sources;
        settings[TAB_SOURCES_DELETED_KEY] = merged.tombs;
    }
    applyRestoredSettings(settings, { wipe: false });
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

    const result = { recordsChanged: 0, downloaded: 0, uploaded: 0, removedLocal: 0, removedRemote: 0, bytesSent: 0, pushed: false };
    const of = (action) => plan.changes.filter(c => c.action === action);
    const downloads = of(SYNC_ACTION.DOWNLOAD);
    let carryForward = [];

    if (plan.latest) {
        const bundle = await loadIncrementalBundle(backend, newest);
        const remoteById = new Map((bundle.files || []).map(f => [itemKey(f), f]));

        let done = 0;
        await runPool(downloads, DOWNLOAD_CONCURRENCY, async (change) => {
            const item = remoteById.get(change.key);
            if (item) {
                if (change.kind === 'audio') {
                    await restoreAudioEntry(item, { wipe: true });
                } else if (change.kind === 'classtab') {
                    await restoreClasstabEntry(item, { wipe: true });
                } else if (change.kind === 'soundfont') {
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

        // Audio this device doesn't hold (it chose not to download it) stays in the snapshot it pushes next
        const heldAudio = new Set((await listAudioFiles()).map(m => m.id));
        const leaving = new Set(of(SYNC_ACTION.DELETE_REMOTE).filter(c => c.kind === 'audio').map(c => c.id));
        carryForward = (bundle.files || []).filter(f => isAudioItem(f) && !heldAudio.has(f.id) && !leaving.has(f.id));

        for (const change of of(SYNC_ACTION.DELETE_LOCAL)) {
            if (change.kind === 'soundfont') await deleteSoundFont(change.id);
            else if (change.kind === 'classtab') await deleteClasstab();
            else await removeLocalTab(change.id);
            result.removedLocal++;
        }

        const droppedFileIds = new Set(of(SYNC_ACTION.DELETE_REMOTE).filter(c => c.kind === 'tab').map(c => c.id));
        result.recordsChanged = await applyRecordDecisions(bundle, plan.records || [], droppedFileIds);
        fillMissingPreferences(bundle);
    }

    if (plan.needsPush) {
        const pushed = await createIncrementalBackup(backend, {
            carryForward,
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
    const settled = localItems(await getAllStoredFiles(), await listSoundFonts(), await listAudioForBackup(), await listClasstab());
    const settledRecords = (await localRecordViews()).records;
    saveSyncBase(backend, Object.fromEntries([...settled].map(([key, item]) => [key, item.fingerprint])),
        Object.fromEntries([...settledRecords].map(([key, r]) => [key, r.fp])));
    return result;
}

// --- replace the remote with this device ---

/**
 * What replacing the sync location with this device would do, without changing anything. Nothing is received:
 * the next snapshot is this device's library as it is, so whatever only the old snapshot holds is left out of it.
 * Older snapshots stay in the location until its own pruning removes them.
 * @returns {Promise<{latest: object|null, changes: Array, unchanged: number, lost: {tabs: number, soundfonts: number, audio: number, records: number}, sending: number}>}
 */
export async function planReplaceRemote(backend, onStatus) {
    const say = (text) => { if (typeof onStatus === 'function') onStatus(text); };
    say('Reading this device\'s library and listing snapshots...');
    const [backups, fileMetas, soundFonts, audioMetas, classtabMetas] = await Promise.all([
        listIncrementalBackups(backend), getAllStoredFiles(), listSoundFonts(), listAudioForBackup(), listClasstab()
    ]);
    const local = localItems(fileMetas, soundFonts, audioMetas, classtabMetas);
    const latest = backups[0] ? { name: backups[0].name, exportedAt: backups[0].exportedAt } : null;
    say(latest ? 'Reading the latest snapshot...' : 'No snapshot found.');
    const manifest = latest ? await backend.readManifest(backups[0]) : null;
    const remote = latest ? remoteItems(manifest) : new Map();

    const changes = [];
    let unchanged = 0;
    for (const key of new Set([...local.keys(), ...remote.keys()])) {
        const mine = local.get(key);
        const theirs = remote.get(key);
        const item = mine || theirs;
        const entry = { kind: item.kind, id: item.id, key, name: item.name, size: item.size };
        if (mine && theirs) {
            if (mine.fingerprint === theirs.fingerprint) unchanged++;
            else changes.push({ ...entry, action: SYNC_ACTION.UPLOAD, reason: 'Differs from the snapshot; this device\'s copy is kept' });
        } else if (mine) changes.push({ ...entry, action: SYNC_ACTION.UPLOAD, reason: 'Not in the snapshot' });
        else changes.push({ ...entry, action: SYNC_ACTION.DELETE_REMOTE, reason: 'Only in the snapshot; it will be left out' });
    }
    changes.sort((a, b) => (a.action === b.action ? 0 : a.action === SYNC_ACTION.DELETE_REMOTE ? -1 : 1) || a.name.localeCompare(b.name));

    const lostItems = changes.filter(c => c.action === SYNC_ACTION.DELETE_REMOTE);
    let records = 0;
    if (latest) {
        const theirs = recordViews({ settings: manifest.settings, extensions: manifest.extensions, library: manifest.library });
        const mine = await localRecordViews();
        for (const [key, r] of theirs.records) if (!mine.records.has(key) && mine.present.has(r.kind)) records++;
    }
    return {
        latest, changes, unchanged,
        sending: changes.length - lostItems.length,
        lost: {
            tabs: lostItems.filter(c => c.kind === 'tab').length,
            soundfonts: lostItems.filter(c => c.kind === 'soundfont').length,
            audio: lostItems.filter(c => c.kind === 'audio').length,
            records
        }
    };
}

/**
 * Save this device's library as the new snapshot and make it the baseline, receiving nothing.
 * @returns {Promise<{uploaded: number, bytesSent: number, removedRemote: number}>}
 */
export async function applyReplaceRemote(backend, plan, onProgress) {
    const report = (phase, current, total, text) => { if (typeof onProgress === 'function') onProgress({ phase, current, total, text }); };
    const newest = (await listIncrementalBackups(backend))[0] || null;
    if ((newest?.name || null) !== (plan.latest?.name || null)) {
        throw new Error('The backup changed while you were reviewing. Start again to see the updated changes.');
    }
    const pushed = await createIncrementalBackup(backend, {
        carryForward: [],
        onProgress: ({ phase, current, total, name }) => report(
            'push', current, total,
            phase === 'manifest' ? 'Saving the new snapshot' : name ? `Sending ${name}` : 'Checking what the backup already holds'
        )
    });
    const settled = localItems(await getAllStoredFiles(), await listSoundFonts(), await listAudioForBackup(), await listClasstab());
    const settledRecords = (await localRecordViews()).records;
    saveSyncBase(backend, Object.fromEntries([...settled].map(([key, item]) => [key, item.fingerprint])),
        Object.fromEntries([...settledRecords].map(([key, r]) => [key, r.fp])));
    return {
        uploaded: pushed.uploaded, bytesSent: pushed.bytesSent,
        removedRemote: plan.changes.filter(c => c.action === SYNC_ACTION.DELETE_REMOTE).length
    };
}
