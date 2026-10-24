import { loadGuitarPro, GP_DISPLAY_SCALE, getGuitarTracks, getActiveInstrumentTracks, getGpNotationMode, setGpNotationMode, getGpStaveProfile, saveHiddenTracks } from './gpProcessor.js';
import { hideLoadingBar } from '../main.js';
import { getPagesPerView, switchToPageMode } from '../utils/viewModeUtils.js';
import { enableContinuousScrollTracking } from '../utils/scrollUtils.js';
import { createPageWrapper, createPageContainer, clearOutput, updatePageIndicator, updateScrollIndicator } from '../utils/renderUtils.js';
import { updateSongForYouTube } from '../youtubePlayer.js';
import { attachAlphaTabApi, detachAlphaTabApi, showScoreOptions, hideScoreOptions, reapplyJamTrackView } from './gpPlayer.js';
import {
    extractScoreTunings,
    extractScoreMetadata,
    applyScoreStringCount,
    getDefaultGpStringCount,
    setDefaultGpStringCount,
    getGpStringCountPreference,
    setGpStringCountPreference,
    getTabStringCountPreference,
    setTabStringCountPreference,
    getEffectiveGpStringCount,
    getScoreMaxStringsForMode,
    getInstrumentMode,
    formatTuningFromMidi,
    getTuningInfo
} from '../utils/tuningUtils.js';
import { addRecentOpened, updateLibrarySongFromScore } from '../libraryStore.js';
import {
    applyScoreAdaptation,
    getTabAdaptPref,
    setTabAdaptPref,
    getMyInstrument,
    setMyInstrument,
    getAdaptTuningOptions,
    findAdaptTuning
} from '../utils/tabAdapter.js';
import { fretboardController } from '../fretboard/fretboardController.js';
import { applyTabTrackColors, isTabTrackColorsEnabled, setTabTrackColorsEnabled, TRACK_PALETTE, getTrackColorIndexFor } from '../utils/trackColors.js';

const PAGE_PADDING = 6;

// State management
export const gpState = {
    currentPageIndex: 0,
    canvases: [],
    pages: [],
    lastLayoutDimensions: null, // Cache layout dimensions
    reset() {
        detachAlphaTabApi();
        hideScoreOptions();
        this.canvases.length = 0;
        this.pages.length = 0;
        this.currentPageIndex = 0;
        this.lastLayoutDimensions = null;
        const synthSection = document.getElementById('synthTrackVisibilitySection');
        const synthList = document.getElementById('synthTrackList');
        if (synthSection) synthSection.style.display = 'none';
        if (synthList) synthList.innerHTML = '';
        const stringCountSection = document.getElementById('scoreOptionsStringCountSection');
        if (stringCountSection) stringCountSection.style.display = 'none';
    }
};

/**
 * Load a Guitar Pro file into the app.
 */
export async function loadGP(file, output, pageModeRadio, continuousModeRadio, debug = false) {
    // Determine active mode (default to page mode if neither or page mode is selected)
    const isPageMode = pageModeRadio ? pageModeRadio.checked : true;

    // Reset state and clear output
    gpState.reset();
    gpState.currentFile = file;
    gpState.lastLayoutDimensions = null; // Force fresh layout calculation
    clearOutput(output);

    // Ensure output is visible for alphaTab sizing
    output.style.display = 'flex';
    output.style.overflowY = isPageMode ? 'hidden' : 'auto';

    // Load file
    let dataToLoad;
    if (file instanceof File) {
        dataToLoad = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    } else {
        dataToLoad = file;
    }

    // Init AlphaTab container with appropriate width for active mode
    const container = document.createElement('div');
    container.className = 'alphaTabContainer';

    const pagesPerView = getPagesPerView(true);
    // Page width = (viewport - container padding - gaps) / pages, minus wrapper border and horizontal padding
        const wrapperPadX = window.innerWidth < 768 ? 4 : 8;
        const targetWidth = Math.floor((window.innerWidth - 20 - 10 * (pagesPerView - 1)) / pagesPerView) - 2 - wrapperPadX * 2;

    container.style.width = isPageMode ? `${targetWidth}px` : '100%';
    container.style.height = isPageMode ? '100%' : 'auto';
    container.style.minHeight = '100%';
    container.style.flexShrink = '0';
    container.style.display = 'block';
    container.style.margin = '0 auto';
    output.appendChild(container);

    console.log('[GP Init] ========================================');
    console.log('[GP Init] Window width:', window.innerWidth);
    console.log('[GP Init] Pages per view:', pagesPerView);
    console.log('[GP Init] Initial mode:', isPageMode ? 'page' : 'continuous');
    console.log('[GP Init] Calculated container width:', isPageMode ? `${targetWidth}px` : '100%');
    console.log('[GP Init] ========================================');

    // Force a layout before creating AlphaTab API
    void container.offsetHeight;

    try {
        const api = await loadGuitarPro(dataToLoad, container, { debug, originalFile: file });
        gpState.canvases = [{ container, api }];
        window.gpApi = api;
        window.gpState = gpState;
        gpState.layoutGPPages = layoutGPPages;
        gpState.renderGPPage = renderGPPage;

        // Attach to synth player
        attachAlphaTabApi(api);

        // Show Score Options button
        showScoreOptions();

        // Populate track selection UI
        populateGpTrackSelectionUI(api);
        syncGpStringCountUI(api.score);
        syncGpAdaptUI(api.score);
        fretboardController.onScoreLoaded(api, api.tracks);
        reapplyJamTrackView();

        // Update YouTube player with parsed score metadata
        if (api.score) {
            updateSongForYouTube({
                filename: file.name,
                scoreTitle: api.score.title,
                scoreArtist: api.score.artist
            });

            const scoreMeta = extractScoreMetadata(api.score);
            const tunings = scoreMeta.tunings || [];
            const primaryTuning = scoreMeta.tuning || (tunings[0] || null);
            const stringCount = scoreMeta.stringCount || null;

            addRecentOpened({
                id: (file.librarySongId && file.tabId) 
                    ? `${file.librarySongId}_tab_${file.tabId}` 
                    : (file.name + (file.startPage ? `_p${file.startPage}_${file.endPage}` : '')),
                name: file.tabName || file.name,
                fileName: file.name,
                tabId: file.tabId || null,
                tabName: file.tabName || file.name,
                startPage: file.startPage || null,
                endPage: file.endPage || null,
                fileStoreId: file.fileStoreId || null,
                librarySongId: file.librarySongId || null,
                providerId: file.providerId || 'local',
                relativePath: file.relativePath || file.name,
                songTitle: file.librarySongTitle || file.songTitle || api.score.title || file.name.replace(/\.[^/.]+$/, ''),
                artist: file.artist || api.score.artist || '',
                album: file.album || api.score.album || '',
                coverUrl: file.coverUrl || null,
                tuning: primaryTuning,
                stringCount: stringCount,
                tunings
            }).catch(() => {});

            updateLibrarySongFromScore({
                fileName: file.name,
                title: api.score.title,
                artist: api.score.artist,
                album: api.score.album,
                primaryTuning,
                stringCount,
                tunings
            }).catch(() => {});
        }

        // Render directly in the active mode
        renderGPPage(output, isPageMode, continuousModeRadio);
    } catch (err) {
        console.error('Error loading Guitar Pro file:', err);
        hideLoadingBar();
    }
}

