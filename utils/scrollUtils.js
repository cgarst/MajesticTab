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
let activeScrollHandler = null; // Store the actual listener reference
const SCROLL_DEBOUNCE = 100; // ms

export function enableContinuousScrollTracking(output, condensedCanvases, onPageChange) {
    // Remove any existing listener first
    if (activeScrollHandler) {
        output.removeEventListener('scroll', activeScrollHandler);
    }

    // Create and store the handler
    activeScrollHandler = () => handleContinuousScroll(output, condensedCanvases, onPageChange);
    output.addEventListener('scroll', activeScrollHandler);
}

export function disableContinuousScrollTracking(output) {
    if (activeScrollHandler) {
        output.removeEventListener('scroll', activeScrollHandler);
        activeScrollHandler = null;
    }
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