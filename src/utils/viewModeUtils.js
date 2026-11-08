import { enableContinuousScrollTracking, disableContinuousScrollTracking } from './scrollUtils.js';
import { getDefaultLandscapePageLayout } from './platformUtils.js';
import { canvasSize, getActiveLazy } from '../pdfProcessor/lazyPages.js';
import { isTabletop, isBook, getFold } from '../foldState.js';

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
// A text tab fits as many pages as its own width allows (see createPaginatedPages); null while another kind is open
let textPagesPerView = null;
export function setTextPagesPerView(n) { textPagesPerView = n > 0 ? n : null; }

export function getPagesPerView(fileType) {
    if (textPagesPerView && (fileType === 'txt' || fileType === undefined)) return textPagesPerView;
    return layoutPagesPerView();
}

// The gap between two pages: the crease itself in book pose (one page on each half), 10px otherwise
export function pageGapPx() { return isBook() ? Math.max(10, getFold().w) : 10; }

function layoutPagesPerView() {
    // iPhone Duo folded like a book: one page on each half
    if (isBook()) return 2;
    const aspectRatio = window.innerWidth / window.innerHeight;
    // Show 1 page when 4:3 or narrower; 2-page mode kicks in only when wider than 4:3
    if (aspectRatio <= (4 / 3)) {
        return 1;
    }

    // Respect the landscape page layout preference ('dual' (2) or 'single' (1))
    const layout = getLandscapePageLayout();
    if (layout === 'single') return 1;

    // Wide windows (ultrawide monitors) get more pages instead of two enormous ones: one more page for every
    // MAX_PAGE_WIDTH of window width, never fewer than two, capped so the pages stay readable.
    return Math.max(2, Math.min(MAX_DUAL_PAGES, Math.floor(window.innerWidth / MAX_PAGE_WIDTH)));
}

// The reader chrome is "phone-sized" below 641px wide, or on a short landscape phone
export const PHONE_READER_QUERY = '(max-width: 640px), (pointer: coarse) and (orientation: landscape) and (max-height: 500px)';
// Tabletop (an iPhone Duo folded with the crease across) uses the phone reader chrome too: score above, controls below
export function isPhoneReader() { return window.matchMedia(PHONE_READER_QUERY).matches || isTabletop(); }
// Phone page mode: the whole area turns pages, the left half back and the right half forward. No tap moves a bar.
export function phoneTapZone(clientX, _clientY, rect) {
    return (clientX - rect.left) / Math.max(1, rect.width) < 0.5 ? 'prev' : 'next';
}

const MAX_PAGE_WIDTH = 900;
const MAX_DUAL_PAGES = 4;

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
