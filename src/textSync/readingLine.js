// textSync/readingLine.js
// Pure math for the reading line: where a recording's clock puts the reader in a text or PDF tab.
//
// A sync point pins a recording time to a unit (a text block, or a PDF canvas), and optionally to a specific bar
// within a staff system (`barOffset`, `barCount`, `colStartFrac`, `colEndFrac`). Between two points the app interpolates
// smoothly: positions are measured in ranks (the index of a unit among the tab's units in reading order, plus a fraction
// for how far through it we are).

/** Unit ids in reading order are not always contiguous (separators have no id), so everything works on ranks. */
export function rankOf(unitIds, unit) {
    const i = unitIds.indexOf(unit);
    if (i >= 0) return i;
    const asNum = typeof unit === 'string' ? Number(unit) : String(unit);
    return unitIds.indexOf(asNum);
}

/**
 * The ids of the points that jump back to a unit (or earlier bar in the same unit) than the point before them (a repeat),
 * points sorted by time. Points naming an unknown unit are skipped.
 * @returns {Set<any>} the `id` of each such point
 */
export function backJumps(points, unitIds) {
    const out = new Set();
    let prev = -1;
    let prevBarOffset = -1;
    for (const p of points) {
        const r = rankOf(unitIds, p.barIndex);
        if (r < 0) continue;
        const bo = p.barOffset ?? 0;
        if (prev >= 0 && (r < prev || (r === prev && bo <= prevBarOffset))) out.add(p.id);
        prev = r;
        prevBarOffset = bo;
    }
    return out;
}

function pointSubRank(p, baseRank) {
    if (baseRank < 0) return -1;
    const count = p.barCount || 0;
    const offset = p.barOffset || 0;
    if (count > 1) return baseRank + Math.max(0, Math.min(0.999, offset / count));
    return baseRank;
}

/**
 * The reading position at `timeMs`.
 * @param {Array<{barIndex:number|string,timeMs:number,endTimeMs?:number,barOffset?:number,barCount?:number}>} points sorted by timeMs
 * @param {Array<number|string>} unitIds every unit in reading order
 * @param {number} timeMs the heard time (recording clock minus audio latency)
 * @param {number|null} endMs length of the recording, to let the last unit finish
 * @returns {number|null} a rank (unit index + fraction), or null with no usable points; before the first point it rests at that point's unit
 */
export function positionAt(points, unitIds, timeMs, endMs = null) {
    const usable = points
        .map((p) => {
            const baseRank = rankOf(unitIds, p.barIndex);
            return {
                baseRank,
                rank: pointSubRank(p, baseRank),
                stepSpan: p.barCount > 1 ? 1 / p.barCount : 1,
                t: p.timeMs,
                endT: p.endTimeMs ?? null,
                raw: p
            };
        })
        .filter((p) => p.baseRank >= 0);
    if (!usable.length) return null;
    // Before the first point the line waits at the first point's unit (where the song starts)
    if (timeMs < usable[0].t) return usable[0].rank;
    let i = 0;
    while (i + 1 < usable.length && usable[i + 1].t <= timeMs) i++;
    const a = usable[i];
    const b = usable[i + 1];
    if (b) {
        const span = b.t - a.t;
        if (span <= 0) return a.rank;
        if (b.rank <= a.rank) {
            // A repeat: the next point goes back. The player keeps reading on through this unit/bar (at most 20 s, as past the
            // last point) and the line jumps back when the clock reaches the point.
            const room = Math.min(20000, span);
            return a.rank + Math.min(a.stepSpan * 0.999, ((timeMs - a.t) / room) * a.stepSpan);
        }
        return a.rank + (b.rank - a.rank) * ((timeMs - a.t) / span);
    }
    // Past the last point: move through that unit/bar over the time that is left, at most 20 s, then rest at its end
    const targetEnd = a.endT != null ? a.endT : (endMs || a.t);
    const room = Math.max(0, Math.min(20000, targetEnd - a.t));
    if (!room) return a.rank;
    return a.rank + Math.min(a.stepSpan * 0.999, ((timeMs - a.t) / room) * a.stepSpan);
}

/**
 * Returns detailed intra-system & intra-bar progress at `timeMs`, including `colFrac` (0..1 across the active system)
 * and `barFrac` (0..1 across the active bar) for both Vertical column cursor and Horizontal ribbon scrolling.
 *
 * @param {Array<any>} points
 * @param {Array<number|string>} unitIds
 * @param {number} timeMs
 * @param {number|null} [endMs=null]
 * @returns {{ rank: number, unitIndex: number, unitId: number|string, barOffset: number, barCount: number, barFrac: number, colFrac: number, colStartFrac: number, colEndFrac: number, visualBarIndex: number|null, barNumber: number|null } | null}
 */
export function barProgressAt(points, unitIds, timeMs, endMs = null) {
    const pos = positionAt(points, unitIds, timeMs, endMs);
    if (pos == null || !unitIds.length) return null;
    const unitIndex = Math.max(0, Math.min(unitIds.length - 1, Math.floor(pos)));
    const unitId = unitIds[unitIndex];
    const unitFrac = Math.max(0, Math.min(1, pos - unitIndex));

    // Find active point at timeMs
    let activeIdx = 0;
    while (activeIdx + 1 < points.length && points[activeIdx + 1].timeMs <= timeMs) activeIdx++;
    const p = points[activeIdx];
    const nextP = points[activeIdx + 1];

    if (p && p.colStartFrac !== undefined && p.colEndFrac !== undefined && rankOf(unitIds, p.barIndex) === unitIndex) {
        const endT = p.endTimeMs ?? (nextP ? nextP.timeMs : (endMs || p.timeMs + 2000));
        const dur = Math.max(1, endT - p.timeMs);
        const barFrac = timeMs < p.timeMs ? 0 : Math.max(0, Math.min(1, (timeMs - p.timeMs) / dur));
        const colFrac = p.colStartFrac + (p.colEndFrac - p.colStartFrac) * barFrac;
        return {
            rank: pos,
            unitIndex,
            unitId,
            barOffset: p.barOffset ?? 0,
            barCount: p.barCount ?? 1,
            barFrac,
            colFrac,
            colStartFrac: p.colStartFrac,
            colEndFrac: p.colEndFrac,
            visualBarIndex: p.visualBarIndex ?? null,
            barNumber: p.barNumber ?? null
        };
    }

    return {
        rank: pos,
        unitIndex,
        unitId,
        barOffset: 0,
        barCount: 1,
        barFrac: unitFrac,
        colFrac: unitFrac,
        colStartFrac: 0,
        colEndFrac: 1,
        visualBarIndex: null,
        barNumber: null
    };
}

/**
 * Where the scroll should go so the line stays readable.
 * The line may roam between `top` and `bottom` (fractions of the viewport height); below `bottom` the page glides
 * so the line stays there, above `top` it brings the line back to `top`.
 * @returns {number|null} the wanted scrollTop, or null when the line is already in the comfortable band
 */
export function followTarget({ lineY, viewH, scrollTop, top = 0.2, bottom = 0.6 }) {
    // lineY is the line's position inside the scrolled content
    const inView = lineY - scrollTop;
    if (inView > viewH * bottom) return lineY - viewH * bottom;
    if (inView < viewH * top) return Math.max(0, lineY - viewH * top);
    return null;
}

/** One step of an exponential glide toward `target`, frame-rate independent. `dt` and `tau` in seconds. */
export function glide(current, target, dt, tau = 0.25) {
    const k = 1 - Math.exp(-dt / tau);
    const next = current + (target - current) * k;
    return Math.abs(target - next) < 0.5 ? target : next;
}
