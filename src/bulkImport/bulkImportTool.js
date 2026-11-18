// bulkImportTool.js
// Bulk import page in Tools: choose a folder, and every tab file in it (subfolders included) is paired with a song.
//   1. Pairing: "Artist - Song.ext", Artist/Album/Song.ext (a track number before the song is ignored), or the metadata
//      inside a Guitar Pro file; Auto picks per file (see pairing.js).
//   2. Suggestions: each pairing is looked up in the library, then on MusicBrainz (one request at a time, as MusicBrainz asks;
//      the rows fill in while it runs).
//   3. Fixing: any row can be changed by searching MusicBrainz, imported as custom music (typed names, no MusicBrainz data;
//      MusicBrainz is always tried first, and a switch makes custom music the answer when nothing matches), or left out.
//   4. Album tabs: a PDF that is a whole album's tab book (named for the album, or a "tab book") is paired with an album instead
//      (MusicBrainz release groups) and imported as the album's tab book. Any row can be switched between the two.
//   4b. Several files for one song: the best stays checked, the rest are left out with a note (markSiblings).
//   5. Import: each paired file is stored and attached to its song (an existing library song, or a new one from the match), or to
//      its album. A switch leaves out files whose song or album already has a tab,
//      and a file whose exact bytes the song already has is skipped whatever its name.
//   Audio files: a second mode on the same page (audioImport.js) matches a folder of audio files to songs already in the library.
// The page's state lives in this module, so leaving Tools while the lookups run does not lose them.

import { getAllSongs, saveSongToLibrary, getSongById, mapOpenFileToSong, findMatchingSongInLibrary, getAlbumTabOptions, addTabOptionToAlbum, DEFAULT_COLLECTION_ID } from '../libraryStore.js';
import { readMpak, saveMpakToLibrary } from '../mpak.js';
import { lookupMusicBrainzByIds } from '../musicbrainz.js';
import { saveStoredFile, getStoredFileRecord } from '../fileStore.js';
import { sha256 } from '../mpak/core/index.js';
import { detectFileMetadata } from '../utils/tuningUtils.js';
import { showToast } from '../utils/toast.js';
import { STRATEGIES, pairFile, pairFromPack, coversTitle, baseNameOf, normName, sameArtist, sameTitle, looksLikeAlbumBook, VIA_LABEL } from './pairing.js';
import { lookup, lookupAlbum, searchSongs, searchAlbums, normKey, resolveAlbumTracklist, matchTrack } from './matcher.js';
import { canPickFolder, pickFilesOnly, pickAndScanFolder } from './scanFolder.js';
import { renderAudioImport, audioImportReadout, onAudioImportChange } from './audioImport.js';
import { packAdds, describeAdds } from './packContribution.js';
import { holdSync } from '../autoSync.js';
import { listAudioFiles, fingerprintOfHead } from '../audioSync/audioFileStore.js';
import { libraryAudioKey, songAudioKeys, keysOfOtherSongs, readLibraryAudio } from '../audioSync/libraryAudio.js';
import { listRecords, mediaKey } from '../audioSync/syncStore.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const STRATEGY_LABEL = {
    auto: 'Automatic',
    'artist-song': 'Artist - Song',
    folders: 'Artist/Album/Song',
    metadata: 'Guitar Pro file data'
};
const STRATEGY_HELP = {
    auto: 'Each file is paired by the best thing it gives: two folders (Artist/Album), then “Artist - Song” in the name, then the data inside a Guitar Pro file.',
    'artist-song': 'Files are named like “Artist - Song.gp5”. A track number or “(tab)” in front or behind is ignored.',
    folders: 'Files sit in an artist folder and an album folder, like Artist/Album/03 Song.gp5. The two folders above each file are used, and a track number in front of the song is ignored.',
    metadata: 'The title, artist and album written inside each Guitar Pro file. PDF and text files carry none.'
};

const state = {
    phase: 'setup', // 'setup' | 'scanning' | 'review' | 'importing'
    strategy: 'auto',
    rootName: '',
    foundCount: 0,
    rows: [],
    filter: 'all', // 'all' | 'attention'
    customFallback: false, // a file nothing matched is imported as custom music
    skipExisting: true, // a tab file whose song already has a tab, and a pack that adds nothing, are left out
    openId: null, // the row whose search panel is open
    lookingUp: false,
    summary: '',
    importDone: 0,
    importTotal: 0,
    songs: [], // library songs, for matching and for finding a song again
    knownArtists: new Map(), // artists the library and the chosen folder's folder names suggest, for files that name none
    controller: null,
    scanController: null
};
const listeners = new Set();
const notify = (id) => listeners.forEach((cb) => { try { cb(id); } catch (e) { console.error('[Bulk import]', e); } });

/** Readout for the Tools row. */
export function bulkImportReadout() {
    if (state.phase === 'importing') return `${Math.min(state.importDone + 1, state.importTotal)} of ${state.importTotal}`;
    if (state.phase === 'review' && state.lookingUp) {
        const done = state.rows.filter((r) => r.stage === 'done').length;
        return `${done} of ${state.rows.length}`;
    }
    return audioImportReadout();
}
onAudioImportChange(() => {
    const el = document.querySelector('[data-read="bulkimport"]');
    if (el && el.textContent !== bulkImportReadout()) el.textContent = bulkImportReadout();
});
listeners.add(() => {
    const el = document.querySelector('[data-read="bulkimport"]');
    if (el && el.textContent !== bulkImportReadout()) el.textContent = bulkImportReadout();
});

// --- Rows ------------------------------------------------------------------------------------------------------------

/** What a row is, for the page: ready (will be imported), attention (needs a look), or left out. */
function verdict(row) {
    if (row.imported) return 'done';
    if (row.stage === 'error' && !row.manual) return 'attention';
    if (row.stage !== 'done' && !row.manual) return 'wait';
    if (!row.pick) return 'attention';
    if (row.addsPending) return 'wait'; // what a pack adds is still being worked out: not yet "already has a tab" or ready
    if (state.skipExisting && !row.forced && (row.entry.ext === 'mpak' && row.adds ? row.adds.total === 0 : row.hadTab)) return 'have';
    if (row.excluded) return 'out';
    // A guess is not imported until the person has looked at it (checked it, or chosen a song)
    return row.status === 'maybe' && !row.manual && !row.confirmed ? 'attention' : 'ready';
}
const statusText = (row) => {
    const text = baseStatusText(row);
    return row.kind === 'album' && row.pick && !row.imported && row.stage === 'done' && verdict(row) !== 'have' ? `Album tab · ${text}` : text;
};
const baseStatusText = (row) => {
    if (row.imported === 'done') return 'Imported';
    if (row.imported === 'skipped') return row.note || 'Already added';
    if (row.imported === 'error') return row.note || 'Could not import';
    if (row.stage === 'queued') return 'Waiting';
    if (row.stage === 'working') return 'Looking up…';
    if (row.stage === 'error') return 'Lookup failed';
    if (row.addsPending && row.pick) return 'Checking the pack…';
    if (row.dupOf && row.excluded && !row.forced) return `Same song as ${row.dupOf.entry.name}`;
    if (verdict(row) === 'have') return row.entry.ext === 'mpak' && row.adds ? 'Nothing new in it' : row.kind === 'album' ? 'Album already has a tab book' : 'Already has a tab';
    if (row.entry.ext === 'mpak' && row.adds?.total && row.status !== 'maybe') return describeAdds(row.adds);
    if (row.pick?.source === 'custom') return 'Custom music';
    if (row.manual && row.pick) return 'Chosen by you';
    if (!row.pick) return row.parsed ? 'No match' : 'No pairing';
    return { library: 'In your library', match: 'Matched', maybe: 'Check this', custom: 'Custom music' }[row.status] || '';
};

