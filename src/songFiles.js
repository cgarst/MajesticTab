// songFiles.js
// Everything a library song holds, in one list: its tabs, audio files, YouTube videos and sync points, with where each one
// came from, when it was added and whether this device holds it. And the two things that can be done to a row: delete it
// (with every reference to it) and move it to another song (the sync points travel with their audio or video).
//
// A song's audio, videos and sync points are not filed under the song's id. They hang off song keys ("Artist - Title", plus the
// names its tabs were opened under, see songKey.js and audioSync/libraryAudio.js), so this module reads every key the song owns,
// leaves out a key another song remembers too, and writes a moved item under the target song's own key. No DOM.

import { getSongById, removeTabOptionFromSong, moveTabOptionToSong } from './libraryStore.js';
import { getStoredFileRecord, getStoredFile } from './fileStore.js';
import { sha256 } from './mpak/core/index.js';
import { retargetSetlistTab } from './setlistStore.js';
import { songKeyFor } from './songKey.js';
import { songTagKeys } from './songLibraryTags.js';
import { slotFileKey, slotSourceKey } from './audioSync/slotKeys.js';
import {
    songAudioKeys, keysOfOtherSongs, readLibraryAudio, forgetLibraryAudio, attachLibraryAudioAlternate,
} from './audioSync/libraryAudio.js';
import { listAudioFiles, recordRemovedAudio, getAudioMeta, unlinkAudioFile, linkAudioFile, relinkAudioFile, deleteAudioFile, getAudioFile } from './audioSync/audioFileStore.js';
import { listRecords, deleteRecord, storageKey, SYNC_CHANGED_EVENT } from './audioSync/syncStore.js';
import { recordStorage } from './audioSync/syncRecordStore.js';
import { listRecordingMeta, setRecordingMeta, forgetRecordingMeta } from './audioSync/recordingMeta.js';
import { stemsOfMeta, stemSetName } from './audioSync/stemSet.js';
import { listHistory, forgetVideo, rememberVideo } from './audioSync/videoHistory.js';

const SLOTS = ['original', 'backing'];
const SLOT_LABEL = { original: 'Original', backing: 'Backing' };
const enc = (k) => encodeURIComponent(String(k).toLowerCase());
const lower = (k) => String(k).toLowerCase();
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* optional */ } };
const drop = (k) => { try { localStorage.removeItem(k); } catch { /* optional */ } };
const lastKey = (k) => `audio_file_last_${enc(k)}`;
const trackKey = (k, slot) => `yt_track_${enc(k)}_${slot}`;

const PROVIDER_LABEL = {
    local: 'A file on this device', 'google-drive': 'Google Drive', 'icloud-drive': 'iCloud Drive', s3: 'S3', webdav: 'WebDAV',
    url: 'A web address', 'web-search': 'Web search', pack: 'A music pack',
};

/** The keys a song owns: its own names and its tabs' names, less any key another song remembers too. */
export function ownKeysOf(song) {
    const others = keysOfOtherSongs(song.id);
    const seen = new Set();
    const out = [];
    for (const k of [...songTagKeys(song), ...songAudioKeys(song)]) {
        if (!k || others.has(lower(k)) || seen.has(lower(k))) continue;
        seen.add(lower(k));
        out.push(k);
    }
    return out;
}

const mediaOfId = (mk) => (mk.startsWith('yt_') ? { kind: 'youtube', videoId: mk.slice(3) } : { kind: 'local', audioId: mk.slice('local_'.length) });

function notify() {
    try {
        window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
        window.dispatchEvent(new CustomEvent('audiofiles:changed'));
        window.dispatchEvent(new CustomEvent('majestictab:data-changed'));
    } catch { /* no window */ }
}

// --- Listing ---------------------------------------------------------------------------------------------------------

async function tabRows(song) {
    const rows = [];
    for (const t of song.tabOptions || []) {
        let location = 'device';
        let size = null;
        if (t.fileStoreId) {
            const rec = await getStoredFileRecord(t.fileStoreId).catch(() => null);
            if (rec) size = rec.size ?? null; else location = 'cloud';
        }
        const source = t.sourceWebsite || (t.sourceUrl ? 'A web address' : '') || PROVIDER_LABEL[t.providerId] || t.providerId || 'A file on this device';
        rows.push({
            kind: 'tab', id: t.id, name: t.name || 'Tab', source, addedAt: t.addedAt || null, location, size,
            libraryPath: t.relativePath || '',
            detail: t.variantOf ? 'Part of a set' : (t.origin ? `Set: ${t.origin}` : ''),
        });
    }
    return rows;
}