let gpRenderToken = 0;

/**
 * Re-render the loaded GP score at the current display scale without reloading
 * the file, so playback and page position are preserved.
 */
export function applyGpDisplayScale(output, pageModeChecked, continuousModeRadio) {
    const api = gpState.canvases[0]?.api;
    const container = gpState.canvases[0]?.container;
    if (!api || !container) return false;

    const oldIndex = gpState.currentPageIndex;
    const oldCount = gpState.pages.length;
    api.settings.display.scale = GP_DISPLAY_SCALE;
    api.updateSettings();

    if (!pageModeChecked) {
        api.render();
        return true;
    }

    // Park offscreen while re-rendering, as in renderGPPage
    const offscreenHolder = document.createElement('div');
    offscreenHolder.style.cssText = 'position:absolute;visibility:hidden;width:0;height:0;overflow:hidden;';
    document.body.appendChild(offscreenHolder);
    if (container.parentNode) container.parentNode.removeChild(container);
    offscreenHolder.appendChild(container);

    const renderToken = ++gpRenderToken;
    const unsub = api.postRenderFinished.on(() => {
        unsub();
        if (offscreenHolder.parentNode) document.body.removeChild(offscreenHolder);
        if (renderToken !== gpRenderToken) return;
        gpState.lastLayoutDimensions = null;
        // Estimate the equivalent position in the new pagination
        gpState.pages = [];
        renderGPPageMode(output);
        const newCount = gpState.pages.length;
        if (oldCount > 0 && newCount > 0) {
            const maxIndex = Math.max(0, newCount - getPagesPerView());
            const target = Math.min(maxIndex, Math.floor(oldIndex / oldCount * newCount));
            if (target !== gpState.currentPageIndex) {
                gpState.currentPageIndex = target;
                renderGPPageMode(output);
            }
        }
    });
    api.render();
    return true;
}

/**
 * Render GP pages based on view mode
 */
