// packContribution.js
// What a .mpak would add to a song the library already has: scores, stems, other audio and sync data, each counted only when the
// song does not have it yet. Bulk import shows it on the row and skips a pack that adds nothing. Pure: the caller passes in what
// the library holds and how to compare, so the rules run without a browser.

const lower = (v) => String(v || '').toLowerCase();

const fileSources = (rec) => (Array.isArray(rec?.sources) ? rec.sources : []).filter((s) => s?.type === 'file' && s.path);

/**
 * @param manifest   the pack's manifest (scores, recordings with sources and sync maps)
 * @param song       the library song the pack goes to, or null when it has none yet (everything is new)
 * @param isSameFile async (source, recording) -> stored audio id when the song already has that file, else null
 * @param hasSync    (recording, media) -> true when the song already has sync points for that recording's media;
 *                   `media` is { kind: 'local', audioId } or { kind: 'youtube', videoId }
 * @returns {{ scores: number, stems: number, audio: number, sync: number, total: number }}
 */
export async function packAdds({ manifest, song, isSameFile, hasSync }) {
    const out = { scores: 0, stems: 0, audio: 0, sync: 0, total: 0 };
    const tabs = Array.isArray(song?.tabOptions) ? song.tabOptions : [];
    for (const sc of manifest?.scores || []) {
        const have = tabs.some((t) => (sc.sha256 && t.sha256 ? t.sha256 === sc.sha256 : !t.sha256 && sc.name && lower(t.name) === lower(sc.name)));
        if (!have) out.scores++;
    }
    for (const rec of manifest?.recordings || []) {
        const sources = fileSources(rec);
        let media = null;
        let isNew = false;
        if (sources.length) {
            const same = song ? await isSameFile(sources[0], rec) : null;
            if (same) media = { kind: 'local', audioId: same };
            else isNew = true;
            if (isNew) out[rec.role === 'stem' ? 'stems' : 'audio']++;
        } else {
            const yt = (rec?.sources || []).find((s) => s?.type === 'youtube' && s.videoId);
            if (yt) media = { kind: 'youtube', videoId: yt.videoId };
        }
        if (Object.keys(rec?.sync || {}).length && (isNew || (media && !hasSync(rec, media)))) out.sync++;
    }
    out.total = out.scores + out.stems + out.audio + out.sync;
    return out;
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "Adds 7 stems and sync data", or "Nothing new" when it adds nothing. */
export function describeAdds(adds) {
    if (!adds || !adds.total) return 'Nothing new';
    const parts = [];
    if (adds.scores) parts.push(count(adds.scores, 'score', 'scores'));
    if (adds.stems) parts.push(count(adds.stems, 'stem', 'stems'));
    if (adds.audio) parts.push(count(adds.audio, 'audio file', 'audio files'));
    if (adds.sync) parts.push('sync data');
    const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    return `Adds ${text}`;
}
