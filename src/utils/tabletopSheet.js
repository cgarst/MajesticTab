// tabletopSheet.js
// iPhone Duo folded with the crease across: a sheet (View, Practice, Tracks, Guitar, Tools, Song, the sound panels) covers
// the whole bottom half, from the crease to the bottom edge, over the song row, the strip and the five words. With
// those covered, the sheet carries its own large Done button; it closes whatever is open through closeAllReaderPanels(),
// the same path the five words use. html.dt-sheet-open drives the CSS and shows the button.

import { isTabletop } from '../foldState.js';
import { anyReaderPanelOpen, closeAllReaderPanels } from './readerPanels.js';

const PANELS = ['viewMenu', 'practiceMenu', 'guitarMenu', 'toolsMenu', 'tracksMenu', 'scoreOptionsDropdownPanel', 'synthDropdownPanel', 'ytDropdownPanel'];
const SETTLE_MS = 60;
let timer = 0;
let button = null;

function ensureButton() {
    if (button) return button;
    button = document.createElement('button');
    button.id = 'tabletopSheetDone';
    button.type = 'button';
    button.textContent = 'Done';
    button.addEventListener('click', () => closeAllReaderPanels());
    document.body.appendChild(button);
    return button;
}

function sync() {
    clearTimeout(timer);
    timer = setTimeout(() => {
        const open = isTabletop() && !document.body.classList.contains('library-view-active') && anyReaderPanelOpen();
        document.documentElement.classList.toggle('dt-sheet-open', open);
        if (open) ensureButton();
    }, SETTLE_MS);
}

export function initTabletopSheet() {
    const watch = new MutationObserver(sync);
    watch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    for (const id of PANELS) {
        const el = document.getElementById(id);
        if (el) watch.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    window.addEventListener('foldchange', sync);
}
