// main.js
import { processPDF } from './pdfProcessor/pdfProcessor.js';
import { fetchPickedFile, setupDrivePicker } from './googleDrive.js';
import { setupExportPDFButton } from './exportPdf.js';
import { loadGP, renderGPPage, gpState, nextGPPage, prevGPPage, layoutGPPages } from './gpProcessor/gpHandler.js';
import { loadText, renderTextPage, textState, nextTextPage, prevTextPage } from './textProcessor/textHandler.js';
import { isFileType, showProgress, hideProgress } from './utils/fileHandlingUtils.js';
import { setupFirstPageNavigation, setupPrevNextNavigation, setupKeyboardNavigation, setupViewModeToggles, setupTapClickNavigation } from './utils/navigationUtils.js';
import { getPagesPerView } from './utils/viewModeUtils.js';
import { clearOutput, updatePageIndicator, layoutPages, renderPage } from './utils/renderUtils.js';
import { enableContinuousScrollTracking } from './utils/scrollUtils.js';
import { initYouTubePlayer, updateSongForYouTube } from './youtubePlayer.js';
import { initSynthPlayer, hideSynthPlayer } from './gpProcessor/gpPlayer.js';
import { initTheming } from './themeEngine.js';

// Handle window resizing 
let resizeTimeout;
window.addEventListener('resize', () => {
    // Debounce resize handling
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        const pageModeRadio = document.getElementById('pageModeRadio');
        const continuousModeRadio = document.getElementById('continuousModeRadio');
        const output = document.getElementById('output');
        
        // Only re-render if we have a file loaded
        if (currentFile && pageModeRadio && output) {
            if (gpState.canvases[0]?.container && pageModeRadio.checked) {
                // For GP files in page mode, recalculate pages based on new dimensions
                const pageHeight = output.clientHeight - 20;
                gpState.pages = layoutGPPages(gpState.canvases[0].container, pageHeight);
            }
            // Re-render after layout recalculation
            renderGPPage(output, pageModeRadio.checked, continuousModeRadio);
        }
    }, 250); // Wait for resize to finish
});

// Handle desktop zooming with Ctrl+Wheel
const mainContent = document.getElementById('mainContent');
const topBar = document.getElementById('topBar');
let currentScale = 1;
const MIN_SCALE = 1.0; // Changed to 1.0 to prevent zooming out beyond initial scale
const MAX_SCALE = 3;

mainContent.addEventListener('wheel', (e) => {
    // Only handle zoom if Ctrl key is pressed
    if (!e.ctrlKey) return;
    
    e.preventDefault();
    
    // Calculate new scale, but prevent zooming out below 1.0
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, currentScale + delta));
    
    if (newScale !== currentScale) {
        // Calculate position relative to the container
        const rect = output.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        // Calculate the scroll offset to keep the mouse position fixed
        const scaleChange = newScale / currentScale;
        const newX = x * scaleChange - x;
        const newY = y * scaleChange - y;
        
        // Apply the transform
        output.style.transform = `scale(${newScale})`;
        output.style.transformOrigin = '0 0';
        
        // Adjust scroll position to maintain mouse point
        mainContent.scrollLeft += newX;
        mainContent.scrollTop += newY;
        
        currentScale = newScale;
    }
});

// Elements
const fileInput = document.getElementById('localFile');
const debugMode = document.getElementById('debugMode');
const condensePdfMode = document.getElementById('condensePdfMode');
const firstBtn = document.getElementById('firstPage');
const prevBtn = document.getElementById('prevPage');
const nextBtn = document.getElementById('nextPage');
const pageIndicator = document.getElementById('pageIndicator');
const navButtons = document.getElementById('navButtons');
const modeButtons = document.getElementById('modeButtons');
const pageModeRadio = document.getElementById('pageModeRadio');
const continuousModeRadio = document.getElementById('continuousModeRadio');
const fileMenuEl = document.getElementById('fileMenu');
const fileMenu = new bootstrap.Offcanvas(fileMenuEl);
const output = document.getElementById('output');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');

// State
let currentFile = null;
let currentProcessing = { aborted: false };
let condensedCanvases = [];
let pages = [];
let currentPageIndex = 0;
let continuous = false;

