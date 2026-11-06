// textSync/readingLine.js
// Pure math for the reading line: where a recording's clock puts the reader in a text or PDF tab.
//
// A sync point pins a recording time to a unit (a text block, or a PDF canvas). Between two points the app does not
// know where the player is, so it assumes an even pace: the position glides from one unit to the next, and the line
// shows that guess. Positions are measured in ranks: the index of a unit among the tab's units in reading order, plus
// a fraction for how far through it we are. 3.25 is a quarter of the way down the fourth unit.

/** Unit ids in reading order are not always contiguous (separators have no id), so everything works on ranks. */
export function rankOf(unitIds, unit) {
    const i = unitIds.indexOf(unit);
    return i;
}

/**
 * The reading position at `timeMs`.
 * @param {{barIndex:number,timeMs:number}[]} points sorted by timeMs
 * @param {number[]} unitIds every unit in reading order
 * @param {number} timeMs the heard time (recording clock minus audio latency)
 * @param {number|null} endMs length of the recording, to let the last unit finish
 * @returns {number|null} a rank (unit index + fraction), or null with no usable points; before the first point it rests at that point's unit
 */
export function positionAt(points, unitIds, timeMs, endMs = null) {
    const usable = points
        .map((p) => ({ rank: rankOf(unitIds, p.barIndex), t: p.timeMs }))
        .filter((p) => p.rank >= 0);
    if (!usable.length) return null;
    // Before the first point the line waits at the first point's unit (where the song starts)
    if (timeMs < usable[0].t) return usable[0].rank;
    let i = 0;
    while (i + 1 < usable.length && usable[i + 1].t <= timeMs) i++;
    const a = usable[i];
    const b = usable[i + 1];
    if (b) {
        const span = b.t - a.t;
        if (span <= 0 || b.rank <= a.rank) return a.rank; // a point that goes back: hold until the clock reaches it
        return a.rank + (b.rank - a.rank) * ((timeMs - a.t) / span);
    }
    // Past the last point: move through that unit over the time that is left, at most 20 s, then rest at its end
    const room = Math.max(0, Math.min(20000, (endMs || a.t) - a.t));
    if (!room) return a.rank;
    return a.rank + Math.min(0.999, (timeMs - a.t) / room);
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
