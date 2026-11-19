// looseAnchors.js
// The arithmetic behind loose follow (looseFollow.js): anchors are `{ timeMs, scoreMs }` pairs the player tapped in, and
// the estimate runs through them and, where they agree, through the start and the end. Pure, so it is unit tested.

/** Adds an anchor and drops the ones it contradicts (time and score must both keep rising). */
export function addAnchor(list, a) {
    const kept = list.filter((p) => (p.timeMs < a.timeMs && p.scoreMs < a.scoreMs) || (p.timeMs > a.timeMs && p.scoreMs > a.scoreMs));
    return [...kept, a].sort((x, y) => x.timeMs - y.timeMs);
}
/** The anchors plus the two ends (start with start, end with end) where they agree with them. */
export function estimatePoints(list, durationMs, totalMs) {
    const pts = [...list];
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || (first.timeMs > 0 && first.scoreMs > 0)) pts.unshift({ timeMs: 0, scoreMs: 0 });
    if (!last || (last.timeMs < durationMs && last.scoreMs < totalMs)) pts.push({ timeMs: durationMs, scoreMs: totalMs });
    return pts;
}
