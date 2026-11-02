// timelineModel.js
// The geometry of the sync timeline, without any drawing: where each point sits along the axis, the segments between
// points with their implied tempo, the stretches that have no points, and how to turn a position on the axis back into
// a time. Positions are fractions of the axis, 0 to 1. The axis is either the score's bars as played ('bars': every
// bar gets the same width, repeats included) or the recording's time ('media'). Pure; unit tested in
// tests/audioSync/timelineModel.test.mjs.

import { pointProblems, resolvePoints } from './pointCheck.js';
import { mediaToScore, scoreToMedia } from './syncMap.js';

/** A stretch of at least this many bars without a point is shown as uncovered. */
export const GAP_BARS = 8;
export const SHORT_SEGMENT_MS = 200;
export const LONG_SEGMENT_MS = 120000;
const TAIL_MS = 5000;

/** Fractional index into the played bars for a time on the score's written timeline (bars have equal width). */
function barFraction(bars, scoreMs) {
    if (!bars.length) return 0;
    if (scoreMs <= bars[0].startMs) return 0;
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (bars[mid].startMs <= scoreMs) lo = mid; else hi = mid - 1;
    }
    const bar = bars[lo];
    const span = bar.endMs - bar.startMs;
    return lo + (span > 0 ? Math.min(1, (scoreMs - bar.startMs) / span) : 0);
}

function scoreMsFromBarFraction(bars, fraction) {
    if (!bars.length) return 0;
    const i = Math.min(bars.length - 1, Math.max(0, Math.floor(fraction)));
    const bar = bars[i];
    return bar.startMs + Math.min(1, Math.max(0, fraction - i)) * (bar.endMs - bar.startMs);
}

/**
 * @param {object} opts
 * @param {object} opts.timeline from `buildScoreTimeline`
 * @param {Array} opts.points stored points (`{ id, barIndex, occurrence, pos, timeMs, source }`)
 * @param {'bars'|'media'} opts.axis
 * @param {number|null} opts.durationMs length of the recording, when known
 */
export function buildTimelineModel({ timeline, points, axis, durationMs = null }) {
    const bars = timeline.bars;
    const total = bars.length || 1;
    const resolved = resolvePoints(timeline, points);
    const { flags, tempos } = pointProblems(timeline, points);
    const byId = new Map(points.map(p => [p.id, p]));
    const maxMedia = Math.max(durationMs || 0, (resolved.at(-1)?.timeMs || 0) + TAIL_MS, 1);

    const fractions = resolved.map(p => barFraction(bars, p.scoreMs));
    const xs = resolved.map((p, i) => (axis === 'bars' ? fractions[i] / total : p.timeMs / maxMedia));

    const markers = resolved.map((p, i) => ({
        id: p.id, x: xs[i], timeMs: p.timeMs, scoreMs: p.scoreMs, barFraction: fractions[i],
        source: byId.get(p.id)?.source || 'manual', flag: flags[p.id] || null
    }));

    const segments = [];
    for (let i = 1; i < resolved.length; i++) {
        const id = resolved[i].id;
        const t = tempos[id];
        const duration = resolved[i].timeMs - resolved[i - 1].timeMs;
        let flag = flags[id] === 'order' || flags[id] === 'tempo' ? flags[id] : null;
        if (!flag && duration < SHORT_SEGMENT_MS) flag = 'short';
        else if (!flag && duration > LONG_SEGMENT_MS) flag = 'long';
        segments.push({ fromId: resolved[i - 1].id, toId: id, x0: xs[i - 1], x1: xs[i], ratio: t?.ratio ?? null, bpm: t?.bpm ?? null, flag });
    }

    // Coverage follows the points that are in order; a stray point would only make false jumps back and forth
    const chain = resolved.map((p, i) => i).filter(i => flags[resolved[i].id] !== 'order');
    const gaps = [];
    if (!chain.length) {
        gaps.push({ x0: 0, x1: 1, bars: bars.length });
    } else {
        const first = chain[0];
        if (fractions[first] > 1) gaps.push({ x0: 0, x1: xs[first], bars: Math.round(fractions[first]) });
        for (let k = 1; k < chain.length; k++) {
            const a = chain[k - 1];
            const b = chain[k];
            if (fractions[b] - fractions[a] > GAP_BARS) gaps.push({ x0: xs[a], x1: xs[b], bars: Math.round(fractions[b] - fractions[a]) });
        }
        const last = chain.at(-1);
        const rest = bars.length - fractions[last];
        if (rest > 1) gaps.push({ x0: xs[last], x1: 1, bars: Math.round(rest) });
    }

    const placed = resolved; // points the score can place; the rest (a pass that isn't played) are not drawn
    return {
        axis, markers, segments, gaps, maxMedia, totalBars: bars.length,
        unplaced: points.length - resolved.length,
        /** Recording time at a position on the axis. */
        xToMediaMs(x) {
            if (axis === 'media') return Math.max(0, x * maxMedia);
            return Math.max(0, scoreToMedia(placed, scoreMsFromBarFraction(bars, x * total)));
        },
        /** Written score time at a position on the axis. */
        xToScoreMs(x) {
            if (axis === 'bars') return scoreMsFromBarFraction(bars, x * total);
            return Math.max(0, mediaToScore(placed, x * maxMedia));
        },
        /** Position on the axis of a recording time (for the playhead). */
        mediaMsToX(ms) {
            if (axis === 'media') return Math.min(1, Math.max(0, ms / maxMedia));
            return Math.min(1, Math.max(0, barFraction(bars, mediaToScore(placed, ms)) / total));
        }
    };
}
