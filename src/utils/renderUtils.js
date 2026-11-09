// renderUtils.js
import { getPagesPerView } from './viewModeUtils.js';
import { canvasSize } from '../pdfProcessor/lazyPages.js';

/**
 * Common utilities for rendering content
 */

/**
 * Create a page wrapper element
 * @param {string} className Class name for the wrapper
 * @returns {HTMLElement} Page wrapper element
 */
export function createPageWrapper(className = 'pageWrapper') {
    const wrapper = document.createElement('div');
    wrapper.className = className;
    return wrapper;
}

/**
 * Create a container for multiple pages
 * @param {string} className Class name for the container
 * @returns {HTMLElement} Page container element
 */
export function createPageContainer(className = 'pageContainer') {
    const container = document.createElement('div');
    container.className = className;
    return container;
}

/**
 * Clear and prepare output container
 * @param {HTMLElement} output Output container element
 */
export function clearOutput(output) {
    output.innerHTML = '';
    output.scrollTop = 0;
}

/**
 * Update page indicator text
 * @param {HTMLElement} indicator Page indicator element
 * @param {number} current Current page/index
 * @param {number} total Total pages/items
 * @param {number} pagesPerView Number of pages being displayed (for page mode)
 */
export function updatePageIndicator(indicator, current, total, pagesPerView = 1) {
    if (pagesPerView > 1) {
        const endPage = Math.min(current + pagesPerView - 1, total);
        indicator.textContent = `${current + 1}-${endPage + 1} of ${total}`;
    } else {
        indicator.textContent = `${current + 1} of ${total}`;
    }
}

/**
 * Update continuous mode scroll indicator
 * @param {HTMLElement} indicator Indicator element
 * @param {HTMLElement} container Scrollable container
 * @param {number} totalItems Total number of items
 */
export function updateScrollIndicator(indicator, container, totalItems) {
    if (!indicator) return;
    const scrollPercent = (container.scrollTop / (container.scrollHeight - container.clientHeight) * 100) || 0;
    indicator.textContent = `${Math.round(scrollPercent)}%`;
}

const PAGE_PADDING_DEFAULT = 20;
// Folded Duo: the page starts at the top of the score half, with no gap above it
const pagePad = () => (document.documentElement.classList.contains('duo-tabletop') && !document.body.classList.contains('reading-mode') ? 0 : PAGE_PADDING_DEFAULT);

/** The iPhone Duo folded on its crease: the score half is wide and short, so a tall page is read in bands. */
const inTabletop = () => document.documentElement.classList.contains('duo-tabletop') && !document.body.classList.contains('reading-mode');

/**
 * A y near `target` (source pixels) where the canvas has a blank row, so a band never cuts through a line of tab.
 * A canvas whose pixels are not loaded yet (lazy page) or cannot be read gets the plain target.
 */
function findBlankRow(canvas, target, reach) {
    try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const w = canvas.width, h = canvas.height;
        if (!ctx || !w || !h) return target;
        const lo = Math.max(1, Math.floor(target - reach)), hi = Math.min(h - 1, Math.ceil(target + reach));
        if (hi <= lo) return target;
        const data = ctx.getImageData(0, lo, w, hi - lo).data;
        const rowBlank = (r) => {
            const o = r * w * 4;
            for (let x = 0; x < w; x++) {
                const i = o + x * 4;
                if (data[i + 3] > 8 && (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200)) return false;
            }
            return true;
        };
        // The blank run closest to the target; cut through its middle
        let best = null;
        let runStart = -1;
        for (let r = 0; r <= hi - lo; r++) {
            const blank = r < hi - lo && rowBlank(r);
            if (blank && runStart < 0) runStart = r;
            if (!blank && runStart >= 0) {
                const mid = lo + (runStart + r) / 2;
                if (best === null || Math.abs(mid - target) < Math.abs(best - target)) best = mid;
                runStart = -1;
            }
        }
        return best === null ? target : Math.round(best);
    } catch {
        return target;
    }
}

/** Cut a canvas that is taller than one view (at full width) into near-equal bands, each [srcY, srcY + srcH). */
function bandsFor(canvas, canvasH, scale, pageHeight) {
    const n = Math.max(2, Math.ceil((canvasH * scale) / pageHeight));
    const step = canvasH / n;
    const cuts = [0];
    for (let k = 1; k < n; k++) cuts.push(findBlankRow(canvas, k * step, step * 0.2));
    cuts.push(canvasH);
    const bands = [];
    for (let k = 0; k < n; k++) bands.push({ srcY: cuts[k], srcH: cuts[k + 1] - cuts[k] });
    return bands;
}

