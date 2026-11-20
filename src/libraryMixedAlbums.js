// libraryMixedAlbums.js
// Songs filed under the wrong album: a song carries the album, year, cover and recording of a different song's slot on
// another album (an earlier metadata reload matched it by track number alone). Pure: callers pass the song records and
// the album track lists in. Settings > Library > Upkeep > Mixed-up albums shows the result and puts the songs back.

const norm = (t) => String(t || '').toLowerCase().replace(/\(.*\)/g, '').replace(/\[.*\]/g, '').replace(/[^a-z0-9]/g, '');

/**
 * Songs that share one recording with a song of a different title on the same album. One recording is one title, so at
 * most one of them belongs. Returns one group per shared recording: `{ recordingMbid, albumMbid, songs }`. Album-tab
 * containers and custom songs are left out.
 */
export function findSharedRecordings(songs) {
    const byKey = new Map();
    for (const s of songs) {
        if (!s || s.isAlbumTabContainer || s.isCustom || !s.recordingMbid || !s.albumMbid) continue;
        const key = `${s.recordingMbid}\u0000${s.albumMbid}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(s);
    }
    const out = [];
    for (const list of byKey.values()) {
        if (list.length < 2) continue;
        if (new Set(list.map((s) => norm(s.title))).size < 2) continue;
        out.push({ recordingMbid: list[0].recordingMbid, albumMbid: list[0].albumMbid, songs: list });
    }
    return out;
}

/**
 * Which songs of a shared-recording group do not belong. `trackTitles` is the album's track list (titles). A song whose
 * title is on the list belongs; one that is not on it is misfiled. When no song of the group is on the list, or the list is
 * unknown, nothing is flagged: only a person can say which one is right.
 */
export function misfiledIn(group, trackTitles) {
    if (!Array.isArray(trackTitles) || trackTitles.length === 0) return [];
    const wanted = trackTitles.map(norm).filter(Boolean);
    const onList = (s) => {
        const t = norm(s.title);
        return !!t && wanted.some((w) => w === t || w.includes(t) || t.includes(w));
    };
    const home = group.songs.filter(onList);
    if (home.length === 0) return [];
    return group.songs.filter((s) => !onList(s));
}

/**
 * Every misfiled song in the library, each with the album it sits on now. `trackTitlesOf(albumMbid)` is async and gives the
 * titles of that album's tracks, or null when they cannot be read.
 */
export async function findMisfiledSongs(songs, trackTitlesOf) {
    const out = [];
    const seen = new Set();
    for (const group of findSharedRecordings(songs)) {
        let titles = null;
        try { titles = await trackTitlesOf(group.albumMbid); } catch (_) { titles = null; }
        for (const song of misfiledIn(group, titles)) {
            if (seen.has(song.id)) continue;
            seen.add(song.id);
            out.push({ song, albumMbid: group.albumMbid, album: song.album || '', year: song.year ?? null });
        }
    }
    return out.sort((a, b) => `${a.song.artist} ${a.song.title}`.localeCompare(`${b.song.artist} ${b.song.title}`));
}
