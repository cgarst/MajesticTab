import { loadGuitarPro } from './gpProcessor.js';

export let gpCanvases = [];
export let gpPages = [];
export let currentGPPageIndex = 0;
let pagesPerView = 1;
const PAGE_PADDING = 10;

/**
 * Load a Guitar Pro file into the app.
 * @param {File|string} file - File object (upload) or path (string)
 * @param {HTMLElement} output - container for both continuous and page modes
 * @param {HTMLInputElement} pageModeRadio 
 * @param {HTMLInputElement} continuousModeRadio
 */
export async function loadGP(file, output, pageModeRadio, continuousModeRadio) {
    // Clear old content
    output.innerHTML = '';
    gpCanvases = [];
    gpPages = [];
    currentGPPageIndex = 0;

    // If File object, read as Base64
    let dataToLoad;
    if (file instanceof File) {
        console.log('Got file as an object')
        dataToLoad = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    } else {
        console.log('File came as a string instead of object')
        dataToLoad = file; // assume string path
    }

    // Create AlphaTab container inside output
    const alphaTabContainer = document.createElement('div');
    alphaTabContainer.className = 'alphaTabContainer';
    alphaTabContainer.style.width = '100%';
    alphaTabContainer.style.margin = '0 auto';
    alphaTabContainer.style.boxSizing = 'border-box';
    alphaTabContainer.style.overflow = 'hidden'; // ensure container doesn't overflow
    output.appendChild(alphaTabContainer);

    // Render in continuous mode first
    const api = await loadGuitarPro(dataToLoad, alphaTabContainer, { shrink: true, debug: false });
    console.log("AlphaTab render complete", api);

    // Store the container for later cloning
    gpCanvases = [{ container: alphaTabContainer }];

    // Constrain width but keep height natural
    const outputWidth = output.clientWidth;
    const containerWidth = alphaTabContainer.offsetWidth;

    if (containerWidth > outputWidth) {
        const scaleX = outputWidth / containerWidth; // horizontal scale only
        alphaTabContainer.style.transformOrigin = 'top left';
        alphaTabContainer.style.transform = `scale(${scaleX}, 1)`; // scaleX horizontally, keep Y = 1
    } else {
        alphaTabContainer.style.transform = 'none';
    }

    // Compute pages for page mode
    layoutGPPages(alphaTabContainer, output);

    // Automatically switch to continuous mode
    continuousModeRadio.checked = true;
    renderGPPage(output, pageModeRadio, continuousModeRadio);
}

/**
 * Render GP pages to output depending on mode
 */
export function renderGPPage(output, pageModeRadio, continuousModeRadio) {
    output.innerHTML = '';
    if (gpPages.length === 0) return;

    pagesPerView = window.innerWidth > window.innerHeight ? 2 : 1;

    if (pageModeRadio.checked) {
        const containerWrapper = document.createElement('div');
        containerWrapper.className = 'pageContainer';
        const pageWidth = (window.innerWidth - 40) / pagesPerView;
        const pageHeight = window.innerHeight - 80;

        for (let i = 0; i < pagesPerView; i++) {
            const pageSet = gpPages[currentGPPageIndex + i];
            if (!pageSet) break;

            const wrapper = document.createElement('div');
            wrapper.className = 'pageWrapper';
            wrapper.style.width = `${pageWidth}px`;
            wrapper.style.height = `${pageHeight}px`;
            wrapper.style.paddingTop = `${PAGE_PADDING}px`;

            pageSet.forEach(item => {
                wrapper.appendChild(item.container.cloneNode(true));
            });

            const pnum = document.createElement('div');
            pnum.className = 'pageNumber';
            pnum.textContent = `${currentGPPageIndex + i + 1}/${gpPages.length}`;
            wrapper.appendChild(pnum);

            containerWrapper.appendChild(wrapper);
        }

        output.appendChild(containerWrapper);

    } else if (continuousModeRadio.checked) {
        output.appendChild(gpCanvases[0].container);
        output.style.overflowY = 'auto';
    }
}

/**
 * Layout GP pages by slicing the container into virtual pages
 */
export function layoutGPPages(container, output) {
    gpPages = [];
    const pageHeight = window.innerHeight - 80 - PAGE_PADDING;
    const totalHeight = container.offsetHeight;
    const pageCount = Math.ceil(totalHeight / pageHeight);

    for (let i = 0; i < pageCount; i++) {
        const wrapper = document.createElement('div');
        wrapper.style.height = `${pageHeight}px`;
        wrapper.style.overflow = 'hidden';
        wrapper.style.position = 'relative';

        // Clone the AlphaTab container for this page
        const clone = container.cloneNode(true);
        clone.style.position = 'absolute';
        clone.style.top = `-${i * pageHeight}px`;
        clone.style.left = '0';
        wrapper.appendChild(clone);

        gpPages.push([{ container: wrapper }]);
    }

    gpState.currentGPPageIndex = 0;
}

export function renderGPPageMode(output, pagesPerView = 1) {
    if (!gpCanvases[0] || gpPages.length === 0) return;

    output.innerHTML = '';
    const containerWrapper = document.createElement('div');
    containerWrapper.className = 'pageContainer';

    const pageWidth = (window.innerWidth - 40) / pagesPerView;
    const pageHeight = window.innerHeight - 80;

    for (let i = 0; i < pagesPerView; i++) {
        const pageSet = gpPages[currentGPPageIndex + i];
        if (!pageSet) break;

        const wrapper = document.createElement('div');
        wrapper.className = 'pageWrapper';
        wrapper.style.width = `${pageWidth}px`;
        wrapper.style.height = `${pageHeight}px`;
        wrapper.style.paddingTop = `${PAGE_PADDING}px`;

        pageSet.forEach(item => {
            // clone the original container for page view
            wrapper.appendChild(item.container.cloneNode(true));
        });

        const pnum = document.createElement('div');
        pnum.className = 'pageNumber';
        pnum.textContent = `${currentGPPageIndex + i + 1}/${gpPages.length}`;
        wrapper.appendChild(pnum);

        containerWrapper.appendChild(wrapper);
    }

    output.appendChild(containerWrapper);
}

export const gpState = {
    currentGPPageIndex: 0,
    gpCanvases: [],
    gpPages: []
};