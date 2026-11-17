// textProcessor.js
import { setTextPagesPerView, getLandscapePageLayout } from '../utils/viewModeUtils.js';
import { attachPillCursor } from '../utils/readerCursorShape.js';
import { decodeText } from '../utils/decodeText.js';
import { groupBlocks, paginate, createChordLyricSegments, sliceAnnotationCols } from './textBlocks.js';
import { resolveTabTuning, capoFromHeaderText } from '../utils/tabTuningMeta.js';
import { resolveTabTempoAndMeter } from '../classtab/tabTempoMeta.js';

const PAGE_PADDING = 20;
let scrollFit = 1, scrollBase = 1;
const MIN_TEXT_PX = 2; // only a guard against a degenerate line; a text tab always shrinks to the width and never scrolls sideways
let textMaxScalePercent = null; // page mode
let textMaxScrollPercent = null; // scroll mode
/** Largest zoom % at which the open text tab still fits its page (null: no limit below the slider's own). */
export function getTextMaxScalePercent(pageMode = true) { return pageMode ? textMaxScalePercent : textMaxScrollPercent; }

const HEADER_SKIP_LINE = /^\s*(?:[#*=~_-]{10,}|#[-]+PLEASE NOTE[-]+#|#.*represents (?:his|their) interpretation.*#|#.*private study, scholarship.*#)\s*$/i;

/**
 * Process text content into continuous vertical mode, paginated pages, and (when staff systems exist) a horizontal ribbon.
 */
export async function processText(file, options = {}) {
    try {
        // Not file.text(): that always reads UTF-8 and turns GBK, Big5, Shift-JIS and Latin-1 tabs into U+FFFD
        const text = decodeText(await file.arrayBuffer());
        const lines = text.replace(/\r\n?/g, '\n').split('\n');

        // A page may only break between blocks: a staff system (ruler, strings, marks) is one block, never split.
        const blocks = groupBlocks(lines);
        const systemBlocks = blocks.filter(b => b.kind === 'system');
        const hasSystems = systemBlocks.length > 0;
        const versions = hasSystems
            ? [...new Set(systemBlocks.map(b => b.version || 1))]
            : [1];
        const activeVersion = options.version && versions.includes(options.version) ? options.version : versions[0];

        const tuningInfo = resolveTabTuning({
            classtabFlag: file.classtabTuning,
            headerText: text,
            fileName: file.name
        });
        const capoFret = capoFromHeaderText(text) || 0;
        const tempoMeta = resolveTabTempoAndMeter({ headerText: text, blocks });

        // Build vertical content, paginated pages, and horizontal ribbon for the active version
        const { fullContent, pages, ribbonContent } = buildVersionedTextViews(lines, blocks, {
            version: activeVersion,
            versions,
            hasSystems
        });

        return {
            fullContent,
            pages,
            ribbonContent,
            blocks,
            lines,
            rawText: text,
            hasSystems,
            versions,
            activeVersion,
            tuning: tuningInfo.tuning,
            tuningSource: tuningInfo.source,
            capoFret,
            tempoMeta
        };
    } catch (error) {
        console.error('Error processing text:', error);
        throw error;
    }
}

/**
 * Builds `fullContent` (Vertical mode), `pages` (Page mode), and `ribbonContent` (Horizontal mode)
 * filtered to the selected `version` when a text file contains multiple versions (`versions.length > 1`).
 */
export function buildVersionedTextViews(lines, blocks, { version = 1, versions = [1], hasSystems = false } = {}) {
    const multiVersion = hasSystems && versions.length > 1;
    const firstSysIdx = blocks.findIndex(b => b.kind === 'system');
    const filteredBlocks = [];
    const filteredElements = [];

    for (let i = 0; i < blocks.length; i++) {
        const blk = blocks[i];
        const bVer = blk.version || 1;
        // Keep shared preamble before the first system, or blocks belonging to the selected version
        if (multiVersion && i >= firstSysIdx && firstSysIdx !== -1 && bVer !== version) {
            continue;
        }
        const el = buildBlockElement(lines, blk);
        if (blk.kind !== 'blank') el.dataset.block = String(i);
        filteredBlocks.push(blk);
        filteredElements.push(el);
    }

    const fullContent = document.createElement('div');
    fullContent.className = 'text-content';
    fullContent.tabIndex = 0;
    filteredElements.forEach(line => fullContent.appendChild(line.cloneNode(true)));
    fullContent.setAttribute('role', 'document');
    requestAnimationFrame(() => {
        fullContent.focus();
    });

    const pages = createPaginatedPages(filteredElements, filteredBlocks);
    if (scrollFit < 1) fullContent.style.setProperty('--text-scale', String(+(scrollBase * scrollFit).toFixed(4)));

    const ribbonContent = hasSystems
        ? buildHorizontalRibbon(lines, blocks, { version })
        : null;

    return { fullContent, pages, ribbonContent };
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
        container.dataset.trimCols = String(block.trimCols || 0);
        const maxCols = block.bars?.length ? block.bars[block.bars.length - 1].colEnd : 0;
        container.dataset.maxCols = String(maxCols);
        for (let i = block.start; i <= block.end; i++) container.appendChild(textLine(lines[i]));
        const cursor = document.createElement('div');
        cursor.className = 'ts-bar-cursor';
        cursor.setAttribute('aria-hidden', 'true');
        cursor.hidden = true;
        attachPillCursor(cursor);
        container.appendChild(cursor);
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

/**
 * Builds the lossless 3-track Horizontal Ribbon DOM (`above`, `strings`, `below`) with a sticky string-tuning gutter,
 * compact header above, stationary 25% playhead, clickable `.ts-bar` segments, and collapsible footer legend disclosure.
 */
export function buildHorizontalRibbon(lines, blocks, { version = 1 } = {}) {
    const root = document.createElement('div');
    root.className = 'txt-ribbon-view';

    const sysEntries = [];
    blocks.forEach((b, idx) => {
        if (b.kind === 'system' && (b.version || 1) === version) {
            sysEntries.push({ block: b, blockIdx: idx });
        }
    });

    if (!sysEntries.length) return root;

    const firstSysStart = sysEntries[0].block.start;
    const headerLines = [];
    for (let i = 0; i < firstSysStart; i++) {
        const l = lines[i];
        if (!l || !l.trim() || HEADER_SKIP_LINE.test(l)) continue;
        headerLines.push(l.trimEnd());
    }

    // 1. Compact Header
    if (headerLines.length > 0) {
        const headerEl = document.createElement('div');
        headerEl.className = 'txt-ribbon-header';

        const topRow = document.createElement('div');
        topRow.className = 'txt-ribbon-header-top';

        const summaryBox = document.createElement('div');
        summaryBox.className = 'txt-ribbon-header-summary';
        const primaryLines = headerLines.slice(0, 3);
        primaryLines.forEach((hl) => {
            const d = document.createElement('div');
            d.className = 'txt-ribbon-header-line';
            d.textContent = hl;
            summaryBox.appendChild(d);
        });
        topRow.appendChild(summaryBox);
        headerEl.appendChild(topRow);

        if (headerLines.length > 3) {
            const more = document.createElement('details');
            more.className = 'txt-ribbon-header-more';
            const sum = document.createElement('summary');
            sum.textContent = `Header notes (${headerLines.length - 3} more lines)`;
            const pre = document.createElement('pre');
            pre.className = 'txt-ribbon-notes-pre';
            pre.textContent = headerLines.slice(3).join('\n');
            more.append(sum, pre);
            headerEl.appendChild(more);
        }

        root.appendChild(headerEl);
    }

    // 2. Compute uniform row heights across all systems for 3-track baseline locking
    const maxAboveRows = Math.max(1, ...sysEntries.map(e => (e.block.above || []).length));
    const maxBelowRows = Math.max(0, ...sysEntries.map(e => (e.block.below || []).length));
    const firstSys = sysEntries[0].block;
    const stringCount = firstSys.strings?.length || 6;
    const defaultLabels = ['e', 'B', 'G', 'D', 'A', 'E'];
    const gutterLabels = Array.from({ length: stringCount }, (_, r) => {
        const raw = firstSys.stringLabels?.[r] || defaultLabels[r % 6];
        return `${raw}|`;
    });

    // 3. Ribbon Stage (stationary playhead + horizontal scroll container)
    const stage = document.createElement('div');
    stage.className = 'txt-ribbon-stage';
    stage.style.setProperty('--above-rows', String(maxAboveRows));
    stage.style.setProperty('--string-rows', String(stringCount));
    stage.style.setProperty('--below-rows', String(maxBelowRows));

    const playhead = document.createElement('div');
    playhead.className = 'txt-ribbon-playhead';
    playhead.setAttribute('aria-hidden', 'true');
    attachPillCursor(playhead);
    stage.appendChild(playhead);

    const scrollEl = document.createElement('div');
    scrollEl.className = 'txt-ribbon-scroll';
    scrollEl.tabIndex = 0;
    scrollEl.setAttribute('role', 'document');
    scrollEl.setAttribute('aria-label', 'Horizontal tab ribbon');

    const track = document.createElement('div');
    track.className = 'txt-ribbon-track';

    // Sticky Left String Gutter
    const gutter = document.createElement('div');
    gutter.className = 'txt-ribbon-gutter';
    gutter.setAttribute('aria-hidden', 'true');

    const gutterAbove = document.createElement('div');
    gutterAbove.className = 'txt-ribbon-above';
    for (let i = 0; i < maxAboveRows; i++) {
        gutterAbove.appendChild(textLine(' ', 'txt-ribbon-line'));
    }

    const gutterStrings = document.createElement('div');
    gutterStrings.className = 'txt-ribbon-strings';
    gutterLabels.forEach((lbl) => {
        gutterStrings.appendChild(textLine(lbl, 'txt-ribbon-line txt-gutter-label'));
    });

    const gutterBelow = document.createElement('div');
    gutterBelow.className = 'txt-ribbon-below';
    for (let i = 0; i < maxBelowRows; i++) {
        gutterBelow.appendChild(textLine(' ', 'txt-ribbon-line'));
    }

    gutter.append(gutterAbove, gutterStrings, gutterBelow);
    track.appendChild(gutter);

    // Lead spacer so Bar 1 starts right at the 25% playhead
    const leadPad = document.createElement('div');
    leadPad.className = 'txt-ribbon-lead-pad';
    leadPad.setAttribute('aria-hidden', 'true');
    track.appendChild(leadPad);

    // System segments and their clickable `.ts-bar` children
    let visualBarIdx = 0;
    for (let sIdx = 0; sIdx < sysEntries.length; sIdx++) {
        const { block, blockIdx } = sysEntries[sIdx];
        const sysEl = document.createElement('div');
        sysEl.className = 'txt-ribbon-system';
        sysEl.dataset.block = String(blockIdx);

        const bars = block.bars || [];
        const above = block.above || [];
        const strings = block.strings || [];
        const below = block.below || [];

        for (let k = 0; k < bars.length; k++) {
            const bar = bars[k];
            let sliceStart = bar.colStart;
            const sliceEnd = bar.colEnd;

            // Strip redundant single opening barline when joining after the gutter or previous bar's closing barline
            if (k === 0 && !bar.repeatStart && !bar.doubleBar && sliceEnd - sliceStart > 2) {
                const firstChars = strings.map(s => s[sliceStart] || '');
                const allSinglePipe = firstChars.filter(ch => ch === '|' || ch === ']' || ch === '+').length >= Math.ceil(strings.length * 0.5);
                const nextChars = strings.map(s => s[sliceStart + 1] || '');
                const nextHasPipe = nextChars.some(ch => ch === '|' || ch === '*' || ch === 'o' || ch === ':');
                if (allSinglePipe && !nextHasPipe) {
                    sliceStart += 1;
                }
            }

            const barWidth = Math.max(1, sliceEnd - sliceStart);
            const barEl = document.createElement('div');
            barEl.className = 'ts-bar';
            if (bar.repeatStart) barEl.classList.add('is-repeat-start');
            if (bar.repeatEnd) barEl.classList.add('is-repeat-end');
            if (bar.doubleBar) barEl.classList.add('is-double-bar');
            barEl.dataset.block = String(blockIdx);
            barEl.dataset.barOffset = String(k);
            barEl.dataset.visualBar = String(visualBarIdx);
            barEl.dataset.barNumber = String(bar.barNumber ?? (visualBarIdx + 1));

            // Top track: `above` lines padded at top to `maxAboveRows`
            const aboveBox = document.createElement('div');
            aboveBox.className = 'txt-ribbon-above';
            const padTopCount = Math.max(0, maxAboveRows - above.length);
            for (let p = 0; p < padTopCount; p++) {
                aboveBox.appendChild(textLine(' '.repeat(barWidth), 'txt-ribbon-line txt-anno-line'));
            }
            for (let a = 0; a < above.length; a++) {
                const rawLine = above[a] || '';
                const seg = (k === 0 && sliceStart > 0)
                    ? sliceAnnotationCols(rawLine, sliceStart).slice(0, barWidth).padEnd(barWidth, ' ')
                    : rawLine.slice(sliceStart, sliceEnd).padEnd(barWidth, ' ');
                aboveBox.appendChild(textLine(seg, 'txt-ribbon-line txt-anno-line'));
            }

            // Middle track: `strings` lines
            const stringsBox = document.createElement('div');
            stringsBox.className = 'txt-ribbon-strings';
            for (let r = 0; r < stringCount; r++) {
                const sLine = strings[r] || '';
                const seg = sLine.slice(sliceStart, sliceEnd).padEnd(barWidth, '-');
                stringsBox.appendChild(textLine(seg, 'txt-ribbon-line txt-string-line'));
            }

            // Bottom track: `below` lines padded at bottom to `maxBelowRows`
            const belowBox = document.createElement('div');
            belowBox.className = 'txt-ribbon-below';
            for (let b = 0; b < below.length; b++) {
                const rawLine = below[b] || '';
                const seg = (k === 0 && sliceStart > 0)
                    ? sliceAnnotationCols(rawLine, sliceStart).slice(0, barWidth).padEnd(barWidth, ' ')
                    : rawLine.slice(sliceStart, sliceEnd).padEnd(barWidth, ' ');
                belowBox.appendChild(textLine(seg, 'txt-ribbon-line txt-anno-line'));
            }
            const padBotCount = Math.max(0, maxBelowRows - below.length);
            for (let p = 0; p < padBotCount; p++) {
                belowBox.appendChild(textLine(' '.repeat(barWidth), 'txt-ribbon-line txt-anno-line'));
            }

            barEl.append(aboveBox, stringsBox, belowBox);
            sysEl.appendChild(barEl);
            visualBarIdx++;
        }

        track.appendChild(sysEl);
    }

    // Trail spacer so the final bar can glide across the 25% playhead
    const trailPad = document.createElement('div');
    trailPad.className = 'txt-ribbon-trail-pad';
    trailPad.setAttribute('aria-hidden', 'true');
    track.appendChild(trailPad);

    scrollEl.appendChild(track);
    stage.appendChild(scrollEl);
    root.appendChild(stage);

    // 4. Collapsible Footer Legend Disclosure
    const lastSysEnd = sysEntries[sysEntries.length - 1].block.end;
    const legendLines = [];
    for (const blk of blocks) {
        if ((blk.version || 1) !== version) continue;
        if (blk.inLegend || blk.start > lastSysEnd) {
            for (let i = blk.start; i <= blk.end; i++) {
                if (!HEADER_SKIP_LINE.test(lines[i] || '')) legendLines.push(lines[i]);
            }
        }
    }
    while (legendLines.length && !legendLines[0].trim()) legendLines.shift();
    while (legendLines.length && !legendLines[legendLines.length - 1].trim()) legendLines.pop();

    if (legendLines.length > 0) {
        const details = document.createElement('details');
        details.className = 'txt-ribbon-legend';
        const summary = document.createElement('summary');
        summary.textContent = 'Notes and legend';
        const pre = document.createElement('pre');
        pre.className = 'txt-ribbon-notes-pre';
        pre.textContent = legendLines.join('\n');
        details.append(summary, pre);
        root.appendChild(details);
    }

    return root;
}

const MIN_PAGE_COLUMNS = 48;

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
    // A page is never narrower than MIN_PAGE_COLUMNS characters, so a one-line note is not a thin strip
    const widthPad = document.createElement('div');
    widthPad.textContent = ' '.repeat(MIN_PAGE_COLUMNS);
    probe.appendChild(widthPad);
    const naturalWidth = Math.ceil(probe.scrollWidth) + PAGE_PADDING * 2 + PAGE_BORDER;
    probe.removeChild(widthPad);
    const tallestBlock = Math.max(1, ...[...probe.children].map(c => c.offsetHeight));
    document.body.removeChild(probe);
    const MAX_PAGES = getLandscapePageLayout() === 'single' ? 1 : 6;
    let pagesPerView = 1;
    for (let n = 2; n <= MAX_PAGES; n++) {
        if (widthPerPage(n) >= naturalWidth) pagesPerView = n; else break;
    }
    // A landscape screen too narrow for two natural-size pages still gets two when the text can shrink to a legible size.
    const chrome = PAGE_PADDING * 2 + PAGE_BORDER;
    const MIN_TWO_PAGE_FIT = 0.5;
    if (pagesPerView === 1 && MAX_PAGES > 1 && window.innerWidth / window.innerHeight > 4 / 3
        && ((widthPerPage(2) - chrome) / Math.max(1, naturalWidth - chrome)) * 0.99 >= MIN_TWO_PAGE_FIT) pagesPerView = 2;
    setTextPagesPerView(pagesPerView);
    // When even one page is narrower than the text (a phone), the text shrinks to fit instead of being cut off.
    // Monospace text scales linearly, so scale the text part of the width; stop at a size that is still legible.
    const baseScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--text-scale')) || 1;
    let fit = 1;
    if (naturalWidth > widthPerPage(pagesPerView)) {
        fit = Math.min(1, ((widthPerPage(pagesPerView) - chrome) / (naturalWidth - chrome)) * 0.99);
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
