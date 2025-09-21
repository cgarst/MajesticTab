// gpHandler.js.new
import { loadGuitarPro } from './gpProcessor.js';
import { hideLoadingBar } from '../main.js';
import { NavigationHandler } from '../utils/navigationUtils.js';
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
    container.style.width = '860px';
    container.style.margin = '0 auto';
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
            output.style.overflowY = 'auto';
            container.style.overflow = 'visible';
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
        container.style.width = '860px';
        container.style.margin = '0 auto';
        container.style.display = 'block';
        container.style.visibility = 'visible';
        container.style.position = 'relative';
        container.style.transform = '';
        container.style.transformOrigin = '';
        
        output.style.overflowY = 'auto';
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

    // Set up container styles for full height pages
    containerWrapper.style.height = '100%';
    containerWrapper.style.display = 'flex';
    containerWrapper.style.alignItems = 'stretch'; // Make children stretch to full height
    containerWrapper.style.gap = '10px';
    containerWrapper.style.padding = '10px';

    for (let i = 0; i < pagesPerView; i++) {
        const pageIndex = gpState.currentPageIndex + i;
        const pageSet = gpState.pages[pageIndex];
        if (!pageSet) break;

        const wrapper = createPageWrapper();
        wrapper.style.flex = '1'; // Make each wrapper take equal space
        wrapper.style.width = `${(100 / pagesPerView)}%`;
        wrapper.style.maxWidth = `${(window.innerWidth - 40) / pagesPerView}px`;
        wrapper.style.height = 'auto'; // Let it stretch with flex
        wrapper.style.display = 'flex';
        wrapper.style.flexDirection = 'column';
        wrapper.style.justifyContent = 'center';
        wrapper.style.alignItems = 'center';
        wrapper.style.margin = '0';
        wrapper.style.overflow = 'hidden';

        const contentContainer = document.createElement('div');
        contentContainer.style.display = 'flex';
        contentContainer.style.flexDirection = 'column';
        contentContainer.style.justifyContent = 'center';
        contentContainer.style.alignItems = 'center';
        contentContainer.style.flex = '1'; // Take up available space
        contentContainer.style.width = '100%';
        contentContainer.style.padding = '10px';
        contentContainer.style.boxSizing = 'border-box';

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
 * Render in continuous mode
 */
function renderGPContinuous(container, output) {
    clearOutput(output);
    
    // Ensure container is properly configured for continuous mode
    container.style.width = '860px';
    container.style.margin = '0 auto';
    container.style.display = 'block';
    container.style.visibility = 'visible';
    container.style.overflow = 'visible';
    
    // Reset any transforms that might have been applied in page mode
    container.style.transform = '';
    container.style.transformOrigin = '';
    
    // Make sure all AlphaTab elements are visible and properly positioned
    container.querySelectorAll('.at-surface').forEach(surface => {
        surface.style.display = 'block';
        surface.style.visibility = 'visible';
        surface.style.position = 'relative';
    });
    
    container.querySelectorAll('.at-surface > div').forEach(div => {
        div.style.display = 'block';
        div.style.visibility = 'visible';
        div.style.position = 'relative';
        div.style.top = '';
        div.style.left = '';
    });
    
    output.appendChild(container);
    
    // Force a reflow to ensure content is visible
    requestAnimationFrame(() => {
        output.style.overflowY = 'auto';
        container.style.overflow = 'visible';
        output.scrollTop = output.scrollTop;
    });
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