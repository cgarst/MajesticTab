/**
 * AlphaTab draws the title, subtitle and artist lines at a fixed font size and does not wrap them, so a long title is
 * cut off at the page edge when the page or screen is narrow (a phone, a high sheet zoom). Shrink any text line that runs
 * past its container, keeping its anchor point, so the whole title is always readable. The staves are not touched.
 */
export function fitScoreText(root) {
    if (!root) return;
    const margin = 8;
    root.querySelectorAll('svg').forEach((svg) => {
        const box = svg.viewBox && svg.viewBox.baseVal;
        const width = box && box.width > 0 ? box.width : (svg.width?.baseVal?.value || svg.clientWidth || svg.parentElement?.clientWidth || 0);
        if (!(width > 0)) return;
        svg.querySelectorAll('text').forEach((text) => {
            if (text.dataset.fitted) return;
            let bbox;
            try { bbox = text.getBBox(); } catch { return; }
            if (!bbox.width) return;
            const anchor = text.getAttribute('text-anchor') || window.getComputedStyle(text).textAnchor;
            const x = Number.parseFloat(text.getAttribute('x')) || (anchor === 'middle' ? width / 2 : bbox.x);
            const y = Number.parseFloat(text.getAttribute('y')) || 0;

            let factor = 1;
            let pivotX = x;

            if (anchor === 'middle') {
                const room = width - 2 * margin;
                if (bbox.width > room && room > 0) {
                    factor = room / bbox.width;
                    pivotX = x;
                }
            } else {
                const left = Math.max(0, bbox.x);
                const room = width - margin - left;
                if (bbox.x + bbox.width > width - margin && room > 0) {
                    factor = room / bbox.width;
                    pivotX = anchor === 'end' ? x : Math.max(x, left);
                }
            }

            if (factor < 1) {
                const existing = text.getAttribute('transform');
                text.setAttribute('transform', `${existing ? existing + ' ' : ''}translate(${pivotX} ${y}) scale(${factor.toFixed(4)}) translate(${-pivotX} ${-y})`);
                text.dataset.fitted = '1';
            }
        });
    });
}
