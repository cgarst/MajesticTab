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
    // Trailing leftovers, one at a time: "ver2 JR", "(Majestic)", "(2)", " GP", " chords", a saved date "#9-08-11-2026"
    for (let i = 0; i < 4; i++) {
        const before = t;
        t = t.replace(/\s+(?:tabs?|chords?|guitar pro|gp\d?|pro)$/i, '')
            .replace(/\s+ver(?:sion)?\.?\s*\d+\w*(?:\s+[A-Za-z]{1,4})?$/i, '')
            .replace(/\s*\((?:majestic|\d{1,2})\)$/i, '')
            .replace(/\s*#[\d-]{6,}$/, '');
        if (t === before) break;
    }
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

// Folders that name a kind of music or of file, not an artist or an album: they are skipped
const GENERIC_FOLDER = /^(chords?|lessons?|videos?|classical|metal|prog(?:ressive)?(?: rock| metal)?|rock|pop|jazz|blues|country|folk|punk|funk|soul|r ?(?:and|n) ?b|hip hop|rap|reggae|electronic|acoustic|fingerstyle|exports?|majestic ?exports?|tabs?|guitar|bass|drums?|music|songs?|misc(?:ellaneous)?|various(?: artists)?|compilations?|unsorted|downloads?|new)$/i;
// Folders inside an album that only hold versions or kinds of file
const NOISE_FOLDER = /^(alt(?:ernates?|ernatives?)?|archive|archived|secondary|old|extras?|bonus|resources|other|pdfs?|gp\d?|(?:pdf|guitar pro(?: \d)?|gp)(?: tab)?(?: books?| files?| tabs?)?|tabs?)$/i;
const folderKey = (s) => normName(cleanAlbumName(s));
const skippable = (s) => GENERIC_FOLDER.test(folderKey(s)) || NOISE_FOLDER.test(folderKey(s));

/** A leading artist name on a song ("metallica_blackened", "Dream Theater - Night Terror") goes. The song's own name stays. */
export function stripArtistPrefix(title, artist) {
    const words = normName(artist).split(' ').filter(Boolean);
    if (!words.length || normName(artist).length < 3) return title;
    const re = new RegExp('^' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_.\\-]*') + '(?:\\s*[-–—:]\\s*|[\\s_.]+)(?=\\S)', 'iu');
    const rest = String(title).replace(re, '').trim();
    return rest && rest !== title ? rest : title;
}

/**
 * The ways a path can read as artist and album, best first. The folders above the file, from the chosen folder down, with the
 * chosen folder's own name first. Genre and kind-of-file folders (Rock, Chords) and version folders (Alt, Guitar Pro files)
 * are left out; of what remains the two nearest the file are the artist and the album, then the nearer one alone as the
 * artist, then readings that skip a folder (an artist, album and a stray folder between). A reading whose artist is named at
 * the start of the file's own name comes first.
 */
export function folderHypotheses(dirs, baseName = '') {
    const d = (dirs || []).map(clean).filter(Boolean);
    const [root, ...inside] = d;
    let L = inside.filter((x) => !skippable(x));
    if (!L.length && root && !skippable(root)) L = [root];
    const n = L.length;
    const out = [];
    // A folder with an order number or a year in front ("02 - Images and Words") is an album, never the artist
    // An album folder named "Artist_Album" or "Artist - Album" is the album
    const add = (artist, album) => { if (artist && cleanAlbumName(artist) === artist) out.push({ artist, album: album ? stripArtistPrefix(cleanAlbumName(album), artist) : '' }); };
    if (n >= 2) add(L[n - 2], L[n - 1]);
    if (n >= 1) add(L[n - 1], '');
    if (n >= 3) { add(L[n - 3], L[n - 2]); add(L[n - 3], L[n - 1]); }
    const seen = new Set();
    const unique = out.filter((h) => { const k = normName(h.artist) + '|' + normName(h.album); if (seen.has(k)) return false; seen.add(k); return true; });
    const name = normName(baseName);
    const named = (h) => { const a = normName(h.artist); return a.length >= 3 && name.includes(a); };
    return [...unique.filter(named), ...unique.filter((h) => !named(h))];
}

/**
 * Artist/Album/Song: see folderHypotheses. Returns the best reading and the others as `alts`.
 */
export function parseFolders(dirs, baseName) {
    const { title, trackNumber, altTitle } = stripTrackNumber(clean(baseName), { loose: (dirs || []).length >= 3 });
    const hyps = folderHypotheses(dirs, baseName);
    const first = hyps[0] || { artist: '', album: '' };
    const raw = cleanSongTitle(title);
    const out = { artist: first.artist, album: first.album, title: stripArtistPrefix(raw, first.artist), rawTitle: raw, trackNumber };
    if (altTitle) out.altTitle = cleanSongTitle(altTitle);
    if (hyps.length > 1) out.alts = hyps.slice(1);
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
    const real = (entry.dirs || []).slice(1).filter((x) => !skippable(x)); // the folders inside the chosen one that mean something
    if (real.length >= 2) {
        const p = parseFolders(entry.dirs, base);
        if (p.artist && p.title) return { ...p, via: 'folders' };
    }
    const named = parseArtistSong(base);
    if (named.artist && named.title) return { ...named, via: 'artist-song' };
    if (fromFile && fromFile.artist) return { ...fromFile, via: 'metadata' };
    if (real.length === 1) {
        const p = parseFolders(entry.dirs, base);
        if (p.artist && p.title) return { ...p, via: 'folders' };
    }
    // A title alone still searches; the artist comes from the lookup
    if (fromFile) return { ...fromFile, via: 'metadata' };
    return named.title ? { ...named, via: 'file name' } : null;
}

/**
 * Is this file a whole album's tab book rather than one song? Only PDFs are asked. 'strong': the name says so ("tab book",
 * "songbook") or holds the album's name with more around it. 'weak': the name is just the album's ("Systematic Chaos.pdf"),
 * which is also how a title track is named, so the caller checks it against what the library knows. null: a song.
 */
export function looksLikeAlbumBook(parsed, entry) {
    if (!parsed || String(entry?.ext || '').toLowerCase() !== 'pdf') return null;
    const name = baseNameOf(entry.name);
    if (/\b(?:tab(?:lature)?s? book|songbook|song book|full album|complete (?:album|tabs?)|digital guitar tablature)\b/i.test(name)) return 'strong';
    const album = parsed.album;
    if (!album) return null;
    const titles = [parsed.title, parsed.rawTitle, parsed.altTitle].filter(Boolean);
    const key = normName(album);
    if (titles.some((t) => normName(t) !== key && key.split(' ').length >= 2 && normName(t).includes(key))) return 'strong';
    if (titles.some((t) => sameTitle(t, album) || closeTitle(t, album))) return 'weak';
    return null;
}

/** How alike two titles are, 0 to 1: the share of their words they have in common. Catches "lifting shadows off a dream" for a track "Lifting Shadows Off a Dream". */
export function titleSimilarity(a, b) {
    const x = new Set(titleKey(a).split(' ').filter(Boolean));
    const y = new Set(titleKey(b).split(' ').filter(Boolean));
    if (!x.size || !y.size) return 0;
    let common = 0;
    for (const w of x) if (y.has(w)) common++;
    return (2 * common) / (x.size + y.size);
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

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
/** A title in the form two versions of it are compared in: no "(album mix)", no leading "The", "Part II" as "part 2". */
function titleKey(s) {
    const t = String(s ?? '').replace(/\s*[\(\[][^)\]]*\b(?:mix|version|remaster(?:ed)?|edit|mono|stereo|live|demo|alternate|bonus|album)\b[^)\]]*[\)\]]/gi, '');
    return normName(t).replace(/^the /, '').replace(/\bpart (i{1,3}|iv|v|vi{1,3}|ix|x)\b/g, (_, r) => `part ${ROMAN[r]}`);
}

