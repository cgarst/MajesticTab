// renderUtils.js
import { getPagesPerView } from './viewModeUtils.js';

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
    const scrollPercent = (container.scrollTop / (container.scrollHeight - container.clientHeight) * 100) || 0;
    indicator.textContent = `${Math.round(scrollPercent)}%`;
}

const PAGE_PADDING = 20;

/**
 * Layout pages for display in page mode
 * @param {Array} condensedCanvases Array of canvases to layout
 * @param {Array} pages Array to store page layouts
 * @param {number} currentPageIndex Current page index
 * @returns {number} Updated current page index
 */
export function layoutPages(condensedCanvases) {
    const pages = [];
    const pageHeight = window.innerHeight - 80 - PAGE_PADDING;
    const pageWidth = window.innerWidth - 40;
    const pagesPerView = getPagesPerView(false); // false = PDF mode
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
        // Initial scale based on width
        let scale = pageWidth / canvas.width / pagesPerView;
        let scaledHeight = canvas.height * scale;

        // If this canvas is taller than the page, scale it to fit
        if (scaledHeight > pageHeight) {
            scale = (pageHeight / canvas.height);
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
            scale = pageHeight / canvas.height;
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
    outerContainer.style.backgroundColor = 'white';
    outerContainer.style.overflow = 'hidden';

    // Create page container
    const container = document.createElement('div');
    container.className = 'pageContainer';

    const startIndex = currentPageIndex;
    const pagesPerView = getPagesPerView(false); // false = PDF mode
    
    for (let i = 0; i < pagesPerView; i++) {
        const pageSet = pages[startIndex + i];
        if (!pageSet) break;

        const wrapper = document.createElement('div');
        wrapper.className = 'pageWrapper';
        wrapper.style.width = `${(window.innerWidth - 40) / pagesPerView}px`;
        wrapper.style.height = `${window.innerHeight - 80}px`;
        wrapper.style.paddingTop = `${PAGE_PADDING}px`;
        wrapper.style.backgroundColor = 'white';
        wrapper.style.float = 'left';
        wrapper.style.marginRight = '10px';
        wrapper.style.boxShadow = '0 2px 6px rgba(0,0,0,0.1)';
        wrapper.style.border = '1px solid #ddd';

        pageSet.forEach((page, idx) => {
            const canvas = page.canvas;
            canvas.style.width = `${canvas.width * page.scale}px`;
            canvas.style.height = 'auto';
            if (idx > 0) {
                canvas.style.marginTop = '10px'; // Add gap between canvases
            }
            wrapper.appendChild(canvas);
        });

        const pageNumber = document.createElement('div');
        pageNumber.className = 'pageNumber';
        pageNumber.style.position = 'absolute';
        pageNumber.style.bottom = '10px';
        pageNumber.style.right = '10px';
        pageNumber.style.color = '#666';
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