// --- SETTINGS MANAGEMENT ---
function setupSettings() {
    // Load settings from localStorage
    const savedDebugMode = localStorage.getItem('debugMode') === 'true';
    
    // Load condense mode settings with different defaults
    const savedCondensePdfMode = localStorage.getItem('condensePdfMode');

    // Apply saved settings
    debugMode.checked = savedDebugMode;
    // Default: Condense PDFs off by default (false)
    condensePdfMode.checked = savedCondensePdfMode === null ? false : savedCondensePdfMode === 'true';
    
    // Initialize modern guitar finish theming engine
    initTheming();

    // Setup dual-page advance selector
    let savedPageAdvance = localStorage.getItem('pageAdvancePages');
    if (!savedPageAdvance) {
        const legacyAdvanceOne = localStorage.getItem('advanceOnePage');
        if (legacyAdvanceOne !== null) {
            savedPageAdvance = legacyAdvanceOne === 'true' ? '1' : '2';
            localStorage.setItem('pageAdvancePages', savedPageAdvance);
            localStorage.removeItem('advanceOnePage');
        } else {
            savedPageAdvance = '2';
        }
    }

    const pageAdvanceRadios = document.querySelectorAll('input[name="pageAdvanceRadio"]');
    pageAdvanceRadios.forEach(radio => {
        if (radio.value === savedPageAdvance) {
            radio.checked = true;
        }
        radio.addEventListener('change', () => {
            if (radio.checked) {
                localStorage.setItem('pageAdvancePages', radio.value);
            }
        });
    });

    // Setup Default View selectors for GP and PDF
    let savedGpDefaultView = localStorage.getItem('gpDefaultView') || 'continuous';
    const gpDefaultRadios = document.querySelectorAll('input[name="gpDefaultViewRadio"]');
    gpDefaultRadios.forEach(radio => {
        if (radio.value === savedGpDefaultView) {
            radio.checked = true;
        }
        radio.addEventListener('change', () => {
            if (radio.checked) {
                localStorage.setItem('gpDefaultView', radio.value);
            }
        });
    });

    let savedPdfDefaultView = localStorage.getItem('pdfDefaultView') || 'page';
    const pdfDefaultRadios = document.querySelectorAll('input[name="pdfDefaultViewRadio"]');
    pdfDefaultRadios.forEach(radio => {
        if (radio.value === savedPdfDefaultView) {
            radio.checked = true;
        }
        radio.addEventListener('change', () => {
            if (radio.checked) {
                localStorage.setItem('pdfDefaultView', radio.value);
            }
        });
    });

    // Setup event listeners for settings changes
    debugMode.addEventListener('change', () => {
        localStorage.setItem('debugMode', debugMode.checked);
        if (currentFile && currentFile.type.includes('pdf')) {
            loadFile(currentFile); // Reload current file with new settings
        }
    });

    condensePdfMode.addEventListener('change', () => {
        localStorage.setItem('condensePdfMode', condensePdfMode.checked);
        if (currentFile && currentFile.type.includes('pdf')) {
            loadFile(currentFile); // Reload current file with new settings
        }
    });
}

// --- INITIALIZATION ---
window.addEventListener('DOMContentLoaded', async () => {
    // Debug: Always log that we're starting
    console.log('[App Init] DOMContentLoaded fired');
    console.log('[App Init] Current URL:', window.location.href);
    console.log('[App Init] Query string:', window.location.search);

    setupExportPDFButton(condensedCanvases);
    setupDrivePicker();
    setupSettings();
    initYouTubePlayer();
    initSynthPlayer();

    // Check for test mode URL parameter
    const urlParams = new URLSearchParams(window.location.search);
    const testFile = urlParams.get('test');
    console.log('[App Init] Test parameter value:', testFile);

    if (testFile) {
        console.log('[Test Mode] Detected test parameter:', testFile);
        console.log('[Test Mode] Attempting to fetch: tests/' + testFile);
        try {
            const response = await fetch(`tests/${testFile}`);
            console.log('[Test Mode] Fetch response status:', response.status, response.statusText);

            if (!response.ok) throw new Error(`Failed to load: ${response.statusText}`);

            const blob = await response.blob();
            console.log('[Test Mode] Blob created, size:', blob.size, 'type:', blob.type);

            const file = new File([blob], testFile, { type: blob.type });
            console.log('[Test Mode] File object created:', file.name, file.size, 'bytes');

            // Load the file automatically
            console.log('[Test Mode] Calling loadFile...');
            await loadFile(file);
            console.log('[Test Mode] ✅ Test file loaded successfully');
        } catch (error) {
            console.error('[Test Mode] ❌ Failed to load test file:', error);
            console.error('[Test Mode] Error stack:', error.stack);
            alert(`Test mode error: Could not load tests/${testFile}\n${error.message}`);
            fileMenu.show();
        }
    } else {
        console.log('[Normal Mode] No test parameter found, showing file menu');
        // Show the file menu on initial load (normal mode)
        fileMenu.show();
    }

    if (urlParams.has('drawer')) {
        fileMenu.show();
    }
    if (urlParams.has('modal')) {
        import('./themeEngine.js').then(m => m.openThemeModal());
    }

    // Create navigation config with getters for dynamic values
    const getNavigationConfig = () => ({
        output,
        currentFile,
        pageModeRadio,
        continuousModeRadio,
        gpState,
        textState,
        getPages: () => pages,
        getCurrentPageIndex: () => currentPageIndex,
        continuous,
        condensedCanvases,
        renderPage: renderCurrentPage,
        renderGPPage: () => renderGPPage(output, pageModeRadio.checked, continuousModeRadio),
        renderTextPage: () => renderTextPage(output, pageModeRadio.checked),
        nextGPPage,
        prevGPPage,
        nextTextPage,
        prevTextPage,
        getPageStep,
        updatePageDisplay,
        doLayoutPages,
        setCurrentPageIndex: (index) => {
            currentPageIndex = index;
            renderCurrentPage();
        }
    });

    setupFirstPageNavigation(firstBtn, getNavigationConfig);
    setupPrevNextNavigation(prevBtn, nextBtn, getNavigationConfig);
    setupKeyboardNavigation(getNavigationConfig);
    setupViewModeToggles(pageModeRadio, continuousModeRadio, getNavigationConfig);
    setupTapClickNavigation(output, getNavigationConfig);
});

