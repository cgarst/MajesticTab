// audioSync/pdfPosition.js
// Where the playhead is inside a PDF page, from the sync points that carry a position (Music Pack SPEC section 9.2).
// Pure: no DOM. A point is `{ barIndex: unit, x?, y?, timeMs }` where the unit is the page's canvas index (anchors.js) and
// `x`, `y` are fractions of the page, origin at the top left. The tab shows each page as a condensed canvas that keeps only
// the music (pdfProcessor.js), so a `y` of the page has to be mapped onto the canvas (`condensedY`).

/** Points on one page this close in `y` are on the same row of music, so the playhead glides along the row. */
const SAME_ROW = 0.02;

const hasPosition = (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y);

/**
 * The playhead at `timeMs`: `{ unit, x?, y? }`, or null when there are no points. Between two points it follows the
 * spec: hold the earlier point, except that two position points on the same row of one page are interpolated (a jump to
 * another row, to another page, or back to an earlier place holds until the next point). Before the first point and
 * after the last it holds.
 */
export function pdfPlayheadAt(points, timeMs) {
    const usable = (points || []).filter((p) => Number.isInteger(p.barIndex) && Number.isFinite(p.timeMs));
    if (!usable.length) return null;
    const at = (p) => (hasPosition(p) ? { unit: p.barIndex, x: p.x, y: p.y } : { unit: p.barIndex });
    if (timeMs <= usable[0].timeMs) return at(usable[0]);
    let i = 0;
    while (i + 1 < usable.length && usable[i + 1].timeMs <= timeMs) i++;
    const a = usable[i];
    const b = usable[i + 1];
    if (!b) return at(a);
    if (hasPosition(a) && hasPosition(b) && a.barIndex === b.barIndex && Math.abs(b.y - a.y) <= SAME_ROW && b.x >= a.x && b.timeMs > a.timeMs) {
        const f = (timeMs - a.timeMs) / (b.timeMs - a.timeMs);
        return { unit: a.barIndex, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    return at(a);
}

/** True when some point names a position, so the tab can draw a playhead and not only turn pages. */
export const hasPositions = (points) => (points || []).some(hasPosition);

/**
 * The height of one row of music as a fraction of the page, for each unit: the smallest gap between the distinct `y`
 * values of its points. A unit with one row has no entry.
 */
export function rowSpans(points) {
    const ys = new Map();
    for (const p of points || []) {
        if (!hasPosition(p)) continue;
        if (!ys.has(p.barIndex)) ys.set(p.barIndex, new Set());
        ys.get(p.barIndex).add(Math.round(p.y * 1000) / 1000);
    }
    const out = new Map();
    for (const [unit, set] of ys) {
        const sorted = [...set].sort((a, b) => a - b);
        let min = Infinity;
        for (let i = 1; i < sorted.length; i++) min = Math.min(min, sorted[i] - sorted[i - 1]);
        if (Number.isFinite(min) && min > 0) out.set(unit, min);
    }
    return out;
}

/**
 * A `y` of the original page (a fraction) as a pixel row of the condensed canvas. `pageMap` is
 * `{ height, sections: [{ trimTop, trimBottom }] }` in original pixels, sorted: the kept sections, stacked in order. A row
 * that fell between two kept sections lands at the start of the next one.
 */
export function condensedY(pageMap, yFrac) {
    const y = Math.min(1, Math.max(0, yFrac)) * pageMap.height;
    let offset = 0;
    for (const s of pageMap.sections) {
        if (y < s.trimTop) return offset;
        if (y <= s.trimBottom) return offset + (y - s.trimTop);
        offset += s.trimBottom - s.trimTop + 1;
    }
    return offset;
}

/**
 * Where to draw the playhead on a page canvas: `{ y, h }`, both in the canvas's displayed pixels (`displayHeight` is its
 * height on screen). `y` is the row's middle, `h` the height of the row. A canvas with no `pageMap` was not condensed, so
 * the page's `y` is the canvas's.
 */
export function playheadBox(canvas, displayHeight, yFrac, rowFrac) {
    const scale = displayHeight / canvas.height;
    const toPx = (f) => (canvas.pageMap ? condensedY(canvas.pageMap, f) : f * canvas.height) * scale;
    const half = (rowFrac || 0.12) / 2;
    const top = toPx(Math.max(0, yFrac - half));
    const bottom = toPx(Math.min(1, yFrac + half));
    return { y: toPx(yFrac), h: Math.max(12, bottom - top) };
}
