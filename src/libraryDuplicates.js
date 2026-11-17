// libraryDuplicates.js
// Songs that appear more than once in the library, and which copies are safe to remove. Pure: callers pass the song records
// in. Settings > Library > Upkeep shows the result and removes the copies; the metadata export links there.

const normName = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Songs that appear more than once: same artist, album and title. Album-tab containers and custom songs are left out.
 * Per group: `keep` is the record to keep (one with tabs, else the lowest disc and track, else the oldest), `remove` the
 * records that are safe to remove (no tabs, no pack, not pinned, no audio attached by id), and `review` is true when
 * more than one record has tabs, which only a person can settle. `hasAudio(song)` says whether audio is attached to a record.
 */
export function findDuplicateSongs(songs, { hasAudio = () => false } = {}) {
    const groups = new Map();
    for (const s of songs) {
        if (!s || s.isAlbumTabContainer || s.isCustom) continue;
        const key = [s.artist, s.album, s.title].map(normName).join('\u0000');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
    }
    const tabCount = (s) => (Array.isArray(s.tabOptions) ? s.tabOptions.length : 0);
    const out = [];
    for (const list of groups.values()) {
        if (list.length < 2) continue;
        const ordered = [...list].sort((a, b) =>
            (tabCount(b) > 0) - (tabCount(a) > 0)
            || (a.mediumNumber || 1) - (b.mediumNumber || 1)
            || (a.trackNumber || 0) - (b.trackNumber || 0)
            || (a.addedAt || 0) - (b.addedAt || 0));
        const [keep, ...rest] = ordered;
        out.push({
            artist: keep.artist || '', album: keep.album || '', title: keep.title || '',
            keep,
            remove: rest.filter((s) => !tabCount(s) && !s.packId && !s.pinned && !hasAudio(s)),
            review: rest.some((s) => tabCount(s) > 0)
        });
    }
    return out.sort((a, b) => `${a.artist} ${a.album} ${a.title}`.localeCompare(`${b.artist} ${b.album} ${b.title}`));
}
