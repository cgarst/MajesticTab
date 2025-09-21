import { updateScrollIndicator } from './renderUtils.js';

// --- SCROLL UTILITIES ---

/**
 * Navigate page container up/down by percentage of viewport height
 * @param {HTMLElement} container Container to scroll
 * @param {boolean} isNext Whether to scroll down (true) or up (false)
 */
export function scrollByViewport(container, isNext = true) {
    const scrollAmount = window.innerHeight * 0.9;
    container.scrollBy({ 
        top: isNext ? scrollAmount : -scrollAmount, 
        behavior: 'smooth' 
    });
}

// --- CONTINUOUS MODE SCROLL TRACKING ---
let scrollTimeout;
const SCROLL_DEBOUNCE = 100; // ms

export function enableContinuousScrollTracking(output, condensedCanvases, onPageChange) {
    output.addEventListener('scroll', () => handleContinuousScroll(output, condensedCanvases, onPageChange));
}

export function disableContinuousScrollTracking(output) {
    output.removeEventListener('scroll', handleContinuousScroll);
}

function handleContinuousScroll(output, condensedCanvases, onPageChange) {
    // Clear existing timeout
    if (scrollTimeout) {
        clearTimeout(scrollTimeout);
    }

    // Set new timeout
    scrollTimeout = setTimeout(() => {
        updateContinuousPageIndicator(output, condensedCanvases, onPageChange);
    }, SCROLL_DEBOUNCE);
}

function updateContinuousPageIndicator(output, condensedCanvases, onPageChange) {
    const indicator = document.getElementById('pageIndicator');
    if (!indicator) return;

    // Update scroll percentage indicator
    updateScrollIndicator(indicator, output, condensedCanvases.length);
}

export function scrollToPage(output, condensedCanvases, pageIndex) {
    if (pageIndex >= 0 && pageIndex < condensedCanvases.length) {
        const canvas = condensedCanvases[pageIndex];
        canvas.scrollIntoView({ behavior: 'smooth' });
    }
}