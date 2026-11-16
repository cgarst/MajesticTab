// fitBarPoints.js
// Bar sync points are kept per song, but a song can have several Guitar Pro scores of the same music laid out
// differently: one plays a repeat sign, another writes the repeated bars out. Points made on one layout name bars the
// other does not have (or lack the second pass of a repeat). This puts such points on the score's own played bars by
// their order in time: the nth point is the start of the nth bar played, which is the same bar in every layout.
// Pure: it works on the played-bar list `[{ barIndex, occurrence }]` in play order.

import { placeBarTimes } from './importers/index.js';

const keyOf = (barIndex, occurrence) => `${barIndex}:${occurrence || 0}`;

/**
 * Whether every point names a bar pass the score plays, and the points do not skip the repeats the score has: a score
 * that repeats bars but gets one point per bar index, more than it has bars once each, was synced on a layout that
 * wrote its repeats out.
 */
function fitsAsIs(points, playedBars) {
    const played = new Set(playedBars.map(b => keyOf(b.barIndex, b.occurrence)));
    if (!points.every(p => played.has(keyOf(p.barIndex, p.occurrence)))) return false;
    const hasRepeats = playedBars.some(b => b.occurrence > 0);
    const oncePlayed = playedBars.filter(b => !b.occurrence).length;
    const secondPass = points.some(p => p.occurrence > 0);
    return !(hasRepeats && !secondPass && points.length > oncePlayed);
}

/**
 * @param {Array<{barIndex:number, occurrence?:number, pos?:number, timeMs:number}>} points bar points, in memory form
 * @param {Array<{barIndex:number, occurrence:number}>} playedBars the score's bars in play order
 * @returns {{ points: Array, moved: boolean, dropped: number }} the points to keep; `moved` when they were put on other bars; `dropped` when the list was longer than the score plays
 */
export function fitBarPoints(points, playedBars) {
    const same = { points, moved: false, dropped: 0 };
    if (!Array.isArray(points) || points.length < 2 || !Array.isArray(playedBars) || !playedBars.length) return same;
    if (points.some(p => !(p.pos === undefined || p.pos === 0))) return same; // points inside bars are not bar starts
    if (fitsAsIs(points, playedBars)) return same;
    const sorted = [...points].sort((a, b) => a.timeMs - b.timeMs);
    const info = {};
    let placed;
    try {
        placed = placeBarTimes(sorted.map(p => p.timeMs), playedBars, info);
    } catch {
        return same; // the counts do not match: the points stay as they are
    }
    return {
        points: placed.map((q, i) => ({ ...sorted[i], barIndex: q.barIndex, occurrence: q.occurrence, pos: 0, timeMs: sorted[i].timeMs })),
        moved: true,
        dropped: info.extra || 0,
    };
}
