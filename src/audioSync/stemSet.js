// audioSync/stemSet.js
// A song whose recording is a set of stems (Music Pack SPEC section 8) with no full mix: one file per part (guitar, bass,
// drums, keys, vocals), time-aligned at offset 0. The player mixes them and the person chooses which ones are heard.
//
// What is kept, all app-internal (nothing is written into an exported pack):
//   - the set itself, on the lead stem's recording meta (`stems`, see recordingMeta.js): the parts' audio ids, labels
//     and instruments. The lead is the stem the pack's sync points are stored under, so both sounds share them.
//   - the muted parts of each sound, one localStorage entry per song and slot (`stem_mutes_<song>_<slot>`).
//
// Both sounds play the same set and differ only in what starts muted: Original starts with the full band, Backing starts
// without the guitar (without the bass in bass mode). The person's own choice, once made, is kept per sound.

import { createDecodedMixSource } from './decodedMixSource.js';

const MUTES_PREFIX = 'stem_mutes_';
const mutesKey = (songKey, slot) => `${MUTES_PREFIX}${encodeURIComponent(String(songKey).toLowerCase())}_${slot}`;

/** The audio ids of the parts a sound starts without: nothing for Original, the guitar (the bass, in bass mode) for Backing. */
export function defaultMutedIds(stems, slot, instrumentMode = 'guitar') {
    if (slot !== 'backing') return [];
    const instrument = instrumentMode === 'bass' ? 'bass' : 'guitar';
    return (stems || []).filter((s) => String(s.instrument || '').toLowerCase() === instrument).map((s) => s.audioId);
}

/** The muted part ids of a sound: the person's choice when there is one, else the default. Ids of parts the set no longer has are dropped. */
export function getMutedIds(songKey, slot, stems, instrumentMode, storage = localStorage) {
    const known = new Set((stems || []).map((s) => s.audioId));
    try {
        const raw = JSON.parse(storage.getItem(mutesKey(songKey, slot)) || 'null');
        if (Array.isArray(raw)) return raw.filter((id) => known.has(id));
    } catch { /* fall through to the default */ }
    return defaultMutedIds(stems, slot, instrumentMode);
}

export function setMutedIds(songKey, slot, ids, storage = localStorage) {
    try { storage.setItem(mutesKey(songKey, slot), JSON.stringify([...new Set(ids)])); } catch { /* optional */ }
}

/** Forgets the person's choice for a sound, so it starts from its default again. */
export function resetMutedIds(songKey, slot, storage = localStorage) {
    try { storage.removeItem(mutesKey(songKey, slot)); } catch { /* optional */ }
}

const levelsKey = (songKey, slot) => `stem_levels_${encodeURIComponent(String(songKey).toLowerCase())}_${slot}`;

/** The person's levels for a sound, `{ audioId: 0..1.5 }`; a stem not in it is at 1. */
export function getLevels(songKey, slot, storage = localStorage) {
    try {
        const raw = JSON.parse(storage.getItem(levelsKey(songKey, slot)) || '{}');
        const out = {};
        for (const [id, v] of Object.entries(raw || {})) if (Number.isFinite(v)) out[id] = Math.min(1.5, Math.max(0, v));
        return out;
    } catch { return {}; }
}

export function setLevel(songKey, slot, audioId, level, storage = localStorage) {
    const all = getLevels(songKey, slot, storage);
    if (level === 1) delete all[audioId]; else all[audioId] = level;
    try {
        if (Object.keys(all).length) storage.setItem(levelsKey(songKey, slot), JSON.stringify(all)); else storage.removeItem(levelsKey(songKey, slot));
    } catch { /* optional */ }
}

export function resetLevels(songKey, slot, storage = localStorage) {
    try { storage.removeItem(levelsKey(songKey, slot)); } catch { /* optional */ }
}

export const isStemMutesKey = (key) => typeof key === 'string' && (key.startsWith(MUTES_PREFIX) || key.startsWith('stem_levels_'));

/**
 * Builds the mixing source of a stem set. `lead` and each of `others` are `{ id, name, type, data, durationMs }`; the lead
 * keeps the clock. Every part starts switched off: the caller applies the muted list with `applyMutes`.
 */
export function createStemSource({ lead, others }, options = {}) {
    return createDecodedMixSource({ id: lead.id, base: lead, stems: others, mutableBase: true, ...options });
}

/** Sets each part's level from `levels` (`{ audioId: level }`, 1 when absent). */
export function applyLevels(source, levels) {
    for (const p of source.parts()) source.setPartLevel(p.id, levels[p.id] ?? 1);
}

/** Switches each part of the source on or off to match `mutedIds`. Resolves when every part to be heard is decoded. */
export async function applyMutes(source, mutedIds) {
    const muted = new Set(mutedIds);
    const results = await Promise.allSettled(source.parts().map((p) => source.setPartEnabled(p.id, !muted.has(p.id))));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
}

/** The set a recording meta describes, or null when it is not a set of two or more parts. */
export function stemsOfMeta(meta) {
    return Array.isArray(meta?.stems) && meta.stems.length > 1 ? meta.stems : null;
}
