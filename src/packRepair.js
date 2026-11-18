// packRepair.js
// Songs whose pack took in audio that belongs to other songs (a key several songs remember, such as a score file name every pack
// of a set shares), and the marker that makes sync build and send those packs again. Pure apart from the storage passed in.
//
// The fingerprint that decides whether sync sends a pack covers the song's own data, not the files a rebuilt pack would drop, so a
// repaired pack is sent only when it is marked here: packSyncLocal.js adds the marker to the song's fingerprint.

const SONG_KEYS_PREFIX = 'yt_song_keys_';
export const REBUILD_KEY = 'majestictab_pack_rebuild';

const lower = (k) => String(k || '').toLowerCase();
const ownKeyOf = (song) => [song.artist, song.title].filter(Boolean).join(' - ') || song.title || '';

/** Map<songId, string[]> of the keys each library song remembers (yt_song_keys_<id>). */
export function readRememberedKeys(storage = localStorage) {
    const out = new Map();
    for (let i = 0; i < storage.length; i++) {
        const name = storage.key(i);
        if (!name || !name.startsWith(SONG_KEYS_PREFIX)) continue;
        try {
            const list = JSON.parse(storage.getItem(name) || '[]');
            const keys = (Array.isArray(list) ? list : []).map((e) => (typeof e === 'string' ? e : e?.key)).filter(Boolean);
            if (keys.length) out.set(name.slice(SONG_KEYS_PREFIX.length), keys);
        } catch { /* unreadable: the song has none to report */ }
    }
    return out;
}

/**
 * Songs with a remembered key that another song remembers too and that has stored audio linked to it: their packs hold files of
 * other songs. `audioFiles` is the stored files' metadata (listAudioFiles). Returns [{ song, keys, files }], `files` being how many
 * stored files are linked to those keys. A song already marked for rebuild is left out: the audio and keys that flag it stay on
 * this device after the rebuilt pack is sent, so the scan alone would list it again.
 */
export function findPooledSongs({ songs, audioFiles, keysBySong, rebuildMarks = {} }) {
    const holders = new Map(); // key -> songs that remember it
    for (const [id, keys] of keysBySong) for (const k of new Set(keys.map(lower))) holders.set(k, (holders.get(k) || 0) + 1);
    const filesOfKey = new Map();
    for (const f of audioFiles) for (const k of new Set((f.songKeys || []).map(lower))) filesOfKey.set(k, (filesOfKey.get(k) || 0) + 1);
    const out = [];
    for (const song of songs) {
        if (!song || rebuildMarks[song.id]) continue;
        const own = lower(ownKeyOf(song));
        const shared = (keysBySong.get(song.id) || []).map(lower).filter((k) => k !== own && holders.get(k) > 1 && filesOfKey.get(k));
        if (!shared.length) continue;
        out.push({ song, keys: [...new Set(shared)], files: Math.max(...shared.map((k) => filesOfKey.get(k))) });
    }
    return out;
}

/** The rebuild stamps by song id: { [songId]: number }. */
export function readRebuildMarks(storage = localStorage) {
    try { return JSON.parse(storage.getItem(REBUILD_KEY) || '{}') || {}; } catch { return {}; }
}

/** The stamp of a song, or 0 when it was never marked. */
export const rebuildStampOf = (songId, storage = localStorage) => readRebuildMarks(storage)[songId] || 0;

/** Marks songs so that sync builds their packs again and sends them. Returns how many were marked. */
export function markPacksForRebuild(songIds, { storage = localStorage, now = Date.now() } = {}) {
    const marks = readRebuildMarks(storage);
    for (const id of songIds) marks[id] = now;
    try { storage.setItem(REBUILD_KEY, JSON.stringify(marks)); } catch { return 0; }
    return songIds.length;
}
