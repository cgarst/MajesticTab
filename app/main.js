// main.js
import { processPDF } from './pdfProcessor/pdfProcessor.js';
import { setupDrivePicker } from './googleDrive.js';
import { setupExportPDFButton } from './exportPdf.js';
import { loadGP, renderGPPage, gpState, nextGPPage, prevGPPage, layoutGPPages } from './gpProcessor/gpHandler.js';
import { setGpDisplayScale, applySavedGpDisplayScale } from './gpProcessor/gpProcessor.js';
import { loadText, renderTextPage, textState, nextTextPage, prevTextPage } from './textProcessor/textHandler.js';
import { isFileType, showProgress, hideProgress } from './utils/fileHandlingUtils.js';
import { setupFirstPageNavigation, setupPrevNextNavigation, setupKeyboardNavigation, setupViewModeToggles, setupTapClickNavigation, setupGlobalRewindButton } from './utils/navigationUtils.js';
import { getPagesPerView } from './utils/viewModeUtils.js';
import { clearOutput, updatePageIndicator, layoutPages, renderPage } from './utils/renderUtils.js';
import { enableContinuousScrollTracking } from './utils/scrollUtils.js';
import { initYouTubePlayer, updateSongForYouTube } from './youtubePlayer.js';
import { initSynthPlayer, hideSynthPlayer } from './gpProcessor/gpPlayer.js';
import { initTheming } from './themeEngine.js';
import { installExtensionSources, applyFileAdapters } from './fileAdapters.js';

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
// Native macOS shell uses an overlay title bar; reserve room for the traffic lights.
if (window.__TAURI__ && /Mac/i.test(navigator.platform)) {
    const root = document.documentElement;
    // Traffic lights are hidden in fullscreen, so revert to the standard layout then.
    const syncTitleBarInset = () => {
        const fs = !!(document.fullscreenElement || document.webkitFullscreenElement)
            || window.innerHeight >= screen.height;
        root.classList.toggle('tauri-macos', !fs);
    };
    syncTitleBarInset();
    window.addEventListener('resize', syncTitleBarInset);
    document.addEventListener('fullscreenchange', syncTitleBarInset);
    document.addEventListener('webkitfullscreenchange', syncTitleBarInset);
}
if (topBar) {
    let isDown = false;
    let startX = 0;
    let scrollLeft = 0;
    let hasDragged = false;

    topBar.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDown = true;
        hasDragged = false;
        startX = e.pageX - topBar.offsetLeft;
        scrollLeft = topBar.scrollLeft;
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        const x = e.pageX - topBar.offsetLeft;
        const walk = x - startX;
        if (Math.abs(walk) > 4) {
            hasDragged = true;
            topBar.classList.add('is-dragging');
            topBar.scrollLeft = scrollLeft - walk;
        }
    });

    const stopDragging = () => {
        if (isDown) {
            isDown = false;
            topBar.classList.remove('is-dragging');
            if (hasDragged) {
                setTimeout(() => { hasDragged = false; }, 50);
            }
        }
    };

    window.addEventListener('mouseup', stopDragging);

    // Prevent accidental button clicks when dragging
    topBar.addEventListener('click', (e) => {
        if (hasDragged) {
            e.preventDefault();
            e.stopPropagation();
            hasDragged = false;
        }
    }, true);
}
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

    const gpSheetScaleInput = document.getElementById('gpSheetScale');
    const gpSheetScaleValue = document.getElementById('gpSheetScaleValue');
    const gpSheetScaleMinus = document.getElementById('gpSheetScaleMinus');
    const gpSheetScalePlus = document.getElementById('gpSheetScalePlus');
    if (gpSheetScaleInput && gpSheetScaleValue) {
        const syncGpSheetScale = (nextValue) => {
            const currentScale = Number.parseInt(nextValue, 10);
            const safeValue = Number.isFinite(currentScale) ? currentScale : 100;
            gpSheetScaleInput.value = String(safeValue);
            gpSheetScaleValue.textContent = `${safeValue}%`;
            return safeValue;
        };

        const applyGpSheetScale = async (nextValue) => {
            const scaledValue = syncGpSheetScale(nextValue);
            setGpDisplayScale(scaledValue);

            if (currentFile && isFileType(currentFile, ['gp', 'gp3', 'gp4', 'gp5', 'gpx'])) {
                await loadFile(currentFile, { hideMenu: false });
            }
        };

        const savedGpSheetScale = applySavedGpDisplayScale();
        syncGpSheetScale(savedGpSheetScale);

        gpSheetScaleInput.addEventListener('input', () => {
            syncGpSheetScale(gpSheetScaleInput.value);
        });

        gpSheetScaleInput.addEventListener('change', async () => {
            await applyGpSheetScale(gpSheetScaleInput.value);
        });

        gpSheetScaleMinus?.addEventListener('click', async () => {
            const currentScale = Number.parseInt(gpSheetScaleInput.value, 10) || 100;
            const nextScale = Math.max(50, currentScale - 5);
            await applyGpSheetScale(nextScale);
        });

        gpSheetScalePlus?.addEventListener('click', async () => {
            const currentScale = Number.parseInt(gpSheetScaleInput.value, 10) || 100;
            const nextScale = Math.min(200, currentScale + 5);
            await applyGpSheetScale(nextScale);
        });
    }
    
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

