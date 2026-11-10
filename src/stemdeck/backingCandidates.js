// stemdeck/backingCandidates.js
// Which songs can get a backing track made from a local audio file, and where the result goes. No DOM and no
// database here (unit tested in Node, tests/stemdeck.test.mjs): the callers pass the stored files' metadata and a
// storage object. A song is known by its key ("Artist - Title"), the same key the Sound panel files its audio under.

const enc = (songKey) => encodeURIComponent(String(songKey).toLowerCase());
export const slotFileKey = (songKey, slot) => `audio_file_${enc(songKey)}_${slot}`;
const lastFileKey = (songKey) => `audio_file_last_${enc(songKey)}`;
export const slotSourceKey = (songKey, slot) => `real_audio_source_${enc(songKey)}_${slot}`;

const read = (storage, key) => { try { return storage.getItem(key); } catch { return null; } };

/**
 * One entry per song that has a local recording to send.
 * `source` is the song's Original file (the one chosen in the Sound panel, else the newest file that is neither the
 * backing track nor something the app generated). `backingId` is the local file in its Backing slot, if any.
 * @param {object[]} files metadata from listAudioFiles() (newest first)
 * @returns {{ songKey: string, source: object, backingId: string|null }[]} sorted by song
 */
export function listBackingCandidates(files, storage) {
    const bySong = new Map();
    for (const f of files) {
        for (const key of f.songKeys || []) {
            if (!bySong.has(key)) bySong.set(key, []);
            bySong.get(key).push(f);
        }
    }
    const out = [];
    for (const [songKey, own] of bySong) {
        const byId = new Map(own.map((f) => [f.id, f]));
        const backingId = byId.has(read(storage, slotFileKey(songKey, 'backing'))) ? read(storage, slotFileKey(songKey, 'backing')) : null;
        const usable = (id) => (id && id !== backingId && byId.has(id) ? byId.get(id) : null);
        const source = usable(read(storage, slotFileKey(songKey, 'original')))
            || usable(read(storage, lastFileKey(songKey)))
            || own.find((f) => f.id !== backingId && !f.generatedFrom)
            || null;
        if (source) out.push({ songKey, source, backingId });
    }
    return out.sort((a, b) => a.songKey.localeCompare(b.songKey, undefined, { sensitivity: 'base' }));
}

/**
 * The songs to send: those chosen, and among them the ones that already have a backing track only when asked.
 * Songs that share one audio file are sent once, so the result is grouped by file.
 * @returns {{ source: object, songs: { songKey: string, backingId: string|null }[] }[]}
 */
export function planJobs(candidates, selected, includeExisting) {
    const jobs = new Map();
    for (const c of candidates) {
        if (!selected.has(c.songKey)) continue;
        if (c.backingId && !includeExisting) continue;
        if (!jobs.has(c.source.id)) jobs.set(c.source.id, { source: c.source, songs: [] });
        jobs.get(c.source.id).songs.push({ songKey: c.songKey, backingId: c.backingId });
    }
    return [...jobs.values()];
}

/** "Song.mp3" becomes "Song (no guitar).mp3". */
export function backingFileName(sourceName, ext) {
    const base = String(sourceName || 'Audio').replace(/\.[a-z0-9]{1,5}$/i, '');
    return `${base} (no guitar).${ext}`;
}
