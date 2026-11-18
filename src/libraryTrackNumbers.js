// libraryTrackNumbers.js
// Fills in the track number, disc and length a song is missing, from the album's tracklist on MusicBrainz. Only blanks are
// filled: a song that has a track number is never changed. A song search returns no track number, so a song bulk import
// found by name arrives without one; this is how it gets its place on the album. Settings > Library > Reload library
// metadata repairs the songs already in the library.

import { saveSongToLibrary, findTrackByRecording, cleanTitle } from './libraryStore.js';
import { getAlbumTracks } from './musicbrainz.js';
import { sameTitle, closeTitle } from './bulkImport/pairing.js';

/** The track of a tracklist this song is: by recording id, else by title (whole, then close), else null. */
export function trackFor(song, tracks) {
    if (!tracks?.length) return null;
    if (song.recordingMbid) {
        const t = findTrackByRecording(tracks, song);
        if (t) return t;
    }
    return tracks.find((t) => sameTitle(song.title, t.title))
        || tracks.find((t) => cleanTitle(t.title) === cleanTitle(song.title))
        || tracks.find((t) => closeTitle(song.title, t.title))
        || null;
}

/** Copy what the track knows into the blanks of the song. Returns true when something was filled. */
function fillBlanks(song, t) {
    let changed = false;
    const set = (key, value) => { if (value != null && value !== '' && !song[key]) { song[key] = value; changed = true; } };
    set('trackNumber', t.trackNumber);
    set('mediumNumber', t.mediumNumber);
    set('mediumTitle', t.mediumTitle);
    set('mediumFormat', t.mediumFormat);
    set('length', t.length);
    set('recordingMbid', t.recordingMbid);
    return changed;
}

/**
 * One song: when it has no track number and names its album, look the album's tracklist up (the lookup is remembered, so the
 * songs of one album cost one request between them) and fill the blanks. The song is changed in place and saved; any failure
 * leaves it as it was.
 */
export async function fillSongTrack(song) {
    try {
        if (!song || song.trackNumber || song.isCustom || song.isAlbumTabContainer || !song.albumMbid) return song;
        const data = await getAlbumTracks(song.albumMbid);
        const t = trackFor(song, data?.tracks);
        if (t && fillBlanks(song, t)) await saveSongToLibrary(song, song.collectionId);
    } catch (err) {
        console.warn('Could not fill in a track number:', err);
    }
    return song;
}
