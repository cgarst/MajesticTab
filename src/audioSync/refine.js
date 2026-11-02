// refine.js
// Pure helpers for the refine tools in tap mode: nudging a point, picking the whole bars around a selected range
// for a re-tap, and finding what a re-tap replaces. Unit tested in tests/audioSync/refine.test.mjs.

import { scoreToMedia } from './syncMap.js';

const NEIGHBOUR_GAP_MS = 1;

/**
 * Moves one point by `deltaMs`, never past its neighbours (each stays strictly before or after it) and never below 0.
 * Returns the new list sorted by time, or null when the point can't move that way.
 */
export function nudgePoint(points, id, deltaMs) {
    const sorted = [...points].sort((a, b) => a.timeMs - b.timeMs);
    const i = sorted.findIndex(p => p.id === id);
    if (i < 0) return null;
    const lo = i > 0 ? sorted[i - 1].timeMs + NEIGHBOUR_GAP_MS : 0;
    const hi = i < sorted.length - 1 ? sorted[i + 1].timeMs - NEIGHBOUR_GAP_MS : Infinity;
    const next = Math.min(hi, Math.max(lo, Math.round(sorted[i].timeMs + deltaMs)));
    if (next === sorted[i].timeMs) return null;
    return sorted.map(p => (p.id === id ? { ...p, timeMs: next } : p));
}

/** Moves a point to `timeMs`, held between its neighbours like `nudgePoint`. */
export function movePoint(points, id, timeMs) {
    const p = points.find(x => x.id === id);
    return p ? nudgePoint(points, id, timeMs - p.timeMs) : null;
}

/**
 * Widens a range of score time to whole bars of the played score: from the start of the bar that contains
 * `scoreA` to the end of the bar that contains `scoreB`.
 * @returns {{ scoreFrom: number, scoreTo: number }|null}
 */
export function wholeBarRange(timeline, scoreA, scoreB) {
    const { bars } = timeline;
    if (!bars.length) return null;
    const lo = Math.min(scoreA, scoreB);
    const hi = Math.max(scoreA, scoreB);
    const at = (ms) => {
        let found = bars[0];
        for (const b of bars) if (b.startMs <= ms) found = b;
        return found;
    };
    const first = at(lo);
    const last = hi > lo ? at(Math.max(lo, hi - 1)) : first;     // a range ending exactly on a bar line stops before the next bar
    return { scoreFrom: first.startMs, scoreTo: last.endMs };
}

/**
 * What re-tapping the score range `[scoreFrom, scoreTo)` replaces and where to play.
 * @param {Array<{id:string, scoreMs:number, timeMs:number}>} resolved points resolved to score time, sorted by time
 * @returns {{ ids: string[], mediaFrom: number, mediaTo: number }} the points inside the range, and the stretch of the
 *   recording it covers, read from the points as they are now
 */
export function retapWindow(resolved, scoreFrom, scoreTo) {
    return {
        ids: resolved.filter(p => p.scoreMs >= scoreFrom && p.scoreMs < scoreTo).map(p => p.id),
        mediaFrom: Math.max(0, scoreToMedia(resolved, scoreFrom)),
        mediaTo: Math.max(0, scoreToMedia(resolved, scoreTo))
    };
}
