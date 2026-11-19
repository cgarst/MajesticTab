// packSyncLocal.js
// This device's side of pack sync (storage/packSync.js): the LocalAdapter over the app's own stores.
//
// A song is a pack item when it has at least one tab whose file is stored here. Its id is its pack id: the song's own id when a
// pack may use it (mpak.js, isPackId), else the id it remembers, else one made now and remembered.
// The item's fingerprint covers everything that goes into the song's pack: the song's metadata, its tab files, the audio files
// and video choices of its two recording slots, and its sync points. Any change to those changes the fingerprint, which is
// what makes sync send the song again. It reads stored-file and audio metadata, never file bytes.
import { getAllLibraryData, getSongById, putLibraryRecord, deleteLibraryRecord, deleteSongFromLibrary, setSongPackId } from './libraryStore.js';
import { getAllStoredFiles, getStoredFile, deleteStoredFile } from './fileStore.js';
import { listSoundFonts, getSoundFontData, restoreSoundFontEntry, deleteSoundFont } from './soundFontStore.js';
import { listClasstab, getClasstabData, restoreClasstabEntry, deleteClasstab, classtabFingerprint } from './classtab/backup.js';
import { listAudioFiles, deleteAudioFile, getRemovedAudio, clearRemovedAudio } from './audioSync/audioFileStore.js';
import { collectAllSettings, applyRestoredSettings } from './backupRestore.js';
import { buildSongPack } from './mtbackup.js';
import { isPackId, saveMpakToLibrary } from './mpak.js';
import { readDirectory, readEntry } from './mpak/core/index.js';
import { blobSource } from './storage/mtbackup.js';
import { createPackStore } from './storage/packStore.js';
import { REMOTE_ONLY_FP } from './storage/packSync.js';
import { songFromManifest } from './storage/libraryDocs.js';
import { recordStorage } from './audioSync/syncRecordStore.js';
import { readRebuildMarks } from './packRepair.js';

const HYBRID_SYNC_KEY = 'majestictab_sync_hybrid';
export const isHybridSyncEnabled = () => { try { return localStorage.getItem(HYBRID_SYNC_KEY) !== '0'; } catch { return true; } };
export const setHybridSyncEnabled = (on) => { try { localStorage.setItem(HYBRID_SYNC_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ } };
import { fingerprintValue } from './recordSync.js';
import { sha256 } from './mpak/core/index.js';

const enc = (s) => encodeURIComponent(String(s).toLowerCase());
const songKeyOf = (song) => [song.artist, song.title].filter(Boolean).join(' - ') || song.title || '';
const SLOT_NAMES = new Set(['original', 'backing']);
const SLOT_KEY = /^(audio_file_|real_audio_source_|yt_track_)(?:last_)?(.+)$/;
const SCORE_SYNC = /^audio_sync_score%3A[0-9a-f]{64}%3A(.+)$/;
const asBuffer = (u8) => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
    ? u8.buffer
    : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));

/**
 * Every localStorage entry that belongs to a song's recordings, grouped by the song key it is stored under. One pass over
 * storage, then a lookup per song: [{ key, value }] sorted by key. The three families are told apart by their prefix and each
 * is matched against `<encoded song key>_` so that "Song" does not collect the entries of "Song_live".
 */
function indexRecordingKeys(storage = localStorage, records = recordStorage) {
    const slots = [], sync = [];
    for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        const m = k && SLOT_KEY.exec(k);
        if (m) slots.push({ key: k, rest: m[2], value: storage.getItem(k) });
    }
    // Sync points live in their own store (syncRecordStore.js), not in localStorage
    for (let i = 0; i < records.length; i++) {
        const k = records.key(i);
        if (!k || !k.startsWith('audio_sync_')) continue;
        const sc = SCORE_SYNC.exec(k);
        sync.push({ key: k, rest: sc ? sc[1] : k.slice('audio_sync_'.length).replace(/^share_/, ''), value: records.getItem(k) });
    }
    return {
        forSong(E) {
            const out = [];
            const prefix = `${E}_`;
            for (const e of slots) if (e.rest.startsWith(prefix) && SLOT_NAMES.has(e.rest.slice(prefix.length))) out.push(e);
            for (const e of sync) if (e.rest.startsWith(prefix)) out.push(e);
            return out.sort((a, b) => (a.key < b.key ? -1 : 1));
        },
    };
}

