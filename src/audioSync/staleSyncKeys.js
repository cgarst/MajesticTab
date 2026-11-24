// staleSyncKeys.js
// Sync points are stored under the song key a tab was opened under, and removing a tab never removed them. This finds the keys
// no tab of a song uses any more and drops the sync points stored under them. A key is stale only when every name it was
// remembered with (the tab's name and its file name) matches none of the song's remaining tabs, and it is neither one of the
// song's own names (shared by all its tabs) nor remembered by another song. When in doubt a key is kept.

import { listRecords, deleteRecord } from './syncStore.js';
import { keysOfOtherSongs, libraryAudioKey } from './libraryAudio.js';
import { songTagKeys } from '../songLibraryTags.js';

const lc = (s) => String(s ?? '').trim().toLowerCase();
const stem = (s) => s.replace(/\.[a-z0-9]{2,4}$/i, '');
const base = (p) => String(p || '').split(/[\\/]/).pop();
const SONG_KEYS = (songId) => `yt_song_keys_${songId}`;

/** The lowercase names a tab goes by: its name, file name and path, each with and without an extension. */
export function namesOfTab(tab) {
    const out = new Set();
    for (const n of [tab?.name, tab?.fileName, tab?.relativePath, base(tab?.relativePath)].map(lc).filter(Boolean)) { out.add(n); out.add(stem(n)); }
    return out;
}

/**
 * Keys no remaining tab uses, from the song's remembered keys (`[{ key, tabName?, filename? }]`). A key with neither a tab name nor
 * a file name is a name of the song itself and is never stale. With `removed` (tabs just taken away) only keys remembered for
 * those tabs are returned. `protect` is a set of lowercase keys to keep.
 */
export function staleTabKeys({ entries, tabs, removed = null, protect = new Set() }) {
    const live = new Set((tabs || []).flatMap((t) => [...namesOfTab(t)]));
    const gone = removed ? new Set(removed.flatMap((t) => [...namesOfTab(t)])) : null;
    const byKey = new Map();
    for (const e of entries || []) {
        const o = typeof e === 'string' ? { key: e } : e;
        if (!o?.key) continue;
        const k = lc(o.key);
        const slot = byKey.get(k) || { key: o.key, names: [], plain: false };
        const names = [o.tabName, o.filename].map(lc).filter(Boolean);
        if (!names.length) slot.plain = true;
        slot.names.push(...names);
        byKey.set(k, slot);
    }
    const out = [];
    for (const [k, v] of byKey) {
        if (v.plain || !v.names.length || protect.has(k)) continue;
        const named = v.names.flatMap((n) => [n, stem(n)]);
        if (named.some((n) => live.has(n)) || live.has(k) || live.has(stem(k))) continue;
        if (gone && !named.some((n) => gone.has(n))) continue;
        out.push({ key: v.key, tabName: v.names[0] });
    }
    return out;
}

function entriesOf(songId) {
    try { const l = JSON.parse(localStorage.getItem(SONG_KEYS(songId)) || '[]'); return Array.isArray(l) ? l : []; } catch { return []; }
}

const protectedKeys = (song) => new Set([...songTagKeys(song), libraryAudioKey(song), ...keysOfOtherSongs(song.id)].filter(Boolean).map(lc));

/** Stale keys of one song that still have sync points: `[{ key, tabName, records, points, updatedAt }]`. */
export function staleSyncOfSong(song, { removed = null } = {}) {
    const stale = staleTabKeys({ entries: entriesOf(song.id), tabs: song.tabOptions || [], removed, protect: protectedKeys(song) });
    const out = [];
    for (const s of stale) {
        const recs = listRecords(s.key);
        if (!recs.length) continue;
        out.push({ ...s, records: recs.length, points: recs.reduce((n, r) => n + r.points.length, 0), updatedAt: Math.max(...recs.map((r) => r.updatedAt || 0)) });
    }
    return out;
}

/** Deletes the sync points stored under the given keys. Returns how many records went. */
export function dropSyncUnderKeys(keys) {
    let n = 0;
    for (const k of keys) for (const rec of listRecords(k)) { deleteRecord(k, rec.media); n++; }
    return n;
}

/** Tabs were just removed from `song` (which keeps others): drop the sync points of the keys only they used. */
export function dropSyncOfRemovedTabs(song, removed) {
    if (!removed?.length || !(song.tabOptions || []).length) return 0;
    return dropSyncUnderKeys(staleSyncOfSong(song, { removed }).map((s) => s.key));
}
