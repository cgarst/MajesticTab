// syncMap.js
// Pure mapping between recording time and score time for audio sync points. No DOM / AlphaTab access so it can
// be unit tested in Node (see tests/audioSync/syncMap.test.mjs).
//
// A point pairs a position on the score's written-time axis (`scoreMs`: milliseconds on AlphaTab's synth timeline,
// which expands repeats) with a time in the recording (`timeMs`). Callers convert bar/occurrence/position to
// `scoreMs`. Between two points the mapping is linear in written time, like AlphaTab's own sync points: it rescales
// the tempo by recording time / written time, which differs from linear-in-ticks when the written tempo changes
// between two points. Before the first and after the last point the adjacent segment's rate carries on, as in
// AlphaTab; with a single point there is no segment, so the recording runs at the written tempo (1:1).

export const MIN_TEMPO_RATIO = 0.25;
export const MAX_TEMPO_RATIO = 4;

/**
 * Checks points sorted by time. Returns a list of problems (empty when valid):
 * `{ index, id, code: 'order' | 'tempo', message }`. Points must be strictly increasing in both axes; an implausible
 * segment tempo is reported as a warning (`code: 'tempo'`) and does not make the map unusable.
 */
export function validatePoints(points) {
    const problems = [];
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        if (!(b.timeMs > a.timeMs) || !(b.scoreMs > a.scoreMs)) {
            problems.push({ index: i, id: b.id, code: 'order', message: 'Sync points must be in order in both the recording and the score' });
            continue;
        }
        const ratio = (b.scoreMs - a.scoreMs) / (b.timeMs - a.timeMs);
        if (ratio < MIN_TEMPO_RATIO || ratio > MAX_TEMPO_RATIO) {
            problems.push({ index: i, id: b.id, code: 'tempo', message: 'Implied tempo is far from the written tempo' });
        }
    }
    return problems;
}

export function hasOrderProblems(points) {
    return validatePoints(points).some(p => p.code === 'order');
}

/** Index of the last point whose `key` value is <= value, or -1. Points must be sorted by `key`. */
function lastAtOrBefore(points, key, value) {
    let lo = 0;
    let hi = points.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid][key] <= value) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

function convert(points, value, fromKey, toKey) {
    const n = points.length;
    if (!n) return value;
    const i = lastAtOrBefore(points, fromKey, value);
    // Outside the first/last point, carry on at the adjacent segment's rate (1:1 with a single point).
    const edgeRate = (a, b) => (n < 2 ? 1 : (b[toKey] - a[toKey]) / (b[fromKey] - a[fromKey]));
    if (i < 0) return points[0][toKey] - (points[0][fromKey] - value) * edgeRate(points[0], points[1]);
    if (i === n - 1) return points[i][toKey] + (value - points[i][fromKey]) * edgeRate(points[n - 2], points[n - 1]);
    const a = points[i];
    const b = points[i + 1];
    const t = (value - a[fromKey]) / (b[fromKey] - a[fromKey]);
    return a[toKey] + t * (b[toKey] - a[toKey]);
}

/** Recording time (ms) to score time (ms). Can be negative before the first point; callers clamp. */
export function mediaToScore(points, timeMs) {
    return convert(points, timeMs, 'timeMs', 'scoreMs');
}

/** Score time (ms) to recording time (ms). */
export function scoreToMedia(points, scoreMs) {
    return convert(points, scoreMs, 'scoreMs', 'timeMs');
}

/**
 * Derived per-segment values, one per adjacent pair: `ratio` is written time / recording time (above 1 means the
 * recording is faster than written) and `bpm` is the implied tempo given the written `writtenBpm`.
 */
export function segmentTempos(points, writtenBpm) {
    const out = [];
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const ratio = (b.scoreMs - a.scoreMs) / (b.timeMs - a.timeMs);
        out.push({ fromId: a.id, toId: b.id, ratio, bpm: writtenBpm ? writtenBpm * ratio : null });
    }
    return out;
}

/**
 * Written time / recording time at score time `scoreMs`: the rate the recording plays the score at there (above 1
 * means faster than written). Outside the first and last point it carries on at the adjacent segment's rate, and a
 * single point or a degenerate segment gives 1.
 */
export function ratioAtScore(points, scoreMs) {
    const n = points.length;
    if (n < 2) return 1;
    let i = 0;
    while (i < n - 2 && points[i + 1].scoreMs <= scoreMs) i++;
    const a = points[i];
    const b = points[i + 1];
    const ratio = (b.scoreMs - a.scoreMs) / (b.timeMs - a.timeMs);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** Returns a new sorted list with `point` inserted, replacing any point with the same id. Does not validate. */
export function withPoint(points, point) {
    return [...points.filter(p => p.id !== point.id), point].sort((a, b) => a.timeMs - b.timeMs);
}
