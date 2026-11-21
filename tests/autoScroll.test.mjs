// Run: node tests/autoScroll.test.mjs
import assert from 'node:assert/strict';
import { stepPace, formatPace, buildAutoPoints, PACE_STEPS } from '../src/utils/autoScroll.js';

assert.equal(stepPace(1, 1), 1.15);
assert.equal(stepPace(1, -1), 0.9);
assert.equal(stepPace(0.5, -1), 0.5, 'clamped at the slowest');
assert.equal(stepPace(3, 1), 3, 'clamped at the fastest');
assert.equal(stepPace(1.05, 1), 1.15, 'between steps, faster goes to the next one up');
assert.equal(stepPace(1.05, -1), 1, 'between steps, slower goes to the next one down');
for (let i = 1; i < PACE_STEPS.length; i++) assert.ok(PACE_STEPS[i] > PACE_STEPS[i - 1]);

assert.equal(formatPace(1), '1.0×');
assert.equal(formatPace(0.75), '0.75×');
assert.equal(formatPace(1.5), '1.5×');
assert.equal(formatPace(2), '2.0×');

const { points, total } = buildAutoPoints([4, 5, 7], 1000);
assert.deepEqual(points.map((p) => [p.barIndex, p.timeMs]), [[4, 0], [5, 1000], [7, 2000]]);
assert.equal(total, 3000);
assert.deepEqual(buildAutoPoints([], 1000), { points: [], total: 0 });

console.log('autoScroll ok');