export function renderGPPage(output, pageModeChecked, continuousModeRadio) {
    if (!gpState.canvases[0]?.container) return;
    
    const renderToken = ++gpRenderToken;
    // Always clear output before rendering
    clearOutput(output);

    const container = gpState.canvases[0].container;
    const api = gpState.canvases[0].api;

    if (pageModeChecked) {
        output.classList.remove('continuous-mode');
        output.style.overflowY = 'hidden';
        output.style.overflowX = 'hidden';
        output.style.overflow = 'hidden';

        const pagesPerView = getPagesPerView(true);
        const targetWidth = Math.floor((window.innerWidth - 24) / pagesPerView) - (window.innerWidth < 768 ? 16 : 24);
        const targetWidthStr = `${targetWidth}px`;
        const widthChanged = container.style.width !== targetWidthStr;

        container.style.width = targetWidthStr;
        container.style.height = '100%';

        if (widthChanged && api) {
            // Park container offscreen while alphaTab re-renders at new target width
            const offscreenHolder = document.createElement('div');
            offscreenHolder.style.cssText = 'position:absolute;visibility:hidden;width:0;height:0;overflow:hidden;';
            document.body.appendChild(offscreenHolder);
            if (container.parentNode) container.parentNode.removeChild(container);
            offscreenHolder.appendChild(container);

            const unsub = api.postRenderFinished.on(() => {
                unsub();
                if (offscreenHolder.parentNode) document.body.removeChild(offscreenHolder);
                if (renderToken !== gpRenderToken) return; // superseded by a newer render
                gpState.lastLayoutDimensions = null; // force fresh layout calculation
                renderGPPageMode(output);
            });
            api.render();
            return;
        }

        // renderGPPageMode will handle layout calculation with caching
        renderGPPageMode(output);
    } else {
        // Make sure the container is detached before reattaching
        if (container.parentNode) {
            container.parentNode.removeChild(container);
        }
        container.style.transform = '';
        container.style.transformOrigin = '';
        const wasNotFullWidth = container.style.width !== '100%';
        container.style.width = '100%';
        container.style.height = 'auto';
        container.style.minHeight = '100%';
        container.style.flexShrink = '0';
        
        // Set up continuous mode view
        output.classList.add('continuous-mode');
        output.style.overflowY = 'auto';  // Explicitly enable vertical scrolling
        output.style.overflowX = 'hidden'; // Prevent horizontal scrolling
        output.appendChild(container);
        output.scrollTop = 0;

        // Keep the top bar percentage in sync with scrolling (scroll or playback follow)
        enableContinuousScrollTracking(output, [container], () => {});
        updateScrollIndicator(document.getElementById('pageIndicator'), output, 1);

        if (wasNotFullWidth && api) {
            api.render();
        }
    }
}

/**
 * Layout GP pages based on block heights
 * @param {HTMLElement} container - The alphaTab container
 * @param {number} pageHeight - Available height for each page
 * @param {number} pageWidth - Available width for each page (optional, defaults to container width)
 */
export function layoutGPPages(container, pageHeight, pageWidth = null) {
    // Get all score parts (includes both the div container and its SVG content)
    const blocks = Array.from(container.querySelectorAll("div.at-surface.at > div"));
    const offscreen = document.createElement('div');
    offscreen.style.position = 'absolute';
    offscreen.style.visibility = 'hidden';
    offscreen.style.width = `${pageWidth || container.clientWidth}px`;
    offscreen.style.height = `${pageHeight}px`;
    offscreen.style.overflow = 'hidden'; // Prevent any overflow issues during measurement
    document.body.appendChild(offscreen);

    // Account for padding and gaps between blocks
    const effectivePageHeight = pageHeight - (PAGE_PADDING * 2);
    
    const pages = [];
    let currentPage = [];
    let currentHeight = 0;

    blocks.forEach((block, blockIndex) => {
        // Deep clone the block and all its content (including SVGs)
        const clone = block.cloneNode(true);
        clone.dataset.blockIndex = blockIndex.toString();
        
        // Reset positioning to get accurate measurements
        clone.style.position = 'relative';
        clone.style.top = 'auto';
        clone.style.left = 'auto';
        clone.style.maxWidth = '100%';
        clone.style.display = 'block';
        
        // Ensure SVGs are properly carried over
        const originalSvg = block.querySelector('svg');
        const clonedSvg = clone.querySelector('svg');
        if (originalSvg && clonedSvg) {
            // Copy any dynamic properties that might not be cloned
            const vb = originalSvg.getAttribute('viewBox');
            if (vb && vb !== 'null') clonedSvg.setAttribute('viewBox', vb);
            clonedSvg.style.width = '100%';
            clonedSvg.style.height = 'auto';
            clonedSvg.style.display = 'block';
        }

        offscreen.appendChild(clone);
        
        // Force a reflow and ensure proper measurement
        void offscreen.offsetHeight;
        const blockHeight = clone.getBoundingClientRect().height;
        const blockWithSpacing = blockHeight + PAGE_PADDING;

        // Start a new page if current block won't fit
        if (currentHeight + blockWithSpacing > effectivePageHeight && currentPage.length) {
            pages.push(currentPage);
            currentPage = [];
            currentHeight = 0;
        }

        currentPage.push(clone);
        currentHeight += blockWithSpacing;
    });

    if (currentPage.length) {
        pages.push(currentPage);
    }

    document.body.removeChild(offscreen);
    return pages;
}

/**
 * Render in page mode
 */
