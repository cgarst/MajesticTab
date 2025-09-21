// textProcessor.js
import { getPagesPerView } from '../utils/viewModeUtils.js';

const PAGE_PADDING = 20;

function createChordLyricSegments(chordLine, lyricLine) {
    const segments = [];
    const chordPositions = [];
    let match;
    const chordRegex = /[A-G][m|maj|dim|aug|sus|#|b]?\d*/g;
    
    while ((match = chordRegex.exec(chordLine)) !== null) {
        chordPositions.push({
            pos: match.index,
            chord: match[0]
        });
    }

    // Add a final position marker
    chordPositions.push({ pos: lyricLine.length });

    // Create segments based on chord positions
    for (let i = 0; i < chordPositions.length - 1; i++) {
        const start = chordPositions[i].pos;
        const end = chordPositions[i + 1].pos;
        const chord = chordPositions[i].chord || '';
        const lyric = lyricLine.substring(start, end);

        segments.push({ chord, lyric });
    }

    return segments;
}

/**
 * Process text content into either continuous mode or pages
 */
export async function processText(file) {
    try {
        const text = await file.text();

        // First identify [Section] markers and split while preserving them
        const sectionMarkerRegex = /^\[.*?\]$/m;
        const lines = text.split('\n');
        let contentSections = [];
        let currentSection = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (sectionMarkerRegex.test(line)) {
                // Add previous section if it exists
                if (currentSection.length > 0) {
                    contentSections.push(currentSection.join('\n'));
                }
                // Start new section with the [Section] marker
                currentSection = [line];
            } else {
                currentSection.push(line);
            }
        }
        
        // Add the last section
        if (currentSection.length > 0) {
            contentSections.push(currentSection.join('\n'));
        }
        
        // If no sections were found, treat the whole text as one section
        if (contentSections.length === 0) {
            // First identify tab notation sections
            const lines = text.split('\n');
            let tabSections = [];
            let currentTab = [];
            let startIdx = -1;

            const isTabLine = line => line.match(/^[eEBGDAa]\|[-\\\/\d\s|~\(\)]*\|?$/);
            const isPartOfTab = line => isTabLine(line) || line.trim().startsWith('|') || line.includes('x');
            
            for (let i = 0; i < lines.length; i++) {
                const currentLine = lines[i].trim();
                const nextLine = lines[i + 1]?.trim();
                const isHeaderForTab = currentLine && nextLine && isTabLine(nextLine);
                
                if (!currentTab.length && (isHeaderForTab || isTabLine(currentLine))) {
                    // Start new tab section
                    startIdx = i;
                    currentTab = [lines[i]];
                } else if (currentTab.length > 0) {
                    currentTab.push(lines[i]);
                    
                    // Check if we're at the end of the tab section
                    const isLastLine = !nextLine || !isPartOfTab(nextLine);
                    
                    if (isPartOfTab(currentLine) && isLastLine) {
                        tabSections.push({
                            start: startIdx,
                            end: i,
                            content: currentTab
                        });
                        currentTab = [];
                        startIdx = -1;
                    }
                }
            }

            // Now split by double newlines while preserving tab sections
            contentSections = [];
            let currentSection = [];
            let skipUntil = -1;

            for (let i = 0; i < lines.length; i++) {
                // Skip lines that are part of a previously added tab section
                if (i <= skipUntil) continue;
                
                const tabSection = tabSections.find(s => i === s.start);
                
                if (tabSection) {
                    // If we have accumulated non-tab content, add it as a section
                    if (currentSection.length > 0) {
                        contentSections.push(currentSection.join('\n'));
                        currentSection = [];
                    }
                    // Add the tab section as its own section
                    contentSections.push(tabSection.content.join('\n'));
                    skipUntil = tabSection.end;
                } else {
                    const line = lines[i];
                    if (line.trim() === '' && lines[i + 1]?.trim() === '') {
                        if (currentSection.length > 0) {
                            contentSections.push(currentSection.join('\n'));
                            currentSection = [];
                        }
                        i++; // Skip the second blank line
                    } else {
                        currentSection.push(line);
                    }
                }
            }

            if (currentSection.length > 0) {
                contentSections.push(currentSection.join('\n'));
            }
        }
        
        // Create the full content element for continuous mode
        const fullContent = document.createElement('div');
        fullContent.className = 'text-content';
        fullContent.tabIndex = 0; // Make focusable for keyboard navigation
        fullContent.style.cssText = `
            width: 100%;
            max-width: 1200px;
            margin: 0 auto;
            padding: 40px;
            font-family: monospace;
            line-height: 1.5;
            background-color: var(--page-bg-color, white);
            color: var(--text-color, black);
            box-shadow: var(--page-shadow, 0 2px 6px rgba(0,0,0,0.1));
            border: 1px solid var(--border-color, #ddd);
            box-sizing: border-box;
            font-size: 14px;
        `;

        // Process each section
        let allProcessedLines = [];
        contentSections.forEach((section, index) => {
            if (index > 0) {
                // Add a minimal separator line between sections (except the first)
                const sectionSeparator = document.createElement('div');
                sectionSeparator.className = 'section-separator';
                sectionSeparator.style.cssText = `
                    margin: 1em 0;
                    border-top: 1px solid var(--separator-color, #ccc);
                `;
                allProcessedLines.push(sectionSeparator);
            }
            
            // Split section into lines
            const lines = section.split('\n');
            const isTabLine = line => line.trim().match(/^[eEBGDAa]\|[-\\\/\d\s|~\(\)]*\|?$/);
            const isChordLine = line => {
                const trimmed = line.trim();
                return trimmed && 
                       (line.replace(/\s/g, '').length / line.length < 0.5) &&
                       /[A-G][m|maj|dim|aug|sus|#|b]?\d*/.test(trimmed);
            };
            let tabContainer = null;
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const nextLine = lines[i + 1];

                // Check for chord-lyric pair first
                if (isChordLine(line) && nextLine && !isTabLine(nextLine) && !isTabLine(line)) {
                    // Create a wrapper for chord-lyric pair
                    const wrapper = document.createElement('div');
                    wrapper.className = 'chord-lyric-line';
                    wrapper.style.cssText = `
                        display: flex;
                        flex-wrap: wrap;
                        gap: 0 4px;
                        width: 100%;
                        white-space: normal;
                    `;

                    // Split into chord-lyric segments
                    const segments = createChordLyricSegments(line, nextLine);
                    segments.forEach(segment => {
                        const segmentDiv = document.createElement('div');
                        segmentDiv.className = 'chord-lyric-segment';
                        segmentDiv.style.cssText = `
                            display: inline-flex;
                            flex-direction: column;
                            align-items: flex-start;
                            font-family: monospace;
                            line-height: 1.5;
                        `;

                        const chordSpan = document.createElement('span');
                        chordSpan.textContent = segment.chord;
                        chordSpan.style.cssText = `
                            min-height: 1.5em;
                            color: #2c5282;
                            font-weight: bold;
                        `;

                        const lyricSpan = document.createElement('span');
                        lyricSpan.textContent = segment.lyric;

                        segmentDiv.appendChild(chordSpan);
                        segmentDiv.appendChild(lyricSpan);
                        wrapper.appendChild(segmentDiv);
                    });

                    if (tabContainer) {
                        allProcessedLines.push(tabContainer);
                        tabContainer = null;
                    }
                    allProcessedLines.push(wrapper);
                    i++; // Skip the lyric line since we've processed it
                    continue;
                }

                // Create div for current line
                const textDiv = document.createElement('div');
                textDiv.style.cssText = `
                    font-family: monospace;
                    line-height: 1.5;
                    white-space: pre-wrap;
                `;
                textDiv.textContent = line;

                // If this is a header (next line is a tab) or a tab line, 
                // start/continue a tab section
                if (nextLine && isTabLine(nextLine) || isTabLine(line) || 
                    (tabContainer && (line.trim().startsWith('|') || line.includes('x')))) {
                    if (!tabContainer) {
                        tabContainer = document.createElement('div');
                        tabContainer.className = 'tab-section-container';
                        tabContainer.style.cssText = 'break-inside: avoid;';
                    }
                    tabContainer.appendChild(textDiv);

                    // If this is the last line of the tab section
                    if (!nextLine || 
                        (!isTabLine(nextLine) && 
                         !nextLine.trim().startsWith('|') && 
                         !nextLine.includes('x'))) {
                        allProcessedLines.push(tabContainer);
                        tabContainer = null;
                    }
                } else {
                    if (tabContainer) {
                        allProcessedLines.push(tabContainer);
                        tabContainer = null;
                    }
                    allProcessedLines.push(textDiv);
                }
            }

            // Add any remaining tab container
            if (tabContainer) {
                allProcessedLines.push(tabContainer);
            }
        });

        // Add all processed lines to the full content
        allProcessedLines.forEach(line => fullContent.appendChild(line.cloneNode(true)));

        // Set up focus handling and make sure it's keyboard-navigable
        fullContent.setAttribute('role', 'document');
        fullContent.tabIndex = 0;

        // Focus after content is added and rendered
        requestAnimationFrame(() => {
            fullContent.focus();
        });

        // Create pages for page mode
        const pages = createPaginatedPages(allProcessedLines);

        return {
            fullContent,
            pages
        };
    } catch (error) {
        console.error('Error processing text:', error);
        throw error;
    }
}

