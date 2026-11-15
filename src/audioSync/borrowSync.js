// audioSync/borrowSync.js
// Uses the sync points of one recording for another recording of the same song, shifted by an offset. Two recordings of
// the same studio track often differ only by a lead-in or a trimmed start, so the points made for one fit the other
// once every time moves by the same amount.
//
// Only points that belong to the same score are borrowed: the store keeps a score's points under one key (the song for
// Guitar Pro bars, the score file for text and PDF, anchors.js), so the records `borrowableRecords` lists are the ones
// of that score and no other. Points made for a different score file are never offered.
//
// `estimateOffsetMs` and `borrowRecord` are pure apart from the store they are given (unit tested in
// tests/audioSync/borrowSync.test.mjs).

import { listRecords, saveRecord, mediaKey } from './syncStore.js';
import { PEAKS_PER_SECOND } from './peaks.js';

const MAX_SHIFT_MS = 30000;
const MIN_CONFIDENCE = 0.5;

/**
 * The shift that lines recording A up with recording B: add the result to a time in A to get the same sound's time in B.
 * Compares the two waveforms' peaks (peaks.js) at every shift up to 30 s either way. `confidence` is the normalised
 * correlation at the best shift, 0 to 1; below 0.5 the match is a guess and the caller should ask the player.
 * Returns null when either waveform is too short to compare.
 *
 * @param {Uint8Array} peaksA
 * @param {Uint8Array} peaksB
 * @returns {{ offsetMs: number, confidence: number } | null}
 */
export function estimateOffsetMs(peaksA, peaksB, { peaksPerSecond = PEAKS_PER_SECOND, maxShiftMs = MAX_SHIFT_MS } = {}) {
    if (!peaksA?.length || !peaksB?.length || Math.min(peaksA.length, peaksB.length) < peaksPerSecond * 2) return null;
    const centred = (p) => {
        let sum = 0;
        for (let i = 0; i < p.length; i++) sum += p[i];
        const mean = sum / p.length;
        const out = new Float32Array(p.length);
        for (let i = 0; i < p.length; i++) out[i] = p[i] - mean;
        return out;
    };
    const a = centred(peaksA);
    const b = centred(peaksB);
    let energyA = 0;
    let energyB = 0;
    for (const v of a) energyA += v * v;
    for (const v of b) energyB += v * v;
    if (!energyA || !energyB) return null;
    const maxLag = Math.min(Math.round(maxShiftMs * peaksPerSecond / 1000), Math.max(a.length, b.length) - 1);
    let best = -Infinity;
    let bestLag = 0;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
        // B[i + lag] against A[i]
        const from = Math.max(0, -lag);
        const to = Math.min(a.length, b.length - lag);
        let sum = 0;
        for (let i = from; i < to; i++) sum += a[i] * b[i + lag];
        if (sum > best) { best = sum; bestLag = lag; }
    }
    const confidence = Math.max(0, Math.min(1, best / Math.sqrt(energyA * energyB)));
    return { offsetMs: Math.round(bestLag * 1000 / peaksPerSecond), confidence };
}

/** Is an estimate sure enough to apply without asking the player to check it? */
export const isConfident = (estimate) => Boolean(estimate) && estimate.confidence >= MIN_CONFIDENCE;

/**
 * The records under `key` (one score's key) that hold points and belong to a recording other than `media`, newest first.
 * `anchorType`, when given, keeps only the records of that kind of score.
 */
export function borrowableRecords(key, media, anchorType = null, storage) {
    const own = mediaKey(media);
    return listRecords(key, storage).filter((r) => r.points.length && mediaKey(r.media) !== own && (!anchorType || r.anchorType === anchorType));
}

/**
 * Copies `from`'s points to `media` under `key`, every time moved by `offsetMs`. A point that would fall before the start
 * of the recording is dropped. Returns the saved record, or null when nothing could be saved. An existing record of
 * `media` is not replaced unless `replace` is set.
 */
export function borrowRecord(key, from, media, offsetMs, { replace = false, storage, now = Date.now() } = {}) {
    if (!from?.points?.length || !mediaKey(media) || !Number.isFinite(offsetMs)) return null;
    const args = storage ? [storage] : [];
    if (!replace) {
        const existing = listRecords(key, ...args).find((r) => mediaKey(r.media) === mediaKey(media) && r.points.length);
        if (existing) return null;
    }
    const points = from.points
        .map((p) => ({ ...p, timeMs: p.timeMs + offsetMs }))
        .filter((p) => p.timeMs >= 0);
    if (!points.length) return null;
    return saveRecord(key, media, points, storage, now, from.anchorType);
}

