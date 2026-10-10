import { enableContinuousScrollTracking, disableContinuousScrollTracking, scrollToPage } from './scrollUtils.js';
import { getDefaultLandscapePageLayout } from './platformUtils.js';

/**
 * Get current landscape page layout preference ('dual' or 'single')
 * @returns {string} 'dual' for 2 pages side-by-side, 'single' for 1 page fitting both dimensions
 */
export function getLandscapePageLayout() {
    return localStorage.getItem('landscapePageLayout') || getDefaultLandscapePageLayout();
}

/**
 * Set landscape page layout preference ('dual' or 'single')
 * @param {string} layout 
 */
export function setLandscapePageLayout(layout) {
    localStorage.setItem('landscapePageLayout', layout);
}

/**
 * Get number of pages to show based on available window width and landscape preference
 * @param {string|boolean} fileType - File type ('gp', 'txt', 'pdf') or boolean (true=gp, false=pdf)
 * @returns {number} Number of pages to show
 */
export function getPagesPerView(fileType = 'gp') {
    const aspectRatio = window.innerWidth / window.innerHeight;
    // When taller than wide (height >= width, i.e. portrait): show 1 page
    if (aspectRatio <= 1.0) {
        return 1;
    }

    // PDF mode in landscape is always dual-page (2 pages) and not affected by "Landscape in Page Mode" setting
    if (fileType === 'pdf' || fileType === false) {
        return 2;
    }

    // For Guitar Pro and TXT tabs: respect the landscape page layout preference ('dual' (2) or 'single' (1))
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
        if (c.width) {
            const scale = output.clientWidth / c.width;
            c.style.width = `${c.width * scale}px`;
            c.style.height = 'auto';
        }

        wrapper.appendChild(c);
        output.appendChild(wrapper);
    });

    // Reset scroll position
    output.scrollTop = 0;

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

export function changePage(continuous, output, condensedCanvases, currentPage, pages, direction, onPageChange) {
    if (continuous) {
        const targetPage = currentPage + direction;
        scrollToPage(output, condensedCanvases, targetPage);
    } else {
        const pagesPerView = getPagesPerView();
        if (direction > 0 && currentPage < pages.length - pagesPerView) {
            onPageChange(currentPage + Math.abs(direction));
        } else if (direction < 0 && currentPage > 0) {
            onPageChange(currentPage + direction);
        }
    }
}