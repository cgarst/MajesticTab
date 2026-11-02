// Run with: node --test tests/audioSync/syncMap.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    validatePoints, hasOrderProblems, mediaToScore, scoreToMedia, segmentTempos, withPoint
} from '../../src/audioSync/syncMap.js';

const pts = [
    { id: 'a', scoreMs: 0, timeMs: 1000 },
    { id: 'b', scoreMs: 2000, timeMs: 3000 },   // steady
    { id: 'c', scoreMs: 4000, timeMs: 7000 },   // recording twice as slow
];

test('maps linearly inside a segment and round-trips', () => {
    assert.equal(mediaToScore(pts, 2000), 1000);
    assert.equal(mediaToScore(pts, 5000), 3000);
    assert.equal(scoreToMedia(pts, 3000), 5000);
    for (const t of [1000, 1234, 3000, 6999]) {
        assert.ok(Math.abs(scoreToMedia(pts, mediaToScore(pts, t)) - t) < 1e-9);
    }
});

test('extrapolates 1:1 before the first and after the last point', () => {
    assert.equal(mediaToScore(pts, 500), -500);
    assert.equal(mediaToScore(pts, 8000), 5000);
    assert.equal(scoreToMedia(pts, -100), 900);
    assert.equal(scoreToMedia(pts, 4500), 7500);
});

test('exact point positions map exactly', () => {
    for (const p of pts) {
        assert.equal(mediaToScore(pts, p.timeMs), p.scoreMs);
        assert.equal(scoreToMedia(pts, p.scoreMs), p.timeMs);
    }
});

test('no points is the identity; one point is a pure offset', () => {
    assert.equal(mediaToScore([], 1234), 1234);
    assert.equal(mediaToScore([pts[0]], 3000), 2000);
    assert.equal(scoreToMedia([pts[0]], 2000), 3000);
});

test('validation flags order problems and tempo outliers', () => {
    assert.deepEqual(validatePoints(pts), []);
    const reordered = [pts[0], { id: 'x', scoreMs: -5, timeMs: 2000 }];
    assert.equal(validatePoints(reordered)[0].code, 'order');
    assert.ok(hasOrderProblems(reordered));
    const dup = [pts[0], { id: 'y', scoreMs: 0, timeMs: 2000 }];
    assert.ok(hasOrderProblems(dup));
    const wild = [pts[0], { id: 'z', scoreMs: 100000, timeMs: 2000 }];
    assert.equal(validatePoints(wild)[0].code, 'tempo');
    assert.ok(!hasOrderProblems(wild));
});

test('segment tempos give ratio and implied bpm', () => {
    const [s1, s2] = segmentTempos(pts, 120);
    assert.equal(s1.ratio, 1);
    assert.equal(s1.bpm, 120);
    assert.equal(s2.ratio, 0.5);
    assert.equal(s2.bpm, 60);
    assert.equal(segmentTempos(pts, 0)[0].bpm, null);
});

test('withPoint keeps order and replaces by id', () => {
    const next = withPoint(pts, { id: 'm', scoreMs: 1000, timeMs: 2000 });
    assert.deepEqual(next.map(p => p.id), ['a', 'm', 'b', 'c']);
    const moved = withPoint(next, { id: 'm', scoreMs: 1000, timeMs: 2500 });
    assert.equal(moved.length, 4);
    assert.equal(moved[1].timeMs, 2500);
});
