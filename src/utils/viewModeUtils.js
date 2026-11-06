import { enableContinuousScrollTracking, disableContinuousScrollTracking } from './scrollUtils.js';
import { getDefaultLandscapePageLayout } from './platformUtils.js';
import { canvasSize, getActiveLazy } from '../pdfProcessor/lazyPages.js';

/**
 * Get current landscape page layout preference ('dual' or 'single')
 * @returns {string} 'dual' for 2 pages side-by-side, 'single' for 1 page fitting both dimensions
 */
export function getLandscapePageLayout() {
    return localStorage.getItem('landscapePageLayout') || getDefaultLandscapePageLayout();
}

/**
 * Get number of pages to show based on available window width and landscape preference
 * @param {string|boolean} fileType - File type ('gp', 'txt', 'pdf') or boolean (true=gp, false=pdf)
 * @returns {number} Number of pages to show
 */
export function getPagesPerView(fileType = 'gp') {
    const aspectRatio = window.innerWidth / window.innerHeight;
    // Show 1 page when 4:3 or narrower; 2-page mode kicks in only when wider than 4:3
    if (aspectRatio <= (4 / 3)) {
        return 1;
    }

    // Respect the landscape page layout preference ('dual' (2) or 'single' (1))
    const layout = getLandscapePageLayout();
    return layout === 'single' ? 1 : 2;
}

export function switchToContinuous(output, condensedCanvases, onPageChange) {
    // Clean out old page-mode layout
    output.innerHTML = '';

    // First disable any existing scroll tracking
    disableContinuousScrollTracking(output);
    output.style.overflowY = 'auto';

    // Rebuild continuous view
    condensedCanvases.forEach(c => {
        if (!c || typeof c !== 'object') return; // Skip invalid canvases
        
        const wrapper = document.createElement('div');
        wrapper.style.width = '100%';
        wrapper.style.textAlign = 'center';

        // Skip scaling if canvas doesn't have dimensions
        const size = canvasSize(c);
        if (size.w) {
            const scale = output.clientWidth / size.w;
            c.style.width = `${size.w * scale}px`;
            c.style.height = 'auto';
        }

        wrapper.appendChild(c);
        output.appendChild(wrapper);
    });

    // Reset scroll position
    output.scrollTop = 0;

    // Long PDFs: process the pages on screen as they scroll into view
    getActiveLazy()?.observe(output);

    // Set up new scroll tracking and update indicator
    enableContinuousScrollTracking(output, condensedCanvases, onPageChange);
    
    // Force initial indicator update
    const indicator = document.getElementById('pageIndicator');
    if (indicator) {
        // Calculate initial scroll percentage
        const scrollPercent = (output.scrollTop / (output.scrollHeight - output.clientHeight) * 100) || 0;
        indicator.textContent = `${Math.round(scrollPercent)}%`;
    }
}

export function switchToPageMode(output, currentPage = 0, totalPages = 0) {
    // Disable continuous mode tracking
    disableContinuousScrollTracking(output);
    output.style.overflowY = 'hidden';
    output.innerHTML = ''; // Clear the output for re-layout

    // Reset indicator to show page numbers
    const indicator = document.getElementById('pageIndicator');
    if (indicator) {
        indicator.textContent = `${currentPage + 1} of ${totalPages}`;
    }
}
