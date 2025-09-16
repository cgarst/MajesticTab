import { loadGuitarPro } from './gpProcessor.js';

let pagesPerView = 1;
const PAGE_PADDING = 10;

/**
 * Load a Guitar Pro file into the app.
 */
export async function loadGP(file, output, pageModeRadio, continuousModeRadio) {
    // Immediately select continuous mode
    continuousModeRadio.checked = true;
    pageModeRadio.checked = false;
    continuousModeRadio.dispatchEvent(new Event('change', { bubbles: true }));

    // Clear old content
    output.innerHTML = '';
    gpState.gpCanvases = [];
    gpState.gpPages = [];
    gpState.currentGPPageIndex = 0;

    // If File object, read as Base64
    let dataToLoad;
    if (file instanceof File) {
        console.log('Got file as an object');
        dataToLoad = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    } else {
        console.log('File came as a string instead of object');
        dataToLoad = file; // assume string path
    }

    // Init AlphaTab container for page view
    const alphaTabContainer = document.createElement('div');
    alphaTabContainer.className = 'alphaTabContainer';
    alphaTabContainer.style.width = '860px';
    alphaTabContainer.style.margin = '0 auto';
    output.appendChild(alphaTabContainer);

    // Render before capturing page data
    let api = await loadGuitarPro(dataToLoad, alphaTabContainer, 
        { shrink: true, debug: false } );

    gpState.gpCanvases = [{ container: alphaTabContainer }];

    api.postRenderFinished.on(() => {
        console.log("AlphaTab postRenderFinished fired (fixed width)");

        // --- Capture pages ---
        const pageHeight = output.clientHeight - 20;
        gpState.gpPages = layoutGPPages(alphaTabContainer, pageHeight);
        console.log("gpPages ready:", gpState.gpPages.map(p => p.length));

        // --- Then show continuous mode by default ---
        output.innerHTML = '';
        output.style.overflowY = 'auto';
        alphaTabContainer.style.overflow = 'visible';
        output.appendChild(alphaTabContainer);
        output.scrollTop = 0;
    });
}

/**
 * Render GP pages to output depending on mode
 */
export function renderGPPage(output, pageModeRadio, continuousModeRadio) {
    output.innerHTML = '';

    if (!gpState.gpPages || gpState.gpPages.length === 0 || !gpState.gpCanvases[0]?.container) return;

    const pagesPerView = window.innerWidth > window.innerHeight ? 2 : 1;

    if (pageModeRadio.checked) {
        const pageHeight = output.clientHeight - 20;
        gpState.gpPages = layoutGPPages(gpState.gpCanvases[0].container, pageHeight);

        const containerWrapper = document.createElement('div');
        containerWrapper.className = 'pageContainer';

        for (let i = 0; i < pagesPerView; i++) {
            const pageIndex = gpState.currentGPPageIndex + i;
            const pageSet = gpState.gpPages[pageIndex];
            if (!pageSet) break;

            const wrapper = document.createElement('div');
            wrapper.className = 'pageWrapper';
            wrapper.style.width = `${(window.innerWidth - 40) / pagesPerView}px`;
            wrapper.style.height = `${pageHeight}px`;
            wrapper.style.overflow = 'hidden';
            wrapper.style.position = 'relative';

            pageSet.forEach(div => wrapper.appendChild(div.cloneNode(true)));

            // Apply scaling to fit horizontally
            scaleGPContainer(wrapper, wrapper.clientWidth);

            const pnum = document.createElement('div');
            pnum.className = 'pageNumber';
            pnum.textContent = `${pageIndex + 1}/${gpState.gpPages.length}`;
            wrapper.appendChild(pnum);

            containerWrapper.appendChild(wrapper);
        }

        output.appendChild(containerWrapper);

        // --- APPLY HORIZONTAL SCALE TO ALL SVGs WHILE PRESERVING ASPECT RATIO ---
        containerWrapper.querySelectorAll('.pageWrapper').forEach(wrapper => {
            const wrapperWidth = wrapper.clientWidth;

            wrapper.querySelectorAll('svg').forEach(svg => {
                const svgWidth = svg.width.baseVal.value;
                const scale = wrapperWidth / svgWidth; // use same scale for X and Y

                svg.style.transformOrigin = 'top left';
                svg.style.transform = `scale(${scale}, ${scale})`;
            });
        });

    } else {
        // Continuous mode
        output.appendChild(gpState.gpCanvases[0].container);
    }

    updateGPPageIndicator();
}

