// mpak.js
// The .mpak song bundle (Music Pack v1 specification): a ZIP container with `manifest.json`, `score/<name>` (or `score.externalPath` for shared PDFs),
// `audio/<name>` (stored), and `sync/<id>.json`.

import {
    MEDIA_TYPE,
    ANCHOR,
    MpakError,
    sha256,
    bytesSource,
    readDirectory,
    readEntry,
    openMpak as coreOpenMpak,
    buildMpak as coreBuildMpak,
} from './mpak/core/index.js';

export const MPAK_FORMAT = 'mpak';
export const MPAK_VERSION = 1;
export const MPAK_EXTENSION = 'mpak';

const SLOTS = ['original', 'backing'];
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
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

function toV1SyncFile(rec, recordingId, anchorType) {
    const seenTimes = new Set();
    const points = [];
    const sorted = [...(rec.points || [])].sort((a, b) => a.timeMs - b.timeMs);
    for (const p of sorted) {
        if (!Number.isFinite(p.timeMs) || p.timeMs < 0) continue;
        let t = p.timeMs;
        while (seenTimes.has(t)) t += 1;
        seenTimes.add(t);
        const pt = {
            timeMs: t,
            bar: p.barIndex,
            occurrence: Number.isInteger(p.occurrence) && p.occurrence >= 0 ? p.occurrence : 0,
            pos: Number.isFinite(p.pos) ? Math.max(0, Math.min(1, p.pos)) : 0,
            source: (p.source === 'tap' || p.source === 'manual' || p.source === 'auto') ? p.source : 'manual',
        };
        if (typeof p.id === 'string' && p.id) pt.id = p.id;
        points.push(pt);
    }
    return {
        version: 1,
        recording: recordingId,
        anchorType,
        updatedAt: new Date(Number.isFinite(rec.updatedAt) && rec.updatedAt > 0 ? rec.updatedAt : Date.now()).toISOString(),
        points,
    };
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

/** Builds a v1 .mpak bundle for the open song. Returns `{ blob, filename }`. */
export async function buildMpak(file, options = {}) {
    const { getAudioFile } = await import('./audioSync/audioFileStore.js');
    const { listRecords, isSyncSharedFromOriginal, mediaKey } = await import('./audioSync/syncStore.js');

    let songKey = options.songKey || '';
    let activeArtist = '';
    let activeTitle = '';
    if (!songKey || !options.song) {
        try {
            const { getSongKey, playerState } = await import('./youtubePlayer.js');
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
    const tabFormat = inferTabFormat(file);
    const name = file.name || `score.${tabFormat}`;
    const safeTabName = sanitizeSegment(name, `score.${tabFormat}`);
    const tabPath = `score/${safeTabName}`;
    const tabBytes = new Uint8Array(await file.arrayBuffer());
    const tabSha256 = await sha256(tabBytes);

    const files = new Map([[tabPath, tabBytes]]);
    const score = {
        path: tabPath,
        format: tabFormat,
        sha256: tabSha256,
        name,
    };
    const tuningArr = toManifestTuning(await manualTuning(file));
    if (tuningArr) score.instruments = [{ tuning: tuningArr }];
    if (tabFormat === 'pdf') {
        const startPage = options.startPage ?? file.mpakPageRange?.startPage;
        const endPage = options.endPage ?? file.mpakPageRange?.endPage;
        const pages = options.pages ?? file.mpakPageRange?.pages;
        if (Number.isInteger(pages) && pages >= 1) score.pages = pages;
        if (Number.isInteger(startPage) && startPage >= 1) score.startPage = startPage;
        if (Number.isInteger(endPage) && endPage >= 1) score.endPage = endPage;
    }

    const manifest = {
        format: MPAK_FORMAT,
        version: MPAK_VERSION,
        createdAt: new Date().toISOString(),
        generator: { name: 'MajesticTab' },
        ...(buildManifestSong(normSong) ? { song: buildManifestSong(normSong) } : {}),
        score,
        recordings: [],
    };

    const recordsByMedia = new Map();
    for (const rec of listRecords(songKey)) {
        const k = mediaKey(rec.media);
        if (k && rec.points?.length) recordsByMedia.set(k, rec);
    }

    const usedNames = new Set();
    for (const slot of SLOTS) {
        const source = getSlotSourceFn(slot);
        const sources = [];
        let syncRec = null;
        try {
            if (source === 'local') {
                let id = localStorage.getItem(`audio_file_${enc(songKey)}_${slot}`);
                if (!id && slot === 'original') id = localStorage.getItem(`audio_file_last_${enc(songKey)}`);
                const rec = id ? await getAudioFile(id) : null;
                if (rec?.data) {
                    const audioBytes = new Uint8Array(rec.data);
                    let audioName = sanitizeSegment(rec.name, `${slot}.audio`);
                    if (usedNames.has(audioName.toLowerCase())) audioName = `${slot}-${audioName}`;
                    usedNames.add(audioName.toLowerCase());
                    const audioPath = `audio/${audioName}`;
                    files.set(audioPath, audioBytes);
                    const fileSrc = {
                        type: 'file',
                        path: audioPath,
                        mime: rec.type || 'audio/mpeg',
                        sha256: await sha256(audioBytes),
                    };
                    if (Number.isFinite(rec.durationMs) && rec.durationMs >= 0) fileSrc.durationMs = rec.durationMs;
                    sources.push(fileSrc);
                    syncRec = recordsByMedia.get(mediaKey({ kind: 'local', audioId: id })) || null;
                }
            } else if (source === 'embedded' && tabFormat === 'gp') {
                sources.push({ type: 'embedded' });
            }

            const videoId = localStorage.getItem(`yt_track_${enc(songKey)}_${slot}`);
            if (videoId && YT_ID_RE.test(videoId)) {
                sources.push({ type: 'youtube', videoId });
                if (!syncRec) syncRec = recordsByMedia.get(mediaKey({ kind: 'youtube', videoId })) || null;
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
        if (syncRec && ANCHOR[tabFormat] === 'bar') {
            const syncPath = `sync/${slot}.json`;
            const syncDoc = toV1SyncFile(syncRec, slot, 'bar');
            if (syncDoc.points.length) {
                files.set(syncPath, new TextEncoder().encode(JSON.stringify(syncDoc, null, 2) + '\n'));
                recording.sync = syncPath;
            }
        }
        manifest.recordings.push(recording);
    }

    // The first recording is the default (SPEC section 7), and the slots are visited original first.
    if (manifest.recordings.some((r) => r.id === 'original')) {
        const backing = manifest.recordings.find((r) => r.id === 'backing');
        if (backing && !backing.sync && isSyncSharedFromOriginal(songKey)) {
            backing.syncFrom = 'original';
        }
    }

    const { parts } = await coreBuildMpak(manifest, files);
    const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
    const artist = clean(normSong.artist);
    const title = clean(normSong.title);
    const base = (artist && title ? `${artist} - ${title}` : title || artist) || name.replace(/\.[^.]+$/, '') || 'song';
    return {
        blob: new Blob(parts, { type: MEDIA_TYPE }),
        filename: `${base}.${MPAK_EXTENSION}`,
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
export async function unpackMpak(input, options = {}) {
    const { header, opened } = await readMpak(input, options);
    if (!SUPPORTED_SCORE_FORMATS.includes(header.score.format)) {
        throw new MpakError(`This .mpak file has a ${SCORE_FORMAT_NAMES[header.score.format] || header.score.format} score, which MajesticTab cannot open. It opens Guitar Pro, PDF and text scores.`);
    }
    if (!opened.score) {
        const extPath = header.score?.externalPath || 'external PDF';
        throw new MpakError(`This .mpak file references an external score (${extPath}) that was not provided.`);
    }
    const tabName = header.score.name || (header.score.path || header.score.externalPath || `score.${header.score.format}`).split('/').pop();
    const mime = MIME_BY_FORMAT[header.score.format] || 'application/octet-stream';
    const tabFile = new File([opened.score], tabName, { type: mime });
    // `instruments` is informational and only for scores that carry no tuning of their own (SPEC section 6): take the
    // first entry that lists a tuning.
    const instrumentTuning = (header.score?.instruments || []).find((i) => Array.isArray(i?.tuning) && i.tuning.length)?.tuning;
    if (instrumentTuning) {
        tabFile.tabTuning = {
            tuning: instrumentTuning.map((n) => n.replace(/-?[0-9]$/, '')).join(' '),
            source: 'user',
        };
    }
    if (header.score?.startPage != null || header.score?.endPage != null) {
        tabFile.mpakPageRange = {
            startPage: header.score.startPage ?? 1,
            endPage: header.score.endPage ?? header.score.pages ?? null,
            pages: header.score.pages ?? null,
        };
    }
    tabFile.mpakSong = header.song;
    if (header.song?.title && !tabFile.songTitle) tabFile.songTitle = header.song.title;
    if (header.song?.artist && !tabFile.artist) tabFile.artist = header.song.artist;
    if (header.song?.album && !tabFile.album) tabFile.album = header.song.album;
    if (header.song?.recordingMbid) tabFile.recordingMbid = header.song.recordingMbid;
    if (header.song?.artistMbid) tabFile.artistMbid = header.song.artistMbid;
    if (header.song?.albumMbid) tabFile.albumMbid = header.song.albumMbid;
    if (input?.sourceUrl && !tabFile.sourceUrl) tabFile.sourceUrl = input.sourceUrl;
    if (input?.sourceWebsite && !tabFile.sourceWebsite) tabFile.sourceWebsite = input.sourceWebsite;
    if (input?.providerId && !tabFile.providerId) tabFile.providerId = input.providerId;
    return { header, opened, part: opened, tabFile };
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

        if (!targetSongId) {
            const { findMatchingSongInLibrary } = await import('./libraryStore.js');
            const matched = await findMatchingSongInLibrary(songInfo, collectionId);
            if (matched) targetSongId = matched.id;
        }

        const hasMbids = Boolean(songInfo.recordingMbid || songInfo.albumMbid);
        if (targetSongId || hasMbids) {
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

    const { loadFile } = await import('./main.js');
    await loadFile(tabFile);
    await applyMpakExtras(header, opened);
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
    return bySlot;
}

/**
 * Attaches an .mpak bundle's recordings (original/backing audio, embedded, or YouTube) and sync points to
 * the given `songKey` and `aliasKeys` (or the currently active reader's songKey when omitted).
 */
export async function applyMpakExtras(data, opened, options = {}) {
    const { saveAudioFile, linkAudioFile, setAudioPeaks } = await import('./audioSync/audioFileStore.js');
    const { decodePeaks } = await import('./audioSync/peaks.js');
    const { attachLibraryAudio } = await import('./audioSync/libraryAudio.js');
    const { saveRecord, setSyncSharedFromOriginal, mediaKey, SYNC_CHANGED_EVENT } = await import('./audioSync/syncStore.js');

    let activeReaderKey = null;
    if (!options.songKey || options.applyToActiveReader === undefined) {
        try {
            const { getSongKey } = await import('./youtubePlayer.js');
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
            updateRecordingSlots = rac.updateRecordingSlots;
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
    const resolvedMedia = new Map();

    for (const slot of SLOTS) {
        const rec = slots[slot];
        if (!rec) continue;
        try {
            const syncDoc = typeof opened?.sync === 'function' ? opened.sync(rec.id) : null;
            const hasSync = Boolean(syncDoc?.points?.length);

            // Cache any YouTube fallback videoId on the recording
            const ytSrc = (rec.sources || []).find((s) => s.type === 'youtube' && s.videoId);
            if (ytSrc) {
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
                    for (const k of allKeys) {
                        if (k !== primaryKey) {
                            await linkAudioFile(meta.id, k).catch(() => {});
                        }
                        localStorage.setItem(`audio_file_${enc(k)}_${slot}`, meta.id);
                        if (slot === 'original') localStorage.setItem(`audio_file_last_${enc(k)}`, meta.id);
                        localStorage.setItem(`real_audio_source_${enc(k)}_${slot}`, 'local');
                    }
                    if (targetSong) {
                        try { attachLibraryAudio(targetSong, meta.id, slot); } catch { /* optional */ }
                    }
                    if (applyToActiveReader) {
                        setSlotSource('local', slot);
                    }
                    decodePeaks(audioBuf.slice(0))
                        .then(({ peaks, durationMs }) => setAudioPeaks(meta.id, peaks, durationMs))
                        .catch(() => {});
                    resolvedMedia.set(rec.id, {
                        kind: 'local', audioId: meta.id, name: meta.name, durationMs: meta.durationMs ?? null, fingerprint: meta.fingerprint,
                    });
                    handled = true;
                    break;
                }
                if (src.type === 'embedded' && data.score?.format === 'gp') {
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

            if (handled && syncDoc?.points?.length && syncDoc.anchorType === 'bar') {
                const media = resolvedMedia.get(rec.id);
                if (media) {
                    const mjPoints = syncDoc.points.map((p) => ({
                        ...(p.id ? { id: p.id } : {}),
                        barIndex: p.bar,
                        occurrence: p.occurrence ?? 0,
                        pos: p.pos ?? 0,
                        timeMs: p.timeMs,
                        source: p.source || 'manual',
                    }));
                    for (const k of allKeys) {
                        saveRecord(k, media, mjPoints);
                    }
                }
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
            const ytSrc = (rec.sources || []).find((s) => s.type === 'youtube' && s.videoId);
            if (!ytSrc) continue;
            const syncDoc = typeof opened?.sync === 'function' ? opened.sync(rec.id) : null;
            if (!syncDoc?.points?.length || syncDoc.anchorType !== 'bar') continue;
            const media = { kind: 'youtube', videoId: ytSrc.videoId, ...(rec.label ? { label: rec.label } : {}) };
            const key = mediaKey(media);
            if (!key || taken.has(key)) continue;
            taken.add(key);
            const points = syncDoc.points.map((p) => ({
                ...(p.id ? { id: p.id } : {}),
                barIndex: p.bar,
                occurrence: p.occurrence ?? 0,
                pos: p.pos ?? 0,
                timeMs: p.timeMs,
                source: p.source || 'manual',
            }));
            for (const k of allKeys) saveRecord(k, media, points);
        } catch (e) {
            console.warn('[mpak] could not attach the', rec?.id, 'recording:', e);
        }
    }

    if (slots.backing && !slots.backing.sync && slots.backing.syncFrom && slots.backing.syncFrom === slots.original?.id && !slots.backing.syncOffsetMs) {
        for (const k of allKeys) {
            setSyncSharedFromOriginal(k, true);
        }
    }

    if (applyToActiveReader) {
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
    } = options;

    const unpacked = (input && input.header && input.part && input.tabFile)
        ? input
        : await unpackMpak(input);
    const { header, part, tabFile } = unpacked;

    const { getSongById, resolveAndSaveOrMergeSong, mapOpenFileToSong } = await import('./libraryStore.js');

    let song = null;
    let merged = false;
    let created = false;

    if (targetSongId) {
        song = await getSongById(targetSongId);
        if (song) merged = true;
    }

    if (!song) {
        const resolved = await resolveAndSaveOrMergeSong(header.song || {}, collectionId, {
            queryMusicBrainz,
            allowTextFallback,
        });
        song = resolved.song;
        merged = resolved.merged;
        created = resolved.created;
    }

    const mapped = await mapOpenFileToSong(
        tabFile,
        song.id,
        tabName || tabFile.name,
        providerId,
        relativePath || tabFile.name
    );
    song = mapped.song || song;
    const tabOption = mapped.tabOption;

    const mainKey = (song.artist && song.title)
        ? `${song.artist} - ${song.title}`
        : (song.title || tabFile.name.replace(/\.[^/.]+$/, ''));

    const aliasSet = new Set();
    const headerKey = (header.song?.artist && header.song?.title)
        ? `${header.song.artist} - ${header.song.title}`
        : (header.song?.title || '');
    if (headerKey && headerKey.toLowerCase() !== mainKey.toLowerCase()) aliasSet.add(headerKey);
    const baseName = (tabFile.name || '').replace(/\.[^/.]+$/, '').trim();
    if (baseName && baseName.toLowerCase() !== mainKey.toLowerCase()) aliasSet.add(baseName);
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
    });

    return {
        song,
        tabOption,
        stored: mapped.stored,
        merged,
        created,
        header,
    };
}
