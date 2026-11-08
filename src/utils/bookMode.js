// bookMode.js
// iPhone Duo folded like a book (crease up and down): the inner display is two portrait halves, so the song goes to Page
// mode with two pages, one on each half, with the crease between them. This is temporary. The player's own choice (the
// Scroll | Page switch for this song, and the saved defaults in Settings) is left alone: the switch goes back to Scroll when the
// fold opens flat again, unless the player has chosen a mode themselves in the meantime. The two-page count itself lives in
// getPagesPerView (viewModeUtils.js); the gap at the crease is --fold-w (design.css).

import { isBook } from '../foldState.js';

let forcedPage = false;

function setMode(page) {
    const radio = document.getElementById(page ? 'pageModeRadio' : 'continuousModeRadio');
    if (!radio || radio.checked) return false;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

export function initBookMode() {
    // A mode chosen by hand while in book pose is the player's: do not undo it on the way out
    for (const id of ['pageModeRadio', 'continuousModeRadio']) {
        document.getElementById(id)?.addEventListener('click', () => { forcedPage = false; });
    }
    window.addEventListener('foldchange', () => {
        if (isBook()) {
            if (setMode(true)) forcedPage = true;
        } else if (forcedPage) {
            forcedPage = false;
            if (document.getElementById('pageModeRadio')?.checked) setMode(false);
        }
    });
}
