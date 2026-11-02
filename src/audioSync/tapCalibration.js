// tapCalibration.js
// Measures how long after a sound a person's taps land, so tap mode can take it off every tap. The clicks come at
// random intervals: against a steady beat people tap ahead of it, which would hide the delay. Each tap is paired with
// the click before it. Pure (unit tested in tests/audioSync/tapCalibration.test.mjs).

/** A tap this long after a click, or later, is not a reaction to it. */
export const MAX_DELAY_MS = 900;
/** The first taps are settling in and are left out of the result. */
export const SKIP_TAPS = 2;
/** Only the most recent taps count, so the result follows the person's rhythm. */
export const USE_TAPS = 12;
export const MIN_TAPS_FOR_RESULT = 3;

const MIN_INTERVAL_MS = 900;
const INTERVAL_SPREAD_MS = 800;

/** Time from one click to the next, 0.9 to 1.7 seconds. `random` is a number from 0 up to (not including) 1. */
export function nextClickInterval(random) {
    return MIN_INTERVAL_MS + Math.floor(random * INTERVAL_SPREAD_MS);
}

/**
 * The delay between a tap and the latest click before it.
 * @param {number[]} clicks click times in ms, ascending
 * @param {number} tapMs
 * @returns {{ delay: number, click: number }|null} null when no click came shortly before the tap
 */
export function delayForTap(clicks, tapMs) {
    let latest = null;
    for (const c of clicks) {
        if (c <= tapMs) latest = c; else break;
    }
    if (latest === null || tapMs - latest > MAX_DELAY_MS) return null;
    return { delay: tapMs - latest, click: latest };
}

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * @param {number[]} delays one per tap, in the order they were made
 * @returns {{ count: number, medianMs: number, spreadMs: number }|null} the typical delay and how much taps vary around
 *   it (the median distance from it), or null until there are enough taps
 */
export function summarizeDelays(delays, { skip = SKIP_TAPS, use = USE_TAPS } = {}) {
    const used = delays.slice(skip).slice(-use);
    if (used.length < MIN_TAPS_FOR_RESULT) return null;
    const m = median(used);
    return { count: used.length, medianMs: Math.round(m), spreadMs: Math.round(median(used.map(d => Math.abs(d - m)))) };
}

/**
 * The tap offset to use. The delay the person measures includes the speakers' own delay, which tap mode already takes
 * off through the audio latency setting, so that part is not counted twice.
 */
export function offsetFromDelay(medianMs, audioLatencyMs = 0) {
    return Math.max(0, Math.round(medianMs - audioLatencyMs));
}
