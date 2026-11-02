// Run with: node --test tests/audioSync/refine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOnsets, nearestOnset } from '../../src/audioSync/onsets.js';
import { nudgePoint, movePoint, wholeBarRange, retapWindow } from '../../src/audioSync/refine.js';
import { buildScoreTimeline } from '../../src/audioSync/scorePositions.js';

// Deterministic noise so the test is repeatable
function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5 >>> 0) / 2 ** 32) * 2 - 1;
}

function clickTrack(hitsMs, { sampleRate = 22050, seconds = 4, noise = 0.003 } = {}) {
    const data = new Float32Array(sampleRate * seconds);
    const r = rng(7);
    for (let i = 0; i < data.length; i++) data[i] = r() * noise;
    for (const t of hitsMs) {
        const start = Math.round(t / 1000 * sampleRate);
        for (let i = 0; i < sampleRate * 0.04; i++) {
            const env = Math.exp(-i / (sampleRate * 0.008));
            if (start + i < data.length) data[start + i] += env * 0.8 * Math.sin(i * 2 * Math.PI * 800 / sampleRate);
        }
    }
    return [data];
}

test('onsets are found where the hits start', () => {
    const hits = [500, 1000, 1480, 2300, 3200];
    const { times } = computeOnsets(clickTrack(hits), 22050);
    assert.equal(times.length, hits.length, `found ${times}`);
    hits.forEach((h, i) => assert.ok(Math.abs(times[i] - h) <= 8, `hit ${h} found at ${times[i]}`));
});

test('a quiet recording or a steady tone has no onsets', () => {
    assert.deepEqual(computeOnsets([new Float32Array(44100)], 22050).times, []);
    const tone = new Float32Array(22050 * 2).map((_, i) => 0.3 * Math.sin(i * 2 * Math.PI * 440 / 22050));
    assert.deepEqual(computeOnsets([tone], 22050).times, []);
    assert.deepEqual(computeOnsets([], 22050).times, []);
});

test('hits closer than 30 ms count once', () => {
    const { times } = computeOnsets(clickTrack([1000, 1015]), 22050);
    assert.equal(times.length, 1);
});

test('nearestOnset picks the closest hit inside the window', () => {
    const onsets = { times: [500, 1000, 1480], strengths: [1, 1, 1] };
    assert.deepEqual(nearestOnset(onsets, 1040), { timeMs: 1000, deltaMs: -40 });
    assert.deepEqual(nearestOnset(onsets, 960), { timeMs: 1000, deltaMs: 40 });
    assert.equal(nearestOnset(onsets, 1200), null);
    assert.deepEqual(nearestOnset(onsets, 1460, 30), { timeMs: 1480, deltaMs: 20 });
    assert.equal(nearestOnset({ times: [], strengths: [] }, 100), null);
});

const P = (id, timeMs) => ({ id, barIndex: 0, occurrence: 0, pos: 0, timeMs });

test('a nudge moves one point and stops short of its neighbours', () => {
    const pts = [P('a', 1000), P('b', 2000), P('c', 3000)];
    assert.equal(nudgePoint(pts, 'b', 10).find(p => p.id === 'b').timeMs, 2010);
    assert.equal(nudgePoint(pts, 'b', -50).find(p => p.id === 'b').timeMs, 1950);
    assert.equal(nudgePoint(pts, 'b', 5000).find(p => p.id === 'b').timeMs, 2999);
    assert.equal(nudgePoint(pts, 'b', -5000).find(p => p.id === 'b').timeMs, 1001);
    assert.equal(nudgePoint(pts, 'a', -5000).find(p => p.id === 'a').timeMs, 0);
    assert.equal(nudgePoint(pts, 'zzz', 10), null);
    assert.equal(nudgePoint([P('a', 0)], 'a', -10), null);          // already at the start
    assert.equal(nudgePoint([P('a', 500), P('b', 501)], 'a', 10), null);   // no room
    assert.equal(pts[1].timeMs, 2000);                              // the input is untouched
});

test('movePoint is a nudge to an absolute time', () => {
    const pts = [P('a', 1000), P('b', 2000), P('c', 3000)];
    assert.equal(movePoint(pts, 'b', 2400).find(p => p.id === 'b').timeMs, 2400);
    assert.equal(movePoint(pts, 'b', 9999).find(p => p.id === 'b').timeMs, 2999);
});

// 10 bars of 2000 ms at 120 bpm
const bar = (barIndex, i) => ({ barIndex, start: i * 3840, end: (i + 1) * 3840, tempoChanges: i ? [] : [{ tick: 0, tempo: 120 }] });
const timeline = buildScoreTimeline(Array.from({ length: 10 }, (_, i) => bar(i, i)));

test('a range widens to whole bars', () => {
    assert.deepEqual(wholeBarRange(timeline, 2500, 6100), { scoreFrom: 2000, scoreTo: 8000 });
    assert.deepEqual(wholeBarRange(timeline, 6100, 2500), { scoreFrom: 2000, scoreTo: 8000 });
    assert.deepEqual(wholeBarRange(timeline, 4000, 8000), { scoreFrom: 4000, scoreTo: 8000 });   // ends on a bar line: stops there
    assert.deepEqual(wholeBarRange(timeline, 4100, 4100), { scoreFrom: 4000, scoreTo: 6000 });
    assert.deepEqual(wholeBarRange(timeline, -50, 1e9), { scoreFrom: 0, scoreTo: 20000 });
    assert.equal(wholeBarRange(buildScoreTimeline([]), 0, 10), null);
});

test('a re-tap replaces the points in the range and says which stretch of the recording to play', () => {
    const resolved = [0, 2000, 4000, 6000, 8000, 10000].map((s, i) => ({ id: `p${i}`, scoreMs: s, timeMs: 1000 + s * 1.1 }));
    const w = retapWindow(resolved, 4000, 8000);
    assert.deepEqual(w.ids, ['p2', 'p3']);                           // 8000 is outside: the range ends before it
    assert.equal(w.mediaFrom, 1000 + 4000 * 1.1);
    assert.equal(w.mediaTo, 1000 + 8000 * 1.1);
    assert.deepEqual(retapWindow(resolved, 20000, 30000).ids, []);
});