/** Stem sets (a lead and its parts) are one audio row; their files are not listed again on their own. */
function stemGroups(keys) {
    const groups = [];
    const inSet = new Set();
    for (const k of keys) {
        for (const [mk, m] of Object.entries(listRecordingMeta(k) || {})) {
            const parts = stemsOfMeta(m);
            if (!parts || !mk.startsWith('local_')) continue;
            const ids = [...new Set([mk.slice('local_'.length), ...parts.map((s) => s.audioId)])];
            ids.forEach((id) => inSet.add(id));
            groups.push({ key: k, mk, ids, label: m.label, count: parts.length, setName: stemSetName(m) });
        }
    }
    return { groups, inSet };
}

/**
 * The recordings the song plays now: for each key and slot, the one the slot's source names (a file, a video, or the file's own
 * audio, which is no recording of its own). Returns a Map from a media key (`local_<id>`, `yt_<id>`) to the slots it is selected for.
 */
function selectedMedia(keys) {
    const out = new Map();
    const pick = (mk, slot) => { if (!out.has(mk)) out.set(mk, new Set()); out.get(mk).add(slot); };
    for (const k of keys) for (const slot of SLOTS) {
        const src = read(slotSourceKey(k, slot));
        const file = read(slotFileKey(k, slot));
        const yt = read(trackKey(k, slot));
        if (src === 'embedded') continue;
        if (src === 'youtube' ? yt : (!file && !src && yt)) pick(`yt_${yt}`, slot);
        else if (file) pick(`local_${file}`, slot);
    }
    return out;
}

const selectedByMedia = (selected, m) => {
    const mk = m.kind === 'youtube' ? `yt_${m.videoId}` : `local_${m.audioId}`;
    return selected.has(mk) ? slotsText(selected.get(mk)) : '';
};
const slotsText = (slots) => [...slots].map((s) => SLOT_LABEL[s]).join(' and ');

async function audioRows(song, keys, selected) {
    const lowerKeys = new Set(keys.map(lower));
    const metas = new Map((await listAudioFiles()).map((m) => [m.id, m]));
    const slotsOf = new Map();
    const note = (id, slot) => {
        if (!id) return;
        if (!slotsOf.has(id)) slotsOf.set(id, new Set());
        if (slot) slotsOf.get(id).add(slot);
    };
    for (const m of metas.values()) if ((m.songKeys || []).some((k) => lowerKeys.has(lower(k)))) note(m.id);
    for (const e of readLibraryAudio(song.id)) note(e.audioId, e.slot);
    for (const k of keys) for (const slot of SLOTS) {
        const id = read(slotFileKey(k, slot));
        if (id && read(slotSourceKey(k, slot)) !== 'youtube') note(id, slot);
    }
    const { groups, inSet } = stemGroups(keys);
    const rows = [];
    for (const [id, slots] of slotsOf) {
        if (inSet.has(id)) continue;
        const m = metas.get(id);
        const rm = keys.map((k) => listRecordingMeta(k)[`local_${id}`]).find(Boolean);
        const role = rm?.label || (slots.size ? [...slots].map((s) => SLOT_LABEL[s]).join(' and ') : rm?.role || '');
        rows.push({
            kind: 'audio', id, ids: [id], name: m?.name || 'Audio file (not on this device)',
            source: m?.generatedFrom ? 'Made in MajesticTab' : 'An audio file', addedAt: m?.savedAt || null,
            location: m ? 'device' : 'cloud', size: m?.size ?? null, detail: role,
            selected: selected.has(`local_${id}`) ? slotsText(selected.get(`local_${id}`)) : '',
        });
    }
    for (const g of groups) {
        const present = await Promise.all(g.ids.map((id) => getAudioMeta(id).catch(() => null)));
        const have = present.filter(Boolean);
        rows.push({
            kind: 'audio', id: g.mk, ids: g.ids, name: g.label || `${g.count} stems`,
            source: 'A set of stems', addedAt: have.length ? Math.min(...have.map((m) => m.savedAt || Infinity)) : null,
            location: have.length === g.ids.length ? 'device' : have.length ? 'partial' : 'cloud',
            size: have.reduce((n, m) => n + (m.size || 0), 0) || null, detail: g.setName || `${g.count} stems`,
            selected: slotsText(new Set(g.ids.flatMap((id) => [...(selected.get(`local_${id}`) || [])]))),
        });
    }
    return rows;
}

