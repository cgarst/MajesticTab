// Run with: node --test tests/audioSync/timelineModel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimelineModel, GAP_BARS } from '../../src/audioSync/timelineModel.js';
import { buildScoreTimeline } from '../../src/audioSync/scorePositions.js';

// 20 bars of 2000 ms each at 120 bpm, no repeats.
const bar = (barIndex, i, tempoChanges = []) => ({ barIndex, start: i * 3840, end: (i + 1) * 3840, tempoChanges });
const timeline = buildScoreTimeline(Array.from({ length: 20 }, (_, i) => bar(i, i, i ? [] : [{ tick: 0, tempo: 120 }])));
const P = (id, barIndex, timeMs, extra = {}) => ({ id, barIndex, occurrence: 0, pos: 0, timeMs, source: 'tap', ...extra });

test('points sit at their bar on the bars axis and at their time on the media axis', () => {
    const pts = [P('a', 0, 1000), P('b', 5, 11000), P('c', 10, 20000)];
    const bars = buildTimelineModel({ timeline, points: pts, axis: 'bars' });
    assert.deepEqual(bars.markers.map(m => m.x), [0, 5 / 20, 10 / 20]);
    const media = buildTimelineModel({ timeline, points: pts, axis: 'media', durationMs: 40000 });
    assert.deepEqual(media.markers.map(m => m.x), [1000 / 40000, 11000 / 40000, 20000 / 40000]);
    assert.equal(media.maxMedia, 40000);
    // with no known length, the axis runs a little past the last point
    assert.equal(buildTimelineModel({ timeline, points: pts, axis: 'media' }).maxMedia, 25000);
});

test('segments carry the implied tempo and a flag for odd ones', () => {
    const pts = [P('a', 0, 0), P('b', 5, 10000), P('c', 10, 12500), P('d', 11, 12600), P('e', 12, 200000)];
    const m = buildTimelineModel({ timeline, points: pts, axis: 'bars' });
    assert.equal(m.segments[0].ratio, 1);          // 5 bars (10 s) in 10 s
    assert.equal(m.segments[0].flag, null);
    assert.equal(m.segments[1].ratio, 4);          // 10 s in 2.5 s: fast, but inside the 0.25x to 4x range
    assert.equal(m.segments[1].flag, null);
    assert.equal(m.segments[2].flag, 'tempo');     // 2 s in 100 ms is 20x
    assert.equal(m.segments[3].flag, 'tempo');     // 2 s in 187 s is far too slow
});

test('a plausible segment that is very short or very long gets its own flag', () => {
    // 100 ms of written time (half a bar's 5%) in 100 ms is 1x, but the segment is shorter than 200 ms
    const short = buildTimelineModel({ timeline, points: [P('a', 0, 0), P('b', 0, 100, { pos: 0.05 })], axis: 'media' });
    assert.equal(short.segments[0].ratio, 1);
    assert.equal(short.segments[0].flag, 'short');
    // 3 minutes of recording for 3 minutes of score is fine in tempo but longer than a segment should be
    const longTimeline = buildScoreTimeline(Array.from({ length: 100 }, (_, i) => bar(i, i, i ? [] : [{ tick: 0, tempo: 120 }])));
    const long = buildTimelineModel({ timeline: longTimeline, points: [P('a', 0, 0), P('b', 99, 198000)], axis: 'media' });
    assert.equal(long.segments[0].flag, 'long');
});

test('an out of order point is flagged and has no tempo', () => {
    const m = buildTimelineModel({ timeline, points: [P('a', 5, 5000), P('b', 2, 9000)], axis: 'bars' });
    assert.equal(m.markers.find(x => x.id === 'b').flag, 'order');
    assert.equal(m.segments[0].ratio, null);
    assert.equal(m.segments[0].flag, 'order');
});

test('uncovered stretches are listed with their size in bars', () => {
    const none = buildTimelineModel({ timeline, points: [], axis: 'bars' });
    assert.deepEqual(none.gaps, [{ x0: 0, x1: 1, bars: 20 }]);
    const m = buildTimelineModel({ timeline, points: [P('a', 3, 3000), P('b', 4, 5000), P('c', 4 + GAP_BARS + 2, 30000)], axis: 'bars' });
    assert.deepEqual(m.gaps.map(g => g.bars), [3, 10, 6]);
    assert.equal(m.gaps[0].x0, 0);
    assert.equal(m.gaps.at(-1).x1, 1);
    // a point on the first bar leaves no gap before it, and a last point on the final bars leaves none after it
    const full = buildTimelineModel({ timeline, points: [P('a', 0, 0), P('b', 19, 38000)], axis: 'bars' });
    assert.deepEqual(full.gaps.map(g => g.bars), [19]);
});

test('a stray out of order point does not make false gaps', () => {
    const pts = [P('a', 0, 0), P('b', 4, 8000), P('stray', 1, 8100), P('c', 8, 16000)];
    const m = buildTimelineModel({ timeline, points: pts, axis: 'bars' });
    assert.equal(m.markers.find(x => x.id === 'stray').flag, 'order');
    assert.deepEqual(m.gaps.map(g => g.bars), [12]);   // only bars 9 to 20 after the last good point
});

test('positions on the axis convert back to times, in both axes', () => {
    const pts = [P('a', 0, 1000), P('b', 10, 31000), P('c', 19, 49000)];
    const bars = buildTimelineModel({ timeline, points: pts, axis: 'bars' });
    // halfway to bar 10 on the bars axis is bar 5, which the points place at 16000 ms
    assert.equal(bars.xToScoreMs(5 / 20), 10000);
    assert.equal(bars.xToMediaMs(5 / 20), 16000);
    assert.ok(Math.abs(bars.mediaMsToX(16000) - 5 / 20) < 1e-9);
    const media = buildTimelineModel({ timeline, points: pts, axis: 'media', durationMs: 60000 });
    assert.equal(media.xToMediaMs(0.5), 30000);
    assert.equal(media.mediaMsToX(15000), 0.25);
    assert.ok(Math.abs(media.xToScoreMs(31000 / 60000) - 20000) < 1e-6);
});

test('points whose pass is not played are counted, not drawn', () => {
    const m = buildTimelineModel({ timeline, points: [P('a', 0, 0), P('x', 3, 5000, { occurrence: 4 })], axis: 'bars' });
    assert.equal(m.markers.length, 1);
    assert.equal(m.unplaced, 1);
});