/**
 * Size of the box a page may use, measured from the real #output area (below the top bar,
 * above the dock or fretboard) and the page container's own padding, so a page never runs
 * past the bottom edge.
 */
function pageBox() {
    const output = document.getElementById('output');
    const outH = output?.clientHeight || (window.innerHeight - 80);
    const outW = output?.clientWidth || window.innerWidth;
    let padV = 40, padH = 40, wrapPadH = 0;
    if (output) {
        const probe = document.createElement('div');
        probe.className = 'pageContainer';
        probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:0;height:0;min-height:0';
        output.appendChild(probe);
        const cs = getComputedStyle(probe);
        padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        padH = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        probe.remove();
        // The page wrapper pads its own sides too: a page at the full width must fit inside that
        const wprobe = document.createElement('div');
        wprobe.className = 'pageWrapper';
        wprobe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:0;height:0;min-height:0';
        output.appendChild(wprobe);
        const ws = getComputedStyle(wprobe);
        wrapPadH = (parseFloat(ws.paddingLeft) || 0) + (parseFloat(ws.paddingRight) || 0)
            + (parseFloat(ws.borderLeftWidth) || 0) + (parseFloat(ws.borderRightWidth) || 0);
        wprobe.remove();
    }
    // 2px for the wrapper border
    return { wrapperHeight: Math.max(100, Math.floor(outH - padV - 2)), width: Math.max(100, outW - padH), wrapPadH };
}

/**
 * Layout pages for display in page mode
 * @param {Array} condensedCanvases Array of canvases to layout
 * @param {Array} pages Array to store page layouts
 * @param {number} currentPageIndex Current page index
 * @returns {number} Updated current page index
 */
export function layoutPages(condensedCanvases) {
    const pages = [];
    const { wrapperHeight, width, wrapPadH } = pageBox();
    const pageHeight = wrapperHeight - pagePad();
    const pageWidth = width;
    const pagesPerView = getPagesPerView('pdf');
    const pageGap = 10; // Gap between canvases on the same page
    const tabletop = inTabletop();

    // Don't try to layout if we don't have any canvases
    if (condensedCanvases.length === 0) {
        return { pages, newIndex: 0 };
    }

    let currentPage = [];
    let usedHeight = 0;
    let currentPageIndex = 0;

    for (let i = 0; i < condensedCanvases.length; i++) {
        const canvas = condensedCanvases[i];
        // Lazy pages keep their size while their pixels are not loaded
        const { w: canvasW, h: canvasH } = canvasSize(canvas);
        // Initial scale based on width
        let scale = pageWidth / canvasW / pagesPerView;
        let scaledHeight = canvasH * scale;

        // Folded Duo: keep the width-fit size and read the page in bands (a page turn moves one band)
        if (tabletop && scaledHeight > pageHeight * 1.05) {
            scale = (pageWidth - wrapPadH) / canvasW;
            scaledHeight = canvasH * scale;
            if (currentPage.length > 0) { pages.push(currentPage); currentPage = []; usedHeight = 0; }
            for (const band of bandsFor(canvas, canvasH, scale, pageHeight)) pages.push([{ canvas, scale, ...band }]);
            continue;
        }

        // If this canvas is taller than the page, scale it to fit
        if (scaledHeight > pageHeight) {
            scale = (pageHeight / canvasH);
            scaledHeight = pageHeight;
        }
        
        // Check if adding this canvas (plus gap) would exceed page height
        if (usedHeight + scaledHeight + (currentPage.length > 0 ? pageGap : 0) > pageHeight) {
            // Only start a new page if we have canvases in the current page
            if (currentPage.length > 0) {
                pages.push(currentPage);
                currentPage = [];
                usedHeight = 0;
            }

            // If this single canvas fits the page height, add it and continue
            if (scaledHeight <= pageHeight) {
                currentPage.push({ canvas, scale });
                usedHeight = scaledHeight;
                continue;
            }

            // If a single canvas is still too tall, scale it to fit exactly
            scale = pageHeight / canvasH;
            currentPage.push({ canvas, scale });
            pages.push(currentPage);
            currentPage = [];
            usedHeight = 0;
            continue;
        }

        // Add canvas to current page
        currentPage.push({ canvas, scale });
        usedHeight += scaledHeight + (currentPage.length > 1 ? pageGap : 0);
    }

    // Add remaining page if it has content
    if (currentPage.length > 0) {
        pages.push(currentPage);
    }

    return {
        pages,
        newIndex: Math.min(currentPageIndex, Math.max(0, pages.length - 1))
    };
}

