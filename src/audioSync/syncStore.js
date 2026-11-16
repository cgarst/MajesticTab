// syncStore.js
// Per-song storage for audio sync data (the points that align a score to a recording). One localStorage entry per
// song and recording, so a song can have several (a studio and a live version). Like the cached YouTube choice
// (`yt_track_*`), the entries are collected into backups and cloud snapshots as one map (`audioSync`), see
// collectAudioSync / mergeAudioSync below.
//
// Records live in IndexedDB (syncRecordStore.js): localStorage's ~10 MB quota filled up with them.
//
// Record: { version: 2, media: { kind: 'youtube', videoId } | { kind: 'local', audioId, name, durationMs, fingerprint },
//           anchorType: 'bar' | 'pdf' | 'text', points, updatedAt }
//
// A stored point is a Music Pack sync point (SPEC section 9) plus an `id` and a `source`, so a record is a sync file
// of a .mpak: `{ timeMs, bar, occurrence, pos }`, `{ timeMs, page, x?, y? }` or `{ timeMs, line, col? }`. The points of a
// text or PDF tab are kept under the song key `text:<song key>` (a namespace of the key, kept so that backups made by
// earlier versions line up); the record's own `anchorType` says which kind they are.
//
// A record can also carry a restore point, `restore: { points, savedAt }`: the points as a pack or an importer brought
// them, or as the person last saved them, kept apart from the points that edits change. The editor's "Restore
// original" puts them back. The first edit of a record that has none keeps the points from before that edit.
//
// In memory a bar point keeps the name the score code has always used, `barIndex` (it is also the position type of the
// timeline and the beat map), and this module is the one place that turns it into `bar` and back. `pdf` and `text`
// points are the same in memory and in storage.
//
// Version 1 records have `barIndex` and no `anchorType`. Under a `text:` key a version 1 point names a unit (a text
// block number or a PDF canvas index) that only the open tab can turn into a line or a page, so such a record is read
// as `anchorType: 'unit'`, with the unit in `unit`, and textSync.js upgrades it.

import { recordStorage } from './syncRecordStore.js';

/** Fired on `window` when a recording's sync points change. */
export const SYNC_CHANGED_EVENT = 'audiosync:changed';

export const AUDIO_SYNC_PREFIX = 'audio_sync_';
export const AUDIO_SYNC_VERSION = 2;

const POINT_SOURCES = new Set(['tap', 'manual', 'auto']);
const ANCHOR_TYPES = new Set(['bar', 'pdf', 'text']);
const UNIT_KEY_PREFIX = `${AUDIO_SYNC_PREFIX}${encodeURIComponent('text:')}`;
const isUnitKey = (key) => typeof key === 'string' && key.startsWith(UNIT_KEY_PREFIX);

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

const unit01 = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
const sourceOf = (p) => (POINT_SOURCES.has(p.source) ? p.source : 'manual');

/** One point as the app holds it, or null. Reads a stored point (`bar`) and an in-memory one (`barIndex`). */
function cleanPoint(p, anchorType) {
    if (!p || typeof p !== 'object') return null;
    const { occurrence = 0, pos = 0, timeMs } = p;
    if (!Number.isFinite(timeMs) || timeMs < 0) return null;
    if (anchorType === 'pdf') {
        if (!Number.isInteger(p.page) || p.page < 1) return null;
        const xy = p.x !== undefined || p.y !== undefined;
        if (xy && !(unit01(p.x) && unit01(p.y))) return null;
        return { id: typeof p.id === 'string' && p.id ? p.id : `p_${p.page}_${Math.round(timeMs)}`, page: p.page, ...(xy ? { x: p.x, y: p.y } : {}), timeMs, source: sourceOf(p) };
    }
    if (anchorType === 'text') {
        if (!Number.isInteger(p.line) || p.line < 0) return null;
        if (p.col !== undefined && (!Number.isInteger(p.col) || p.col < 0)) return null;
        return { id: typeof p.id === 'string' && p.id ? p.id : `p_${p.line}_${Math.round(timeMs)}`, line: p.line, ...(p.col !== undefined ? { col: p.col } : {}), timeMs, source: sourceOf(p) };
    }
    if (anchorType === 'unit') {
        if (!Number.isInteger(p.unit) || p.unit < 0) return null;
        return { id: typeof p.id === 'string' && p.id ? p.id : `p_${p.unit}_${Math.round(timeMs)}`, unit: p.unit, timeMs, source: sourceOf(p) };
    }
    const barIndex = p.barIndex ?? p.bar;
    if (!Number.isInteger(barIndex) || barIndex < 0) return null;
    if (!Number.isInteger(occurrence) || occurrence < 0) return null;
    if (!Number.isFinite(pos) || pos < 0 || pos > 1) return null;
    return {
        id: typeof p.id === 'string' && p.id ? p.id : `p_${barIndex}_${occurrence}_${Math.round(pos * 1000)}`,
        barIndex, occurrence, pos, timeMs,
        source: sourceOf(p)
    };
}

