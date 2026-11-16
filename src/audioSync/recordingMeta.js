// audioSync/recordingMeta.js
// What a pack says about a recording of a song, kept by the app for the Original panel's list: its role (SPEC section 7:
// original, alternate, backing, stem, solo, live ...), its label, its place in the pack's `recordings`, which tracks of the
// score its audio lacks or is alone (`scoreTracks`), and the recording a stem was split from (`stemOf`).
//
// App-internal only: nothing here is written into an exported pack. One localStorage entry per song, a map from the
// recording's media key (syncStore.mediaKey: `yt_<videoId>` or `local_<audioId>`) to its meta. Backed up with the video
// choices (the key starts with `rec_meta_`).
//
// Entry: { role, label?, packIndex?, stemOf?, tracks?: { mode: 'omits' | 'only', names: string[] } }
// `stemOf` is the media key of the recording the stem belongs to. `tracks` holds the track names the pack wrote in
// `scoreTracks[...].names`; a pack that wrote only indexes gives no `tracks`, since the names cannot be known without the score.

import { mediaKey } from './syncStore.js';

export const REC_META_PREFIX = 'rec_meta_';
export const isRecordingMetaKey = (key) => typeof key === 'string' && key.startsWith(REC_META_PREFIX);

const key = (songKey) => `${REC_META_PREFIX}${encodeURIComponent(String(songKey).toLowerCase())}`;
const MAX_NAMES = 12;

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** One entry as stored, or null when it says nothing the list can use. */
function cleanMeta(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const role = str(raw.role, 40);
    if (!role) return null;
    const out = { role };
    const label = str(raw.label, 200);
    if (label) out.label = label;
    if (Number.isInteger(raw.packIndex) && raw.packIndex >= 0) out.packIndex = raw.packIndex;
    const stemOf = str(raw.stemOf, 200);
    if (stemOf) out.stemOf = stemOf;
    const t = raw.tracks;
    if (t && (t.mode === 'omits' || t.mode === 'only') && Array.isArray(t.names)) {
        const names = t.names.map((n) => str(n, 80)).filter(Boolean).slice(0, MAX_NAMES);
        if (names.length) out.tracks = { mode: t.mode, names };
    }
    return out;
}

/** Every recording's meta for a song: { mediaKey: meta }. */
export function listRecordingMeta(songKey, storage = localStorage) {
    if (!songKey) return {};
    try {
        const raw = JSON.parse(storage.getItem(key(songKey)) || '{}');
        const out = {};
        if (raw && typeof raw === 'object') {
            for (const [k, v] of Object.entries(raw)) {
                const meta = cleanMeta(v);
                if (meta) out[k] = meta;
            }
        }
        return out;
    } catch { return {}; }
}

export function getRecordingMeta(songKey, media, storage = localStorage) {
    const k = mediaKey(media);
    return k ? listRecordingMeta(songKey, storage)[k] || null : null;
}

/** Keeps what a pack said about a recording. A pack imported again replaces the entry. */
export function setRecordingMeta(songKey, media, meta, storage = localStorage) {
    const k = mediaKey(media);
    const clean = cleanMeta(meta);
    if (!songKey || !k || !clean) return;
    const all = listRecordingMeta(songKey, storage);
    all[k] = clean;
    try { storage.setItem(key(songKey), JSON.stringify(all)); } catch { /* optional */ }
}

export function forgetRecordingMeta(songKey, media, storage = localStorage) {
    const k = mediaKey(media);
    if (!songKey || !k) return;
    const all = listRecordingMeta(songKey, storage);
    if (!(k in all)) return;
    delete all[k];
    try {
        if (Object.keys(all).length) storage.setItem(key(songKey), JSON.stringify(all)); else storage.removeItem(key(songKey));
    } catch { /* optional */ }
}

/**
 * What a pack recording becomes here (`rec` is a manifest recording, `index` its place in `recordings`).
 * `keyOfId(id)` gives the media key of another recording of the pack, for a stem's parent. It also says which score the
 * `scoreTracks` entry to read belongs to (`primaryScoreId`): the primary score's, else the first entry.
 */
