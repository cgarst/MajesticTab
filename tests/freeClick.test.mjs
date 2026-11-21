// Run: node tests/freeClick.test.mjs
import assert from 'node:assert/strict';
import { clampBpm, firstBeatAtOrAfter, isAccent, bpmFromTaps, phaseForTap, BPM_MIN, BPM_MAX, BPM_DEFAULT } from '../src/utils/freeClick.js';

assert.equal(clampBpm(10), BPM_MIN);
assert.equal(clampBpm(999), BPM_MAX);
assert.equal(clampBpm(96.4), 96);
assert.equal(clampBpm('x'), BPM_DEFAULT);

// Beats of a 600 ms grid starting at 100 ms
assert.equal(firstBeatAtOrAfter(100, 100, 600), 0, 'on the first beat');
assert.equal(firstBeatAtOrAfter(101, 100, 600), 1, 'just after it, the next one');
assert.equal(firstBeatAtOrAfter(0, 100, 600), 0, 'before the grid, its first beat');
assert.equal(firstBeatAtOrAfter(-900, 100, 600), -1, 'a seek before the start still lands on a grid beat');

assert.equal(isAccent(0, 4), true);
assert.equal(isAccent(3, 4), false);
assert.equal(isAccent(4, 4), true);
assert.equal(isAccent(-4, 4), true, 'negative beats count back from the bar line');
assert.equal(isAccent(-1, 4), false);

assert.equal(bpmFromTaps([0]), null, 'one tap is not a tempo');
assert.equal(bpmFromTaps([0, 500]), 120);
assert.equal(bpmFromTaps([0, 600, 1200, 1800]), 100);
assert.equal(bpmFromTaps([0, 1000, 1500, 2000, 2500, 3000, 3500]), 120, 'only the last taps count');

assert.equal(phaseForTap(1250, 600), 50);
assert.equal(phaseForTap(600, 600), 0);
assert.equal(phaseForTap(-50, 600), 550);
console.log('freeClick ok');
