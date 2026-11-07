// textProcessor.js
import { setTextPagesPerView, getLandscapePageLayout } from '../utils/viewModeUtils.js';
import { decodeText } from '../utils/decodeText.js';
import { groupBlocks, paginate, createChordLyricSegments } from './textBlocks.js';

const PAGE_PADDING = 20;
let scrollFit = 1, scrollBase = 1;
const MIN_TEXT_PX = 8; // a WebView stops shrinking text at about 8px, so a smaller size only cuts lines off at the edge; wider text scrolls sideways instead
let textMaxScalePercent = null; // page mode
let textMaxScrollPercent = null; // scroll mode
/** Largest zoom % at which the open text tab still fits its page (null: no limit below the slider's own). */
export function getTextMaxScalePercent(pageMode = true) { return pageMode ? textMaxScalePercent : textMaxScrollPercent; }

/**
 * Process text content into either continuous mode or pages
 */
export async function processText(file) {
    try {
        // Not file.text(): that always reads UTF-8 and turns GBK, Big5, Shift-JIS and Latin-1 tabs into U+FFFD
        const text = decodeText(await file.arrayBuffer());
        const lines = text.replace(/\r\n?/g, '\n').split('\n');

        // A page may only break between blocks: a staff system (ruler, strings, marks) is one block, never split.
        const blocks = groupBlocks(lines);
        const allProcessedLines = blocks.map(block => buildBlockElement(lines, block));

        // Each block (a line, a staff system, a chord-and-lyric line) is numbered so sync points can name it.
        // Gaps carry no id: nothing to sync to.
        allProcessedLines.forEach((el, i) => { if (blocks[i].kind !== 'blank') el.dataset.block = String(i); });

        // Create the full content element for continuous mode
        const fullContent = document.createElement('div');
        fullContent.className = 'text-content';
        fullContent.tabIndex = 0; // Make focusable for keyboard navigation
        allProcessedLines.forEach(line => fullContent.appendChild(line.cloneNode(true)));

        // Set up focus handling and make sure it's keyboard-navigable
        fullContent.setAttribute('role', 'document');

        // Focus after content is added and rendered
        requestAnimationFrame(() => {
            fullContent.focus();
        });

        // Create pages for page mode
        const pages = createPaginatedPages(allProcessedLines, blocks);
        // Scroll mode: shrink to the width (24px padding and a 1px border a side, at most 1200px wide) so nothing is cut off
        if (scrollFit < 1) fullContent.style.setProperty('--text-scale', String(+(scrollBase * scrollFit).toFixed(4)));

        return {
            fullContent,
            pages
        };
    } catch (error) {
        console.error('Error processing text:', error);
        throw error;
    }
}

function textLine(line, extraClass) {
    const div = document.createElement('div');
    div.className = extraClass ? `text-line ${extraClass}` : 'text-line';
    div.textContent = line;
    return div;
}

function buildBlockElement(lines, block) {
    if (block.kind === 'blank') return textLine('', 'text-gap');
    if (block.kind === 'system') {
        const container = document.createElement('div');
        container.className = 'tab-section-container';
        for (let i = block.start; i <= block.end; i++) container.appendChild(textLine(lines[i]));
        return container;
    }
    if (block.kind === 'chord') {
        const wrapper = document.createElement('div');
        wrapper.className = 'chord-lyric-line';
        createChordLyricSegments(lines[block.start], lines[block.end]).forEach(segment => {
            const segmentDiv = document.createElement('div');
            segmentDiv.className = 'chord-lyric-segment';
            const chordSpan = document.createElement('span');
            chordSpan.textContent = segment.chord;
            chordSpan.className = 'chord-lyric-chord';
            const lyricSpan = document.createElement('span');
            lyricSpan.textContent = segment.lyric;
            segmentDiv.appendChild(chordSpan);
            segmentDiv.appendChild(lyricSpan);
            wrapper.appendChild(segmentDiv);
        });
        return wrapper;
    }
    return textLine(lines[block.start]);
}