function videoAndSyncRows(song, keys, selected) {
    const videos = new Map();
    const noteVideo = (id, patch) => {
        if (!id) return;
        const v = videos.get(id) || { slots: new Set(), last: 0, label: '' };
        if (patch.slot) v.slots.add(patch.slot);
        v.last = Math.max(v.last, patch.last || 0);
        if (patch.label && !v.label) v.label = patch.label;
        videos.set(id, v);
    };
    const sync = [];
    for (const k of keys) {
        for (const slot of SLOTS) {
            noteVideo(read(trackKey(k, slot)), { slot });
            for (const h of listHistory(k, slot)) noteVideo(h.videoId, { last: h.lastUsedAt });
        }
        for (const rec of listRecords(k)) {
            const m = rec.media;
            if (m.kind === 'youtube') noteVideo(m.videoId, { last: rec.updatedAt, label: m.label });
            const forName = m.kind === 'youtube' ? (m.label || `YouTube video ${m.videoId}`) : (m.name || 'Audio file');
            sync.push({
                kind: 'sync', id: `${k}\u0000${m.kind === 'youtube' ? `yt_${m.videoId}` : `local_${m.audioId}`}`, key: k, media: m,
                name: `${rec.points.length} sync ${rec.points.length === 1 ? 'point' : 'points'}`, detail: `For ${forName}`,
                source: m.kind === 'youtube' ? 'YouTube video' : 'Audio file', addedAt: rec.updatedAt || null, location: 'device', size: null,
                selected: selectedByMedia(selected, m),
            });
        }
    }
    const videoRows = [...videos].map(([id, v]) => ({
        kind: 'youtube', id, ids: [id], name: v.label || `YouTube video ${id}`, source: 'YouTube', addedAt: v.last || null,
        location: 'link', size: null, detail: '',
        selected: selected.has(`yt_${id}`) ? slotsText(selected.get(`yt_${id}`)) : '',
    }));
    return { videoRows, sync };
}

/**
 * `{ tabs, audio, videos, sync }`: rows of `{ kind, id, name, source, addedAt, location, size, detail }`. An audio, video or sync
 * row also has `selected`: the slots ("Original", "Backing") it is selected for now, or '' when the song does not play it.
 */
export async function listSongFiles(song) {
    const keys = ownKeysOf(song);
    const selected = selectedMedia(keys);
    const [tabs, audio] = await Promise.all([tabRows(song), audioRows(song, keys, selected)]);
    const { videoRows, sync } = videoAndSyncRows(song, keys, selected);
    sync.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return { tabs, audio, videos: videoRows.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)), sync };
}

// --- Deleting --------------------------------------------------------------------------------------------------------

function dropRecords(keys, wanted) {
    for (const k of keys) for (const rec of listRecords(k)) if (wanted(rec.media)) deleteRecord(k, rec.media);
}

async function deleteAudio(song, row) {
    const keys = ownKeysOf(song);
    const lowerKeys = new Set(keys.map(lower));
    for (const id of row.ids) {
        for (const k of keys) {
            for (const slot of SLOTS) {
                if (read(slotFileKey(k, slot)) !== id) continue;
                drop(slotFileKey(k, slot));
                if (read(slotSourceKey(k, slot)) === 'local') drop(slotSourceKey(k, slot));
            }
            if (read(lastKey(k)) === id) drop(lastKey(k));
            forgetRecordingMeta(k, { kind: 'local', audioId: id });
        }
        dropRecords(keys, (m) => m.kind === 'local' && m.audioId === id);
        forgetLibraryAudio(song.id, id);
        const meta = await getAudioMeta(id).catch(() => null);
        for (const sk of meta?.songKeys || []) if (lowerKeys.has(lower(sk))) await unlinkAudioFile(id, sk);
        // A file no song key links any more is deleted by unlinkAudioFile; one that was never linked is deleted here
        const left = await getAudioMeta(id).catch(() => null);
        if (left && !(left.songKeys || []).length) await deleteAudioFile(id);
    }
}