function renderGPPageMode(output) {
    clearOutput(output);
    const pagesPerView = getPagesPerView(true); // true = Guitar Pro mode

    // Measure fretboard dock height if visible so pages and stave blocks fit above it
    const fretboardDock = document.getElementById('fretboardDock');
    const isFretboardOpen = document.body.classList.contains('fretboard-open') && fretboardDock && fretboardDock.style.display !== 'none';
    const fretboardHeight = isFretboardOpen ? (fretboardDock.offsetHeight || 165) : 0;

    // Only recalculate if dimensions changed
    const pageHeight = Math.max(120, output.clientHeight - fretboardHeight - 20);
    const pageWidth = (window.innerWidth - 20) / pagesPerView;
    const currentDimensions = { pageHeight, pageWidth, pagesPerView, isFretboardOpen, fretboardHeight };

    console.log('[GP Layout Debug] Calculating dimensions:', {
        windowWidth: window.innerWidth,
        pagesPerView,
        calculatedPageWidth: pageWidth,
        outputHeight: output.clientHeight,
        fretboardHeight,
        calculatedPageHeight: pageHeight
    });

    // Check if we need to recalculate layout
    const needsRecalc = !gpState.lastLayoutDimensions ||
        gpState.lastLayoutDimensions.pageHeight !== pageHeight ||
        gpState.lastLayoutDimensions.pageWidth !== pageWidth ||
        gpState.lastLayoutDimensions.pagesPerView !== pagesPerView ||
        gpState.lastLayoutDimensions.isFretboardOpen !== isFretboardOpen;

    if (needsRecalc) {
        // Park the container in an offscreen element so AlphaTab's resize observer
        // doesn't see a detached/invisible container and produce null-dimensioned SVGs.
        const offscreenHolder = document.createElement('div');
        offscreenHolder.style.cssText = 'position:absolute;visibility:hidden;width:0;height:0;overflow:hidden;';
        document.body.appendChild(offscreenHolder);
        const container = gpState.canvases[0].container;
        if (container.parentNode) container.parentNode.removeChild(container);
        offscreenHolder.appendChild(container);

        gpState.pages = layoutGPPages(container, pageHeight, pageWidth);
        gpState.lastLayoutDimensions = currentDimensions;

        offscreenHolder.removeChild(container);
        document.body.removeChild(offscreenHolder);
    }

    const containerWrapper = createPageContainer();
    containerWrapper.className = 'gp-page-container';

    for (let i = 0; i < pagesPerView; i++) {
        const pageIndex = gpState.currentPageIndex + i;
        const pageSet = gpState.pages[pageIndex];
        if (!pageSet) break;

        const wrapper = createPageWrapper();
        wrapper.className = 'gp-page-wrapper alphaTab at';
        wrapper.style.width = `${(100 / pagesPerView)}%`;
        wrapper.style.padding = window.innerWidth < 768 ? '5px 4px' : '5px 8px';
        wrapper.style.boxSizing = 'border-box';
        wrapper.style.overflow = 'hidden';

        const contentContainer = document.createElement('div');
        contentContainer.className = 'alphaTab-gp-content alphaTab at';
        contentContainer.style.width = '100%';
        contentContainer.style.display = 'flex';
        contentContainer.style.flexDirection = 'column';
        contentContainer.style.alignItems = 'center';

        pageSet.forEach((div, idx) => {
            const clone = div.cloneNode(true);
            clone.dataset.blockIndex = div.dataset.blockIndex ?? idx.toString();

            // Reset positioning
            clone.style.position = 'relative';
            clone.style.top = 'auto';
            clone.style.left = 'auto';
            clone.style.display = 'block';
            clone.style.marginBottom = `${PAGE_PADDING}px`;
            clone.style.maxWidth = '100%';
            clone.style.overflow = 'visible';

            // SMuFL music glyphs use % font-sizes that resolve against inherited CSS font-size.
            // Boost it so glyphs appear at a larger visual size in page mode.
            clone.style.fontSize = `${(16 / GP_DISPLAY_SCALE * 1.5).toFixed(4)}px`;

            // Keep SVG at its rendered size, don't scale up
            const svg = clone.querySelector('svg');
            if (svg) {
                // Set viewBox if it doesn't exist - crucial for proper scaling
                const viewBox = svg.getAttribute('viewBox');
                if ((!viewBox || viewBox === 'null') && svg.width.baseVal.value > 0) {
                    const originalWidth = svg.width.baseVal.value;
                    const originalHeight = svg.height.baseVal.value;
                    svg.setAttribute('viewBox', `0 0 ${originalWidth} ${originalHeight}`);
                }

                // Keep the rendered size, don't scale up
                const renderedWidth = svg.width.baseVal.value;
                svg.style.width = `${renderedWidth}px`;
                svg.style.height = 'auto';
                svg.style.maxWidth = '100%'; // Can scale down if needed
                svg.style.display = 'block';
            }

            contentContainer.appendChild(clone);
        });

        wrapper.appendChild(contentContainer);

        const pnum = document.createElement('div');
        pnum.className = 'pageNumber';
        pnum.textContent = `${pageIndex + 1}/${gpState.pages.length}`;
        wrapper.appendChild(pnum);

        containerWrapper.appendChild(wrapper);
    }
        output.appendChild(containerWrapper);
    updatePageIndicator(
        document.getElementById('pageIndicator'), 
        gpState.currentPageIndex,
        gpState.pages.length,
        pagesPerView
    );
}

/**
 * Navigation functions
 */
/**
 * Navigate to next GP page and re-render
 * @param {HTMLElement} output - The output container element
 * @returns {boolean} Whether navigation was successful
 */
