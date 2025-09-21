// navigationUtils.js
import { scrollByViewport } from './scrollUtils.js';
import { switchToContinuous, switchToPageMode, getPagesPerView } from './viewModeUtils.js';
import { clearOutput, updatePageIndicator } from './renderUtils.js';

// Navigation action constants
export const NavigationAction = {
    NEXT: 'NEXT',
    PREV: 'PREV',
    FIRST: 'FIRST',
    TOGGLE_VIEW_MODE: 'TOGGLE_VIEW_MODE'
};

/**
 * Core navigation function that handles all types of navigation
 * @param {Object} config Navigation configuration
 * @param {HTMLElement} config.output Output container element
 * @param {boolean} config.isNext True for next, false for previous
 * @param {boolean} config.pageModeChecked Whether page mode is active
 * @param {Object} config.gpState Guitar Pro state object
 * @param {Array} config.pages Array of pages (for PDF)
 * @param {number} config.currentPageIndex Current page index (for PDF)
 * @param {number} config.step Number of pages to move
 * @param {Function} config.renderPage Function to render PDF page
 * @param {Function} config.renderGPPage Function to render GP page
 * @param {Function} config.nextGPPage Function to go to next GP page
 * @param {Function} config.prevGPPage Function to go to previous GP page
 * @param {Function} config.continuousModeRadio Radio button for continuous mode
 * @returns {Object} New state {newPageIndex} if changed
 */
export function navigate(config) {
    const {
        output,
        isNext,
        pageModeChecked,
        gpState,
        pages,
        currentPageIndex,
        step = 1,
        renderGPPage,
        nextGPPage,
        prevGPPage,
        continuousModeRadio
    } = config;

    // Handle GP files
    if (gpState?.canvases[0]) {
        if (pageModeChecked) {
            const navigated = isNext ? nextGPPage?.() : prevGPPage?.();
            if (navigated && renderGPPage) {
                renderGPPage(output, pageModeChecked, continuousModeRadio);
            }
        } else {
            scrollByViewport(output, isNext);
        }
        return null;
    }

    // Handle text files
    if (config.textState?.pages?.length > 0 || config.textState?.fullContent) {
        if (pageModeChecked) {
            const navigated = isNext ? config.nextTextPage?.() : config.prevTextPage?.();
            if (navigated && config.renderTextPage) {
                config.renderTextPage(output, pageModeChecked);
            }
        } else {
            scrollByViewport(output, isNext);
        }
        return null;
    }

    // Handle PDFs
    if (pageModeChecked) {
        const currentPages = pages || config.getPages?.();
        const currentIdx = currentPageIndex || config.getCurrentPageIndex?.();
        
        if (!currentPages || !currentPages.length) return null;

        const newIndex = isNext 
            ? Math.min(currentIdx + step, Math.max(0, currentPages.length - getPagesPerView()))
            : Math.max(0, currentIdx - step);

        if (newIndex !== currentIdx) {
            return { newPageIndex: newIndex };
        }
    } else {
        scrollByViewport(output, isNext);
    }
    
    return null;
}

/**
 * Class to handle navigation state and actions
 */
export class NavigationHandler {
    constructor(config) {
        this.config = config;
    }

    /**
     * Process a navigation action
     * @param {string} action - The navigation action to perform
     * @returns {Object|null} New state if changed
     */
    handleAction(action) {
        const { config } = this;
        const isGP = config.gpState?.canvases[0];
        const isPageMode = config.pageModeChecked || config.pageModeRadio?.checked;

        switch (action) {
            case NavigationAction.NEXT:
            case NavigationAction.PREV:
                return navigate({
                    ...config,
                    isNext: action === NavigationAction.NEXT,
                    pageModeChecked: isPageMode
                });
            case NavigationAction.FIRST:
                return this._handleFirstPage();
            default:
                return null;
        }
    }

    _handleDirectionalNavigation(isNext) {
        const { config } = this;
        const isGP = config.gpState?.canvases[0];
        const isPageMode = config.pageModeChecked || config.pageModeRadio?.checked;

        if (isGP) {
            if (isPageMode) {
                if (isNext) config.nextGPPage();
                else config.prevGPPage();
                config.renderGPPage(config.output, isPageMode, config.continuousModeRadio);
            } else {
                scrollByViewport(config.output, isNext);
            }
            return null;
        }

        if (isPageMode) {
            const pages = config.pages || config.getPages?.();
            const currentPageIndex = config.currentPageIndex || config.getCurrentPageIndex?.();
            
            if (!pages || !pages.length) return null;

            const step = config.step || config.getPageStep?.() || 1;
            const newIndex = isNext 
                ? Math.min(currentPageIndex + step, Math.max(0, pages.length - getPagesPerView()))
                : Math.max(0, currentPageIndex - step);

            if (newIndex !== currentPageIndex) {
                return { newPageIndex: newIndex };
            }
        } else {
            scrollByViewport(config.output, isNext);
        }
        
        return null;
    }