/**
 * The same song under a looser reading than sameTitle: one title may carry more in front of the other
 * ("Six Degrees of Inner Turbulence: II. About to Crash", "jimi hendrix all along the watchtower"), when what is left is at
 * least two words.
 */
export function closeTitle(a, b) {
    const x = titleKey(a);
    const y = titleKey(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.split(' ').length >= 2 && long.endsWith(` ${short}`);
}

/** Why a pairing was chosen, in the words the page shows. */
export const VIA_LABEL = { metadata: 'file data', folders: 'folders', 'artist-song': 'file name', 'file name': 'file name' };

/**
 * Words audio files carry after the song: "(Official Audio)", "[HQ]", "(Remastered 2009)", "(Backing Track)", "(Karaoke)". Returns
 * the title without them, and `backing` when the name says the file is a backing track and not the recording.
 */
export function cleanAudioTitle(title) {
    let t = clean(title);
    let backing = false;
    const tag = /\s*[\(\[][^)\]]*\b(?:official(?: music)? (?:audio|video)|audio|lyrics?|hq|hd|remaster(?:ed)?(?: \d{4})?|backing(?: track)?|karaoke|instrumental|no guitars?|minus one)\b[^)\]]*[\)\]]/gi;
    t = t.replace(tag, (m) => { if (/backing|karaoke|no guitars?|minus one/i.test(m)) backing = true; return ''; });
    const tail = /\s+[-–]\s*(?:backing(?: track)?|karaoke|no guitars?)$|\s+(?:backing track|karaoke)$/i;
    if (tail.test(t)) { backing = true; t = t.replace(tail, ''); }
    return { title: t.replace(/\s+/g, ' ').trim(), backing };
}
