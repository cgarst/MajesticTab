// audioSync/alignCheck.js
// Do two recordings of the same song line up, and do their sync points agree with that? Sync points are stored in each
// recording's own time, so a sync copied from one recording to another is only right when the two start together.
// `measureAlignment` compares the recordings' waveform peaks (peaks.js) over the whole song and in windows, and says
// whether they differ by one constant offset, by something that changes, or cannot be compared. `compareSyncs` then
// checks the bar points of two recordings against that offset. Both are pure (tests/audioSync/alignCheck.test.mjs).

import { estimateOffsetMs } from './borrowSync.js';
import { PEAKS_PER_SECOND } from './peaks.js';

const WINDOW_S = 20;
const SEARCH_S = 2;                 // how far a window may stray from the whole-song offset
const MIN_WINDOW_CONFIDENCE = 0.3;  // quieter or unrelated windows are left out
const MIN_WINDOWS = 3;
const MAX_SPREAD_MS = 60;           // windows disagreeing by more than this are not one constant offset
export const OFFSET_TOLERANCE_MS = 150;

const median = (values) => {
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * How recording B sits against recording A: add `offsetMs` to a time in A to get the same sound's time in B.
 * `kind` is 'offset' when the whole-song offset holds in every window, 'varies' when it does not (different edit,
 * tempo or mix), and 'unknown' when the peaks are too short or too unlike to say. `spreadMs` is the largest
 * disagreement between a window and the median.
 *
 * @param {Uint8Array} peaksA
 * @param {Uint8Array} peaksB
 * @returns {{ kind: 'offset'|'varies'|'unknown', offsetMs: number, confidence: number, spreadMs: number, windows: number }}
 */
export function measureAlignment(peaksA, peaksB, { peaksPerSecond = PEAKS_PER_SECOND } = {}) {
    const unknown = { kind: 'unknown', offsetMs: 0, confidence: 0, spreadMs: 0, windows: 0 };
    const whole = estimateOffsetMs(peaksA, peaksB, { peaksPerSecond });
    if (!whole) return unknown;
    const msPerBin = 1000 / peaksPerSecond;
    const win = WINDOW_S * peaksPerSecond;
    const search = SEARCH_S * peaksPerSecond;
    const centre = Math.round(whole.offsetMs / msPerBin);
    const found = [];
    for (let w = 0; w + win <= peaksA.length; w += win) {
        const from = w + centre - search;
        const to = w + centre + win + search;
        if (from < 0 || to > peaksB.length) continue;
        const est = estimateOffsetMs(peaksA.subarray(w, w + win), peaksB.subarray(from, to), {
            peaksPerSecond, maxShiftMs: SEARCH_S * 2 * 1000,
        });
        if (!est || est.confidence < MIN_WINDOW_CONFIDENCE) continue;
        // The slice of B starts `from` bins in, so its lag is measured from there
        found.push(est.offsetMs + (from - w) * msPerBin);
    }
    const base = { ...unknown, offsetMs: whole.offsetMs, confidence: whole.confidence, windows: found.length };
    if (found.length < MIN_WINDOWS) return base;
    const mid = median(found);
    const spreadMs = Math.round(Math.max(...found.map((v) => Math.abs(v - mid))));
    return { ...base, kind: spreadMs <= MAX_SPREAD_MS ? 'offset' : 'varies', offsetMs: Math.round(mid), spreadMs };
}

/**
 * Compares two recordings' bar points of the same score. `alignment` is measureAlignment(peaksA, peaksB). The typical
 * difference between the two sets of times should equal the audio offset; when it does not, one of the syncs does not
 * fit its recording. `deltaMs` is that typical difference (B minus A), `errorMs` how far it is from the offset.
 *
 * @returns {{ verdict: 'consistent'|'conflict'|'unknown', deltaMs: number, errorMs: number, matched: number }}
 */
export function compareSyncs(pointsA, pointsB, alignment) {
    const unknown = { verdict: 'unknown', deltaMs: 0, errorMs: 0, matched: 0 };
    if (alignment?.kind !== 'offset') return unknown;
    const key = (p) => `${p.barIndex}:${p.occurrence ?? 0}`;
    const timesA = new Map(pointsA.filter((p) => Number.isInteger(p.barIndex)).map((p) => [key(p), p.timeMs]));
    const deltas = pointsB.filter((p) => timesA.has(key(p))).map((p) => p.timeMs - timesA.get(key(p)));
    if (deltas.length < 3) return unknown;
    const deltaMs = Math.round(median(deltas));
    const errorMs = deltaMs - alignment.offsetMs;
    return { verdict: Math.abs(errorMs) > OFFSET_TOLERANCE_MS ? 'conflict' : 'consistent', deltaMs, errorMs, matched: deltas.length };
}

/** "2.5 s" or "640 ms". */
export function formatShift(ms) {
    const a = Math.abs(ms);
    return a >= 1000 ? `${(a / 1000).toFixed(a >= 10000 ? 0 : 1)} s` : `${Math.round(a)} ms`;
}

/**
 * One line for the sync editor, or null when the two recordings and their syncs agree or cannot be judged.
 * `otherName` is the other recording's name.
 */
export function conflictText(result, alignment, otherName) {
    if (result?.verdict !== 'conflict') return null;
    const apart = formatShift(alignment.offsetMs);
    if (Math.abs(result.deltaMs) <= OFFSET_TOLERANCE_MS) {
        return `The points match ${otherName}, but the two recordings are ${apart} apart. One of them is off.`;
    }
    return `The map differs from ${otherName} by ${formatShift(result.deltaMs)}, but the recordings are ${apart} apart. One of them is off.`;
}