function setupExtensionSettings() {
    const modal = document.getElementById('extensionModal');
    const openButton = document.getElementById('openExtensions');
    const sourceInput = document.getElementById('extensionSource');
    const listView = document.getElementById('extensionListView');
    const editorView = document.getElementById('extensionEditorView');
    const extensionList = document.getElementById('extensionList');
    const extensionCount = document.getElementById('extensionCount');
    const managerStatus = document.getElementById('extensionManagerStatus');
    const editorStatus = document.getElementById('extensionEditorStatus');
    const addButton = document.getElementById('addExtension');
    const importButton = document.getElementById('importExtensionFile');
    const importInput = document.getElementById('importExtensionInput');
    const saveButton = document.getElementById('saveExtension');
    const closeButton = modal?.querySelector('.extension-modal-close-btn');
    const extensionsKey = 'customExtensions';
    const legacySourceKey = 'customExtensionSource';
    const legacyEnabledKey = 'customExtensionEnabled';
    const adapterSourceKey = 'customFileAdapterSource';

    if (!modal || !openButton || !sourceInput || !listView || !editorView || !extensionList) return;

    let returnFocusTarget = null;
    let editingId = null;
    let extensions = [];
    const editor = window.CodeMirror?.fromTextArea(sourceInput, {
        mode: 'javascript',
        lineNumbers: true,
        indentUnit: 2,
        tabSize: 2,
        indentWithTabs: false,
        lineWrapping: false,
        placeholder: sourceInput.placeholder
    });

    editor?.on('change', () => {
        sourceInput.value = editor.getValue();
    });

    const getSource = () => editor ? editor.getValue() : sourceInput.value;
    const extensionLabel = extension => extension.registrationIds?.length
        ? extension.registrationIds.join(', ')
        : 'No registered ID';
    const setSource = source => {
        sourceInput.value = source;
        editor?.setValue(source);
    };
    const saveExtensions = () => localStorage.setItem(extensionsKey, JSON.stringify(extensions));

    const refreshInstalledExtensions = () => {
        extensions.forEach(extension => { extension.error = ''; });
        const active = extensions.filter(extension => extension.enabled);
        const result = installExtensionSources(active.map(({ id, source }) => ({ id, source })));
        result.errors.forEach(error => {
            const extension = extensions.find(item => item.id === error.id);
            if (extension) extension.error = error.message;
        });
        active.forEach(extension => {
            extension.registrationIds = result.idsByExtension[extension.id] || [];
            if (extension.error) extension.registrationIds = [];
        });
        saveExtensions();
        const failedCount = result.errors.length;
        managerStatus.textContent = failedCount
            ? `${result.registrationCount} registrations active; ${failedCount} extension${failedCount === 1 ? '' : 's'} failed to load`
            : result.registrationCount
                ? `${result.registrationCount} registration${result.registrationCount === 1 ? '' : 's'} active`
                : 'No extensions registered';
    };

    const renderExtensions = () => {
        extensionList.replaceChildren();
        extensionCount.textContent = `${extensions.length} extension${extensions.length === 1 ? '' : 's'}`;

        if (!extensions.length) {
            const emptyState = document.createElement('div');
            emptyState.className = 'extension-empty-state';
            emptyState.textContent = 'No extensions yet';
            extensionList.append(emptyState);
            return;
        }

        extensions.forEach(extension => {
            const row = document.createElement('article');
            row.className = 'extension-item';
            row.setAttribute('role', 'listitem');

            const details = document.createElement('div');
            details.className = 'extension-item-details';
            const label = extensionLabel(extension);
            const name = document.createElement('strong');
            name.className = 'extension-item-name';
            name.textContent = label;
            name.title = label;
            const state = document.createElement('span');
            state.className = extension.error ? 'extension-item-state text-danger' : 'extension-item-state';
            state.textContent = extension.error
                ? `Could not load: ${extension.error}`
                : extension.enabled ? 'Enabled' : 'Disabled';
            details.append(name, state);

            const actions = document.createElement('div');
            actions.className = 'extension-item-actions';
            const enabledLabel = document.createElement('label');
            enabledLabel.className = 'form-check form-switch extension-toggle';
            const enabledInput = document.createElement('input');
            enabledInput.className = 'form-check-input';
            enabledInput.type = 'checkbox';
            enabledInput.checked = extension.enabled;
            enabledInput.setAttribute('aria-label', `${label} enabled`);
            enabledInput.addEventListener('change', () => {
                extension.enabled = enabledInput.checked;
                saveExtensions();
                refreshInstalledExtensions();
                renderExtensions();
            });
            enabledLabel.append(enabledInput);

            const editButton = document.createElement('button');
            editButton.className = 'btn btn-sm theme-control-btn';
            editButton.type = 'button';
            editButton.title = `Edit ${label}`;
            editButton.setAttribute('aria-label', `Edit ${label}`);
            editButton.innerHTML = '<i class="bi-pencil"></i>';
            editButton.addEventListener('click', () => showEditor(extension));

            const deleteButton = document.createElement('button');
            deleteButton.className = 'btn btn-sm theme-control-btn extension-delete-button';
            deleteButton.type = 'button';
            deleteButton.title = `Delete ${label}`;
            deleteButton.setAttribute('aria-label', `Delete ${label}`);
            deleteButton.innerHTML = '<i class="bi-trash"></i>';
            deleteButton.addEventListener('click', () => {
                if (!window.confirm(`Delete "${label}"?`)) return;
                extensions = extensions.filter(item => item.id !== extension.id);
                saveExtensions();
                refreshInstalledExtensions();
                renderExtensions();
            });

            actions.append(enabledLabel, editButton, deleteButton);
            row.append(details, actions);
            extensionList.append(row);
        });
    };

    const showList = () => {
        editorView.classList.add('d-none');
        listView.classList.remove('d-none');
        renderExtensions();
        addButton.focus();
    };

    const showEditor = (extension, sourceOverride) => {
        editingId = extension?.id ?? null;
        setSource(sourceOverride ?? extension?.source ?? '');
        document.getElementById('extensionEditorMode').textContent = extension ? 'Edit extension' : 'New extension';
        editorStatus.textContent = '';
        listView.classList.add('d-none');
        editorView.classList.remove('d-none');
        requestAnimationFrame(() => {
            editor?.refresh();
            if (editor) editor.focus();
            else sourceInput.focus();
        });
    };

    const openModal = () => {
        returnFocusTarget = document.getElementById('menuToggleBtn') || openButton;
        modal.classList.add('show');
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('modal-open');
        showList();
    };

    const closeModal = () => {
        modal.classList.remove('show');
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('modal-open');
        returnFocusTarget?.focus();
    };

    openButton.addEventListener('click', () => {
        const menu = document.getElementById('fileMenu');
        const offcanvas = menu && window.bootstrap?.Offcanvas?.getInstance(menu);
        if (menu?.classList.contains('show') && offcanvas) {
            menu.addEventListener('hidden.bs.offcanvas', openModal, { once: true });
            offcanvas.hide();
        } else {
            openModal();
        }
    });
    closeButton?.addEventListener('click', closeModal);
    modal.addEventListener('click', event => {
        if (event.target === modal) closeModal();
    });
    window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && modal.classList.contains('show')) closeModal();
    });

    const storedExtensions = localStorage.getItem(extensionsKey);
    if (storedExtensions !== null) {
        try {
            const parsed = JSON.parse(storedExtensions);
            if (Array.isArray(parsed)) {
                extensions = parsed.filter(extension =>
                    extension && typeof extension.id === 'string' && typeof extension.source === 'string'
                        && extension.id !== 'builtin-acoustic-guitar'
                ).map(extension => ({
                    id: extension.id,
                    source: extension.source,
                    enabled: extension.enabled === true,
                    registrationIds: Array.isArray(extension.registrationIds)
                        ? extension.registrationIds.filter(id => typeof id === 'string')
                        : [],
                    error: ''
                }));
            }
        } catch (error) {
            managerStatus.textContent = `Could not read saved extensions: ${error.message}`;
        }
    }

    const oldSource = localStorage.getItem(legacySourceKey) ?? localStorage.getItem(adapterSourceKey);
    if (oldSource !== null) {
        if (!extensions.some(extension => extension.id === 'migrated-extension')) {
            extensions.push({
                id: 'migrated-extension',
                source: oldSource,
                enabled: (localStorage.getItem(legacyEnabledKey) ?? localStorage.getItem('customFileAdapterEnabled')) === 'true',
                registrationIds: [],
                error: ''
            });
        }
    }

    localStorage.removeItem(legacySourceKey);
    localStorage.removeItem(legacyEnabledKey);
    localStorage.removeItem(adapterSourceKey);
    localStorage.removeItem('customFileAdapterEnabled');
    localStorage.removeItem('builtInAcousticGuitarExtensionInstalled');
    refreshInstalledExtensions();
    renderExtensions();

    addButton.addEventListener('click', () => showEditor(null));
    importButton.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
        const file = importInput.files?.[0];
        importInput.value = '';
        if (!file) return;

        try {
            showEditor(null, await file.text());
        } catch (error) {
            managerStatus.textContent = `Could not read extension file: ${error.message}`;
        }
    });
    document.getElementById('backToExtensions').addEventListener('click', showList);
    document.getElementById('cancelExtensionEdit').addEventListener('click', showList);
    saveButton.addEventListener('click', () => {
        const existing = extensions.find(extension => extension.id === editingId);
        if (existing) {
            existing.source = getSource();
            existing.registrationIds = [];
            existing.error = '';
        } else {
            extensions.push({
                id: globalThis.crypto?.randomUUID?.() ?? `extension-${Date.now()}`,
                source: getSource(),
                enabled: true,
                registrationIds: [],
                error: ''
            });
        }

        saveExtensions();
        refreshInstalledExtensions();
        showList();
    });
}

