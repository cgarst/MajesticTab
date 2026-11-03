// toolsMenu.js
// The "Tools" menu: Chord library, Scales, Circle of fifths, Fretboard, Tuner and Jam. The rows keep their original
// element ids, so the modules that bind to them work unchanged. This file adds:
//   - open / close / placement of the menu
//   - a live Jam session pill and a status dot on the Tools button
//   - the R and T keys
// The playback dock is always on, and there is no pinned tool: the bar has fixed labelled buttons.

import { updateGlobalAudioControls } from './navigationUtils.js';

const LEGACY_KEYS = ['majestictab.pinnedTool', 'majestictab.playbackDock'];

const $ = (id) => document.getElementById(id);

function writeStorage(key, value) {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch (_) { /* storage can be blocked; the setting just won't persist */ }
}

let _openMenu = null;
let _closeMenu = null;
let _toggleMenu = null;

export function toggleToolsMenu(triggerEl) {
    if (_toggleMenu) _toggleMenu(triggerEl);
}

export function openToolsMenu(triggerEl) {
    if (_openMenu) _openMenu(triggerEl);
}

export function closeToolsMenu() {
    if (_closeMenu) _closeMenu();
}

export function initToolsMenu() {
    const toggleBtn = $('toolsToggleBtn');
    const menu = $('toolsMenu');
    if (!toggleBtn || !menu) return;

    let activeTriggerBtn = null;

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

    function placeMenu(trigger = activeTriggerBtn || toggleBtn) {
        if (!trigger) return;
        const rect = trigger.getBoundingClientRect();
        menu.style.left = 'auto';
        menu.style.bottom = 'auto';
        menu.style.top = `${Math.round(rect.bottom + 8)}px`;
        menu.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
    }

    function openMenu(trigger = toggleBtn) {
        activeTriggerBtn = trigger;
        syncReferenceActive();
        menu.style.display = 'block';
        updateDividers();
        placeMenu(trigger);
        trigger?.setAttribute('aria-expanded', 'true');
        trigger?.classList.add('active');
        if (trigger !== toggleBtn) {
            toggleBtn?.setAttribute('aria-expanded', 'true');
        }
    }

    function closeMenu() {
        if (!isOpen()) return;
        menu.style.display = 'none';
        activeTriggerBtn?.setAttribute('aria-expanded', 'false');
        activeTriggerBtn?.classList.remove('active');
        toggleBtn?.setAttribute('aria-expanded', 'false');
        toggleBtn?.classList.remove('active');
        activeTriggerBtn = null;
    }

    function toggleMenu(trigger = toggleBtn) {
        if (isOpen()) closeMenu();
        else openMenu(trigger);
    }

    _openMenu = openMenu;
    _closeMenu = closeMenu;
    _toggleMenu = toggleMenu;

    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMenu(toggleBtn);
    });

    document.addEventListener('pointerdown', (e) => {
        if (!isOpen()) return;
        if (menu.contains(e.target)) return;
        if (toggleBtn?.contains(e.target)) return;
        if (activeTriggerBtn?.contains(e.target)) return;
        closeMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen()) {
            closeMenu();
            (activeTriggerBtn || toggleBtn)?.focus();
        }
    });
    window.addEventListener('resize', () => {
        if (isOpen()) { updateDividers(); placeMenu(); }
    });

    // Choosing a tool closes the menu. The dock switch stays open so the change is visible.
    menu.addEventListener('click', (e) => {
        const item = e.target.closest('.tools-item');
        if (item) closeMenu();
    });

    // ---- Reference library -------------------------------------------------

    // Chords, Scales and Circle of fifths are three tools that share one screen. Each opens as a modal over
    // whatever is on screen: a song, the library, or the start screen.
    menu.querySelectorAll('.tools-ref-item').forEach((item) => {
        item.addEventListener('click', async () => {
            const ref = await import('../referenceLibrary.js');
            ref.openReferenceModal(item.dataset.refTab);
        });
    });

    // ---- Keyboard shortcuts (R: Chord library, T: Tuner) ---------------

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

    forward('jamLiveBtn', 'jamToggleBtn');
    function forward(itemId, targetId) {
        $(itemId)?.addEventListener('click', () => $(targetId)?.click());
    }

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
        toggleBtn.classList.toggle('has-jam', jamLive);
    }

    // The dock is always on. Older builds stored a switch; clear it so it cannot linger.
    LEGACY_KEYS.forEach((k) => writeStorage(k, null));
    document.body.classList.remove('dock-off');
    updateGlobalAudioControls();

    // ---- Keep everything in sync with the modules that own the real controls ---

    const observer = new MutationObserver(() => {
        syncStatus();
        if (isOpen()) updateDividers();
    });
    ['fretboardPill', 'jamPill', 'fretboardToggleBtn', 'tunerToggleBtn', 'jamToggleBtn']
        .forEach((id) => {
            const el = $(id);
            if (el) observer.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
        });
    const jamLabel = $('jamStatusLabel');
    if (jamLabel) observer.observe(jamLabel, { childList: true, characterData: true, subtree: true });

    syncStatus();
}
