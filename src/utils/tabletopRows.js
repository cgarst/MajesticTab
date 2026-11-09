// tabletopRows.js
// iPhone Duo folded with the crease across: the two rows nearest the thumb swap their usual contents. The page buttons
// (previous, next) move down beside restart and play, where they are pressed most, and the Synth | Original switch moves
// up into the song row. Unfolding puts both back where they were. The elements move; nothing is cloned, so every
// listener and id stays as it is.

import { isTabletop } from '../foldState.js';

let marks = null; // where each element lives outside tabletop

function parts() {
    return {
        nav: document.getElementById('navButtons'),
        src: document.querySelector('.dock-src'),
        bar: document.getElementById('topBar'),
        brand: document.getElementById('brandSection'),
        tools: document.querySelector('.dock-tools')
    };
}

function swapIn() {
    const { nav, src, bar, brand, tools } = parts();
    if (marks || !nav || !src || !bar || !brand || !tools) return;
    marks = {
        nav: { parent: nav.parentNode, next: nav.nextSibling },
        src: { parent: src.parentNode, next: src.nextSibling }
    };
    tools.insertBefore(nav, tools.firstChild);
    brand.after(src);
    document.documentElement.classList.add('dt-rows-swapped');
}

function swapOut() {
    if (!marks) return;
    const { nav, src } = parts();
    if (nav) marks.nav.parent.insertBefore(nav, marks.nav.next && marks.nav.next.parentNode === marks.nav.parent ? marks.nav.next : null);
    if (src) marks.src.parent.insertBefore(src, marks.src.next && marks.src.next.parentNode === marks.src.parent ? marks.src.next : null);
    marks = null;
    document.documentElement.classList.remove('dt-rows-swapped');
}

function sync() {
    if (isTabletop() && !document.body.classList.contains('library-view-active')) swapIn();
    else swapOut();
}

export function initTabletopRows() {
    window.addEventListener('foldchange', sync);
    sync();
}
