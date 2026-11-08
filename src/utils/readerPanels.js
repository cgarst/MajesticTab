// readerPanels.js
// One open/close behaviour for every reader panel: View, Practice, Song, Guitar, Tools, Synth, Recording and Volume.
//
// - showPanel / hidePanel are the only things that change a panel's display. Showing plays the entry, hiding plays a
//   shorter exit and then sets display:none. Both use the motion tokens in design.css and are instant under
//   prefers-reduced-motion. A panel being hidden counts as closed straight away (isShown is false).
// - initReaderPanels makes the panels one set: opening any one closes the others.
//
// Each panel module keeps its own contents and placement; this file owns the open state and the motion.

import { isTabletop } from '../foldState.js';

const EXIT_MS = 150;
const timers = new WeakMap();

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Whether a tap outside an open panel closes it. In tabletop (iPhone Duo, crease across) the panels live in the bottom half and
 * never cover the score, so a tap on the score (turning a page, placing the cursor) must leave them open.
 */
export function outsideTapCloses() { return !isTabletop(); }

/** True while the panel is on screen and not on its way out */
export function isShown(el) {
    return Boolean(el) && el.style.display !== 'none' && !el.classList.contains('rp-out');
}

export function showPanel(el, display = '') {
    if (!el) return;
    clearTimeout(timers.get(el));
    el.classList.remove('rp-out');
    el.style.display = display;
    if (reduced()) return;
    el.classList.remove('rp-in');
    void el.offsetWidth; // restart the entry if it was mid-exit
    el.classList.add('rp-in');
}

export function hidePanel(el) {
    if (!el || el.style.display === 'none' || el.classList.contains('rp-out')) return;
    clearTimeout(timers.get(el));
    if (reduced()) {
        el.classList.remove('rp-in');
        el.style.display = 'none';
        return;
    }
    el.classList.remove('rp-in');
    el.classList.add('rp-out');
    timers.set(el, setTimeout(() => {
        el.classList.remove('rp-out');
        el.style.display = 'none';
    }, EXIT_MS));
}

/**
 * Where every top-bar menu opens: under its button, right edge on the button's right edge, kept inside the window.
 * Call it after showPanel so the panel has a width. Phones ignore it (the CSS makes bottom sheets).
 */
export function placePanel(panel, anchor, margin = 8, align = 'right') {
    if (!panel || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = panel.offsetWidth || 360;
    const want = align === 'left' ? r.left : r.right - w;
    const left = Math.max(margin, Math.min(window.innerWidth - w - margin, Math.round(want)));
    Object.assign(panel.style, { position: 'fixed', top: `${Math.round(r.bottom + 8)}px`, left: `${left}px`, right: 'auto', bottom: 'auto', transform: 'none' });
}

// The set: [button id, panel id, close()]. Closing goes through each panel's own close path.
const click = (id) => () => document.getElementById(id)?.click();
const PANELS = [
    { button: 'viewToggleBtn', panel: 'viewMenu', close: click('viewToggleBtn') },
    { button: 'practiceToggleBtn', panel: 'practiceMenu', close: click('practiceToggleBtn') },
    { button: 'topBarSongTitleBtn', panel: 'scoreOptionsDropdownPanel', close: click('scoreOptionsPanelCloseBtn') },
    { button: 'tracksToggleBtn', panel: 'tracksMenu', close: click('tracksToggleBtn') },
    { button: 'guitarToggleBtn', panel: 'guitarMenu', close: click('guitarToggleBtn') },
    { button: 'toolsToggleBtn', panel: 'toolsMenu', close: click('toolsToggleBtn') },
    { button: 'synthToggleBtn', panel: 'synthDropdownPanel', close: click('synthPanelCloseBtn') },
    { button: 'ytToggleBtn', panel: 'ytDropdownPanel', close: click('ytPanelCloseBtn') },
    { button: 'dockVolumeBtn', panel: null, close: click('dockVolumeBtn') }
];

/** True when any reader panel is open (tabletop keeps one open in the bottom half) */
export function anyReaderPanelOpen() {
    return PANELS.some((p) => (p.panel ? isShown(document.getElementById(p.panel))
        : document.getElementById(p.button)?.getAttribute('aria-expanded') === 'true'));
}

/** Close every open reader panel (the library has no reader chrome). */
export function closeAllReaderPanels() {
    PANELS.forEach((p) => {
        const open = p.panel ? isShown(document.getElementById(p.panel))
            : document.getElementById(p.button)?.getAttribute('aria-expanded') === 'true';
        if (open) p.close();
    });
}

export function initReaderPanels() {
    const openNow = (p) => {
        if (p.panel) return isShown(document.getElementById(p.panel));
        return document.getElementById(p.button)?.getAttribute('aria-expanded') === 'true';
    };
    const onOpened = (self) => {
        PANELS.forEach((p) => { if (p !== self && openNow(p)) p.close(); });
    };
    PANELS.forEach((p) => {
        if (p.panel) {
            const el = document.getElementById(p.panel);
            if (!el) return;
            el.classList.add('rpanel');
            new MutationObserver(() => { if (isShown(el)) onOpened(p); }).observe(el, { attributes: true, attributeFilter: ['style'] });
        } else {
            const btn = document.getElementById(p.button);
            if (btn) new MutationObserver(() => { if (btn.getAttribute('aria-expanded') === 'true') onOpened(p); })
                .observe(btn, { attributes: true, attributeFilter: ['aria-expanded'] });
        }
    });
}
