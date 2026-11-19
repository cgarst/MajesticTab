// inferBarSync.js
// Infers Guitar Pro bar sync points (`anchorType: 'bar'`) from a PDF score's sync points (`anchorType: 'pdf'`)
// when the PDF points sit on a regular musical grid (such as beats, eighth-notes, or bar starts).
// Pure: works on a score timeline from `buildScoreTimeline` and an array of PDF points. No DOM or AlphaTab access.

import { TICKS_PER_QUARTER } from './scorePositions.js';
import { syncFit } from './pointCheck.js';
import { nearestOnset } from './onsets.js';

const CANDIDATE_UNITS = [
    { name: 'sixteenth', ticks: TICKS_PER_QUARTER / 4 },
    { name: 'eighth', ticks: TICKS_PER_QUARTER / 2 },
    { name: 'quarter', ticks: TICKS_PER_QUARTER },
    { name: 'half', ticks: TICKS_PER_QUARTER * 2 },
    { name: 'bar', ticks: null },
    // One step per beat of each bar's own meter: dotted quarters in 6/8, 9/8, 12/8 and 15/8, else the denominator note
    { name: 'beat', ticks: 'meter' },
];

const MAX_INTERVAL_RATIO_DEVIATION = 0.35;
const MIN_REGULAR_SHARE = 0.75;
const SKIP_START_COST = 0.1;
// A PDF may open with a count-in bar the score lacks (a few points), but its first point is otherwise the start of its first
// bar: skipping more than a bar's worth of its first points is dear
const FREE_PDF_START_SKIPS = 8;
const SKIP_PDF_START_COST = 0.6;
const pdfStartSkipCost = (n) => Math.min(n, FREE_PDF_START_SKIPS) * SKIP_START_COST + Math.max(0, n - FREE_PDF_START_SKIPS) * SKIP_PDF_START_COST;
const SKIP_END_COST = 0.1;
const SKIP_STEP_COST = 0.45;
// The PDF's line breaks do not say where the score's bars are when the two barline the same music differently (5/4 + 6/4 in one, 6/4 + 6/4 in the other), so they only break ties
const SYS_BREAK_OFF_BAR_PENALTY = 0;
const MAX_DP_BAND = 48;
const LONG_STEP_RATIO = 2.5;            // a score step this many times the PDF's usual gap can take several PDF points
const MAX_LONG_STEP_POINTS = 40;
const LONG_STEP_COST = 0.05;
const LONG_STEP_MAX_ERROR = 0.25;       // its PDF points must span about the step's own time, so the count they take is pinned down
const LONG_STEP_ERROR_WEIGHT = 4;
const MAX_FLAGGED_SHARE = 0.03;
const ONSET_MATCH_WINDOW_MS = 120;
const MAX_BAR_SHIFTS = 4;
const MAX_STEP_SHIFT = 8;                // the PDF may also start a beat or two off the score's first bar

function tickToScoreMs(bar, tick) {
    let seg = bar.segments[0];
    for (const s of bar.segments) {
        if (s.tick <= tick) seg = s;
    }
    return seg.ms + (tick - seg.tick) * 60000 / (seg.tempo * TICKS_PER_QUARTER);
}

/** Expands `timeline.bars` into a grid of `{ barIdx, barIndex, occurrence, tick, scoreMs, isBarStart }`. */
/** The ticks of one beat in a bar: a dotted quarter in a compound meter (6/8, 9/8, 12/8, 15/8), else the denominator note. */
function beatTicks(bar) {
    const { num, den } = bar;
    if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return TICKS_PER_QUARTER;
    if (den === 8 && num >= 6 && num % 3 === 0) return TICKS_PER_QUARTER * 1.5;
    return TICKS_PER_QUARTER * 4 / den;
}