export function nextGPPage(output, step = null) {
    if (!gpState.pages.length) return false;
    const pagesPerView = getPagesPerView(true);
    let advanceStep = step;
    if (advanceStep === null) {
        const selected = document.querySelector('input[name="pageAdvanceRadio"]:checked');
        const advancePages = selected ? parseInt(selected.value, 10) : 2;
        advanceStep = advancePages === 1 ? 1 : pagesPerView;
    }
    const newIndex = Math.min(gpState.currentPageIndex + advanceStep, Math.max(0, gpState.pages.length - pagesPerView));
    if (newIndex !== gpState.currentPageIndex) {
        gpState.currentPageIndex = newIndex;
        if (output) {
            renderGPPageMode(output);
        }
        return true;
    }
    return false;
}

/**
 * Navigate to previous GP page and re-render
 * @param {HTMLElement} output - The output container element
 * @param {number|null} step - Optional page step count
 * @returns {boolean} Whether navigation was successful
 */
export function prevGPPage(output, step = null) {
    if (!gpState.pages.length) return false;
    let advanceStep = step;
    if (advanceStep === null) {
        const selected = document.querySelector('input[name="pageAdvanceRadio"]:checked');
        const advancePages = selected ? parseInt(selected.value, 10) : 2;
        advanceStep = advancePages === 1 ? 1 : getPagesPerView(true);
    }
    const newIndex = Math.max(0, gpState.currentPageIndex - advanceStep);
    if (newIndex !== gpState.currentPageIndex) {
        gpState.currentPageIndex = newIndex;
        if (output) {
            renderGPPageMode(output);
        }
        return true;
    }
    return false;
}

/**
 * Apply selected tracks to AlphaTab renderer and re-paginate in Page Mode
 */
export function applyGpTrackSelection(visibleTrackIndices) {
    const api = gpState.canvases[0]?.api;
    const container = gpState.canvases[0]?.container;
    const output = document.getElementById('output');
    if (!api || !container || !api.score?.tracks || !visibleTrackIndices?.length) return;

    const tracksToRender = api.score.tracks.filter(t => visibleTrackIndices.includes(t.index));
    if (!tracksToRender.length) return;

    const pageModeRadio = document.getElementById('pageModeRadio');
    const isPageMode = pageModeRadio ? pageModeRadio.checked : true;

    applyTabTrackColors(api.score, tracksToRender.map(t => t.index));

    if (!isPageMode) {
        api.renderTracks(tracksToRender);
        updateTrackSelectionUI(visibleTrackIndices);
        fretboardController.onTrackSelectionChanged(tracksToRender);
        return;
    }

    // In Page mode: park container offscreen while AlphaTab re-renders with new tracks
    const offscreenHolder = document.createElement('div');
    offscreenHolder.style.cssText = 'position:absolute;visibility:hidden;width:0;height:0;overflow:hidden;';
    document.body.appendChild(offscreenHolder);
    if (container.parentNode) container.parentNode.removeChild(container);
    offscreenHolder.appendChild(container);

    const renderToken = ++gpRenderToken;
    const unsub = api.postRenderFinished.on(() => {
        unsub();
        if (offscreenHolder.parentNode) document.body.removeChild(offscreenHolder);
        if (renderToken !== gpRenderToken) return;
        gpState.lastLayoutDimensions = null;
        gpState.pages = [];
        gpState.currentPageIndex = Math.min(gpState.currentPageIndex, Math.max(0, gpState.pages.length - 1));
        renderGPPageMode(output);
        updateTrackSelectionUI(visibleTrackIndices);
        fretboardController.onTrackSelectionChanged(tracksToRender);
    });

    api.renderTracks(tracksToRender);
}

/**
 * Update checkboxes and buttons in track selection UI
 */
export function updateTrackSelectionUI(visibleIndices) {
    const synthList = document.getElementById('synthTrackList');
    if (!synthList) return;
    const isSingleVisible = visibleIndices.length === 1;

    synthList.querySelectorAll('.gp-track-checkbox').forEach(cb => {
        const idx = parseInt(cb.dataset.trackIndex, 10);
        const isChecked = visibleIndices.includes(idx);
        cb.checked = isChecked;
        cb.disabled = isChecked && isSingleVisible;

        const dot = cb.closest('.gp-track-row')?.querySelector('.gp-track-dot');
        if (dot) {
            const position = visibleIndices.indexOf(idx);
            dot.style.setProperty('--track-color', position >= 0 ? TRACK_PALETTE[getTrackColorIndexFor(idx)] : 'transparent');
            dot.classList.toggle('is-hidden-track', position < 0);
        }
    });
}

/**
 * Populate track selection list in synth panel
 */
