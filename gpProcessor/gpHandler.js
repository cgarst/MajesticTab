// gpHandler.js.new
import { loadGuitarPro } from './gpProcessor.js';
import { hideLoadingBar } from '../main.js';
import { getPagesPerView, switchToPageMode } from '../utils/viewModeUtils.js';
import { createPageWrapper, createPageContainer, clearOutput, updatePageIndicator } from '../utils/renderUtils.js';

const PAGE_PADDING = 10;

// State management
export const gpState = {
    currentPageIndex: 0,
    canvases: [],
    pages: [],
    lastLayoutDimensions: null, // Cache layout dimensions
    reset() {
        this.canvases.length = 0;
        this.pages.length = 0;
        this.currentPageIndex = 0;
        this.lastLayoutDimensions = null;
    }
};

/**
 * Load a Guitar Pro file into the app.
 */
export async function loadGP(file, output, pageModeRadio, continuousModeRadio, debug = false) {
    // We want page mode, but render continuous first to let AlphaTab size properly
    const targetPageMode = true;

    // Temporarily set continuous mode for initial render
    continuousModeRadio.checked = true;
    pageModeRadio.checked = false;

    // Reset state and clear output
    gpState.reset();
    gpState.lastLayoutDimensions = null; // Force fresh layout calculation
    clearOutput(output);

    // Ensure output is visible for alphaTab sizing
    output.style.display = 'flex';
    output.style.overflowY = 'auto';

    // Load file
    let dataToLoad;
    if (file instanceof File) {
        dataToLoad = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    } else {
        dataToLoad = file;
    }

    // Init AlphaTab container with width for target page mode
    const container = document.createElement('div');
    container.className = 'alphaTabContainer';

    // Calculate width for page mode (2 pages side-by-side)
    const pagesPerView = getPagesPerView(true);
    const targetWidth = Math.floor((window.innerWidth - 80) / pagesPerView) - 60; // More conservative for better fit

    container.style.width = `${targetWidth}px`;
    container.style.height = '100%';
    container.style.display = 'block';
    container.style.margin = '0 auto'; // Center it
    output.appendChild(container);

    console.log('[GP Init] ========================================');
    console.log('[GP Init] Window width:', window.innerWidth);
    console.log('[GP Init] Pages per view:', pagesPerView);
    console.log('[GP Init] Calculated container width:', targetWidth, 'px');
    console.log('[GP Init] ========================================');

    // Force a layout before creating AlphaTab API
    void container.offsetHeight;

    try {
        const api = await loadGuitarPro(dataToLoad, container, { debug });
        gpState.canvases = [{ container }];

        // Rendering is complete (promise resolved), now set up display
        // First render in continuous mode (simple, no layout needed)
        renderGPPage(output, false, continuousModeRadio);

        console.log('[GP Mode Switch] Continuous rendered, switching to page mode...');

        // Then switch to page mode after DOM settles
        if (targetPageMode) {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    console.log('[GP Mode Switch] Executing switch to page mode');
                    pageModeRadio.checked = true;
                    continuousModeRadio.checked = false;
                    renderGPPage(output, true, continuousModeRadio);
                    console.log('[GP Mode Switch] Page mode rendered');
                });
            });
        }
    } catch (err) {
        console.error('Error loading Guitar Pro file:', err);
        hideLoadingBar();
    }
}

/**
 * Render GP pages based on view mode
 */
export function renderGPPage(output, pageModeChecked, continuousModeRadio) {
    if (!gpState.canvases[0]?.container) return;
    
    // Always clear output before rendering
    clearOutput(output);

    if (pageModeChecked) {
        // renderGPPageMode will handle layout calculation with caching
        renderGPPageMode(output);
    } else {
        // Make sure the container is detached before reattaching
        const container = gpState.canvases[0].container;
        if (container.parentNode) {
            container.parentNode.removeChild(container);
        }
        container.style.transform = '';
        container.style.transformOrigin = '';
        
        // Set up continuous mode view
        output.classList.add('continuous-mode');
        output.style.overflowY = 'auto';  // Explicitly enable vertical scrolling
        output.style.overflowX = 'hidden'; // Prevent horizontal scrolling
        output.appendChild(container);
        output.scrollTop = 0;
    }
}