// --- INITIALIZATION ---
window.addEventListener('DOMContentLoaded', async () => {
    // Debug: Always log that we're starting
    console.log('[App Init] DOMContentLoaded fired');
    console.log('[App Init] Current URL:', window.location.href);
    console.log('[App Init] Query string:', window.location.search);

    setupExportPDFButton();
    setupDrivePicker();
    setupSettings();
    setupExtensionSettings();
    initYouTubePlayer();
    initSynthPlayer();
    setupGlobalRewindButton();

    // Check for test mode URL parameter
    const urlParams = new URLSearchParams(window.location.search);
    const testFile = urlParams.get('test');
    console.log('[App Init] Test parameter value:', testFile);

    if (testFile) {
        console.log('[Test Mode] Detected test parameter:', testFile);
        console.log('[Test Mode] Attempting to fetch: tests/' + testFile);
        try {
            let response = await fetch(`tests/${testFile}`);
            if (!response.ok) {
                response = await fetch(`../tests/${testFile}`);
            }
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
        // Show the file menu on initial load (normal mode), unless the Drive modal was
        // just reopened after the OAuth redirect (the offcanvas focus trap would steal
        // focus from the Drive search input)
        const driveModalEl = document.getElementById('driveModal');
        const driveModalOpen = driveModalEl && driveModalEl.style.display === 'flex';
        if (driveModalOpen) {
            console.log('[Normal Mode] Drive modal open, not showing file menu');
        } else {
            console.log('[Normal Mode] No test parameter found, showing file menu');
            fileMenu.show();
        }
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
    const processing = { aborted: false };
    currentProcessing = processing;
    
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
        abortSignal: processing,
        onCanvasRendered: (canvas) => {
            if (processing.aborted) return;

            // Always check current mode at render time
            const isPageMode = pageModeRadio.checked;
            continuous = !isPageMode;
            
            if (isPageMode) {
                if (!canvas._layoutScheduled) {
                    canvas._layoutScheduled = true;
                    setTimeout(() => {
                        if (!processing.aborted) {
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
                        if (!processing.aborted) {
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

export async function loadFile(file, { hideMenu = true } = {}) {
    if (hideMenu) {
        fileMenu.hide();
    }
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

    const supportedFile = isFileType(file, ['pdf', 'gp', 'gp3', 'gp4', 'gp5', 'gpx', 'txt']);
    let fileToLoad = file;
    if (supportedFile && file instanceof File) {
        try {
            showProgress(progressContainer, progressBar);
            fileToLoad = await applyFileAdapters(file);
        } catch (error) {
            console.error('Error applying file adapters:', error);
            alert(error?.message || 'Unable to process this file.');
            return;
        } finally {
            hideProgress(progressContainer, progressBar);
        }
    }

    if (isFileType(file, ['pdf'])) {
        await loadPDF(fileToLoad);
    } else if (isFileType(file, ['gp', 'gp3', 'gp4', 'gp5', 'gpx'])) {
        showProgress(progressContainer, progressBar);
        await loadGP(fileToLoad, output, pageModeRadio, continuousModeRadio);
        hideProgress(progressContainer, progressBar);
    } else if (isFileType(file, ['txt'])) {
        showProgress(progressContainer, progressBar);
        await loadText(fileToLoad, output, pageModeRadio, continuousModeRadio);
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

export function getCurrentFile() {
    return currentFile;
}

export function getCondensedCanvases() {
    return condensedCanvases;
}

export function getPdfPages() {
    return pages;
}

// Fullscreen toggle
(function setupFullscreenToggle() {
    const btn = document.getElementById("fullscreenToggleBtn");
    const icon = document.getElementById("fullscreenIcon");
    if (!btn) return;
    const root = document.documentElement;
    const nativeImmersive = window.AndroidImmersive;
    let immersive = false;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!request && !nativeImmersive) { btn.parentElement.style.display = "none"; return; }
    const getFsElement = () => nativeImmersive ? (immersive || null) : (document.fullscreenElement || document.webkitFullscreenElement);
    const exit = () => (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    btn.addEventListener("click", () => {
        console.log("Fullscreen button clicked; currently fullscreen:", !!getFsElement());
        if (nativeImmersive) {
            immersive = !immersive;
            nativeImmersive.setImmersive(immersive);
            onChange();
            btn.blur();
            return;
        }
        try {
            const result = getFsElement() ? exit() : request.call(root);
            if (result && result.catch) result.catch(err => console.error("Fullscreen failed:", err));
        } catch (err) {
            console.error("Fullscreen failed:", err);
        }
        btn.blur();
    });
    const onChange = () => {
        const fs = !!getFsElement();
        icon.className = fs ? "bi-fullscreen-exit" : "bi-arrows-fullscreen";
        btn.title = fs ? "Exit Fullscreen" : "Enter Fullscreen";
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
})();
