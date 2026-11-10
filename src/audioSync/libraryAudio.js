// libraryAudio.js
// Audio attached to a library song from outside the reader (Tools > Bulk import, audio files). A song's audio is filed under
// its song key, the "Artist - Title" the reader works out from the open tab's score, and that key can differ from the library's
// own names (and between a song's tabs). So an attachment is also recorded against the library song's id, and when the song is
// opened the files are linked to the key the reader is using and take the Original or Backing slot if it is still empty.
// A plain localStorage entry per song, no DOM.

import { slotFileKey, slotSourceKey } from '../stemdeck/backingCandidates.js';

const REGISTRY = (songId) => `audio_lib_${songId}`;
const SONG_KEYS = (songId) => `yt_song_keys_${songId}`;
const SLOTS = ['original', 'backing'];

/** The storage keys that say which file is a song's Original or Backing, and its source: backed up with the video choices. */
export const isAudioChoiceKey = (key) => typeof key === 'string'
    && (key.startsWith('audio_file_') || key.startsWith('real_audio_source_') || key.startsWith('real_audio_last_slot_') || key.startsWith('audio_lib_'));

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
export const libraryAudioKey = (song) => [song?.artist, song?.title].filter(Boolean).join(' - ');

/** [{ audioId, slot }] attached to a library song by the bulk import. */
export function readLibraryAudio(songId) {
    try {
        const list = JSON.parse(read(REGISTRY(songId)) || '[]');
        return Array.isArray(list) ? list.filter((e) => e && e.audioId && SLOTS.includes(e.slot)) : [];
    } catch { return []; }
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

/** Records a stored file as the song's audio and makes it the slot's file under the library key. */
export function attachLibraryAudio(song, audioId, slot) {
    const list = readLibraryAudio(song.id).filter((e) => !(e.audioId === audioId && e.slot === slot));
    list.push({ audioId, slot });
    write(REGISTRY(song.id), JSON.stringify(list.slice(-20)));
    const key = libraryAudioKey(song);
    if (key) {
        write(slotFileKey(key, slot), audioId);
        if (slot === 'original') write(`audio_file_last_${encodeURIComponent(key.toLowerCase())}`, audioId);
        write(slotSourceKey(key, slot), 'local');
    }
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
