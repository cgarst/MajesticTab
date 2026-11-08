// tabletopDock.js
// iPhone Duo folded with the crease across: the bottom half is the controls, so something is always open there. Practice
// (speed, loop, metronome, count-in) is the one you reach for most while playing, so it is the resting panel: opened when
// the song opens, and again whenever the open panel is closed, so the half is never an empty tone. View, Tracks, Guitar,
// Tools, Song and the sound panels replace it while they are open, through the same buttons as everywhere else.

import { isTabletop } from '../foldState.js';
import { anyReaderPanelOpen } from './readerPanels.js';

const SETTLE_MS = 220; // lets a panel's exit and the next panel's entry finish before deciding that nothing is open
let timer = 0;

function inReader() {
    return !document.body.classList.contains('library-view-active') && Boolean(document.getElementById('output'));
}

function settle() {
    clearTimeout(timer);
    timer = setTimeout(() => {
        if (!isTabletop() || !inReader() || anyReaderPanelOpen()) return;
        const btn = document.getElementById('practiceToggleBtn');
        if (btn && !btn.disabled) btn.click();
    }, SETTLE_MS);
}

export function initTabletopDock() {
    const watch = new MutationObserver(settle);
    watch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    for (const id of ['viewMenu', 'practiceMenu', 'guitarMenu', 'toolsMenu', 'tracksMenu', 'scoreOptionsDropdownPanel', 'synthDropdownPanel', 'ytDropdownPanel']) {
        const el = document.getElementById(id);
        if (el) watch.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    window.addEventListener('foldchange', settle);
}