/**
 * Layout GP pages based on indivisible DIV blocks
 * @param {HTMLElement} container - AlphaTab container
 * @param {number} pageHeight - Desired page height in px
 * @returns {HTMLElement[][]} gpPages - Array of page arrays
 */
export function layoutGPPages(container, pageHeight) {
    //console.log("Layout GP Pages Debug:");

    const allBlocks = Array.from(container.querySelectorAll("div.at-surface.at > div"));
    //console.log("Total content blocks found:", allBlocks.length);

    // Offscreen container for reliable height measurements
    const offscreen = document.createElement('div');
    offscreen.style.position = 'absolute';
    offscreen.style.visibility = 'hidden';
    offscreen.style.width = `${container.clientWidth}px`;
    document.body.appendChild(offscreen);

    const gpPages = [];
    let currentPage = [];
    let currentHeight = 0;

    allBlocks.forEach((block, i) => {
        const clone = block.cloneNode(true);
        offscreen.appendChild(clone);
        const blockHeight = clone.offsetHeight;
        //console.log(`Child ${i} height:`, blockHeight);

        // Start new page if current page is full
        if (currentHeight + blockHeight > pageHeight && currentPage.length) {
            gpPages.push(currentPage);
            currentPage = [];
            currentHeight = 0;
        }

        currentPage.push(clone);
        currentHeight += blockHeight;
    });

    if (currentPage.length) gpPages.push(currentPage);

    document.body.removeChild(offscreen);
    //console.log("Final gpPages structure:", gpPages.map(p => p.length));
    return gpPages;
}

/**
 * Render a single page
 * @param {HTMLElement} output - Page output container
 * @param {HTMLElement[][]} gpPages - Array of page arrays
 * @param {number} pageIndex - Which page to render
 */
export function renderGPPageMode(output, gpPages, pageIndex) {
    if (!gpPages || !gpPages[pageIndex]) return;
    output.innerHTML = '';

    gpPages[pageIndex].forEach(block => {
        output.appendChild(block);
    });

    console.log(`RenderGPPageMode - appended page ${pageIndex}`);
}

/**
 * Continuous mode rendering
 * Just appends the original container for scrolling
 */
function renderGPContinuous(container, output) {
    output.innerHTML = '';
    output.appendChild(container);
    console.log("Rendering continuous mode");
}

export const gpState = {
    currentGPPageIndex: 0,
    gpCanvases: [],
    gpPages: []
};

export function nextGPPage() {
    if (!gpState.gpPages.length) return;
    gpState.currentGPPageIndex = Math.min(gpState.gpPages.length - 1, gpState.currentGPPageIndex + 1);
}

export function prevGPPage() {
    if (!gpState.gpPages.length) return;
    gpState.currentGPPageIndex = Math.max(0, gpState.currentGPPageIndex - 1);
}   

function updateGPPageIndicator() {
    if (!gpState.gpPages || gpState.gpPages.length === 0) return;

    if (pageModeRadio.checked) {
        pageIndicator.textContent = `${gpState.currentGPPageIndex + 1}/${gpState.gpPages.length}`;
    } else if (continuousModeRadio.checked) {
        const container = gpState.gpCanvases[0]?.container;
        if (!container) return;
        const scrollTop = output.scrollTop;
        const totalHeight = container.scrollHeight - output.clientHeight;
        const percent = totalHeight > 0 ? Math.floor((scrollTop / totalHeight) * 100) : 100;
        pageIndicator.textContent = `${percent}%`;
    }
}

export function scaleGPContainer(container, targetWidth) {
    if (!container) return;

    // Measure the actual content width
    const content = container.querySelectorAll(':scope > *'); // immediate children
    if (!content.length) return;

    let maxWidth = 0;
    content.forEach(child => {
        const childRight = child.offsetLeft + child.offsetWidth;
        if (childRight > maxWidth) maxWidth = childRight;
    });

    // Compute scale factor
    const scaleX = targetWidth / maxWidth;

    // Apply transform
    container.style.transformOrigin = 'top left';
    container.style.transform = `scale(${scaleX}, 1)`;
}
