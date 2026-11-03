// syncStore.js
// Per-song storage for audio sync data (the points that align a score to a recording). One localStorage entry per
// song and recording, so a song can have several (a studio and a live version). Like the cached YouTube choice
// (`yt_track_*`), the entries are collected into backups and cloud snapshots as one map (`audioSync`), see
// collectAudioSync / mergeAudioSync below.
//
// Record: { version: 1, media: { kind: 'youtube', videoId } | { kind: 'local', audioId, name, durationMs, fingerprint },
//           points: [{ id, barIndex, occurrence, pos, timeMs, source }], updatedAt }

/** Fired on `window` when a recording's sync points change. */
export const SYNC_CHANGED_EVENT = 'audiosync:changed';

export const AUDIO_SYNC_PREFIX = 'audio_sync_';
export const AUDIO_SYNC_VERSION = 1;

const POINT_SOURCES = new Set(['tap', 'manual', 'auto']);

export function mediaKey(media) {
    if (media?.kind === 'youtube' && media.videoId) return `yt_${media.videoId}`;
    if (media?.kind === 'local' && media.audioId) return `local_${media.audioId}`;
    return null;
}

/** Storage key for one song and recording. `songKey` is the song identity string (see getSongKey). */
export function storageKey(songKey, media) {
    const m = mediaKey(media);
    return m ? `${AUDIO_SYNC_PREFIX}${encodeURIComponent(String(songKey).toLowerCase())}_${m}` : null;
}

function cleanPoint(p) {
    if (!p || typeof p !== 'object') return null;
    const { barIndex, occurrence = 0, pos = 0, timeMs } = p;
    if (!Number.isInteger(barIndex) || barIndex < 0) return null;
    if (!Number.isInteger(occurrence) || occurrence < 0) return null;
    if (!Number.isFinite(pos) || pos < 0 || pos > 1) return null;
    if (!Number.isFinite(timeMs) || timeMs < 0) return null;
    return {
        id: typeof p.id === 'string' && p.id ? p.id : `p_${barIndex}_${occurrence}_${Math.round(pos * 1000)}`,
        barIndex, occurrence, pos, timeMs,
        source: POINT_SOURCES.has(p.source) ? p.source : 'manual'
    };
}

/** Returns a clean record, or null when `raw` is not usable. Drops malformed points and sorts by time. */
export function normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object' || raw.version !== AUDIO_SYNC_VERSION) return null;
    if (!mediaKey(raw.media) || !Array.isArray(raw.points)) return null;
    const m = raw.media;
    const media = m.kind === 'youtube'
        ? { kind: 'youtube', videoId: String(m.videoId) }
        : {
            kind: 'local', audioId: String(m.audioId), name: String(m.name ?? ''),
            durationMs: Number.isFinite(m.durationMs) ? m.durationMs : null, fingerprint: String(m.fingerprint ?? '')
        };
    const points = raw.points.map(cleanPoint).filter(Boolean).sort((a, b) => a.timeMs - b.timeMs);
    return { version: AUDIO_SYNC_VERSION, media, points, updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0 };
}

function parse(text) {
    try { return normalizeRecord(JSON.parse(text)); } catch { return null; }
}

// Per song option: a backing track with no points of its own uses the original recording's points.
const SHARE_PREFIX = 'audio_sync_share_';
const shareKey = (songKey) => `${SHARE_PREFIX}${encodeURIComponent(String(songKey).toLowerCase())}`;

export function isSyncSharedFromOriginal(songKey, storage = localStorage) {
    try { return storage.getItem(shareKey(songKey)) === '1'; } catch { return false; }
}

export function setSyncSharedFromOriginal(songKey, on, storage = localStorage) {
    try {
        if (on) storage.setItem(shareKey(songKey), '1');
        else storage.removeItem(shareKey(songKey));
    } catch { /* ignore */ }
}

let slotMediaResolver = null;
/** The player registers `(songKey) => ({ original, backing })` (media descriptors or null) so the store knows which recording is which. */
export function setSlotMediaResolver(fn) { slotMediaResolver = fn; }

