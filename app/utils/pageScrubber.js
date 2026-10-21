// pageScrubber.js
// Popover slider shown when tapping the page indicator, to scrub across pages (page mode)
// or across the scroll range (continuous mode).
import { getPagesPerView } from './viewModeUtils.js';

/**
 * @param {HTMLElement} indicator The #pageIndicator element
 * @param {Function} getConfig Returns the navigation config (see getNavigationConfig in main.js)
 */
export function setupPageScrubber(indicator, getConfig) {
    let popover = null;
    let slider = null;
    let label = null;
    let syncTimer = null;

    const isPageMode = (config) => !!(config.pageModeChecked || config.pageModeRadio?.checked);

    function getState(config) {
        if (!config.currentFile) return null;
        const output = config.output;
        if (!isPageMode(config)) {
            const range = output.scrollHeight - output.clientHeight;
            if (range <= 0) return null;
            return {
                continuous: true,
                min: 0,
                max: 100,
                value: Math.round(output.scrollTop / range * 100)
            };
        }
        let total = 0;
        let value = 0;
        if (config.gpState?.canvases[0]) {
            total = config.gpState.pages.length;
            value = config.gpState.currentPageIndex;
        } else if (config.textState?.pages?.length > 0) {
            total = config.textState.pages.length;
            value = config.textState.currentPageIndex;
        } else {
            total = config.getPages?.().length || 0;
            value = config.getCurrentPageIndex?.() || 0;
        }
        if (total <= 0) return null;
        const perView = getPagesPerView();
        return { continuous: false, min: 0, max: Math.max(0, total - perView), total, perView, value };
    }

    function labelFor(state, value) {
        if (state.continuous) return `${value}%`;
        const end = Math.min(value + state.perView, state.total);
        return state.perView > 1 ? `${value + 1}-${end} of ${state.total}` : `${value + 1} of ${state.total}`;
    }

    function applyValue(config, state, value) {
        if (state.continuous) {
            const out = config.output;
            out.scrollTop = value / 100 * (out.scrollHeight - out.clientHeight);
            return;
        }
        if (config.gpState?.canvases[0]) {
            if (config.gpState.currentPageIndex === value) return;
            config.gpState.currentPageIndex = value;
            config.renderGPPage(config.output, true, config.continuousModeRadio);
        } else if (config.textState?.pages?.length > 0) {
            if (config.textState.currentPageIndex === value) return;
            config.textState.currentPageIndex = value;
            config.renderTextPage(config.output, true);
        } else {
            if (config.getCurrentPageIndex?.() === value) return;
            config.setCurrentPageIndex(value);
            config.updatePageDisplay?.();
        }
    }

    function close() {
        if (!popover) return;
        popover.remove();
        popover = null;
        clearInterval(syncTimer);
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
    }

    function onOutside(e) {
        if (popover && !popover.contains(e.target) && !indicator.contains(e.target)) close();
    }

    function onKey(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
        }
    }

    function open() {
        const config = getConfig();
        const state = getState(config);
        if (!state || state.max <= state.min) return;

        popover = document.createElement('div');
        popover.className = 'page-scrubber-popover';
        label = document.createElement('div');
        label.className = 'page-scrubber-label';
        slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'form-range page-scrubber-slider';
        slider.min = state.min;
        slider.max = state.max;
        slider.step = 1;
        slider.value = state.value;
        label.textContent = labelFor(state, state.value);
        popover.append(label, slider);
        document.body.appendChild(popover);

        const rect = indicator.getBoundingClientRect();
        const width = popover.offsetWidth;
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
        popover.style.left = `${left}px`;
        popover.style.top = `${rect.bottom + 8}px`;

        let dragging = false;
        slider.addEventListener('pointerdown', () => { dragging = true; });
        slider.addEventListener('pointerup', () => { dragging = false; });
        slider.addEventListener('input', () => {
            const cfg = getConfig();
            const st = getState(cfg) || state;
            const v = parseInt(slider.value, 10);
            label.textContent = labelFor(st, v);
            applyValue(cfg, st, v);
        });
        // Keep the slider in sync if the page changes while it is open
        syncTimer = setInterval(() => {
            if (dragging || !slider) return;
            const st = getState(getConfig());
            if (!st) return;
            slider.max = st.max;
            slider.value = st.value;
            label.textContent = labelFor(st, st.value);
        }, 400);

        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
    }

    indicator.style.cursor = 'pointer';
    indicator.setAttribute('role', 'button');
    indicator.addEventListener('click', () => {
        if (popover) close();
        else open();
    });
}
