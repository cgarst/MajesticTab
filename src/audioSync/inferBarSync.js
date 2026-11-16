// inferBarSync.js
// Infers Guitar Pro bar sync points (`anchorType: 'bar'`) from a PDF score's sync points (`anchorType: 'pdf'`)
// when the PDF points sit on a regular musical grid (such as beats, eighth-notes, or bar starts).
// Pure: works on a score timeline from `buildScoreTimeline` and an array of PDF points. No DOM or AlphaTab access.

import { TICKS_PER_QUARTER } from './scorePositions.js';
import { syncFit } from './pointCheck.js';

const CANDIDATE_UNITS = [
    { name: 'sixteenth', ticks: TICKS_PER_QUARTER / 4 },
    { name: 'eighth', ticks: TICKS_PER_QUARTER / 2 },
    { name: 'quarter', ticks: TICKS_PER_QUARTER },
    { name: 'half', ticks: TICKS_PER_QUARTER * 2 },
    { name: 'bar', ticks: null },
];

const MAX_INTERVAL_RATIO_DEVIATION = 0.35;
const MIN_REGULAR_SHARE = 0.75;
const SKIP_START_COST = 0.25;
const SKIP_END_COST = 0.1;
const SKIP_STEP_COST = 0.45;
const MAX_DP_BAND = 48;

function tickToScoreMs(bar, tick) {
    let seg = bar.segments[0];
    for (const s of bar.segments) {
        if (s.tick <= tick) seg = s;
    }
    return seg.ms + (tick - seg.tick) * 60000 / (seg.tempo * TICKS_PER_QUARTER);
}

/** Expands `timeline.bars` into a grid of `{ barIdx, barIndex, occurrence, tick, scoreMs, isBarStart }`. */
function buildScoreGrid(timeline, unitTicks) {
    const grid = [];
    timeline.bars.forEach((bar, barIdx) => {
        if (unitTicks === null) {
            grid.push({
                barIdx,
                barIndex: bar.barIndex,
                occurrence: bar.occurrence,
                tick: bar.startTick,
                scoreMs: bar.startMs,
                isBarStart: true,
            });
            return;
        }
        for (let t = bar.startTick; t < bar.endTick - 1e-6; t += unitTicks) {
            grid.push({
                barIdx,
                barIndex: bar.barIndex,
                occurrence: bar.occurrence,
                tick: t,
                scoreMs: tickToScoreMs(bar, t),
                isBarStart: t === bar.startTick,
            });
        }
    });
    return grid;
}