/** The anchor type a list of points is written for, from the fields of the first one (bar points when empty). */
export function anchorTypeOf(points) {
    const p = points?.[0];
    if (p && p.page !== undefined) return 'pdf';
    if (p && p.line !== undefined) return 'text';
    return 'bar';
}

/** Points as Music Pack sync points (SPEC section 9): the one place `barIndex` becomes `bar`. */
export function toSyncPoints(points, anchorType) {
    return (points || []).map((p) => {
        if (anchorType !== 'bar') return { ...p };
        const { barIndex, ...rest } = p;
        return { ...rest, bar: barIndex };
    });
}

/** Music Pack sync points as the app holds them (the inverse of toSyncPoints). */
export function fromSyncPoints(points, anchorType) {
    return (points || []).map((p) => {
        if (anchorType !== 'bar') return { ...p };
        const { bar, ...rest } = p;
        return { ...rest, barIndex: bar };
    });
}

/**
 * Returns a clean record, or null when `raw` is not usable. Drops malformed points and sorts by time. `raw` is a stored
 * record or one this function returned earlier. `key` is the storage key it came from, which tells a version 1 record of
 * a text or PDF tab (points that are units) from a version 1 record of bars.
 */
export function normalizeRecord(raw, key = null) {
    if (!raw || typeof raw !== 'object' || (raw.version !== 1 && raw.version !== 2)) return null;
    if (!mediaKey(raw.media) || !Array.isArray(raw.points)) return null;
    let anchorType;
    let rawPoints = raw.points;
    if (raw.version === 1) {
        if (isUnitKey(key)) { anchorType = 'unit'; rawPoints = raw.points.map((p) => ({ ...p, unit: p?.barIndex })); }
        else anchorType = 'bar';
    } else {
        anchorType = raw.anchorType;
        if (!ANCHOR_TYPES.has(anchorType) && !(anchorType === 'unit' && raw.version === 2)) return null;
    }
    const m = raw.media;
    const media = m.kind === 'youtube'
        ? {
            kind: 'youtube',
            videoId: String(m.videoId),
            ...(m.label ? { label: String(m.label) } : {}),
            ...(m.origin && typeof m.origin === 'object' ? { origin: m.origin } : {})
        }
        : {
            kind: 'local', audioId: String(m.audioId), name: String(m.name ?? ''),
            durationMs: Number.isFinite(m.durationMs) ? m.durationMs : null, fingerprint: String(m.fingerprint ?? ''),
            ...(m.origin && typeof m.origin === 'object' ? { origin: m.origin } : {})
        };
    const clean = (list) => list.map((p) => cleanPoint(p, anchorType)).filter(Boolean).sort((a, b) => a.timeMs - b.timeMs);
    const points = clean(rawPoints);
    const restorePoints = Array.isArray(raw.restore?.points) ? clean(raw.restore.points) : [];
    const restore = restorePoints.length ? { points: restorePoints, savedAt: Number.isFinite(raw.restore.savedAt) ? raw.restore.savedAt : 0 } : null;
    return { version: AUDIO_SYNC_VERSION, media, anchorType, points, updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0, ...(restore ? { restore } : {}) };
}

/** Whether two point lists put the same positions at the same times. */
export function samePoints(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    const key = (p) => [p.barIndex ?? p.bar, p.occurrence, p.pos, p.page, p.x, p.y, p.line, p.col, p.unit, p.timeMs].join('|');
    return a.every((p, i) => key(p) === key(b[i]));
}

