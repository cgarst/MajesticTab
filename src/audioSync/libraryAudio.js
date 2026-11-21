// libraryAudio.js
// Audio attached to a library song from outside the reader (Tools > Bulk import, audio files). A song's audio is filed under
// its song key, the "Artist - Title" the reader works out from the open tab's score, and that key can differ from the library's
// own names (and between a song's tabs). So an attachment is also recorded against the library song's id, and when the song is
// opened the files are linked to the key the reader is using and take the Original or Backing slot if it is still empty.
// A plain localStorage entry per song, no DOM.

import { slotFileKey, slotSourceKey } from '../stemdeck/backingCandidates.js';
import { ownSongKey } from '../songKey.js';

const REGISTRY = (songId) => `audio_lib_${songId}`;
const SONG_KEYS = (songId) => `yt_song_keys_${songId}`;
const SLOTS = ['original', 'backing'];

/** The storage keys that say which file is a song's Original or Backing, and its source: backed up with the video choices. */
export const isAudioChoiceKey = (key) => typeof key === 'string'
    && (key.startsWith('audio_file_') || key.startsWith('real_audio_source_') || key.startsWith('real_audio_last_slot_') || key.startsWith('audio_lib_') || key.startsWith('audio_key_'));

const BACKING_NAME = /backing[\s_.-]*tracks?|no[\s_.-]*guitars?/i;

/**
 * A file restored from a backup made before slots were saved: when its song has no file in either slot, a name that says
 * "backing track" or "no guitar" makes it the Backing track, and any other name the Original. A song the backup (or this
 * device) already set up is left alone.
 */
export function assignRestoredAudioSlot(item) {
    for (const key of item?.songKeys || []) {
        const enc = encodeURIComponent(String(key).toLowerCase());
        if (read(`audio_file_${enc}_original`) || read(`audio_file_${enc}_backing`) || read(`audio_file_last_${enc}`)) continue;
        const slot = BACKING_NAME.test(item.name || '') ? 'backing' : 'original';
        write(slotFileKey(key, slot), item.id);
        if (slot === 'original') write(`audio_file_last_${enc}`, item.id);
        if (!read(slotSourceKey(key, slot))) write(slotSourceKey(key, slot), 'local');
    }
}

const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* optional */ } };

/** The song key the library's own names give: how the reader keys a tab with no score title of its own. */
export const libraryAudioKey = (song) => (song?.id && ownSongKey(song.id)) || [song?.artist, song?.title].filter(Boolean).join(' - ');

/** [{ audioId, slot }] attached to a library song by the bulk import. */
export function readLibraryAudio(songId) {
    try {
        const list = JSON.parse(read(REGISTRY(songId)) || '[]');
        return Array.isArray(list) ? list.filter((e) => e && e.audioId && SLOTS.includes(e.slot)) : [];
    } catch { return []; }
}

/** The player removed a file: forget it in every library song's attachments, or opening the song would link it again. */
export function detachLibraryAudio(audioId) {
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith('audio_lib_')) continue;
            const list = JSON.parse(localStorage.getItem(key) || '[]');
            if (!Array.isArray(list) || !list.some((e) => e?.audioId === audioId)) continue;
            const kept = list.filter((e) => e?.audioId !== audioId);
            if (kept.length) localStorage.setItem(key, JSON.stringify(kept)); else localStorage.removeItem(key);
        }
    } catch { /* optional */ }
}

/** Every song key this library song's audio may sit under: its own names and the keys its tabs have been opened under. */
export function songAudioKeys(song) {
    const keys = new Set([libraryAudioKey(song)].filter(Boolean));
    try {
        for (const e of JSON.parse(read(SONG_KEYS(song.id)) || '[]')) {
            const k = typeof e === 'string' ? e : e?.key;
            if (k) keys.add(k);
        }
    } catch { /* none remembered */ }
    return [...keys];
}

/**
 * The song keys that library songs other than `songId` remember (lowercase). A key more than one song remembers does not name
 * one song's audio: a pack built from it would take in every other song's files too.
 */
export function keysOfOtherSongs(songId, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    const out = new Set();
    if (!storage) return out;
    const prefix = SONG_KEYS('');
    try {
        for (let i = 0; i < storage.length; i++) {
            const name = storage.key(i);
            if (!name || !name.startsWith(prefix) || name === SONG_KEYS(songId)) continue;
            const list = JSON.parse(storage.getItem(name) || '[]');
            if (!Array.isArray(list)) continue;
            for (const e of list) {
                const k = typeof e === 'string' ? e : e?.key;
                if (k) out.add(String(k).toLowerCase());
            }
        }
    } catch { /* what could not be read is not counted */ }
    return out;
}

