// renderer.js
export let pages = [];
export let currentPageIndex = 0;
export let pagesPerView = 1;
let continuousScrollHandler = null;
export const PAGE_PADDING = 10;

export function renderPage(output) {
    output.innerHTML = '';
    const containerWrapper = document.createElement('div');
    containerWrapper.className = 'pageContainer';

    for (let i = 0; i < pagesPerView; i++) {
        const pageSet = pages[currentPageIndex + i];
        if (!pageSet) break;

        const wrapper = document.createElement('div');
        wrapper.className = 'pageWrapper';
        wrapper.style.width = `${(output.clientWidth - 40) / pagesPerView}px`;
        wrapper.style.height = `${window.innerHeight - 80}px`;
        wrapper.style.paddingTop = `${PAGE_PADDING}px`;
        wrapper.style.textAlign = 'center';
        wrapper.style.overflow = 'hidden';
        wrapper.style.position = 'relative';

        pageSet.forEach(item => {
            const c = item.canvas || item.container;
            if (!c) return;
            if (item.scale) {
                c.style.width = `${c.width * item.scale}px`;
                c.style.height = `${c.height * item.scale}px`;
            }
            wrapper.appendChild(c);
        });

        const pnum = document.createElement('div');
        pnum.className = 'pageNumber';
        pnum.textContent = `${currentPageIndex + i + 1}/${pages.length}`;
        wrapper.appendChild(pnum);

        containerWrapper.appendChild(wrapper);
    }

    output.appendChild(containerWrapper);
}

export function layoutPages(condensedCanvases, output) {
    pages = [];
    const pageHeight = window.innerHeight - 80 - PAGE_PADDING;
    const pageWidth = window.innerWidth - 40;
    pagesPerView = window.innerWidth > window.innerHeight ? 2 : 1;

    let currentPage = [];
    let usedHeight = 0;

    condensedCanvases.forEach(c => {
        let scale = pageWidth / c.width / pagesPerView;
        let scaledHeight = c.height * scale;
        if (scaledHeight > pageHeight) {
            scale = pageHeight / c.height;
            scaledHeight = pageHeight;
        }
        if (usedHeight + scaledHeight > pageHeight) {
            if (currentPage.length) pages.push(currentPage);
            currentPage = [];
            usedHeight = 0;
        }
        currentPage.push({ canvas: c, scale });
        usedHeight += scaledHeight;
    });

    if (currentPage.length) pages.push(currentPage);
    if (currentPageIndex >= pages.length) currentPageIndex = 0;
    renderPage(output);
}

export function switchToContinuous(condensedCanvases, output) {
    output.style.overflowY = 'auto';
    output.innerHTML = '';

    condensedCanvases.forEach(c => {
        const wrapper = document.createElement('div');
        wrapper.style.width = '100%';
        wrapper.style.textAlign = 'center';
        const scale = output.clientWidth / c.width;
        c.style.width = `${c.width * scale}px`;
        c.style.height = 'auto';
        wrapper.appendChild(c);
        output.appendChild(wrapper);
    });

    enableContinuousScrollTracking(output);
}

export function enableContinuousScrollTracking(output) {
    if (continuousScrollHandler) return;
    continuousScrollHandler = () => {
        const scrollTop = output.scrollTop;
        const totalHeight = output.scrollHeight - output.clientHeight;
        const percent = totalHeight > 0 ? Math.floor((scrollTop / totalHeight) * 100) : 100;
        const pageIndicator = document.getElementById('pageIndicator');
        pageIndicator.textContent = `${percent}%`;
    };
    output.addEventListener('scroll', continuousScrollHandler);
}

export function disableContinuousScrollTracking(output) {
    if (!continuousScrollHandler) return;
    output.removeEventListener('scroll', continuousScrollHandler);
    continuousScrollHandler = null;
}
