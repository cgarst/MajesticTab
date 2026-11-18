// audioSync/syncShrink.js
// What Settings > Library > Upkeep > Map records can shrink in the stored sync points. Pure: the caller reads the stored
// records and passes them in, and says how to find a stem's parent; the task writes the store.
//
// Two kinds of record are reducible, both made by earlier versions and both loss free:
//   - a restore copy: the record's restore point holds the same points the record has (a pack's, never edited). It becomes
//     the marker syncStore.js writes today (`restore: { same: true, savedAt }`), which reads back as the same points.
//   - a stem's copy: a stem of a pack's stem set whose points are exactly its parent's, under the same score key. The player
//     gives such a stem its parent's points (syncStore.js, setStemParentResolver), so the record can go.
// A record the person edited (points differ from the restore point or from the parent's) is never touched.
//
// The scan keeps a hash of each record's points, not the points, so a library of thousands of records is not held in memory.
// Before it changes a record the task checks the points themselves with `shrunkRestore` and `stemIsCopy`.

export const mediaKeyOf = (m) => (m?.kind === 'youtube' && m.videoId ? `yt_${m.videoId}` : m?.kind === 'local' && m.audioId ? `local_${m.audioId}` : null);
const samePoints = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
const usable = (raw) => Boolean(raw && raw.version === 2 && Array.isArray(raw.points) && raw.points.length && mediaKeyOf(raw.media));

// cyrb53: 53 bits of a string, with its length, is plenty to group equal lists; nothing is changed on a hash alone
function hashOf(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${str.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/** The storage key of the record `parentMediaKey` has next to the record stored under `key` for `media`, or null. */
export function siblingKey(key, media, parentMediaKey) {
    const mk = mediaKeyOf(media);
    if (!mk || !parentMediaKey || !key.endsWith(`_${mk}`)) return null;
    return `${key.slice(0, key.length - mk.length)}${parentMediaKey}`;
}

/** What the scan keeps of one stored record (its JSON text), or null when it is not a version 2 record with points. */
export function entryOf(key, text) {
    let raw;
    try { raw = JSON.parse(text); } catch { return null; }
    if (!usable(raw)) return null;
    const restore = raw.restore;
    const restoreText = Array.isArray(restore?.points) && restore.same !== true ? JSON.stringify(restore.points) : null;
    return {
        key, size: text.length, media: raw.media, anchorType: raw.anchorType, sig: hashOf(JSON.stringify(raw.points)),
        restore: !restore ? null : restore.same === true ? { same: true } : restoreText ? { sig: hashOf(restoreText), size: restoreText.length } : null,
    };
}

/** The record to write for a restore copy (its restore point equal to its points), or null when it is not one. */
export function shrunkRestore(raw) {
    if (!usable(raw) || !raw.restore || raw.restore.same || !samePoints(raw.restore.points, raw.points)) return null;
    return { ...raw, restore: { same: true, savedAt: raw.restore.savedAt } };
}

/** Whether `raw` is a stem's copy of `parentRaw`: the same points for the same kind of score, and no restore point of its own to keep. */
export function stemIsCopy(raw, parentRaw) {
    if (!usable(raw) || !usable(parentRaw) || raw.anchorType !== parentRaw.anchorType || !samePoints(raw.points, parentRaw.points)) return false;
    return !raw.restore || raw.restore.same === true || samePoints(raw.restore.points, raw.points);
}

/**
 * @param entries       what `entryOf` made, one per stored record
 * @param stemParentOf  (entry) => the media key of the recording this one is a stem of, or null
 * @returns {{ restore: {key, bytes}[], stems: {key, bytes, parentKey}[], restoreBytes: number, stemBytes: number }}
 *          `bytes` is what removing the copy saves
 */
export function planShrink(entries, { stemParentOf = () => null } = {}) {
    const byKey = new Map(entries.map((e) => [e.key, e]));
    const stems = [];
    const removed = new Set();
    for (const e of entries) {
        if (e.media.kind !== 'local') continue;
        const parentMk = stemParentOf(e);
        if (!parentMk) continue;
        const parentKey = siblingKey(e.key, e.media, parentMk);
        const parent = parentKey && byKey.get(parentKey);
        if (!parent || parent.anchorType !== e.anchorType || parent.sig !== e.sig) continue;
        if (stemParentOf(parent)) continue; // a parent that is itself a stem is left alone
        if (e.restore && !e.restore.same && e.restore.sig !== e.sig) continue; // the person's own restore point stays
        stems.push({ key: e.key, bytes: e.size, parentKey });
        removed.add(e.key);
    }
    const restore = [];
    for (const e of entries) {
        if (removed.has(e.key) || !e.restore || e.restore.same || e.restore.sig !== e.sig) continue;
        restore.push({ key: e.key, bytes: e.restore.size }); // what is saved: the second copy of the points
    }
    const sum = (list) => list.reduce((n, x) => n + x.bytes, 0);
    return { restore, stems, restoreBytes: sum(restore), stemBytes: sum(stems) };
}