function deleteVideo(song, row) {
    const id = row.id;
    const keys = ownKeysOf(song);
    for (const k of keys) {
        for (const slot of SLOTS) {
            if (read(trackKey(k, slot)) === id) {
                drop(trackKey(k, slot));
                if (read(slotSourceKey(k, slot)) === 'youtube') drop(slotSourceKey(k, slot));
            }
            forgetVideo(k, slot, id);
        }
        forgetRecordingMeta(k, { kind: 'youtube', videoId: id });
    }
    dropRecords(keys, (m) => m.kind === 'youtube' && m.videoId === id);
}

/**
 * Where the song stands with the sync location, from what the last sync recorded (no network): the baseline holds, per pack,
 * the fingerprint this device had when it and the store last agreed. Same fingerprint now means everything this device holds is
 * in the sync copy ('synced'); a different one means changes since ('pending'); no entry means the pack was never sent or
 * taken ('never'). 'none' when no sync location is set or none has synced yet. Returns `{ status, syncedAt }`, where
 * `syncedAt` is when that last sync ran (ms), so the screen can say how old the answer is.
 */
export async function syncStatusOf(song) {
    try {
        const { getTarget, LAST_LOCATION_KEY } = await import('./syncBackend.js');
        const { localBaselines, createLocalAdapter } = await import('./packSyncLocal.js');
        const { isPackId } = await import('./mpak.js');
        const location = getTarget() && localStorage.getItem(LAST_LOCATION_KEY);
        const base = location && localBaselines.get(location);
        if (!base) return { status: 'none', syncedAt: 0 };
        const syncedAt = base.syncedAt || 0;
        const packId = isPackId(song.id) ? song.id : isPackId(song.packId) ? song.packId : null;
        const entry = packId && base.items?.[`p:${packId}`];
        if (!entry) return { status: 'never', syncedAt };
        const now = (await createLocalAdapter().items()).get(`p:${packId}`);
        return { status: now && entry.l !== undefined && now.fp === entry.l ? 'synced' : 'pending', syncedAt };
    } catch { return { status: 'none', syncedAt: 0 }; }
}

/**
 * Where each tab and audio row sits in the sync location, from the pack's manifest (a small read, no file downloaded). Opens the
 * store without asking the person, so it returns null when that needs a prompt or the location cannot be reached.
 * Otherwise `{ found, paths }`: `paths` maps "kind:id" to its store paths; a row that has none is not in the sync copy.
 */
export async function locateInSyncCopy(song, rows) {
    try {
        const { getTarget, openSyncStore } = await import('./syncBackend.js');
        const target = getTarget();
        if (!target) return null;
        const opened = await openSyncStore(target, { interactive: false });
        if (opened.status !== 'ready') return null;
        const { locateInSyncCopy: locate } = await import('./storage/orphans.js');
        const packId = song.packId || song.id;
        const paths = new Map();
        let found = false;
        for (const row of rows) {
            if (row.kind !== 'tab' && row.kind !== 'audio') continue;
            const r = await locate({ store: opened.store }, packId, await syncCopyTargetsOf(song, row));
            found = r.found;
            if (!r.found) break;
            paths.set(`${row.kind}:${row.id}`, row.kind === 'tab' ? r.scores : r.audio);
        }
        return { found, paths };
    } catch { return null; }
}

/** Is a sync location configured? Without one there is no sync copy to offer to delete. */
export async function hasSyncCopyTarget() {
    try { return Boolean((await import('./syncBackend.js')).getTarget()); } catch { return false; }
}