// --- What a pack would add --------------------------------------------------------------------------------------------

let audioFilesCache = null;
const audioFilesNow = async () => (audioFilesCache ||= await listAudioFiles().catch(() => []));
const lowerKey = (k) => String(k || '').toLowerCase();

/** The library song a pick points at, or null when importing it would create the song. Does not create anything. */
function knownSong(pick) {
    if (!pick) return null;
    if (pick.source === 'custom') {
        const artist = pick.artist || 'Custom Music';
        return state.songs.find((s) => s.isCustom && sameTitle(s.title, pick.title) && sameTitle(s.artist, artist) && sameTitle(s.album, pick.album)) || null;
    }
    return state.songs.find((s) => (pick.songId && s.id === pick.songId) || (pick.recordingMbid && s.recordingMbid === pick.recordingMbid)
        || (sameTitle(s.title, pick.title) && sameArtist(s.artist, pick.artist) && (!pick.album || sameTitle(s.album, pick.album)))) || null;
}

/** The first megabyte of a pack's audio file, read from the archive without reading the file whole; null when it cannot be. */
async function headOf(file, opened, path) {
    try {
        const r = opened.range(path);
        return new Uint8Array(await file.slice(r.start, Math.min(r.end, r.start + 1048576)).arrayBuffer());
    } catch { return null; }
}

/**
 * Works out what an .mpak row would add to its song and keeps it on the row (`row.adds`, null when it cannot be told). A file the
 * song already has is found by its size, then by the stored fingerprint of its first megabyte. Only the song's own audio counts:
 * keys another song also remembers do not say whose a file is.
 */
async function computeAdds(row) {
    if (row.entry.ext !== 'mpak') return;
    const seq = (row.addsSeq = (row.addsSeq || 0) + 1);
    row.addsPending = Boolean(row.pick);
    let adds = null;
    if (row.pick) {
        try {
            const file = await row.entry.getFile();
            const { header, opened } = await readMpak(file);
            const song = knownSong(row.pick);
            let isSameFile = async () => null;
            let hasSync = () => false;
            if (song) {
                const stored = await audioFilesNow();
                const others = keysOfOtherSongs(song.id);
                const own = lowerKey(libraryAudioKey(song));
                const keys = [...new Set([libraryAudioKey(song), ...songAudioKeys(song)].filter(Boolean))].filter((k) => lowerKey(k) === own || !others.has(lowerKey(k)));
                const keySet = new Set(keys.map(lowerKey));
                const ids = new Set(readLibraryAudio(song.id).map((e) => e.audioId));
                const mine = stored.filter((f) => ids.has(f.id) || (f.songKeys || []).some((k) => keySet.has(lowerKey(k))));
                isSameFile = async (src) => {
                    const near = mine.filter((f) => f.size === src.size);
                    if (!near.length) return null;
                    const head = await headOf(file, opened, src.path);
                    if (!head) return near[0].id;
                    const fp = await fingerprintOfHead(src.size, head);
                    return near.find((f) => f.fingerprint === fp)?.id || null;
                };
                const shas = (header.scores || []).map((sc) => sc.sha256).filter(Boolean);
                const have = new Set(keys.flatMap((k) => [k, `text:${k}`, ...shas.map((h) => `score:${h}:${k}`)])
                    .flatMap((k) => listRecords(k)).map((r) => mediaKey(r.media)).filter(Boolean));
                hasSync = (rec, media) => have.has(mediaKey(media));
            }
            adds = await packAdds({ manifest: header, song, isSameFile, hasSync });
        } catch (err) {
            console.warn('[Bulk import] Could not tell what', row.entry.path, 'adds:', err);
        }
    }
    if (row.addsSeq === seq) { row.adds = adds; row.addsPending = false; }
}

/** A song that is not on MusicBrainz: the names as the file gave them (or the person typed them), saved as custom music. */
const customPick = (p, kind = 'song') => ({
    kind, source: 'custom', title: p.title || '', artist: p.artist || '', album: kind === 'album' ? (p.title || '') : (p.album || ''), artistMbid: '', albumMbid: '',
    recordingMbid: '', year: null, length: null, coverUrl: null
});

/** Does the song (or album) this row would add to already have a tab? A pack is judged by what it would add (computeAdds). */
function markHad(row) {
    markHadTab(row);
    if (row.entry?.ext === 'mpak') computeAdds(row).then(() => notify(row.id)).catch(() => {});
}

function markHadTab(row) {
    const p = row.pick;
    row.hadTab = false;
    if (!p) return;
    const artist = p.artist || 'Custom Music';
    if (row.kind === 'album') {
        row.hadTab = state.songs.some((s) => s.isAlbumTabContainer && (s.tabOptions || []).length > 0 && sameArtist(s.artist, artist) && sameTitle(s.album || s.title, p.title));
    } else {
        row.hadTab = state.songs.some((s) => !s.isAlbumTabContainer && (s.tabOptions || []).length > 0
            && ((p.songId && s.id === p.songId) || (p.recordingMbid && s.recordingMbid === p.recordingMbid)
                || (sameTitle(s.title, p.title) && sameArtist(s.artist, artist) && (!p.album || sameTitle(s.album, p.album)))));
    }
}

// --- Several files for one song ---------------------------------------------------------------------------------------

const FORMAT_RANK = ['gp', 'gp5', 'gpx', 'gp4', 'gp3', 'mscz', 'pdf', 'txt'];
/** Files of one family compete for a song (a Guitar Pro file and a PDF of it are different tabs and both stay). */
const familyOf = (ext) => (/^(gp[345x]?|mscz)$/.test(ext) ? 'score' : ext === 'pdf' ? 'pdf' : 'text');

/**
 * When several files in the folder go to the same song, the best one stays checked and the others are left out with a note
 * saying which file they lost to (check one to import it anyway). The best is the person's own check, then the format, then
 * the larger file. A row the person has already decided on is not changed.
 */
