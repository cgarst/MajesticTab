// textHandler.js
import { processText, buildHorizontalRibbon, buildVersionedTextViews } from './textProcessor.js';
import { hideLoadingBar } from '../main.js';
import { showLoadingCard, setLoadingProgress, hideLoadingCard } from '../utils/loadingCard.js';
import { clearOutput, updatePageIndicator } from '../utils/renderUtils.js';
import { getPagesPerView } from '../utils/viewModeUtils.js';
import { enableContinuousScrollTracking } from '../utils/scrollUtils.js';

// State management for text files
export const textState = {
    currentPageIndex: 0,
    pages: [], // For page mode
    fullContent: null, // For vertical continuous mode
    ribbonContent: null, // For horizontal ribbon mode
    blocks: [],
    lines: [],
    rawText: '',
    hasSystems: false,
    versions: [1],
    activeVersion: 1,
    tuning: null,
    tuningSource: null,
    capoFret: 0,
    tempoMeta: null,
    alignment: null,
    layoutMode: 'vertical', // 'page' | 'vertical' | 'horizontal'
    reset() {
        this.pages.length = 0;
        this.currentPageIndex = 0;
        this.fullContent = null;
        this.ribbonContent = null;
        this.blocks = [];
        this.lines = [];
        this.rawText = '';
        this.hasSystems = false;
        this.versions = [1];
        this.activeVersion = 1;
        this.tuning = null;
        this.tuningSource = null;
        this.capoFret = 0;
        this.tempoMeta = null;
        this.alignment = null;
        document.body.classList.remove('txt-has-bars', 'txt-horizontal-mode');
    }
};

export function setTextLayoutMode(mode) {
    if (mode === 'page' || mode === 'vertical' || mode === 'horizontal') {
        textState.layoutMode = mode;
    }
}

export function setTextVersion(version) {
    if (!textState.hasSystems || !textState.versions.includes(version) || textState.activeVersion === version) return;
    textState.activeVersion = version;
    textState.currentPageIndex = 0;
    const views = buildVersionedTextViews(textState.lines, textState.blocks, {
        version,
        versions: textState.versions,
        hasSystems: textState.hasSystems
    });
    textState.fullContent = views.fullContent;
    textState.pages = views.pages;
    textState.ribbonContent = views.ribbonContent;

    const output = document.getElementById('output');
    const pageModeRadio = document.getElementById('pageModeRadio');
    if (output) renderTextPage(output, Boolean(pageModeRadio?.checked));
    window.dispatchEvent(new CustomEvent('majestictab:txt-version-changed', { detail: { version } }));
}

/**
 * Render text pages based on view mode ('page', 'vertical', or 'horizontal')
 */
export function renderTextPage(output, pageModeChecked) {
    clearOutput(output);
    
    const pageIndicator = document.getElementById('pageIndicator');
    const isHorizontal = !pageModeChecked && textState.hasSystems && textState.layoutMode === 'horizontal' && textState.ribbonContent;
    document.body.classList.toggle('txt-horizontal-mode', Boolean(isHorizontal));
    
    if (pageModeChecked) {
        textState.layoutMode = 'page';
        output.style.overflowY = 'hidden';
        const pagesPerView = getPagesPerView('txt');
        
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
    } else if (isHorizontal) {
        // Horizontal ribbon mode
        output.className = 'continuous-mode txt-ribbon-output';
        output.style.overflowY = 'auto';
        const ribbon = buildHorizontalRibbon(textState.lines, textState.blocks, {
            version: textState.activeVersion
        });
        output.appendChild(ribbon);
        const scrollEl = ribbon.querySelector('.txt-ribbon-scroll');
        if (scrollEl && pageIndicator) {
            const updatePct = () => {
                const maxScroll = Math.max(1, scrollEl.scrollWidth - scrollEl.clientWidth);
                const pct = Math.min(100, Math.max(0, Math.round((scrollEl.scrollLeft / maxScroll) * 100)));
                pageIndicator.textContent = `${pct}%`;
            };
            scrollEl.addEventListener('scroll', updatePct, { passive: true });
            updatePct();
        }
    } else {
        // Continuous vertical mode
        if (textState.layoutMode === 'page') textState.layoutMode = 'vertical';
        output.className = 'continuous-mode';
        output.style.overflowY = '';

        if (textState.fullContent) {
            // Create a wrapper just like PDF does
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'width:100%;min-width:0'; // as wide as the screen, never as wide as the longest line
            const content = textState.fullContent.cloneNode(true);
            wrapper.appendChild(content);
            output.appendChild(wrapper);

            // Enable scroll tracking like PDFs do
            enableContinuousScrollTracking(output, [content], (newPage) => {
                textState.currentPageIndex = newPage;
                const scrollPercent = (output.scrollTop / (output.scrollHeight - output.clientHeight) * 100) || 0;
                if (pageIndicator) pageIndicator.textContent = `${Math.round(scrollPercent)}%`;
            });
        }
    }
}

/**
 * Load a text tab file into the app.
 */
export async function loadText(file, output, pageModeRadio, continuousModeRadio) {
    const prevLayout = textState.layoutMode;
    textState.reset();
    clearOutput(output);

    const loadingToken = showLoadingCard(output, {
        title: file.librarySongTitle || file.songTitle || file.tabName || (file.name || '').replace(/\.[^/.]+$/, ''),
        subtitle: file.artist || '',
        coverUrl: file.coverUrl || '',
        stage: 'Reading file…'
    });
    try {
        setLoadingProgress(loadingToken, 30, 'Laying out pages…');
        const processed = await processText(file);
        setLoadingProgress(loadingToken, 80, 'Rendering…');
        
        textState.fullContent = processed.fullContent;
        textState.pages = processed.pages;
        textState.ribbonContent = processed.ribbonContent;
        textState.blocks = processed.blocks;
        textState.lines = processed.lines;
        textState.rawText = processed.rawText;
        textState.hasSystems = processed.hasSystems;
        textState.versions = processed.versions;
        textState.activeVersion = processed.activeVersion;
        textState.tuning = processed.tuning;
        textState.tuningSource = processed.tuningSource;
        textState.capoFret = processed.capoFret;
        textState.tempoMeta = processed.tempoMeta;
        if (processed.capoFret > 0) {
            file.detectedCapo = processed.capoFret;
        }

        document.body.classList.toggle('txt-has-bars', Boolean(processed.hasSystems));

        const pageModeChecked = pageModeRadio.checked;
        if (pageModeChecked) {
            textState.layoutMode = 'page';
        } else if (prevLayout === 'horizontal' && processed.hasSystems) {
            textState.layoutMode = 'horizontal';
        } else {
            textState.layoutMode = 'vertical';
        }
        renderTextPage(output, pageModeChecked);
        
        // Initialize page indicator
        const pageIndicator = document.getElementById('pageIndicator');
        if (!pageModeChecked && pageIndicator) {
            pageIndicator.textContent = '0%';
        }
    } catch (err) {
        console.error('Error loading text file:', err);
        hideLoadingBar();
    } finally {
        setLoadingProgress(loadingToken, 100, 'Ready');
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        hideLoadingCard(loadingToken, output);
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
