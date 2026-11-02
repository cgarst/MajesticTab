// src/utils/slidingPill.js

const EXCLUDED_PILL_IDS = new Set([
    'navButtons',
    'toolsPill',
    'viewPill',
    'songPill',
    'guitarPill',
    'fullscreenPill',
    'globalAudioControls',
    'jamLivePill'
]);

/**
 * Checks if a .hud-pill-group is a true segmented control.
 * @param {HTMLElement} group
 * @returns {boolean}
 */
function isSegmentedGroup(group) {
    if (!group || !group.classList?.contains('hud-pill-group')) return false;
    if (group.id && EXCLUDED_PILL_IDS.has(group.id)) return false;
    return true;
}

/**
 * Positions the sliding pill under the currently active button in a .hud-pill-group.
 * @param {HTMLElement} group - The .hud-pill-group element.
 * @param {boolean} [instant=false] - If true, bypasses animation transition.
 */
export function updateSlidingPill(group, instant = false) {
    if (!isSegmentedGroup(group)) return;

    // Ensure sliding pill element exists
    let pill = group.querySelector(':scope > .hud-sliding-pill');
    if (!pill) {
        pill = document.createElement('span');
        pill.className = 'hud-sliding-pill';
        pill.setAttribute('aria-hidden', 'true');
        group.prepend(pill);
    }

    // Find the currently active item
    const active = group.querySelector(
        '.btn-check:checked + label, input:checked + label, .btn.active, .btn.active-audio-mode, [aria-checked="true"], [aria-pressed="true"]'
    );

    if (!active || active.offsetWidth === 0) {
        pill.style.opacity = '0';
        return;
    }

    group.classList.add('has-sliding-pill');
    if (instant) group.classList.add('no-pill-anim');

    pill.style.opacity = '1';
    pill.style.width = `${active.offsetWidth}px`;
    pill.style.transform = `translate3d(${active.offsetLeft}px, 0, 0)`;

    if (instant) {
        void pill.offsetWidth; // force reflow
        group.classList.remove('no-pill-anim');
    }
}

/**
 * Updates sliding pills in all visible .hud-pill-group elements within a root container.
 * @param {ParentNode} [root=document]
 * @param {boolean} [instant=false]
 */
export function refreshAllSlidingPills(root = document, instant = false) {
    const groups = root.querySelectorAll('.hud-pill-group');
    groups.forEach(g => updateSlidingPill(g, instant));
}

/**
 * Initializes automatic sliding pill behavior on all .hud-pill-group elements.
 */
export function initSlidingPills() {
    window.refreshSlidingPills = refreshAllSlidingPills;

    // Event delegation on clicks and input changes within .hud-pill-group
    document.addEventListener('click', (e) => {
        const group = e.target.closest('.hud-pill-group');
        if (group && isSegmentedGroup(group)) {
            requestAnimationFrame(() => updateSlidingPill(group));
        }
    }, { passive: true });

    document.addEventListener('change', (e) => {
        const group = e.target.closest('.hud-pill-group');
        if (group && isSegmentedGroup(group)) {
            requestAnimationFrame(() => updateSlidingPill(group));
        }
    }, { passive: true });

    // Handle Bootstrap dropdown / modal / offcanvas open events
    ['shown.bs.dropdown', 'shown.bs.offcanvas', 'shown.bs.modal', 'shown.bs.collapse'].forEach(evt => {
        document.addEventListener(evt, (e) => {
            const root = e.target || document;
            requestAnimationFrame(() => refreshAllSlidingPills(root, true));
        });
    });

    // Observer for body class changes (e.g. library open/close)
    const observer = new MutationObserver(() => {
        requestAnimationFrame(() => refreshAllSlidingPills(document, true));
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

    // Handle window resize
    window.addEventListener('resize', () => {
        requestAnimationFrame(() => refreshAllSlidingPills(document, true));
    }, { passive: true });

    // Initial update
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => refreshAllSlidingPills(document, true));
    } else {
        refreshAllSlidingPills(document, true);
    }
}