/**
 * Render the current page(s)
 * @param {HTMLElement} output Output container element
 * @param {Array} pages Array of page layouts
 * @param {number} currentPageIndex Current page index
 * @param {Function} onPageRendered Callback after rendering is complete
 */
export function renderPage(output, pages, currentPageIndex, onPageRendered, onBandScroll) {
    if (!pages.length) return;

    clearOutput(output);

    // Create outer container that fills the viewport
    const outerContainer = document.createElement('div');
    outerContainer.style.width = '100%';
    outerContainer.style.height = '100%';
    outerContainer.style.overflow = 'hidden';

    // Create page container
    const container = document.createElement('div');
    container.className = 'pageContainer';

    const startIndex = currentPageIndex;
    const pagesPerView = getPagesPerView('pdf');
    const box = pageBox();
    
    const bandJobs = [];
    for (let i = 0; i < pagesPerView; i++) {
        const pageSet = pages[startIndex + i];
        if (!pageSet) break;

        const wrapper = document.createElement('div');
        wrapper.className = 'pageWrapper';
        wrapper.style.width = `${box.width / pagesPerView}px`;
        wrapper.style.height = `${box.wrapperHeight}px`;
        wrapper.style.paddingTop = `${pagePad()}px`;
        wrapper.style.boxSizing = 'border-box';

        pageSet.forEach((page, idx) => {
            const canvas = page.canvas;
            canvas.style.width = `${canvasSize(canvas).w * page.scale}px`;
            canvas.style.height = 'auto';
            canvas.style.marginTop = idx > 0 ? '10px' : ''; // Add gap between canvases
            if (page.srcH) {
                // One band of a tall page: a window onto the canvas, sized below once the wrapper is in the page
                const win = document.createElement('div');
                win.className = 'pageBand';
                canvas.style.maxWidth = 'none';
                canvas.style.display = 'block';
                win.appendChild(canvas);
                bandJobs.push({ win, canvas, wrapper, page, index: startIndex + i });
                wrapper.appendChild(win);
            } else {
                canvas.style.display = '';
                canvas.style.maxWidth = '';
                wrapper.appendChild(canvas);
            }
        });

        const pageNumber = document.createElement('div');
        pageNumber.className = 'pageNumber';
        pageNumber.textContent = `${startIndex + i + 1}/${pages.length}`;
        wrapper.appendChild(pageNumber);

        container.appendChild(wrapper);
    }

    outerContainer.appendChild(container);
    output.appendChild(outerContainer);

    for (const { win, canvas, wrapper, page, index } of bandJobs) {
        const ws = getComputedStyle(wrapper);
        const avail = wrapper.clientWidth - (parseFloat(ws.paddingLeft) || 0) - (parseFloat(ws.paddingRight) || 0);
        const sc = avail / canvasSize(canvas).w;
        // The window shows the whole page and opens at this band, so a staff the cut ran through can be scrolled into view
        const viewH = Math.min(canvasSize(canvas).h * sc, box.wrapperHeight - pagePad());
        win.style.cssText = `overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;box-sizing:content-box;padding:0;flex:none;width:${avail}px;height:${viewH}px;margin:0 auto`;
        canvas.style.width = `${avail}px`;
        canvas.style.marginTop = '0';
        win.scrollTop = page.srcY * sc;
        // Scrolling is how the player moves through the bands: the page position follows the band in the middle of the window
        let at = index;
        win.addEventListener('scroll', () => {
            const y = (win.scrollTop + win.clientHeight / 2) / sc; // the band in the middle of the window
            let next = at;
            for (let k = 0; k < pages.length; k++) {
                const b = pages[k][0];
                if (b && b.canvas === canvas && b.srcH && y >= b.srcY && y < b.srcY + b.srcH) { next = k; break; }
            }
            if (next === at) return;
            at = next;
            const num = wrapper.querySelector('.pageNumber');
            if (num) num.textContent = `${at + 1}/${pages.length}`;
            onBandScroll?.(at);
        }, { passive: true });
    }

    if (onPageRendered) {
        onPageRendered();
    }
}