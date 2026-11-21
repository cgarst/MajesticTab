// audioSync/stemRepair.js
// What Settings > Library > Upkeep > Stems listed as audio can fix. Pure: the caller reads each song's recording meta
// (recordingMeta.js) and passes it in; the task writes the result back.
//
// A set of stems is kept on its lead's meta (`stems`: the parts' audio ids, labels and instruments), and each other part
// has a meta of its own with `role: 'stem'` and `stemOf` (the lead's media key). A part that was first saved as a plain
// recording (an alternate, a backing track, no role at all) and was added to a set later can keep that old entry, so the
// Original panel lists it as a recording of its own beside the set it belongs to. The fix is the entry add stems writes.

const keyOfAudioId = (audioId) => `local_${audioId}`;

/**
 * Parts of a stem set whose own meta does not say they are stems.
 * `metas` is `{ mediaKey: meta }` for one song. Returns `[{ key, leadKey, meta }]`, `meta` being what the entry should become
 * (`role`, `stemOf`, `label`, `instrument`). A part that two sets claim is left alone, and so is a part with no meta at all
 * (nothing lists it as audio). The lead itself is never changed.
 */
export function planStemRepair(metas) {
    const claims = new Map(); // part key -> lead keys that list it
    for (const [leadKey, meta] of Object.entries(metas || {})) {
        if (!Array.isArray(meta?.stems)) continue;
        for (const s of meta.stems) {
            const key = keyOfAudioId(s.audioId);
            if (key === leadKey) continue;
            if (!claims.has(key)) claims.set(key, []);
            claims.get(key).push({ leadKey, stem: s });
        }
    }
    const fixes = [];
    for (const [key, list] of claims) {
        const own = metas[key];
        if (!own || list.length !== 1) continue;
        const { leadKey, stem } = list[0];
        if (own.role === 'stem' && own.stemOf === leadKey) continue;
        // Keep the part's own name; the set's label and instrument fill in what it has not got
        const meta = { role: 'stem', stemOf: leadKey, label: own.label || stem.label || 'Stem' };
        const instrument = own.instrument || stem.instrument;
        if (instrument) meta.instrument = instrument;
        fixes.push({ key, leadKey, meta, was: own.role || null });
    }
    return fixes;
}
