// Run with: node --test tests/audioSync/scorePositions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildScoreTimeline, positionToScoreMs, scoreMsToPosition, scoreMsToTick, playedBarsFromLookup
} from '../../src/audioSync/scorePositions.js';
import { createYouTubeSource } from '../../src/audioSync/mediaSource.js';

// 4/4 bars of 3840 ticks at 120 bpm are 2000 ms each. Play order 0 1 2 1 2 3 (bars 1 and 2 repeat once).
const bar = (barIndex, i, tempoChanges = []) => ({ barIndex, start: i * 3840, end: (i + 1) * 3840, tempoChanges });
const played = [bar(0, 0, [{ tick: 0, tempo: 120 }]), bar(1, 1), bar(2, 2), bar(1, 3), bar(2, 4), bar(3, 5)];

test('timeline numbers each pass of a repeated bar', () => {
    const tl = buildScoreTimeline(played);
    assert.deepEqual(tl.bars.map(b => [b.barIndex, b.occurrence]), [[0, 0], [1, 0], [2, 0], [1, 1], [2, 1], [3, 0]]);
    assert.equal(tl.totalMs, 12000);
    assert.equal(positionToScoreMs(tl, { barIndex: 1, occurrence: 0 }), 2000);
    assert.equal(positionToScoreMs(tl, { barIndex: 1, occurrence: 1 }), 6000);
    assert.equal(positionToScoreMs(tl, { barIndex: 1, occurrence: 1, pos: 0.5 }), 7000);
    assert.equal(positionToScoreMs(tl, { barIndex: 3, occurrence: 1 }), null);
});

test('scoreMs maps back to bar, pass and position', () => {
    const tl = buildScoreTimeline(played);
    assert.deepEqual(scoreMsToPosition(tl, 7000), { barIndex: 1, occurrence: 1, pos: 0.5 });
    assert.deepEqual(scoreMsToPosition(tl, -50), { barIndex: 0, occurrence: 0, pos: 0 });
    assert.deepEqual(scoreMsToPosition(tl, 99999), { barIndex: 3, occurrence: 0, pos: 1 });
    assert.equal(scoreMsToPosition(buildScoreTimeline([]), 0), null);
});

test('tempo changes between and inside bars are honoured', () => {
    const tl = buildScoreTimeline([
        bar(0, 0, [{ tick: 0, tempo: 120 }]),
        bar(1, 1, [{ tick: 3840, tempo: 60 }]),                              // bar 1 is 4000 ms
        bar(2, 2, [{ tick: 7680, tempo: 60 }, { tick: 9600, tempo: 120 }])   // half at 60 (2000), half at 120 (1000)
    ]);
    assert.equal(positionToScoreMs(tl, { barIndex: 1 }), 2000);
    assert.equal(positionToScoreMs(tl, { barIndex: 2 }), 6000);
    assert.equal(positionToScoreMs(tl, { barIndex: 2, pos: 0.5 }), 8000);
    assert.equal(positionToScoreMs(tl, { barIndex: 2, pos: 1 }), 9000);
    assert.equal(tl.totalMs, 9000);
    assert.deepEqual(scoreMsToPosition(tl, 8500), { barIndex: 2, occurrence: 0, pos: 0.75 });
});

test('scoreMsToTick gives the expanded playback tick', () => {
    const tl = buildScoreTimeline(played);
    assert.equal(scoreMsToTick(tl, 6000), 3 * 3840);
    assert.equal(scoreMsToTick(tl, 7000), 3 * 3840 + 1920);
    assert.equal(scoreMsToTick(tl, -10), 0);
    assert.equal(scoreMsToTick(tl, 99999), 6 * 3840);
});

test('playedBarsFromLookup reads AlphaTab lookup entries', () => {
    const lookup = { masterBars: [{ masterBar: { index: 4 }, start: 0, end: 10, tempoChanges: [{ tick: 0, tempo: 90, extra: 1 }] }] };
    assert.deepEqual(playedBarsFromLookup(lookup), [{ barIndex: 4, start: 0, end: 10, tempoChanges: [{ tick: 0, tempo: 90 }] }]);
    assert.deepEqual(playedBarsFromLookup(null), []);
});

test('YouTube source adapts the panel control to the MediaSource interface', () => {
    const calls = [];
    let snap = { videoId: 'abc', playing: true, buffering: false, timeSec: 12.5, rate: 1 };
    let listener;
    const src = createYouTubeSource(
        { snapshot: () => snap, seek: t => calls.push(['seek', t]), play: () => calls.push(['play']), pause: () => calls.push(['pause']), setRate: r => calls.push(['rate', r]) },
        cb => { listener = cb; return () => calls.push(['off']); }
    );
    assert.equal(src.kind, 'youtube');
    assert.equal(src.id, 'abc');
    assert.equal(src.getTimeMs(), 12500);
    src.seek(2000); src.setRate(0.75); src.play(); src.pause();
    assert.deepEqual(calls, [['seek', 2], ['rate', 0.75], ['play'], ['pause']]);
    const events = [];
    const off = src.on(e => events.push(e.type));
    listener({ type: 'time' });
    listener({ type: 'rate' });
    off();
    assert.deepEqual(events, ['time', 'rate']);
    snap = { ...snap, buffering: true, playing: false };
    assert.ok(src.isBuffering() && !src.isPlaying());
    assert.equal(src.capabilities.preciseClock, false);
});
