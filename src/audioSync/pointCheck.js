// pointCheck.js
// Resolves stored sync points against a score timeline and checks them. Pure (no DOM or AlphaTab access), so it is
// unit tested in Node (tests/audioSync/pointCheck.test.mjs).

import { positionToScoreMs, tempoAtScoreMs } from './scorePositions.js';
import { validatePoints, segmentTempos } from './syncMap.js';

/** Resolve stored points to `scoreMs`. Points whose bar pass is not played are dropped. */
export function resolvePoints(timeline, stored) {
    return stored
        .map(p => ({ id: p.id, timeMs: p.timeMs, scoreMs: positionToScoreMs(timeline, { barIndex: p.barIndex, occurrence: p.occurrence || 0, pos: p.pos || 0 }) }))
        .filter(p => p.scoreMs !== null)
        .sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Checks stored points against the score. Returns `{ flags, tempos }`: `flags` is `{ [id]: 'missing' | 'order' | 'tempo' }`
 * for points to flag and `tempos` is `{ [id]: { ratio, bpm } }` for the segment ending at each point. A point is
 * `missing` when its bar pass is not played in this score, `order` when it is not after the previous point in both the
 * recording and the score, and `tempo` when its segment implies a tempo far from the written one. A point flagged
 * `order` has no tempo.
 */
export function pointProblems(timeline, stored) {
    const flags = {};
    const resolved = [];
    for (const p of [...stored].sort((a, b) => a.timeMs - b.timeMs)) {
        const [r] = resolvePoints(timeline, [p]);
        if (r) resolved.push(r);
        else flags[p.id] = 'missing';
    }
    for (const problem of validatePoints(resolved)) flags[problem.id] = problem.code;
    const tempos = {};
    resolved.forEach((point, i) => {
        if (!i || flags[point.id] === 'order') return;
        const [seg] = segmentTempos([resolved[i - 1], point], tempoAtScoreMs(timeline, resolved[i - 1].scoreMs));
        tempos[point.id] = { ratio: seg.ratio, bpm: seg.bpm };
    });
    return { flags, tempos };
}
