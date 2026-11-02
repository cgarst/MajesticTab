// Run with: node --test tests/audioSync/pointCheck.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePoints, pointProblems } from '../../src/audioSync/pointCheck.js';
import { buildScoreTimeline } from '../../src/audioSync/scorePositions.js';

// Bars 0 1 2 1 2 3 played, 2000 ms each at 120 bpm.
const bar = (barIndex, i, tempoChanges = []) => ({ barIndex, start: i * 3840, end: (i + 1) * 3840, tempoChanges });
const tl = buildScoreTimeline([bar(0, 0, [{ tick: 0, tempo: 120 }]), bar(1, 1), bar(2, 2), bar(1, 3), bar(2, 4), bar(3, 5)]);
const P = (id, barIndex, timeMs, extra = {}) => ({ id, barIndex, occurrence: 0, pos: 0, timeMs, ...extra });

test('resolvePoints maps to score time, sorts by recording time and drops unplayed passes', () => {
    const r = resolvePoints(tl, [P('b', 1, 5000), P('a', 0, 1000), P('x', 3, 9000, { occurrence: 2 })]);
    assert.deepEqual(r.map(p => [p.id, p.scoreMs]), [['a', 0], ['b', 2000]]);
});

test('clean points have no flags and give segment tempos', () => {
    const { flags, tempos } = pointProblems(tl, [P('a', 0, 1000), P('b', 1, 3000), P('c', 2, 7000)]);
    assert.deepEqual(flags, {});
    assert.equal(tempos.a, undefined);
    assert.equal(tempos.b.bpm, 120);
    assert.equal(tempos.c.bpm, 60);
});

test('flags missing, out of order and implausible tempo; order problems get no tempo', () => {
    const { flags, tempos } = pointProblems(tl, [
        P('a', 0, 1000),
        P('b', 3, 3000),                       // bar 3 at 3 s...
        P('c', 1, 4000),                       // ...then an earlier bar later in the recording
        P('d', 3, 9000, { occurrence: 5 }),    // not played
        P('e', 2, 4100)                        // 8x faster than written
    ]);
    assert.equal(flags.d, 'missing');
    assert.equal(flags.c, 'order');
    assert.equal(tempos.c, undefined);
    assert.ok(flags.b === 'tempo' || flags.e === 'tempo');
});
