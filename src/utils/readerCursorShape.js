// The playhead outline shared by the Guitar Pro reader and the text tab: a vertical stadium with a pointed V bottom.

export const READER_CURSOR_WIDTH = 20;

/** SVG path for a vertically oriented pill with a pointed V-shaped bottom. */
export function buildPillVPath(w, h) {
    const r = w / 2;
    const v = Math.min(12, Math.max(8, h * 0.12));
    return `M ${r} 1 A ${r - 1} ${r - 1} 0 0 1 ${w - 1} ${r} L ${w - 1} ${h - v} L ${r + 2} ${h - 3} Q ${r} ${h - 1} ${r - 2} ${h - 3} L 1 ${h - v} L 1 ${r} A ${r - 1} ${r - 1} 0 0 1 ${r} 1 Z`;
}

/** Draws the outline inside `el` and redraws it whenever `el` is resized (the element's height sets the pill's height). */
export function attachPillCursor(el) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'pill-cursor-svg');
    svg.setAttribute('width', String(READER_CURSOR_WIDTH));
    const path = document.createElementNS(NS, 'path');
    svg.appendChild(path);
    el.appendChild(svg);
    let lastH = 0;
    const draw = () => {
        const h = el.clientHeight;
        if (!h || Math.abs(h - lastH) < 1) return;
        lastH = h;
        svg.setAttribute('height', String(h));
        svg.setAttribute('viewBox', `0 0 ${READER_CURSOR_WIDTH} ${h}`);
        path.setAttribute('d', buildPillVPath(READER_CURSOR_WIDTH, h));
    };
    if (typeof ResizeObserver === 'function') new ResizeObserver(draw).observe(el);
    draw();
}
