// gpHandler.js.new
import { loadGuitarPro } from './gpProcessor.js';
import { hideLoadingBar } from '../main.js';
import { getPagesPerView } from '../utils/viewModeUtils.js';
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
    // Immediately select continuous mode
    continuousModeRadio.checked = true;
    pageModeRadio.checked = false;
    continuousModeRadio.dispatchEvent(new Event('change', { bubbles: true }));

    // Reset state and clear output
    gpState.reset();
    clearOutput(output);

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

    // Init AlphaTab container
    const container = document.createElement('div');
    container.className = 'alphaTabContainer';
    output.appendChild(container);

    try {
        const api = await loadGuitarPro(dataToLoad, container, { debug });
        gpState.canvases = [{ container }];

        api.postRenderFinished.on(() => {
            // Show continuous mode by default (layout calculated on-demand in page mode)
            clearOutput(output);
            output.classList.add('continuous-mode');
            output.appendChild(container);
            output.scrollTop = 0;
        });
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
        wrapper.style.maxWidth = `${pageWidth}px`;
        wrapper.style.padding = '20px';
        wrapper.style.boxSizing = 'border-box';
        wrapper.style.overflow = 'hidden';

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
            clone.style.width = '100%';
            clone.style.maxWidth = '100%';
            clone.style.overflow = 'visible';

            // Scale SVG to fit within container
            const svg = clone.querySelector('svg');
            if (svg) {
                // Get the natural width from viewBox or current width
                const viewBox = svg.getAttribute('viewBox');
                let naturalWidth = svg.width.baseVal.value;

                // Only use viewBox if it exists and is valid
                if (viewBox && viewBox !== 'null' && viewBox.includes(' ')) {
                    const vbWidth = parseFloat(viewBox.split(' ')[2]);
                    if (!isNaN(vbWidth)) {
                        naturalWidth = vbWidth;
                    }
                }

                // Calculate scale to fit within page width (minus padding)
                const availableWidth = pageWidth - 40;
                const scale = (naturalWidth > 0 && naturalWidth > availableWidth) ? availableWidth / naturalWidth : 1;

                // Apply scaling by setting explicit dimensions
                if (scale < 1) {
                    const scaledWidth = naturalWidth * scale;
                    const scaledHeight = svg.height.baseVal.value * scale;

                    // Set viewBox if it doesn't exist - this is crucial for proper scaling
                    if (!viewBox || viewBox === 'null') {
                        const originalWidth = svg.width.baseVal.value;
                        const originalHeight = svg.height.baseVal.value;
                        svg.setAttribute('viewBox', `0 0 ${originalWidth} ${originalHeight}`);
                    }

                    svg.setAttribute('width', scaledWidth);
                    svg.setAttribute('height', scaledHeight);
                    svg.style.width = `${scaledWidth}px`;
                    svg.style.height = `${scaledHeight}px`;
                    clone.style.width = `${scaledWidth}px`;
                    clone.style.height = `${scaledHeight}px`;
                } else {
                    svg.style.width = '100%';
                    svg.style.height = 'auto';
                }

                svg.style.display = 'block';
                svg.style.maxWidth = '100%';
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