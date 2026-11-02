// Run with: node --test tests/audioSync/follower.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFollower } from '../../src/audioSync/follower.js';
import { buildScoreTimeline } from '../../src/audioSync/scorePositions.js';

// 4 bars of 3840 ticks at 120 bpm = 2000 ms each.
const timeline = buildScoreTimeline([0, 1, 2, 3].map(i => ({ barIndex: i, start: i * 3840, end: (i + 1) * 3840, tempoChanges: i ? [] : [{ tick: 0, tempo: 120 }] })));
// Recording starts the score at 1000 ms and runs twice as slow after bar 1 (4000 ms for bar 1).
const points = [{ id: 'a', scoreMs: 0, timeMs: 1000 }, { id: 'b', scoreMs: 2000, timeMs: 3000 }, { id: 'c', scoreMs: 4000, timeMs: 7000 }];

function make(extra = {}) {
    const ticks = [];
    const src = { getTimeMs: () => 0, isBuffering: () => false };
    const f = createFollower({ source: src, getPoints: () => points, timeline, setTick: t => ticks.push(t), ...extra });
    return { f, ticks, src };
}

test('maps recording time to playback ticks through the points', () => {
    const { f, ticks } = make();
    f.step(1000); f.step(3000); f.step(5000); f.step(7000);
    assert.deepEqual(ticks, [0, 3840, 3840 + 1920, 2 * 3840]);
});

test('only sets the tick when the beat changes', () => {
    const { f, ticks } = make({ snapToBeat: t => Math.floor(t / 960) * 960 });
    f.step(1000); f.step(1100); f.step(1400);
    assert.deepEqual(ticks, [0]);
    f.step(1600);
    assert.deepEqual(ticks, [0, 960]);
});

test('skips while buffering and applies the output latency', () => {
    const { f, ticks, src } = make({ getLatencyMs: () => 500 });
    src.isBuffering = () => true;
    assert.equal(f.step(3000), null);
    src.isBuffering = () => false;
    f.step(3000); // heard 2500: halfway through the first bar, 750 ms into the 2000 ms before point b -> tick 1.5 * 1920
    assert.deepEqual(ticks, [Math.round(1920 * (1500 / 2000) * 2)]);
});

test('refresh re-applies the same tick; start and stop drive the scheduler', () => {
    const { f, ticks, src } = make();
    f.step(1000); f.step(1000);
    assert.equal(ticks.length, 1);
    f.refresh(); f.step(1000);
    assert.equal(ticks.length, 2);

    let queued = null; let cancelled = 0;
    let t = 1000; src.getTimeMs = () => t;
    const loop = createFollower({
        source: src, getPoints: () => points, timeline, setTick: x => ticks.push(x),
        schedule: cb => { queued = cb; return 7; }, cancel: () => { cancelled++; }
    });
    loop.start();
    assert.ok(loop.running);
    queued(); t = 3000; queued();
    assert.equal(ticks.at(-1), 3840);
    loop.stop();
    assert.equal(cancelled, 1);
    assert.ok(!loop.running);
});
