// mtab.js
// The .mtab song bundle: one file that carries a song to another player with everything they need to practise it.
// It holds the original tab file, the recordings attached to it (a YouTube video, or an audio file, for the Original
// and Backing slots), the sync points that align the score to each recording, and what the player entered by hand
// (the tuning of a PDF or text tab).
//
// Layout: the bytes "MTAB", a 4 byte big-endian length N, N bytes of JSON (the header), then the binary parts one
// after the other. Binary parts are raw bytes, never base64, so a bundle has no size limit of its own and is never
// held as one string: it is written and read as Blob slices.
//
// header: { format: 'majestictab-song', version: 1, createdAt,
//   song: { artist, title, album?, year?, trackNumber?, mediumNumber?, length?,
//           recordingMbid?, artistMbid?, albumMbid?, musicbrainz?: { recordingMbid?, artistMbid?, albumMbid? } },
//   tab: { name, type, size },                      part 0
//   tuning: string | null,
//   recordings: { original|backing: { source: 'youtube', videoId }
//                 | { source: 'local', audio: { id, name, type, durationMs, fingerprint, size } } },  parts 1.. in order
//   sync: [record], shareSyncFromOriginal: boolean }

export const MTAB_FORMAT = 'majestictab-song';
export const MTAB_VERSION = 1;
export const MTAB_EXTENSION = 'mtab';
const MAGIC = 'MTAB';
const SLOTS = ['original', 'backing'];

const enc = (s) => encodeURIComponent(String(s).toLowerCase());

export const isMtabFile = (file) => /\.mtab$/i.test(file?.name || '');

export function isMtabBytes(bytes) {
    if (!bytes) return false;
    const u8 = bytes instanceof Uint8Array
        ? bytes
        : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : (ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null));
    if (!u8 || u8.length < 8) return false;
    return u8[0] === 0x4d && u8[1] === 0x54 && u8[2] === 0x41 && u8[3] === 0x42;
}

