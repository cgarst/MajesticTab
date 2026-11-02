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
