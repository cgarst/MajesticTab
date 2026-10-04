import { updateScrollIndicator } from './renderUtils.js';

// --- SCROLL UTILITIES ---

const ROW_TOP_PADDING = 8; // Padding above system row so notation/chords above bar are cleanly in view

/**
 * Navigate page container up/down, cleanly snapping to system/row boundaries
 * so cut-off bars are brought into full view at the top of the viewport.
 * @param {HTMLElement} container Container to scroll
 * @param {boolean} isNext Whether to scroll down (true) or up (false)
 */
export function scrollByViewport(container, isNext = true) {
    if (!container) return;

    // 1. Locate all system rows / canvas blocks inside container
    const rawBlocks = Array.from(container.querySelectorAll(
        'div.at-surface.at > div, .at-surface > div, .pageWrapper, .gp-page-wrapper, canvas, .condensed-page-canvas'
    ));

    const containerRect = container.getBoundingClientRect();
    const currentScrollTop = container.scrollTop;
    const viewHeight = container.clientHeight;
    const viewBottom = currentScrollTop + viewHeight;

    const blocks = rawBlocks
        .map(el => {
            const rect = el.getBoundingClientRect();
            const top = rect.top - containerRect.top + currentScrollTop;
            const bottom = top + rect.height;
            return {
                el,
                top,
                bottom,
                height: rect.height
            };
        })
        .filter(b => b.height > 15) // Filter out zero-height or tiny spacer elements
        .sort((a, b) => a.top - b.top);

    // Fallback if no structured system blocks found
    if (!blocks.length) {
        const scrollAmount = Math.max(100, viewHeight * 0.8);
        container.scrollBy({
            top: isNext ? scrollAmount : -scrollAmount,
            behavior: 'smooth'
        });
        return;
    }

    if (isNext) {
        // Find the first block that is partially cut off at the bottom of the viewport,
        // or the first block completely below the viewport
        const cutOffThreshold = viewBottom - 12;
        let targetBlock = blocks.find(b => b.top < cutOffThreshold && b.bottom > cutOffThreshold);

        if (!targetBlock) {
            // If no block is partially cut off at bottom, take the first block starting at/below viewBottom
            targetBlock = blocks.find(b => b.top >= cutOffThreshold);
        }

        let newScrollTop;
        if (targetBlock) {
            newScrollTop = Math.max(0, targetBlock.top - ROW_TOP_PADDING);
            // If newScrollTop is virtually the same as current, advance to the next block
            if (newScrollTop <= currentScrollTop + 15) {
                const nextBlock = blocks.find(b => b.top > targetBlock.top + 15);
                if (nextBlock) {
                    newScrollTop = Math.max(0, nextBlock.top - ROW_TOP_PADDING);
                } else {
                    newScrollTop = currentScrollTop + viewHeight * 0.8;
                }
            }
        } else {
            // Already at the end of blocks, scroll to bottom
            newScrollTop = container.scrollHeight - viewHeight;
        }

        const maxScroll = Math.max(0, container.scrollHeight - viewHeight);
        container.scrollTo({
            top: Math.min(maxScroll, newScrollTop),
            behavior: 'smooth'
        });
    } else {
        // Scrolling Up (Previous)
        const topCutOffThreshold = currentScrollTop + 12;
        const currentTopBlockIndex = blocks.findIndex(b => b.bottom > topCutOffThreshold);

        if (currentTopBlockIndex <= 0) {
            // Already at or near the first block -> scroll to top
            container.scrollTo({
                top: 0,
                behavior: 'smooth'
            });
            return;
        }

        const anchorBlock = blocks[currentTopBlockIndex];
        const precedingBlocks = blocks.slice(0, currentTopBlockIndex);

        // Find the earliest preceding block such that all rows down to anchor block fit in view
        let chosenBlock = precedingBlocks[precedingBlocks.length - 1];
        for (let i = precedingBlocks.length - 1; i >= 0; i--) {
            const candidate = precedingBlocks[i];
            const spanHeight = (anchorBlock.bottom - candidate.top) + (ROW_TOP_PADDING * 2);
            if (spanHeight <= viewHeight) {
                chosenBlock = candidate;
            } else {
                break;
            }
        }

        let newScrollTop = Math.max(0, chosenBlock.top - ROW_TOP_PADDING);
        if (newScrollTop >= currentScrollTop - 15) {
            newScrollTop = Math.max(0, currentScrollTop - viewHeight * 0.8);
        }

        container.scrollTo({
            top: newScrollTop,
            behavior: 'smooth'
        });
    }
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