// --- FILE LOADING ---
fileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    await loadFile(file);
});

// --- LOAD PDF ---
async function loadPDF(file) {
    if (currentProcessing) currentProcessing.aborted = true;
    currentProcessing = { aborted: false };
    
    // Show progress bar immediately
    showProgress(progressContainer, progressBar);
    
    // Show navigation controls
    navButtons.style.display = 'flex';
    modeButtons.style.display = 'flex';

    // Clear previous state
    condensedCanvases.length = 0;
    pages.length = 0;
    currentPageIndex = 0;
    clearOutput(output);
    
    // Set up continuous mode scrolling if needed
    if (!pageModeRadio.checked) {
        output.style.overflowY = 'auto';
        enableContinuousScrollTracking(output, condensedCanvases, (newPage) => {
            currentPageIndex = newPage;
            updatePageDisplay();
        });
    }

    // Process PDF with current settings
    await processPDF(file, {
        debugMode: { checked: debugMode.checked },
        originalMode: { checked: !condensePdfMode.checked },
        progressContainer,
        progressBar,
        condensedCanvases,
        abortSignal: currentProcessing,
        onCanvasRendered: (canvas) => {
            if (currentProcessing.aborted) return;

            // Always check current mode at render time
            const isPageMode = pageModeRadio.checked;
            continuous = !isPageMode;
            
            if (isPageMode) {
                if (!canvas._layoutScheduled) {
                    canvas._layoutScheduled = true;
                    setTimeout(() => {
                        if (!currentProcessing.aborted) {
                            // Store current page index before layout
                            const oldIndex = currentPageIndex;
                            // Do layout but preserve the current page
                            clearOutput(output);
                            const result = layoutPages(condensedCanvases, pages);
                            pages = result.pages;
                            // Restore previous page index if we had one
                            currentPageIndex = oldIndex < pages.length ? oldIndex : result.newIndex;
                            updatePageDisplay();
                            renderCurrentPage();
                            output.focus();
                        }
                        canvas._layoutScheduled = false;
                    }, 0);
                }
            } else {
                // For continuous mode, append new canvas without clearing
                if (!canvas._appendScheduled) {
                    canvas._appendScheduled = true;
                    setTimeout(() => {
                        if (!currentProcessing.aborted) {
                            const wrapper = document.createElement('div');
                            wrapper.style.width = '100%';
                            wrapper.style.textAlign = 'center';
                            
                            // Scale canvas to fit width
                            if (canvas.width) {
                                const scale = output.clientWidth / canvas.width;
                                canvas.style.width = `${canvas.width * scale}px`;
                                canvas.style.height = 'auto';
                            }
                            
                            wrapper.appendChild(canvas);
                            output.appendChild(wrapper);
                            updatePageDisplay();
                        }
                        canvas._appendScheduled = false;
                    }, 0);
                }
            }
        }
    });
    
    // Hide progress bar after processing is complete
    hideProgress(progressContainer, progressBar);
}

