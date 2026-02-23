import { enableContinuousScrollTracking, disableContinuousScrollTracking, scrollToPage } from './scrollUtils.js';

/**
 * Get number of pages to show based on available window width
 * @param {boolean} isGuitarPro - Whether this is for Guitar Pro mode
 * @returns {number} Number of pages to show
 */
export function getPagesPerView(isGuitarPro = false) {
    if (isGuitarPro) {
        // For Guitar Pro: use portrait/landscape detection
        const aspectRatio = window.innerWidth / window.innerHeight;
        // When taller than wide (height >= width): show 1 page
        // When wider than tall (width > height): show 2 pages
        return aspectRatio <= 1.0 ? 1 : 2;
    }

    // For PDF mode: same portrait/landscape detection as Guitar Pro
    const aspectRatio = window.innerWidth / window.innerHeight;
    return aspectRatio <= 1.0 ? 1 : 2;
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