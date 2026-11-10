// matcher.js
// Pair a parsed file (artist, album, song) with something real: first a song already in the library, then MusicBrainz.
// Every result keeps its candidates so the page can offer them when the first choice is not the right one.

import { searchMusicBrainz } from '../musicbrainz.js';
import { normName, sameArtist, sameTitle, closeTitle, stripArtistPrefix } from './pairing.js';

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
    const hits = songs.filter((s) => closeTitle(s.title, parsed.title) && (!parsed.artist || sameArtist(s.artist, parsed.artist)));
    hits.sort((a, b) => Number(sameTitle(b.album, parsed.album)) - Number(sameTitle(a.album, parsed.album)));
    return hits.map(fromLibrary);
}

const rank = (c, parsed) => (closeTitle(c.title, parsed.title) ? 4 : 0)
    + (parsed.artist && sameArtist(c.artist, parsed.artist) ? 2 : 0)
    + (parsed.album && sameTitle(c.album, parsed.album) ? 1 : 0);

/**
 * @returns {Promise<{status: 'library'|'match'|'maybe'|'none', pick: object|null, candidates: object[]}>}
 *   library: the song is already in the library (the tab is added to it)
 *   match: MusicBrainz gave this song and artist by name
 *   maybe: something came back, but the name or artist differs: the person should look
 *   none: nothing to offer
 */
const MAX_SEARCHES = 6; // MusicBrainz answers one request a second: a hard file gets a few tries, not a dozen

/**
 * A path can read more than one way (Rock/Boston/song: artist Rock, or artist Boston), and a leading number can be a track
 * number or part of the song ("1 Pull Me Under", "7 Rings"). The library is asked about every reading first (free), then
 * MusicBrainz about each in turn until one gives a sure answer. Without one, the first reading's answer is kept.
 */
export async function lookup(parsed, { songs = [], signal } = {}) {
    if (!parsed?.title) return { status: 'none', pick: null, candidates: [] };
    const base = parsed.rawTitle ?? parsed.title;
    const readings = [{ artist: parsed.artist, album: parsed.album || '' }, ...(parsed.alts || [])];
    // The song's name alone is the last resort: it can only ever be a guess
    if (parsed.artist) readings.push({ artist: '', album: '' });
    const attempts = [];
    readings.forEach((h, i) => {
        const titles = [i === 0 ? parsed.title : stripArtistPrefix(base, h.artist)];
        if (parsed.altTitle) titles.push(stripArtistPrefix(parsed.altTitle, h.artist));
        [...new Set(titles.filter(Boolean))].forEach((title) => attempts.push({ ...parsed, ...h, title }));
    });
    for (const a of attempts) {
        if (!a.artist) continue;
        const known = findInLibrary(a, songs);
        if (known.length) return { status: 'library', pick: known[0], candidates: known };
    }
    let best = null;
    for (const a of attempts.slice(0, MAX_SEARCHES)) {
        const r = await lookupTitle(a, { songs: [], signal });
        if (r.status === 'match') return r;
        if (!best && r.status !== 'none') best = r;
    }
    return best || { status: 'none', pick: null, candidates: [] };
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
