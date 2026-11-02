// onsets.js
// Finds where notes and hits start in a recording, so a tap that is a little early or late can snap to the sound it
// was meant for. The recording is cut into 5 ms steps, each step's loudness is compared with the one before, and the
// sharp rises that stand out from their surroundings are the onsets. `computeOnsets` and `nearestOnset` are pure
// (unit tested in tests/audioSync/onsets.test.mjs); `decodeOnsets` needs a browser's decoder.

const HOP_MS = 5;
const WINDOW_MS = 10;
const CONTEXT_FRAMES = 100;       // 0.5 s either side set what counts as a rise
const THRESHOLD_STDS = 2;
const MIN_RISE = 0.6;             // in natural-log energy: about a doubling
const MIN_GAP_MS = 30;

/**
 * @param {Float32Array[]} channels decoded channel data
 * @param {number} sampleRate
 * @returns {{ times: number[], strengths: number[] }} onset times in ms, ascending, and how sharp each rise was
 */
export function computeOnsets(channels, sampleRate) {
    const length = channels[0]?.length || 0;
    const hop = Math.max(1, Math.round(sampleRate * HOP_MS / 1000));
    const win = Math.max(1, Math.round(sampleRate * WINDOW_MS / 1000));
    const frames = Math.floor((length - win) / hop);
    if (frames < 3) return { times: [], strengths: [] };

    // Loudness per step (log of the mean square across channels)
    const energy = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
        let sum = 0;
        const start = f * hop;
        for (const data of channels) {
            for (let i = start; i < start + win; i++) sum += data[i] * data[i];
        }
        energy[f] = Math.log(sum / (win * channels.length) + 1e-9);
    }

    // Only rises count: a decay is not an onset
    const rise = new Float64Array(frames);
    for (let f = 1; f < frames; f++) rise[f] = Math.max(0, energy[f] - energy[f - 1]);

    // Local mean and spread of the rises, from running sums
    const sum = new Float64Array(frames + 1);
    const sumSq = new Float64Array(frames + 1);
    for (let f = 0; f < frames; f++) {
        sum[f + 1] = sum[f] + rise[f];
        sumSq[f + 1] = sumSq[f] + rise[f] * rise[f];
    }

    const picked = [];
    for (let f = 1; f < frames - 1; f++) {
        const a = Math.max(0, f - CONTEXT_FRAMES);
        const b = Math.min(frames, f + CONTEXT_FRAMES + 1);
        const n = b - a;
        const mean = (sum[b] - sum[a]) / n;
        const std = Math.sqrt(Math.max(0, (sumSq[b] - sumSq[a]) / n - mean * mean));
        if (rise[f] < MIN_RISE || rise[f] < mean + THRESHOLD_STDS * std) continue;
        if (rise[f] < rise[f - 1] || rise[f] < rise[f + 1]) continue;       // a local peak
        // The step whose window first covers an attack rises sharply; the attack sits inside that window
        picked.push({ time: f * hop * 1000 / sampleRate + WINDOW_MS / 2, strength: rise[f] });
    }

    // Two onsets closer than the minimum gap are one hit: keep the sharper
    const times = [];
    const strengths = [];
    for (const p of picked) {
        const last = times.length - 1;
        if (last >= 0 && p.time - times[last] < MIN_GAP_MS) {
            if (p.strength > strengths[last]) { times[last] = p.time; strengths[last] = p.strength; }
        } else {
            times.push(p.time);
            strengths.push(p.strength);
        }
    }
    return { times, strengths };
}

/**
 * The onset closest to `timeMs` within `windowMs` either side, or null.
 * @returns {{ timeMs: number, deltaMs: number }|null} `deltaMs` is how far the onset is from the time asked about
 */
export function nearestOnset(onsets, timeMs, windowMs = 80) {
    const { times } = onsets;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] < timeMs) lo = mid + 1; else hi = mid;
    }
    let best = null;
    for (const i of [lo - 1, lo]) {
        if (i < 0 || i >= times.length) continue;
        const d = Math.abs(times[i] - timeMs);
        if (d <= windowMs && (!best || d < Math.abs(best.deltaMs))) best = { timeMs: times[i], deltaMs: times[i] - timeMs };
    }
    return best;
}

/** Decodes `arrayBuffer` and finds its onsets, or returns null when the platform can't decode this format. */
export async function decodeOnsets(arrayBuffer) {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    try {
        const audio = await ctx.decodeAudioData(arrayBuffer.slice(0));
        const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
        return computeOnsets(channels, audio.sampleRate);
    } catch {
        return null;
    } finally {
        ctx.close?.().catch?.(() => {});
    }
}
