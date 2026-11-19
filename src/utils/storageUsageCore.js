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