function buildScoreGrid(timeline, fixedTicks) {
    const grid = [];
    timeline.bars.forEach((bar, barIdx) => {
        const unitTicks = fixedTicks === 'meter' ? beatTicks(bar) : fixedTicks;
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
 * When `isSysStart` is provided, penalizes matching a PDF system start to a non-bar-start in `grid`.
 * Returns an array `map[pIdx] = sIdx` (or -1 if skipped), or null if lengths are incompatible.
 */
function alignSequences(times, grid, isSysStart = null) {
    const N = times.length;
    const M = grid.length;
    if (N < 4 || M < 4) return null;
    if (N < M * 0.5 || N > M * 1.25) return null;

    const band = Math.max(MAX_DP_BAND, Math.abs(M - N) + 16);
    const INF = 1e9;
    // Flat Float64Array per row would be tiny; band-offset rows keep memory O(N * band)
    const rowWidth = 2 * band + 1;
    const dp = new Float64Array(N * rowWidth).fill(INF);
    const parent = new Int16Array(N * rowWidth); // 1 = diag, 2 = left (skip S), 3 = up (skip P), 4 + k = one long step taking k PDF points

    // A score step far longer than the PDF's usual beat (a slow fade-in bar written at a crawl) stands for several PDF points
    const gaps = [];
    for (let i = 1; i < N; i++) gaps.push(times[i] - times[i - 1]);
    gaps.sort((a, b) => a - b);
    const medianGap = gaps[Math.floor(gaps.length / 2)] || 0;

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
    for (let i = 1; i < Math.min(N, band + 1); i++) {
        const idx = cellIdx(i, 0);
        if (idx >= 0) dp[idx] = pdfStartSkipCost(i);
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
                    const sysPen = isSysStart?.[i] && !grid[j].isBarStart ? SYS_BREAK_OFF_BAR_PENALTY : 0;
                    const cost = dp[diagIdx] + stepCost + sysPen;
                    if (cost < best) { best = cost; bestOp = 1; }
                    if (medianGap > 0 && ds > medianGap * LONG_STEP_RATIO) {
                        for (let k = 2; k <= MAX_LONG_STEP_POINTS && k <= i; k++) {
                            const fromIdx = cellIdx(i - k, j - 1);
                            if (fromIdx < 0) continue;
                            const e = Math.abs((times[i] - times[i - k]) / ds - 1);
                            if (e > LONG_STEP_MAX_ERROR) continue;
                            const longCost = dp[fromIdx] + e * LONG_STEP_ERROR_WEIGHT + LONG_STEP_COST;
                            if (longCost < best) { best = longCost; bestOp = 3 + k; }
                        }
                    }
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
        } else if (op > 3) {
            map[i] = j;
            i -= op - 3;
            j--;
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

/** Sorts valid PDF points and detects system-start indices when page/y layout is present. */
function extractPdfFeatures(pdfPoints) {
    const sorted = [...pdfPoints]
        .filter(p => Number.isFinite(p?.timeMs) && p.timeMs >= 0)
        .sort((a, b) => a.timeMs - b.timeMs);
    const times = sorted.map(p => p.timeMs);
    const hasLayout = sorted.some(p => Number.isFinite(p.page) || Number.isFinite(p.y));
    const isSysStart = hasLayout
        ? sorted.map((p, i) => i === 0 || p.page !== sorted[i - 1].page || Math.abs((p.y ?? 0) - (sorted[i - 1].y ?? 0)) > 0.01)
        : null;
    return { times, isSysStart };
}

function scoreMsToTimeMs(anchors, scoreMs) {
    if (!anchors.length) return scoreMs;
    if (scoreMs <= anchors[0].scoreMs) {
        if (anchors.length >= 2) {
            const rate = (anchors[1].timeMs - anchors[0].timeMs) / Math.max(1, anchors[1].scoreMs - anchors[0].scoreMs);
            return anchors[0].timeMs + (scoreMs - anchors[0].scoreMs) * rate;
        }
        return anchors[0].timeMs + (scoreMs - anchors[0].scoreMs);
    }
    for (let i = 1; i < anchors.length; i++) {
        if (scoreMs <= anchors[i].scoreMs) {
            const a = anchors[i - 1];
            const b = anchors[i];
            const frac = (scoreMs - a.scoreMs) / Math.max(1, b.scoreMs - a.scoreMs);
            return a.timeMs + frac * (b.timeMs - a.timeMs);
        }
    }
    const last = anchors[anchors.length - 1];
    return last.timeMs + (scoreMs - last.scoreMs);
}

/**
 * Scores how well a candidate `points` alignment places the GP score's early notes against `audioOnsets`.
 * Returns a value in roughly [-1, 1]; higher means better onset match and smaller initial silence mismatch.
 */
function scoreAudioOnsetAlignment(timeline, points, noteScoreTimesMs, audioOnsets) {
    if (!audioOnsets?.times?.length || !noteScoreTimesMs?.length || !points.length) return 0;
    const barByKey = new Map(timeline.bars.map(b => [`${b.barIndex}:${b.occurrence}`, b]));
    const anchors = points
        .map(p => ({ scoreMs: barByKey.get(`${p.barIndex}:${p.occurrence || 0}`)?.startMs, timeMs: p.timeMs }))
        .filter(a => Number.isFinite(a.scoreMs))
        .sort((a, b) => a.scoreMs - b.scoreMs);
    if (!anchors.length) return 0;

    const sample = noteScoreTimesMs.slice(0, 40);
    let hits = 0;
    for (const sMs of sample) {
        const predMs = scoreMsToTimeMs(anchors, sMs);
        if (predMs >= -ONSET_MATCH_WINDOW_MS && nearestOnset(audioOnsets, predMs, ONSET_MATCH_WINDOW_MS)) hits++;
    }
    const hitRate = hits / sample.length;

    const predFirstMs = scoreMsToTimeMs(anchors, sample[0]);
    const firstAudioMs = audioOnsets.times[0];
    const firstGapMs = Math.abs(firstAudioMs - predFirstMs);
    const gapPenalty = firstGapMs > 250 ? Math.min(1, (firstGapMs - 250) / 1500) : 0;

    return hitRate - gapPenalty;
}

function evaluateAlignment(timeline, times, grid, isSysStart, unitName, totalSteps) {
    const map = alignSequences(times, grid, isSysStart);
    if (!map) return null;

    const points = extractBarPoints(timeline, times, grid, map);
    if (points.length < timeline.bars.length * 0.8) return null;

    const fit = syncFit(timeline, points);
    const maxFlagged = Math.max(1, Math.floor(timeline.bars.length * MAX_FLAGGED_SHARE));
    if (!fit || fit.flagged > maxFlagged || fit.tempoSpread > 0.2) return null;

    let matchedSteps = 0;
    for (let k = 0; k < map.length; k++) {
        if (map[k] >= 0) matchedSteps++;
    }

    const score = fit.placed * 10 - fit.flagged * 30 - fit.tempoSpread * 100 - Math.abs(times.length - grid.length) * 0.05;
    return {
        score,
        result: { points, fit, unit: unitName, matchedSteps, totalSteps },
    };
}

/**
 * Infers GP bar sync points from PDF sync points against a score `timeline`.
 *
 * @param {object} timeline result of `buildScoreTimeline(playedBars)`
 * @param {Array<{timeMs:number, page?:number, x?:number, y?:number}>} pdfPoints PDF sync points (will be sorted by `timeMs`)
 * @param {{ audioOnsets?: { times: number[] } | null, noteScoreTimesMs?: number[] | null }} [options]
 * @returns {{ points: Array, fit: object, unit: string, matchedSteps: number, totalSteps: number } | null}
 */
export function inferBarSyncFromPdf(timeline, pdfPoints, options = {}) {
    if (!timeline?.bars?.length || !Array.isArray(pdfPoints) || pdfPoints.length < 4) return null;
    const { times, isSysStart } = extractPdfFeatures(pdfPoints);
    if (!isRegularGrid(times)) return null;

    let best = null;
    let bestGrid = null;
    let bestUnit = null;
    for (const unit of CANDIDATE_UNITS) {
        const grid = buildScoreGrid(timeline, unit.ticks);
        const candidate = evaluateAlignment(timeline, times, grid, isSysStart, unit.name, grid.length);
        if (!candidate) continue;
        if (!best || candidate.score > best.score) {
            best = candidate;
            bestGrid = grid;
            bestUnit = unit;
        }
    }

    if (!best) return null;

    const { audioOnsets = null, noteScoreTimesMs = null } = options || {};
    if (audioOnsets?.times?.length && noteScoreTimesMs?.length && bestGrid) {
        const stepsPerBar0 = bestUnit.ticks === null
            ? 1
            : bestUnit.ticks === 'meter'
                ? Math.max(1, bestGrid.filter((g) => g.barIdx === 0).length)
                : Math.max(1, Math.round((timeline.bars[0].endTick - timeline.bars[0].startTick) / bestUnit.ticks));

        let bestAudioScore = best.score + scoreAudioOnsetAlignment(timeline, best.result.points, noteScoreTimesMs, audioOnsets) * 150;
        let bestResult = best.result;

        const shifts = new Set();
        for (let k = 1; k <= MAX_BAR_SHIFTS; k++) { shifts.add(k * stepsPerBar0); shifts.add(-k * stepsPerBar0); }
        for (let k = 1; k <= MAX_STEP_SHIFT; k++) { shifts.add(k); shifts.add(-k); }
        for (const signedShift of shifts) {
            const shiftBars = Math.sign(signedShift);
            const stepShift = Math.abs(signedShift);
            const shiftedTimes = shiftBars > 0 ? times.slice(stepShift) : times;
            const shiftedSys = shiftBars > 0 && isSysStart ? isSysStart.slice(stepShift) : isSysStart;
            const shiftedGrid = shiftBars < 0 ? bestGrid.slice(stepShift) : bestGrid;
            const cand = evaluateAlignment(timeline, shiftedTimes, shiftedGrid, shiftedSys, bestUnit.name, bestGrid.length);
            if (!cand) continue;
            const totalScore = cand.score + scoreAudioOnsetAlignment(timeline, cand.result.points, noteScoreTimesMs, audioOnsets) * 150;
            if (totalScore > bestAudioScore) {
                bestAudioScore = totalScore;
                bestResult = cand.result;
            }
        }
        return bestResult;
    }

    return best.result;
}
