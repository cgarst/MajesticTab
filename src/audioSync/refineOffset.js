// audioSync/refineOffset.js
// Takes the coarse offset between two recordings (alignCheck.js, accurate to the 20 ms of the waveform peaks) down to
// about a millisecond. Each recording is reduced to a 1 ms envelope of how sharply its loudness rises (the same idea as
// onsets.js, so two different mixes of one performance still match), and the two are compared at every shift within
// 80 ms of the coarse offset over segments spread across the song. `computeFlux` and `refineOffset` are pure (unit
// tested in tests/audioSync/refineOffset.test.mjs); `decodeFlux` needs a browser's decoder.

export const FLUX_PER_SECOND = 1000;
const SMOOTH_MS = 5;
const SEGMENT_S = 12;
const MAX_SEGMENTS = 14;
const RANGE_MS = 80;

/**
 * @param {Float32Array[]} channels decoded channel data
 * @param {number} sampleRate
 * @returns {Float32Array} one value per millisecond: the rise in log loudness there, 0 where it falls
 */
export function computeFlux(channels, sampleRate) {
    const length = channels[0]?.length || 0;
    const ms = Math.floor(length * 1000 / sampleRate);
    const per = sampleRate / 1000;
    const energy = new Float64Array(ms);
    for (let i = 0; i < ms; i++) {
        const from = Math.floor(i * per);
        const to = Math.min(length, Math.floor((i + 1) * per) || from + 1);
        let sum = 0;
        for (const data of channels) for (let j = from; j < to; j++) sum += data[j] * data[j];
        energy[i] = sum / (Math.max(1, to - from) * channels.length);
    }
    // A short moving average, then the log, then only the rises
    const smooth = new Float64Array(ms);
    let run = 0;
    for (let i = 0; i < ms; i++) {
        run += energy[i];
        if (i >= SMOOTH_MS) run -= energy[i - SMOOTH_MS];
        smooth[i] = Math.log(run / Math.min(i + 1, SMOOTH_MS) + 1e-9);
    }
    const flux = new Float32Array(ms);
    for (let i = 1; i < ms; i++) flux[i] = Math.max(0, smooth[i] - smooth[i - 1]);
    return flux;
}

/**
 * The shift that lines A up with B to the millisecond: add the result to a time in A to get the same sound's time in B.
 * `coarseMs` is the estimate to search around. Returns null when there is nothing to compare.
 *
 * @param {Float32Array} fluxA
 * @param {Float32Array} fluxB
 * @param {number} coarseMs
 * @returns {{ offsetMs: number, confidence: number } | null}
 */
export function refineOffset(fluxA, fluxB, coarseMs, { rangeMs = RANGE_MS } = {}) {
    const seg = SEGMENT_S * 1000;
    const coarse = Math.round(coarseMs);
    // Segments of A that B has audio for, busiest first, then spread out in time
    const candidates = [];
    for (let w = 0; w + seg <= fluxA.length; w += seg) {
        if (w + coarse - rangeMs < 0 || w + coarse + seg + rangeMs > fluxB.length) continue;
        let sum = 0;
        for (let i = w; i < w + seg; i++) sum += fluxA[i];
        candidates.push({ w, sum });
    }
    if (!candidates.length) return null;
    const mean = candidates.reduce((s, c) => s + c.sum, 0) / candidates.length;
    const busy = candidates.filter((c) => c.sum >= mean * 0.5);
    const step = Math.max(1, Math.ceil(busy.length / MAX_SEGMENTS));
    const chosen = busy.filter((_, i) => i % step === 0);
    if (!chosen.length) return null;

    const shifts = rangeMs * 2 + 1;
    const dots = new Float64Array(shifts);
    let energyA = 0;
    let energyB = 0;
    for (const { w } of chosen) {
        for (let i = w; i < w + seg; i++) energyA += fluxA[i] * fluxA[i];
        for (let k = 0; k < shifts; k++) {
            const base = w + coarse - rangeMs + k;
            let dot = 0;
            for (let i = 0; i < seg; i++) dot += fluxA[w + i] * fluxB[base + i];
            dots[k] += dot;
        }
        const mid = w + coarse;
        for (let i = mid; i < mid + seg; i++) energyB += fluxB[i] * fluxB[i];
    }
    if (!energyA || !energyB) return null;
    let best = 0;
    for (let k = 1; k < shifts; k++) if (dots[k] > dots[best]) best = k;
    // A parabola through the peak and its neighbours places it between whole milliseconds
    let frac = 0;
    if (best > 0 && best < shifts - 1) {
        const a = dots[best - 1];
        const b = dots[best];
        const c = dots[best + 1];
        const denom = a - 2 * b + c;
        if (denom < 0) frac = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denom));
    }
    const confidence = Math.max(0, Math.min(1, dots[best] / Math.sqrt(energyA * energyB)));
    return { offsetMs: Math.round(coarse - rangeMs + best + frac) || 0, confidence };
}

/** Combines time-aligned flux arrays (such as a set of stems) by summing each millisecond's onset rise. */
export function combineFlux(fluxList) {
    const valid = (fluxList || []).filter((f) => f?.length);
    if (!valid.length) return null;
    if (valid.length === 1) return valid[0];
    let maxLen = 0;
    for (const f of valid) if (f.length > maxLen) maxLen = f.length;
    const out = new Float32Array(maxLen);
    for (const f of valid) for (let i = 0; i < f.length; i++) out[i] += f[i];
    return out;
}

/** Decodes `arrayBuffer` and returns its flux, or null when the platform can't decode this format. */
export async function decodeFlux(arrayBuffer) {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    try {
        const audio = await ctx.decodeAudioData(arrayBuffer.slice(0));
        return computeFlux(Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i)), audio.sampleRate);
    } catch {
        return null;
    } finally {
        ctx.close?.().catch?.(() => {});
    }
}