function createPaginatedPages(processedLines, blocks) {
    const pages = [];
    // #output reserves 80px at the bottom; the container and the wrapper
    // each add vertical padding and the wrapper adds a 1px border.
    const outputEl = document.getElementById('output');
    const outputHeight = outputEl?.clientHeight || window.innerHeight;
    const pageHeight = outputHeight - 80 - PAGE_PADDING * 2 - 2;
    // The text area's own width, not the window's: the library rail and the open Practice panel take space too.
    const outStyle = outputEl ? getComputedStyle(outputEl) : null;
    const outputWidth = outputEl
        ? outputEl.clientWidth - (parseFloat(outStyle.paddingLeft) || 0) - (parseFloat(outStyle.paddingRight) || 0)
        : window.innerWidth;
    // .pageContainer pads 20px a side and puts 20px between pages; a lone page is capped at 95% of that.
    const CONTAINER_PAD = 20, PAGE_GAP = 20, PAGE_BORDER = 2;
    const inner = Math.max(0, outputWidth - CONTAINER_PAD * 2);
    const widthPerPage = n => (n === 1 ? inner * 0.95 : (inner - PAGE_GAP * (n - 1)) / n);

    // How many pages sit side by side follows the text itself: a narrow tab leaves room for more pages at the same
    // size, a wide one gets one. Measure the widest line at its natural width; add pages only while it still fits.
    const probe = document.createElement('div');
    probe.className = 'measure-div';
    probe.style.cssText = 'position:absolute;visibility:hidden;width:max-content;white-space:pre';
    processedLines.forEach(el => probe.appendChild(el.cloneNode(true)));
    document.body.appendChild(probe);
    const naturalWidth = Math.ceil(probe.scrollWidth) + PAGE_PADDING * 2 + PAGE_BORDER;
    const tallestBlock = Math.max(1, ...[...probe.children].map(c => c.offsetHeight));
    document.body.removeChild(probe);
    const MAX_PAGES = getLandscapePageLayout() === 'single' ? 1 : 6;
    let pagesPerView = 1;
    for (let n = 2; n <= MAX_PAGES; n++) {
        if (widthPerPage(n) >= naturalWidth) pagesPerView = n; else break;
    }
    setTextPagesPerView(pagesPerView);
    // When even one page is narrower than the text (a phone), the text shrinks to fit instead of being cut off.
    // Monospace text scales linearly, so scale the text part of the width; stop at a size that is still legible.
    const baseScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--text-scale')) || 1;
    let fit = 1;
    if (pagesPerView === 1 && naturalWidth > widthPerPage(1)) {
        const chrome = PAGE_PADDING * 2 + PAGE_BORDER;
        fit = Math.min(1, ((widthPerPage(1) - chrome) / (naturalWidth - chrome)) * 0.99);
    }
    // A block (a staff system) is never split, so one taller than a page shrinks the text until it fits.
    const maxHeight = pageHeight - PAGE_PADDING * 2;
    if (tallestBlock * fit > maxHeight) fit = (maxHeight / tallestBlock) * 0.99;
    // The zoom control stops at the size that fits, or at the smallest legible size (see MIN_TEXT_PX).
    const minFit = Math.min(1, MIN_TEXT_PX / (14 * baseScale));
    fit = Math.max(minFit, fit);
    const scrollAvail = Math.min(outputWidth, 1200) - 50;
    const textPart = Math.max(1, naturalWidth - PAGE_PADDING * 2 - PAGE_BORDER);
    scrollFit = Math.max(Math.min(1, MIN_TEXT_PX / (14 * baseScale)), Math.min(1, (scrollAvail / textPart) * 0.99));
    scrollBase = baseScale;
    textMaxScrollPercent = scrollFit < 1 ? Math.floor(baseScale * scrollFit * 100) : null;
    textMaxScalePercent = fit < 1 ? Math.floor(baseScale * fit * 100) : null;
    const fitScale = String(+(baseScale * fit).toFixed(4));
    const fittedNatural = Math.ceil((naturalWidth - PAGE_PADDING * 2 - PAGE_BORDER) * fit) + PAGE_PADDING * 2 + PAGE_BORDER;
    // A page is only as wide as its text (never wider than its share of the area), so no empty strip sits beside it.
    const availableWidth = Math.min(Math.floor(widthPerPage(pagesPerView)), fittedNatural);

    // Create a temporary div to measure content height
    const measureDiv = document.createElement('div');
    measureDiv.className = 'measure-div';
    measureDiv.style.setProperty('--text-scale', fitScale);
    measureDiv.style.width = `${availableWidth - PAGE_PADDING * 2 - PAGE_BORDER}px`;
    document.body.appendChild(measureDiv);
    
    // Each block is measured once; blocks stack without margins, so heights add up.
    const heights = processedLines.map(el => {
        measureDiv.innerHTML = '';
        measureDiv.appendChild(el.cloneNode(true));
        return measureDiv.offsetHeight;
    });

    // Create page function
    function createNewPage(elements) {
        const pageWrapper = document.createElement('div');
        pageWrapper.className = 'pageWrapper';
        pageWrapper.setAttribute('role', 'document');
        pageWrapper.tabIndex = 0;
        pageWrapper.style.width = `${availableWidth}px`;
        pageWrapper.style.flex = '0 0 auto';

        const pageContent = document.createElement('div');
        if (fit < 1) pageContent.style.setProperty('--text-scale', fitScale);

        elements.forEach(el => pageContent.appendChild(el.cloneNode(true)));
        pageWrapper.appendChild(pageContent);
        return pageWrapper;
    }

    paginate(blocks, heights, maxHeight).forEach(indices => {
        pages.push(createNewPage(indices.map(i => processedLines[i])));
    });

    document.body.removeChild(measureDiv);
    return pages;
}