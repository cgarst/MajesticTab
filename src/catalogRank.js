// Ranking for music-catalog search results (artists, albums, songs).
// MusicBrainz gives every exact-name match the same relevance score, so same-named
// tribute acts, unrelated bands and mashup/8-bit albums tie with the real artist.
// Pure functions, no DOM or network, so they can be unit-tested in node.

const JUNK_RE = /\b(tribute|karaoke|cover|covers|8-bit|8 bit|mashup|mash-up|parody|lullaby|string quartet|symphonic|orchestra|rso|piano version|workout|fitness|reloaded|revival|backing track|originally performed|dark trance|plunderphonics?)\b/i;

const norm = s => String(s || '').toLowerCase().trim();

function isJunk(text, q) {
    const m = JUNK_RE.exec(String(text || ''));
    return !!m && !norm(q).includes(m[1].toLowerCase());
}

// Higher is better. Exact name, then name prefix, then the catalog's own score,
// with community tag count (popularity proxy) breaking ties among same-named acts.
function artistScore(a, q) {
    const name = norm(a.name);
    let s = a.score || 0;
    if (name === q) s += 200;
    else if (name.startsWith(q)) s += 30;
    s += Math.min(Math.log2(1 + (a.tagCount || 0)) * 8, 60);
    if (isJunk(a.disambiguation, q) || isJunk(a.name, q)) s -= 150;
    return s;
}

export function rankCatalogArtists(artists, query) {
    const q = norm(query);
    return artists.map((a, i) => ({ a, i, s: artistScore(a, q) }))
        .sort((x, y) => y.s - x.s || x.i - y.i).map(x => x.a);
}

// top: best artist match, used to float its own albums and songs to the top.
function isTop(creditName, creditMbid, top) {
    if (!top) return false;
    return (creditMbid && creditMbid === top.id) || norm(creditName) === norm(top.name);
}

export function rankCatalogAlbums(albums, query, top) {
    const q = norm(query);
    return albums.map((al, i) => {
        let s = al.score || 0;
        if (isTop(al.artist, al.artistMbid, top)) s += 150;
        if (isJunk(al.title, q) || isJunk(al.artist, q)) s -= 150;
        if (al.primaryType === 'Album') s += 10;
        return { al, s, i };
    }).sort((x, y) => y.s - x.s || x.i - y.i).map(x => x.al);
}

export function rankCatalogSongs(songs, query, top) {
    const q = norm(query);
    // A bare artist-name query: songs merely titled with the name by others are noise.
    const queryIsArtist = !!top && norm(top.name) === q;
    return songs.map((so, i) => {
        let s = so.score || 0;
        const byTop = isTop(so.artist, so.artistMbid, top);
        if (byTop) s += queryIsArtist ? 300 : 120;
        if (isJunk(so.title, q) || isJunk(so.artist, q) || isJunk(so.album, q)) s -= 250;
        if (queryIsArtist && !byTop && norm(so.title) === q) s -= 200;
        return { so, s, i };
    }).sort((x, y) => y.s - x.s || x.i - y.i).map(x => x.so);
}

// Split ranked artists into those that lead the results and weaker partial-name matches
// ("Metallica 2", "Some Kind of Metallica") that belong after the real artist's albums and songs.
// When no artist matches the query exactly, nothing is demoted.
export function splitCatalogArtists(rankedArtists, query) {
    const q = norm(query);
    const exact = rankedArtists.filter(a => norm(a.name) === q);
    if (!exact.length) return { lead: rankedArtists, rest: [] };
    return { lead: exact, rest: rankedArtists.filter(a => norm(a.name) !== q) };
}