/**
 * A record as it is stored: version 2 with Music Pack points. A record of units (read from version 1 and not yet
 * upgraded) goes back out as version 1, so a device that has not been updated still understands it.
 */
export function serializeRecord(rec) {
    if (rec.anchorType === 'unit') {
        return { version: 1, media: rec.media, points: rec.points.map(({ unit, ...p }) => ({ ...p, barIndex: unit, occurrence: 0, pos: 0 })), updatedAt: rec.updatedAt };
    }
    return {
        version: AUDIO_SYNC_VERSION, media: rec.media, anchorType: rec.anchorType, points: toSyncPoints(rec.points, rec.anchorType), updatedAt: rec.updatedAt,
        ...(rec.restore ? { restore: { points: toSyncPoints(rec.restore.points, rec.anchorType), savedAt: rec.restore.savedAt } } : {}),
    };
}

function parse(text, key = null) {
    try { return normalizeRecord(JSON.parse(text), key); } catch { return null; }
}

// Per song option: a backing track with no points of its own uses the original recording's points.
const SHARE_PREFIX = 'audio_sync_share_';
const shareKey = (songKey) => `${SHARE_PREFIX}${encodeURIComponent(String(songKey).toLowerCase())}`;

export function isSyncSharedFromOriginal(songKey, storage = recordStorage) {
    try { return storage.getItem(shareKey(songKey)) === '1'; } catch { return false; }
}

export function setSyncSharedFromOriginal(songKey, on, storage = recordStorage) {
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
    try { const text = storage.getItem(key); return text === null ? null : parse(text, key); } catch { return null; }
}

/**
 * The record for a recording. A backing track without points of its own gets the original recording's points
 * (marked `inherited`) when the song's option is on; saving after an edit stores them under the backing track.
 */
export function loadRecord(songKey, media, storage = recordStorage) {
    const stored = loadOwnRecord(songKey, media, storage);
    // A record with no points (cleared, but holding a restore point) is not a synced recording
    const own = stored?.points.length ? stored : null;
    if (own || !slotMediaResolver || !isSyncSharedFromOriginal(songKey, storage)) return own;
    let slots = null;
    try { slots = slotMediaResolver(songKey); } catch { slots = null; }
    if (!slots?.original || !slots.backing || mediaKey(slots.backing) !== mediaKey(media)) return own;
    if (mediaKey(slots.original) === mediaKey(media)) return own;
    const orig = loadOwnRecord(songKey, slots.original, storage);
    if (!orig?.points.length) return own;
    return { ...orig, media: normalizeRecord({ ...orig, media }).media, inherited: true };
}

/** The restore point of a recording, `{ points, savedAt }`, or null. */
export function loadRestorePoint(songKey, media, storage = recordStorage) {
    return loadOwnRecord(songKey, media, storage)?.restore || null;
}

/**
 * Saves `points` for a recording, stamping `updatedAt`. An empty point list removes the entry, unless it holds a
 * restore point. The record keeps the restore point it has. `restoreTo` replaces it with those points (a pack's or an
 * importer's, or the current ones the person chose to keep); `holdPrevious` (an edit in the sync editor) makes the
 * points the record had before into its restore point when it has none yet. Returns the record.
 */
export function saveRecord(songKey, media, points, storage = recordStorage, now = Date.now(), anchorType = anchorTypeOf(points), { restoreTo = null, holdPrevious = false } = {}) {
    const key = storageKey(songKey, media);
    if (!key) return null;
    const record = normalizeRecord({ version: AUDIO_SYNC_VERSION, media, anchorType, points, updatedAt: now });
    if (!record) return null;
    const before = loadOwnRecord(songKey, media, storage);
    let restore = before?.restore || null;
    if (restoreTo) {
        const kept = normalizeRecord({ version: AUDIO_SYNC_VERSION, media, anchorType, points: restoreTo, updatedAt: now })?.points || [];
        if (kept.length) restore = { points: kept, savedAt: now };
    } else if (holdPrevious && !restore && before?.points.length && !samePoints(before.points, record.points)) {
        restore = { points: before.points, savedAt: before.updatedAt };
    }
    if (restore) record.restore = restore;
    try {
        if (!record.points.length && !restore) storage.removeItem(key);
        else storage.setItem(key, JSON.stringify(serializeRecord(record)));
        if (storage === recordStorage) {
            globalThis.window?.dispatchEvent?.(new CustomEvent('majestictab:data-changed'));
        }
    } catch (e) {
        console.warn('[Audio Sync] Could not save sync points:', e);
        return null;
    }
    return record;
}

