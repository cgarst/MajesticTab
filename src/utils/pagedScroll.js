/**
 * Paged follow for vertical scores and text tabs.
 *
 * The page holds still while the cursor travels along a line and then down the lines that fit. When the cursor enters a
 * line that no longer fits, the view makes one quick glide that puts that line at the top, in the time the eye takes to
 * return to the left edge. The last line that fits is marked beforehand, so the turn is seen coming. This replaces a jump
 * (Guitar Pro) and a continuous drift every line (text tabs).
 *
 * Pure logic: no DOM. The callers read the layout and write the scroll position.
 */

export const PAGE_GLIDE_MS = 300;

/** Ease-out, the same curve as `--ease-out` (cubic-bezier(0.22, 1, 0.36, 1)), by Newton iteration on x(t). */
export function easeOut(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const bez = (a, b, s) => 3 * a * (1 - s) * (1 - s) * s + 3 * b * (1 - s) * s * s + s * s * s;
    const dbez = (a, b, s) => 3 * a * (1 - s) * (1 - s) + 6 * (b - a) * (1 - s) * s + 3 * (1 - b) * s * s;
    let s = t;
    for (let i = 0; i < 8; i++) {
        const err = bez(0.22, 0.36, s) - t;
        const d = dbez(0.22, 0.36, s);
        if (Math.abs(err) < 1e-5 || Math.abs(d) < 1e-6) break;
        s -= err / d;
    }
    return bez(1, 1, Math.max(0, Math.min(1, s)));
}

/** A time-based glide of one number (a scroll position). `step(now)` returns the value to write, or null when idle. */
export function createGlide() {
    let g = null;
    return {
        get active() { return g !== null; },
        get to() { return g ? g.to : null; },
        start(from, to, now, ms = PAGE_GLIDE_MS) { g = { from, to, start: now, ms }; },
        step(now) {
            if (!g) return null;
            const t = (now - g.start) / g.ms;
            if (t >= 1) { const v = g.to; g = null; return v; }
            return g.from + (g.to - g.from) * easeOut(t);
        },
        cancel() { g = null; }
    };
}

/**
 * The line the cursor is in is not on the page: it runs past the bottom limit, or sits above the top. A line taller than
 * `maxFrac` of the usable height can never sit on a page, so it is never turned to (the caller follows it the old way).
 * All y are in view coordinates.
 */
export function lineNeedsTurn({ top, bottom, usableTop, usableBottom, maxFrac = 0.8 }) {
    if (bottom - top > (usableBottom - usableTop) * maxFrac) return false;
    return bottom > usableBottom || top < usableTop;
}

/** The cursor's line is the last that fits and the next one does not: the turn is next. */
export function isLastLine({ bottom, nextBottom, usableBottom }) {
    return nextBottom != null && bottom <= usableBottom && nextBottom > usableBottom;
}
