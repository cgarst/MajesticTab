// What a library row says about a song's media: audio file, YouTube, stems, mapped. Read from what this device holds.
// A device that has not downloaded a song's audio (hybrid sync) holds none of it, so the device that does hold it writes
// the answers onto the song record (`tagFlags`) and the row reads them back (`mediaTags`), so every device shows the same.
import { songHasSyncPoints } from './audioSync/syncStore.js';
import { songHasLocalSlot, songAudioKeys, readLibraryAudio } from './audioSync/libraryAudio.js';
import { listRecordingMeta } from './audioSync/recordingMeta.js';
import { stemsOfMeta } from './audioSync/stemSet.js';
import { slotFileKey } from './stemdeck/backingCandidates.js';

export const TAG_FLAGS = ['hasAudioFile', 'hasYouTube', 'hasStems', 'mapped'];

/** The keys a song is opened by: its own names and its tabs' names. */
export const songTagKeys = (song) => [
    [song.artist, song.title].filter(Boolean).join(' - '),
    song.title,
    ...(song.tabOptions || []).map((t) => t.name),
].filter(Boolean);

/** What this device holds for the song. */
export function localMediaTags(song) {
    const songKeys = songTagKeys(song);
    const audioKeys = [...new Set([...songKeys, ...songAudioKeys(song)])];
    // Files that belong to a stem set (the set's own file and its parts) are the stems, not a separate audio file
    const stemIds = new Set();
    for (const k of audioKeys) {
        try {
            for (const [mk, m] of Object.entries(listRecordingMeta(k) || {})) {
                const parts = stemsOfMeta(m);
                if (!parts) continue;
                if (mk.startsWith('local_')) stemIds.add(mk.slice('local_'.length));
                parts.forEach((st) => stemIds.add(st.audioId));
            }
        } catch { /* optional */ }
    }
    const slotFileIds = audioKeys.flatMap((k) => ['original', 'backing'].map((sl) => {
        try { return songHasLocalSlot(k, sl) ? localStorage.getItem(slotFileKey(k, sl)) : null; } catch { return null; }
    })).filter(Boolean);
    const hasAudioFile = readLibraryAudio(song.id).some((e) => !stemIds.has(e.audioId)) || slotFileIds.some((id) => !stemIds.has(id));
    // A linked video is a video saved for the song's Original or Backing, under any key the song is opened by
    const hasYouTube = audioKeys.some((k) => ['original', 'backing'].some((mode) => {
        try { return Boolean(localStorage.getItem(`yt_track_${encodeURIComponent(k.toLowerCase())}_${mode}`)); } catch { return false; }
    }));
    return { hasAudioFile, hasYouTube, hasStems: stemIds.size > 0, mapped: songKeys.some((k) => songHasSyncPoints(k)) };
}

/** What the row shows: what this device holds, or what a device that holds it recorded on the song. */
export function mediaTags(song) {
    const local = localMediaTags(song);
    return Object.fromEntries(TAG_FLAGS.map((f) => [f, local[f] || Boolean(song[f])]));
}

/** The song with the flags this device can set (never cleared here: a device without the data must not erase another's). */
export function withTagFlags(song) {
    const local = localMediaTags(song);
    const add = TAG_FLAGS.filter((f) => local[f] && !song[f]);
    return add.length ? { ...song, ...Object.fromEntries(add.map((f) => [f, true])) } : song;
}
