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
    reset() {
        this.canvases.length = 0;
        this.pages.length = 0;
        this.currentPageIndex = 0;
    }
};

/**
 * Load a Guitar Pro file into the app.
 */
export async function loadGP(file, output, pageModeRadio, continuousModeRadio, shrink = false, debug = false) {
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
        const api = await loadGuitarPro(dataToLoad, container, { shrink, debug });
        gpState.canvases = [{ container }];

        api.postRenderFinished.on(() => {
            // Layout pages
            const pageHeight = output.clientHeight - 20;
            gpState.pages = layoutGPPages(container, pageHeight);
            
            // Show continuous mode by default
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
        // Always recalculate pages in page mode to ensure proper sizing
        const pageHeight = output.clientHeight - 20;
        gpState.pages = layoutGPPages(gpState.canvases[0].container, pageHeight);
        renderGPPageMode(output);
    } else {
        // Make sure the container is detached before reattaching
        const container = gpState.canvases[0].container;
        if (container.parentNode) {
            container.parentNode.removeChild(container);
        }
        container.style.transform = '';
        container.style.transformOrigin = '';
        
        output.classList.add('continuous-mode');
        output.appendChild(container);
        output.scrollTop = 0;
    }
}

/**
 * Layout GP pages based on block heights
 */
export function layoutGPPages(container, pageHeight) {
    const blocks = Array.from(container.querySelectorAll("div.at-surface.at > div"));
    const offscreen = document.createElement('div');
    offscreen.style.position = 'absolute';
    offscreen.style.visibility = 'hidden';
    offscreen.style.width = `${container.clientWidth}px`;
    offscreen.style.height = `${pageHeight}px`;  // Set height to match target page height
    document.body.appendChild(offscreen);

    // Account for padding and gaps between blocks
    const effectivePageHeight = pageHeight - (PAGE_PADDING * 2);
    
    const pages = [];
    let currentPage = [];
    let currentHeight = 0;

    blocks.forEach((block) => {
        const clone = block.cloneNode(true);
        offscreen.appendChild(clone);
        const blockHeight = clone.offsetHeight;
        const blockWithSpacing = blockHeight + PAGE_PADDING; // Add spacing between blocks

        // If adding this block would exceed page height and we already have blocks, start a new page
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
    const containerWrapper = createPageContainer();
    containerWrapper.className = 'gp-page-container';

    for (let i = 0; i < pagesPerView; i++) {
        const pageIndex = gpState.currentPageIndex + i;
        const pageSet = gpState.pages[pageIndex];
        if (!pageSet) break;

        const wrapper = createPageWrapper();
        wrapper.className = 'gp-page-wrapper';
        wrapper.style.width = `${(100 / pagesPerView)}%`;
        wrapper.style.maxWidth = `${(window.innerWidth - 40) / pagesPerView}px`;

        const contentContainer = document.createElement('div');
        contentContainer.className = 'alphaTab-gp-content';

        pageSet.forEach(div => {
            const clone = div.cloneNode(true);
            clone.style.maxWidth = '100%'; // Ensure content doesn't overflow
            contentContainer.appendChild(clone);
        });
        wrapper.appendChild(contentContainer);

        const pnum = document.createElement('div');
        pnum.className = 'pageNumber';
        pnum.textContent = `${pageIndex + 1}/${gpState.pages.length}`;
        wrapper.appendChild(pnum);

        containerWrapper.appendChild(wrapper);
    }

        // Scale SVGs to fit wrapper width while preserving aspect ratio
        containerWrapper.querySelectorAll('.pageWrapper').forEach(wrapper => {
            wrapper.querySelectorAll('svg').forEach(svg => {
                // First set the SVG to fill its container width
                svg.style.width = '100%';
                svg.style.height = 'auto';
                svg.style.maxWidth = '100%';
                
                // Remove any transform since we're using responsive sizing
                svg.style.transform = '';
                svg.style.transformOrigin = '';
            });
        });
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
 * Navigate to next GP page
 * @returns {boolean} Whether navigation was successful
 */
export function nextGPPage() {
    if (!gpState.pages.length) return false;
    const newIndex = Math.min(gpState.currentPageIndex + 1, Math.max(0, gpState.pages.length - getPagesPerView()));
    if (newIndex !== gpState.currentPageIndex) {
        gpState.currentPageIndex = newIndex;
        return true;
    }
    return false;
}

/**
 * Navigate to previous GP page
 * @returns {boolean} Whether navigation was successful
 */
export function prevGPPage() {
    if (!gpState.pages.length) return false;
    const newIndex = Math.max(0, gpState.currentPageIndex - 1);
    if (newIndex !== gpState.currentPageIndex) {
        gpState.currentPageIndex = newIndex;
        return true;
    }
    return false;
}