/**
 * Layout GP pages based on block heights
 * @param {HTMLElement} container - The alphaTab container
 * @param {number} pageHeight - Available height for each page
 * @param {number} pageWidth - Available width for each page (optional, defaults to container width)
 */
export function layoutGPPages(container, pageHeight, pageWidth = null) {
    // Get all score parts (includes both the div container and its SVG content)
    const blocks = Array.from(container.querySelectorAll("div.at-surface.at > div"));
    const offscreen = document.createElement('div');
    offscreen.style.position = 'absolute';
    offscreen.style.visibility = 'hidden';
    offscreen.style.width = `${pageWidth || container.clientWidth}px`;
    offscreen.style.height = `${pageHeight}px`;
    offscreen.style.overflow = 'hidden'; // Prevent any overflow issues during measurement
    document.body.appendChild(offscreen);

    // Account for padding and gaps between blocks
    const effectivePageHeight = pageHeight - (PAGE_PADDING * 2);
    
    const pages = [];
    let currentPage = [];
    let currentHeight = 0;

    blocks.forEach((block) => {
        // Deep clone the block and all its content (including SVGs)
        const clone = block.cloneNode(true);
        
        // Reset positioning to get accurate measurements
        clone.style.position = 'relative';
        clone.style.top = 'auto';
        clone.style.left = 'auto';
        clone.style.maxWidth = '100%';
        clone.style.display = 'block';
        
        // Ensure SVGs are properly carried over
        const originalSvg = block.querySelector('svg');
        const clonedSvg = clone.querySelector('svg');
        if (originalSvg && clonedSvg) {
            // Copy any dynamic properties that might not be cloned
            clonedSvg.setAttribute('viewBox', originalSvg.getAttribute('viewBox'));
            clonedSvg.style.width = '100%';
            clonedSvg.style.height = 'auto';
            clonedSvg.style.display = 'block';
        }

        offscreen.appendChild(clone);
        
        // Force a reflow and ensure proper measurement
        void offscreen.offsetHeight;
        const blockHeight = clone.getBoundingClientRect().height;
        const blockWithSpacing = blockHeight + PAGE_PADDING;

        // Start a new page if current block won't fit
        if (currentHeight + blockWithSpacing > effectivePageHeight && currentPage.length) {
            pages.push(currentPage);
            currentPage = [];
            currentHeight = 0;
        }

        currentPage.push(clone);
        currentHeight += blockWithSpacing;
    });

    if (currentPage.length) {
        pages.push(currentPage);
    }

    document.body.removeChild(offscreen);
    return pages;
}

/**
 * Render in page mode
 */