/**
 * Does a stored file belong to other songs only? True when the file is linked to song keys and none of them is one of this
 * song's own keys (`ownKeys`, lowercase, raw and encoded). A file linked to no key is kept. This holds whichever way the file
 * reached the song: a slot pointer, an attachment by id, or a key lookup.
 */
export function isForeignAudio(meta, ownKeys) {
    const keys = (meta?.songKeys || []).map((k) => String(k).toLowerCase());
    return keys.length > 0 && !keys.some((k) => ownKeys.has(k));
}

/** Does this song already have an audio file in the slot, under any of its keys? `existingIds` is the set of stored files' ids. */
export function songHasAudioInSlot(song, slot, existingIds) {
    if (readLibraryAudio(song.id).some((e) => e.slot === slot && existingIds.has(e.audioId))) return true;
    return songAudioKeys(song).some((k) => existingIds.has(read(slotFileKey(k, slot))));
}

/** Is a local audio file the song's file for this slot (attached, and the slot's source not set to a video or the file's own audio)? */
export function songHasLocalSlot(songKey, slot) {
    if (!songKey) return false;
    const source = read(slotSourceKey(songKey, slot));
    if (source === 'youtube' || source === 'embedded') return false;
    if (read(slotFileKey(songKey, slot))) return true;
    return slot === 'original' && Boolean(read(`audio_file_last_${encodeURIComponent(String(songKey).toLowerCase())}`));
}

/** Is a local audio file the song's Original? */
export const songHasLocalOriginal = (songKey) => songHasLocalSlot(songKey, 'original');

/** Is there a local audio file in either slot (Original or Backing)? */
export const songHasLocalAudio = (songKey) => songHasLocalSlot(songKey, 'original') || songHasLocalSlot(songKey, 'backing');

const LAST_SLOT_KEY = (songKey) => `real_audio_last_slot_${encodeURIComponent(String(songKey).toLowerCase())}`;

/** Remembers which slot (Original or Backing) the player last used for this song. */
export function rememberLastSlot(songKey, slot) {
    if (songKey && SLOTS.includes(slot)) write(LAST_SLOT_KEY(songKey), slot);
}

/**
 * The slot a song opens on: the one with a local file when only one has, and otherwise (both have one, or neither) the last
 * one used, Original when that was never recorded.
 */
export function preferredSlot(songKey) {
    const original = songHasLocalSlot(songKey, 'original');
    const backing = songHasLocalSlot(songKey, 'backing');
    if (original !== backing) return backing ? 'backing' : 'original';
    return songKey && read(LAST_SLOT_KEY(songKey)) === 'backing' ? 'backing' : 'original';
}

/**
 * Files linked to the song that no slot uses (a restore from a backup that did not save slots, or a file added some other way):
 * a slot with no file and no source chosen takes the first file whose name fits it ("backing track" or "no guitar" is the
 * Backing track, any other name the Original). A slot the player set up, or set to a video, is left alone.
 * Returns true when a slot was filled.
 */
export function adoptUnassignedAudio(songKey, files) {
    if (!songKey || !files?.length) return false;
    const enc = encodeURIComponent(String(songKey).toLowerCase());
    const used = new Set(SLOTS.map((slot) => read(slotFileKey(songKey, slot))).filter(Boolean));
    let changed = false;
    for (const slot of SLOTS) {
        if (read(slotFileKey(songKey, slot)) || read(slotSourceKey(songKey, slot))) continue;
        if (slot === 'original' && read(`audio_file_last_${enc}`)) continue;
        const file = files.find((f) => !used.has(f.id) && BACKING_NAME.test(f.name || '') === (slot === 'backing'));
        if (!file) continue;
        write(slotFileKey(songKey, slot), file.id);
        if (slot === 'original') write(`audio_file_last_${enc}`, file.id);
        write(slotSourceKey(songKey, slot), 'local');
        used.add(file.id);
        changed = true;
    }
    return changed;
}

const ADOPTED_FLAG = 'audio_slots_adopted_v2';

/**
 * Once per install: every song's linked files that no slot uses fill its empty slots (see adoptUnassignedAudio), so audio from a
 * backup made before slots were saved is in place for every song, not only the ones opened afterwards. Returns how many songs changed.
 */
export async function adoptAllUnassignedAudio() {
    if (read(ADOPTED_FLAG)) return 0;
    const { listAudioFiles } = await import('./audioFileStore.js');
    const bySong = new Map();
    for (const f of await listAudioFiles()) for (const key of f.songKeys || []) bySong.set(key, [...(bySong.get(key) || []), f]);
    let changed = 0;
    for (const [key, files] of bySong) if (adoptUnassignedAudio(key, files)) changed++;
    write(ADOPTED_FLAG, '1');
    console.info(`[Audio slots] ${bySong.size} songs with files, ${changed} filled`);
    return changed;
}

