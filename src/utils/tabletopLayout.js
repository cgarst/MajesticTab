// tabletopLayout.js
// iPhone Duo folded with the crease across: the controls half holds, top down, the song row, the fretboard, the strip
// (progress, and the recording bar when Original is selected) with the transport, and the five words. Whatever height
// those do not need is shared equally between them, so nothing is crowded and nothing floats alone. This measures the
// spare height and publishes the share as --dt-slack (each gap); design.css places the fretboard and the strip with it.
// Without a fretboard (PDF, text, MIDI) there are two gaps instead of three.

import { isTabletop } from '../foldState.js';

let queued = 0;

function visible(el) {
    return Boolean(el) && !el.classList.contains('is-hidden') && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
}

function measure() {
    queued = 0;
    const root = document.documentElement;
    if (!isTabletop() || document.body.classList.contains('library-view-active')) {
        root.style.removeProperty('--dt-slack');
        return;
    }
    const bar = document.getElementById('topBar');
    const words = document.getElementById('topFlexZone');
    const dock = document.querySelector('.mobile-playback-dock');
    const fb = document.getElementById('fretboardDock');
    if (!bar || !words || !dock) return;
    const fbShown = visible(fb) && document.body.classList.contains('fretboard-open');
    const top = bar.getBoundingClientRect().top;           // the song row starts at the hinge's lower edge
    const bottom = words.getBoundingClientRect().top;      // the five words start here
    const used = bar.offsetHeight + (fbShown ? fb.offsetHeight : 0) + (visible(dock) ? dock.offsetHeight : 0);
    const gaps = fbShown ? 3 : 2;
    const slack = Math.max(8, Math.floor((bottom - top - used) / gaps));
    root.style.setProperty('--dt-slack', `${slack}px`);
}

function queue() {
    if (!queued) queued = requestAnimationFrame(measure);
}

export function initTabletopLayout() {
    window.addEventListener('foldchange', queue);
    window.addEventListener('resize', queue);
    new MutationObserver(queue).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: false });
    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(queue);
        for (const sel of ['#topBar', '#topFlexZone', '.mobile-playback-dock', '#fretboardDock']) {
            const el = document.querySelector(sel);
            if (el) ro.observe(el);
        }
    }
    queue();
}
