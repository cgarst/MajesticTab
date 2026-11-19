// Run with: node --test tests/audioSync/looseAnchors.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { addAnchor, estimatePoints } from '../../src/audioSync/looseAnchors.js';
import { mediaToScore } from '../../src/audioSync/syncMap.js';

test('with no anchors the estimate lays the recording over the score from end to end', () => {
    const pts = estimatePoints([], 90000, 240000);
    assert.equal(mediaToScore(pts, 45000), 120000);
});

test('an anchor bends the estimate through it', () => {
    const pts = estimatePoints([{ timeMs: 10000, scoreMs: 60000 }], 90000, 240000);
    assert.equal(mediaToScore(pts, 10000), 60000);
    assert.ok(mediaToScore(pts, 50000) > 60000 && mediaToScore(pts, 50000) < 240000);
});

test('a new anchor drops the ones it contradicts and keeps the rest in order', () => {
    let list = addAnchor([], { timeMs: 10000, scoreMs: 30000 });
    list = addAnchor(list, { timeMs: 50000, scoreMs: 150000 });
    list = addAnchor(list, { timeMs: 30000, scoreMs: 20000 }); // later in time but earlier in the score than the first
    assert.deepEqual(list.map((a) => a.timeMs), [30000, 50000]);
});

test('an end that disagrees with the anchors is left out', () => {
    const pts = estimatePoints([{ timeMs: 95000, scoreMs: 100000 }], 90000, 240000);
    assert.equal(pts[pts.length - 1].timeMs, 95000);
});
