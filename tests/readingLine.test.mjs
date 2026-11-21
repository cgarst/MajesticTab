// Run with: node --test tests/readingLine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { positionAt, barProgressAt, backJumps, followTarget, glide } from '../src/textSync/readingLine.js';

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

test('barProgressAt interpolates intra-system bar offsets and colFrac across bars', () => {
    const barPts = [
        { id: 'b0', barIndex: '1', barOffset: 0, barCount: 2, colStartFrac: 0, colEndFrac: 0.5, timeMs: 0, endTimeMs: 2000 },
        { id: 'b1', barIndex: '1', barOffset: 1, barCount: 2, colStartFrac: 0.5, colEndFrac: 1.0, timeMs: 2000, endTimeMs: 4000 }
    ];
    const pMidFirst = barProgressAt(barPts, [0, 1], 1000, 4000);
    assert.equal(pMidFirst.unitIndex, 1);
    assert.equal(pMidFirst.barOffset, 0);
    assert.ok(Math.abs(pMidFirst.colFrac - 0.25) < 1e-6);

    const pMidSecond = barProgressAt(barPts, [0, 1], 3000, 4000);
    assert.equal(pMidSecond.barOffset, 1);
    assert.ok(Math.abs(pMidSecond.colFrac - 0.75) < 1e-6);
});

test('backJumps includes 1-bar in-place repeats on the same unit and barOffset', () => {
    const pts = [
        { id: 'p0', barIndex: '5', barOffset: 0, timeMs: 0 },
        { id: 'p1', barIndex: '5', barOffset: 0, timeMs: 2000 }
    ];
    assert.deepEqual([...backJumps(pts, ['5'])], ['p1']);
});

test('note-level points in the same bar advance barFrac/colFrac without triggering repeats', () => {
    const notePts = [
        { id: 'n0', barIndex: '0', barOffset: 0, barCount: 1, colStartFrac: 0.25, colEndFrac: 0.5, barColStartFrac: 0, barColEndFrac: 1, timeMs: 250, endTimeMs: 1250 },
        { id: 'n1', barIndex: '0', barOffset: 0, barCount: 1, colStartFrac: 0.5, colEndFrac: 0.75, barColStartFrac: 0, barColEndFrac: 1, timeMs: 1250, endTimeMs: 2250 },
        { id: 'n2', barIndex: '0', barOffset: 0, barCount: 1, colStartFrac: 0.75, colEndFrac: 1.0, barColStartFrac: 0, barColEndFrac: 1, timeMs: 2250, endTimeMs: 3250 }
    ];
    assert.equal(backJumps(notePts, ['0']).size, 0);
    const p0 = barProgressAt(notePts, ['0'], 250, 3250);
    assert.ok(Math.abs(p0.colFrac - 0.25) < 1e-6);
    assert.ok(Math.abs(p0.barFrac - 0.25) < 1e-6);
    const pMid = barProgressAt(notePts, ['0'], 1750, 3250);
    assert.ok(Math.abs(pMid.colFrac - 0.625) < 1e-6);
    assert.ok(Math.abs(pMid.barFrac - 0.625) < 1e-6);
});


test('the last bar of a staff system keeps the line in that system until the next system starts', () => {
    // Unit 10 is a system of 4 bars, units 11 and 12 are annotation lines with no cursor, unit 13 is the next system
    const ids = [10, 11, 12, 13];
    const sys = [
        { barIndex: 10, timeMs: 0, barOffset: 0, barCount: 4, colStartFrac: 0, colEndFrac: 0.25, barColStartFrac: 0, barColEndFrac: 0.25 },
        { barIndex: 10, timeMs: 1000, barOffset: 3, barCount: 4, colStartFrac: 0.75, colEndFrac: 1, barColStartFrac: 0.75, barColEndFrac: 1 },
        { barIndex: 13, timeMs: 4000, barOffset: 0, barCount: 4, colStartFrac: 0, colEndFrac: 0.25, barColStartFrac: 0, barColEndFrac: 0.25 }
    ];
    for (const t of [1000, 2000, 3000, 3999]) {
        const pos = positionAt(sys, ids, t);
        assert.equal(Math.floor(pos), 0, `at ${t} the line is still in the system (rank ${pos})`);
        assert.equal(barProgressAt(sys, ids, t).unitId, 10);
    }
    assert.equal(Math.floor(positionAt(sys, ids, 4000)), 3);
    // Unit-level points without columns still glide through the lines between
    const plain = [{ barIndex: 10, timeMs: 0 }, { barIndex: 13, timeMs: 3000 }];
    assert.ok(positionAt(plain, ids, 1500) > 1);
});
