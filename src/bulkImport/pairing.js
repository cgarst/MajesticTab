// pairing.js
// Pure helpers for Tools > Bulk import: read an artist, album and song title out of where a tab file sits and what it is
// called, under the three pairing strategies, and compare names loosely. No DOM, no network.
//
//   'artist-song'  "Artist - Song.ext"
//   'folders'      Artist/Album/Song.ext, a track number in front of the song is ignored
//   'metadata'     the title, artist and album written inside a Guitar Pro file (read by the caller)
//   'auto'         per file: folders when the file is two folders deep, then the file name, then the file's metadata

export const STRATEGIES = ['auto', 'artist-song', 'folders', 'metadata'];

const clean = (s) => String(s ?? '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

/** Lower case, no accents, "&" as "and", punctuation as spaces: the form two names are compared in. */
export function normName(s) {
    return String(s ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/** "01 - Song", "01. Song", "01_Song", "(01) Song", "01 Song" (zero padded only): the number goes. A name like "7 Rings" stays. */
export function stripTrackNumber(name, { loose = false } = {}) {
    const s = String(name ?? '').trim();
    const m = s.match(/^\(?(\d{1,3})\)?\s*[-._)\]–]\s*(?=\S)/) || s.match(/^(0\d{1,2})\s+(?=\S)/);
    if (m) return { title: s.slice(m[0].length).trim(), trackNumber: parseInt(m[1], 10) };
    // In an album folder a bare "1 Pull Me Under" is a track number too. It could be a song called "7 Rings", so the
    // caller keeps the whole name as `altTitle` and the lookup tries both.
    const bare = loose && s.match(/^(\d{1,2})\s+(?=\S)/);
    if (bare) return { title: s.slice(bare[0].length).trim(), trackNumber: parseInt(bare[1], 10), altTitle: s };
    return { title: s, trackNumber: null };
}

/** Words tab files tend to carry after the song: "(tab)", "(Guitar Pro)", "(ver 2)", "tabs". */
export function cleanSongTitle(title) {
    let t = clean(title);
    t = t.replace(/\s*[\(\[][^)\]]*\b(?:tabs?|guitar pro|power tab|gp[345x]?|ver(?:sion)?\.?\s*\d+|v\d+|official|pro)\b[^)\]]*[\)\]]/gi, '');
    t = t.replace(/\s+(?:tabs?|guitar pro|ver(?:sion)?\.?\s*\d+)$/i, '');
    return t.replace(/\s+/g, ' ').trim();
}

/** "1992 - Images and Words", "Images and Words (1992)", "[FLAC]": the year and tags go. */
export function cleanAlbumName(name) {
    let a = clean(name);
    a = a.replace(/^[\(\[]?\d{4}[\)\]]?\s*[-–.]\s*/, '');
    a = a.replace(/^\d{1,2}\s*[-–.)]\s+/, ''); // "02 - Images and Words": the album's place in a discography
    a = a.replace(/\s*[\(\[]\s*(?:\d{4}|flac|mp3|\d+\s*kbps|remaster(?:ed)?(?:\s+\d{4})?)\s*[\)\]]\s*$/gi, '');
    return a.trim();
}

/** "Artist - Song" (spaced hyphen or dash). Without one the whole name is the song and the artist is unknown. */
export function parseArtistSong(baseName) {
    const { title: rest, trackNumber } = stripTrackNumber(clean(baseName));
    const m = rest.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (!m) return { artist: '', album: '', title: cleanSongTitle(rest), trackNumber };
    return { artist: m[1].trim(), album: '', title: cleanSongTitle(m[2]), trackNumber };
}

/**
 * Artist/Album/Song: the two folders above the file, the album's own, then the artist's. `dirs` run from the chosen folder
 * down, the chosen folder's own name first. One folder is an artist. No folder gives no artist.
 */
export function parseFolders(dirs, baseName) {
    const { title, trackNumber, altTitle } = stripTrackNumber(clean(baseName), { loose: true });
    const d = (dirs || []).map(clean).filter(Boolean);
    let artist = '';
    let album = '';
    if (d.length >= 2) { artist = d[d.length - 2]; album = cleanAlbumName(d[d.length - 1]); }
    else if (d.length === 1) artist = d[0];
    const out = { artist, album, title: cleanSongTitle(title), trackNumber };
    if (altTitle) out.altTitle = cleanSongTitle(altTitle);
    return out;
}

/** The file's name without its extension. */
export function baseNameOf(fileName) {
    return String(fileName ?? '').replace(/\.[^./\\]+$/, '');
}

const JUNK_TITLE = /^(untitled|new song|song|track\s*\d*|no title|score)$/i;

/** What the file's own data gave (title, artist, album), or null when it names no song. */
export function fromMetadata(meta) {
    const title = cleanSongTitle(meta?.title || '');
    if (!title || JUNK_TITLE.test(title)) return null;
    return { artist: clean(meta?.artist), album: cleanAlbumName(meta?.album), title, trackNumber: null };
}

/**
 * The pairing for one file under a strategy: { artist, album, title, trackNumber, via } or null when the strategy cannot read it.
 * @param {{dirs: string[], name: string}} entry  dirs: the folders above the file from the chosen folder (its own name first)
 * @param {string} strategy
 * @param {object|null} meta  the file's embedded metadata when the caller read it (Guitar Pro files)
 */
export function pairFile(entry, strategy, meta = null) {
    const base = baseNameOf(entry.name);
    const tag = (p, via) => (p && p.title ? { ...p, via } : null);
    if (strategy === 'metadata') return tag(fromMetadata(meta), 'metadata');
    if (strategy === 'artist-song') {
        const p = parseArtistSong(base);
        return p.artist ? tag(p, 'artist-song') : null;
    }
    if (strategy === 'folders') {
        const p = parseFolders(entry.dirs, base);
        return p.artist ? tag(p, 'folders') : null;
    }
    // auto: how the person laid the files out beats what a tabber typed into the file
    const fromFile = fromMetadata(meta);
    const real = (entry.dirs || []).slice(1); // the folders inside the chosen one
    if (real.length >= 2) {
        const p = parseFolders(entry.dirs, base);
        if (p.artist && p.title) return { ...p, via: 'folders' };
    }
    const named = parseArtistSong(base);
    if (named.artist && named.title) return { ...named, via: 'artist-song' };
    if (fromFile && fromFile.artist) return { ...fromFile, via: 'metadata' };
    if (real.length === 1) {
        const p = parseFolders(real, base);
        if (p.artist && p.title) return { ...p, via: 'folders' };
    }
    // A title alone still searches; the artist comes from the lookup
    if (fromFile) return { ...fromFile, via: 'metadata' };
    return named.title ? { ...named, via: 'file name' } : null;
}

/** Do two artist names read as the same? One may hold the other ("The Beatles" and "Beatles"). */
export function sameArtist(a, b) {
    const x = normName(a).replace(/^the /, '');
    const y = normName(b).replace(/^the /, '');
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
}

export function sameTitle(a, b) {
    const x = normName(a);
    const y = normName(b);
    return Boolean(x) && x === y;
}

/** Why a pairing was chosen, in the words the page shows. */
export const VIA_LABEL = { metadata: 'file data', folders: 'folders', 'artist-song': 'file name', 'file name': 'file name' };
