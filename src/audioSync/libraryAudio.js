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
    for (const { audioId, slot } of list) {
        if (!(await getAudioMeta(audioId))) continue;
        await linkAudioFile(audioId, songKey);
        const current = read(slotFileKey(songKey, slot));
        if (current && (await getAudioMeta(current))) continue;
        write(slotFileKey(songKey, slot), audioId);
        if (slot === 'original') write(`audio_file_last_${encodeURIComponent(songKey.toLowerCase())}`, audioId);
        write(slotSourceKey(songKey, slot), 'local');
        changed = true;
    }
    if (changed) {
        const { SYNC_CHANGED_EVENT } = await import('./syncStore.js');
        window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
    }
}
