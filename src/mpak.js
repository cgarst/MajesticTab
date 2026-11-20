// mpak.js
// The .mpak song bundle (Music Pack v1 specification): a ZIP container with `manifest.json`, `score/<name>` (or `score.externalPath` for shared PDFs),
// `audio/<name>` (stored), and `sync/<id>.json`.

import {
    MEDIA_TYPE,
    ANCHOR,
    MpakError,
    sha256,
    derivedPackId,
    bytesSource,
    readDirectory,
    readEntry,
    openMpak as coreOpenMpak,
    buildMpak as coreBuildMpak,
    placeBarTimes,
    isBarTimes,
} from './mpak/core/index.js';
import { decodeText } from './utils/decodeText.js';
import { linkSets } from './tabSets.js';
import { newPackId } from './mpakSession.js';
import { toSyncPoints, fromSyncPoints } from './audioSync/syncStore.js';
import { fitBarPoints } from './audioSync/fitBarPoints.js';
import { unitsToPoints, scoreSyncKey, legacyScoreSyncKey, textBlocksOf } from './audioSync/anchors.js';

export const MPAK_FORMAT = 'mpak';
export const MPAK_VERSION = 1;
export const MPAK_EXTENSION = 'mpak';

const SLOTS = ['original', 'backing'];
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
/** What a pack `id` may be (SPEC section 4): 1 to 64 of A-Z a-z 0-9 _ - */
const PACK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isPackId = (v) => typeof v === 'string' && PACK_ID_RE.test(v);
const PITCH_RE = /^[A-G][#b]?(-?[0-9])?$/;

const MIME_BY_FORMAT = {
    gp3: 'application/octet-stream',
    gp4: 'application/octet-stream',
    gp5: 'application/octet-stream',
    gp: 'application/octet-stream',
    gpx: 'application/octet-stream',
    musicxml: 'application/vnd.recordare.musicxml+xml',
    mxl: 'application/vnd.recordare.musicxml',
    mscz: 'application/octet-stream',
    midi: 'audio/midi',
    abc: 'text/plain;charset=utf-8',
    pdf: 'application/pdf',
    txt: 'text/plain;charset=utf-8',
};

// The score formats the reader can display. The others are valid in a .mpak file but are rejected on open.
const SUPPORTED_SCORE_FORMATS = ['gp3', 'gp4', 'gp5', 'gp', 'gpx', 'pdf', 'txt'];
const SCORE_FORMAT_NAMES = { musicxml: 'MusicXML', mxl: 'MusicXML', mscz: 'MuseScore', midi: 'MIDI', abc: 'ABC notation' };

// File extensions that name a score format under another spelling.
const FORMAT_BY_EXTENSION = { mid: 'midi', kar: 'midi', xml: 'musicxml' };

const enc = (s) => encodeURIComponent(String(s).toLowerCase());

export const isMpakFile = (file) => /\.mpak$/i.test(file?.name || '');

/**
 * True when the bytes are a ZIP whose `manifest.json` says `format: "mpak"`. There is no magic number to read: a file
 * is recognised by its extension or, for bytes with no usable name, by this check. Never throws.
 */
export async function isMpakBytes(bytes) {
    try {
        if (!bytes) return false;
        const u8 = bytes instanceof Uint8Array
            ? bytes
            : (bytes instanceof ArrayBuffer
                ? new Uint8Array(bytes)
                : (ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null));
        if (!u8 || u8.length < 30 || u8[0] !== 0x50 || u8[1] !== 0x4b) return false;
        const source = bytesSource(u8);
        const entry = (await readDirectory(source)).find((e) => e.name === 'manifest.json');
        if (!entry) return false;
        const manifest = JSON.parse(new TextDecoder().decode(await readEntry(source, entry, { maxSize: 1 << 20 })));
        return manifest?.format === MPAK_FORMAT;
    } catch {
        return false;
    }
}

/** Normalize `song` metadata (including MusicBrainz IDs in direct fields or v1 `ids.musicbrainz` / legacy `musicbrainz`). */
export function normalizeMpakSong(rawSong = {}, rawHeader = {}) {
    const s = (rawSong && typeof rawSong === 'object') ? rawSong : {};
    const mb = (s.ids?.musicbrainz && typeof s.ids.musicbrainz === 'object')
        ? s.ids.musicbrainz
        : ((s.musicbrainz && typeof s.musicbrainz === 'object')
            ? s.musicbrainz
            : ((rawHeader?.musicbrainz && typeof rawHeader.musicbrainz === 'object') ? rawHeader.musicbrainz : {}));

    const recordingMbid = String(s.recordingMbid || mb.recordingMbid || mb.recordingId || mb.recording || '').trim() || null;
    const artistMbid = String(s.artistMbid || mb.artistMbid || mb.artistId || mb.artist || '').trim() || null;
    const releaseMbid = String(s.releaseMbid || mb.release || mb.releaseId || '').trim() || null;
    const albumMbid = String(
        s.albumMbid || s.releaseGroupMbid || s.releaseGroupId ||
        mb.albumMbid || mb.releaseGroupMbid || mb.releaseGroupId || mb.releaseGroup ||
        mb.albumId || s.releaseId || mb.releaseId || mb.release || ''
    ).trim() || null;

    const normalized = {
        artist: String(s.artist || '').trim(),
        title: String(s.title || '').trim(),
    };

    if (s.composer && String(s.composer).trim()) normalized.composer = String(s.composer).trim();
    if (s.album && String(s.album).trim()) normalized.album = String(s.album).trim();
    if (s.year !== undefined && s.year !== null && s.year !== '') normalized.year = s.year;
    if (s.trackNumber !== undefined && s.trackNumber !== null && s.trackNumber !== '') {
        const tn = parseInt(s.trackNumber, 10);
        if (!Number.isNaN(tn)) normalized.trackNumber = tn;
    }
    if (s.mediumNumber !== undefined && s.mediumNumber !== null && s.mediumNumber !== '') {
        const mn = parseInt(s.mediumNumber, 10);
        if (!Number.isNaN(mn)) normalized.mediumNumber = mn;
    }
    if (s.length !== undefined && s.length !== null && s.length !== '') {
        const len = typeof s.length === 'number' ? s.length : parseInt(s.length, 10);
        if (!Number.isNaN(len)) normalized.length = len;
    }
    if (s.coverUrl && String(s.coverUrl).trim()) normalized.coverUrl = String(s.coverUrl).trim();

    if (recordingMbid) normalized.recordingMbid = recordingMbid;
    if (artistMbid) normalized.artistMbid = artistMbid;
    if (albumMbid) normalized.albumMbid = albumMbid;
    if (releaseMbid) normalized.releaseMbid = releaseMbid;
    if (recordingMbid || artistMbid || albumMbid || releaseMbid) {
        normalized.musicbrainz = {
            ...(recordingMbid ? { recordingMbid } : {}),
            ...(artistMbid ? { artistMbid } : {}),
            ...(albumMbid ? { albumMbid } : {}),
            ...(releaseMbid ? { releaseMbid } : {}),
        };
    }

    return normalized;
}

/** The tuning the player set by hand for the open tab (PDF or text), or null. */
async function manualTuning(file) {
    if (file.tabTuning?.source === 'user' && file.tabTuning.tuning) return file.tabTuning.tuning;
    if (!file.librarySongId) return null;
    try {
        const { getSongById } = await import('./libraryStore.js');
        const tab = (await getSongById(file.librarySongId))?.tabOptions?.find((t) => t.id === file.tabId);
        return tab?.tuningSource === 'user' && tab.tuning ? tab.tuning : null;
    } catch { return null; }
}

function toManifestTuning(raw) {
    if (!raw) return null;
    const items = Array.isArray(raw) ? raw : String(raw).trim().split(/[\s,]+/);
    const clean = items.map((s) => String(s).trim()).filter(Boolean);
    if (!clean.length || !clean.every((s) => PITCH_RE.test(s))) return null;
    return clean;
}

function sanitizeSegment(name, fallback) {
    const base = String(name || '').split(/[\\/]/).pop() || '';
    const cleaned = base.replace(/[\u0000-\u001f\\]/g, '_').replace(/^\.+$/, '');
    return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

function inferTabFormat(file) {
    const ext = String(file?.name || '').split('.').pop().toLowerCase();
    if (ext && ext in ANCHOR) return ext;
    if (FORMAT_BY_EXTENSION[ext]) return FORMAT_BY_EXTENSION[ext];
    if (file?.type === 'application/pdf') return 'pdf';
    if (String(file?.type || '').startsWith('text/')) return 'txt';
    return 'gp5';
}

function buildManifestSong(norm) {
    const song = {};
    if (norm.title) song.title = norm.title;
    if (norm.artist) song.artist = norm.artist;
    if (norm.composer) song.composer = norm.composer;
    if (norm.album) song.album = norm.album;
    if (Number.isInteger(norm.year)) song.year = norm.year;
    if (Number.isInteger(norm.trackNumber) && norm.trackNumber >= 0) song.trackNumber = norm.trackNumber;
    if (Number.isInteger(norm.mediumNumber) && norm.mediumNumber >= 0) song.mediumNumber = norm.mediumNumber;
    if (Number.isInteger(norm.length) && norm.length >= 0) song.length = norm.length;

    const mb = {};
    if (norm.recordingMbid && UUID_RE.test(norm.recordingMbid)) mb.recording = norm.recordingMbid;
    if (norm.artistMbid && UUID_RE.test(norm.artistMbid)) mb.artist = norm.artistMbid;
    if (norm.albumMbid && UUID_RE.test(norm.albumMbid)) mb.releaseGroup = norm.albumMbid;
    if (norm.releaseMbid && UUID_RE.test(norm.releaseMbid)) mb.release = norm.releaseMbid;
    if (Object.keys(mb).length) song.ids = { musicbrainz: mb };

    return Object.keys(song).length ? song : null;
}

// The sync store keeps the points of a text or PDF tab apart from the bar points of a Guitar Pro tab, under a key that
// names the score file (anchors.js). A record there holds Music Pack sync points already (syncStore.js), so it is written
// to the archive as it is; only a record from before that, whose points are units, is converted.
const syncKeyFor = (anchorType, songKey, scoreSha256) => (anchorType === 'bar' ? songKey : scoreSyncKey(songKey, scoreSha256));

const isUtf8 = (bytes) => {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
};

/**
 * A stored record as a sync file (SPEC section 9). Its points are Music Pack sync points already. A record of units (kept
 * before points were stored as lines and pages) is converted with the score it was made for. Returns null when the record
 * is for another kind of score than `anchorType`.
 */
function toV1SyncFile(rec, recordingId, scoreId, anchorType, { firstPage = 1, lastPage = null, pageOffset = 0, blocks = null } = {}) {
    let points = rec.points;
    if (rec.anchorType === 'unit') points = unitsToPoints(points, anchorType, { firstPage, blocks: blocks || [] });
    else if (rec.anchorType !== anchorType) return null;
    if (anchorType === 'pdf') points = points.filter((p) => p.page >= firstPage && (!lastPage || p.page <= lastPage));
    // A pack that holds only its pages numbers them from 1: the store's points name the pages of the whole book
    if (anchorType === 'pdf' && pageOffset) points = points.map((p) => ({ ...p, page: p.page - pageOffset }));
    const seenTimes = new Set();
    const out = [];
    for (const p of toSyncPoints([...points].sort((a, b) => a.timeMs - b.timeMs), anchorType)) {
        if (!Number.isFinite(p.timeMs) || p.timeMs < 0) continue;
        let t = p.timeMs;
        while (seenTimes.has(t)) t += 1;
        seenTimes.add(t);
        out.push({ ...p, timeMs: t });
    }
    return {
        version: 1,
        recording: recordingId,
        score: scoreId,
        anchorType,
        updatedAt: new Date(Number.isFinite(rec.updatedAt) && rec.updatedAt > 0 ? rec.updatedAt : Date.now()).toISOString(),
        points: out,
    };
}

const STORED_ANCHORS = ['bar', 'pdf', 'text'];
// The formats whose repeats the spec defines (SPEC section 9.1, "Played bars"); a list of bar times is not used on the others when they repeat
const GP_FORMATS = ['gp3', 'gp4', 'gp5', 'gp', 'gpx'];

/**
 * Does a score's file name belong to this song? A name like "guitar-1-tablature" is the same in every pack of a set, so a song
 * key made from it would be shared by all those songs. A name that carries the song's title is the song's own.
 */
export function isSongSpecificName(baseName, title) {
    const flat = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const t = flat(title);
    return Boolean(t) && flat(baseName).includes(t);
}

function rememberLibrarySongKey(librarySongId, key, meta = {}) {
    if (!librarySongId || !key) return;
    try {
        const storageKey = `yt_song_keys_${librarySongId}`;
        const raw = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const list = raw.map(item => (typeof item === 'string' ? { key: item } : item));
        const entry = {
            key,
            filename: meta.filename || '',
            tabName: meta.tabName || '',
            sourceWebsite: meta.sourceWebsite || null,
            sourceUrl: meta.sourceUrl || null,
        };
        const existingIdx = list.findIndex(e => e.key && e.key.toLowerCase() === key.toLowerCase());
        if (existingIdx >= 0) {
            list[existingIdx] = { ...list[existingIdx], ...entry };
        } else {
            list.push(entry);
        }
        localStorage.setItem(storageKey, JSON.stringify(list.slice(-20)));
    } catch { /* optional */ }
}

/**
 * A PDF cut down to the pages a song uses, for a pack of one song from a book. Returns `{ bytes, pages, firstPage, lastPage }`
 * (the book pages it covers), or null when there is nothing to cut: no range, the range is the whole file, pdf-lib is not
 * loaded or the file cannot be read. The caller then stores the PDF whole with its range.
 */
async function trimPdfToRange(bytes, startPage, endPage) {
    const lib = globalThis.PDFLib;
    const hasStart = Number.isInteger(startPage) && startPage >= 1;
    const hasEnd = Number.isInteger(endPage) && endPage >= 1;
    if (!lib?.PDFDocument || (!hasStart && !hasEnd)) return null;
    try {
        const src = await lib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
        const total = src.getPageCount();
        const firstPage = Math.min(total, hasStart ? startPage : 1);
        const lastPage = Math.max(firstPage, Math.min(total, hasEnd ? endPage : total));
        if (firstPage === 1 && lastPage === total) return null;
        const out = await lib.PDFDocument.create();
        const indices = Array.from({ length: lastPage - firstPage + 1 }, (_, i) => firstPage - 1 + i);
        for (const page of await out.copyPages(src, indices)) out.addPage(page);
        return { bytes: new Uint8Array(await out.save()), pages: indices.length, firstPage, lastPage };
    } catch (e) {
        console.warn('[mpak] could not cut the PDF to its pages, storing it whole:', e);
        return null;
    }
}

/** The pages of a score's file that its sync points may name, and how far the store's page numbers shift to fit the file. */
const syncWindowOf = (run) => (run.trimmed
    ? { firstPage: run.trimmed.firstPage, lastPage: run.trimmed.lastPage, pageOffset: run.trimmed.firstPage - 1 }
    : { firstPage: run.entry.startPage || 1, lastPage: run.entry.endPage || run.entry.pages || null });

/**
 * The other tabs of the open song that can go in its pack: the ones in the library whose file is stored on this device and
 * that the app can show. Returns inputs for `buildMpak`'s `scores` option. Never throws.
 */
export async function otherLibraryScores(file) {
    if (!file?.librarySongId) return [];
    try {
        const { getSongById } = await import('./libraryStore.js');
        const { getStoredFile } = await import('./fileStore.js');
        const song = await getSongById(file.librarySongId);
        const out = [];
        for (const t of song?.tabOptions || []) {
            if (t.id === file.tabId || !t.fileStoreId) continue;
            const stored = await getStoredFile(t.fileStoreId);
            const f = stored?.file;
            if (!f || !SUPPORTED_SCORE_FORMATS.includes(inferTabFormat(f))) continue;
            out.push({
                file: f,
                label: t.name && t.name !== f.name ? t.name : undefined,
                origin: typeof t.origin === 'string' && t.origin ? t.origin : undefined,
                tuning: t.tuningSource === 'user' ? t.tuning : null,
                startPage: Number.isInteger(t.startPage) ? t.startPage : undefined,
                endPage: Number.isInteger(t.endPage) ? t.endPage : undefined,
            });
        }
        return out;
    } catch { return []; }
}

/**
 * Builds a v1 .mpak bundle for the open song. Returns `{ blob, filename }`. The open tab is the primary score. The song's
 * other tabs that are stored on this device go in as more scores, each with its own sync; `options.scores` replaces that
 * list (inputs `{ file, label?, origin?, tuning?, startPage?, endPage?, pages? }`).
 */
export async function buildMpak(file, options = {}) {
    const { getAudioFile } = await import('./audioSync/audioFileStore.js');
    const { listRecords, isSyncSharedFromOriginal, mediaKey } = await import('./audioSync/syncStore.js');

    let songKey = options.songKey || '';
    let activeArtist = '';
    let activeTitle = '';
    if (!songKey || !options.song) {
        try {
            const { getSongKey, playerState } = await import('./soundPlayer.js');
            if (!songKey) songKey = getSongKey();
            activeArtist = playerState?.artist || '';
            activeTitle = playerState?.title || '';
        } catch { /* headless environment */ }
    }

    let getSlotSourceFn = (slot) => {
        const val = localStorage.getItem(`real_audio_source_${enc(songKey)}_${slot}`);
        return (val === 'local' || val === 'embedded' || val === 'youtube') ? val : 'youtube';
    };
    if (!options.songKey) {
        try {
            const { getSlotSource } = await import('./audioSync/realAudioController.js');
            getSlotSourceFn = getSlotSource;
        } catch { /* headless environment */ }
    }

    let libSong = options.song || null;
    if (!libSong && file?.librarySongId) {
        try {
            const { getSongById } = await import('./libraryStore.js');
            libSong = await getSongById(file.librarySongId);
        } catch { /* optional */ }
    }

    const priorMpakSong = (file?.mpakSong && typeof file.mpakSong === 'object') ? file.mpakSong : {};
    const rawSongMeta = {
        artist: options.song?.artist || activeArtist || libSong?.artist || priorMpakSong.artist || file?.artist || '',
        title: options.song?.title || activeTitle || libSong?.title || priorMpakSong.title || file?.songTitle || '',
        album: options.song?.album || (libSong?.album && libSong.album !== 'Unknown Album' ? libSong.album : '') || priorMpakSong.album || file?.album || '',
        year: options.song?.year ?? libSong?.year ?? priorMpakSong.year ?? null,
        trackNumber: options.song?.trackNumber ?? libSong?.trackNumber ?? priorMpakSong.trackNumber ?? null,
        mediumNumber: options.song?.mediumNumber ?? libSong?.mediumNumber ?? priorMpakSong.mediumNumber ?? null,
        length: options.song?.length ?? libSong?.length ?? priorMpakSong.length ?? null,
        recordingMbid: options.song?.recordingMbid || libSong?.recordingMbid || priorMpakSong.recordingMbid || file?.recordingMbid || null,
        artistMbid: options.song?.artistMbid || libSong?.artistMbid || priorMpakSong.artistMbid || file?.artistMbid || null,
        albumMbid: options.song?.albumMbid || libSong?.albumMbid || priorMpakSong.albumMbid || file?.albumMbid || null,
        releaseMbid: options.song?.releaseMbid || priorMpakSong.releaseMbid || null,
        musicbrainz: options.song?.musicbrainz || priorMpakSong.musicbrainz || null,
    };

    const normSong = normalizeMpakSong(rawSongMeta);
    // The scores of the file: the open tab first (the primary score), then the song's other tabs the caller passes.
    // Each score has its own sync (SPEC section 6.2), found by what names its points in the store.
    const files = new Map();
    const manifestScores = [];
    const scoreRuns = [];
    const usedScoreIds = new Set();
    const usedScorePaths = new Set();
    let barSyncTaken = false;
    const seenScores = new Set();
    // The open tab's set (src/tabSets.js): from its library tab, else from the pack it was opened from
    const primaryTab = libSong?.tabOptions?.find((t) => t.id === file?.tabId);
    const primaryOrigin = primaryTab?.origin || file?.mpakOrigin || undefined;
    // The open tab's name, when it is not just its file name, as the other scores carry theirs (otherLibraryScores)
    const primaryLabel = (primaryTab?.name && primaryTab.name !== file?.name ? primaryTab.name : file?.mpakLabel) || undefined;
    const inputs = [{ file, label: primaryLabel, origin: primaryOrigin, tuning: await manualTuning(file), startPage: options.startPage ?? file.mpakPageRange?.startPage ?? file.startPage, endPage: options.endPage ?? file.mpakPageRange?.endPage ?? file.endPage, pages: options.pages ?? file.mpakPageRange?.pages }, ...(options.scores ?? await otherLibraryScores(file))];
    for (const input of inputs) {
        const sFile = input.file;
        const format = inferTabFormat(sFile);
        const sName = sFile.name || `score.${format}`;
        let bytes = new Uint8Array(await sFile.arrayBuffer());
        // The tab's own hash names its sync records, even when the bytes are converted below
        const openSha256 = await sha256(bytes);
        // The same file twice (and the same pages of it) is one score
        const dupKey = `${openSha256}:${input.startPage ?? ''}:${input.endPage ?? ''}`;
        if (seenScores.has(dupKey)) continue;
        seenScores.add(dupKey);
        let id = format, n = 2;
        while (usedScoreIds.has(id)) id = `${format}-${n++}`;
        usedScoreIds.add(id);
        let path = `score/${sanitizeSegment(sName, `score.${format}`)}`;
        if (usedScorePaths.has(path.toLowerCase())) path = `score/${id}-${sanitizeSegment(sName, `score.${format}`)}`;
        usedScorePaths.add(path.toLowerCase());
        // A text score must be UTF-8 in the file (SPEC section 6): convert one in another encoding and hash the converted bytes.
        if (format === 'txt' && !isUtf8(bytes)) bytes = new TextEncoder().encode(decodeText(bytes));
        // A song from a book goes in with only its own pages (options.trimPdf false keeps the whole book and the range)
        const trimmed = format === 'pdf' && options.trimPdf !== false ? await trimPdfToRange(bytes, input.startPage, input.endPage) : null;
        if (trimmed) bytes = trimmed.bytes;
        files.set(path, bytes);
        const entry = { id, path, format, sha256: await sha256(bytes), name: sName };
        if (input.label) entry.label = input.label;
        if (typeof input.origin === 'string' && input.origin) entry.origin = input.origin; // SPEC section 6.4
        const tuningArr = toManifestTuning(input.tuning);
        if (tuningArr) entry.instruments = [{ tuning: tuningArr }];
        if (trimmed) {
            // The file is the song's pages alone: the whole file is the song, so no range (SPEC section 6.1)
            entry.pages = trimmed.pages;
        } else if (format === 'pdf') {
            if (Number.isInteger(input.pages) && input.pages >= 1) entry.pages = input.pages;
            if (Number.isInteger(input.startPage) && input.startPage >= 1) entry.startPage = input.startPage;
            if (Number.isInteger(input.endPage) && input.endPage >= 1) entry.endPage = input.endPage;
        }
        manifestScores.push(entry);

        // Where this score's points are kept: by song for Guitar Pro bars (one set a song, so only the first score of
        // that kind gets them), by song and score file for a text or PDF tab. Records an earlier version shared between
        // a song's text and PDF tabs are read as well.
        const anchorType = ANCHOR[format];
        const run = { entry, anchorType, bytes, trimmed, recordsByMedia: new Map(), syncKey: null, legacyKey: null };
        if (anchorType === 'bar' && !barSyncTaken) { barSyncTaken = true; run.syncKey = songKey; }
        else if (anchorType === 'pdf' || anchorType === 'text') { run.syncKey = scoreSyncKey(songKey, openSha256); run.legacyKey = legacyScoreSyncKey(songKey); }
        if (run.syncKey) {
            for (const rec of [...(run.legacyKey ? listRecords(run.legacyKey) : []), ...listRecords(run.syncKey)]) {
                const k = mediaKey(rec.media);
                if (!k || !rec.points?.length) continue;
                // a legacy record of the other kind of score is not this tab's
                if (rec.anchorType !== 'unit' && rec.anchorType !== anchorType) continue;
                const have = run.recordsByMedia.get(k);
                if (!have || rec.updatedAt >= have.updatedAt) run.recordsByMedia.set(k, rec);
            }
        }
        scoreRuns.push(run);
    }
    const primary = scoreRuns[0];
    const tabFormat = primary.entry.format;
    const name = primary.entry.name;

    // The pack's identity (SPEC section 4): the library song's own id when a pack can use it, else the id the song remembers
    // for its packs, else the one the file was opened with. A song that has none gets one now, kept for its later packs.
    let packId = options.id || (isPackId(libSong?.id) ? libSong.id : null) || (isPackId(libSong?.packId) ? libSong.packId : null)
        || (isPackId(file?.mpakId) ? file.mpakId : null);
    if (!packId) packId = libSong?.id ? (globalThis.crypto?.randomUUID?.() || await derivedPackId(primary.entry.sha256)).toLowerCase() : await derivedPackId(primary.entry.sha256);
    if (libSong?.id && !isPackId(libSong.id) && libSong.packId !== packId) {
        try { await (await import('./libraryStore.js')).setSongPackId(libSong.id, packId); } catch { /* the id is still written to this pack */ }
    }

    const manifest = {
        format: MPAK_FORMAT,
        version: MPAK_VERSION,
        id: packId,
        createdAt: new Date().toISOString(),
        generator: { name: 'MajesticTab' },
        ...(buildManifestSong(normSong) ? { song: buildManifestSong(normSong) } : {}),
        scores: manifestScores,
        recordings: [],
    };

    const usedNames = new Set();
    const packedAudio = new Set(); // ids of the audio files already in the pack
    const packedHashes = new Set(); // and their hashes: the same bytes stored twice go in once
    const attachSyncs = (recording, mediaId, syncRecsMap = null) => {
        for (const run of scoreRuns) {
            const syncRec = syncRecsMap ? syncRecsMap.get(run) : run.recordsByMedia.get(mediaId);
            if (!syncRec) continue;
            const syncPath = `sync/${recording.id}-${run.entry.id}.json`;
            const syncDoc = toV1SyncFile(syncRec, recording.id, run.entry.id, run.anchorType, {
                ...syncWindowOf(run),
                blocks: run.anchorType === 'text' ? textBlocksOf(run.bytes) : null,
            });
            if (syncDoc?.points.length) {
                files.set(syncPath, new TextEncoder().encode(JSON.stringify(syncDoc, null, 2) + '\n'));
                (recording.sync ||= {})[run.entry.id] = syncPath;
            }
        }
    };
    const packAudioBytes = async (rec, fallbackName) => {
        const audioBytes = new Uint8Array(rec.data);
        const hash = await sha256(audioBytes);
        let audioName = sanitizeSegment(rec.name, fallbackName);
        if (usedNames.has(audioName.toLowerCase())) audioName = `${rec.id.slice(0, 8)}-${audioName}`;
        usedNames.add(audioName.toLowerCase());
        const audioPath = `audio/${audioName}`;
        files.set(audioPath, audioBytes);
        const fileSrc = { type: 'file', path: audioPath, mime: rec.type || 'audio/mpeg', sha256: hash };
        if (Number.isFinite(rec.durationMs) && rec.durationMs >= 0) fileSrc.durationMs = rec.durationMs;
        packedAudio.add(rec.id);
        packedHashes.add(hash);
        return fileSrc;
    };

    // A stem-only song (SPEC section 8): both slots share the lead stem, and recordingMeta holds the stem list.
    let packedStemSet = false;
    try {
        {
            const { listRecordingMeta } = await import('./audioSync/recordingMeta.js');
            const { stemsOfMeta } = await import('./audioSync/stemSet.js');
            const metas = listRecordingMeta(songKey);
            // The set is the song's own whatever the original slot plays right now: a song whose Original is a video still has its
            // stems, and they go into the pack as stems (SPEC section 8), not as plain audio files
            let origId = getSlotSourceFn('original') === 'local'
                ? (localStorage.getItem(`audio_file_${enc(songKey)}_original`) || localStorage.getItem(`audio_file_last_${enc(songKey)}`))
                : null;
            if (!origId || !stemsOfMeta(metas[mediaKey({ kind: 'local', audioId: origId })])) {
                origId = Object.entries(metas).find(([k, m]) => k.startsWith('local_') && stemsOfMeta(m))?.[0].slice('local_'.length) || null;
            }
            if (origId) {
                const stems = stemsOfMeta(metas[mediaKey({ kind: 'local', audioId: origId })]);
                if (stems) {
                    const loadedStems = [];
                    for (const s of stems) {
                        const rec = await getAudioFile(s.audioId);
                        if (rec?.data) loadedStems.push({ stem: s, rec });
                    }
                    if (loadedStems.length >= 2) {
                        packedStemSet = true;
                        let leadRecId = null;
                        let leadHasSync = false;
                        const stemEntries = [];
                        for (let i = 0; i < loadedStems.length; i++) {
                            const { stem: s, rec } = loadedStems[i];
                            const fileSrc = await packAudioBytes(rec, `stem-${i + 1}.audio`);
                            const recId = `stem-${i + 1}`;
                            const recording = {
                                id: recId,
                                role: 'stem',
                                label: s.label || String(rec.name || '').replace(/\.[^.]+$/, '') || `Stem ${i + 1}`,
                                sources: [fileSrc],
                                ...(s.instrument ? { stem: { instrument: s.instrument } } : {}),
                            };
                            attachSyncs(recording, mediaKey({ kind: 'local', audioId: rec.id }));
                            if (rec.id === origId || (!leadRecId && recording.sync)) {
                                leadRecId = recId;
                                leadHasSync = Boolean(recording.sync);
                            }
                            stemEntries.push({ recording, isLead: rec.id === origId });
                        }
                        if (leadRecId && leadHasSync) {
                            for (const entry of stemEntries) {
                                if (entry.recording.id !== leadRecId && !entry.recording.sync) {
                                    entry.recording.syncFrom = leadRecId;
                                }
                            }
                        }
                        for (const entry of stemEntries) manifest.recordings.push(entry.recording);
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[mpak] could not pack stem set:', e);
    }

    // A stem set stands for the original sound: the Original slot's own file is not packed again, but the video the slot remembers
    // is still a recording of the song, and so is a backing track of its own
    for (const slot of SLOTS) {
        const source = getSlotSourceFn(slot);
        const sources = [];
        const syncRecs = new Map(); // score run -> the record of this recording for that score
        const findRecords = (media) => { for (const run of scoreRuns) { const rec = run.recordsByMedia.get(mediaKey(media)); if (rec && !syncRecs.has(run)) syncRecs.set(run, rec); } };
        try {
            if (source === 'local') {
                let id = localStorage.getItem(`audio_file_${enc(songKey)}_${slot}`);
                if (!id && slot === 'original') id = localStorage.getItem(`audio_file_last_${enc(songKey)}`);
                const rec = id ? await getAudioFile(id) : null;
                // The backing slot can hold one of the set's own stems (both sounds play the set): that one is already packed
                if (rec?.data && !(packedStemSet && (slot === 'original' || packedAudio.has(id)))) {
                    sources.push(await packAudioBytes(rec, `${slot}.audio`));
                    findRecords({ kind: 'local', audioId: id });
                }
            } else if (source === 'embedded' && tabFormat === 'gp') {
                sources.push({ type: 'embedded' });
            }

            const videoId = localStorage.getItem(`yt_track_${enc(songKey)}_${slot}`);
            if (videoId && YT_ID_RE.test(videoId)) {
                sources.push({ type: 'youtube', videoId });
                findRecords({ kind: 'youtube', videoId });
            }
        } catch (e) {
            console.warn('[mpak] could not read the', slot, 'recording:', e);
        }

        if (!sources.length) continue;

        const recording = {
            id: slot,
            role: slot,
            sources,
        };
        attachSyncs(recording, null, syncRecs);
        manifest.recordings.push(recording);
    }

    // Every other audio file of the song goes in too, as a recording of its own: the files of its other tabs, the ones
    // attached to the library song, and the one in a slot whose source is a video. The player has one file per slot at a
    // time, so these are the ones it lists beside the slot's file.
    try {
        const { listAudioFilesForSong, getAudioMeta } = await import('./audioSync/audioFileStore.js');
        const { readLibraryAudio, songAudioKeys, keysOfOtherSongs, isForeignAudio } = await import('./audioSync/libraryAudio.js');
        // A key another library song remembers too (an import can leave the same one on every song) does not say whose audio a
        // file is, so only the song's own key and its own other keys count. Files attached by id below are not affected.
        const otherKeys = libSong?.id ? keysOfOtherSongs(libSong.id) : new Set();
        const keys = [...new Set([songKey, ...(libSong?.id ? songAudioKeys(libSong) : [])].filter(Boolean))]
            .filter((k) => k === songKey || !otherKeys.has(k.toLowerCase()));
        const candidates = new Map(); // audio id -> slot
        const add = (id, slot) => { if (id && !candidates.has(id) && !packedAudio.has(id)) candidates.set(id, slot); };
        for (const k of keys) {
            for (const slot of SLOTS) add(localStorage.getItem(`audio_file_${enc(k)}_${slot}`), slot);
            add(localStorage.getItem(`audio_file_last_${enc(k)}`), 'original');
        }
        if (libSong?.id) for (const e of readLibraryAudio(libSong.id)) add(e.audioId, e.slot);
        for (const k of keys) for (const meta of await listAudioFilesForSong(k)) add(meta.id, 'original');

        // A file linked only to other songs' keys is theirs, however it reached this song (an attachment by id included)
        const ownKeys = new Set(keys.flatMap((k) => [k.toLowerCase(), enc(k).toLowerCase()]));
        let n = 0;
        for (const [id, slot] of candidates) {
            if (isForeignAudio(await getAudioMeta(id), ownKeys)) continue;
            const rec = await getAudioFile(id);
            if (!rec?.data) continue;
            const audioBytes = new Uint8Array(rec.data);
            const hash = await sha256(audioBytes);
            if (packedHashes.has(hash)) continue;
            packedHashes.add(hash);
            let audioName = sanitizeSegment(rec.name, `audio-${n + 1}.audio`);
            if (usedNames.has(audioName.toLowerCase())) audioName = `${id.slice(0, 8)}-${audioName}`;
            usedNames.add(audioName.toLowerCase());
            const audioPath = `audio/${audioName}`;
            files.set(audioPath, audioBytes);
            const fileSrc = { type: 'file', path: audioPath, mime: rec.type || 'audio/mpeg', sha256: hash };
            if (Number.isFinite(rec.durationMs) && rec.durationMs >= 0) fileSrc.durationMs = rec.durationMs;
            n += 1;
            const recording = {
                id: `audio-${n}`,
                role: slot === 'backing' ? 'backing' : 'alternate',
                label: String(rec.name || '').replace(/\.[^.]+$/, '') || `Audio ${n}`,
                sources: [fileSrc],
            };
            for (const run of scoreRuns) {
                const syncRec = run.recordsByMedia.get(mediaKey({ kind: 'local', audioId: id }));
                if (!syncRec) continue;
                const syncPath = `sync/${recording.id}-${run.entry.id}.json`;
                const syncDoc = toV1SyncFile(syncRec, recording.id, run.entry.id, run.anchorType, {
                    ...syncWindowOf(run),
                    blocks: run.anchorType === 'text' ? textBlocksOf(run.bytes) : null,
                });
                if (syncDoc?.points.length) {
                    files.set(syncPath, new TextEncoder().encode(JSON.stringify(syncDoc, null, 2) + '\n'));
                    (recording.sync ||= {})[run.entry.id] = syncPath;
                }
            }
            manifest.recordings.push(recording);
        }
    } catch (e) {
        console.warn('[mpak] could not add the song\'s other audio files:', e);
    }

    // The other videos the song remembers in each part (the slot loop wrote only the chosen one): a recording of their own, with
    // their sync points, and the role of the part they are listed in
    try {
        const { listHistory } = await import('./audioSync/videoHistory.js');
        const { getRecordingMeta } = await import('./audioSync/recordingMeta.js');
        const packedVideos = new Set(manifest.recordings.flatMap((r) => r.sources.filter((x) => x.type === 'youtube').map((x) => x.videoId)));
        let v = 0;
        for (const slot of SLOTS) {
            for (const { videoId } of listHistory(songKey, slot)) {
                if (!YT_ID_RE.test(videoId) || packedVideos.has(videoId)) continue;
                packedVideos.add(videoId);
                v += 1;
                const media = { kind: 'youtube', videoId };
                const said = getRecordingMeta(songKey, media);
                const recording = {
                    id: `video-${v}`,
                    role: slot === 'backing' ? 'backing' : (said?.role && said.role !== 'backing' ? said.role : 'alternate'),
                    ...(said?.label ? { label: said.label } : {}),
                    sources: [{ type: 'youtube', videoId }],
                };
                attachSyncs(recording, mediaKey(media));
                manifest.recordings.push(recording);
            }
        }
    } catch (e) {
        console.warn('[mpak] could not add the song\'s other videos:', e);
    }

    // The first recording is the default (SPEC section 7), and the slots are visited original first.
    if (manifest.recordings.some((r) => r.id === 'original')) {
        const backing = manifest.recordings.find((r) => r.id === 'backing');
        const shared = scoreRuns.some((run) => run.syncKey && (isSyncSharedFromOriginal(run.syncKey) || (run.legacyKey && isSyncSharedFromOriginal(run.legacyKey))));
        if (backing && !backing.sync && shared) {
            backing.syncFrom = 'original';
        }
    }

    // The size of each score and audio file, and the size and hash of each sync file (SPEC section 4, "Integrity")
    const entries = {};
    for (const sc of manifest.scores) if (files.has(sc.path)) sc.size = files.get(sc.path).length;
    for (const rec of manifest.recordings) {
        for (const src of rec.sources) if (src.type === 'file' && files.has(src.path)) src.size = files.get(src.path).length;
        for (const path of Object.values(rec.sync || {})) {
            const bytes = files.get(path);
            if (bytes) entries[path] = { size: bytes.length, sha256: await sha256(bytes) };
        }
    }
    if (Object.keys(entries).length) manifest.entries = entries;

    const { parts } = await coreBuildMpak(manifest, files);
    const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
    const artist = clean(normSong.artist);
    const title = clean(normSong.title);
    const base = (artist && title ? `${artist} - ${title}` : title || artist) || name.replace(/\.[^.]+$/, '') || 'song';
    return {
        blob: new Blob(parts, { type: MEDIA_TYPE }),
        filename: `${base}.${MPAK_EXTENSION}`,
        packId,
    };
}

/**
 * A bundle the desktop shell was opened with. It stays on disk: Rust hands over only its path and size, and the
 * pieces are read on demand, so a bundle with hours of audio never goes through the page as one array.
 */
export function nativeMpakSource({ name, path, size }) {
    return {
        name, size,
        read: async (start, end, type = '') => {
            const bytes = await window.__TAURI__.core.invoke('read_opened_file_range', { path, start, len: end - start });
            return new Blob([bytes], { type });
        },
    };
}

async function toUint8(chunk) {
    if (chunk instanceof Uint8Array) return chunk;
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (chunk && typeof chunk.arrayBuffer === 'function') return new Uint8Array(await chunk.arrayBuffer());
    return new Uint8Array(0);
}

// Converts a File, Blob, Uint8Array, ArrayBuffer, or `{ name, size, read(start, end) }` into a spec ByteSource.
function asByteSource(input) {
    if (!input) return { name: '', size: 0, read: async () => new Uint8Array(0) };
    if (typeof input.read === 'function') {
        return {
            name: input.name || '',
            size: input.size ?? 0,
            read: async (start, end) => toUint8(await input.read(start, end)),
        };
    }
    if (input instanceof Uint8Array || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
        const u8 = input instanceof Uint8Array
            ? input
            : (input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
        return {
            name: input.name || '',
            size: u8.byteLength,
            read: async (start, end) => u8.subarray(start, Math.min(end, u8.byteLength)),
        };
    }
    return {
        name: input.name || '',
        size: input.size ?? 0,
        read: async (start, end) => new Uint8Array(await input.slice(start, end).arrayBuffer()),
    };
}

/** Parses a v1 .mpak bundle: `{ header, opened, part }`. Throws MpakError for invalid bundles. */
export async function readMpak(input, options = {}) {
    const opened = await coreOpenMpak(asByteSource(input), options);
    const header = {
        ...opened.manifest,
        song: normalizeMpakSong(opened.manifest.song, opened.manifest),
    };
    return { header, opened, part: opened };
}

/**
 * Unpacks an .mpak bundle into `{ header, opened, part, tabFile }`, attaching normalized `header.song`
 * (including any MusicBrainz IDs) as `tabFile.mpakSong`.
 */
/** A score of a pack as a `File` the reader can open, with the tuning and page range its entry gives. */
function scoreFileOf(entry, bytes) {
    const name = entry.name || (entry.path || entry.externalPath || `score.${entry.format}`).split('/').pop();
    const file = new File([bytes], name, { type: MIME_BY_FORMAT[entry.format] || 'application/octet-stream' });
    if (entry.sha256) file.contentSha256 = entry.sha256;
    if (entry.label) file.mpakLabel = entry.label;
    if (typeof entry.origin === 'string' && entry.origin) file.mpakOrigin = entry.origin; // SPEC section 6.4: scores of one origin are a set
    // `instruments` is informational and only for scores that carry no tuning of their own (SPEC section 6): take the
    // first entry that lists a tuning.
    const instrumentTuning = (entry.instruments || []).find((i) => Array.isArray(i?.tuning) && i.tuning.length)?.tuning;
    if (instrumentTuning) {
        file.tabTuning = {
            tuning: instrumentTuning.map((n) => n.replace(/-?[0-9]$/, '')).join(' '),
            source: 'user',
        };
    }
    if (entry.startPage != null || entry.endPage != null) {
        file.mpakPageRange = {
            startPage: entry.startPage ?? 1,
            endPage: entry.endPage ?? entry.pages ?? null,
            pages: entry.pages ?? null,
        };
        // The PDF reader and the library read the range from `startPage` and `endPage`: without them the whole book opens
        if (Number.isInteger(entry.startPage) && entry.startPage >= 1) file.startPage = entry.startPage;
        if (Number.isInteger(entry.endPage) && entry.endPage >= 1) file.endPage = entry.endPage;
    }
    return file;
}

/**
 * Unpacks an .mpak bundle into `{ header, opened, part, tabFile, score, otherScores }`. `tabFile` is the first score the
 * app can show (the primary score when it can), `score` its manifest entry, and `otherScores` the rest of the scores it
 * can show, as `{ score, file }`. The normalized `header.song` (including any MusicBrainz IDs) is attached to `tabFile`
 * as `mpakSong`. Throws when no score is one the app can open.
 */
export async function unpackMpak(input, options = {}) {
    const { header, opened } = await readMpak(input, options);
    const supported = header.scores.filter((sc) => SUPPORTED_SCORE_FORMATS.includes(sc.format));
    if (!supported.length) {
        const names = [...new Set(header.scores.map((sc) => SCORE_FORMAT_NAMES[sc.format] || sc.format))].join(', ');
        throw new MpakError(`This .mpak file has ${names} ${header.scores.length > 1 ? 'scores' : 'score'}, which MajesticTab cannot open. It opens Guitar Pro, PDF and text scores.`);
    }
    const score = supported[0];
    const bytes = opened.scoreBytes(score.id);
    if (!bytes) {
        throw new MpakError(`This .mpak file references an external score (${score.externalPath || 'external PDF'}) that was not provided.`);
    }
    const tabFile = scoreFileOf(score, bytes);
    tabFile.mpakSong = header.song;
    if (isPackId(header.id)) tabFile.mpakId = header.id;
    if (header.song?.title && !tabFile.songTitle) tabFile.songTitle = header.song.title;
    if (header.song?.artist && !tabFile.artist) tabFile.artist = header.song.artist;
    if (header.song?.album && !tabFile.album) tabFile.album = header.song.album;
    if (header.song?.recordingMbid) tabFile.recordingMbid = header.song.recordingMbid;
    if (header.song?.artistMbid) tabFile.artistMbid = header.song.artistMbid;
    if (header.song?.albumMbid) tabFile.albumMbid = header.song.albumMbid;
    if (input?.sourceUrl && !tabFile.sourceUrl) tabFile.sourceUrl = input.sourceUrl;
    if (input?.sourceWebsite && !tabFile.sourceWebsite) tabFile.sourceWebsite = input.sourceWebsite;
    if (input?.providerId && !tabFile.providerId) tabFile.providerId = input.providerId;
    // A score kept outside the archive that was not provided is skipped: the pack still opens without it
    const otherScores = supported.slice(1)
        .map((sc) => ({ score: sc, bytes: opened.scoreBytes(sc.id) }))
        .filter((x) => x.bytes)
        .map((x) => ({ score: x.score, file: scoreFileOf(x.score, x.bytes) }));
    return { header, opened, part: opened, tabFile, score, otherScores, packName: input?.name || '' };
}

const PENDING_BROWSER_TARGET_KEY = 'majestictab_pending_browser_target';
const PENDING_BROWSER_TARGET_TTL_MS = 30 * 60 * 1000;

function normMatchText(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function takeMatchingPendingBrowserTarget(songInfo = {}) {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(PENDING_BROWSER_TARGET_KEY);
        if (!raw) return null;
        const pending = JSON.parse(raw);
        if (!pending?.songId || !pending?.timestamp || (Date.now() - pending.timestamp) > PENDING_BROWSER_TARGET_TTL_MS) {
            localStorage.removeItem(PENDING_BROWSER_TARGET_KEY);
            return null;
        }
        const incomingTitle = normMatchText(songInfo.title);
        const pendingTitle = normMatchText(pending.title);
        const incomingArtist = normMatchText(songInfo.artist);
        const pendingArtist = normMatchText(pending.artist);
        const explicitIdMatch = songInfo.id && songInfo.id === pending.songId;
        if (!explicitIdMatch && incomingTitle && pendingTitle && incomingTitle !== pendingTitle) {
            return null;
        }
        if (!explicitIdMatch && incomingArtist && pendingArtist && incomingArtist !== pendingArtist) {
            return null;
        }
        localStorage.removeItem(PENDING_BROWSER_TARGET_KEY);
        return pending;
    } catch {
        return null;
    }
}

/**
 * Opens a bundle: loads its score, then attaches the recordings, sync points and tuning to the song as the open tab
 * knows it (its song key is only settled once the score is loaded).
 */
export async function openMpak(file, options = {}) {
    const { beginLoadingHold, endLoadingHold, setCurrentLoadingProgress, setLoadingProgressRange } = await import('./utils/loadingCard.js');
    const output = typeof document !== 'undefined' ? document.getElementById('output') : null;
    beginLoadingHold(output, {
        title: (file?.name || '').replace(/\.[^/.]+$/, '') || 'Loading pack',
        stage: 'Opening pack…',
    });
    try {
        const unpacked = await unpackMpak(file, options);
        const { header, opened, tabFile } = unpacked;
        if (opened.warnings?.length) {
            console.warn('[mpak] warnings while opening bundle:', opened.warnings);
        }

        try {
            const songInfo = header.song || {};
            const pending = takeMatchingPendingBrowserTarget(songInfo);
            let targetSongId = pending?.songId || null;
            const collectionId = pending?.collectionId || undefined;

            // Only a download the user started from the in-app browser into a chosen song is saved here. Opening a file (from
            // the OS, a picker or a drop) never adds to the library: the user saves it with Save to library.
            if (targetSongId) {
                const saved = await saveMpakToLibrary(unpacked, {
                    targetSongId,
                    collectionId,
                    queryMusicBrainz: true,
                });
                if (saved?.song?.id) {
                    tabFile.librarySongId = saved.song.id;
                    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
                    }
                }
            }
        } catch (e) {
            console.warn('[mpak] auto-merge on openMpak failed:', e);
        }

        // A pack that was not saved to the library keeps its scores in the Song menu, so the other scores open from the pack
        if (!tabFile.librarySongId) {
            tabFile.mpakStandalone = true;
            tabFile.mpakPackId = newPackId(); // the pack's audio and sync data are kept under its own key, until it closes
            rememberOpenedMpak(unpacked);
            rememberPackScores(unpacked);
        }

        const hasAudio = (header?.recordings || []).some((r) => (r.sources || []).some((s) => s.type === 'file' && s.path && opened?.entries?.includes(s.path)));
        if (hasAudio) setLoadingProgressRange(5, 50);
        const { loadFile } = await import('./main.js');
        await loadFile(tabFile);
        if (hasAudio) setLoadingProgressRange(50, 100);
        await applyMpakExtras(header, opened, {
            onProgress: (pct, stage) => setCurrentLoadingProgress(pct, stage),
        });
        setCurrentLoadingProgress(100, 'Ready');
    } finally {
        endLoadingHold(output);
    }
}

// The open pack's scores, by the file the reader has open. Only for a pack opened from a file: a library song lists its own tabs.
const packScores = new WeakMap();
const openedMpaks = new WeakMap();

function rememberOpenedMpak(unpacked) {
    if (!unpacked?.tabFile) return;
    openedMpaks.set(unpacked.tabFile, unpacked);
    for (const other of unpacked.otherScores || []) {
        if (other?.file) openedMpaks.set(other.file, unpacked);
    }
}

/** Returns the unpacked bundle an open standalone .mpak score came from, or null. */
export function getOpenedMpak(file) {
    return (file && openedMpaks.get(file)) || null;
}

function rememberPackScores(unpacked) {
    const { header, opened, tabFile, score, otherScores } = unpacked;
    if (!otherScores?.length) return;
    const all = [{ score, file: tabFile }, ...otherScores];
    for (const { file } of all) { file.mpakStandalone = true; file.mpakPackId = tabFile.mpakPackId; } // matched to no library song by name
    const entries = all.map(({ score: sc, file }) => {
        const pages = (sc.startPage && sc.endPage) ? `Pages ${sc.startPage}\u2013${sc.endPage}` : '';
        const kind = sc.format === 'pdf' ? 'PDF' : sc.format === 'txt' ? 'Text' : 'Guitar Pro';
        return { id: sc.id, file, name: sc.label || sc.name || file.name, detail: [kind, pages].filter(Boolean).join(' \u00b7 '), ...(typeof sc.origin === 'string' && sc.origin ? { origin: sc.origin } : {}) };
    });
    for (const e of entries) {
        if (e.file !== tabFile) { e.file.mpakSong = header.song; if (isPackId(header.id)) e.file.mpakId = header.id; }
        packScores.set(e.file, { entries, header, opened });
    }
}

/** The other scores of the pack the open file came from, as `[{ id, name, detail }]`; empty when it is not from a pack. */
export function otherPackScores(file) {
    const pack = file && packScores.get(file);
    return pack ? pack.entries.filter((e) => e.file !== file).map(({ id, name, detail }) => ({ id, name, detail })) : [];
}

/** All scores of the pack the open file came from, as `[{ id, name, detail, origin?, current }]`; empty when it is not from a pack. */
export function packScoresOf(file) {
    const pack = file && packScores.get(file);
    return pack ? pack.entries.map(({ id, name, detail, origin, file: f }) => ({ id, name, detail, ...(origin ? { origin } : {}), current: f === file })) : [];
}

/** Opens another score of the pack the open file came from. */
export async function openPackScore(file, id) {
    const pack = packScores.get(file);
    const entry = pack?.entries.find((e) => e.id === id);
    if (!entry) return;
    const { beginLoadingHold, endLoadingHold, setCurrentLoadingProgress, setLoadingProgressRange } = await import('./utils/loadingCard.js');
    const output = typeof document !== 'undefined' ? document.getElementById('output') : null;
    beginLoadingHold(output, {
        title: entry.name || 'Loading score',
        stage: 'Loading score…',
    });
    try {
        const hasAudio = (pack.header?.recordings || []).some((r) => (r.sources || []).some((s) => s.type === 'file' && s.path && pack.opened?.entries?.includes(s.path)));
        if (hasAudio) setLoadingProgressRange(0, 50);
        const { loadFile } = await import('./main.js');
        await loadFile(entry.file);
        if (hasAudio) setLoadingProgressRange(50, 100);
        await applyMpakExtras(pack.header, pack.opened, {
            onProgress: (pct, stage) => setCurrentLoadingProgress(pct, stage),
        });
        setCurrentLoadingProgress(100, 'Ready');
    } finally {
        endLoadingHold(output);
    }
}

const hasFile = (r) => (r?.sources || []).some((src) => src.type === 'file' && src.path);

/**
 * A pack that is only stems, with no full mix (SPEC section 8): `{ lead, members }` (members include the lead), or null.
 * The stems are the song's audio: the player mixes them and the person chooses which are heard. The lead is the stem that
 * has sync points of its own, else the first one; the others use its points (`syncFrom`).
 */
export function stemSetOf(manifest) {
    const recs = manifest?.recordings || [];
    // A full mix with audio of its own is not a set of stems with no mix. An original or alternate that is only a video
    // (or the score's own sound) sits beside the stems: the stems stay the song's audio and the video is one more recording.
    if (recs.some((r) => (r.role === 'original' || r.role === 'alternate') && hasFile(r))) return null;
    const members = recs.filter((r) => r.role === 'stem' && !r.stemOf && hasFile(r));
    if (members.length < 2) return null;
    const lead = members.find((r) => r.sync && Object.keys(r.sync).length) || members[0];
    return { lead, members };
}

function mapRecordingsToSlots(manifest) {
    const recs = manifest?.recordings || [];
    const bySlot = { original: null, backing: null };
    // The first recording is the default (SPEC section 7): if it is an original, it takes the original slot.
    if (recs[0] && (recs[0].role === 'original' || recs[0].id === 'original')) bySlot.original = recs[0];
    for (const r of recs) {
        if (!bySlot.original && (r.role === 'original' || r.id === 'original')) {
            bySlot.original = r;
        } else if (!bySlot.backing && (r.role === 'backing' || r.id === 'backing')) {
            bySlot.backing = r;
        }
    }
    // An alternate is another version of the released recording (SPEC section 7): it only takes the original slot when
    // the pack has no original.
    if (!bySlot.original) bySlot.original = recs.find((r) => r.role === 'alternate') || null;
    // A pack can have no original at all (a pack of a backing track and its stems has no full mix). The default
    // recording, the first (SPEC section 7), then takes the original slot, so the player has something to play and the
    // sync points are found. A stem alone is not a recording to play first. It does not also fill the backing slot.
    if (!bySlot.original && recs[0] && recs[0].role !== 'stem' && (recs[0].sources || []).length) {
        bySlot.original = recs[0];
        if (bySlot.backing === recs[0]) bySlot.backing = recs.find((r) => r !== recs[0] && r.role === 'backing') || null;
    }
    // Stems with no full mix: both sounds play the set, and differ only in which parts start muted (audioSync/stemSet.js)
    const set = stemSetOf(manifest);
    if (set && (!bySlot.original || !hasFile(bySlot.original))) {
        bySlot.original = set.lead;
        if (!bySlot.backing) bySlot.backing = set.lead;
    }
    return bySlot;
}

/**
 * Attaches an .mpak bundle's recordings (original/backing audio, embedded, or YouTube) and sync points to
 * the given `songKey` and `aliasKeys` (or the currently active reader's songKey when omitted).
 */
export async function applyMpakExtras(data, opened, options = {}) {
    const { saveAudioFile, linkAudioFile, setAudioPeaks } = await import('./audioSync/audioFileStore.js');
    const { decodePeaks } = await import('./audioSync/peaks.js');
    const { attachLibraryAudio, attachLibraryAudioAlternate } = await import('./audioSync/libraryAudio.js');
    const { saveRecord, loadRecord, samePoints, setSyncSharedFromOriginal, mediaKey, SYNC_CHANGED_EVENT } = await import('./audioSync/syncStore.js');
    const { setRecordingMeta, metaOfPackRecording, listRecordingMeta } = await import('./audioSync/recordingMeta.js');
    const { stemsOfMeta } = await import('./audioSync/stemSet.js');
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const totalAudioFiles = (data?.recordings || []).filter((r) => (r.sources || []).some((s) => s.type === 'file' && s.path && opened?.entries?.includes(s.path))).length;
    let savedAudioCount = 0;
    const reportAudioProgress = () => {
        if (!onProgress || !totalAudioFiles) return;
        savedAudioCount++;
        const pct = Math.min(85, Math.round((savedAudioCount / totalAudioFiles) * 85));
        onProgress(pct, `Loading audio (${Math.min(savedAudioCount, totalAudioFiles)}/${totalAudioFiles})…`);
    };

    let activeReaderKey = null;
    if (!options.songKey || options.applyToActiveReader === undefined) {
        try {
            const { getSongKey } = await import('./soundPlayer.js');
            activeReaderKey = getSongKey();
        } catch { /* headless environment */ }
    }

    const primaryKey = options.songKey || activeReaderKey;
    if (!primaryKey) return;

    const allKeys = Array.from(new Set([primaryKey, ...(options.aliasKeys || [])].filter(Boolean)));
    const applyToActiveReader = options.applyToActiveReader !== undefined
        ? Boolean(options.applyToActiveReader)
        : (!options.songKey || (activeReaderKey && allKeys.some(k => k.toLowerCase() === activeReaderKey.toLowerCase())));

    let setSlotSource = () => {};
    let getSlotSource = (slot) => localStorage.getItem(`real_audio_source_${enc(primaryKey)}_${slot}`) || 'youtube';
    let updateRecordingSlots = () => {};
    let hasEmbeddedAudio = () => false;
    if (applyToActiveReader) {
        try {
            const rac = await import('./audioSync/realAudioController.js');
            setSlotSource = rac.setSlotSource;
            getSlotSource = rac.getSlotSource;
            updateRecordingSlots = rac.updateRealAudioPanelView; // the whole panel: source switch, sections and the slot rows
            hasEmbeddedAudio = rac.hasEmbeddedAudio;
        } catch { /* headless environment */ }
    }

    let targetSong = options.song || null;
    if (!targetSong && options.songId) {
        try {
            const { getSongById } = await import('./libraryStore.js');
            targetSong = await getSongById(options.songId);
        } catch { /* optional */ }
    }

    const slots = mapRecordingsToSlots(data);
    const stemSet = stemSetOf(data);
    const resolvedMedia = new Map();
    // Each score is synced on its own (SPEC section 6.2). The points of text and PDF scores are kept by song and score
    // file; bar points are kept by song, so only the first score of that kind gets them.
    const scores = Array.isArray(data?.scores) ? data.scores : [];
    let barTaken = false;
    const syncTargets = scores.filter((sc) => {
        const anchor = ANCHOR[sc.format];
        if (!STORED_ANCHORS.includes(anchor)) return false;
        if (anchor === 'bar') { if (barTaken) return false; barTaken = true; }
        return true;
    });
    // A list of bar times (a sync file whose points are bare numbers, SPEC section 9.1) names no bars: it goes onto the played bars of the
    // score it is for. It is left out when the score cannot be read, when the list has more times than the score has played
    // bars, and, for a format whose repeats the spec does not define, when the score has repeats.
    const placedSync = async (recId, sc) => {
        const doc = typeof opened?.sync === 'function' ? opened.sync(recId, sc.id) : null;
        if (!isBarTimes(doc)) return doc;
        const played = await playedBarsOf(sc);
        const repeats = Boolean(played?.some((bar) => bar.occurrence > 0));
        const placed = played && !(repeats && !GP_FORMATS.includes(sc.format)) ? placeBarTimes(doc, played) : null;
        if (!placed) console.info(`[mpak] a list of bar times was left out for "${sc.name || sc.id}": it does not fit the bars the score plays`);
        return placed;
    };
    const syncDocsOf = async (rec) => (await Promise.all(syncTargets.map(async (sc) => ({ sc, doc: await placedSync(rec.id, sc) }))))
        .filter((x) => x.doc?.points?.length);
    // A stem of a set that has the lead's own points needs no record: the player gives it its parent's (syncStore.js,
    // setStemParentResolver). Saving one per stem copied the same points into a record each.
    const sameAsLead = async ({ sc, doc }, rec) => {
        if (!stemSet || rec === stemSet.lead || !stemSet.members.includes(rec) || typeof opened?.sync !== 'function') return false;
        const lead = await placedSync(stemSet.lead.id, sc);
        return Boolean(lead?.points?.length) && lead.anchorType === doc.anchorType && JSON.stringify(lead.points) === JSON.stringify(doc.points);
    };
    // The bars a score plays, repeats included, read from its file; null when it cannot be read
    const playedBarsCache = new Map();
    const playedBarsOf = async (sc) => {
        if (!playedBarsCache.has(sc.id)) {
            let bars = null;
            try {
                if (sc.path && opened?.entries?.includes(sc.path)) {
                    const { extractPlayedBarsFromFile } = await import('./urlImport/attachSync.js');
                    bars = (await extractPlayedBarsFromFile(await opened.file(sc.path))) || null;
                }
            } catch { /* the points are kept as they are */ }
            playedBarsCache.set(sc.id, bars?.length ? bars : null);
        }
        return playedBarsCache.get(sc.id);
    };
    let keptEdits = false;
    const saveSyncs = async (docs, media) => {
        for (const { sc, doc } of docs) {
            let points = fromSyncPoints(doc.points, doc.anchorType);
            if (doc.anchorType === 'bar') {
                // Bar points are kept by song, so a pack can hold them from a score laid out differently (a repeat written
                // out, or played by a repeat sign). They go onto this score's own played bars, in time order.
                const played = await playedBarsOf(sc);
                if (played) {
                    const fit = fitBarPoints(points, played);
                    if (fit.moved) {
                        console.info(`[mpak] sync points fitted to the bars "${sc.name || sc.id}" plays` + (fit.dropped ? ` (${fit.dropped} left out)` : ''));
                        points = fit.points;
                    }
                }
            }
            for (const k of allKeys) {
                const key = syncKeyFor(doc.anchorType, k, sc.sha256);
                // Points the person edited since the last import stay. The pack's own become the restore point, so
                // "Restore original" in the sync editor brings them back.
                const cur = loadRecord(key, media);
                const edited = cur && !cur.inherited && cur.restore && !samePoints(cur.points, cur.restore.points) && !samePoints(cur.points, points);
                if (edited) {
                    saveRecord(key, media, cur.points, undefined, undefined, doc.anchorType, { restoreTo: points });
                    keptEdits = true;
                } else {
                    saveRecord(key, media, points, undefined, undefined, doc.anchorType, { restoreTo: points });
                }
            }
        }
    };

    // What the song already has in a slot: the id of its local file, or the id of its video, or null when the slot is free
    const slotTakenBy = (slot) => {
        const source = localStorage.getItem(`real_audio_source_${enc(primaryKey)}_${slot}`);
        if (source === 'youtube') return localStorage.getItem(`yt_track_${enc(primaryKey)}_${slot}`) || null;
        return localStorage.getItem(`audio_file_${enc(primaryKey)}_${slot}`) || null;
    };

    for (const slot of SLOTS) {
        const rec = slots[slot];
        if (!rec) continue;
        try {
            const syncDocs = await syncDocsOf(rec);
            const hasSync = syncDocs.length > 0;
            let takenId = options.keepExistingSlots ? slotTakenBy(slot) : null;
            // A song whose two sounds share one stem set has its lead in the Backing slot only as the default: a backing
            // recording of the pack's own takes the slot (a file the person chose for it stays)
            if (takenId && slot === 'backing' && rec.role === 'backing' && slotTakenBy('original') === takenId
                && stemsOfMeta(listRecordingMeta(primaryKey)[mediaKey({ kind: 'local', audioId: takenId })])) takenId = null;

            // One recording in both slots (a set of stems): the file is stored once, the second slot points at it
            const already = resolvedMedia.get(rec.id);
            if (already?.kind === 'local') {
                if (!takenId || takenId === already.audioId) {
                    for (const k of allKeys) {
                        localStorage.setItem(`audio_file_${enc(k)}_${slot}`, already.audioId);
                        localStorage.setItem(`real_audio_source_${enc(k)}_${slot}`, 'local');
                    }
                    if (targetSong) { try { attachLibraryAudio(targetSong, already.audioId, slot); } catch { /* optional */ } }
                    if (applyToActiveReader) setSlotSource('local', slot);
                }
                continue;
            }

            // Cache any YouTube fallback videoId on the recording
            const ytSrc = (rec.sources || []).find((s) => s.type === 'youtube' && s.videoId);
            if (ytSrc && !takenId) {
                for (const k of allKeys) {
                    localStorage.setItem(`yt_track_${enc(k)}_${slot}`, String(ytSrc.videoId));
                }
            }

            // Pick the first playable source (SPEC section 7)
            let handled = false;
            for (const src of rec.sources || []) {
                if (src.type === 'file' && src.path && opened?.entries?.includes(src.path)) {
                    const audioU8 = await opened.file(src.path);
                    const audioBuf = audioU8.buffer.slice(audioU8.byteOffset, audioU8.byteOffset + audioU8.byteLength);
                    const meta = await saveAudioFile({
                        name: src.path.split('/').pop() || `${slot}.audio`,
                        type: src.mime || 'audio/mpeg',
                        data: audioBuf,
                        songKey: primaryKey,
                        durationMs: src.durationMs ?? null,
                    });
                    // A song that already has a different recording in this slot keeps it. The new file is stored and linked
                    // to the song, so the player lists it, and its sync points are saved against it below.
                    const keep = Boolean(takenId) && takenId !== meta.id;
                    for (const k of allKeys) {
                        if (k !== primaryKey) {
                            await linkAudioFile(meta.id, k).catch(() => {});
                        }
                        if (keep) continue;
                        localStorage.setItem(`audio_file_${enc(k)}_${slot}`, meta.id);
                        if (slot === 'original') localStorage.setItem(`audio_file_last_${enc(k)}`, meta.id);
                        localStorage.setItem(`real_audio_source_${enc(k)}_${slot}`, 'local');
                    }
                    if (targetSong) {
                        try { (keep ? attachLibraryAudioAlternate : attachLibraryAudio)(targetSong, meta.id, slot); } catch { /* optional */ }
                    }
                    if (applyToActiveReader && !keep) {
                        setSlotSource('local', slot);
                    }
                    decodePeaks(audioBuf.slice(0))
                        .then(({ peaks, durationMs }) => setAudioPeaks(meta.id, peaks, durationMs))
                        .catch(() => {});
                    resolvedMedia.set(rec.id, {
                        kind: 'local', audioId: meta.id, name: meta.name, durationMs: meta.durationMs ?? null, fingerprint: meta.fingerprint,
                    });
                    reportAudioProgress();
                    handled = true;
                    break;
                }
                if (src.type === 'embedded' && !takenId && scores.find((sc) => sc.id === (src.score ?? scores[0]?.id))?.format === 'gp') {
                    for (const k of allKeys) {
                        localStorage.setItem(`real_audio_source_${enc(k)}_${slot}`, 'embedded');
                    }
                    if (applyToActiveReader) {
                        setSlotSource('embedded', slot);
                    }
                    handled = true;
                    break;
                }
                if (src.type === 'youtube' && src.videoId) {
                    // A different video already in the slot stays; this one is kept as a synced video of the song below
                    if (takenId && takenId !== String(src.videoId)) continue;
                    const preferEmbedded = slot === 'original' && !hasSync && applyToActiveReader && hasEmbeddedAudio();
                    const chosenSource = preferEmbedded ? 'embedded' : 'youtube';
                    for (const k of allKeys) {
                        localStorage.setItem(`real_audio_source_${enc(k)}_${slot}`, chosenSource);
                    }
                    if (applyToActiveReader) {
                        setSlotSource(chosenSource, slot);
                    }
                    resolvedMedia.set(rec.id, { kind: 'youtube', videoId: src.videoId });
                    handled = true;
                    break;
                }
            }

            if (handled && syncDocs.length) {
                const media = resolvedMedia.get(rec.id);
                if (media) await saveSyncs(syncDocs, media);
            }
        } catch (e) {
            console.warn('[mpak] could not attach the', slot, 'recording:', e);
        }
    }

    // The player has two slots, but a bundle can list any number of synced YouTube videos (several recordings of the
    // song, backing tracks, solos). Each of the rest is kept as a synced video of the song, with its label. A video
    // listed twice keeps its first points, and a video already attached to a slot is left as it is.
    const taken = new Set([...resolvedMedia.values()].map((media) => mediaKey(media)).filter(Boolean));
    for (const rec of data?.recordings || []) {
        if (resolvedMedia.has(rec.id)) continue;
        try {
            // An audio file in a recording the two slots did not take: stored and linked to the song, so the player lists it
            const fileSrc = (rec.sources || []).find((s) => s.type === 'file' && s.path && opened?.entries?.includes(s.path));
            if (fileSrc) {
                const audioU8 = await opened.file(fileSrc.path);
                const audioBuf = audioU8.buffer.slice(audioU8.byteOffset, audioU8.byteOffset + audioU8.byteLength);
                const meta = await saveAudioFile({
                    name: fileSrc.path.split('/').pop() || `${rec.id}.audio`,
                    type: fileSrc.mime || 'audio/mpeg',
                    data: audioBuf,
                    songKey: primaryKey,
                    durationMs: fileSrc.durationMs ?? null,
                });
                for (const k of allKeys) if (k !== primaryKey) await linkAudioFile(meta.id, k).catch(() => {});
                if (targetSong && !stemSet?.members.includes(rec)) { // the parts of a stem set are not recordings of their own
                    try { attachLibraryAudioAlternate(targetSong, meta.id, rec.role === 'backing' ? 'backing' : 'original'); } catch { /* optional */ }
                }
                decodePeaks(audioBuf.slice(0))
                    .then(({ peaks, durationMs }) => setAudioPeaks(meta.id, peaks, durationMs))
                    .catch(() => {});
                const media = { kind: 'local', audioId: meta.id, name: meta.name, durationMs: meta.durationMs ?? null, fingerprint: meta.fingerprint };
                resolvedMedia.set(rec.id, media);
                reportAudioProgress();
                const docs = [];
                for (const d of await syncDocsOf(rec)) if (!(await sameAsLead(d, rec))) docs.push(d);
                if (docs.length) await saveSyncs(docs, media);
                continue;
            }
            const ytSrc = (rec.sources || []).find((s) => s.type === 'youtube' && s.videoId);
            if (!ytSrc) continue;
            const syncDocs = await syncDocsOf(rec);
            const media = { kind: 'youtube', videoId: ytSrc.videoId, ...(rec.label ? { label: rec.label } : {}) };
            const key = mediaKey(media);
            if (!key || taken.has(key)) continue;
            taken.add(key);
            if (!syncDocs.length) {
                // A video with no map points is remembered in the part its role is for, so the player lists it
                const { rememberVideo } = await import('./audioSync/videoHistory.js');
                const part = rec.role === 'backing' ? 'backing' : 'original';
                for (const k of allKeys) rememberVideo(k, part, String(ytSrc.videoId));
                resolvedMedia.set(rec.id, media);
                continue;
            }
            await saveSyncs(syncDocs, media);
            resolvedMedia.set(rec.id, media);
        } catch (e) {
            console.warn('[mpak] could not attach the', rec?.id, 'recording:', e);
        }
    }

    // What the pack says about each recording the player now has (role, label, place in the pack, tracks, stem parent) is kept
    // for the Original panel's list. It stays inside the app: nothing of it is written back into an exported pack.
    const keyOfId = (id) => (resolvedMedia.has(id) ? mediaKey(resolvedMedia.get(id)) : null);
    (data?.recordings || []).forEach((rec, index) => {
        const media = resolvedMedia.get(rec.id);
        const meta = media && metaOfPackRecording(rec, index, keyOfId, scores[0]?.id);
        if (!meta) return;
        if (stemSet?.members.includes(rec)) {
            const leadKey = keyOfId(stemSet.lead.id);
            if (rec === stemSet.lead) {
                // The lead stands for the whole set: it sorts first, and the player builds the mix from `stems`
                const stems = stemSet.members.filter((m) => resolvedMedia.get(m.id)?.kind === 'local').map((m) => ({
                    audioId: resolvedMedia.get(m.id).audioId, label: m.label, instrument: m.stem?.instrument,
                }));
                meta.role = 'original';
                meta.label = 'All stems';
                delete meta.instrument;
                if (stems.length > 1) meta.stems = stems;
            } else if (leadKey) {
                meta.stemOf = leadKey;
            }
        }
        for (const k of allKeys) setRecordingMeta(k, media, meta);
    });

    if (slots.backing && slots.backing.syncFrom && slots.backing.syncFrom === slots.original?.id && !slots.backing.syncOffsetMs) {
        // syncFrom covers the scores the backing track has no sync file of its own for
        for (const sc of syncTargets) {
            if (slots.backing.sync?.[sc.id]) continue;
            for (const k of allKeys) setSyncSharedFromOriginal(syncKeyFor(ANCHOR[sc.format], k, sc.sha256), true);
        }
    }

    if (keptEdits) {
        try {
            const { showToast } = await import('./utils/toast.js');
            showToast('Kept your edited map points. The pack\'s own are under Restore original in the map editor.', 'info', 6000);
        } catch { /* headless environment */ }
    }

    if (applyToActiveReader) {
        if (onProgress && totalAudioFiles) onProgress(90, 'Preparing mixer…');
        // The audio player listed the song's files when the score loaded, before they were stored here. Without a library
        // song (attachLibraryAudio sends this event) it would keep an empty list: Synth audio, no file to play.
        try {
            const { AUDIO_FILES_CHANGED_EVENT } = await import('./audioSync/audioBackup.js');
            window.dispatchEvent(new CustomEvent(AUDIO_FILES_CHANGED_EVENT));
            const { awaitAudioFilesReady } = await import('./audioSync/audioFilePlayer.js');
            await awaitAudioFilesReady();
        } catch { /* headless environment */ }
        try {
            if (getSlotSource('original') === 'embedded') (await import('./utils/navigationUtils.js')).setActiveAudioMode('real');
        } catch { /* optional */ }
        try { updateRecordingSlots(); } catch { /* the reader draws them next time */ }
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
    }
}

/**
 * The tab of `song` that holds this score file, or null. Tabs added from a pack record the score's SHA-256; an older tab
 * has none, so it is matched by file type, name and size.
 */
async function findTabOfScore(song, file, entry) {
    const sha = entry?.sha256 || file?.contentSha256 || null;
    const fileName = file?.name || '';
    const ext = fileName.split('.').pop().toLowerCase();
    const label = entry?.label || '';
    const entryName = entry?.name || '';
    const remoteCandidates = [];

    for (const t of song?.tabOptions || []) {
        // Typed text changes after it has synced, so its hash and size say nothing: the same name is the same tab
        if (t.editableText && ext === 'txt' && fileName && (t.name === fileName || (t.relativePath || '').split(/[\\/]/).pop() === fileName)) return t;
        if (sha && t.sha256) {
            if (t.sha256 === sha) return t;
            continue;
        }
        if (!t.fileStoreId) {
            const tabExt = (t.fileType || '').toLowerCase();
            if (tabExt && ext && tabExt !== ext) continue;
            const relBase = (t.relativePath || '').split(/[\\/]/).pop();
            if (
                (fileName && (relBase === fileName || t.name === fileName))
                || (label && t.name === label)
                || (entryName && (relBase === entryName || t.name === entryName))
            ) {
                return t;
            }
            if (!t.sha256) remoteCandidates.push(t);
            continue;
        }
        if (t.fileType !== ext) continue;
        try {
            const { getStoredFileRecord } = await import('./fileStore.js');
            const rec = await getStoredFileRecord(t.fileStoreId);
            if (rec && rec.size === file.size && rec.name === file.name) return t;
        } catch { /* compare no further */ }
    }
    return remoteCandidates.length === 1 ? remoteCandidates[0] : null;
}

/**
 * Gives the tabs that a pack added their set (src/tabSets.js): each tab takes its score's `origin`, and the scores of one
 * origin in this pack link to the first of them (the primary score when it is one). Sets are per file: a tab the song
 * already had from another pack is not pulled into this pack's set, and a tab that is already in a set keeps it, so adding
 * the same pack again changes nothing. `tabOptions` is the Map from each score's file to its tab, in pack order; the tabs in
 * it are updated in place. Returns the song as stored afterwards, or null when nothing changed. `store` is for tests: the
 * `updateTabOptionOnSong` and `getSongById` it uses.
 */
export async function linkImportedSets(song, tabOptions, store = null) {
    const items = [...tabOptions].map(([file, tab]) => ({ tab, origin: file?.mpakOrigin || null })).filter((x) => x.tab?.id);
    if (!items.some((x) => x.origin)) return null;
    const updates = new Map();
    const want = (tab) => { if (!updates.has(tab.id)) updates.set(tab.id, {}); return updates.get(tab.id); };
    for (const { tab, origin } of items) if (origin && !tab.origin) want(tab).origin = origin;
    const links = linkSets(items.filter((x) => x.origin).map((x) => ({ id: x.tab.id, origin: x.origin })));
    const byId = new Map(items.map((x) => [x.tab.id, x.tab]));
    for (const [variantId, headId] of links) {
        const variant = byId.get(variantId);
        const head = byId.get(headId);
        if (variant.variantOf || head.variantOf) continue; // already in a set: it keeps it, and a variant is never a head
        want(variant).variantOf = headId;
    }
    if (!updates.size) return null;
    const { updateTabOptionOnSong, getSongById } = store || await import('./libraryStore.js');
    for (const [tabId, patch] of updates) {
        try {
            Object.assign(byId.get(tabId), await updateTabOptionOnSong(song.id, tabId, patch) || patch);
        } catch (e) {
            console.warn('[mpak] could not put the', tabId, 'tab in its set:', e);
        }
    }
    return getSongById(song.id);
}

/**
 * Saves an .mpak bundle to the library, using its MusicBrainz IDs (`recordingMbid`, `artistMbid`, `albumMbid`)
 * and song metadata to either:
 *   - Add the song in the proper Artist > Album > Song hierarchy (querying MusicBrainz by ID when needed), or
 *   - Merge into an existing library song as another tab option,
 * and attaches the bundle's recordings and sync points to the library song.
 */
export async function saveMpakToLibrary(input, options = {}) {
    const {
        collectionId = undefined,
        targetSongId = null,
        tabName = null,
        providerId = 'local',
        relativePath = '',
        queryMusicBrainz = true,
        allowTextFallback = false,
        keepExistingSlots = undefined,
    } = options;

    const unpacked = (input && input.header && input.part && input.tabFile)
        ? input
        : await unpackMpak(input);
    const { header, part, tabFile } = unpacked;

    const { getSongById, findSongByPackId, setSongPackId, resolveAndSaveOrMergeSong, mapOpenFileToSong } = await import('./libraryStore.js');

    let song = null;
    let merged = false;
    let created = false;
    const packId = isPackId(header.id) ? header.id : null;

    if (targetSongId) {
        song = await getSongById(targetSongId);
        if (song) merged = true;
    }

    // A pack with an `id` is the song that has that id (SPEC section 4), whatever its title or artist now say
    if (!song && packId) {
        song = await findSongByPackId(packId);
        if (song) merged = true;
    }

    if (!song) {
        const resolved = await resolveAndSaveOrMergeSong(packId ? { ...(header.song || {}), id: packId } : (header.song || {}), collectionId, {
            queryMusicBrainz,
            allowTextFallback,
        });
        song = resolved.song;
        merged = resolved.merged;
        created = resolved.created;
        // Found by its title and artist, not its id: the song now remembers the pack's id, so its next pack carries it
        if (merged && packId && song.id !== packId && song.packId !== packId) song = (await setSongPackId(song.id, packId)) || song;
    }

    // A score the song already has (the same file, by its SHA-256) is not added again, so adding the same pack twice, or a
    // second pack that carries the same score, leaves one tab. A different score becomes another tab, named by its label.
    const addScore = async (file, entry, name) => {
        const existing = await findTabOfScore(song, file, entry);
        if (existing) {
            // A song record synced from library.json (dynamic/hybrid mode) can carry a tab's sha256 without a local fileStore entry.
            const { getStoredFileRecord, saveStoredFile } = await import('./fileStore.js');
            const hasLocalFile = existing.fileStoreId && Boolean(await getStoredFileRecord(existing.fileStoreId));
            if (hasLocalFile && existing.editableText) {
                // The pack carries the newer typed text: this device's file takes it, under the same file id
                const { saveStoredFile: save } = await import('./fileStore.js');
                await save(file, existing.providerId || 'local', { id: existing.fileStoreId, editableText: true });
                const { updateTabOptionOnSong } = await import('./libraryStore.js');
                const sha = entry?.sha256 || file?.contentSha256 || null;
                const updatedTab = await updateTabOptionOnSong(song.id, existing.id, { sha256: sha });
                return { song: (await getSongById(song.id)) || song, tabOption: updatedTab || existing, stored: null, duplicate: true };
            }
            if (hasLocalFile) return { song, tabOption: existing, stored: null, duplicate: true };
            const stored = await saveStoredFile(file, providerId, {
                name: file.name,
                type: file.type,
                relativePath: relativePath || file.name,
                songId: song.id,
                sourceUrl: file.sourceUrl || null,
                sourceWebsite: file.sourceWebsite || null,
            });
            const { updateTabOptionOnSong } = await import('./libraryStore.js');
            const sha = entry?.sha256 || file?.contentSha256 || null;
            const updatedTab = await updateTabOptionOnSong(song.id, existing.id, {
                fileStoreId: stored.id,
                ...(sha && !existing.sha256 ? { sha256: sha } : {}),
            });
            const refreshedSong = (await getSongById(song.id)) || song;
            return { song: refreshedSong, tabOption: updatedTab, stored, duplicate: false };
        }
        const label = entry?.label || null;
        return mapOpenFileToSong(file, song.id, name || label || file.name, providerId, file.name);
    };
    const mapped = await addScore(tabFile, unpacked.score, tabName);
    song = mapped.song || song;
    const tabOption = mapped.tabOption;
    const tabOptions = new Map();
    if (tabOption) tabOptions.set(tabFile, tabOption);

    // The pack's other scores (a PDF beside a Guitar Pro file, say) become more tabs of the song
    for (const other of unpacked.otherScores || []) {
        try {
            const added = await addScore(other.file, other.score, null);
            song = added.song || song;
            if (added.tabOption) tabOptions.set(other.file, added.tabOption);
        } catch (e) {
            console.warn('[mpak] could not add the', other.score.id, 'score to the song:', e);
        }
    }

    song = (await linkImportedSets(song, tabOptions)) || song;

    const mainKey = (song.artist && song.title)
        ? `${song.artist} - ${song.title}`
        : (song.title || tabFile.name.replace(/\.[^/.]+$/, ''));

    const aliasSet = new Set();
    const headerKey = (header.song?.artist && header.song?.title)
        ? `${header.song.artist} - ${header.song.title}`
        : (header.song?.title || '');
    if (headerKey && headerKey.toLowerCase() !== mainKey.toLowerCase()) aliasSet.add(headerKey);
    const baseName = (tabFile.name || '').replace(/\.[^/.]+$/, '').trim();
    if (baseName && baseName.toLowerCase() !== mainKey.toLowerCase() && isSongSpecificName(baseName, song.title)) aliasSet.add(baseName);
    const aliasKeys = Array.from(aliasSet);

    const keyMeta = {
        filename: tabFile.name,
        tabName: tabOption?.name || tabFile.name,
        sourceUrl: tabFile.sourceUrl || null,
        sourceWebsite: tabFile.sourceWebsite || null,
    };
    rememberLibrarySongKey(song.id, mainKey, keyMeta);
    for (const ak of aliasKeys) {
        rememberLibrarySongKey(song.id, ak, keyMeta);
    }

    await applyMpakExtras(header, part, {
        songKey: mainKey,
        aliasKeys,
        song,
        applyToActiveReader: false,
        // A song that already had audio keeps it: the pack's recording is stored beside it, with its sync points
        keepExistingSlots: keepExistingSlots !== undefined ? keepExistingSlots : merged,
    });

    return {
        song,
        tabOption,
        tabOptions,
        stored: mapped.stored,
        merged,
        created,
        header,
    };
}