function createPaginatedPages(processedLines) {
    const pages = [];
    const pageHeight = window.innerHeight - 80;
    const pageWidth = window.innerWidth - 40;
    const pagesPerView = getPagesPerView(false);
    const availableWidth = Math.floor((pageWidth - PAGE_PADDING * 4) / pagesPerView);
    
    // Create a temporary div to measure content height
    const measureDiv = document.createElement('div');
    measureDiv.style.cssText = `
        position: absolute;
        visibility: hidden;
        width: ${availableWidth - PAGE_PADDING * 2}px;
        padding: ${PAGE_PADDING}px;
        box-sizing: border-box;
        font-family: monospace;
        font-size: 14px;
        line-height: 1.5;
    `;
    document.body.appendChild(measureDiv);
    
    function measureContentHeight(elements) {
        measureDiv.innerHTML = '';
        elements.forEach(el => measureDiv.appendChild(el.cloneNode(true)));
        return measureDiv.offsetHeight;
    }

    // Create page function
    function createNewPage(elements) {
        const pageWrapper = document.createElement('div');
        pageWrapper.className = 'pageWrapper';
        pageWrapper.setAttribute('role', 'document');
        pageWrapper.tabIndex = 0;
        pageWrapper.style.cssText = `
            width: ${availableWidth}px;
            height: 100%;
            min-height: ${pageHeight}px;
            background-color: var(--page-bg-color, white);
            color: var(--text-color, black);
            box-shadow: var(--page-shadow, 0 2px 6px rgba(0,0,0,0.1));
            border: 1px solid var(--border-color, #ddd);
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
        `;

        const pageContent = document.createElement('div');
        pageContent.style.cssText = `
            margin: 0;
            padding: ${PAGE_PADDING}px;
            width: 100%;
            flex: 1;
            box-sizing: border-box;
            font-size: 14px;
        `;

        elements.forEach(el => pageContent.appendChild(el.cloneNode(true)));
        pageWrapper.appendChild(pageContent);
        return pageWrapper;
    }

    let currentElements = [];
    const maxHeight = pageHeight - PAGE_PADDING * 2;

    for (const element of processedLines) {
        const potentialElements = [...currentElements, element];
        const height = measureContentHeight(potentialElements);

        if (height > maxHeight && currentElements.length > 0) {
            pages.push(createNewPage(currentElements));
            currentElements = [element];
        } else {
            currentElements = potentialElements;
        }
    }

    // Add any remaining content as the last page
    if (currentElements.length > 0) {
        pages.push(createNewPage(currentElements));
    }

    document.body.removeChild(measureDiv);
    return pages;
}