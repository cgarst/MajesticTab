// gpHandler.js.new
import { loadGuitarPro, GP_DISPLAY_SCALE } from './gpProcessor.js';
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
 * Move section rehearsal labels (Intro, Band Enter, etc.) upward when AlphaTab
 * renders them at the same y-row as above-staff accent/ornament glyphs.
 * Operates on the original rendered SVGs so the fix propagates to both
 * continuous mode (direct display) and page mode (clone-based display).
 *
 * When the label needs a negative SVG y, we use svg overflow:visible and add
 * paddingTop to the containing block div — this avoids any viewBox or height
 * change (which would cause scale distortion and uneven stave widths).
 */
function fixSectionLabelOverlaps(container) {
    // Pre-build the list of block divs (direct children of the at-surface div)
    // so we can efficiently find which block contains a given SVG.
    const blocks = Array.from(container.querySelectorAll('div.at-surface.at > div'));

    const svgs = container.querySelectorAll('svg');
    svgs.forEach(svg => {
        const allTexts = Array.from(svg.querySelectorAll('text'));

        // Section labels: bold Georgia font (AlphaTab renders rehearsal/section names this way).
        // Exclude tempo markings like "= 120" (no alphabetic characters) — those use the same
        // bold Georgia style but are rendered inline with the tempo glyph (♩), not above-staff.
        const labels = allTexts.filter(t => {
            const s = t.getAttribute('style') || '';
            return s.includes('bold') && s.includes('Georgia') && /[a-zA-Z]/.test(t.textContent);
        });
        if (labels.length === 0) return;

        // SMuFL glyph groups: find <g transform="translate(x y)"> elements that contain
        // a text with a percentage font-size. We use the translate-y as the visual position
        // rather than getBoundingClientRect(), because the alphaTab SMuFL font has a very
        // large em-box (spanning the full staff height) which inflates BCR far beyond the
        // actual visible glyph, making BCR-based overlap detection unreliable.
        const glyphGroups = Array.from(svg.querySelectorAll('g[transform]')).filter(g => {
            const t = g.querySelector('text');
            if (!t) return false;
            return /font-size:\s*[\d.]+%/.test(t.getAttribute('style') || '');
        });

        // LIFT: SVG units to place the label ABOVE the nearest glyph group translate-y.
        // Must account for both the label text height (~10.5px) and the fact that SMuFL
        // glyphs extend visually upward from their translate anchor point.
        const LIFT = 20;
        const PROXIMITY = 30; // SVG units — how close a glyph must be to count as nearby

        labels.forEach(label => {
            const labelY = parseFloat(label.getAttribute('y') || '0');
            if (isNaN(labelY)) return;

            // Find glyph groups whose translate-y is within the label's y-band
            const nearby = glyphGroups.filter(g => {
                const m = g.getAttribute('transform')
                    ?.match(/translate\s*\(\s*[-\d.]+\s*,?\s*([-\d.]+)\s*\)/);
                if (!m) return false;
                const gy = parseFloat(m[1]);
                return gy >= labelY - 5 && gy <= labelY + PROXIMITY;
            });
            if (nearby.length === 0) return;

            // Find the topmost glyph group translate-y
            let minGlyphY = Infinity;
            nearby.forEach(g => {
                const m = g.getAttribute('transform')
                    ?.match(/translate\s*\(\s*[-\d.]+\s*,?\s*([-\d.]+)\s*\)/);
                if (m) minGlyphY = Math.min(minGlyphY, parseFloat(m[1]));
            });
            if (minGlyphY === Infinity) return;

            // Target: place the label LIFT units above the topmost glyph anchor
            const targetY = minGlyphY - LIFT;
            if (targetY >= labelY) return; // already in a good position

            // If targetY is negative the label would be clipped by the SVG viewport.
            // Instead of changing the viewBox (which distorts vertical scale and makes
            // stave widths appear uneven), we:
            //   1. Allow the SVG to overflow its bounds (overflow:visible)
            //   2. Add paddingTop to the containing block div so the label has
            //      physical space above the SVG in the layout.
            // This keeps the SVG dimensions and scale completely unchanged.
            if (targetY < 0) {
                svg.style.overflow = 'visible';
                const blockDiv = blocks.find(b => b.contains(svg));
                if (blockDiv) {
                    const needed = Math.ceil(-targetY) + 2; // +2px safety margin
                    const current = parseInt(blockDiv.style.paddingTop || '0');
                    blockDiv.style.paddingTop = `${Math.max(current, needed)}px`;
                }
            }

            label.setAttribute('y', targetY.toFixed(2));
        });
    });
}

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

        // Fix section labels (Intro, Band Enter, etc.) that AlphaTab positions at
        // the same y-row as above-staff accent/ornament glyphs.
        fixSectionLabelOverlaps(container);

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
            const vb = originalSvg.getAttribute('viewBox');
            if (vb && vb !== 'null') clonedSvg.setAttribute('viewBox', vb);
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
        // Park the container in an offscreen element so AlphaTab's resize observer
        // doesn't see a detached/invisible container and produce null-dimensioned SVGs.
        const offscreenHolder = document.createElement('div');
        offscreenHolder.style.cssText = 'position:absolute;visibility:hidden;width:0;height:0;overflow:hidden;';
        document.body.appendChild(offscreenHolder);
        const container = gpState.canvases[0].container;
        if (container.parentNode) container.parentNode.removeChild(container);
        offscreenHolder.appendChild(container);

        gpState.pages = layoutGPPages(container, pageHeight, pageWidth);
        gpState.lastLayoutDimensions = currentDimensions;

        offscreenHolder.removeChild(container);
        document.body.removeChild(offscreenHolder);
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

            // SMuFL music glyphs use % font-sizes that resolve against inherited CSS font-size.
            // Boost it so glyphs appear at a larger visual size in page mode.
            clone.style.fontSize = `${(16 / GP_DISPLAY_SCALE * 1.5).toFixed(4)}px`;

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