function markSiblings() {
    const groups = new Map();
    for (const r of state.rows) {
        r.dupOf = null;
        if (r.imported || !r.pick || r.kind === 'album' || r.entry.ext === 'mpak' || (r.stage !== 'done' && !r.manual)) continue;
        const p = r.pick;
        const who = p.songId || p.recordingMbid || [p.artist || 'Custom Music', p.title].map(normName).join('\u0000');
        const key = `${who}\u0001${familyOf(r.entry.ext)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    const rank = (r) => { const i = FORMAT_RANK.indexOf(r.entry.ext); return i < 0 ? FORMAT_RANK.length : i; };
    for (const list of groups.values()) {
        if (list.length < 2) continue;
        const best = [...list].sort((a, b) => ((b.forced || b.manual) - (a.forced || a.manual)) || (rank(a) - rank(b)) || ((b.entry.size || 0) - (a.entry.size || 0)) || a.entry.path.localeCompare(b.entry.path))[0];
        for (const r of list) {
            if (r === best) continue;
            r.dupOf = best;
            if (!r.dupSeen) { r.dupSeen = true; if (!r.forced) r.excluded = true; }
        }
    }
}

const hashCache = new Map(); // stored file id -> sha256 of its bytes
async function hashOfBytes(buffer) { return sha256(new Uint8Array(buffer)); }

/** Does the song already have a tab with exactly these bytes, whatever it is called? Sizes are compared first, so most checks read nothing. */
async function songHasSameFile(song, file, fileHash) {
    for (const t of song?.tabOptions || []) {
        if (t.sha256) { if (t.sha256 === fileHash.value) return true; continue; }
        if (!t.fileStoreId) continue;
        try {
            const rec = await getStoredFileRecord(t.fileStoreId);
            if (!rec || (rec.size || rec.data?.byteLength) !== file.size) continue;
            if (!hashCache.has(t.fileStoreId)) hashCache.set(t.fileStoreId, await hashOfBytes(rec.data));
            if (hashCache.get(t.fileStoreId) === fileHash.value) return true;
        } catch { /* a tab that cannot be read is not a match */ }
    }
    return false;
}

function makeRow(entry, i) {
    return { id: `r${i}`, entry, kind: 'song', manualKind: false, hadTab: false, adds: null, addsSeq: 0, addsPending: false, forced: false, parsed: null, stage: 'queued', status: 'none', pick: null, candidates: [], before: null, excluded: false, confirmed: false, manual: false, imported: '', note: '', error: '' };
}

/** The song written in a pack's manifest ({} when it has none, null when the pack cannot be read). Read once per row. */
async function packSongOf(row) {
    if (row.packSong === undefined) {
        try { row.packSong = (await readMpak(await row.entry.getFile())).header?.song || {}; } catch { row.packSong = null; }
    }
    return row.packSong;
}

async function embeddedMeta(entry) {
    if (!/^gp[345x]?$/.test(entry.ext)) return null;
    try { return await detectFileMetadata(await entry.getFile(), entry.name); } catch { return null; }
}

/** Pair one file by the chosen strategy, then look the pairing up. A row the person set by hand is left alone. */
async function resolveRow(row, signal) {
    row.stage = 'working';
    notify(row.id);
    try {
        if (row.entry.ext === 'mpak') {
            const mpakSong = await packSongOf(row);
            if (!mpakSong) throw new Error('Could not read the pack');
            // The pack names its own song, so that is the pairing; the file name is used only when the manifest has no artist
            row.parsed = pairFromPack(mpakSong)
                || pairFile(row.entry, state.strategy, (mpakSong.title || mpakSong.artist) ? mpakSong : null)
                || (mpakSong.title ? {
                    artist: mpakSong.artist || '',
                    album: mpakSong.album || '',
                    title: mpakSong.title,
                    trackNumber: mpakSong.trackNumber || null,
                    via: 'metadata'
                } : null);
            row.kind = 'song';
            const libMatch = await findMatchingSongInLibrary(mpakSong).catch(() => null);
            if (libMatch && !row.manual) {
                row.status = 'match';
                row.pick = {
                    source: 'library',
                    song: libMatch,
                    title: libMatch.title,
                    artist: libMatch.artist,
                    album: libMatch.album || '',
                    year: libMatch.year || '',
                    trackNumber: libMatch.trackNumber || null,
                    recordingMbid: libMatch.recordingMbid || mpakSong.recordingMbid || '',
                    artistMbid: libMatch.artistMbid || mpakSong.artistMbid || '',
                    albumMbid: libMatch.albumMbid || mpakSong.albumMbid || ''
                };
                row.candidates = [row.pick];
                takeFallback(row);
                markHad(row);
                row.stage = 'done';
                return;
            }
            if ((mpakSong.recordingMbid || mpakSong.albumMbid) && !row.manual) {
                const mb = await lookupMusicBrainzByIds(mpakSong).catch(() => null);
                if (mb && mb.title) {
                    row.status = 'match';
                    row.pick = {
                        source: 'musicbrainz',
                        title: mb.title,
                        artist: mb.artist || mpakSong.artist || '',
                        album: mb.album || mpakSong.album || '',
                        year: mb.year || mpakSong.year || '',
                        trackNumber: mb.trackNumber ?? mpakSong.trackNumber ?? null,
                        length: mb.length ?? mpakSong.length ?? null,
                        recordingMbid: mb.recordingMbid || mpakSong.recordingMbid || '',
                        artistMbid: mb.artistMbid || mpakSong.artistMbid || '',
                        albumMbid: mb.albumMbid || mpakSong.albumMbid || '',
                        coverUrl: mb.coverUrl || ''
                    };
                    row.candidates = [row.pick];
                    takeFallback(row);
                    markHad(row);
                    row.stage = 'done';
                    return;
                }
            }
            if (!row.parsed) { row.stage = 'done'; row.status = 'none'; row.pick = null; row.candidates = []; return; }
        }
        const meta = row.entry.ext === 'mpak' ? null : (state.strategy === 'artist-song' || state.strategy === 'folders' ? null : await embeddedMeta(row.entry));
        if (!row.parsed) row.parsed = pairFile(row.entry, state.strategy, meta);
        if (!row.parsed) { row.stage = 'done'; row.status = 'none'; row.pick = null; row.candidates = []; return; }
        // A whole album's tab book is paired with an album. A file named only for its album is also how a title track is named,
        // so that one is a song when the library has such a song, and otherwise stays a guess for the person to settle.
        const looks = looksLikeAlbumBook(row.parsed, row.entry);
        let kind = row.manualKind ? row.kind : (looks ? 'album' : 'song');
        if (!row.manualKind && looks === 'weak' && state.songs.some((s) => !s.isAlbumTabContainer && sameArtist(s.artist, row.parsed.artist)
            && sameTitle(s.album, row.parsed.album) && sameTitle(s.title, row.parsed.title))) kind = 'song';
        row.kind = kind;
        let found = kind === 'album' ? await lookupAlbum(row.parsed, { songs: state.songs, signal }) : await lookup(row.parsed, { songs: state.songs, signal, knownArtists: state.knownArtists });
        if (kind === 'album' && !row.manualKind && looks === 'weak' && found.status === 'match') found = { ...found, status: 'maybe' };
        if (row.manual) return;
        row.status = found.status;
        row.pick = found.pick;
        row.candidates = found.candidates;
        takeFallback(row);
        markHad(row);
        row.stage = 'done';
    } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') { row.stage = 'queued'; return; }
        console.warn('[Bulk import] Lookup failed for', row.entry.path, err);
        row.stage = 'error';
        row.error = err?.message || 'Lookup failed';
    } finally {
        notify(row.id);
    }
}

/**
 * Files that sit in the same Artist/Album folder are looked up together: one album search and one tracklist fetch resolve every
 * file in the folder that reads as one of its tracks, in place of a search for each file. Folders of fewer than three files cost
 * about the same either way and are left to the per-file lookup, as is anything the album did not settle.
 */
const ALBUM_GROUP_MIN = 3;
async function resolveAlbumGroups(signal) {
    const groups = new Map();
    for (const row of state.rows) {
        if (signal.aborted) return;
        if (row.manual || row.imported || row.stage === 'done') continue;
        let parsed = null;
        if (row.entry.ext === 'mpak') {
            // A pack's album and song are in its manifest. A song the library already has is left to the per-file lookup.
            const song = await packSongOf(row);
            parsed = pairFromPack(song);
            if (parsed && await findMatchingSongInLibrary(song).catch(() => null)) continue;
        } else if (state.strategy !== 'metadata') { // that pairing needs the files read first
            parsed = pairFile(row.entry, state.strategy, null);
        }
        if (!parsed?.artist || !parsed.album || looksLikeAlbumBook(parsed, row.entry)) continue;
        const key = `${normKey(parsed.artist)}|${normName(parsed.album)}`;
        if (!groups.has(key)) groups.set(key, { artist: parsed.artist, album: parsed.album, items: [] });
        groups.get(key).items.push({ row, parsed });
    }
    for (const g of groups.values()) {
        if (signal.aborted) return;
        if (g.items.length < ALBUM_GROUP_MIN) continue;
        let resolved = null;
        try { resolved = await resolveAlbumTracklist(g.artist, g.album, { songs: state.songs, signal }); }
        catch (err) { if (signal.aborted || err?.name === 'AbortError') return; console.warn('[Bulk import] Album lookup failed for', g.artist, g.album, err); }
        if (!resolved) continue;
        // Packs that are parts of one track ("A Change of Seasons" in seven packs) all read as that track, and a pack of two songs reads as one of them: those stay guesses
        const matched = g.items.filter(({ row }) => !row.manual).map(({ row, parsed }) => ({ row, parsed, pick: matchTrack(parsed, resolved) })).filter((m) => m.pick);
        const uses = new Map();
        for (const m of matched) if (m.row.entry.ext === 'mpak') { const k = m.pick.recordingMbid || m.pick.title; uses.set(k, (uses.get(k) || 0) + 1); }
        for (const { row, parsed, pick } of matched) {
            const shared = row.entry.ext === 'mpak' && (uses.get(pick.recordingMbid || pick.title) > 1 || !coversTitle(pick.title, parsed.title));
            Object.assign(row, { parsed, kind: 'song', pick, status: shared ? 'maybe' : 'match', candidates: [pick], stage: 'done', error: '' });
            markHad(row);
            notify(row.id);
        }
    }
}

/** A lookup that failed (MusicBrainz busy, a dropped connection) is tried again, a little later each time, before the row gives up. */
async function resolveWithRetry(row, signal) {
    for (let attempt = 1; ; attempt++) {
        await resolveRow(row, signal);
        if (row.stage !== 'error' || signal?.aborted || attempt >= 3) return;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
}

async function runLookups() {
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.lookingUp = true;
    state.songs = await getAllSongs().catch(() => []);
    const known = new Map();
    const addKnown = (name) => { const key = normKey(name); if (key.length >= 3 && !known.has(key)) known.set(key, name); };
    state.songs.forEach((s) => { if (s.artist && !s.isCustom && s.artist !== 'Unknown Artist') addKnown(s.artist); });
    state.rows.forEach((r) => (r.entry.dirs || []).slice(1).forEach(addKnown));
    state.knownArtists = known;
    notify();
    await resolveAlbumGroups(controller.signal);
    for (const row of state.rows) {
        if (controller.signal.aborted) break;
        if (row.manual || row.stage === 'done' || row.imported) continue;
        await resolveWithRetry(row, controller.signal);
    }
    if (state.controller === controller) { state.lookingUp = false; state.controller = null; }
    markSiblings();
    notify();
}

function restartLookups() {
    state.controller?.abort();
    for (const row of state.rows) {
        if (row.manual || row.imported) continue;
        Object.assign(row, { stage: 'queued', status: 'none', pick: null, candidates: [], before: null, parsed: null, error: '', excluded: false, confirmed: false, forced: false, hadTab: false, adds: null, addsPending: false });
        if (!row.manualKind) row.kind = 'song';
    }
    runLookups();
}

/** Start from a scan result (the folder picker, and the tests that hand one in). */
export function loadScanResult(result) {
    state.controller?.abort();
    state.rootName = result.rootName;
    state.rows = result.entries.map(makeRow);
    state.phase = 'review';
    state.summary = '';
    state.openId = null;
    state.filter = 'all';
    notify();
    if (state.rows.length) runLookups();
}

// --- Import ----------------------------------------------------------------------------------------------------------

/** The switch changed: rows nothing matched take (or give back) the custom music answer. */
function applyCustomFallback() {
    for (const row of state.rows) {
        if (row.manual || row.imported || row.stage !== 'done') continue;
        if (state.customFallback) takeFallback(row);
        else if (row.before) { row.pick = row.before.pick; row.status = row.before.status; row.before = null; }
        markHad(row);
    }
}

/** With the switch on, a row MusicBrainz gave nothing for, or only a guess, becomes custom music (the guess stays a candidate). */
function takeFallback(row) {
    if (!state.customFallback || row.manual || !row.parsed?.title || row.before) return;
    if (row.pick && row.status !== 'maybe') return;
    row.before = { pick: row.pick, status: row.status };
    row.pick = row.kind === 'album' ? customPick({ title: row.parsed.album || row.parsed.title, artist: row.parsed.artist }, 'album') : customPick(row.parsed);
    row.status = 'custom';
}

/** Switch a row between a song and an album's tab book, and look it up again as the other. */
function setKind(row, kind) {
    if (row.kind === kind) return;
    row.kind = kind;
    row.manualKind = true;
    Object.assign(row, { manual: false, excluded: false, confirmed: false, forced: false, hadTab: false, adds: null, addsPending: false, before: null, pick: null, candidates: [], status: 'none', stage: 'queued' });
    notify(row.id);
    resolveRow(row, null);
}

async function songFor(pick) {
    if (pick.source === 'custom') {
        const artist = pick.artist || 'Custom Music';
        const known = state.songs.find((s) => s.isCustom && sameTitle(s.title, pick.title) && sameTitle(s.artist, artist) && sameTitle(s.album, pick.album));
        if (known) return known;
        const song = await saveSongToLibrary({ title: pick.title, artist, album: pick.album, isCustom: true }, DEFAULT_COLLECTION_ID);
        state.songs.push(song);
        return song;
    }
    if (pick.songId) {
        const s = await getSongById(pick.songId);
        if (s) return s;
    }
    const known = state.songs.find((s) => (pick.recordingMbid && s.recordingMbid === pick.recordingMbid)
        || (sameTitle(s.title, pick.title) && sameArtist(s.artist, pick.artist) && (!pick.album || sameTitle(s.album, pick.album))));
    if (known) return known;
    const song = await saveSongToLibrary({
        title: pick.title, artist: pick.artist, artistMbid: pick.artistMbid, album: pick.album, albumMbid: pick.albumMbid,
        recordingMbid: pick.recordingMbid, year: pick.year, length: pick.length, coverUrl: pick.coverUrl,
        trackNumber: pick.trackNumber, mediumNumber: pick.mediumNumber, mediumTitle: pick.mediumTitle, mediumFormat: pick.mediumFormat
    }, DEFAULT_COLLECTION_ID);
    state.songs.push(song);
    return song;
}

/** A tab book goes on the album (under the library's own names when it has the album), not on a song. */
async function importAlbumTab(row, file) {
    const pick = row.pick;
    const artist = pick.artist || 'Custom Music';
    const existing = await getAlbumTabOptions(DEFAULT_COLLECTION_ID, artist, pick.title);
    if (existing.some((t) => t.name === file.name)) return 'skipped';
    const meta = await detectFileMetadata(file, file.name).catch(() => ({}));
    const stored = await saveStoredFile(file, 'local', { name: file.name, type: file.type, relativePath: row.entry.path });
    await addTabOptionToAlbum(DEFAULT_COLLECTION_ID, artist, pick.title, {
        name: file.name, providerId: 'local', relativePath: row.entry.path, fileStoreId: stored.id,
        tuning: meta?.primaryTuning, tunings: meta?.tunings, stringCount: meta?.stringCount,
        fileType: file.name.split('.').pop().toLowerCase(), isCustom: pick.source === 'custom',
        artistMbid: pick.artistMbid, albumMbid: pick.albumMbid, coverUrl: pick.coverUrl, year: pick.year
    });
    return 'done';
}

async function runImport() {
    // What already has a tab is judged by the library as it is now, before this import adds any
    state.songs = await getAllSongs().catch(() => state.songs);
    state.rows.forEach((r) => { if (!r.imported) markHadTab(r); });
    markSiblings();
    audioFilesCache = null;
    for (const r of state.rows) if (!r.imported && r.entry.ext === 'mpak') await computeAdds(r);
    const todo = state.rows.filter((r) => verdict(r) === 'ready' && !r.imported);
    if (!todo.length) { notify(); return; }
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.lookingUp = false;
    state.phase = 'importing';
    state.importDone = 0;
    state.importTotal = todo.length;
    notify();
    let added = 0;
    let skipped = 0;
    let failed = 0;
    for (const row of todo) {
        if (controller.signal.aborted) break;
        try {
            const file = await row.entry.getFile();
            if (row.kind === 'album') {
                if ((await importAlbumTab(row, file)) === 'skipped') { row.imported = 'skipped'; row.note = 'Already added'; skipped++; }
                else { row.imported = 'done'; added++; }
                state.importDone++;
                notify(row.id);
                continue;
            }
            const song = await songFor(row.pick);
            if (row.entry.ext === 'mpak') {
                const saved = await saveMpakToLibrary(file, {
                    targetSongId: song.id,
                    relativePath: row.entry.path,
                    queryMusicBrainz: false
                });
                const updated = saved?.song || song;
                const i = state.songs.findIndex((s) => s.id === song.id);
                if (i >= 0) state.songs[i] = (await getSongById(song.id)) || updated; else state.songs.push(updated);
                row.imported = 'done';
                added++;
            } else if (await songHasSameFile(state.songs.find((s) => s.id === song.id) || song, file, { value: await hashOfBytes(await file.arrayBuffer()) })) {
                // Judged against the song as it is now, including tabs this run has added, and by content, not name
                row.imported = 'skipped';
                row.note = 'Same file already added';
                skipped++;
            } else {
                const { song: updated } = await mapOpenFileToSong(file, song.id, file.name, 'local', row.entry.path);
                const i = state.songs.findIndex((s) => s.id === song.id);
                if (i >= 0) state.songs[i] = (await getSongById(song.id)) || updated; else state.songs.push(updated);
                row.imported = 'done';
                added++;
            }
        } catch (err) {
            console.error('[Bulk import] Could not import', row.entry.path, err);
            row.imported = 'error';
            row.note = 'Could not import';
            failed++;
        }
        state.importDone++;
        notify(row.id);
    }
    state.phase = 'review';
    state.controller = null;
    audioFilesCache = null;
    const parts = [plural(added, 'tab', 'tabs') + ' imported'];
    if (skipped) parts.push(`${skipped} already in the library`);
    if (failed) parts.push(`${failed} failed`);
    if (controller.signal.aborted) parts.unshift('Cancelled');
    state.summary = parts.join(' · ');
    if (added) {
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
        showToast(`Imported ${plural(added, 'tab', 'tabs')}`, 'success');
    }
    notify();
}

// --- The page --------------------------------------------------------------------------------------------------------

function renderTabsImport(container) {
    let alive = true;
    const root = document.createElement('div');
    root.className = 'be-root imp-root';
    container.appendChild(root);
    const searches = new Map(); // row id -> { text, results, busy, error }
    let searchSeq = 0;

    const counts = () => {
        const c = { ready: 0, attention: 0, out: 0, wait: 0, done: 0, have: 0 };
        for (const r of state.rows) c[verdict(r)]++;
        return c;
    };

    function suggestionHtml(row) {
        const p = row.pick;
        if (!p) return `<span class="imp-sugg is-none">${esc(row.parsed ? [row.parsed.artist, row.parsed.title].filter(Boolean).join(' – ') : 'Nothing found in the name or the file')}</span>`;
        const sub = [p.kind === 'album' ? '' : p.album, p.year].filter(Boolean).join(' · ');
        return `<span class="imp-sugg">${esc(p.artist || 'Custom Music')} – ${esc(p.title)}${sub ? `<span class="imp-sub"> · ${esc(sub)}</span>` : ''}</span>`;
    }

    function searchHtml(row) {
        const s = searches.get(row.id) || {};
        const list = s.results || row.candidates || [];
        const album = row.kind === 'album';
        const text = s.text ?? [row.parsed?.artist, album ? (row.parsed?.album || row.parsed?.title) : (row.parsed?.title || baseNameOf(row.entry.name))].filter(Boolean).join(' ');
        const custom = row.pick?.source === 'custom' ? row.pick
            : { title: (album ? (row.parsed?.album || row.parsed?.title) : row.parsed?.title) || baseNameOf(row.entry.name), artist: row.parsed?.artist || '', album: row.parsed?.album || '' };
        const isPdf = row.entry.ext === 'pdf';
        return `
        <div class="imp-search" data-for="${row.id}">
          ${isPdf ? `<div class="imp-kind" role="group" aria-label="This file is">
            <span class="imp-sub">This file is</span>
            <button type="button" class="ct-text imp-kind-btn" data-act="kind" data-kind="song" aria-pressed="${!album}">One song</button>
            <button type="button" class="ct-text imp-kind-btn" data-act="kind" data-kind="album" aria-pressed="${album}">A whole album’s tab book</button>
          </div>` : ''}
          <div class="imp-search-bar">
            <input type="search" class="form-control form-control-sm" data-act="search-text" value="${esc(text)}" aria-label="Search MusicBrainz for this ${album ? 'album' : 'song'}" placeholder="${album ? 'Artist and album' : 'Artist and song'}">
            <button type="button" class="ct-text" data-act="search-go">Search</button>
          </div>
          <div class="imp-results" role="listbox" aria-label="${album ? 'Albums' : 'Songs'} found">
            ${s.busy ? '<p class="ct-sub" role="status">Searching…</p>' : ''}
            ${s.error ? `<p class="ct-error">${esc(s.error)}</p>` : ''}
            ${!s.busy && !s.error && !list.length ? `<p class="ct-sub">Nothing found. Try the ${album ? 'album' : 'song'} name alone, or fewer words.</p>` : ''}
            ${list.map((c, i) => `
              <button type="button" class="imp-result${row.pick && row.pick.source === c.source && sameTitle(row.pick.title, c.title) && sameArtist(row.pick.artist, c.artist) ? ' is-picked' : ''}" role="option" data-act="pick" data-i="${i}">
                <span class="imp-result-main">${esc(c.artist)} – ${esc(c.title)}</span>
                <span class="imp-sub">${esc([c.kind === 'album' ? '' : c.album, c.year, c.source === 'library' ? 'In your library' : ''].filter(Boolean).join(' · '))}</span>
              </button>`).join('')}
          </div>
          <div class="imp-custom">
            <p class="be-option-title">${album ? 'Not on MusicBrainz? Import as a custom album tab book' : 'Not on MusicBrainz? Import as custom music'}</p>
            <div class="imp-custom-fields">
              <input type="text" class="form-control form-control-sm" data-field="title" value="${esc(custom.title)}" aria-label="${album ? 'Album title' : 'Song title'}" placeholder="${album ? 'Album title' : 'Song title'}" autocomplete="off">
              <input type="text" class="form-control form-control-sm" data-field="artist" value="${esc(custom.artist)}" aria-label="Artist" placeholder="Artist (Custom Music)" autocomplete="off">
              ${album ? '' : `<input type="text" class="form-control form-control-sm" data-field="album" value="${esc(custom.album)}" aria-label="Album or folder" placeholder="Album or folder (optional)" autocomplete="off">`}
            </div>
            <button type="button" class="ct-text" data-act="use-custom">${album ? 'Use as custom album tab' : 'Use as custom music'}</button>
          </div>
          <div class="imp-search-foot"><button type="button" class="ct-text" data-act="close-search">Done</button></div>
        </div>`;
    }

    function rowHtml(row) {
        const v = verdict(row);
        const open = state.openId === row.id;
        const via = row.parsed?.via ? VIA_LABEL[row.parsed.via] : '';
        const busy = state.phase === 'importing';
        return `
        <div class="imp-row is-${v}${open ? ' is-open' : ''}" data-row="${row.id}">
          <div class="imp-line">
            <input type="checkbox" class="form-check-input imp-check" data-act="include" aria-label="Import ${esc(row.entry.name)}" ${v === 'ready' ? 'checked' : ''} ${!row.pick || row.imported || busy || v === 'wait' ? 'disabled' : ''}>
            <div class="imp-text">
              <span class="imp-file" title="${esc(row.entry.path)}">${esc(row.entry.path)}</span>
              ${suggestionHtml(row)}
            </div>
            <span class="imp-state">${esc(statusText(row))}${via && row.pick && !row.manual && !row.imported && row.status !== 'library' ? ` · from ${esc(via)}` : ''}</span>
            ${row.imported || busy ? '' : `${row.stage === 'error' ? '<button type="button" class="ct-text imp-retry" data-act="retry">Retry</button>' : ''}<button type="button" class="ct-text imp-change" data-act="change" aria-expanded="${open}">${row.pick ? 'Change' : (row.kind === 'album' ? 'Find album' : 'Find song')}</button>`}
          </div>
          ${open ? searchHtml(row) : ''}
        </div>`;
    }

    function headHtml() {
        const c = counts();
        const total = state.rows.length;
        const parts = [`${plural(total, 'file', 'files')} in ${esc(state.rootName)}`];
        if (c.ready) parts.push(`${c.ready} ready`);
        if (c.attention) parts.push(`${c.attention} need a look`);
        if (c.have) parts.push(`${c.have} already ${c.have === 1 ? 'has a tab' : 'have a tab'}`);
        if (state.lookingUp) parts.push(`Looking up ${state.rows.filter((r) => r.stage === 'done').length} of ${total}`);
        return parts.join(' · ');
    }

    function setupHtml() {
        const files = pickFilesOnly();
        const can = files || canPickFolder();
        return `
        <p class="ct-sub">Choose ${files ? 'tab files' : 'a folder of tabs'} (Guitar Pro, PDF and text files, subfolders included). Each file is paired with a song, checked against your library and MusicBrainz, and shown here for you to look over before anything is imported.</p>
        <fieldset class="imp-strategies">
          <legend class="be-option-title">How the files are named</legend>
          ${STRATEGIES.map((s) => `
            <label class="be-option imp-strategy">
              <input type="radio" class="form-check-input" name="impStrategy" value="${s}" ${state.strategy === s ? 'checked' : ''}>
              <span class="be-option-text"><span class="be-option-title">${esc(STRATEGY_LABEL[s])}${s === 'auto' ? ' (recommended)' : ''}</span></span>
            </label>`).join('')}
          <p class="ct-sub imp-help">${esc(STRATEGY_HELP[state.strategy])}</p>
        </fieldset>
        ${can ? '' : '<p class="ct-note">Importing a folder needs the MajesticTab app on a computer, or Chrome or Edge. Phones can add tabs to a song one at a time.</p>'}
        <div class="be-actions">
          <button type="button" class="btn btn-sm btn-theme-primary" data-act="choose" ${can ? '' : 'disabled'}>${files ? 'Choose files' : 'Choose folder'}</button>
          <span class="be-status" role="status">${esc(state.summary)}</span>
        </div>`;
    }

    function reviewHtml() {
        const c = counts();
        const importing = state.phase === 'importing';
        const shown = state.filter === 'attention' ? state.rows.filter((r) => ['attention', 'wait'].includes(verdict(r)) && !r.imported) : state.rows;
        return `
        <div class="imp-top">
          <div class="be-stats-row" role="status" data-part="head">${headHtml()}</div>
          ${importing ? `<div class="be-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round((state.importDone / Math.max(1, state.importTotal)) * 100)}"><div class="be-progress-fill" style="width:${Math.round((state.importDone / Math.max(1, state.importTotal)) * 100)}%"></div></div>` : ''}
          <div class="be-actions imp-actions">
            <button type="button" class="btn btn-sm btn-theme-primary" data-act="import" ${importing || !c.ready ? 'disabled' : ''}>${importing ? `Importing ${state.importDone} of ${state.importTotal}…` : (c.ready ? `Import ${plural(c.ready, 'tab', 'tabs')}` : 'Import')}</button>
            ${importing ? '<button type="button" class="ct-text" data-act="cancel-import">Cancel</button>' : ''}
            ${importing ? '' : `
            <label class="imp-strategy-pick">
              <span class="imp-sub">Pair by</span>
              <select class="form-select form-select-sm" data-act="strategy" aria-label="How the files are named">
                ${STRATEGIES.map((s) => `<option value="${s}" ${state.strategy === s ? 'selected' : ''}>${esc(STRATEGY_LABEL[s])}</option>`).join('')}
              </select>
            </label>
            ${c.attention || state.filter !== 'all' ? `<button type="button" class="ct-text" data-act="${state.filter === 'all' ? 'only-attention' : 'show-all'}">${state.filter === 'all' ? (c.attention === 1 ? 'Show the one that needs a look' : `Show the ${c.attention} that need a look`) : 'Show all'}</button>` : ''}
            <button type="button" class="ct-text" data-act="select-all">Select all</button>
            <button type="button" class="ct-text" data-act="select-none">Select none</button>
            <button type="button" class="ct-text" data-act="choose">Choose another folder</button>`}
          </div>
          ${importing ? '' : `<label class="be-option imp-fallback"><input type="checkbox" class="form-check-input" data-act="skip-existing" ${state.skipExisting ? 'checked' : ''}><span class="be-option-text"><span class="be-option-title">Skip files that add nothing new</span><span class="be-option-sub">A tab file is left out when its song, or its album’s tab book, already has a tab. A pack is left out when its song already has its score, stems, audio and sync data. Check its row to import it anyway.</span></span></label>`}
          ${importing ? '' : `<label class="be-option imp-fallback"><input type="checkbox" class="form-check-input" data-act="custom-fallback" ${state.customFallback ? 'checked' : ''}><span class="be-option-text"><span class="be-option-title">Import files with no good match as custom music</span><span class="be-option-sub">MusicBrainz is tried first. Songs it cannot find, or only guesses at, are saved under the names from the file.</span></span></label>`}
          ${state.summary ? `<div class="be-status" role="status">${esc(state.summary)}</div>` : ''}
        </div>
        ${state.rows.length === 0 ? '<p class="ct-empty">No Guitar Pro, PDF or text files were found in that folder.</p>' : ''}
        <div class="imp-list">${shown.map(rowHtml).join('')}</div>`;
    }

    function render() {
        if (!alive || !root.isConnected) return;
        if (state.phase === 'scanning') {
            root.innerHTML = `<div class="be-stats-row" role="status">Looking through the folder… ${plural(state.foundCount, 'file', 'files')} so far</div>
              <div class="be-actions"><button type="button" class="ct-text" data-act="cancel-scan">Cancel</button></div>`;
        } else if (state.phase === 'setup') root.innerHTML = setupHtml();
        else root.innerHTML = reviewHtml();
    }

    /** One row (and the header counts) changed: redraw only those, so a long list stays steady while lookups arrive. */
    function patch(id) {
        if (!alive || !root.isConnected) return;
        if (!id || state.phase === 'setup' || state.phase === 'scanning') { render(); return; }
        const el = root.querySelector(`[data-row="${id}"]`);
        const row = state.rows.find((r) => r.id === id);
        if (el && row) {
            const hadFocus = el.contains(document.activeElement);
            el.outerHTML = rowHtml(row);
            if (hadFocus && state.openId === id) root.querySelector(`[data-row="${id}"] [data-act="search-text"]`)?.focus();
        }
        const head = root.querySelector('[data-part="head"]');
        if (head) head.innerHTML = headHtml();
        const importBtn = root.querySelector('[data-act="import"]');
        if (importBtn && state.phase === 'review') {
            const n = counts().ready;
            importBtn.textContent = n ? `Import ${plural(n, 'tab', 'tabs')}` : 'Import';
            importBtn.disabled = !n;
        } else if (state.phase === 'importing') {
            const bar = root.querySelector('.be-progress-fill');
            if (bar) bar.style.width = `${Math.round((state.importDone / Math.max(1, state.importTotal)) * 100)}%`;
            const btn = root.querySelector('[data-act="import"]');
            if (btn) btn.textContent = `Importing ${state.importDone} of ${state.importTotal}…`;
        }
    }

    const onChange = (id) => patch(id);
    listeners.add(onChange);

    async function choose() {
        const controller = new AbortController();
        state.scanController = controller;
        state.foundCount = 0;
        const previous = state.phase;
        try {
            state.phase = 'scanning';
            render();
            const result = await pickAndScanFolder((n) => {
                state.foundCount = n;
                if (n % 25 === 0) render();
            }, controller.signal);
            if (!alive && !result) return;
            if (!result || controller.signal.aborted) { state.phase = previous === 'scanning' ? 'setup' : previous; state.scanController = null; notify(); return; }
            state.scanController = null;
            loadScanResult(result);
        } catch (err) {
            console.error('[Bulk import] Could not read the folder:', err);
            state.phase = previous === 'scanning' ? 'setup' : previous;
            state.scanController = null;
            showToast('Could not read that folder', 'error');
            notify();
        }
    }

    async function runSearch(rowId) {
        const row = state.rows.find((r) => r.id === rowId);
        const input = root.querySelector(`[data-for="${rowId}"] [data-act="search-text"]`);
        if (!row || !input) return;
        const text = input.value.trim();
        const seq = ++searchSeq;
        searches.set(rowId, { text, results: null, busy: Boolean(text), error: '' });
        patch(rowId);
        if (!text) return;
        try {
            const results = row.kind === 'album' ? await searchAlbums(text) : await searchSongs(text);
            if (seq !== searchSeq) return;
            searches.set(rowId, { text, results, busy: false, error: '' });
        } catch (err) {
            if (seq !== searchSeq) return;
            searches.set(rowId, { text, results: [], busy: false, error: `Search failed: ${err?.message || 'no answer from MusicBrainz'}` });
        }
        patch(rowId);
    }

    root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || !root.contains(btn)) return;
        const act = btn.dataset.act;
        const rowEl = btn.closest('[data-row]');
        const searchEl = btn.closest('[data-for]');
        const rowId = rowEl?.dataset.row || searchEl?.dataset.for;
        const row = state.rows.find((r) => r.id === rowId);
        if (act === 'choose') choose();
        else if (act === 'cancel-scan') { state.scanController?.abort(); }
        else if (act === 'import') holdSync(runImport);
        else if (act === 'cancel-import') state.controller?.abort();
        else if (act === 'select-all' || act === 'select-none') {
            // Every row in view that has a song or album to go to; “Check this” rows count as looked at. Rows left out for
            // already having a tab stay out while that switch is on (check a row by hand to import it anyway).
            const on = act === 'select-all';
            const inView = state.filter === 'attention' ? state.rows.filter((r) => ['attention', 'wait'].includes(verdict(r)) && !r.imported) : state.rows;
            for (const r of inView) {
                if (!r.pick || r.imported) continue;
                r.excluded = !on;
                if (on) r.confirmed = true;
            }
            render();
        }
        else if (act === 'only-attention') { state.filter = 'attention'; render(); }
        else if (act === 'show-all') { state.filter = 'all'; render(); }
        else if (act === 'change' && row) {
            const prev = state.openId;
            state.openId = state.openId === row.id ? null : row.id;
            if (prev && prev !== row.id) patch(prev);
            patch(row.id);
            root.querySelector(`[data-row="${row.id}"] [data-act="search-text"]`)?.focus();
        } else if (act === 'retry' && row) {
            Object.assign(row, { stage: 'queued', error: '' });
            patch(row.id);
            resolveWithRetry(row, null).then(() => { markSiblings(); notify(); });
        } else if (act === 'close-search' && row) { state.openId = null; patch(row.id); root.querySelector(`[data-row="${row.id}"] [data-act="change"]`)?.focus(); }
        else if (act === 'search-go' && row) runSearch(row.id);
        else if (act === 'kind' && row) { searches.delete(row.id); setKind(row, btn.dataset.kind); patch(row.id); }
        else if (act === 'use-custom' && row) {
            const field = (n) => searchEl?.querySelector(`[data-field="${n}"]`)?.value.trim() || '';
            const title = field('title');
            if (!title) { searchEl?.querySelector('[data-field="title"]')?.focus(); return; }
            row.pick = customPick({ title, artist: field('artist'), album: field('album') }, row.kind);
            row.status = 'custom';
            row.manual = true;
            row.excluded = false;
            row.forced = false;
            markHad(row);
            row.stage = 'done';
            row.dupSeen = true; // a song the person chose is theirs: never left out as a sibling
            markSiblings();
            state.openId = null;
            render();
            root.querySelector(`[data-row="${row.id}"] [data-act="change"]`)?.focus();
        }
        else if (act === 'pick' && row) {
            const s = searches.get(row.id);
            const list = s?.results || row.candidates;
            const chosen = list?.[Number(btn.dataset.i)];
            if (!chosen) return;
            row.pick = chosen;
            row.manual = true;
            row.status = chosen.source === 'library' ? 'library' : 'match';
            row.excluded = false;
            row.forced = false;
            markHad(row);
            row.stage = 'done';
            row.dupSeen = true; // a song the person chose is theirs: never left out as a sibling
            markSiblings();
            state.openId = null;
            render();
            root.querySelector(`[data-row="${row.id}"] [data-act="change"]`)?.focus();
        }
    });
    root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.name === 'impStrategy') { state.strategy = t.value; render(); return; }
        if (t.dataset.act === 'strategy') { state.strategy = t.value; if (state.rows.length) { restartLookups(); render(); } return; }
        if (t.dataset.act === 'skip-existing') { state.skipExisting = t.checked; render(); return; }
        if (t.dataset.act === 'custom-fallback') { state.customFallback = t.checked; applyCustomFallback(); render(); return; }
        if (t.dataset.act === 'include') {
            const row = state.rows.find((r) => r.id === t.closest('[data-row]')?.dataset.row);
            if (row) {
                row.excluded = !t.checked;
                if (t.checked) { row.confirmed = true; row.forced = true; }
                markSiblings();
                render();
            }
        }
    });
    root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.dataset?.act === 'search-text') {
            e.preventDefault();
            runSearch(e.target.closest('[data-for]')?.dataset.for);
        } else if (e.key === 'Escape' && state.openId && e.target.closest?.('[data-for]')) {
            e.stopPropagation();
            const id = state.openId;
            state.openId = null;
            patch(id);
            root.querySelector(`[data-row="${id}"] [data-act="change"]`)?.focus();
        }
    });

    render();
    // Lookups started before the page was left carry on; the page shows where they are
    return () => {
        alive = false;
        listeners.delete(onChange);
    };
}

// --- The two modes ---------------------------------------------------------------------------------------------------

let mode = 'tabs'; // 'tabs' | 'audio'; kept while Tools is left, like each mode's own review

export function renderBulkImportTool(container) {
    const host = document.createElement('div');
    host.className = 'imp-modes';
    container.appendChild(host);
    const bar = document.createElement('div');
    bar.className = 'imp-kind imp-mode-bar';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'What to import');
    const body = document.createElement('div');
    host.append(bar, body);
    let dispose = null;
    const show = () => {
        dispose?.();
        body.replaceChildren();
        bar.innerHTML = ['tabs', 'audio'].map((m) => `<button type="button" class="ct-text imp-kind-btn" data-mode="${m}" aria-pressed="${mode === m}">${m === 'tabs' ? 'Tabs' : 'Audio files'}</button>`).join('');
        dispose = mode === 'audio' ? renderAudioImport(body) : renderTabsImport(body);
    };
    bar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-mode]');
        if (!btn || btn.dataset.mode === mode) return;
        mode = btn.dataset.mode;
        show();
        bar.querySelector(`[data-mode="${mode}"]`)?.focus();
    });
    show();
    return () => dispose?.();
}