/** What identifies a row's files inside a pack in the sync location (see removeFromSyncCopy). Read before the local delete. */
async function syncCopyTargetsOf(song, row, { hash: wantHash = true } = {}) {
    const what = { scoreHashes: [], scoreIds: [], audio: [], videoIds: [] };
    if (row.kind === 'tab') {
        const t = (song.tabOptions || []).find((x) => x.id === row.id);
        if (!t) return what;
        what.scoreIds.push(t.id);
        let hash = t.sha256 || null;
        if (!hash && wantHash && t.fileStoreId) {
            try {
                const stored = await getStoredFile(t.fileStoreId);
                if (stored?.file) hash = await sha256(new Uint8Array(await stored.file.arrayBuffer()));
            } catch { /* the tab then matches by id */ }
        }
        if (hash) what.scoreHashes.push(hash);
    } else if (row.kind === 'audio') {
        for (const id of row.ids) {
            const m = await getAudioMeta(id).catch(() => null);
            if (m?.name) what.audio.push({ name: m.name, size: m.size || 0 });
        }
    } else if (row.kind === 'youtube') what.videoIds.push(row.id);
    return what;
}

/**
 * Deletes one row and every reference to it. A tab keeps the song's audio (the audio rows have their own Delete).
 * With `syncCopy` the row's files are also removed from the sync location, first: when that cannot be done (no connection,
 * access not granted) this throws and nothing is deleted here. Returns `{ syncCopy: 'removed' | 'none' | 'skipped' }`, where
 * 'none' means the sync location holds no pack of this song and 'skipped' means a row kind that has no copy of its own.
 */
export async function deleteSongFile(song, row, opts = {}) {
    return deleteSongFiles(song, [row], opts);
}

/**
 * Deletes several rows in one go, with one pass over the sync copy when `syncCopy` is set (see deleteSongFile). `onProgress` is
 * called with 'cloud' when the cloud library step starts and 'device' when the local one does. Audio and videos
 * go before sync points, so a sync row whose recording just went is already gone and is skipped.
 */
export async function deleteSongFiles(song, rows, { syncCopy = false, onProgress = null } = {}) {
    let copy = 'skipped';
    const what = { scoreHashes: [], scoreIds: [], audio: [], videoIds: [] };
    const copyRows = rows.filter((r) => r.kind !== 'sync');
    if (syncCopy && copyRows.length) {
        for (const row of copyRows) {
            const w = await syncCopyTargetsOf(song, row);
            for (const k of Object.keys(what)) what[k].push(...w[k]);
        }
        onProgress?.('cloud');
        const { getTarget, openSyncStore } = await import('./syncBackend.js');
        const { removeFromSyncCopy } = await import('./storage/orphans.js');
        const target = getTarget();
        const opened = target ? await openSyncStore(target, { interactive: true }) : { status: 'none' };
        if (opened.status !== 'ready') throw new Error(`The sync location is not available (${opened.status})`);
        const packId = song.packId || song.id;
        copy = (await removeFromSyncCopy({ store: opened.store }, packId, what)).found ? 'removed' : 'none';
    }
    onProgress?.('device');
    const order = { tab: 0, audio: 1, youtube: 1, sync: 2 };
    for (const row of [...rows].sort((a, b) => order[a.kind] - order[b.kind])) {
        if (row.kind === 'tab') await removeTabOptionFromSong(song.id, row.id, { keepAudio: true });
        else if (row.kind === 'audio') {
            // Remembered, so the next sync does not carry the file over from the store's copy again
            if (syncCopy && copy !== 'skipped') {
                for (const id of row.ids) {
                    const m = await getAudioMeta(id).catch(() => null);
                    if (m?.name) for (const k of ownKeysOf(song)) recordRemovedAudio(k, { name: m.name, size: m.size || 0 });
                }
            }
            await deleteAudio(song, row);
        } else if (row.kind === 'youtube') deleteVideo(song, row);
        else if (row.kind === 'sync') deleteRecord(row.key, row.media);
    }
    notify();
    return { syncCopy: copy };
}

// --- Moving ----------------------------------------------------------------------------------------------------------

/** Moves the sync points of the matching recordings from the song's keys to `toKey`; the newer record wins a clash. */
function moveRecords(fromKeys, toKey, wanted) {
    for (const k of fromKeys) {
        if (lower(k) === lower(toKey)) continue;
        for (const rec of listRecords(k)) {
            if (!wanted(rec.media)) continue;
            const from = storageKey(k, rec.media);
            const to = storageKey(toKey, rec.media);
            const raw = recordStorage.getItem(from);
            if (!from || !to || raw == null) continue;
            const existing = recordStorage.getItem(to);
            let theirs = 0;
            try { theirs = existing ? (JSON.parse(existing).updatedAt || 0) : 0; } catch { /* replaced */ }
            if (!existing || theirs < (rec.updatedAt || 0)) recordStorage.setItem(to, raw);
            recordStorage.removeItem(from);
        }
    }
}

