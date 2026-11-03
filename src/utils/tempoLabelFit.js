/**
 * AlphaTab places the tempo note symbol and the "= 84" text after a tempo label such as "Allegretto poco" using the
 * width it measured for that label. When the browser draws the label wider than it measured (font fallback, bold
 * metrics), the label runs into the symbol. Shrink such a label, keeping its start, until it ends before the symbol.
 * Only the label is touched; the symbol, the number and every stave stay as AlphaTab drew them.
 */
export function fitTempoLabels(root) {
    if (!root) return;
    root.querySelectorAll('svg text').forEach((label) => {
        if (label.dataset.tempoFitted) return;
        const glyph = label.nextElementSibling;
        if (!glyph || glyph.tagName.toLowerCase() !== 'g') return;
        const m = /translate\(\s*([-\d.eE]+)[\s,]+([-\d.eE]+)\s*\)/.exec(glyph.getAttribute('transform') || '');
        if (!m) return;
        const gx = Number.parseFloat(m[1]);
        const gy = Number.parseFloat(m[2]);
        const x = Number.parseFloat(label.getAttribute('x'));
        const y = Number.parseFloat(label.getAttribute('y'));
        // The symbol sits on the label's baseline, to its right.
        if (!(gx > x) || Math.abs(gy - y) > 1) return;
        let width;
        try {
            const chars = label.getNumberOfChars();
            const text = label.textContent;
            // A trailing space is part of the label's box but not of what is drawn.
            width = label.getSubStringLength(0, text.endsWith(' ') ? chars - 1 : chars);
        } catch { return; }
        const room = gx - 2 - x;
        if (!(width > 0) || !(room > 0) || width <= room) return;
        const factor = room / width;
        const existing = label.getAttribute('transform');
        label.setAttribute('transform', `${existing ? existing + ' ' : ''}translate(${x} ${y}) scale(${factor.toFixed(4)}) translate(${-x} ${-y})`);
        label.dataset.tempoFitted = '1';
    });
}
