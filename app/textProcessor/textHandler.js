// textHandler.js
import { processText } from './textProcessor.js';
import { hideLoadingBar } from '../main.js';
import { clearOutput, updatePageIndicator } from '../utils/renderUtils.js';
import { getPagesPerView } from '../utils/viewModeUtils.js';
import { enableContinuousScrollTracking, scrollByViewport } from '../utils/scrollUtils.js';

// State management for text files
export const textState = {
    currentPageIndex: 0,
    pages: [], // For page mode
    fullContent: null, // For continuous mode
    reset() {
        this.pages.length = 0;
        this.currentPageIndex = 0;
        this.fullContent = null;
    }
};

/**
 * Render text pages based on view mode
 */
export function renderTextPage(output, pageModeChecked) {
    clearOutput(output);
    
    const pageIndicator = document.getElementById('pageIndicator');
    
    if (pageModeChecked) {
        output.style.overflowY = 'hidden';
        const pagesPerView = getPagesPerView(false); // false = PDF mode
        
        // Create outer container that fills the viewport
        const outerContainer = document.createElement('div');
        outerContainer.className = 'outer-container';

        // Create page container
        const container = document.createElement('div');
        container.className = 'pageContainer';

        const startIndex = textState.currentPageIndex;
        
        // Add pages for the current view with flex layout
        for (let i = 0; i < pagesPerView; i++) {
            const page = textState.pages[startIndex + i];
            if (!page) break;
            
            // Each page is already sized correctly from textProcessor
            const clonedPage = page.cloneNode(true);
            container.appendChild(clonedPage);
        }

        outerContainer.appendChild(container);
        output.appendChild(outerContainer);

        // Update page indicator for page mode
        updatePageIndicator(
            pageIndicator,
            textState.currentPageIndex,
            textState.pages.length,
            pagesPerView
        );
    } else {
        // Continuous mode 
        output.className = 'continuous-mode';

        if (textState.fullContent) {
            // Create a wrapper just like PDF does
            const wrapper = document.createElement('div');
            const content = textState.fullContent.cloneNode(true);
            wrapper.appendChild(content);
            output.appendChild(wrapper);

            // Enable scroll tracking like PDFs do
            enableContinuousScrollTracking(output, [content], (newPage) => {
                textState.currentPageIndex = newPage;
                const scrollPercent = (output.scrollTop / (output.scrollHeight - output.clientHeight) * 100) || 0;
                pageIndicator.textContent = `${Math.round(scrollPercent)}%`;
            });
        }
    }
}

/**
 * Load a text tab file into the app.
 */
export async function loadText(file, output, pageModeRadio, continuousModeRadio) {
    // Reset state and clear output
    textState.reset();
    clearOutput(output);
    
    try {
        // Process text content for both modes up front
        const { fullContent, pages } = await processText(file);
        
        // Store both representations
        textState.fullContent = fullContent;
        textState.pages = pages;
        
        // Render based on current mode
        const pageModeChecked = pageModeRadio.checked;
        renderTextPage(output, pageModeChecked);
        
        // Initialize page indicator
        const pageIndicator = document.getElementById('pageIndicator');
        if (!pageModeChecked) {
            pageIndicator.textContent = '0%';
        }
    } catch (err) {
        console.error('Error loading text file:', err);
        hideLoadingBar();
    }
}

/**
 * Navigate to next text page, considering two-page view
 * @returns {boolean} Whether navigation was successful
 */
export function nextTextPage(step = null) {
    if (!textState.pages.length) return false;
    const pagesPerView = getPagesPerView('txt');
    let advanceStep = step;
    if (advanceStep === null) {
        const selected = document.querySelector('input[name="pageAdvanceRadio"]:checked');
        const advancePages = selected ? parseInt(selected.value, 10) : 2;
        advanceStep = advancePages === 1 ? 1 : pagesPerView;
    }
    const newIndex = Math.min(textState.currentPageIndex + advanceStep, Math.max(0, textState.pages.length - pagesPerView));
    if (newIndex !== textState.currentPageIndex) {
        textState.currentPageIndex = newIndex;
        return true;
    }
    return false;
}

/**
 * Navigate to previous text page
 * @param {number|null} step - Optional page step count
 * @returns {boolean} Whether navigation was successful
 */
export function prevTextPage(step = null) {
    if (!textState.pages.length) return false;
    let advanceStep = step;
    if (advanceStep === null) {
        const selected = document.querySelector('input[name="pageAdvanceRadio"]:checked');
        const advancePages = selected ? parseInt(selected.value, 10) : 2;
        advanceStep = advancePages === 1 ? 1 : getPagesPerView('txt');
    }
    const newIndex = Math.max(0, textState.currentPageIndex - advanceStep);
    if (newIndex !== textState.currentPageIndex) {
        textState.currentPageIndex = newIndex;
        return true;
    }
    return false;
}