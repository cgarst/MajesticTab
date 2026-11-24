// storageUsageCore.js
// Pure helpers for the storage diagram at the top of Settings, Data management: what takes space on this device and in
// cloud storage, in five kinds (cloud storage never holds the cache). No imports, so it can be tested on its own.

/** The kinds, in the order the bar draws them. */
export const USAGE_KINDS = [
    { id: 'tabs', label: 'Tabs' },
    { id: 'audio', label: 'Audio' },
    { id: 'fonts', label: 'Sound fonts' },
    { id: 'classtab', label: 'Classical tab' },
    { id: 'cache', label: 'Cache' },
];

export const emptyUsage = () => ({ tabs: 0, audio: 0, fonts: 0, classtab: 0, cache: 0 });

/**
 * Sorts a store listing into kinds by path. Entries are `{ path, size }` under `packs/<id>/` (audio files sit in an
 * `audio/` folder, everything else there is the song's tabs and records), `soundfonts/` and `classtab/`.
 */
export function cloudUsageFromEntries(entries) {
    const out = emptyUsage();
    for (const e of entries || []) {
        const size = Number(e?.size) || 0;
        const path = String(e?.path || '');
        if (!size) continue;
        if (path.startsWith('soundfonts/')) out.fonts += size;
        else if (path.startsWith('classtab/')) out.classtab += size;
        else if (/^packs\/[^/]+\/audio\//.test(path)) out.audio += size;
        else if (path.startsWith('packs/')) out.tabs += size;
    }
    return out;
}

/** Bytes of one listing, summed by `size` (a stored file, an audio file, a sound font). */
export const sumSizes = (items) => (items || []).reduce((n, i) => n + (Number(i?.size) || 0), 0);

export const totalOf = (usage) => USAGE_KINDS.reduce((n, k) => n + (usage?.[k.id] || 0), 0);

/**
 * Bar segments for a usage: each kind's share of the bar, as a percent of `scale` (the larger of the two totals, so the
 * device bar and the cloud bar are drawn to the same length). Kinds with no bytes are left out.
 */
export function barSegments(usage, scale) {
    if (!scale) return [];
    return USAGE_KINDS
        .map((k, index) => ({ id: k.id, label: k.label, index, bytes: usage?.[k.id] || 0 }))
        .filter((s) => s.bytes > 0)
        .map((s) => ({ ...s, percent: Math.max(0.5, (s.bytes / scale) * 100) }));
}

/**
 * Which audio files belong together as a set of stems. `metas` are `{ song, map }`: a song's key (as the recording meta is
 * stored under it) and its raw meta map (`{ mediaKey: meta }`). A lead's `stems` list names its parts; a part that names the
 * mix it was split from (`stemOf`) joins the other parts of that mix. Returns a Map from audio id to `{ group, song }`.
 * Files in no set are left out.
 */
export function stemGroupsFromMeta(metas) {
    const out = new Map();
    for (const { song, map } of metas || []) {
        for (const [key, meta] of Object.entries(map || {})) {
            if (Array.isArray(meta?.stems) && meta.stems.length > 1) {
                for (const s of meta.stems) if (s?.audioId) out.set(String(s.audioId), { group: `set:${key}`, song });
            } else if (meta?.stemOf && key.startsWith('local_')) {
                out.set(key.slice('local_'.length), { group: `of:${meta.stemOf}`, song });
            }
        }
    }
    return out;
}

/** The song names an audio file is kept for ("Artist - Title" keys): the first two, then a count. */
const ownerOfKeys = (keys) => {
    const names = [...new Set((keys || []).map(String).filter(Boolean))];
    return names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(', ');
};

/**
 * Every stored file as one row, biggest first. `lists` holds `{ id, name, size, songKeys? }` items by kind; the audio files of
 * one stem set (see `stemGroupsFromMeta`) are one row with the sum of their sizes, named for the song. A row carries the
 * `ids` it stands for and, for audio, the lowercased `songs` that list it. The cache is not a file and is left out.
 */
export function largestRows(lists, stemGroups = new Map()) {
    const rows = [];
    const groups = new Map();
    for (const k of ['tabs', 'audio', 'fonts', 'classtab']) {
        const kindIndex = USAGE_KINDS.findIndex((u) => u.id === k);
        for (const item of lists?.[k] || []) {
            const size = Number(item?.size) || 0;
            if (!size) continue;
            const songKeys = Array.isArray(item.songKeys) ? item.songKeys : [];
            const info = k === 'audio' ? stemGroups.get(String(item.id)) : null;
            if (!info) {
                rows.push({ kind: k, index: kindIndex, name: item.name || 'Untitled', bytes: size, count: 1, ids: [item.id], songs: [...new Set(songKeys.map((x) => String(x).toLowerCase()))], owner: item.owner || ownerOfKeys(songKeys) });
                continue;
            }
            let row = groups.get(info.group);
            if (!row) {
                row = { kind: k, index: kindIndex, name: '', bytes: 0, count: 0, ids: [], songs: [], stems: true, label: info.song || '' };
                groups.set(info.group, row);
                rows.push(row);
            }
            row.bytes += size;
            row.count += 1;
            row.ids.push(item.id);
            if (!row.owner) row.owner = ownerOfKeys(songKeys);
            if (info.song && !row.songs.includes(info.song)) row.songs.push(info.song);
            for (const x of songKeys) { const l = String(x).toLowerCase(); if (!row.songs.includes(l)) row.songs.push(l); }
            if (!row.label && songKeys[0]) row.label = songKeys[0];
            if (!row.fallback) row.fallback = item.name || '';
            row.cased ||= songKeys[0] || '';
        }
    }
    for (const r of rows) {
        if (!r.stems) continue;
        const song = r.cased || r.label || String(r.fallback || 'Untitled').replace(/\.[A-Za-z0-9]{2,4}$/, '');
        r.name = r.count > 1 ? `${song} (${r.count} stems)` : song;
        delete r.label; delete r.fallback; delete r.cased;
    }
    return rows.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}