export function populateGpTrackSelectionUI(api) {
    const synthSection = document.getElementById('synthTrackVisibilitySection');
    const synthList = document.getElementById('synthTrackList');
    const synthShowAllBtn = document.getElementById('synthShowAllTracksBtn');

    if (!synthList || !api?.score?.tracks) return;

    const activeTracks = getActiveInstrumentTracks(api.score);
    if (activeTracks.length <= 1) {
        if (synthSection) synthSection.style.display = 'none';
        synthList.innerHTML = '';
        return;
    }

    if (synthSection) synthSection.style.display = 'block';

    const getTrackTuningLabel = (track) => {
        const raw = (track.staves || []).find(st => !st.isPercussion && st.stringTuning?.tunings?.length)?.stringTuning.tunings
            || (Array.isArray(track.tuning) && track.tuning.length ? track.tuning : null);
        const formatted = raw ? formatTuningFromMidi(raw) : null;
        const label = formatted ? (getTuningInfo(formatted)?.displayName || formatted) : '';
        return label.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    };

    const renderTrackRow = (ti) => {
        const id = `synth_track_${ti.index}`;
        const tuningLabel = getTrackTuningLabel(ti.track);
        return `
          <div class="gp-track-row d-flex align-items-center justify-content-between">
            <div class="form-check form-switch mb-0 d-flex align-items-center gap-2">
              <input class="form-check-input theme-switch gp-track-checkbox" type="checkbox" id="${id}" data-track-index="${ti.index}" checked>
              <span class="track-chip-dot gp-track-dot" title="Fretboard color"></span>
              <label class="form-check-label small text-truncate" for="${id}" style="max-width: 170px;" title="${ti.track.name || `Track ${ti.index + 1}`}">${ti.track.name || `Track ${ti.index + 1}`}</label>
              ${tuningLabel ? `<span class="badge badge-theme-secondary gp-track-tuning flex-shrink-0" title="Tuning">${tuningLabel}</span>` : ''}
            </div>
            <button type="button" class="btn btn-sm theme-control-btn gp-track-only-btn" data-track-index="${ti.index}" title="Show only this track">Only</button>
          </div>
        `;
    };

    synthList.innerHTML = activeTracks.map(ti => renderTrackRow(ti)).join('');

    const handleToggle = (trackIndex, isChecked) => {
        const currentRendered = (api.tracks || []).map(t => t.index);
        let newIndices;
        if (isChecked) {
            newIndices = [...new Set([...currentRendered, trackIndex])];
        } else {
            newIndices = currentRendered.filter(idx => idx !== trackIndex);
            if (newIndices.length === 0) {
                // Keep at least one track visible
                updateTrackSelectionUI(currentRendered);
                return;
            }
        }
        applyGpTrackSelection(newIndices);
        const allIndices = activeTracks.map(ti => ti.index);
        const hiddenIndices = allIndices.filter(idx => !newIndices.includes(idx));
        saveHiddenTracks(gpState.currentFile, hiddenIndices, activeTracks);
    };

    const handleOnly = (trackIndex) => {
        applyGpTrackSelection([trackIndex]);
        const allIndices = activeTracks.map(ti => ti.index);
        const hiddenIndices = allIndices.filter(idx => idx !== trackIndex);
        saveHiddenTracks(gpState.currentFile, hiddenIndices, activeTracks);
    };

    const handleShowAll = () => {
        const allIndices = activeTracks.map(ti => ti.index);
        applyGpTrackSelection(allIndices);
        saveHiddenTracks(gpState.currentFile, [], activeTracks);
    };

    // Attach listeners
    synthList.querySelectorAll('.gp-track-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.trackIndex, 10);
            handleToggle(idx, e.target.checked);
        });
    });
    synthList.querySelectorAll('.gp-track-only-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.currentTarget.dataset.trackIndex, 10);
            handleOnly(idx);
        });
    });

    if (synthShowAllBtn) synthShowAllBtn.onclick = handleShowAll;

    const colorSwitch = document.getElementById('tabTrackColorSwitch');
    if (colorSwitch) {
        colorSwitch.checked = isTabTrackColorsEnabled();
        colorSwitch.onchange = () => {
            setTabTrackColorsEnabled(colorSwitch.checked);
            applyGpTrackSelection((api.tracks || []).map(t => t.index));
        };
    }

    const currentRendered = (api.tracks || []).map(t => t.index);
    updateTrackSelectionUI(currentRendered);
}

/**
 * Switch Guitar Pro notation mode (Tab Only vs Tab + Standard)
 */
export function applyGpNotationMode(mode) {
    const safeMode = setGpNotationMode(mode);
    const api = gpState.canvases[0]?.api;
    const container = gpState.canvases[0]?.container;
    const output = document.getElementById('output');

    // Sync radio controls
    syncGpNotationRadios(safeMode);

    if (!api || !container) return;

    if (api.score && Array.isArray(api.score.tracks)) {
        for (const track of api.score.tracks) {
            if (Array.isArray(track.staves)) {
                for (const staff of track.staves) {
                    staff.showStandardNotation = true;
                    staff.showTablature = true;
                }
            }
        }
    }

    api.settings.display.staveProfile = getGpStaveProfile(safeMode);
    api.updateSettings();

    const pageModeRadio = document.getElementById('pageModeRadio');
    const isPageMode = pageModeRadio ? pageModeRadio.checked : true;

    if (!isPageMode) {
        api.render();
        return;
    }

    // In Page mode: park container offscreen while AlphaTab re-renders
    const offscreenHolder = document.createElement('div');
    offscreenHolder.style.cssText = 'position:absolute;visibility:hidden;width:0;height:0;overflow:hidden;';
    document.body.appendChild(offscreenHolder);
    if (container.parentNode) container.parentNode.removeChild(container);
    offscreenHolder.appendChild(container);

    const renderToken = ++gpRenderToken;
    const unsub = api.postRenderFinished.on(() => {
        unsub();
        if (offscreenHolder.parentNode) document.body.removeChild(offscreenHolder);
        if (renderToken !== gpRenderToken) return;
        gpState.lastLayoutDimensions = null;
        gpState.pages = [];
        gpState.currentPageIndex = Math.min(gpState.currentPageIndex, Math.max(0, gpState.pages.length - 1));
        renderGPPageMode(output);
    });

    api.render();
}