/** Records a stored file as the song's audio without touching its slots: the song's keys link it when they open, so the player lists it. */
export function attachLibraryAudioAlternate(song, audioId, slot) {
    const list = readLibraryAudio(song.id).filter((e) => !(e.audioId === audioId && e.slot === slot));
    list.push({ audioId, slot });
    write(REGISTRY(song.id), JSON.stringify(list.slice(-20)));
}

/** Records a stored file as the song's audio and makes it the slot's file under the library key. */
export function attachLibraryAudio(song, audioId, slot) {
    attachLibraryAudioAlternate(song, audioId, slot);
    const key = libraryAudioKey(song);
    if (key) {
        write(slotFileKey(key, slot), audioId);
        if (slot === 'original') write(`audio_file_last_${encodeURIComponent(key.toLowerCase())}`, audioId);
        write(slotSourceKey(key, slot), 'local');
    }
}

/**
 * A song merged into another: its attached files and the keys its tabs were opened under now belong to `to`, and `from`
 * keeps nothing, so removing it does not take the files with it.
 */
export function adoptSongAudio(from, to) {
    if (!from?.id || !to?.id || from.id === to.id) return;
    for (const { audioId, slot } of readLibraryAudio(from.id)) attachLibraryAudioAlternate(to, audioId, slot);
    const keys = new Set([...songAudioKeys(to), ...songAudioKeys(from)].filter((k) => k !== libraryAudioKey(to)));
    write(SONG_KEYS(to.id), JSON.stringify([...keys]));
    try {
        localStorage.removeItem(REGISTRY(from.id));
        localStorage.removeItem(SONG_KEYS(from.id));
    } catch { /* optional */ }
}

/**
 * The reader opened a library song under `songKey`: link the files attached to it by id to that key, and let them fill a slot that
 * has no file. Nothing happens for a song with no attachment, and a slot the player set up is left alone.
 */
export async function adoptLibraryAudio(songId, songKey) {
    if (!songId || !songKey) return;
    const list = readLibraryAudio(songId);
    if (!list.length) return;
    const { linkAudioFile, getAudioMeta } = await import('./audioFileStore.js');
    let changed = false;
    let linked = false;
    for (const { audioId, slot } of list) {
        if (!(await getAudioMeta(audioId))) continue;
        await linkAudioFile(audioId, songKey);
        linked = true;
        const current = read(slotFileKey(songKey, slot));
        if (current && (await getAudioMeta(current))) continue;
        write(slotFileKey(songKey, slot), audioId);
        if (slot === 'original') write(`audio_file_last_${encodeURIComponent(songKey.toLowerCase())}`, audioId);
        write(slotSourceKey(songKey, slot), 'local');
        changed = true;
    }
    // The player listed this song's files when it opened, possibly before the link above: have it list them again
    if (linked) {
        const { AUDIO_FILES_CHANGED_EVENT } = await import('./audioBackup.js');
        window.dispatchEvent(new CustomEvent(AUDIO_FILES_CHANGED_EVENT));
    }
    if (changed) {
        const { SYNC_CHANGED_EVENT } = await import('./syncStore.js');
        window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
    }
}

/**
 * Forget everything a library song kept for its audio: the files linked to its keys (deleted when no other song uses them), the
 * Original and Backing choices, the sources, the video choices and the attachments. Called when the song's last tab goes, so a
 * tab added again later starts clean. A key another song also remembers is left alone.
 */
export async function purgeSongAudio(song) {
    if (!song?.id) return;
    const { listAudioFiles, unlinkAudioFile } = await import('./audioFileStore.js');
    const others = keysOfOtherSongs(song.id);
    const keys = songAudioKeys(song).filter((k) => !others.has(String(k).toLowerCase()));
    const encoded = new Set(keys.map((k) => encodeURIComponent(String(k).toLowerCase())));
    const lower = new Set(keys.map((k) => String(k).toLowerCase()));
    const attached = new Set(readLibraryAudio(song.id).map((e) => e.audioId));
    try {
        for (const meta of await listAudioFiles()) {
            const own = (meta.songKeys || []).filter((k) => lower.has(String(k).toLowerCase()));
            if (!own.length && !attached.has(meta.id)) continue;
            for (const k of own) await unlinkAudioFile(meta.id, k);
        }
    } catch { /* optional */ }
    try {
        const prefixes = ['audio_file_', 'audio_file_last_', 'real_audio_source_', 'real_audio_last_slot_', 'yt_track_'];
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const name = localStorage.key(i);
            if (!name) continue;
            const hit = prefixes.some((pre) => {
                if (!name.startsWith(pre)) return false;
                const rest = name.slice(pre.length);
                return [...encoded].some((e) => rest === e || rest.startsWith(`${e}_`));
            });
            if (hit) localStorage.removeItem(name);
        }
        localStorage.removeItem(REGISTRY(song.id));
        localStorage.removeItem(SONG_KEYS(song.id));
    } catch { /* optional */ }
}
