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

/**
 * How well stored bar points fit the score: how many of the bars it plays they place, how many points are flagged, and
 * how far the tempo they imply strays from the written one. `level` is 'good' (every bar placed, nothing flagged),
 * 'partial' (some bars have no point, nothing flagged), or 'check' (a flagged point, or under 90% of the bars placed).
 * `text` is the sentence the recording row and the sync editor show.
 */
export function syncFit(timeline, stored) {
    const total = timeline?.bars?.length || 0;
    if (!total || !stored?.length) return null;
    const { flags, tempos } = pointProblems(timeline, stored);
    const covered = new Set();
    for (const p of stored) {
        if (positionToScoreMs(timeline, { barIndex: p.barIndex, occurrence: p.occurrence || 0, pos: p.pos || 0 }) !== null) covered.add(`${p.barIndex}:${p.occurrence || 0}`);
    }
    const flagged = Object.keys(flags).length;
    const devs = Object.values(tempos).map(t => Math.abs(t.ratio - 1)).filter(Number.isFinite).sort((a, b) => a - b);
    const tempoSpread = devs.length ? devs[Math.min(devs.length - 1, Math.floor(devs.length * 0.9))] : 0;
    const level = flagged > 0 || covered.size < total * 0.9 ? 'check' : covered.size < total ? 'partial' : 'good';
    const text = `${covered.size} of ${total} bars placed, ${flagged} to check` + (devs.length ? `, tempo within ${Math.max(1, Math.round(tempoSpread * 100))}% of written` : '');
    return { level, placed: covered.size, total, flagged, tempoSpread, text };
}
