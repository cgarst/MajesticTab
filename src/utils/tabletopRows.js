// tabletopRows.js
// iPhone Duo folded with the crease across: the page buttons (previous, next) move out of the song row and down into the
// transport row, after the Synth | Original switch, so restart, play, the sound switch and the page buttons are one row of
// large keys under the thumb. Unfolding puts them back. The element moves; it is not cloned, so every listener and id stays.

import { isTabletop } from '../foldState.js';

let mark = null; // where the page buttons live outside tabletop

function swapIn() {
    const nav = document.getElementById('navButtons');
    const src = document.querySelector('.dock-src');
    if (mark || !nav || !src) return;
    mark = { parent: nav.parentNode, next: nav.nextSibling };
    src.after(nav);
    document.documentElement.classList.add('dt-rows-swapped');
}

function swapOut() {
    if (!mark) return;
    const nav = document.getElementById('navButtons');
    if (nav) mark.parent.insertBefore(nav, mark.next && mark.next.parentNode === mark.parent ? mark.next : null);
    mark = null;
    document.documentElement.classList.remove('dt-rows-swapped');
}

function sync() {
    if (isTabletop() && !document.body.classList.contains('library-view-active')) swapIn();
    else swapOut();
}

export function initTabletopRows() {
    window.addEventListener('foldchange', sync);
    // On the device the pose arrives while the library is showing, so the reader opening is what decides too
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    sync();
}
