// Run with: node --test tests/readingLine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { positionAt, followTarget, glide } from '../src/textSync/readingLine.js';

const units = [0, 1, 2, 4, 5]; // 3 is a separator with no id
const pts = [
    { barIndex: 0, timeMs: 1000 },
    { barIndex: 2, timeMs: 5000 },
    { barIndex: 5, timeMs: 9000 }
];

test('nothing before the first point', () => {
    assert.equal(positionAt(pts, units, 500), null);
    assert.equal(positionAt([], units, 500), null);
});

test('the line glides between two points at an even pace', () => {
    assert.equal(positionAt(pts, units, 1000), 0);
    assert.equal(positionAt(pts, units, 3000), 1); // halfway from unit 0 to unit 2
    assert.equal(positionAt(pts, units, 5000), 2);
});

test('ranks skip ids that are not units', () => {
    // from unit 2 (rank 2) to unit 5 (rank 4): halfway is rank 3, the unit with id 4
    assert.equal(positionAt(pts, units, 7000), 3);
});

test('after the last point the line crosses that unit over the time left, then rests', () => {
    assert.equal(positionAt(pts, units, 9000, 19000), 4);
    assert.equal(positionAt(pts, units, 14000, 19000), 4.5);
    assert.ok(positionAt(pts, units, 99000, 19000) < 5);
    assert.equal(positionAt(pts, units, 12000), 4); // no recording length: stays at the start
});

test('a point that names an unknown unit is ignored, a point that goes backwards holds', () => {
    assert.equal(positionAt([{ barIndex: 99, timeMs: 0 }], units, 100), null);
    const back = [{ barIndex: 4, timeMs: 0 }, { barIndex: 1, timeMs: 1000 }];
    assert.equal(positionAt(back, units, 500), 3);
});

test('the page follows only when the line leaves the comfortable band', () => {
    const base = { viewH: 1000, scrollTop: 400 };
    assert.equal(followTarget({ ...base, lineY: 700 }), null); // 30% down
    assert.equal(followTarget({ ...base, lineY: 1100 }), 500); // 70% down: bring it back to 60%
    assert.equal(followTarget({ ...base, lineY: 450 }), 250); // 5% down: bring it to 20%
    assert.equal(followTarget({ ...base, lineY: 100, scrollTop: 400 }), 0); // never negative
});

test('the glide is frame-rate independent and lands exactly', () => {
    const once = glide(0, 100, 0.2);
    const twice = glide(glide(0, 100, 0.1), 100, 0.1);
    assert.ok(Math.abs(once - twice) < 1e-9);
    assert.equal(glide(99.8, 100, 0.016), 100);
});
