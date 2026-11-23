// The stem layer of a recording (SPEC section 8): the parts a mix was split into, kept in its `stems` array.
//
// Inside MajesticTab a pack's stems are read as the form older packs have, a recording of their own with `role: 'stem'` and
// `stemOf` (the mix), because the player, the set logic and the stored metadata are built on it. `flattenStemLayer` turns a
// manifest into that form when it is read, and `nestStemLayer` turns it back when a pack is written. A pack that already has
// `stemOf` (written before the stem layer) is read as it is, and is written in the new form.
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

/** The stems nested in a recording. */
export const stemsOf = (rec) => (Array.isArray(rec?.stems) ? rec.stems.filter(isObj) : []);

/** The sources of a recording and of the stems it holds: every file the recording needs. */
export const recordingSources = (rec) => [...(Array.isArray(rec?.sources) ? rec.sources : []), ...stemsOf(rec).flatMap((s) => (Array.isArray(s.sources) ? s.sources : []))];

/** A copy of the manifest's recordings with each nested stem as a recording of its own, after the mix that holds it. */
export function flattenStemLayer(recordings) {
    if (!Array.isArray(recordings)) return recordings;
    const out = [];
    for (const rec of recordings) {
        const stems = stemsOf(rec);
        if (!isObj(rec) || !stems.length) { out.push(rec); continue; }
        const { stems: _drop, ...mix } = rec;
        out.push(mix);
        for (const st of stems) out.push({ ...st, role: 'stem', stemOf: rec.id, sources: st.sources || [] });
    }
    return out;
}

/**
 * The reverse, for writing: a stem recording that names a mix present in the list, and has no sync, beat file or offset of its own
 * (so it uses the mix's), moves into that mix's `stems`. Any other stem stays a recording of its own, without `stemOf`.
 */
export function nestStemLayer(recordings) {
    const byId = new Map(recordings.map((r) => [r.id, r]));
    const nests = (r) => r.role === 'stem' && r.stemOf && byId.has(r.stemOf) && byId.get(r.stemOf).role !== 'stem'
        && !(r.sync && Object.keys(r.sync).length) && !r.beats && !r.syncFrom && !r.syncOffsetMs && !r.scoreTracks && !r.without;
    const layers = new Map();
    for (const r of recordings) {
        if (!nests(r)) continue;
        const { role: _role, stemOf, id, label, stem, sources } = r;
        (layers.get(stemOf) || layers.set(stemOf, []).get(stemOf)).push({ id, ...(label ? { label } : {}), ...(stem ? { stem } : {}), sources: sources || [] });
    }
    return recordings.filter((r) => !nests(r)).map((r) => {
        const { stemOf: _s, ...rest } = r;
        const stems = layers.get(r.id);
        if (stems) return { ...rest, stems };
        const { stemsComplete: _c, ...plain } = rest; // `stemsComplete` is for a recording that has stems
        return plain;
    });
}