/** Normalize `header.song` (including MusicBrainz IDs in direct fields or nested `musicbrainz` object). */
export function normalizeMtabSong(rawSong = {}, rawHeader = {}) {
    const s = (rawSong && typeof rawSong === 'object') ? rawSong : {};
    const mb = (s.musicbrainz && typeof s.musicbrainz === 'object')
        ? s.musicbrainz
        : ((rawHeader?.musicbrainz && typeof rawHeader.musicbrainz === 'object') ? rawHeader.musicbrainz : {});

    const recordingMbid = String(s.recordingMbid || mb.recordingMbid || mb.recordingId || mb.recording || '').trim() || null;
    const artistMbid = String(s.artistMbid || mb.artistMbid || mb.artistId || mb.artist || '').trim() || null;
    const albumMbid = String(
        s.albumMbid || s.releaseGroupMbid || s.releaseGroupId || s.releaseId ||
        mb.albumMbid || mb.releaseGroupMbid || mb.releaseGroupId || mb.albumId || mb.releaseId || ''
    ).trim() || null;

    const normalized = {
        artist: String(s.artist || '').trim(),
        title: String(s.title || '').trim()
    };

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
    if (recordingMbid || artistMbid || albumMbid) {
        normalized.musicbrainz = {
            ...(recordingMbid ? { recordingMbid } : {}),
            ...(artistMbid ? { artistMbid } : {}),
            ...(albumMbid ? { albumMbid } : {})
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
            sourceUrl: meta.sourceUrl || null
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

/** Builds the bundle for the open song. Returns `{ blob, filename }`. Audio of any size goes in. */
export async function buildMtab(file, options = {}) {
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

    const priorMtabSong = (file?.mtabSong && typeof file.mtabSong === 'object') ? file.mtabSong : {};
    const rawSongMeta = {
        artist: options.song?.artist || activeArtist || libSong?.artist || priorMtabSong.artist || file?.artist || '',
        title: options.song?.title || activeTitle || libSong?.title || priorMtabSong.title || file?.songTitle || '',
        album: options.song?.album || (libSong?.album && libSong.album !== 'Unknown Album' ? libSong.album : '') || priorMtabSong.album || file?.album || '',
        year: options.song?.year ?? libSong?.year ?? priorMtabSong.year ?? null,
        trackNumber: options.song?.trackNumber ?? libSong?.trackNumber ?? priorMtabSong.trackNumber ?? null,
        mediumNumber: options.song?.mediumNumber ?? libSong?.mediumNumber ?? priorMtabSong.mediumNumber ?? null,
        length: options.song?.length ?? libSong?.length ?? priorMtabSong.length ?? null,
        recordingMbid: options.song?.recordingMbid || libSong?.recordingMbid || priorMtabSong.recordingMbid || file?.recordingMbid || null,
        artistMbid: options.song?.artistMbid || libSong?.artistMbid || priorMtabSong.artistMbid || file?.artistMbid || null,
        albumMbid: options.song?.albumMbid || libSong?.albumMbid || priorMtabSong.albumMbid || file?.albumMbid || null,
        musicbrainz: options.song?.musicbrainz || priorMtabSong.musicbrainz || null
    };

    const name = file.name || 'tab';
    const parts = [file];
    const header = {
        format: MTAB_FORMAT,
        version: MTAB_VERSION,
        createdAt: Date.now(),
        song: normalizeMtabSong(rawSongMeta),
        tab: { name, type: file.type || 'application/octet-stream', size: file.size },
        tuning: await manualTuning(file),
        recordings: {},
        sync: [],
        shareSyncFromOriginal: false
    };
    const usedMedia = new Set();

    for (const slot of SLOTS) {
        const source = getSlotSourceFn(slot);
        try {
            if (source === 'local') {
                let id = localStorage.getItem(`audio_file_${enc(songKey)}_${slot}`);
                if (!id && slot === 'original') id = localStorage.getItem(`audio_file_last_${enc(songKey)}`);
                const rec = id ? await getAudioFile(id) : null;
                if (rec?.data) {
                    header.recordings[slot] = {
                        source: 'local',
                        audio: {
                            id, name: rec.name, type: rec.type || 'audio/mpeg', durationMs: rec.durationMs ?? null,
                            fingerprint: rec.fingerprint || '', size: rec.data.byteLength
                        }
                    };
                    parts.push(rec.data);
                    usedMedia.add(mediaKey({ kind: 'local', audioId: id }));
                }
            } else if (source === 'embedded') {
                header.recordings[slot] = { source: 'embedded' };
            } else {
                const videoId = localStorage.getItem(`yt_track_${enc(songKey)}_${slot}`);
                if (videoId) {
                    header.recordings[slot] = { source: 'youtube', videoId };
                    usedMedia.add(mediaKey({ kind: 'youtube', videoId }));
                }
            }
        } catch (e) {
            console.warn('[mtab] could not read the', slot, 'recording:', e);
        }
    }

    // Sync points only for recordings the bundle carries
    for (const rec of listRecords(songKey)) {
        if (rec.points.length && usedMedia.has(mediaKey(rec.media))) header.sync.push(rec);
    }
    header.shareSyncFromOriginal = isSyncSharedFromOriginal(songKey);

    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, headerBytes.length);
    // "Artist - Song", never the original file's name; characters a file system rejects are dropped
    const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
    const artist = clean(header.song.artist);
    const title = clean(header.song.title);
    const base = (artist && title ? `${artist} - ${title}` : title || artist) || name.replace(/\.[^.]+$/, '') || 'song';
    return {
        blob: new Blob([MAGIC, length, headerBytes, ...parts], { type: 'application/x-majestictab-song' }),
        filename: `${base}.${MTAB_EXTENSION}`
    };
}

/**
 * A bundle the desktop shell was opened with. It stays on disk: Rust hands over only its path and size, and the
 * pieces are read on demand, so a bundle with hours of audio never goes through the page as one array.
 */
export function nativeMtabSource({ name, path, size }) {
    return {
        name, size,
        read: async (start, end, type = '') => {
            const bytes = await window.__TAURI__.core.invoke('read_opened_file_range', { path, start, len: end - start });
            return new Blob([bytes], { type });
        }
    };
}

// A File, Blob, Uint8Array, ArrayBuffer, or a source with `read`, as one shape: `{ name, size, read(start, end, type) -> Promise<Blob> }`
function asSource(f) {
    if (!f) return { name: '', size: 0, read: async () => new Blob([]) };
    if (typeof f.read === 'function') return f;
    if (f instanceof Uint8Array || f instanceof ArrayBuffer || ArrayBuffer.isView(f)) {
        const blob = new Blob([f]);
        return { name: f.name || '', size: blob.size, read: async (a, b, type = '') => blob.slice(a, b, type) };
    }
    return { name: f.name || '', size: f.size ?? 0, read: async (a, b, type = '') => f.slice(a, b, type) };
}

/** Parses a bundle: `{ header, part(i) }`, where `part(i)` is the i-th binary part as a Promise of a Blob. Throws a readable error. */
export async function readMtab(input) {
    const file = asSource(input);
    const notBundle = () => new Error('This is not a MajesticTab song file');
    if (file.size < 8 || (await (await file.read(0, 4)).text()) !== MAGIC) throw notBundle();
    const headerLength = new DataView(await (await file.read(4, 8)).arrayBuffer()).getUint32(0);
    if (8 + headerLength > file.size) throw notBundle();
    let header;
    try { header = JSON.parse(await (await file.read(8, 8 + headerLength)).text()); } catch { throw notBundle(); }
    if (header?.format !== MTAB_FORMAT || !header.tab?.name) throw notBundle();
    if (!Number.isInteger(header.version) || header.version > MTAB_VERSION) throw new Error('This song file is from a newer MajesticTab. Update the app to open it.');

    header.song = normalizeMtabSong(header.song, header);

    const sizes = [header.tab.size, ...SLOTS.map((s) => header.recordings?.[s]?.audio?.size).filter((n) => n !== undefined)];
    let offset = 8 + headerLength;
    const spans = sizes.map((n) => { const span = [offset, offset + n]; offset += n; return span; });
    if (offset > file.size || sizes.some((n) => !Number.isInteger(n) || n < 0)) throw new Error('This song file is incomplete');
    return { header, part: (i, type = '') => file.read(spans[i][0], spans[i][1], type) };
}

/**
 * Unpacks an .mtab bundle into `{ header, part, tabFile }`, attaching normalized `header.song`
 * (including any MusicBrainz IDs) as `tabFile.mtabSong`.
 */
export async function unpackMtab(input) {
    const { header, part } = await readMtab(input);
    const tabBlob = await part(0, header.tab.type || '');
    const tabFile = new File([tabBlob], header.tab.name, { type: header.tab.type || '' });
    if (header.tuning) tabFile.tabTuning = { tuning: header.tuning, source: 'user' };
    tabFile.mtabSong = header.song;
    if (header.song?.title && !tabFile.songTitle) tabFile.songTitle = header.song.title;
    if (header.song?.artist && !tabFile.artist) tabFile.artist = header.song.artist;
    if (header.song?.album && !tabFile.album) tabFile.album = header.song.album;
    if (header.song?.recordingMbid) tabFile.recordingMbid = header.song.recordingMbid;
    if (header.song?.artistMbid) tabFile.artistMbid = header.song.artistMbid;
    if (header.song?.albumMbid) tabFile.albumMbid = header.song.albumMbid;
    if (input?.sourceUrl && !tabFile.sourceUrl) tabFile.sourceUrl = input.sourceUrl;
    if (input?.sourceWebsite && !tabFile.sourceWebsite) tabFile.sourceWebsite = input.sourceWebsite;
    if (input?.providerId && !tabFile.providerId) tabFile.providerId = input.providerId;
    return { header, part, tabFile };
}

/**
 * Opens a bundle: loads its tab, then attaches the recordings, sync points and tuning to the song as the open tab
 * knows it (its song key is only settled once the tab is loaded).
 */
export async function openMtab(file) {
    const { header, part, tabFile } = await unpackMtab(file);

    const { loadFile } = await import('./main.js');
    await loadFile(tabFile);
    await applyMtabExtras(header, part);
}

/**
 * Attaches an .mtab bundle's recordings (original/backing audio or YouTube) and sync points to
 * the given `songKey` and `aliasKeys` (or the currently active reader's songKey when omitted).
 */
export async function applyMtabExtras(data, part, options = {}) {
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

    // Bundle media identity -> the media on this device (a local audio file may get another id here)
    const remap = new Map();
    let partIndex = 1;
    for (const slot of SLOTS) {
        const r = data.recordings?.[slot];
        if (!r) continue;
        try {
            if (r.source === 'youtube' && r.videoId) {
                const hasSync = data.sync?.some((rec) => rec?.points?.length && rec.media?.kind === 'youtube' && rec.media?.videoId === r.videoId);
                const preferEmbedded = slot === 'original' && !hasSync && applyToActiveReader && hasEmbeddedAudio();
                const chosenSource = preferEmbedded ? 'embedded' : 'youtube';
                for (const k of allKeys) {
                    localStorage.setItem(`yt_track_${enc(k)}_${slot}`, String(r.videoId));
                    localStorage.setItem(`real_audio_source_${enc(k)}_${slot}`, chosenSource);
                }
                if (applyToActiveReader) {
                    setSlotSource(chosenSource, slot);
                }
                remap.set(mediaKey({ kind: 'youtube', videoId: r.videoId }), { kind: 'youtube', videoId: r.videoId });
            } else if (r.source === 'embedded') {
                for (const k of allKeys) {
                    localStorage.setItem(`real_audio_source_${enc(k)}_${slot}`, 'embedded');
                }
                if (applyToActiveReader) {
                    setSlotSource('embedded', slot);
                }
            } else if (r.source === 'local' && r.audio) {
                const audioPart = await part(partIndex++, r.audio.type || '');
                const audioBytes = await audioPart.arrayBuffer();
                const meta = await saveAudioFile({
                    name: r.audio.name,
                    type: r.audio.type,
                    data: audioBytes,
                    songKey: primaryKey,
                    durationMs: r.audio.durationMs ?? null
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
                decodePeaks(audioBytes.slice(0))
                    .then(({ peaks, durationMs }) => setAudioPeaks(meta.id, peaks, durationMs))
                    .catch(() => {});
                if (r.audio.id) remap.set(mediaKey({ kind: 'local', audioId: r.audio.id }), {
                    kind: 'local', audioId: meta.id, name: meta.name, durationMs: meta.durationMs ?? null, fingerprint: meta.fingerprint
                });
            }
        } catch (e) {
            console.warn('[mtab] could not attach the', slot, 'recording:', e);
        }
    }
    for (const rec of data.sync || []) {
        const media = remap.get(mediaKey(rec?.media)) || rec?.media;
        if (media && Array.isArray(rec.points)) {
            for (const k of allKeys) {
                saveRecord(k, media, rec.points);
            }
        }
    }
    if (data.shareSyncFromOriginal) {
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
 * Saves an .mtab bundle to the library, using its MusicBrainz IDs (`recordingMbid`, `artistMbid`, `albumMbid`)
 * and song metadata to either:
 *   - Add the song in the proper Artist > Album > Song hierarchy (querying MusicBrainz by ID when needed), or
 *   - Merge into an existing library song as another tab option,
 * and attaches the bundle's recordings and sync points to the library song.
 */
export async function saveMtabToLibrary(input, options = {}) {
    const {
        collectionId = undefined,
        targetSongId = null,
        tabName = null,
        providerId = 'local',
        relativePath = '',
        queryMusicBrainz = true,
        allowTextFallback = false
    } = options;

    const unpacked = (input && input.header && input.part && input.tabFile)
        ? input
        : await unpackMtab(input);
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
            allowTextFallback
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
        sourceWebsite: tabFile.sourceWebsite || null
    };
    rememberLibrarySongKey(song.id, mainKey, keyMeta);
    for (const ak of aliasKeys) {
        rememberLibrarySongKey(song.id, ak, keyMeta);
    }

    await applyMtabExtras(header, part, {
        songKey: mainKey,
        aliasKeys,
        song,
        applyToActiveReader: false
    });

    return {
        song,
        tabOption,
        stored: mapped.stored,
        merged,
        created,
        header
    };
}