function loadOwnRecord(songKey, media, storage) {
    const key = storageKey(songKey, media);
    if (!key) return null;
    try { const text = storage.getItem(key); return text === null ? null : parse(text); } catch { return null; }
}

/**
 * The record for a recording. A backing track without points of its own gets the original recording's points
 * (marked `inherited`) when the song's option is on; saving after an edit stores them under the backing track.
 */
export function loadRecord(songKey, media, storage = localStorage) {
    const own = loadOwnRecord(songKey, media, storage);
    if (own?.points.length || !slotMediaResolver || !isSyncSharedFromOriginal(songKey, storage)) return own;
    let slots = null;
    try { slots = slotMediaResolver(songKey); } catch { slots = null; }
    if (!slots?.original || !slots.backing || mediaKey(slots.backing) !== mediaKey(media)) return own;
    if (mediaKey(slots.original) === mediaKey(media)) return own;
    const orig = loadOwnRecord(songKey, slots.original, storage);
    if (!orig?.points.length) return own;
    return { ...orig, media: normalizeRecord({ ...orig, media }).media, inherited: true };
}

/** Saves `points` for a recording, stamping `updatedAt`. An empty point list removes the entry. Returns the record. */
export function saveRecord(songKey, media, points, storage = localStorage, now = Date.now()) {
    const key = storageKey(songKey, media);
    if (!key) return null;
    const record = normalizeRecord({ version: AUDIO_SYNC_VERSION, media, points, updatedAt: now });
    try {
        if (!record.points.length) storage.removeItem(key);
        else storage.setItem(key, JSON.stringify(record));
    } catch (e) {
        console.warn('[Audio Sync] Could not save sync points:', e);
        return null;
    }
    return record;
}

export function deleteRecord(songKey, media, storage = localStorage) {
    const key = storageKey(songKey, media);
    if (key) try { storage.removeItem(key); } catch { /* ignore */ }
}

/** Every stored record of a song, newest first. */
export function listRecords(songKey, storage = localStorage) {
    const prefix = `${AUDIO_SYNC_PREFIX}${encodeURIComponent(String(songKey).toLowerCase())}_`;
    const out = [];
    for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(prefix)) {
            const rec = parse(storage.getItem(k));
            if (rec) out.push(rec);
        }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** True when any recording of the song has at least one sync point. */
export function songHasSyncPoints(songKey, storage = localStorage) {
    try { return listRecords(songKey, storage).some(r => r.points.length > 0); } catch { return false; }
}

// --- Backup and cloud sync plumbing ------------------------------------------------------------------------------

/** All entries as `{ storageKey: record }` for a backup or snapshot. Empty when there are none. */
export function collectAudioSync(storage = localStorage) {
    const out = {};
    for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(AUDIO_SYNC_PREFIX)) {
            const rec = parse(storage.getItem(k));
            if (rec) out[k] = rec;
        }
    }
    return out;
}

/**
 * Applies a collected map. With `wipe` the incoming entries replace everything; otherwise an incoming record only
 * replaces a local one when it is newer, so editing on two devices keeps the latest edit. Returns the number written.
 */
export function mergeAudioSync(incoming, { wipe = false } = {}, storage = localStorage) {
    let written = 0;
    for (const [key, raw] of Object.entries(incoming || {})) {
        if (!key.startsWith(AUDIO_SYNC_PREFIX)) continue;
        const rec = normalizeRecord(raw);
        if (!rec || !rec.points.length) continue;
        const local = wipe ? null : parse(storage.getItem(key));
        if (local && local.updatedAt >= rec.updatedAt) continue;
        try { storage.setItem(key, JSON.stringify(rec)); written++; } catch { /* quota: skip */ }
    }
    return written;
}

/** Removes every entry (for a wipe or reset). */
export function clearAudioSync(storage = localStorage) {
    const keys = [];
    for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(AUDIO_SYNC_PREFIX)) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
}