export function deleteRecord(songKey, media, storage = recordStorage) {
    const key = storageKey(songKey, media);
    if (key) {
        try {
            storage.removeItem(key);
            if (storage === recordStorage) {
                globalThis.window?.dispatchEvent?.(new CustomEvent('majestictab:data-changed'));
            }
        } catch { /* ignore */ }
    }
}

/** Every stored record of a song, newest first. */
export function listRecords(songKey, storage = recordStorage) {
    const prefix = `${AUDIO_SYNC_PREFIX}${encodeURIComponent(String(songKey).toLowerCase())}_`;
    const out = [];
    for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(prefix)) {
            const rec = parse(storage.getItem(k), k);
            if (rec?.points.length) out.push(rec);
        }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Every stored `pdf` record for `songKey` and `media` (under `score:<sha256>:<songKey>` or `text:<songKey>`), newest first. */
export function listPdfRecordsForMedia(songKey, media, storage = recordStorage) {
    const m = mediaKey(media);
    if (!songKey || !m) return [];
    const encodedSong = encodeURIComponent(String(songKey).toLowerCase());
    const scorePrefix = `${AUDIO_SYNC_PREFIX}${encodeURIComponent('score:')}`;
    const scoreSuffix = `${encodeURIComponent(':')}${encodedSong}_${m}`;
    const legacyKey = storageKey(`text:${songKey}`, media);
    const out = [];
    for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k) continue;
        const matchesScore = k.startsWith(scorePrefix) && k.endsWith(scoreSuffix);
        const matchesLegacy = legacyKey && k === legacyKey;
        if (!matchesScore && !matchesLegacy) continue;
        const rec = parse(storage.getItem(k), k);
        if (rec?.anchorType === 'pdf' && rec.points.length) out.push(rec);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** True when any recording of the song has at least one sync point. */
export function songHasSyncPoints(songKey, storage = recordStorage) {
    try { return listRecords(songKey, storage).some(r => r.points.length > 0); } catch { return false; }
}

// --- Backup and cloud sync plumbing ------------------------------------------------------------------------------

/** All entries as `{ storageKey: record }` for a backup or snapshot. Empty when there are none. */
export function collectAudioSync(storage = recordStorage) {
    const out = {};
    for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k || !k.startsWith(AUDIO_SYNC_PREFIX)) continue;
        if (k.startsWith(SHARE_PREFIX)) {
            if (storage.getItem(k) === '1') out[k] = { shared: true };
            continue;
        }
        const rec = parse(storage.getItem(k), k);
        if (rec) out[k] = serializeRecord(rec);
    }
    return out;
}

/**
 * Applies a collected map. With `wipe` the incoming entries replace everything; otherwise an incoming record only
 * replaces a local one when it is newer, so editing on two devices keeps the latest edit. Returns the number written.
 */
export function mergeAudioSync(incoming, { wipe = false } = {}, storage = recordStorage) {
    let written = 0;
    for (const [key, raw] of Object.entries(incoming || {})) {
        if (!key.startsWith(AUDIO_SYNC_PREFIX)) continue;
        if (key.startsWith(SHARE_PREFIX)) {
            // The per song "backing track uses the original's points" option has no timestamp, so it only turns on
            if (raw?.shared === true && storage.getItem(key) !== '1') {
                try { storage.setItem(key, '1'); written++; } catch { /* quota: skip */ }
            }
            continue;
        }
        const rec = normalizeRecord(raw, key);
        if (!rec || !rec.points.length) continue;
        const local = wipe ? null : parse(storage.getItem(key), key);
        if (local && local.updatedAt >= rec.updatedAt) continue;
        try { storage.setItem(key, JSON.stringify(serializeRecord(rec))); written++; } catch { /* quota: skip */ }
    }
    return written;
}

/** Removes every entry (for a wipe or reset). */
export function clearAudioSync(storage = recordStorage) {
    const keys = [];
    for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(AUDIO_SYNC_PREFIX)) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
}
