// toolsMenu.js
// Top bar "Tools" menu. Rarely used tools (Fretboard, Tuner, Jam, Gamepad) live here instead of
// each owning a pill in the bar. The rows keep their original element ids, so the modules that
// bind to them (fretboard, tuner, jam, gamepad) work unchanged. This file only adds:
//   - open / close / placement of the menu
//   - one pinned tool that can be promoted into the bar
//   - a live Jam session pill and a status dot on the Tools button
//   - the playback dock on/off switch
//   - menu rows for controls that fold away at narrow widths (Fullscreen, Bookmarks)

import { updateGlobalAudioControls } from './navigationUtils.js';

const PIN_KEY = 'majestictab.pinnedTool';
const DOCK_KEY = 'majestictab.playbackDock';

// Tuning fork, the same drawing the Tuner row uses
const TUNING_FORK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12v9"/><circle cx="12" cy="21" r="1.5"/><path d="M7 3v6a5 5 0 0 0 10 0V3"/></svg>';

const PINNABLE = {
    fretboard: { rowId: 'fretboardPill', btnId: 'fretboardToggleBtn', iconHtml: '<i class="bi-grid-3x2-gap"></i>', label: 'Fretboard' },
    tuner: { rowId: 'tunerPill', btnId: 'tunerToggleBtn', iconHtml: TUNING_FORK_SVG, label: 'Tuner' },
    reference: { rowId: 'toolsReferenceRow', btnId: 'toolsReferenceItem', iconHtml: '<i class="bi-journal-bookmark"></i>', label: 'Reference library' },
    jam: { rowId: 'jamPill', btnId: 'jamToggleBtn', iconHtml: '<i class="bi-people-fill"></i>', label: 'Jam mode' }
};

const $ = (id) => document.getElementById(id);

function readStorage(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}

function writeStorage(key, value) {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch (_) { /* storage can be blocked; the setting just won't persist */ }
}

function isShown(el) {
    return Boolean(el) && el.style.display !== 'none';
}