function renderGPPageMode(output) {
    clearOutput(output);
    const pagesPerView = getPagesPerView(true); // true = Guitar Pro mode

    // Only recalculate if dimensions changed
    const pageHeight = output.clientHeight - 20;
    const pageWidth = (window.innerWidth - 40) / pagesPerView;
    const currentDimensions = { pageHeight, pageWidth, pagesPerView };

    console.log('[GP Layout Debug] Calculating dimensions:', {
        windowWidth: window.innerWidth,
        pagesPerView,
        calculatedPageWidth: pageWidth,
        outputHeight: output.clientHeight,
        calculatedPageHeight: pageHeight
    });

    // Check if we need to recalculate layout
    const needsRecalc = !gpState.lastLayoutDimensions ||
        gpState.lastLayoutDimensions.pageHeight !== pageHeight ||
        gpState.lastLayoutDimensions.pageWidth !== pageWidth ||
        gpState.lastLayoutDimensions.pagesPerView !== pagesPerView;

    if (needsRecalc) {
        gpState.pages = layoutGPPages(gpState.canvases[0].container, pageHeight, pageWidth);
        gpState.lastLayoutDimensions = currentDimensions;
    }

    const containerWrapper = createPageContainer();
    containerWrapper.className = 'gp-page-container';

    for (let i = 0; i < pagesPerView; i++) {
        const pageIndex = gpState.currentPageIndex + i;
        const pageSet = gpState.pages[pageIndex];
        if (!pageSet) break;

        const wrapper = createPageWrapper();
        wrapper.className = 'gp-page-wrapper';
        wrapper.style.width = `${(100 / pagesPerView)}%`;
        wrapper.style.padding = '20px';
        wrapper.style.boxSizing = 'border-box';
        wrapper.style.overflow = 'auto'; // Allow scroll if content is larger

        const contentContainer = document.createElement('div');
        contentContainer.className = 'alphaTab-gp-content';
        contentContainer.style.width = '100%';
        contentContainer.style.display = 'flex';
        contentContainer.style.flexDirection = 'column';
        contentContainer.style.alignItems = 'center';

        pageSet.forEach((div, idx) => {
            const clone = div.cloneNode(true);

            // Reset positioning
            clone.style.position = 'relative';
            clone.style.top = 'auto';
            clone.style.left = 'auto';
            clone.style.display = 'block';
            clone.style.marginBottom = '10px';
            clone.style.maxWidth = '100%';
            clone.style.overflow = 'visible';

            // Keep SVG at its rendered size, don't scale up
            const svg = clone.querySelector('svg');
            if (svg) {
                // Set viewBox if it doesn't exist - crucial for proper scaling
                const viewBox = svg.getAttribute('viewBox');
                if ((!viewBox || viewBox === 'null') && svg.width.baseVal.value > 0) {
                    const originalWidth = svg.width.baseVal.value;
                    const originalHeight = svg.height.baseVal.value;
                    svg.setAttribute('viewBox', `0 0 ${originalWidth} ${originalHeight}`);
                }

                // Keep the rendered size, don't scale up
                const renderedWidth = svg.width.baseVal.value;
                svg.style.width = `${renderedWidth}px`;
                svg.style.height = 'auto';
                svg.style.maxWidth = '100%'; // Can scale down if needed
                svg.style.display = 'block';
            }

            contentContainer.appendChild(clone);
        });

        wrapper.appendChild(contentContainer);

        const pnum = document.createElement('div');
        pnum.className = 'pageNumber';
        pnum.textContent = `${pageIndex + 1}/${gpState.pages.length}`;
        wrapper.appendChild(pnum);

        containerWrapper.appendChild(wrapper);
    }
        output.appendChild(containerWrapper);
    updatePageIndicator(
        document.getElementById('pageIndicator'), 
        gpState.currentPageIndex,
        gpState.pages.length,
        pagesPerView
    );
}

/**
 * Navigation functions
 */
/**
 * Navigate to next GP page and re-render
 * @param {HTMLElement} output - The output container element
 * @returns {boolean} Whether navigation was successful
 */
export function nextGPPage(output) {
    if (!gpState.pages.length) return false;
    const newIndex = Math.min(gpState.currentPageIndex + 1, Math.max(0, gpState.pages.length - getPagesPerView()));
    if (newIndex !== gpState.currentPageIndex) {
        gpState.currentPageIndex = newIndex;
        if (output) {
            renderGPPageMode(output);
        }
        return true;
    }
    return false;
}

/**
 * Navigate to previous GP page and re-render
 * @param {HTMLElement} output - The output container element
 * @returns {boolean} Whether navigation was successful
 */
export function prevGPPage(output) {
    if (!gpState.pages.length) return false;
    const newIndex = Math.max(0, gpState.currentPageIndex - 1);
    if (newIndex !== gpState.currentPageIndex) {
        gpState.currentPageIndex = newIndex;
        if (output) {
            renderGPPageMode(output);
        }
        return true;
    }
    return false;
}