    _handleFirstPage() {
        const { config } = this;
        const isGP = config.gpState?.canvases[0];
        const isPageMode = config.pageModeChecked || config.pageModeRadio?.checked;

        if (isGP) {
            if (isPageMode) {
                config.gpState.currentPageIndex = 0;
                config.renderGPPage(config.output, isPageMode, config.continuousModeRadio);
            } else {
                config.output.scrollTo({ top: 0, behavior: 'smooth' });
            }
        } else {
            if (isPageMode) {
                return { newPageIndex: 0 };
            } else {
                config.output.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }
        return null;
    }
}



/**
 * Handle keyboard navigation
 * @param {Function} getConfig Function to get current navigation configuration
 */
export function setupKeyboardNavigation(getConfig) {
    window.addEventListener('keydown', (e) => {
        const config = getConfig();
        if (!config.currentFile) return;

        const nextPageKeys = ['ArrowRight', 'ArrowDown', 'PageDown', ' '];
        const prevPageKeys = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Enter'];

        // Always prevent default arrow key behavior in our app
        const activeEl = document.activeElement;
        if (nextPageKeys.includes(e.key) || prevPageKeys.includes(e.key)) {
            e.preventDefault();
        }

        // Avoid handling keys when focused on form elements
        if (activeEl && (
            activeEl.tagName === 'INPUT' || 
            activeEl.tagName === 'TEXTAREA' ||
            activeEl.tagName === 'SELECT' ||
            activeEl.tagName === 'BUTTON'
        )) return;

        // Prevent arrow keys from scrolling the page
        if (nextPageKeys.includes(e.key) || prevPageKeys.includes(e.key)) {
            e.preventDefault();
        }

        const isNext = nextPageKeys.includes(e.key);
        const isPrev = prevPageKeys.includes(e.key);

        if (isNext || isPrev) {
            e.preventDefault();
            const navigationHandler = new NavigationHandler(config);
            const action = isNext ? NavigationAction.NEXT : NavigationAction.PREV;
            const result = navigationHandler.handleAction(action);
            
            if (result?.newPageIndex !== undefined && config.setCurrentPageIndex) {
                config.setCurrentPageIndex(result.newPageIndex);
            }
        }
    });
}

/**
 * Setup first page button navigation
 */
export function setupFirstPageNavigation(firstBtn, getConfig) {
    firstBtn.addEventListener('click', () => {
        const config = getConfig();
        if (!config.currentFile) return;

        const navigationHandler = new NavigationHandler(config);
        const result = navigationHandler.handleAction(NavigationAction.FIRST);
        
        if (result?.newPageIndex !== undefined) {
            config.setCurrentPageIndex(result.newPageIndex);
        }
    });
}

/**
 * Setup previous and next button navigation
 */
export function setupPrevNextNavigation(prevBtn, nextBtn, getConfig) {
    const setupButton = (button, action) => {
        button.addEventListener('click', () => {
            const config = getConfig();
            if (!config.currentFile) return;
            
            const navigationHandler = new NavigationHandler(config);
            const result = navigationHandler.handleAction(action);
            
            if (result?.newPageIndex !== undefined) {
                config.setCurrentPageIndex(result.newPageIndex);
            }
        });
    };

    setupButton(prevBtn, NavigationAction.PREV);
    setupButton(nextBtn, NavigationAction.NEXT);
}

/**
 * Setup view mode toggle handlers
 */
export function setupViewModeToggles(pageModeRadio, continuousModeRadio, getConfig) {
    const updateIndicator = (config, isPageMode) => {
        const indicator = document.getElementById('pageIndicator');
        if (!indicator || !config.output || !config.currentFile) return;

        if (isPageMode) {
            // Update to page numbers
            if (config.gpState?.canvases[0]) {
                indicator.textContent = `${config.gpState.currentPageIndex + 1} of ${config.gpState.pages.length}`;
            } else if (config.condensedCanvases) {
                indicator.textContent = `${config.currentPageIndex + 1} of ${config.condensedCanvases.length}`;
            }
        } else {
            // Update to scroll percentage
            // Use requestAnimationFrame to ensure we get accurate scroll values after layout
            requestAnimationFrame(() => {
                const scrollPercent = (config.output.scrollTop / (config.output.scrollHeight - config.output.clientHeight) * 100) || 0;
                indicator.textContent = `${Math.round(scrollPercent)}%`;
            });
        }
    };

    pageModeRadio.addEventListener('change', () => {
        const config = getConfig();
        if (!config.output || !config.currentFile) return;

        config.continuous = !pageModeRadio.checked;
        const isPageMode = pageModeRadio.checked;
        
        // Update UI immediately to reflect mode change
        const indicator = document.getElementById('pageIndicator');
        clearOutput(config.output);

        if (config.gpState.canvases[0]) {
            // For Guitar Pro files
            if (isPageMode) {
                // Switch to page mode
                if (indicator) {
                    indicator.textContent = `${config.gpState.currentPageIndex + 1} of ${config.gpState.pages.length}`;
                }
                switchToPageMode(
                    config.output, 
                    config.gpState.currentPageIndex,
                    config.gpState.pages.length
                );
                // Immediate render
                config.renderGPPage(config.output, true, continuousModeRadio);
                // Focus the output element to enable keyboard navigation
                config.output.focus();
            } else {
                // For GP files, just render directly in continuous mode
                config.renderGPPage(config.output, false, continuousModeRadio);
                
                // Force immediate scroll indicator update
                if (indicator) {
                    const scrollPercent = (config.output.scrollTop / (config.output.scrollHeight - config.output.clientHeight) * 100) || 0;
                    indicator.textContent = `${Math.round(scrollPercent)}%`;
                }
            }
        } else {
            if (isPageMode) {
                if (config.textState?.pages?.length > 0) {
                    // Handle text files
                    config.output.style.overflowY = 'hidden';
                    // Switch to page mode for text files
                    switchToPageMode(
                        config.output,
                        config.textState.currentPageIndex,
                        config.textState.pages.length
                    );
                    config.renderTextPage(config.output, true);
                    config.output.focus();
                } else {
                    // Switch to page mode for PDFs
                    switchToPageMode(
                        config.output,
                        config.currentPageIndex,
                        config.condensedCanvases.length
                    );
                    // Update page indicator and layout
                    updateIndicator(config, true);
                    config.doLayoutPages();
                    // Focus the output element to enable keyboard navigation
                    config.output.focus();
                }
            } else {
                if (config.textState?.pages?.length > 0) {
                    // Handle text files in continuous mode
                    switchToContinuous(
                        config.output,
                        [config.textState.fullContent],
                        (newPage) => {
                            config.textState.currentPageIndex = newPage;
                            if (indicator) {
                                const scrollPercent = (config.output.scrollTop / (config.output.scrollHeight - config.output.clientHeight) * 100) || 0;
                                indicator.textContent = `${Math.round(scrollPercent)}%`;
                            }
                        }
                    );
                    config.renderTextPage(config.output, false);
                } else {
                    // Switch to continuous mode for PDFs
                    switchToContinuous(
                        config.output,
                        config.condensedCanvases,
                        (newPage) => {
                            config.currentPageIndex = newPage;
                            config.updatePageDisplay();
                            updateIndicator(config, false);
                        }
                    );
                }
            }
        }
    });

    continuousModeRadio.addEventListener('change', () => {
        if (!continuousModeRadio.checked) return;
        
        const config = getConfig();
        config.continuous = true;
        
        // Update UI immediately to reflect mode change
        const indicator = document.getElementById('pageIndicator');
        clearOutput(config.output);

        if (config.gpState.canvases[0]) {
            // For GP files, just render directly in continuous mode
            config.renderGPPage(config.output, false, continuousModeRadio);
            updateIndicator(config, false);
        } else if (config.textState?.pages?.length > 0) {
            // Handle text files in continuous mode
            switchToContinuous(
                config.output,
                [config.textState.fullContent],
                (newPage) => {
                    config.textState.currentPageIndex = newPage;
                    if (indicator) {
                        const scrollPercent = (config.output.scrollTop / (config.output.scrollHeight - config.output.clientHeight) * 100) || 0;
                        indicator.textContent = `${Math.round(scrollPercent)}%`;
                    }
                }
            );
            config.renderTextPage(config.output, false);
        } else {
            // Switch to continuous mode for PDFs
            switchToContinuous(
                config.output,
                config.condensedCanvases,
                (newPage) => {
                    config.currentPageIndex = newPage;
                    config.updatePageDisplay();
                    updateIndicator(config, false);
                }
            );
        }
        
        // Queue a second UI update to ensure indicator is correct after layout
        requestAnimationFrame(() => {
            if (indicator) {
                const scrollPercent = (config.output.scrollTop / (config.output.scrollHeight - config.output.clientHeight) * 100) || 0;
                indicator.textContent = `${Math.round(scrollPercent)}%`;
            }
        });
        
        config.output.focus();
    });
}

/**
 * Handle tap/click navigation
 */
export function setupTapClickNavigation(output, getConfig) {
    output.addEventListener('click', (e) => {
        const config = getConfig();
        handleTapNavigation(e, config);
    });
}

/**
 * Handle tap/click navigation in page mode
 * @param {MouseEvent} e Mouse/Touch event
 * @param {Object} config Navigation configuration object
 */
export function handleTapNavigation(e, config) {
    // Skip if there's no file loaded or not in page mode
    if (!config.pageModeRadio?.checked) return;
    if (config.currentFile == null) return;

    const outputRect = config.output.getBoundingClientRect();
    if (e.clientY < outputRect.top) return;

    const pageContainers = config.output.querySelectorAll('.pageWrapper');
    for (let i = 0; i < pageContainers.length; i++) {
        const rect = pageContainers[i].getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
            const clickX = e.clientX;
            const midX = rect.left + rect.width / 2;
            const action = clickX >= midX ? NavigationAction.NEXT : NavigationAction.PREV;

            const navigationHandler = new NavigationHandler(config);
            const result = navigationHandler.handleAction(action);

            if (result?.newPageIndex !== undefined) {
                config.setCurrentPageIndex(result.newPageIndex);
            }
            break;
        }
    }
}