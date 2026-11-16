// Run with: node --test tests/fitBarPoints.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitBarPoints } from '../src/audioSync/fitBarPoints.js';

const played = (order) => { const seen = {}; return order.map((barIndex) => ({ barIndex, occurrence: seen[barIndex] = (seen[barIndex] ?? -1) + 1 })); };
const pts = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, barIndex: i, occurrence: 0, pos: 0, timeMs: 1000 + i * 3000, source: 'manual' }));

test('points from a layout without the repeat land on the repeat score\'s second pass', () => {
    const score = played([0, 1, 0, 1, 2, 3]); // bars 0-1 repeated, 4 bars written
    const r = fitBarPoints(pts(6), score);
    assert.equal(r.moved, true);
    assert.deepEqual(r.points.map(p => [p.barIndex, p.occurrence]), [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [3, 0]]);
    assert.deepEqual(r.points.map(p => p.timeMs), pts(6).map(p => p.timeMs));
    assert.equal(r.points[2].id, 'p2');
});

test('a longer list leaves the trailing points out', () => {
    const r = fitBarPoints(pts(7), played([0, 1, 0, 1, 2, 3]));
    assert.equal(r.points.length, 6);
    assert.equal(r.dropped, 1);
});

test('points that already fit the score stay', () => {
    const score = played([0, 1, 0, 1, 2, 3]);
    const own = fitBarPoints(pts(6), score).points;
    assert.equal(fitBarPoints(own, score).moved, false);
    assert.equal(fitBarPoints(pts(4), played([0, 1, 2, 3])).moved, false);
});

test('a first-pass list on a score with repeats stays', () => {
    assert.equal(fitBarPoints(pts(4), played([0, 1, 0, 1, 2, 3])).moved, false);
});

test('a count that matches nothing stays', () => {
    assert.equal(fitBarPoints(pts(5), played([0, 1, 0, 1, 2, 3])).moved, false);
});
