// Run with: node --test tests/readingLine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { positionAt, backJumps, followTarget, glide } from '../src/textSync/readingLine.js';

const units = [0, 1, 2, 4, 5]; // 3 is a separator with no id
const pts = [
    { barIndex: 0, timeMs: 1000 },
    { barIndex: 2, timeMs: 5000 },
    { barIndex: 5, timeMs: 9000 }
];

test('before the first point the line waits at its unit; no points, no line', () => {
    assert.equal(positionAt(pts, units, 500), 0);
    assert.equal(positionAt([{ barIndex: 2, timeMs: 5000 }], units, 0), 2);
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

test('a point that names an unknown unit is ignored', () => {
    assert.equal(positionAt([{ barIndex: 99, timeMs: 0 }], units, 100), null);
});

test('a repeat: the line reads on through its unit, then jumps back at the point', () => {
    const back = [{ barIndex: 4, timeMs: 0 }, { barIndex: 1, timeMs: 1000 }, { barIndex: 2, timeMs: 3000 }];
    assert.equal(positionAt(back, units, 0), 3);
    assert.equal(positionAt(back, units, 500), 3.5);
    assert.ok(positionAt(back, units, 999) < 4);   // never crosses into the next unit
    assert.equal(positionAt(back, units, 1000), 1); // the jump
    assert.equal(positionAt(back, units, 2000), 1.5);
    // a long stretch before the jump: the unit finishes in 20 s, then the line rests at its end
    const long = [{ barIndex: 4, timeMs: 0 }, { barIndex: 0, timeMs: 60000 }];
    assert.ok(positionAt(long, units, 30000) > 3.99 && positionAt(long, units, 30000) < 4);
    assert.equal(positionAt(long, units, 60000), 0);
});

test('backJumps names the points that return to an earlier unit', () => {
    const list = [
        { id: 'a', barIndex: 0, timeMs: 0 }, { id: 'b', barIndex: 2, timeMs: 1000 },
        { id: 'c', barIndex: 0, timeMs: 2000 }, { id: 'd', barIndex: 99, timeMs: 2500 }, { id: 'e', barIndex: 2, timeMs: 3000 }
    ];
    assert.deepEqual([...backJumps(list, units)], ['c']);
    assert.equal(backJumps([], units).size, 0);
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