const HASH_CACHE_KEY = 'majestictab_packsync_hashes';
const loadHashes = () => { try { return JSON.parse(localStorage.getItem(HASH_CACHE_KEY)) || {}; } catch { return {}; } };
const saveHashes = (h) => { try { localStorage.setItem(HASH_CACHE_KEY, JSON.stringify(h)); } catch { /* quota: hashed again next time */ } };

/**
 * A tab record does not always carry the hash of its file, and the hash is how the store's song record is matched to the tab
 * of a pack on another device. Fills it in on the copy it returns (never on the stored record). Each file is hashed once:
 * the result is remembered against the file's size and dates.
 */
async function withTabHashes(songs, files) {
    const fileById = new Map(files.map((f) => [f.id, f]));
    const cache = loadHashes();
    let dirty = false;
    const out = [];
    for (const song of songs) {
        const tabOptions = [];
        for (const t of song.tabOptions || []) {
            const meta = t.fileStoreId && fileById.get(t.fileStoreId);
            if (t.sha256 || !meta) { tabOptions.push(t); continue; }
            const fp = fileFp(meta);
            let hash = cache[t.fileStoreId]?.fp === fp ? cache[t.fileStoreId].hash : null;
            if (!hash) {
                try {
                    const stored = await getStoredFile(t.fileStoreId);
                    if (stored?.file) { hash = await sha256(new Uint8Array(await stored.file.arrayBuffer())); cache[t.fileStoreId] = { fp, hash }; dirty = true; }
                } catch { /* the tab then matches by id or name */ }
            }
            tabOptions.push(hash ? { ...t, sha256: hash } : t);
        }
        out.push({ ...song, tabOptions });
    }
    if (dirty) saveHashes(cache);
    return out;
}

const fileFp = (m) => `${m.size || 0}:${m.lastModified || 0}:${m.savedAt || 0}`;

