// tapRules.js
// Decides whether a tap can become a sync point. A point pairs a position in the score with a time in the recording,
// and points must keep the same order in both, so a tap is valid when every other point is on the same side of it in
// the score as it is in the recording. A tap on a position that already has a point replaces that point (re-tapping a
// bar). Pure; unit tested in tests/audioSync/tapRules.test.mjs.

const SAME_POSITION_MS = 1;

/**
 * @param {Array<{id:string, scoreMs:number, timeMs:number}>} points existing points, resolved to score time
 * @param {Array<{scoreMs:number}>} candidates the positions the tapped beat can mean, in play order (one per pass
 *   of a repeated bar)
 * @param {number} timeMs the tap's time in the recording
 * @returns {{ candidate: object, replaceId: string|null }|null} the first candidate that keeps the points in order,
 *   or null when none does
 */
export function chooseTap(points, candidates, timeMs) {
    for (const candidate of candidates) {
        let replaceId = null;
        let ok = true;
        for (const p of points) {
            if (Math.abs(p.scoreMs - candidate.scoreMs) <= SAME_POSITION_MS) {
                replaceId = p.id;
                continue;
            }
            if (p.timeMs === timeMs || (p.scoreMs < candidate.scoreMs) !== (p.timeMs < timeMs)) {
                ok = false;
                break;
            }
        }
        if (ok) return { candidate, replaceId };
    }
    return null;
}

const conflictsWith = (p, scoreMs, timeMs) => p.timeMs === timeMs || (p.scoreMs < scoreMs) !== (p.timeMs < timeMs);

/**
 * Patch Sync: a tap on any bar is kept, and the points it contradicts go instead of the tap being refused. The pass
 * of a repeated bar that contradicts the fewest points is chosen (the first on a tie).
 * @param {Array<{id:string, scoreMs:number, timeMs:number}>} points existing points, resolved to score time
 * @param {Array<{scoreMs:number}>} candidates the positions the tapped beat can mean
 * @param {number} timeMs the tap's time in the recording
 * @returns {{ candidate: object, replaceIds: string[], dropIds: string[] }|null} `replaceIds` are points on the
 *   tapped position itself, `dropIds` are points that would be out of order with the tap
 */
export function patchPlan(points, candidates, timeMs) {
    let best = null;
    for (const candidate of candidates) {
        const replaceIds = [];
        const dropIds = [];
        for (const p of points) {
            if (Math.abs(p.scoreMs - candidate.scoreMs) <= SAME_POSITION_MS) replaceIds.push(p.id);
            else if (conflictsWith(p, candidate.scoreMs, timeMs)) dropIds.push(p.id);
        }
        if (!best || dropIds.length < best.dropIds.length) best = { candidate, replaceIds, dropIds };
    }
    return best;
}

/**
 * Patch Sync's fix range: two taps mark the start and the end of a bad stretch. Both become points, and every point
 * between them in the score goes, along with any point outside that they contradict.
 * @returns {{ a: object, b: object, removeIds: string[], clearedCount: number }|null} null when the end is not after
 *   the start in both the score and the recording
 */
export function rangePlan(points, candidatesA, timeA, candidatesB, timeB) {
    if (!(timeB > timeA)) return null;
    for (const a of candidatesA) {
        for (const b of candidatesB) {
            if (!(b.scoreMs > a.scoreMs)) continue;
            const inside = points.filter(p => p.scoreMs >= a.scoreMs - SAME_POSITION_MS && p.scoreMs <= b.scoreMs + SAME_POSITION_MS);
            const rest = points.filter(p => !inside.includes(p));
            const contradicted = rest.filter(p => conflictsWith(p, a.scoreMs, timeA) || conflictsWith(p, b.scoreMs, timeB));
            return { a, b, removeIds: [...inside, ...contradicted].map(p => p.id), clearedCount: inside.length + contradicted.length };
        }
    }
    return null;
}
