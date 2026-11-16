// packSyncLocal.js
// This device's side of pack sync (storage/packSync.js): the LocalAdapter over the app's own stores.
//
// A song is a pack item when it has at least one tab whose file is stored here. Its id is its pack id: the song's own id when a
// pack may use it (mpak.js, isPackId), else the id it remembers, else one made now and remembered.
// The item's fingerprint covers everything that goes into the song's pack: the song's metadata, its tab files, the audio files
// and video choices of its two recording slots, and its sync points. Any change to those changes the fingerprint, which is
// what makes sync send the song again. It reads stored-file and audio metadata, never file bytes.
import { getAllLibraryData, getSongById, putLibraryRecord, deleteLibraryRecord, deleteSongFromLibrary, setSongPackId } from './libraryStore.js';
import { getAllStoredFiles } from './fileStore.js';
import { listSoundFonts, getSoundFontData, restoreSoundFontEntry, deleteSoundFont } from './soundFontStore.js';
import { listClasstab, getClasstabData, restoreClasstabEntry, deleteClasstab, classtabFingerprint } from './classtab/backup.js';
import { listAudioFiles } from './audioSync/audioFileStore.js';
import { collectAllSettings, applyRestoredSettings } from './backupRestore.js';
import { buildSongPack } from './mtbackup.js';
import { isPackId, saveMpakToLibrary } from './mpak.js';
import { readDirectory, readEntry } from './mpak/core/index.js';
import { blobSource } from './storage/mtbackup.js';
import { createPackStore } from './storage/packStore.js';
import { recordStorage } from './audioSync/syncRecordStore.js';

const HYBRID_SYNC_KEY = 'majestictab_sync_hybrid';
export const isHybridSyncEnabled = () => { try { return localStorage.getItem(HYBRID_SYNC_KEY) === '1'; } catch { return false; } };
export const setHybridSyncEnabled = (on) => { try { localStorage.setItem(HYBRID_SYNC_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ } };
import { fingerprintValue } from './recordSync.js';
import { sha256 } from './mpak/core/index.js';
import { getStoredFile } from './fileStore.js';

const enc = (s) => encodeURIComponent(String(s).toLowerCase());
const songKeyOf = (song) => [song.artist, song.title].filter(Boolean).join(' - ') || song.title || '';
const SLOT_NAMES = new Set(['original', 'backing']);
const SLOT_KEY = /^(audio_file_|real_audio_source_|yt_track_)(?:last_)?(.+)$/;
const SCORE_SYNC = /^audio_sync_score%3A[0-9a-f]{64}%3A(.+)$/;
const asBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

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
        async items() {
            const [{ songs }, files, audio, fonts, classtab] = await Promise.all([getAllLibraryData(), getAllStoredFiles(), listAudioFiles(), listSoundFonts(), listClasstab()]);
            const fileById = new Map(files.map((f) => [f.id, f]));
            const audioById = new Map(audio.map((a) => [a.id, a]));
            const recording = indexRecordingKeys();
            const out = new Map();
            songOfPack = new Map();
            for (const song of songs) {
                const tabs = (song.tabOptions || []).filter((t) => t.fileStoreId && fileById.has(t.fileStoreId));
                if (!tabs.length) continue;
                const packId = await packIdOfSong(song);
                songOfPack.set(packId, song.id);
                const signals = recording.forSong(enc(songKeyOf(song))).map((e) => {
                    const a = e.key.startsWith('audio_file_') ? audioById.get(e.value) : null;
                    return [e.key, e.value, a ? `${a.size || 0}:${a.fingerprint || ''}` : ''];
                });
                const fp = fingerprintValue({
                    meta: [song.title, song.artist, song.album, song.year, song.length, song.trackNumber, song.mediumNumber, song.recordingMbid, song.artistMbid, song.albumMbid],
                    tabs: tabs.map((t) => [t.id, t.name, t.startPage, t.endPage, t.tuning, fileFp(fileById.get(t.fileStoreId))]),
                    signals,
                });
                out.set(`p:${packId}`, { kind: 'pack', id: packId, name: song.title, fp, time: song.addedAt || 0 });
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
            return { files };
        },

        /** Takes the store's pack in, additively. Hybrid mode omits audio so heavy assets stay remote until requested. */
        async applyPack(packId, pack, { includeAudio = true } = {}) {
            const blob = await pack.toMpak({ includeAudio });
            await saveMpakToLibrary(blob, { queryMusicBrainz: false });
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

/** Downloads a remote pack's audio on demand (used when hybrid mode skipped audio during sync). */
export async function fetchPackAudioOnDemand(store, packId) {
    const pack = await createPackStore(store).open(packId);
    const blob = await pack.toMpak({ includeAudio: true });
    await saveMpakToLibrary(blob, { queryMusicBrainz: false });
}

/** Downloads a remote SoundFont on demand (used when hybrid mode kept it remote during sync). */
export async function fetchSoundFontOnDemand(store, id, meta = {}) {
    const bytes = await store.read(`soundfonts/${id}.sf2`);
    const item = { id, name: meta.name || id, size: meta.size || bytes.length, addedAt: meta.addedAt || Date.now(), fetchData: async () => asBuffer(bytes) };
    await restoreSoundFontEntry(item, { wipe: true });
}