export function metaOfPackRecording(rec, index, keyOfId = () => null, primaryScoreId = null) {
    if (!rec || typeof rec !== 'object') return null;
    const meta = { role: rec.role, label: rec.label, packIndex: index };
    if (rec.role === 'stem' && typeof rec.stemOf === 'string') {
        const parent = keyOfId(rec.stemOf);
        if (parent) meta.stemOf = parent;
    }
    const st = rec.scoreTracks && typeof rec.scoreTracks === 'object' ? rec.scoreTracks : null;
    if (st) {
        const entry = (primaryScoreId && st[primaryScoreId]) || st[Object.keys(st)[0]];
        const mode = Array.isArray(entry?.omits) ? 'omits' : Array.isArray(entry?.only) ? 'only' : null;
        // The names are the pack's own words for the tracks, and the only ones to show: an index alone is not a name
        if (mode && Array.isArray(entry.names) && entry.names.length === entry[mode].length) meta.tracks = { mode, names: entry.names };
    }
    return cleanMeta(meta);
}

// Roles in list order. The rest of the known and unknown roles (live, cover, solo, lesson, click ...) sit between the
// alternates and the backing tracks; a recording the pack never described comes last.
const ROLE_RANK = { original: 0, alternate: 1, backing: 3, stem: 4 };
const OTHER_RANK = 2;
const UNDESCRIBED_RANK = 5;

export const roleRank = (meta) => (meta ? (ROLE_RANK[meta.role] ?? OTHER_RANK) : UNDESCRIBED_RANK);

/** The role as a person reads it ("Alternate", "Live"), or '' for the roles the slot already says (original, backing). */
export function roleLabel(meta) {
    const role = meta?.role;
    if (!role || role === 'original' || role === 'backing') return '';
    return role.charAt(0).toUpperCase() + role.slice(1);
}

/** "Without Drums" / "Only Drums" from a recording's tracks, or ''. */
export function tracksNote(meta) {
    const t = meta?.tracks;
    if (!t?.names?.length) return '';
    return `${t.mode === 'omits' ? 'Without' : 'Only'} ${t.names.join(', ')}`;
}

/**
 * Puts a list of recordings in the order the panel shows: original first, then alternates, then the other roles, then
 * backing tracks, then recordings the pack did not describe. Inside a role they keep the pack's order (the first
 * recording of a pack is its default, SPEC section 7), and `tie(a, b)` settles the rest (newest first for videos).
 * A stem follows the recording it was split from, indented one step.
 *
 * `items` are whatever the caller lists, `keyOf(item)` their media key, `metas` the map from `listRecordingMeta`.
 * Returns `[{ item, meta, nested }]`.
 */
export function orderRecordings(items, keyOf, metas, tie = () => 0) {
    const entries = items.map((item, i) => ({ item, i, k: keyOf(item), meta: metas[keyOf(item)] || null }));
    const byKey = new Map(entries.map((e) => [e.k, e]));
    // A stem nests under a recording that is listed and is not itself a stem of another (so a loop cannot hide both)
    const isChild = (e) => e.meta?.role === 'stem' && e.meta.stemOf && e.meta.stemOf !== e.k
        && byKey.has(e.meta.stemOf) && !byKey.get(e.meta.stemOf).meta?.stemOf;
    const pack = (e) => e.meta?.packIndex ?? Number.MAX_SAFE_INTEGER;
    const cmp = (a, b) => (roleRank(a.meta) - roleRank(b.meta)) || (pack(a) - pack(b)) || tie(a.item, b.item) || (a.i - b.i);
    const childrenOf = new Map();
    for (const e of entries) if (isChild(e)) (childrenOf.get(e.meta.stemOf) || childrenOf.set(e.meta.stemOf, []).get(e.meta.stemOf)).push(e);
    const out = [];
    for (const e of entries.filter((x) => !isChild(x)).sort(cmp)) {
        out.push({ item: e.item, meta: e.meta, nested: false });
        for (const c of (childrenOf.get(e.k) || []).sort(cmp)) out.push({ item: c.item, meta: c.meta, nested: true });
    }
    return out;
}