export async function loadFile(file) {
    fileMenu.hide();
    resetView();

    currentFile = file;
    currentProcessing.aborted = true;
    currentProcessing = { aborted: false };
    
    // Update YouTube player metadata with filename
    updateSongForYouTube({ filename: file.name });
    
    // Show navigation controls for all supported file types
    navButtons.style.display = 'flex';
    modeButtons.style.display = 'flex';
    
    // Make output focusable and focus it for keyboard navigation
    output.tabIndex = 0;
    output.focus();
    
    // Apply default view mode based on file type preference
    const modeParam = new URLSearchParams(window.location.search).get('mode');
    if (modeParam === 'page') {
        pageModeRadio.checked = true;
        continuousModeRadio.checked = false;
    } else if (modeParam === 'continuous' || modeParam === 'scroll') {
        continuousModeRadio.checked = true;
        pageModeRadio.checked = false;
    } else if (isFileType(file, ['gp', 'gp3', 'gp4', 'gp5', 'gpx'])) {
        const gpDefault = localStorage.getItem('gpDefaultView') || 'continuous';
        if (gpDefault === 'continuous') {
            continuousModeRadio.checked = true;
            pageModeRadio.checked = false;
        } else {
            pageModeRadio.checked = true;
            continuousModeRadio.checked = false;
        }
    } else if (isFileType(file, ['pdf'])) {
        const pdfDefault = localStorage.getItem('pdfDefaultView') || 'page';
        if (pdfDefault === 'continuous') {
            continuousModeRadio.checked = true;
            pageModeRadio.checked = false;
        } else {
            pageModeRadio.checked = true;
            continuousModeRadio.checked = false;
        }
    }

    if (isFileType(file, ['pdf'])) {
        await loadPDF(file);
    } else if (isFileType(file, ['gp', 'gp3', 'gp4', 'gp5', 'gpx'])) {
        showProgress(progressContainer, progressBar);
        await loadGP(file, output, pageModeRadio, continuousModeRadio);
        hideProgress(progressContainer, progressBar);
    } else if (isFileType(file, ['txt'])) {
        showProgress(progressContainer, progressBar);
        await loadText(file, output, pageModeRadio, continuousModeRadio);
        hideProgress(progressContainer, progressBar);
    } else {
        console.warn('Unsupported file type:', file.name.split('.').pop().toLowerCase());
        // Hide navigation controls for unsupported files
        navButtons.style.display = 'none';
        modeButtons.style.display = 'none';
    }
}

// --- RESET FUNCTION ---
function resetView() {
    if (currentProcessing) currentProcessing.aborted = true;

    // Reset file states
    condensedCanvases.length = 0;
    pages.length = 0;
    currentPageIndex = 0;
    gpState.reset();

    // Reset UI and scroll position
    clearOutput(output);
    output.scrollTop = 0;
    pageIndicator.textContent = '';
    
    // Hide navigation controls and mode buttons by default
    navButtons.style.display = 'none';
    modeButtons.style.display = 'none';
}

// --- PAGE LAYOUT AND RENDERING ---
function doLayoutPages() {
    const result = layoutPages(condensedCanvases, pages);
    pages = result.pages;
    if (result.newIndex !== currentPageIndex) {
        currentPageIndex = result.newIndex;
    }
    // Update indicator before rendering
    updatePageDisplay();
    renderCurrentPage();
    // Focus after layout and rendering is complete
    output.focus();
}

function getPageStep() {
    const selected = document.querySelector('input[name="pageAdvanceRadio"]:checked');
    const advancePages = selected ? parseInt(selected.value, 10) : 2;
    return advancePages === 1 ? 1 : getPagesPerView();
}

// --- PAGE RENDERING ---
function renderCurrentPage() {
    if (!pages || !pages.length) return;
    renderPage(output, pages, currentPageIndex, updatePageDisplay);
}

// --- PAGE INDICATOR ---
function updatePageDisplay() {
    if (pages.length > 0) {
        if (continuousModeRadio.checked) {
            // In continuous mode, show scroll percentage
            const scrollPercent = (output.scrollTop / (output.scrollHeight - output.clientHeight) * 100) || 0;
            pageIndicator.textContent = `${Math.round(scrollPercent)}%`;
        } else {
            // In page mode, show page numbers
            updatePageIndicator(
                pageIndicator,
                currentPageIndex,
                pages.length,
                getPagesPerView()
            );
        }
    }
}

export function hideLoadingBar() {
    hideProgress(progressContainer, progressBar);
}

export function hideFileMenu() {
    fileMenu.hide();
}