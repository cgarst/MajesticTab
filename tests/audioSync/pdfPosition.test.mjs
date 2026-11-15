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

test('holds the earlier point across a jump back', () => {
    assert.deepEqual(pdfPlayheadAt([pt(0, 0, 0.8, 0.2), pt(0, 1000, 0.1, 0.2)], 500), { unit: 0, x: 0.8, y: 0.2 }, 'a repeat to the left on the row');
    assert.deepEqual(pdfPlayheadAt([pt(1, 0, 0.5, 0.5), pt(0, 1000, 0.1, 0.1)], 500), { unit: 1, x: 0.5, y: 0.5 }, 'back to an earlier page');
});

test('the last beat of a row keeps moving to the end of the staff, then the next row starts on time', () => {
    const row = [pt(0, 0, 0.1, 0.2), pt(0, 1000, 0.2, 0.2), pt(0, 2000, 0.3, 0.2), pt(0, 3000, 0.4, 0.2)];
    const pts = [...row, pt(0, 4000, 0.1, 0.4)];
    const mid = pdfPlayheadAt(pts, 3500);       // the beat before was 0.1 wide, so the row ends at 0.5
    assert.equal(mid.y, 0.2);
    assert.ok(Math.abs(mid.x - 0.45) < 1e-9, `x ${mid.x}`);
    assert.ok(Math.abs(pdfPlayheadAt(pts, 3999).x - 0.5) < 1e-3, 'it arrives at the end as the next beat starts');
    assert.deepEqual(pdfPlayheadAt(pts, 4000), { unit: 0, x: 0.1, y: 0.4 }, 'then it is at the start of the next row');
});

test('the end of a row is held inside the staff, and it works across a page too', () => {
    const pts = [pt(0, 0, 0.8, 0.9), pt(0, 1000, 0.95, 0.9), pt(1, 2000, 0.1, 0.1)];
    const p = pdfPlayheadAt(pts, 1500);          // 0.95 + 0.15 would pass the staff, so the end is 0.985
    assert.equal(p.unit, 0);
    assert.ok(p.x > 0.95 && p.x < 0.985);
    assert.equal(pdfPlayheadAt(pts, 2000).unit, 1);
    assert.ok(Math.abs(pdfPlayheadAt([pt(0, 0, 0.9, 0.2), pt(0, 1000, 0.1, 0.4)], 500).x - 0.9425) < 1e-9, 'a lone beat on a row uses a default width');
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
