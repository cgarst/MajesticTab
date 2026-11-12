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
// header: { format: 'majestictab-song', version: 1, createdAt, song: { artist, title },
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

/** Builds the bundle for the open song. Returns `{ blob, filename }`. Audio of any size goes in. */
export async function buildMtab(file) {
    const { getSongKey, playerState } = await import('./youtubePlayer.js');
    const { getSlotSource } = await import('./audioSync/realAudioController.js');
    const { getAudioFile } = await import('./audioSync/audioFileStore.js');
    const { listRecords, isSyncSharedFromOriginal, mediaKey } = await import('./audioSync/syncStore.js');

    const songKey = getSongKey();
    const name = file.name || 'tab';
    const parts = [file];
    const header = {
        format: MTAB_FORMAT,
        version: MTAB_VERSION,
        createdAt: Date.now(),
        song: { artist: playerState.artist || '', title: playerState.title || '' },
        tab: { name, type: file.type || 'application/octet-stream', size: file.size },
        tuning: await manualTuning(file),
        recordings: {},
        sync: [],
        shareSyncFromOriginal: false
    };
    const usedMedia = new Set();

    for (const slot of SLOTS) {
        const source = getSlotSource(slot);
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

// A File, or a source with `read`, as one shape: `{ name, size, read(start, end, type) -> Promise<Blob> }`
const asSource = (f) => (typeof f.read === 'function' ? f : { name: f.name, size: f.size, read: async (a, b, type = '') => f.slice(a, b, type) });

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

    const sizes = [header.tab.size, ...SLOTS.map((s) => header.recordings?.[s]?.audio?.size).filter((n) => n !== undefined)];
    let offset = 8 + headerLength;
    const spans = sizes.map((n) => { const span = [offset, offset + n]; offset += n; return span; });
    if (offset > file.size || sizes.some((n) => !Number.isInteger(n) || n < 0)) throw new Error('This song file is incomplete');
    return { header, part: (i, type = '') => file.read(spans[i][0], spans[i][1], type) };
}

/**
 * Opens a bundle: loads its tab, then attaches the recordings, sync points and tuning to the song as the open tab
 * knows it (its song key is only settled once the tab is loaded).
 */
export async function openMtab(file) {
    const { header, part } = await readMtab(file);
    const tabFile = new File([await part(0)], header.tab.name, { type: header.tab.type || '' });
    if (header.tuning) tabFile.tabTuning = { tuning: header.tuning, source: 'user' };

    const { loadFile } = await import('./main.js');
    await loadFile(tabFile);
    await applyMtabExtras(header, part);
}

async function applyMtabExtras(data, part) {
    const { getSongKey } = await import('./youtubePlayer.js');
    const { saveAudioFile } = await import('./audioSync/audioFileStore.js');
    const { saveRecord, setSyncSharedFromOriginal, mediaKey, SYNC_CHANGED_EVENT } = await import('./audioSync/syncStore.js');
    const { setSlotSource, getSlotSource, updateRecordingSlots, hasEmbeddedAudio } = await import('./audioSync/realAudioController.js');
    const songKey = getSongKey();
    if (!songKey) return;

    // Bundle media identity -> the media on this device (a local audio file may get another id here)
    const remap = new Map();
    let partIndex = 1;
    for (const slot of SLOTS) {
        const r = data.recordings?.[slot];
        if (!r) continue;
        try {
            if (r.source === 'youtube' && r.videoId) {
                localStorage.setItem(`yt_track_${enc(songKey)}_${slot}`, String(r.videoId));
                const hasSync = data.sync?.some((rec) => rec?.points?.length && rec.media?.kind === 'youtube' && rec.media?.videoId === r.videoId);
                const preferEmbedded = slot === 'original' && !hasSync && hasEmbeddedAudio();
                setSlotSource(preferEmbedded ? 'embedded' : 'youtube', slot);
                remap.set(mediaKey({ kind: 'youtube', videoId: r.videoId }), { kind: 'youtube', videoId: r.videoId });
            } else if (r.source === 'embedded') {
                setSlotSource('embedded', slot);
            } else if (r.source === 'local' && r.audio) {
                const audioPart = await part(partIndex++, r.audio.type || '');
                const meta = await saveAudioFile({
                    name: r.audio.name, type: r.audio.type, data: await audioPart.arrayBuffer(), songKey,
                    durationMs: r.audio.durationMs ?? null
                });
                localStorage.setItem(`audio_file_${enc(songKey)}_${slot}`, meta.id);
                if (slot === 'original') localStorage.setItem(`audio_file_last_${enc(songKey)}`, meta.id);
                setSlotSource('local', slot);
                if (r.audio.id) remap.set(mediaKey({ kind: 'local', audioId: r.audio.id }), {
                    kind: 'local', audioId: meta.id, name: meta.name, durationMs: meta.durationMs ?? null, fingerprint: meta.fingerprint
                });
            }
        } catch (e) {
            console.warn('[mtab] could not attach the', slot, 'recording:', e);
        }
    }
    for (const rec of data.sync || []) {
        const media = remap.get(mediaKey(rec?.media));
        if (media && Array.isArray(rec.points)) saveRecord(songKey, media, rec.points);
    }
    if (data.shareSyncFromOriginal) setSyncSharedFromOriginal(songKey, true);

    try {
        if (getSlotSource('original') === 'embedded') (await import('./utils/navigationUtils.js')).setActiveAudioMode('real');
    } catch { /* optional */ }
    try { updateRecordingSlots(); } catch { /* the reader draws them next time */ }
    window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
}
