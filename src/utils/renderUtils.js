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

const PAGE_PADDING = 20;

/**
 * Size of the box a page may use, measured from the real #output area (below the top bar,
 * above the dock or fretboard) and the page container's own padding, so a page never runs
 * past the bottom edge.
 */
function pageBox() {
    const output = document.getElementById('output');
    const outH = output?.clientHeight || (window.innerHeight - 80);
    const outW = output?.clientWidth || window.innerWidth;
    let padV = 40, padH = 40;
    if (output) {
        const probe = document.createElement('div');
        probe.className = 'pageContainer';
        probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:0;height:0;min-height:0';
        output.appendChild(probe);
        const cs = getComputedStyle(probe);
        padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        padH = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        probe.remove();
    }
    // 2px for the wrapper border
    return { wrapperHeight: Math.max(100, Math.floor(outH - padV - 2)), width: Math.max(100, outW - padH) };
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
    const { wrapperHeight, width } = pageBox();
    const pageHeight = wrapperHeight - PAGE_PADDING;
    const pageWidth = width;
    const pagesPerView = getPagesPerView('pdf');
    const pageGap = 10; // Gap between canvases on the same page

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
export function renderPage(output, pages, currentPageIndex, onPageRendered) {
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
    
    for (let i = 0; i < pagesPerView; i++) {
        const pageSet = pages[startIndex + i];
        if (!pageSet) break;

        const wrapper = document.createElement('div');
        wrapper.className = 'pageWrapper';
        wrapper.style.width = `${box.width / pagesPerView}px`;
        wrapper.style.height = `${box.wrapperHeight}px`;
        wrapper.style.paddingTop = `${PAGE_PADDING}px`;
        wrapper.style.boxSizing = 'border-box';

        pageSet.forEach((page, idx) => {
            const canvas = page.canvas;
            canvas.style.width = `${canvasSize(canvas).w * page.scale}px`;
            canvas.style.height = 'auto';
            if (idx > 0) {
                canvas.style.marginTop = '10px'; // Add gap between canvases
            }
            wrapper.appendChild(canvas);
        });

        const pageNumber = document.createElement('div');
        pageNumber.className = 'pageNumber';
        pageNumber.textContent = `${startIndex + i + 1}/${pages.length}`;
        wrapper.appendChild(pageNumber);

        container.appendChild(wrapper);
    }

    outerContainer.appendChild(container);
    output.appendChild(outerContainer);
    
    if (onPageRendered) {
        onPageRendered();
    }
}