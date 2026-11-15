// Run with: node --test tests/audioSync/pdfPosition.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfPlayheadAt, hasPositions, rowSpans, condensedY, playheadBox } from '../../src/audioSync/pdfPosition.js';

const pt = (unit, timeMs, x, y) => ({ barIndex: unit, timeMs, ...(x === undefined ? {} : { x, y }) });

test('holds the first point before it, and the last after it', () => {
    const pts = [pt(0, 1000, 0.1, 0.2), pt(0, 2000, 0.5, 0.2)];
    assert.deepEqual(pdfPlayheadAt(pts, 0), { unit: 0, x: 0.1, y: 0.2 });
    assert.deepEqual(pdfPlayheadAt(pts, 9000), { unit: 0, x: 0.5, y: 0.2 });
    assert.equal(pdfPlayheadAt([], 100), null);
});

test('glides along a row between two points on the same row', () => {
    const p = pdfPlayheadAt([pt(0, 1000, 0.1, 0.2), pt(0, 2000, 0.5, 0.2)], 1500);
    assert.equal(p.unit, 0);
    assert.ok(Math.abs(p.x - 0.3) < 1e-9 && p.y === 0.2);
});

test('holds the earlier point across a jump to another row, another page, or back', () => {
    assert.deepEqual(pdfPlayheadAt([pt(0, 0, 0.9, 0.2), pt(0, 1000, 0.1, 0.4)], 500), { unit: 0, x: 0.9, y: 0.2 });
    assert.deepEqual(pdfPlayheadAt([pt(0, 0, 0.9, 0.9), pt(1, 1000, 0.1, 0.1)], 500), { unit: 0, x: 0.9, y: 0.9 });
    assert.deepEqual(pdfPlayheadAt([pt(0, 0, 0.8, 0.2), pt(0, 1000, 0.1, 0.2)], 500), { unit: 0, x: 0.8, y: 0.2 }, 'a repeat to the left');
});

test('a point with only a page puts the playhead on that page and gives no position', () => {
    assert.deepEqual(pdfPlayheadAt([pt(2, 0), pt(3, 1000)], 500), { unit: 2 });
    assert.equal(hasPositions([pt(2, 0)]), false);
    assert.equal(hasPositions([pt(2, 0), pt(2, 5, 0.1, 0.1)]), true);
});

test('row height is the smallest gap between rows of a page', () => {
    const pts = [pt(0, 0, 0.1, 0.0714), pt(0, 1, 0.5, 0.0714), pt(0, 2, 0.1, 0.2143), pt(0, 3, 0.1, 0.3571), pt(1, 4, 0.1, 0.5)];
    const spans = rowSpans(pts);
    assert.ok(Math.abs(spans.get(0) - 0.1429) < 1e-3);
    assert.equal(spans.has(1), false, 'a page with one row has none');
});

test('condensedY stacks the kept sections and skips what was cut', () => {
    const map = { height: 1000, sections: [{ trimTop: 100, trimBottom: 199 }, { trimTop: 500, trimBottom: 599 }] };
    assert.equal(condensedY(map, 0.15), 50);    // 150 is 50 into the first section
    assert.equal(condensedY(map, 0.55), 150);   // 550 is 50 into the second, which starts at 100
    assert.equal(condensedY(map, 0.3), 100);    // 300 was cut: it lands at the start of the next section
    assert.equal(condensedY(map, 0.9), 200);    // past the last kept section: the bottom
    assert.equal(condensedY(map, 0.05), 0);
});

test('playheadBox scales to the displayed size, and uses the page y when the canvas was not condensed', () => {
    const plain = { height: 800 };
    assert.deepEqual(playheadBox(plain, 400, 0.5, 0.2), { y: 200, h: 80 });
    const condensed = { height: 200, pageMap: { height: 1000, sections: [{ trimTop: 400, trimBottom: 599 }] } };
    const box = playheadBox(condensed, 100, 0.5, 0.1);   // y 500 is 100 into the kept section: 100 px of 200, shown at half size
    assert.equal(box.y, 50);
    assert.ok(box.h >= 12);
});