function moveMeta(fromKeys, toKey, mk) {
    const media = mediaOfId(mk);
    for (const k of fromKeys) {
        if (lower(k) === lower(toKey)) continue;
        const meta = listRecordingMeta(k)[mk];
        if (!meta) continue;
        setRecordingMeta(toKey, media, meta);
        forgetRecordingMeta(k, media);
    }
}

async function moveAudio(from, to, row) {
    const toKey = songKeyFor(to);
    const fromKeys = ownKeysOf(from);
    const lowerFrom = new Set(fromKeys.map(lower));
    for (const id of row.ids) {
        const slotsHeld = new Set();
        for (const k of fromKeys) for (const slot of SLOTS) {
            if (read(slotFileKey(k, slot)) !== id) continue;
            slotsHeld.add(slot);
            drop(slotFileKey(k, slot));
            if (read(slotSourceKey(k, slot)) === 'local') drop(slotSourceKey(k, slot));
            if (read(lastKey(k)) === id) drop(lastKey(k));
        }
        const attached = readLibraryAudio(from.id).find((e) => e.audioId === id);
        forgetLibraryAudio(from.id, id);
        attachLibraryAudioAlternate(to, id, [...slotsHeld][0] || attached?.slot || 'original');
        for (const slot of slotsHeld) {
            // The target's slot is taken only when it has nothing of its own
            if (read(slotFileKey(toKey, slot)) || read(slotSourceKey(toKey, slot))) continue;
            write(slotFileKey(toKey, slot), id);
            write(slotSourceKey(toKey, slot), 'local');
            if (slot === 'original' && !read(lastKey(toKey))) write(lastKey(toKey), id);
        }
        const meta = await getAudioFile(id).then((r) => r && { songKeys: r.songKeys }).catch(() => null);
        if (meta) {
            let relinked = false;
            for (const sk of meta.songKeys || []) {
                if (!lowerFrom.has(lower(sk))) continue;
                await relinkAudioFile(id, sk, toKey);
                relinked = true;
            }
            if (!relinked) await linkAudioFile(id, toKey);
        }
        moveRecords(fromKeys, toKey, (m) => m.kind === 'local' && m.audioId === id);
        moveMeta(fromKeys, toKey, `local_${id}`);
    }
}

function moveVideo(from, to, row) {
    const id = row.id;
    const toKey = songKeyFor(to);
    const fromKeys = ownKeysOf(from);
    for (const k of fromKeys) {
        for (const slot of SLOTS) {
            if (read(trackKey(k, slot)) === id) {
                drop(trackKey(k, slot));
                const wasYoutube = read(slotSourceKey(k, slot)) === 'youtube';
                if (wasYoutube) drop(slotSourceKey(k, slot));
                if (!read(trackKey(toKey, slot)) && !read(slotFileKey(toKey, slot))) {
                    write(trackKey(toKey, slot), id);
                    if (wasYoutube && !read(slotSourceKey(toKey, slot))) write(slotSourceKey(toKey, slot), 'youtube');
                }
            }
            for (const h of listHistory(k, slot)) {
                if (h.videoId !== id) continue;
                forgetVideo(k, slot, id);
                rememberVideo(toKey, slot, id, () => true, localStorage, h.lastUsedAt || Date.now());
            }
        }
    }
    moveRecords(fromKeys, toKey, (m) => m.kind === 'youtube' && m.videoId === id);
    moveMeta(fromKeys, toKey, `yt_${id}`);
}

/** Moves one row to another song. Returns false when it could not be moved. A sync row never moves on its own. */
export async function moveSongFile(from, toSongId, row) {
    const to = await getSongById(toSongId);
    if (!to || !from || to.id === from.id) return false;
    if (row.kind === 'tab') {
        // Only this tab moves, so the set it leaves stays together
        const moved = await moveTabOptionToSong(from.id, row.id, to.id);
        if (!moved) return false;
        await retargetSetlistTab(row.id, from.id, to.id);
    } else if (row.kind === 'audio') await moveAudio(from, to, row);
    else if (row.kind === 'youtube') moveVideo(from, to, row);
    else return false;
    notify();
    return true;
}
