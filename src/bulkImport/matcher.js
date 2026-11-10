// matcher.js
// Pair a parsed file (artist, album, song) with something real: first a song already in the library, then MusicBrainz.
// Every result keeps its candidates so the page can offer them when the first choice is not the right one.

import { searchMusicBrainz } from '../musicbrainz.js';
import { normName, sameArtist, sameTitle } from './pairing.js';

const cache = new Map(); // search text -> candidates (a folder of one album asks MusicBrainz about each song once)

/** What the page needs from a MusicBrainz recording, or from a library song. */
const fromRecording = (r) => ({
    source: 'musicbrainz',
    title: r.title, artist: r.artist, artistMbid: r.artistMbid || '', album: r.album || '', albumMbid: r.albumMbid || '',
    recordingMbid: r.recordingMbid || r.id || '', year: r.year || null, length: r.length || null, coverUrl: r.coverUrl || null
});
const fromLibrary = (s) => ({
    source: 'library', songId: s.id,
    title: s.title, artist: s.artist, artistMbid: s.artistMbid || '', album: s.album || '', albumMbid: s.albumMbid || '',
    recordingMbid: s.recordingMbid || '', year: s.year || null, length: s.length || null, coverUrl: s.coverUrl || null
});

/** Search MusicBrainz for songs. Also used by the page's own search box. */
export async function searchSongs(text, { signal } = {}) {
    const key = normName(text);
    if (!key) return [];
    if (cache.has(key)) return cache.get(key);
    const found = (await searchMusicBrainz(text, 'song', { signal })).slice(0, 12).map(fromRecording);
    cache.set(key, found);
    return found;
}

/** Songs already in the library that read as this one. Same album first. */
export function findInLibrary(parsed, songs) {
    const hits = songs.filter((s) => sameTitle(s.title, parsed.title) && (!parsed.artist || sameArtist(s.artist, parsed.artist)));
    hits.sort((a, b) => Number(sameTitle(b.album, parsed.album)) - Number(sameTitle(a.album, parsed.album)));
    return hits.map(fromLibrary);
}

const rank = (c, parsed) => (sameTitle(c.title, parsed.title) ? 4 : 0)
    + (parsed.artist && sameArtist(c.artist, parsed.artist) ? 2 : 0)
    + (parsed.album && sameTitle(c.album, parsed.album) ? 1 : 0);

/**
 * @returns {Promise<{status: 'library'|'match'|'maybe'|'none', pick: object|null, candidates: object[]}>}
 *   library: the song is already in the library (the tab is added to it)
 *   match: MusicBrainz gave this song and artist by name
 *   maybe: something came back, but the name or artist differs: the person should look
 *   none: nothing to offer
 */
export async function lookup(parsed, { songs = [], signal } = {}) {
    const first = await lookupTitle(parsed, { songs, signal });
    // "1 Pull Me Under" read as track 1: if that found nothing sure, try the whole name as the title ("7 Rings")
    if (parsed?.altTitle && first.status !== 'match' && first.status !== 'library') {
        const second = await lookupTitle({ ...parsed, title: parsed.altTitle }, { songs, signal });
        if (second.status === 'match' || second.status === 'library') return second;
    }
    return first;
}

async function lookupTitle(parsed, { songs, signal }) {
    if (!parsed?.title) return { status: 'none', pick: null, candidates: [] };
    const known = findInLibrary(parsed, songs);
    if (known.length && (parsed.artist || known.length === 1)) return { status: 'library', pick: known[0], candidates: known };

    const found = await searchSongs([parsed.artist, parsed.title].filter(Boolean).join(' '), { signal });
    if (!found.length) return { status: 'none', pick: null, candidates: [] };
    const ranked = found.map((c, i) => ({ c, i, r: rank(c, parsed) })).sort((a, b) => b.r - a.r || a.i - b.i);
    const best = ranked[0];
    const exact = parsed.artist ? best.r >= 6 : false;
    return { status: exact ? 'match' : 'maybe', pick: best.c, candidates: ranked.map((x) => x.c) };
}