/** Checks that most inter-point intervals are reasonably regular (not sparse/ad-hoc phrase clicks). */
function isRegularGrid(times) {
    if (times.length < 4) return false;
    const diffs = [];
    for (let i = 1; i < times.length; i++) diffs.push(times[i] - times[i - 1]);
    const sorted = [...diffs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (!(median > 0)) return false;
    let regular = 0;
    for (const d of diffs) {
        if (d >= median * 0.55 && d <= median * 1.65) regular++;
    }
    return regular / diffs.length >= MIN_REGULAR_SHARE;
}

/**
 * Banded 1D dynamic programming alignment between PDF timestamps `times` (length N) and score grid `grid` (length M).
 * Returns an array `map[pIdx] = sIdx` (or -1 if skipped), or null if lengths are incompatible.
 */
function alignSequences(times, grid) {
    const N = times.length;
    const M = grid.length;
    if (N < 4 || M < 4) return null;
    if (N < M * 0.5 || N > M * 1.25) return null;

    const band = Math.max(MAX_DP_BAND, Math.abs(M - N) + 16);
    const INF = 1e9;
    // Flat Float64Array per row would be tiny; band-offset rows keep memory O(N * band)
    const rowWidth = 2 * band + 1;
    const dp = new Float64Array(N * rowWidth).fill(INF);
    const parent = new Int8Array(N * rowWidth); // 1 = diag, 2 = left (skip S), 3 = up (skip P)

    const colOffset = (i) => Math.round((i * (M - 1)) / Math.max(1, N - 1));
    const cellIdx = (i, j) => {
        const off = j - colOffset(i) + band;
        return off >= 0 && off < rowWidth ? i * rowWidth + off : -1;
    };

    for (let j = 0; j < Math.min(M, band + 1); j++) {
        const idx = cellIdx(0, j);
        if (idx >= 0) {
            const subBarPenalty = j > 0 && !grid[j].isBarStart ? 1.0 : 0;
            dp[idx] = j * SKIP_START_COST + subBarPenalty;
        }
    }

    for (let i = 1; i < N; i++) {
        const c = colOffset(i);
        const jStart = Math.max(0, c - band);
        const jEnd = Math.min(M - 1, c + band);
        const dt = i > 0 ? times[i] - times[i - 1] : 0;

        for (let j = jStart; j <= jEnd; j++) {
            const curIdx = cellIdx(i, j);
            let best = dp[curIdx];
            let bestOp = 0;

            if (j > 0) {
                const leftIdx = cellIdx(i, j - 1);
                if (leftIdx >= 0) {
                    const cost = dp[leftIdx] + (i === N - 1 ? SKIP_END_COST : SKIP_STEP_COST);
                    if (cost < best) { best = cost; bestOp = 2; }
                }
            }
            if (i > 0) {
                const upIdx = cellIdx(i - 1, j);
                if (upIdx >= 0) {
                    const cost = dp[upIdx] + SKIP_STEP_COST;
                    if (cost < best) { best = cost; bestOp = 3; }
                }
            }
            if (i > 0 && j > 0) {
                const diagIdx = cellIdx(i - 1, j - 1);
                if (diagIdx >= 0) {
                    const ds = grid[j].scoreMs - grid[j - 1].scoreMs;
                    const err = ds > 0 && dt > 0 ? Math.abs(dt / ds - 1) : 1;
                    const stepCost = err <= MAX_INTERVAL_RATIO_DEVIATION ? err : MAX_INTERVAL_RATIO_DEVIATION + (err - MAX_INTERVAL_RATIO_DEVIATION) * 4;
                    const cost = dp[diagIdx] + stepCost;
                    if (cost < best) { best = cost; bestOp = 1; }
                }
            }
            dp[curIdx] = best;
            parent[curIdx] = bestOp;
        }
    }

    let bestEndJ = -1;
    let bestEndCost = INF;
    const lastC = colOffset(N - 1);
    for (let j = Math.max(0, lastC - band); j <= Math.min(M - 1, lastC + band); j++) {
        const idx = cellIdx(N - 1, j);
        if (idx < 0) continue;
        const cost = dp[idx] + (M - 1 - j) * SKIP_END_COST;
        if (cost < bestEndCost) { bestEndCost = cost; bestEndJ = j; }
    }
    if (bestEndJ < 0 || bestEndCost >= INF) return null;

    const map = new Int32Array(N).fill(-1);
    let i = N - 1;
    let j = bestEndJ;
    while (i >= 0 && j >= 0) {
        const idx = cellIdx(i, j);
        const op = idx >= 0 ? parent[idx] : 0;
        if (op === 1) {
            map[i] = j;
            i--;
            j--;
        } else if (op === 2) {
            j--;
        } else if (op === 3) {
            i--;
        } else {
            map[i] = j;
            break;
        }
    }
    return map;
}

/** Converts an aligned grid mapping into bar-start sync points `{ id, barIndex, occurrence, pos: 0, timeMs }`. */
function extractBarPoints(timeline, times, grid, map) {
    const barStartByIdx = new Map();
    for (let pIdx = 0; pIdx < map.length; pIdx++) {
        const sIdx = map[pIdx];
        if (sIdx < 0) continue;
        const step = grid[sIdx];
        if (step.isBarStart && !barStartByIdx.has(step.barIdx)) {
            barStartByIdx.set(step.barIdx, times[pIdx]);
        }
    }

    const points = [];
    timeline.bars.forEach((bar, barIdx) => {
        const timeMs = barStartByIdx.get(barIdx);
        if (timeMs === undefined) return;
        points.push({
            id: `infer_${bar.barIndex}_${bar.occurrence}`,
            barIndex: bar.barIndex,
            occurrence: bar.occurrence,
            pos: 0,
            timeMs: Math.round(timeMs),
        });
    });
    return points;
}

/**
 * Infers GP bar sync points from PDF sync points against a score `timeline`.
 *
 * @param {object} timeline result of `buildScoreTimeline(playedBars)`
 * @param {Array<{timeMs:number}>} pdfPoints PDF sync points (will be sorted by `timeMs`)
 * @returns {{ points: Array, fit: object, unit: string, matchedSteps: number, totalSteps: number } | null}
 */
export function inferBarSyncFromPdf(timeline, pdfPoints) {
    if (!timeline?.bars?.length || !Array.isArray(pdfPoints) || pdfPoints.length < 4) return null;
    const times = [...pdfPoints]
        .map(p => p?.timeMs)
        .filter(t => Number.isFinite(t) && t >= 0)
        .sort((a, b) => a - b);

    if (!isRegularGrid(times)) return null;

    let best = null;
    for (const unit of CANDIDATE_UNITS) {
        const grid = buildScoreGrid(timeline, unit.ticks);
        const map = alignSequences(times, grid);
        if (!map) continue;

        const points = extractBarPoints(timeline, times, grid, map);
        if (points.length < timeline.bars.length * 0.8) continue;

        const fit = syncFit(timeline, points);
        if (!fit || fit.flagged > 0 || fit.tempoSpread > 0.2) continue;

        let matchedSteps = 0;
        for (let k = 0; k < map.length; k++) {
            if (map[k] >= 0) matchedSteps++;
        }

        const score = fit.placed * 10 - fit.tempoSpread * 100 - Math.abs(times.length - grid.length) * 0.05;
        if (!best || score > best.score) {
            best = {
                score,
                result: { points, fit, unit: unit.name, matchedSteps, totalSteps: grid.length },
            };
        }
    }

    return best ? best.result : null;
}