export function initToolsMenu() {
    const toggleBtn = $('toolsToggleBtn');
    const menu = $('toolsMenu');
    if (!toggleBtn || !menu) return;

    let pinned = readStorage(PIN_KEY);
    if (!PINNABLE[pinned]) pinned = null;

    // ---- Open / close ------------------------------------------------------

    const isOpen = () => menu.style.display !== 'none';

    // Dividers only show between two groups that each have a visible row
    function updateDividers() {
        let divider = null;
        let anyBefore = false;
        let anyAfter = false;
        const flush = () => { if (divider) divider.style.display = anyBefore && anyAfter ? '' : 'none'; };
        Array.from(menu.children).forEach((child) => {
            if (child.classList.contains('tools-menu-divider')) {
                flush();
                divider = child;
                anyBefore = anyBefore || anyAfter;
                anyAfter = false;
            } else if (child.classList.contains('tools-row')) {
                if (getComputedStyle(child).display !== 'none') anyAfter = true;
            }
        });
        flush();
    }

    function placeMenu() {
        const rect = toggleBtn.getBoundingClientRect();
        menu.style.top = `${Math.round(rect.bottom + 8)}px`;
        menu.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
    }

    function openMenu() {
        syncAvailability();
        syncReferenceActive();
        menu.style.display = 'block';
        updateDividers();
        placeMenu();
        toggleBtn.setAttribute('aria-expanded', 'true');
        toggleBtn.classList.add('active');
    }

    function closeMenu() {
        if (!isOpen()) return;
        menu.style.display = 'none';
        toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.classList.remove('active');
    }

    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isOpen()) closeMenu();
        else openMenu();
    });

    document.addEventListener('pointerdown', (e) => {
        if (isOpen() && !menu.contains(e.target) && !toggleBtn.contains(e.target)) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen()) {
            closeMenu();
            toggleBtn.focus();
        }
    });
    window.addEventListener('resize', () => {
        if (isOpen()) { updateDividers(); placeMenu(); }
    });

    // Choosing a tool closes the menu. The dock switch stays open so the change is visible.
    menu.addEventListener('click', (e) => {
        const item = e.target.closest('.tools-item');
        if (item && item.id !== 'dockToggleBtn') closeMenu();
    });

    // ---- Reference library -------------------------------------------------

    async function syncReferenceActive() {
        const ref = await import('../referenceLibrary.js');
        $('toolsReferenceItem')?.classList.toggle('active', ref.isReferenceOpen());
        syncPinnedProxy();
    }

    // Opens as a modal over whatever is on screen: a song, the library, or the start screen
    $('toolsReferenceItem')?.addEventListener('click', async () => {
        const ref = await import('../referenceLibrary.js');
        ref.openReferenceModal();
    });

    // ---- Keyboard shortcuts (R: Reference library, T: Tuner) ---------------

    const isTypingTarget = (el) => Boolean(el) && (
        (el.tagName === 'INPUT' && !['radio', 'checkbox', 'button', 'submit', 'range'].includes(el.type)) ||
        el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
    );

    // Pressing the key again closes the tool; any other open modal blocks it
    window.addEventListener('keydown', async (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTypingTarget(document.activeElement)) return;
        const key = e.key.toLowerCase();
        if (key !== 'r' && key !== 't') return;
        e.preventDefault();
        if (key === 'r') {
            const ref = await import('../referenceLibrary.js');
            if (ref.isReferenceOpen()) ref.closeReferenceModal();
            else if (!document.body.classList.contains('modal-open') && !$('tunerToggleBtn')?.classList.contains('active')) ref.openReferenceModal();
        } else {
            const tunerOpen = $('tunerToggleBtn')?.classList.contains('active');
            if (tunerOpen) (await import('../tuner/tuner.js')).closeTunerModal();
            else if (!document.body.classList.contains('modal-open')) $('tunerToggleBtn')?.click();
        }
    });

    // ---- Folded controls ---------------------------------------------------

    function forward(itemId, targetId) {
        $(itemId)?.addEventListener('click', () => $(targetId)?.click());
    }
    forward('toolsFullscreenItem', 'fullscreenToggleBtn');
    forward('toolsBookmarksItem', 'pdfBookmarksBtn');
    forward('jamLiveBtn', 'jamToggleBtn');

    function syncAvailability() {
        $('toolsFullscreenRow')?.classList.toggle('is-available', isShown($('fullscreenPill')));
        $('toolsBookmarksRow')?.classList.toggle('is-available', isShown($('pdfBookmarksBtn')));
    }

    // ---- Pinned tool -------------------------------------------------------

    function renderPins() {
        menu.querySelectorAll('[data-pin-tool]').forEach((btn) => {
            const on = btn.dataset.pinTool === pinned;
            btn.setAttribute('aria-pressed', String(on));
            btn.title = on ? 'Unpin from the bar' : 'Pin to the bar';
        });
        syncPinnedProxy();
    }

    function syncPinnedProxy() {
        const pill = $('pinnedToolPill');
        const proxy = $('pinnedToolBtn');
        const icon = $('pinnedToolIcon');
        if (!pill || !proxy || !icon) return;
        const spec = pinned ? PINNABLE[pinned] : null;
        const source = spec ? $(spec.btnId) : null;
        const row = spec ? $(spec.rowId) : null;
        const jamLive = $('jamToggleBtn')?.classList.contains('jam-active');
        // A live Jam session takes the pinned slot so the bar never grows.
        if (!spec || !source || !isShown(row) || jamLive) {
            pill.style.display = 'none';
            return;
        }
        pill.style.display = '';
        icon.innerHTML = spec.iconHtml;
        proxy.title = spec.label;
        proxy.setAttribute('aria-label', spec.label);
        proxy.classList.toggle('active', source.classList.contains('active') || source.classList.contains('jam-active'));
    }

    menu.addEventListener('click', (e) => {
        const pinBtn = e.target.closest('[data-pin-tool]');
        if (!pinBtn) return;
        e.stopPropagation();
        const tool = pinBtn.dataset.pinTool;
        pinned = pinned === tool ? null : tool;
        writeStorage(PIN_KEY, pinned);
        renderPins();
    });

    $('pinnedToolBtn')?.addEventListener('click', () => {
        const spec = pinned ? PINNABLE[pinned] : null;
        if (spec) $(spec.btnId)?.click();
    });

    // ---- Status: live Jam pill and Tools dot -------------------------------

    function syncStatus() {
        const jamBtn = $('jamToggleBtn');
        const jamLive = Boolean(jamBtn?.classList.contains('jam-active'));
        const jamPill = $('jamLivePill');
        if (jamPill) {
            jamPill.style.display = jamLive ? '' : 'none';
            const full = ($('jamStatusLabel')?.textContent || '').trim();
            const short = full.startsWith('Hosting') ? full.replace('Hosting', 'Host') : full.split(' · ')[0];
            const label = $('jamLiveLabel');
            if (label) label.textContent = short;
            const btn = $('jamLiveBtn');
            if (btn) btn.title = full ? `Jam mode: ${full}` : 'Jam session';
        }
        const padConnected = isShown($('controllerPill')) && Boolean($('controllerPill'));
        toggleBtn.classList.toggle('has-pad', padConnected);
        toggleBtn.classList.toggle('has-jam', jamLive);
        syncPinnedProxy();
    }

    // ---- Playback dock switch ----------------------------------------------

    function applyDock(on) {
        document.body.classList.toggle('dock-off', !on);
        const btn = $('dockToggleBtn');
        btn?.setAttribute('aria-checked', String(on));
        btn?.classList.toggle('is-on', on);
        updateGlobalAudioControls();
    }

    $('dockToggleBtn')?.addEventListener('click', () => {
        const on = document.body.classList.contains('dock-off');
        writeStorage(DOCK_KEY, on ? null : 'off');
        applyDock(on);
    });

    // ---- Keep everything in sync with the modules that own the real controls ---

    const observer = new MutationObserver(() => {
        syncStatus();
        syncAvailability();
        if (isOpen()) updateDividers();
    });
    ['fretboardPill', 'jamPill', 'controllerPill', 'fullscreenPill', 'pdfBookmarksBtn', 'fretboardToggleBtn', 'tunerToggleBtn', 'jamToggleBtn']
        .forEach((id) => {
            const el = $(id);
            if (el) observer.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
        });
    const jamLabel = $('jamStatusLabel');
    if (jamLabel) observer.observe(jamLabel, { childList: true, characterData: true, subtree: true });

    applyDock(readStorage(DOCK_KEY) !== 'off');
    renderPins();
    syncStatus();
    syncAvailability();
}