/**
 * Synchronize all Guitar Pro notation radio buttons
 */
export function syncGpNotationRadios(mode = getGpNotationMode()) {
    const notationRadios = document.querySelectorAll('input[name="gpNotationRadio"], input[name="synthNotationRadio"]');
    notationRadios.forEach(radio => {
        radio.checked = radio.value === mode;
    });
}

/**
 * Switch Guitar Pro tab string count view (native, 7, 8 for guitar; native, 5, 6 for bass).
 * Persists the selection specifically for this tab.
 */
export function applyGpStringCount(targetCount) {
    const instrumentMode = getInstrumentMode();
    const safeCount = (targetCount === '7' || targetCount === '8' || targetCount === '5' || targetCount === '6') ? targetCount : 'native';

    if (gpState.currentFile) {
        setTabStringCountPreference(gpState.currentFile, safeCount, instrumentMode);
    }

    const api = gpState.canvases[0]?.api;
    const container = gpState.canvases[0]?.container;
    const output = document.getElementById('output');

    // Sync notation menu radio controls and badge (does not touch settings menu defaults)
    syncGpNotationStringCountRadios(safeCount);
    if (api?.score) {
        updateGpStringCountBadge(api.score);
        applyScoreStringCount(api.score, safeCount, instrumentMode);
        applyTabTrackColors(api.score, (api.tracks || []).map(t => t.index));
        fretboardController.onTrackSelectionChanged(api.tracks || (api.score.tracks ? [api.score.tracks[0]] : []));
    }

    if (!api || !container) return;

    const pageModeRadio = document.getElementById('pageModeRadio');
    const isPageMode = pageModeRadio ? pageModeRadio.checked : true;

    if (!isPageMode) {
        api.render();
        return;
    }

    // In Page mode: park container offscreen while AlphaTab re-renders
    const offscreenHolder = document.createElement('div');
    offscreenHolder.style.cssText = 'position:absolute;visibility:hidden;width:0;height:0;overflow:hidden;';
    document.body.appendChild(offscreenHolder);
    if (container.parentNode) container.parentNode.removeChild(container);
    offscreenHolder.appendChild(container);

    const renderToken = ++gpRenderToken;
    const unsub = api.postRenderFinished.on(() => {
        unsub();
        if (offscreenHolder.parentNode) document.body.removeChild(offscreenHolder);
        if (renderToken !== gpRenderToken) return;
        gpState.lastLayoutDimensions = null;
        gpState.pages = [];
        gpState.currentPageIndex = Math.min(gpState.currentPageIndex, Math.max(0, gpState.pages.length - 1));
        renderGPPageMode(output);
    });

    api.render();
}

/**
 * Updates the string count badge in the Score Options panel
 */
export function updateGpStringCountBadge(score) {
    const badge = document.getElementById('scoreCurrentStringsBadge');
    if (!badge || !score) return;
    const nativeMax = getScoreMaxStringsForMode(score);
    badge.textContent = `${nativeMax}-String`;
}

/**
 * Synchronize the notation menu's string count radio buttons for the active tab
 */
export function syncGpNotationStringCountRadios(count = getEffectiveGpStringCount(gpState.currentFile)) {
    const radios = document.querySelectorAll('input[name="synthStringCountRadio"]');
    radios.forEach(radio => {
        if (radio.value === String(count)) {
            radio.checked = true;
        }
    });
}

export const syncGpStringCountRadios = syncGpNotationStringCountRadios;

/**
 * Dynamically builds and updates the string count options in the Score Options panel
 */
export function syncGpStringCountUI(score) {
    const section = document.getElementById('scoreOptionsStringCountSection');
    const pillsContainer = document.getElementById('scoreOptionsStringCountPills');
    if (!section || !pillsContainer) return;

    if (!score) {
        section.style.display = 'none';
        return;
    }

    const instrumentMode = getInstrumentMode();
    const isBass = instrumentMode === 'bass';

    updateGpStringCountBadge(score);

    const options = isBass
        ? [
            { id: 'synthStringCountNative', value: 'native', label: 'Original' },
            { id: 'synthStringCount5', value: '5', label: '5-String' },
            { id: 'synthStringCount6', value: '6', label: '6-String' }
        ]
        : [
            { id: 'synthStringCountNative', value: 'native', label: 'Original' },
            { id: 'synthStringCount7', value: '7', label: '7-String' },
            { id: 'synthStringCount8', value: '8', label: '8-String' }
        ];

    const currentCount = getEffectiveGpStringCount(gpState.currentFile, instrumentMode);

    pillsContainer.innerHTML = options.map(opt => `
        <input type="radio" class="btn-check" name="synthStringCountRadio" id="${opt.id}" value="${opt.value}" autocomplete="off" ${opt.value === currentCount ? 'checked' : ''}>
        <label class="btn btn-sm" for="${opt.id}" style="flex: 1;">${opt.label}</label>
    `).join('');

    pillsContainer.querySelectorAll('input[name="synthStringCountRadio"]').forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.checked) {
                applyGpStringCount(radio.value);
            }
        });
    });

    section.style.display = '';
}


