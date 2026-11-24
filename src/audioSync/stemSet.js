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
import { createLocalMixSource } from './localMixSource.js';
import { getAudioMeta, getAudioFile } from './audioFileStore.js';
import { combinePeaks } from './peaks.js';
import { decodeFlux, combineFlux } from './refineOffset.js';
import { listRecordingMeta } from './recordingMeta.js';
import { mediaKey } from './syncStore.js';

/** Sent when a sound's muted parts are saved or reset, so a list that says how many are muted can follow. */
export const STEM_MUTES_EVENT = 'majestictab:stem-mutes';
const announce = () => { try { window.dispatchEvent(new Event(STEM_MUTES_EVENT)); } catch { /* not in a page */ } };

const MUTES_PREFIX = 'stem_mutes_';
const mutesKey = (songKey, slot) => `${MUTES_PREFIX}${encodeURIComponent(String(songKey).toLowerCase())}_${slot}`;

/** The audio ids of the parts a sound starts without: nothing for Original, the guitar (the bass, in bass mode) for Backing. */
export function defaultMutedIds(stems, slot, instrumentMode = 'guitar') {
    if (slot !== 'backing') return [];
    const instrument = instrumentMode === 'bass' ? 'bass' : 'guitar';
    return (stems || []).filter((s) => String(s.instrument || '').toLowerCase() === instrument).map((s) => s.audioId);
}

/** The parts a sound never plays: under Backing, the guitar (the bass, in bass mode). Bringing it back is Full band's job. */
export function lockedMutedIds(stems, slot, instrumentMode = 'guitar') {
    return defaultMutedIds(stems, slot, instrumentMode);
}

/** The muted part ids of a sound: the person's choice when there is one, else the default; the locked parts are always muted. Ids of parts the set no longer has are dropped. */
export function getMutedIds(songKey, slot, stems, instrumentMode, storage = localStorage) {
    const known = new Set((stems || []).map((s) => s.audioId));
    try {
        const raw = JSON.parse(storage.getItem(mutesKey(songKey, slot)) || 'null');
        if (Array.isArray(raw)) return [...new Set([...raw.filter((id) => known.has(id)), ...lockedMutedIds(stems, slot, instrumentMode)])];
    } catch { /* fall through to the default */ }
    return defaultMutedIds(stems, slot, instrumentMode);
}

export function setMutedIds(songKey, slot, ids, storage = localStorage) {
    try { storage.setItem(mutesKey(songKey, slot), JSON.stringify([...new Set(ids)])); } catch { /* optional */ }
    announce();
}

/** Forgets the person's choice for a sound, so it starts from its default again. */
export function resetMutedIds(songKey, slot, storage = localStorage) {
    try { storage.removeItem(mutesKey(songKey, slot)); } catch { /* optional */ }
    announce();
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

/**
 * Streaming HTMLAudioElement fallback for `createStemSource` when a recording is too long to decode into memory
 * or WebAudio decoding is unavailable.
 */
export function createStreamingStemSource({ lead, others }, options = {}) {
    return createLocalMixSource({ id: lead.id, base: lead, stems: others, mutableBase: true, ...options });
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

/** What a stem set is called where one name stands for it: "3 stems: Guitar, Bass, Drums", or '' when it is no set. */
export function stemSetName(meta) {
    const stems = stemsOfMeta(meta);
    if (!stems) return '';
    const labels = stems.map((s) => s.label).filter(Boolean);
    return `${stems.length} stems${labels.length ? `: ${labels.join(', ')}` : ''}`;
}

/**
 * Loads the waveform peaks for a local recording, combining every stem when the recording is a stem set.
 * Returns null when no peaks are stored.
 */
export async function loadRecordingPeaks(songKey, media, { getMeta = getAudioMeta, storage } = {}) {
    if (media?.kind !== 'local' || !media.audioId) return null;
    const stems = songKey ? stemsOfMeta(listRecordingMeta(songKey, storage)[mediaKey(media)]) : null;
    if (!stems) return (await getMeta(media.audioId).catch(() => null))?.peaks || null;
    const metas = await Promise.all(stems.map((s) => getMeta(s.audioId).catch(() => null)));
    return combinePeaks(metas.map((m) => m?.peaks));
}

/**
 * Decodes the 1 ms onset flux for a local recording, decoding one stem at a time and summing when it is a stem set
 * so only one decoded PCM buffer is held in memory at once.
 */
export async function loadRecordingFlux(songKey, media, { getFile = getAudioFile, decode = decodeFlux, storage } = {}) {
    if (media?.kind !== 'local' || !media.audioId) return null;
    const stems = songKey ? stemsOfMeta(listRecordingMeta(songKey, storage)[mediaKey(media)]) : null;
    if (!stems) {
        const file = await getFile(media.audioId).catch(() => null);
        return file?.data ? decode(file.data) : null;
    }
    const fluxes = [];
    for (const s of stems) {
        const file = await getFile(s.audioId).catch(() => null);
        const flux = file?.data ? await decode(file.data) : null;
        if (flux) fluxes.push(flux);
    }
    return combineFlux(fluxes);
}