/** The pack id of a song: its own id, the one it remembers, or a new one that it now remembers. */
async function packIdOfSong(song) {
    if (isPackId(song.id)) return song.id;
    if (isPackId(song.packId)) return song.packId;
    const id = (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`).toLowerCase();
    await setSongPackId(song.id, id);
    return id;
}

/** @returns {import('./storage/packSync.js').LocalAdapter} */
export function createLocalAdapter({ now = () => Date.now() } = {}) {
    // pack id -> library song id, filled by items() and read by the other calls
    let songOfPack = new Map();

    const adapter = {
        async adoptPackIds(packIdsBySongId) {
            if (!packIdsBySongId?.size) return;
            const { songs } = await getAllLibraryData();
            for (const song of songs) {
                if (isPackId(song.id)) continue;
                const target = packIdsBySongId.get(song.id);
                if (isPackId(target) && song.packId !== target) {
                    await setSongPackId(song.id, target);
                }
            }
        },

        async items() {
            const [{ songs }, files, audio, fonts, classtab] = await Promise.all([getAllLibraryData(), getAllStoredFiles(), listAudioFiles(), listSoundFonts(), listClasstab()]);
            const fileById = new Map(files.map((f) => [f.id, f]));
            const audioById = new Map(audio.map((a) => [a.id, a]));
            const songsWithAudio = new Set();
            for (const a of audio) {
                for (const k of a.songKeys || []) {
                    songsWithAudio.add(k);
                    songsWithAudio.add(enc(k));
                }
            }
            const recording = indexRecordingKeys();
            const rebuildMarks = readRebuildMarks();
            const out = new Map();
            songOfPack = new Map();
            for (const song of songs) {
                const tabs = (song.tabOptions || []).filter((t) => t.fileStoreId && fileById.has(t.fileStoreId));
                if (!tabs.length) {
                    if ((song.tabOptions || []).length && (isPackId(song.id) || isPackId(song.packId))) {
                        const packId = isPackId(song.id) ? song.id : song.packId;
                        songOfPack.set(packId, song.id);
                        out.set(`p:${packId}`, { kind: 'pack', id: packId, name: song.title, fp: REMOTE_ONLY_FP, time: song.addedAt || 0, hasAudio: false, remoteOnly: true });
                    }
                    continue;
                }
                const packId = await packIdOfSong(song);
                songOfPack.set(packId, song.id);
                const songKey = enc(songKeyOf(song));
                const signals = recording.forSong(songKey).map((e) => {
                    const a = e.key.startsWith('audio_file_') ? audioById.get(e.value) : null;
                    return [e.key, e.value, a ? `${a.size || 0}:${a.fingerprint || ''}` : ''];
                });
                const fp = fingerprintValue({
                    meta: [song.title, song.artist, song.album, song.year, song.length, song.trackNumber, song.mediumNumber, song.recordingMbid, song.artistMbid, song.albumMbid],
                    tabs: tabs.map((t) => [t.id, t.name, t.startPage, t.endPage, t.tuning, fileFp(fileById.get(t.fileStoreId))]),
                    signals,
                    removedAudio: getRemovedAudio(songKeyOf(song)),
                    // Only a song marked in Settings, Upkeep carries this, so no other fingerprint changes
                    ...(rebuildMarks[song.id] ? { rebuilt: rebuildMarks[song.id] } : {}),
                });
                // What a send would hold at most: the song's tab files and its audio (an estimate, the pack is not built here)
                const sized = new Map(tabs.map((t) => [t.fileStoreId, fileById.get(t.fileStoreId)?.size || 0]));
                for (const e of recording.forSong(songKey)) if (e.key.startsWith('audio_file_') && audioById.has(e.value)) sized.set(e.value, audioById.get(e.value).size || 0);
                const size = [...sized.values()].reduce((a, b) => a + b, 0);
                out.set(`p:${packId}`, { kind: 'pack', id: packId, name: song.title, fp, size, time: song.addedAt || 0, hasAudio: songsWithAudio.has(songKey), ...(rebuildMarks[song.id] ? { rebuilt: true } : {}) });
            }
            for (const f of fonts) out.set(`s:${f.id}`, { kind: 'soundfont', id: f.id, name: f.name, fp: `${f.size || 0}:${f.addedAt || 0}`, time: f.addedAt || 0, size: f.size || 0 });
            for (const c of classtab) out.set(`c:${c.id}`, { kind: 'classtab', id: c.id, name: c.name, fp: classtabFingerprint(c), time: c.addedAt || 0, size: c.size || 0 });
            return out;
        },

        async readItem(key) {
            if (key.startsWith('s:')) {
                const id = key.slice(2);
                const meta = (await listSoundFonts()).find((f) => f.id === id);
                const data = await getSoundFontData(id);
                if (!meta || !data) throw new Error(`SoundFont ${id} is not on this device`);
                return { bytes: new Uint8Array(data), name: meta.name, size: meta.size, addedAt: meta.addedAt };
            }
            if (key.startsWith('c:')) {
                const meta = (await listClasstab()).find((c) => `c:${c.id}` === key);
                const data = await getClasstabData();
                if (!meta || !data) throw new Error('The Classtab archive is not on this device');
                return { bytes: new Uint8Array(data), name: meta.name, size: meta.size, addedAt: meta.addedAt };
            }
            const packId = key.slice(2);
            if (!songOfPack.has(packId)) await adapter.items();
            const song = await getSongById(songOfPack.get(packId));
            if (!song) throw new Error(`No song for pack ${packId}`);
            const pack = await buildSongPack(song);
            if (!pack || pack.packId !== packId) throw new Error(`Could not build the pack of ${song.title}`);
            const source = blobSource(pack.blob);
            const files = new Map();
            for (const e of await readDirectory(source)) {
                if (e.name === 'mimetype') continue;
                // Slice Stored audio entries as Blobs so large audio files stream instead of buffering in JS memory
                if (e.method === 0 && e.name.startsWith('audio/')) {
                    files.set(e.name, pack.blob.slice(e.dataStart, e.dataStart + e.csize));
                } else {
                    files.set(e.name, await readEntry(source, e, {}));
                }
            }
            // Tabs the song lists but this device holds no file for (a hybrid device frees them): the upload keeps the store's copy of those scores
            const unstoredScoreHashes = [];
            for (const t of song.tabOptions || []) {
                if (!t.sha256) continue;
                const held = t.fileStoreId ? (await getStoredFile(t.fileStoreId))?.file : null;
                if (!held) unstoredScoreHashes.push(t.sha256);
            }
            return { files, removedAudio: getRemovedAudio(songKeyOf(song)), unstoredScoreHashes };
        },

        async clearRemovedAudio(key) {
            if (!key.startsWith('p:')) return;
            const packId = key.slice(2);
            const songId = songOfPack.get(packId);
            const song = songId ? await getSongById(songId) : null;
            if (song) clearRemovedAudio(songKeyOf(song));
        },

        /** Takes the store's pack in, additively. Hybrid mode omits audio so heavy assets stay remote until requested. */
        async applyPack(packId, pack, { includeAudio = true } = {}) {
            const blob = await pack.toMpak({ includeAudio });
            await saveMpakToLibrary(blob, { queryMusicBrainz: false });
        },

        /** Creates a remote-only song record from a pack's manifest when it isn't in library.json. */
        async applyManifest(packId, manifest) {
            await putLibraryRecord('song', songFromManifest(packId, manifest, { now: now() }));
        },

        async applyBlob(key, bytes, meta) {
            const item = { id: key.slice(2), name: meta.name, size: meta.size || bytes.length, addedAt: meta.addedAt || now(), fetchData: async () => asBuffer(bytes) };
            if (key.startsWith('s:')) await restoreSoundFontEntry(item, { wipe: true });
            else await restoreClasstabEntry(item, { wipe: true });
        },

        async deleteItem(key) {
            if (key.startsWith('s:')) return deleteSoundFont(key.slice(2));
            if (key.startsWith('c:')) return deleteClasstab();
            if (!songOfPack.has(key.slice(2))) await adapter.items();
            const songId = songOfPack.get(key.slice(2));
            if (songId) await deleteSongFromLibrary(songId);
        },

        async records() {
            const [library, files] = await Promise.all([getAllLibraryData(), getAllStoredFiles()]);
            return { library: { ...library, songs: await withTabHashes(library.songs, files) }, settings: collectAllSettings() };
        },
        putRecord: (kind, record) => putLibraryRecord(kind, record),
        deleteRecord: (kind, id) => deleteLibraryRecord(kind, id),
        async setSetting(key, value) { applyRestoredSettings({ [key]: value }, { wipe: false }); },
        async removeSetting(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
    };
    return adapter;
}

/** Where the sync baseline lives: one entry per storage location, in localStorage. */
export const localBaselines = {
    key: (location) => `majestictab_packsync_base_${encodeURIComponent(location)}`,
    get(location) { try { return JSON.parse(localStorage.getItem(this.key(location))) || null; } catch { return null; } },
    set(location, value) { try { localStorage.setItem(this.key(location), JSON.stringify(value)); } catch { /* quota: next sync starts without a baseline and merges */ } },
    clear(location) { try { localStorage.removeItem(this.key(location)); } catch { /* storage unavailable */ } },
};

/** Downloads a remote pack (scores and optionally audio) on demand and updates the baseline so it is not re-uploaded. */
export async function fetchPackOnDemand(store, packId, { includeAudio = !isHybridSyncEnabled(), baselines = localBaselines, location = null, targetSongId = null } = {}) {
    const pack = await createPackStore(store).open(packId);
    const blob = await pack.toMpak({ includeAudio });
    await saveMpakToLibrary(blob, { targetSongId, queryMusicBrainz: false });
    if (location) {
        const base = baselines.get(location) || { items: {}, records: {} };
        const items = { ...(base.items || {}) };
        const after = (await createLocalAdapter().items()).get(`p:${packId}`);
        if (after) items[`p:${packId}`] = { l: after.fp, r: pack.version };
        baselines.set(location, { ...base, items });
    }
}

/** Downloads a remote pack's audio on demand (used when hybrid mode skipped audio during sync). */
export async function fetchPackAudioOnDemand(store, packId) {
    return fetchPackOnDemand(store, packId, { includeAudio: true });
}

/** Downloads a remote SoundFont on demand (used when hybrid mode kept it remote during sync). */
export async function fetchSoundFontOnDemand(store, id, meta = {}) {
    const bytes = await store.read(`soundfonts/${id}.sf2`);
    const item = { id, name: meta.name || id, size: meta.size || bytes.length, addedAt: meta.addedAt || Date.now(), fetchData: async () => asBuffer(bytes) };
    await restoreSoundFontEntry(item, { wipe: true });
}

/**
 * Removes local SoundFonts and song audio files that are already present in `store`,
 * and updates the sync baseline so future hybrid syncs keep them remote-only instead of deleting them remotely.
 */
function findEvictableAssets({ fonts, audioFiles, storedFiles, songs, setlists, hasRemoteSoundFont, hasRemotePack, hasRemoteAudio }) {
    const evictSoundFonts = [];
    for (const f of fonts) {
        if (hasRemoteSoundFont(f.id)) evictSoundFonts.push(f);
    }

    const setlistSongIds = new Set();
    for (const sl of setlists || []) {
        for (const item of sl.items || []) {
            if (item?.songId) setlistSongIds.add(item.songId);
        }
    }
    const isProtected = (song) => Boolean(song.pinned || setlistSongIds.has(song.id));

    const evictAudio = [];
    if (audioFiles.length) {
        const packBySongKey = new Map();
        const protectedSongKeys = new Set();
        for (const song of songs) {
            const rawKey = songKeyOf(song);
            const k = enc(rawKey);
            const pid = isPackId(song.id) ? song.id : (isPackId(song.packId) ? song.packId : null);
            if (rawKey && pid) {
                packBySongKey.set(rawKey, pid);
                packBySongKey.set(k, pid);
            }
            if (rawKey && isProtected(song)) {
                protectedSongKeys.add(rawKey);
                protectedSongKeys.add(k);
            }
        }
        for (const a of audioFiles) {
            const keys = a.songKeys || [];
            if (!keys.length) continue;
            if (keys.some((k) => protectedSongKeys.has(k))) continue;
            const packIds = keys.map((k) => packBySongKey.get(k));
            if (packIds.some((pid) => !pid || !hasRemoteAudio(pid))) continue;
            evictAudio.push({ audio: a, packIds });
        }
    }

    const fileById = new Map(storedFiles.map((f) => [f.id, f]));
    const refCounts = new Map();
    for (const song of songs) {
        for (const t of song.tabOptions || []) {
            if (t.fileStoreId) refCounts.set(t.fileStoreId, (refCounts.get(t.fileStoreId) || 0) + 1);
        }
    }
    const evictSongs = [];
    for (const song of songs) {
        if (isProtected(song)) continue;
        const pid = isPackId(song.id) ? song.id : (isPackId(song.packId) ? song.packId : null);
        if (!pid || !hasRemotePack(pid)) continue;
        const hadFile = (song.tabOptions || []).some((t) => t.fileStoreId && fileById.has(t.fileStoreId));
        if (!hadFile) continue;
        for (const t of song.tabOptions || []) {
            if (t.fileStoreId) refCounts.set(t.fileStoreId, (refCounts.get(t.fileStoreId) || 1) - 1);
        }
        evictSongs.push({ song, pid });
    }
    const evictStoredFiles = [];
    for (const [fileId, count] of refCounts) {
        if (count <= 0 && fileById.has(fileId)) {
            evictStoredFiles.push(fileById.get(fileId));
        }
    }

    const totalBytes =
        evictSoundFonts.reduce((s, f) => s + (f.size || 0), 0) +
        evictAudio.reduce((s, e) => s + (e.audio.size || 0), 0) +
        evictStoredFiles.reduce((s, f) => s + (f.size || 0), 0);

    return { evictSoundFonts, evictAudio, evictSongs, evictStoredFiles, totalBytes };
}

function getLatestTargetBaseline(target) {
    if (!target) return null;
    try {
        const prefix = `majestictab_packsync_base_${encodeURIComponent(`${target}|`)}`;
        let best = null;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || !k.startsWith(prefix)) continue;
            const parsed = JSON.parse(localStorage.getItem(k) || 'null');
            if (parsed?.items && (!best || Object.keys(parsed.items).length > Object.keys(best.items).length)) {
                best = parsed;
            }
        }
        return best;
    } catch {
        return null;
    }
}

/** Estimates reclaimable local bytes for files already synced to `target` without network calls. */
export async function estimateReclaimableLocalBytes(target) {
    const base = getLatestTargetBaseline(target);
    if (!base?.items) return { bytes: 0, files: 0 };
    const items = base.items;
    const [fonts, audioFiles, storedFiles, { songs, setlists }] = await Promise.all([
        listSoundFonts(), listAudioFiles(), getAllStoredFiles(), getAllLibraryData(),
    ]);
    const res = findEvictableAssets({
        fonts,
        audioFiles,
        storedFiles,
        songs,
        setlists,
        hasRemoteSoundFont: (id) => Boolean(items[`s:${id}`]),
        hasRemotePack: (pid) => Boolean(items[`p:${pid}`]),
        hasRemoteAudio: (pid) => Boolean(items[`p:${pid}`]),
    });
    return {
        bytes: res.totalBytes,
        files: res.evictSoundFonts.length + res.evictAudio.length + res.evictStoredFiles.length,
    };
}

export async function evictLocalHeavyAssets({ store, baselines = localBaselines, location }) {
    const base = baselines.get(location) || { items: {}, records: {} };
    const nextBase = { items: { ...(base.items || {}) }, records: { ...(base.records || {}) } };

    const [fonts, remoteFontEntries, audioFiles, storedFiles, { songs, setlists }, remotePackEntries] = await Promise.all([
        listSoundFonts(), store.list('soundfonts/'),
        listAudioFiles(), getAllStoredFiles(), getAllLibraryData(), store.list('packs/'),
    ]);
    const remoteFontPaths = new Set(remoteFontEntries.map((e) => e.path));
    const packsWithAudio = new Set();
    const remoteManifestPacks = new Set();
    for (const e of remotePackEntries) {
        const audioMatch = /^packs\/([^/]+)\/audio\/.+/.exec(e.path);
        if (audioMatch) packsWithAudio.add(audioMatch[1]);
        const manMatch = /^packs\/([^/]+)\/manifest\.json$/.exec(e.path);
        if (manMatch) remoteManifestPacks.add(manMatch[1]);
    }

    const plan = findEvictableAssets({
        fonts,
        audioFiles,
        storedFiles,
        songs,
        setlists,
        hasRemoteSoundFont: (id) => remoteFontPaths.has(`soundfonts/${id}.sf2`),
        hasRemotePack: (pid) => remoteManifestPacks.has(pid),
        hasRemoteAudio: (pid) => packsWithAudio.has(pid),
    });

    const evictedPackIds = new Set();
    for (const f of plan.evictSoundFonts) {
        await deleteSoundFont(f.id);
        delete nextBase.items[`s:${f.id}`];
    }
    for (const { audio, packIds } of plan.evictAudio) {
        await deleteAudioFile(audio.id);
        for (const pid of packIds) evictedPackIds.add(pid);
    }
    for (const { song, pid } of plan.evictSongs) {
        const updatedTabs = (song.tabOptions || []).map((t) => t.fileStoreId ? { ...t, fileStoreId: null } : t);
        await putLibraryRecord('song', { ...song, tabOptions: updatedTabs });
        evictedPackIds.add(pid);
    }
    for (const f of plan.evictStoredFiles) {
        await deleteStoredFile(f.id);
    }

    if (evictedPackIds.size) {
        const afterItems = await createLocalAdapter().items();
        for (const pid of evictedPackIds) {
            const key = `p:${pid}`;
            const after = afterItems.get(key);
            if (nextBase.items[key] && after) {
                nextBase.items[key] = { ...nextBase.items[key], l: after.fp };
            }
        }
    }

    baselines.set(location, nextBase);
    return {
        freedAudio: plan.evictAudio.length,
        freedSoundFonts: plan.evictSoundFonts.length,
        freedScores: plan.evictStoredFiles.length,
        freedBytes: plan.totalBytes,
    };
}