/**
 * Opts the open tab in or out of instrument adaptation (or changes its tuning/method) and re-renders.
 * Pass null to restore the tab as written.
 */
export function applyGpTabAdaptation(pref) {
    const api = gpState.canvases[0]?.api;
    const score = api?.score;
    if (!score) return;
    const instrumentMode = getInstrumentMode();

    setTabAdaptPref(gpState.currentFile, pref);
    if (pref?.enabled) {
        setMyInstrument(pref);
    }

    // String-count padding sits on top of the adapted layout, so undo it first and re-apply after
    applyScoreStringCount(score, 'native', instrumentMode);
    for (const track of score.tracks || []) {
        for (const staff of track.staves || []) {
            delete staff._originalTunings;
            delete staff._originalTuningName;
            for (const bar of staff.bars || []) {
                for (const voice of bar.voices || []) {
                    for (const beat of voice.beats || []) {
                        for (const note of beat.notes || []) delete note._origString;
                    }
                }
            }
        }
    }

    score._adaptSummary = applyScoreAdaptation(score, pref, instrumentMode);
    syncGpAdaptUI(score);
    applyGpStringCount(getEffectiveGpStringCount(gpState.currentFile, instrumentMode));
    // Transposing retunes the strings, so the synth needs its MIDI rebuilt to follow the new pitch
    if (typeof api.loadMidiForScore === 'function') api.loadMidiForScore();
}

function describeAdaptation(summary, pref) {
    if (!summary) return '';
    const tuning = findAdaptTuning(pref.tuningName);
    const fromName = formatTuningFromMidi(summary.from);
    const parts = [];
    if (fromName) parts.push(`Adapted from ${fromName}`);
    if (pref.method === 'transpose') {
        const toName = tuning?.shortName || 'your tuning';
        return fromName ? `Transposed from ${fromName} to ${toName} · frets unchanged, pitch changes` : `Transposed to ${toName} · frets unchanged, pitch changes`;
    }
    parts.push(pref.method === 'capo' ? `Capo ${summary.capo}` : 'Frets shifted to ' + (tuning?.shortName || 'your tuning'));
    if (summary.remapped) parts.push(`${summary.remapped} note${summary.remapped === 1 ? '' : 's'} moved to another string`);
    if (summary.unplayable) parts.push(`${summary.unplayable} out of range${tuning ? ' (try a lower tuning)' : ''}`);
    if (summary.harmonics) parts.push('harmonics keep their fret position');
    return parts.join(' · ');
}

/**
 * Builds the "Adapt to My Tuning" section of the Notation panel for the open tab
 */
export function syncGpAdaptUI(score) {
    const section = document.getElementById('scoreOptionsAdaptSection');
    if (!section) return;
    if (!score) {
        section.style.display = 'none';
        return;
    }

    const instrumentMode = getInstrumentMode();
    const pref = getTabAdaptPref(gpState.currentFile);
    const mine = pref || getMyInstrument();
    const enabled = !!pref;

    const toggle = document.getElementById('adaptEnableSwitch');
    const controls = document.getElementById('adaptControls');
    const select = document.getElementById('adaptTuningSelect');
    const capoSelect = document.getElementById('adaptCapoSelect');
    const summaryEl = document.getElementById('adaptSummary');
    const badge = document.getElementById('adaptStateBadge');

    toggle.checked = enabled;
    controls.style.display = enabled ? '' : 'none';
    badge.style.display = enabled ? '' : 'none';
    select.innerHTML = getAdaptTuningOptions(instrumentMode)
        .map(t => `<option value="${t.shortName}" ${t.shortName === mine.tuningName ? 'selected' : ''}>${t.name}</option>`)
        .join('');
    capoSelect.innerHTML = ['auto', ...Array.from({ length: 9 }, (_, i) => String(i + 1))]
        .map(v => `<option value="${v}" ${String(mine.capo ?? 'auto') === v ? 'selected' : ''}>${v === 'auto' ? 'Auto' : 'Fret ' + v}</option>`)
        .join('');
    document.querySelectorAll('input[name="adaptMethodRadio"]').forEach(r => { r.checked = r.value === mine.method; });
    document.getElementById('adaptCapoRow').style.display = mine.method === 'capo' ? 'flex' : 'none';
    summaryEl.textContent = enabled ? describeAdaptation(score._adaptSummary, mine) : '';
    section.style.display = '';

    const read = () => {
        const capoVal = capoSelect.value;
        return {
            enabled: toggle.checked,
            tuningName: select.value,
            method: document.querySelector('input[name="adaptMethodRadio"]:checked')?.value || 'shift',
            capo: capoVal === 'auto' ? 'auto' : parseInt(capoVal, 10)
        };
    };
    toggle.onchange = () => applyGpTabAdaptation(toggle.checked ? read() : null);
    select.onchange = () => applyGpTabAdaptation(read());
    capoSelect.onchange = () => applyGpTabAdaptation(read());
    document.querySelectorAll('input[name="adaptMethodRadio"]').forEach(r => {
        r.onchange = () => { if (r.checked) applyGpTabAdaptation(read()); };
    });
}
