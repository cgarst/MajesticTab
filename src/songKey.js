// songKey.js
// The key everything the reader keeps for a song hangs off (its audio files, which slot plays which, its YouTube videos, its
// recording meta, its sync points): the artist and title, as "Artist - Title". Two library songs can share that (the studio
// and the live version of one title, on two albums). The one added second then gets a key of its own, with its song id in
// it, and shares nothing with the first. A song that never collided keeps the plain key, so nothing of anyone's moves.
// App-internal: never written to a pack. No DOM, so it runs under node.

/** Starts the key of a library song that has its own: the song's id and a space follow. */
export const SONG_KEY_MARK = 'song~';
/** The localStorage entry that holds one song's own key. Backed up with the audio choices (see isAudioChoiceKey). */
export const OWN_KEY_PREFIX = 'audio_key_';

/** The key the artist and title give. */
export const baseSongKey = (song) => [song?.artist, song?.title].filter(Boolean).join(' - ') || song?.title || '';

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

/** The own key of a song, or null when it uses the plain one. */
export const ownSongKey = (songId) => (songId ? read(`${OWN_KEY_PREFIX}${songId}`) || null : null);

/** The key a library song's data is stored under. */
export const songKeyFor = (song) => (song ? ownSongKey(song.id) || baseSongKey(song) : '');

/** Gives a song a key of its own and returns it. */
export function assignOwnSongKey(song) {
    const key = `${SONG_KEY_MARK}${song.id} ${baseSongKey(song)}`;
    try { localStorage.setItem(`${OWN_KEY_PREFIX}${song.id}`, key); } catch { /* storage unavailable */ }
    return key;
}

/** A song key as a person reads it, without the marker of an own key. */
export const plainOwnKey = (key) => (typeof key === 'string' && key.startsWith(SONG_KEY_MARK) ? key.replace(/^song~\S+ /, '') : key);
