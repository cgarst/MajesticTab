// main.js
import { processPDF } from './pdfProcessor/pdfProcessor.js';
import { setupDrivePicker } from './googleDrive.js';
import { setupExportPDFButton } from './exportPdf.js';
import { setupSaveToLibraryButton } from './saveToLibrary.js';
import { setupAddToSetlistButton } from './setlistUi.js';
import { setupSetlistNav, refreshSetlistNav } from './setlistPlayer.js';
import { loadGP, renderGPPage, applyGpDisplayScale, gpState, nextGPPage, prevGPPage, layoutGPPages, applyGpNotationMode, syncGpNotationRadios, applyGpStringCount, syncGpStringCountRadios, syncGpStringCountUI } from './gpProcessor/gpHandler.js';
import { setGpDisplayScale, applySavedGpDisplayScale, getGpNotationMode, getGpDisplayScalePercent } from './gpProcessor/gpProcessor.js';
import { setupPageScrubber } from './utils/pageScrubber.js';
import { loadText, renderTextPage, textState, nextTextPage, prevTextPage } from './textProcessor/textHandler.js';
import { isFileType, showProgress, hideProgress } from './utils/fileHandlingUtils.js';
import { setupFirstPageNavigation, setupPrevNextNavigation, setupKeyboardNavigation, setupMouseNavigation, setupSystemBackNavigation, setupViewModeToggles, setupTapClickNavigation, setupGlobalRewindButton, updateGlobalAudioControls, handleGlobalBack } from './utils/navigationUtils.js';
import { getPagesPerView } from './utils/viewModeUtils.js';
import { clearOutput, updatePageIndicator, layoutPages, renderPage } from './utils/renderUtils.js';
import { enableContinuousScrollTracking, scrollToPage } from './utils/scrollUtils.js';
import { initYouTubePlayer, updateSongForYouTube } from './youtubePlayer.js';
import { initSoundFontPanel } from './gpProcessor/soundFontPanel.js';
import { initMixerPanel, wireModal, closeModal } from './gpProcessor/mixerPanel.js';
import { initAudioLatencyModal } from './gpProcessor/audioLatencyModal.js';
import { initSynthPlayer, hideSynthPlayer, initScoreOptionsPanel, showScoreOptions, hideScoreOptions, syncSynthTrackModeLabels } from './gpProcessor/gpPlayer.js';
import { setPdfDocument, setBookmarkCurrentPageIndex, clearPdfBookmarks, initPdfBookmarksUI } from './pdfProcessor/pdfBookmarks.js';
import { initTheming } from './themeEngine.js';
import { installExtensionSources, applyFileAdapters } from './fileAdapters.js';
import { initUpdater } from './updater.js';
import { openFromProvider } from './fileProviders.js';
import { openLibraryModal, closeLibraryModal, isLibraryOpen } from './libraryModal.js';
import { initTauriDownloadListener } from './tabDownloader.js';
import { addRecentOpened } from './libraryStore.js';
import { inferTuningFromTextOrName, detectFileMetadata, getInstrumentMode, setInstrumentMode, getDefaultGpStringCount, setDefaultGpStringCount } from './utils/tuningUtils.js';
import { initBackupRestore } from './backupRestore.js';
import { initSync } from './syncUi.js';
import { showToast } from './utils/toast.js';
import { initGamepadManager } from './utils/gamepadManager.js';
import { initJamMode } from './jam/jamManager.js';
import { isSteamDeck, applyPlatformDefaults, getDefaultView, getDefaultLandscapePageLayout } from './utils/platformUtils.js';
import { initIOSAudioUnlock, isIOSDevice } from './utils/iosAudioUnlock.js';
import { initFretboard } from './fretboard/fretboardController.js';
import { initTuner } from './tuner/tuner.js';
import { initToolsMenu } from './utils/toolsMenu.js';
import { initUrlRouter, getRouteFromUrl } from './utils/urlRouter.js';

// Initialize iOS audio unlock and session configuration as early as possible
initIOSAudioUnlock();
if (isIOSDevice()) {
    const isNativeIOS = Boolean(window.__TAURI__);
    const isStandaloneIOS = Boolean(window.navigator?.standalone || window.matchMedia?.('(display-mode: standalone)')?.matches);
    if (isNativeIOS || isStandaloneIOS) {
        document.documentElement.classList.add('tauri-ios');
    }
    if (isStandaloneIOS && !isNativeIOS) {
        document.documentElement.classList.add('ios-pwa');
    }
    if (isNativeIOS) {
        try {
            window.__TAURI__?.core?.invoke('configure_ios_main_window').catch(() => {});
        } catch (_) {}
    }
}

// Handle window resizing 
let resizeTimeout;
window.addEventListener('resize', () => {
    // Debounce resize handling
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(async () => {
        const pageModeRadio = document.getElementById('pageModeRadio');
        const continuousModeRadio = document.getElementById('continuousModeRadio');
        const output = document.getElementById('output');
        
        // Only re-render if we have a file loaded
        if (currentFile && pageModeRadio && output) {
            if (gpState.canvases[0]?.container && pageModeRadio.checked) {
                // For GP files in page mode, recalculate pages based on new dimensions
                const pageHeight = output.clientHeight - 20;
                const anchorBlock = gpState.pages[gpState.currentPageIndex]?.[0]?.dataset?.blockIndex;
                gpState.pages = layoutGPPages(gpState.canvases[0].container, pageHeight);
                if (anchorBlock !== undefined) {
                    const found = gpState.pages.findIndex(p => p.some(b => b.dataset.blockIndex === anchorBlock));
                    if (found >= 0) gpState.currentPageIndex = found;
                }
                gpState.currentPageIndex = Math.min(gpState.currentPageIndex, Math.max(0, gpState.pages.length - 1));
                renderGPPage(output, pageModeRadio.checked, continuousModeRadio);
            } else if (isFileType(currentFile, ['pdf']) && pageModeRadio.checked) {
                doLayoutPages();
            } else if (isFileType(currentFile, ['txt']) && pageModeRadio.checked) {
                await loadFile(currentFile, { hideMenu: false, keepMode: true });
            }
        }
    }, 250); // Wait for resize to finish
});

// Handle desktop zooming with Ctrl+Wheel
const mainContent = document.getElementById('mainContent');
const topBar = document.getElementById('topBar');
// Native macOS shell uses an overlay title bar; reserve room for the traffic lights.
if (window.__TAURI__ && /Mac/i.test(navigator.platform) && !isIOSDevice()) {
    const root = document.documentElement;
    const appWindow = window.__TAURI__.window?.getCurrentWindow?.();
    // Traffic lights are hidden in fullscreen, so revert to the standard layout then.
    let syncToken = 0;
    const syncTitleBarInset = async () => {
        const token = ++syncToken;
        let fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (!fs && appWindow) {
            try { fs = await appWindow.isFullscreen(); } catch {}
        }
        if (token === syncToken) root.classList.toggle('tauri-macos', !fs);
    };
    // The window state settles after the fullscreen animation, so re-check once it ends.
    let settleTimer = 0;
    const scheduleSync = () => {
        syncTitleBarInset();
        clearTimeout(settleTimer);
        settleTimer = setTimeout(syncTitleBarInset, 600);
    };
    syncTitleBarInset();
    window.addEventListener('resize', scheduleSync);
    document.addEventListener('fullscreenchange', scheduleSync);
    document.addEventListener('webkitfullscreenchange', scheduleSync);
}
// Native Windows shell is undecorated; draw window controls on the right and shift the top bar controls left.
// In fullscreen the controls are hidden, so the top bar controls return to the right edge.
if (window.__TAURI__ && /Win/i.test(navigator.platform)) {
    const root = document.documentElement;
    const appWindow = window.__TAURI__.window?.getCurrentWindow?.();
    const maxIcon = document.getElementById('winMaxIcon');
    const maxBtn = document.getElementById('winMaxBtn');
    let syncToken = 0;
    const syncWindowState = async () => {
        const token = ++syncToken;
        let fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        let maximized = false;
        if (appWindow) {
            try { if (!fs) fs = await appWindow.isFullscreen(); } catch {}
            try { maximized = await appWindow.isMaximized(); } catch {}
        }
        if (token !== syncToken) return;
        root.classList.toggle('tauri-windows', !fs);
        if (maxIcon) maxIcon.className = maximized ? 'bi-fullscreen-exit' : 'bi-square';
        if (maxBtn) { const t = maximized ? 'Restore' : 'Maximize'; maxBtn.title = t; maxBtn.setAttribute('aria-label', t); }
    };
    let settleTimer = 0;
    const scheduleSync = () => {
        syncWindowState();
        clearTimeout(settleTimer);
        settleTimer = setTimeout(syncWindowState, 400);
    };
    window.__syncWindowState = scheduleSync;
    document.getElementById('winMinBtn')?.addEventListener('click', () => appWindow?.minimize());
    maxBtn?.addEventListener('click', () => appWindow?.toggleMaximize());
    document.getElementById('winCloseBtn')?.addEventListener('click', () => appWindow?.close());
    syncWindowState();
    window.addEventListener('resize', scheduleSync);
    document.addEventListener('fullscreenchange', scheduleSync);
    document.addEventListener('webkitfullscreenchange', scheduleSync);
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

// Prevent dragging images from the app
window.addEventListener('dragstart', (e) => {
    const target = e.target;
    if (target && (target.nodeName === 'IMG' || target.nodeName === 'image' || (target.closest && target.closest('img, image')))) {
        e.preventDefault();
    }
}, true);

// Prevent browser from opening dropped files as webpages outside drop targets
window.addEventListener('dragover', (e) => {
    e.preventDefault();
}, false);
window.addEventListener('drop', (e) => {
    e.preventDefault();
}, false);


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
fileMenuEl.addEventListener('hidden.bs.offcanvas', () => {
    document.activeElement?.blur?.();
});
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

// --- TAB SIZE & DISPLAY SCALE ---
export function syncGpSheetScale(nextValue) {
    const currentScale = Number.parseInt(nextValue, 10);
    const safeValue = Number.isFinite(currentScale) ? Math.min(150, Math.max(50, currentScale)) : 100;
    const input = document.getElementById('gpSheetScale');
    const valueEl = document.getElementById('gpSheetScaleValue');
    if (input) input.value = String(safeValue);
    if (valueEl) valueEl.textContent = `${safeValue}%`;
    return safeValue;
}

export async function applyGpSheetScale(nextValue) {
    const scaledValue = syncGpSheetScale(nextValue);
    setGpDisplayScale(scaledValue);

    if (currentFile && isFileType(currentFile, ['txt'])) {
        await loadFile(currentFile, { hideMenu: false, keepMode: true });
    } else if (currentFile && isFileType(currentFile, ['gp', 'gp3', 'gp4', 'gp5', 'gpx'])) {
        if (!applyGpDisplayScale(output, pageModeRadio?.checked, continuousModeRadio)) {
            await loadFile(currentFile, { hideMenu: false, keepMode: true });
        }
    }
    return scaledValue;
}

// --- PINCH TO ZOOM TAB SIZE ---
function setupPinchToZoom() {
    const container = document.getElementById('mainContent') || document.body;
    let activePinchInitialDistance = null;
    let activePinchStartScale = null;
    let latestTargetScale = null;
    let pinchDebounceTimer = null;
    let wheelDeltaAccumulator = 0;

    const isInteractiveOverlayOpen = (e) => {
        if (isLibraryOpen() || document.querySelector('.modal.show, .offcanvas.show')) return true;
        if (e && e.target && e.target.closest && e.target.closest('.modal, .offcanvas, input, textarea, select')) return true;
        return false;
    };

    const commitScale = (targetPercent) => {
        latestTargetScale = targetPercent;
        syncGpSheetScale(targetPercent);
        showToast(`Tab size: ${targetPercent}%`, 'info', 1500, 'tab-size-scale');
        clearTimeout(pinchDebounceTimer);
        pinchDebounceTimer = setTimeout(() => {
            applyGpSheetScale(targetPercent);
        }, 80);
    };

    const flushScale = () => {
        clearTimeout(pinchDebounceTimer);
        if (latestTargetScale !== null) {
            applyGpSheetScale(latestTargetScale);
            latestTargetScale = null;
        }
    };

    // 1. Multi-touch Pinch Gesture (iOS, Android, touchscreen tablets/laptops)
    container.addEventListener('touchstart', (e) => {
        if (isInteractiveOverlayOpen(e)) return;
        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            activePinchInitialDistance = Math.hypot(dx, dy);
            activePinchStartScale = latestTargetScale ?? getGpDisplayScalePercent();
        }
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
        if (isInteractiveOverlayOpen(e)) return;
        if (e.touches.length === 2 && activePinchInitialDistance && activePinchStartScale !== null) {
            if (e.cancelable) e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const currentDist = Math.hypot(dx, dy);
            const ratio = currentDist / activePinchInitialDistance;
            let targetPercent = Math.round((activePinchStartScale * ratio) / 5) * 5;
            targetPercent = Math.min(150, Math.max(50, targetPercent));
            if (targetPercent !== (latestTargetScale ?? getGpDisplayScalePercent())) {
                commitScale(targetPercent);
            }
        }
    }, { passive: false });

    container.addEventListener('touchend', (e) => {
        if (e.touches.length < 2 && activePinchInitialDistance) {
            activePinchInitialDistance = null;
            activePinchStartScale = null;
            flushScale();
        }
    }, { passive: true });

    container.addEventListener('touchcancel', () => {
        activePinchInitialDistance = null;
        activePinchStartScale = null;
        flushScale();
    }, { passive: true });

    // 2. iOS Safari / WebKit native gesture events
    container.addEventListener('gesturestart', (e) => {
        if (isInteractiveOverlayOpen(e)) return;
        e.preventDefault();
        activePinchStartScale = latestTargetScale ?? getGpDisplayScalePercent();
    });

    container.addEventListener('gesturechange', (e) => {
        if (isInteractiveOverlayOpen(e)) return;
        e.preventDefault();
        if (activePinchStartScale !== null) {
            let targetPercent = Math.round((activePinchStartScale * e.scale) / 5) * 5;
            targetPercent = Math.min(150, Math.max(50, targetPercent));
            if (targetPercent !== (latestTargetScale ?? getGpDisplayScalePercent())) {
                commitScale(targetPercent);
            }
        }
    });

    container.addEventListener('gestureend', (e) => {
        e.preventDefault();
        if (activePinchStartScale !== null) {
            activePinchStartScale = null;
            flushScale();
        }
    });

    // 3. Trackpad Pinch & Ctrl + Mouse Wheel (macOS, Windows, Linux)
    window.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        if (isInteractiveOverlayOpen(e)) return;
        e.preventDefault();

        wheelDeltaAccumulator -= e.deltaY;
        const STEP_THRESHOLD = 25;
        if (Math.abs(wheelDeltaAccumulator) >= STEP_THRESHOLD) {
            const steps = Math.trunc(wheelDeltaAccumulator / STEP_THRESHOLD);
            wheelDeltaAccumulator -= steps * STEP_THRESHOLD;
            const currentPercent = latestTargetScale ?? getGpDisplayScalePercent();
            const nextPercent = Math.min(150, Math.max(50, currentPercent + steps * 5));
            if (nextPercent !== currentPercent) {
                commitScale(nextPercent);
            }
        }
    }, { passive: false });
}


// --- SETTINGS MANAGEMENT ---
function setupSettings() {
    // Apply platform defaults on initial launch/install (e.g. Steam Deck defaults to Page view and 1-page landscape)
    applyPlatformDefaults();

    // Load settings from localStorage
    const savedDebugMode = localStorage.getItem('debugMode') === 'true';
    
    // Load condense mode settings with different defaults
    const savedCondensePdfMode = localStorage.getItem('condensePdfMode');

    // Apply saved settings
    debugMode.checked = savedDebugMode;
    // Default: Condense PDFs off by default (false)
    condensePdfMode.checked = savedCondensePdfMode === null ? false : savedCondensePdfMode === 'true';

    const gpSheetScaleInput = document.getElementById('gpSheetScale');
    const gpSheetScaleMinus = document.getElementById('gpSheetScaleMinus');
    const gpSheetScalePlus = document.getElementById('gpSheetScalePlus');
    const savedGpSheetScale = applySavedGpDisplayScale();
    syncGpSheetScale(savedGpSheetScale);

    gpSheetScaleInput?.addEventListener('input', () => {
        syncGpSheetScale(gpSheetScaleInput.value);
    });

    gpSheetScaleInput?.addEventListener('change', async () => {
        await applyGpSheetScale(gpSheetScaleInput.value);
    });

    gpSheetScaleMinus?.addEventListener('click', async () => {
        const currentScale = Number.parseInt(gpSheetScaleInput?.value, 10) || 100;
        const nextScale = Math.max(50, currentScale - 5);
        await applyGpSheetScale(nextScale);
    });

    gpSheetScalePlus?.addEventListener('click', async () => {
        const currentScale = Number.parseInt(gpSheetScaleInput?.value, 10) || 100;
        const nextScale = Math.min(150, currentScale + 5);
        await applyGpSheetScale(nextScale);
    });
    
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

    // Setup Instrument Mode selector (Guitar vs Bass)
    const activeInstrumentMode = getInstrumentMode();
    wireModal('defaultsModal', 'defaultsModalBtn');
    document.getElementById('defaultsDoneBtn')?.addEventListener('click', () => closeModal('defaultsModal'));
    document.getElementById('defaultsResetBtn')?.addEventListener('click', () => {
        const defaults = {
            gpDefaultViewRadio: getDefaultView('gp'),
            pdfDefaultViewRadio: getDefaultView('pdf'),
            txtDefaultViewRadio: getDefaultView('txt'),
            gpDefaultStringsGuitarRadio: 'native',
            gpDefaultStringsBassRadio: 'native'
        };
        Object.entries(defaults).forEach(([name, value]) => {
            document.querySelector(`input[name="${name}"][value="${value}"]`)?.click();
        });
    });

    const instrumentModeRadios = document.querySelectorAll('input[name="instrumentModeRadio"]');
    instrumentModeRadios.forEach(radio => {
        if (radio.value === activeInstrumentMode) {
            radio.checked = true;
        }
        radio.addEventListener('change', async () => {
            if (radio.checked) {
                setInstrumentMode(radio.value);
                syncSynthTrackModeLabels();
                // If a GP file is loaded, re-load/re-render to swap tracks
                if (currentFile && isFileType(currentFile, ['gp', 'gp3', 'gp4', 'gp5', 'gpx'])) {
                    await loadFile(currentFile, { hideMenu: false, keepMode: true });
                }
                // If library is open, re-render library view
                if (isLibraryOpen()) {
                    import('./libraryModal.js').then(m => m.renderLibraryModal());
                }
            }
        });
    });

    // Setup Default View selectors for GP and PDF
    document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => new bootstrap.Tooltip(el));

    let savedGpDefaultView = localStorage.getItem('gpDefaultView') || getDefaultView('gp');
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

    let savedPdfDefaultView = localStorage.getItem('pdfDefaultView') || getDefaultView('pdf');
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

    let savedTxtDefaultView = localStorage.getItem('txtDefaultView') || getDefaultView('txt');
    document.querySelectorAll('input[name="txtDefaultViewRadio"]').forEach(radio => {
        if (radio.value === savedTxtDefaultView) {
            radio.checked = true;
        }
        radio.addEventListener('change', () => {
            if (radio.checked) {
                localStorage.setItem('txtDefaultView', radio.value);
            }
        });
    });

    // Setup Landscape in Page Mode selector (dual vs single page)
    let savedLandscapeLayout = localStorage.getItem('landscapePageLayout') || getDefaultLandscapePageLayout();
    const landscapeLayoutRadios = document.querySelectorAll('input[name="landscapePageLayoutRadio"]');
    landscapeLayoutRadios.forEach(radio => {
        if (radio.value === savedLandscapeLayout) {
            radio.checked = true;
        }
        radio.addEventListener('change', async () => {
            if (radio.checked) {
                localStorage.setItem('landscapePageLayout', radio.value);
                if (currentFile && pageModeRadio && pageModeRadio.checked) {
                    if (isFileType(currentFile, ['gp', 'gp3', 'gp4', 'gp5', 'gpx'])) {
                        const pagesPerView = getPagesPerView('gp');
                        if (gpState.pages?.length) {
                            gpState.currentPageIndex = Math.min(gpState.currentPageIndex, Math.max(0, gpState.pages.length - pagesPerView));
                        }
                        gpState.lastLayoutDimensions = null;
                        renderGPPage(output, true, continuousModeRadio);
                    } else if (isFileType(currentFile, ['txt'])) {
                        await loadFile(currentFile, { hideMenu: false, keepMode: true });
                    } else if (isFileType(currentFile, ['pdf'])) {
                        const pagesPerView = getPagesPerView('pdf');
                        if (pages?.length) {
                            currentPageIndex = Math.min(currentPageIndex, Math.max(0, pages.length - pagesPerView));
                        }
                        doLayoutPages();
                    }
                }
            }
        });
    });

    // Guitar Pro Notation Mode (Tab Only vs Tab + Standard)
    const savedGpNotation = getGpNotationMode();
    syncGpNotationRadios(savedGpNotation);

    const gpNotationRadios = document.querySelectorAll('input[name="gpNotationRadio"], input[name="synthNotationRadio"]');
    gpNotationRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.checked) {
                applyGpNotationMode(radio.value);
            }
        });
    });

    // Guitar Pro Tab String Count Defaults (Settings menu)
    const savedGuitarStrings = getDefaultGpStringCount('guitar');
    const guitarStringRadios = document.querySelectorAll('input[name="gpDefaultStringsGuitarRadio"]');
    guitarStringRadios.forEach(radio => {
        if (radio.value === savedGuitarStrings) {
            radio.checked = true;
        }
        radio.addEventListener('change', () => {
            if (radio.checked) {
                setDefaultGpStringCount(radio.value, 'guitar');
            }
        });
    });

    const savedBassStrings = getDefaultGpStringCount('bass');
    const bassStringRadios = document.querySelectorAll('input[name="gpDefaultStringsBassRadio"]');
    bassStringRadios.forEach(radio => {
        if (radio.value === savedBassStrings) {
            radio.checked = true;
        }
        radio.addEventListener('change', () => {
            if (radio.checked) {
                setDefaultGpStringCount(radio.value, 'bass');
            }
        });
    });

    // Setup event listeners for settings changes
    debugMode?.addEventListener('change', () => {
        localStorage.setItem('debugMode', debugMode.checked);
        if (currentFile && isFileType(currentFile, ['pdf'])) {
            loadFile(currentFile, { hideMenu: false, keepMode: true }); // Reload current file with new settings
        }
    });

    condensePdfMode?.addEventListener('change', () => {
        localStorage.setItem('condensePdfMode', condensePdfMode.checked);
        const exportPdfBtn = document.getElementById('exportPDFBtn');
        if (exportPdfBtn && currentFile && isFileType(currentFile, ['pdf'])) {
            exportPdfBtn.style.display = condensePdfMode.checked ? '' : 'none';
        }
        if (currentFile && isFileType(currentFile, ['pdf'])) {
            loadFile(currentFile, { hideMenu: false, keepMode: true }); // Reload current file with new settings
        }
    });

    document.getElementById('bulkExportBtn')?.addEventListener('click', () => {
        window.location.href = 'batchExport.html';
    });

    // Initialize Backup & Restore
    initBackupRestore();
    initSync();

    // Setup Quit App button (Native Linux desktop client only; navigator.platform reports "Linux" on Android too)
    if (window.__TAURI__ && /Linux/i.test(navigator.platform) && !/Android/i.test(navigator.userAgent)) {
        const fileMenuFooter = document.getElementById('fileMenuFooter');
        if (fileMenuFooter) fileMenuFooter.style.display = '';
        document.getElementById('menuQuitAppBtn')?.addEventListener('click', async () => {
            try {
                const appWindow = window.__TAURI__.window?.getCurrentWindow?.();
                if (appWindow) {
                    await appWindow.close();
                    return;
                }
            } catch (e) {
                console.warn('appWindow.close() failed:', e);
            }
            try {
                if (window.__TAURI__.process?.exit) {
                    await window.__TAURI__.process.exit(0);
                    return;
                }
            } catch (e) {
                console.warn('process.exit() failed:', e);
            }
        });
    }

    // Setup edge swipe gesture to open the menu on touch-enabled platforms
    setupMenuEdgeSwipeGesture();
}

/**
 * Enables swiping right from the left screen edge to open the hamburger menu drawer,
 * and sliding/swiping left from the right to dismiss the drawer across all touch platforms.
 */
function setupMenuEdgeSwipeGesture() {
    let startX = 0;
    let startY = 0;
    let isTrackingOpen = false;
    let isTrackingClose = false;
    const EDGE_THRESHOLD = 30; // Max distance from left viewport edge in pixels to initiate open gesture
    const SWIPE_MIN_DISTANCE = 45; // Minimum horizontal distance to trigger drawer opening or closing

    window.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) {
            isTrackingOpen = false;
            isTrackingClose = false;
            return;
        }

        const touch = e.touches[0];
        const fileMenu = document.getElementById('fileMenu');
        const isMenuOpen = Boolean(fileMenu && fileMenu.classList.contains('show'));

        if (isMenuOpen) {
            // Avoid triggering drawer dismissal when user is dragging a range slider
            if (e.target && e.target.closest && e.target.closest('input[type="range"]')) {
                isTrackingClose = false;
                return;
            }
            startX = touch.clientX;
            startY = touch.clientY;
            isTrackingClose = true;
            isTrackingOpen = false;
            return;
        }

        // Below is for opening the menu when closed
        if (touch.clientX > EDGE_THRESHOLD) {
            isTrackingOpen = false;
            return;
        }

        // Do not trigger if any interactive modal or dialog backdrop is open
        const openBackdrops = Array.from(document.querySelectorAll('.theme-modal-backdrop'))
            .filter(el => el.style.display === 'flex' || el.style.display === 'block');
        if (openBackdrops.length > 0 || document.querySelector('.modal.show')) {
            isTrackingOpen = false;
            return;
        }

        // When library page is open, only allow edge swipe to open settings if at root level (cannot go back)
        const libPage = document.getElementById('libraryPage');
        if (libPage && libPage.style.display !== 'none') {
            if (typeof window.__majesticLibraryCanGoBack === 'function' && window.__majesticLibraryCanGoBack()) {
                isTrackingOpen = false;
                return;
            }
        }

        // Avoid triggering when interacting with form controls or buttons near edge
        if (e.target && e.target.closest && e.target.closest('input, textarea, select, button')) {
            isTrackingOpen = false;
            return;
        }

        startX = touch.clientX;
        startY = touch.clientY;
        isTrackingOpen = true;
        isTrackingClose = false;
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];

        if (isTrackingOpen) {
            const deltaX = touch.clientX - startX;
            const deltaY = Math.abs(touch.clientY - startY);

            // Cancel if swiping backwards or primarily vertical scroll
            if (deltaX < 0 || (deltaY > 25 && deltaY > deltaX)) {
                isTrackingOpen = false;
                return;
            }

            // Trigger action when threshold reached
            if (deltaX >= SWIPE_MIN_DISTANCE && deltaX > deltaY * 1.2) {
                const libPage = document.getElementById('libraryPage');
                const isTabOpen = Boolean(currentFile && (!libPage || libPage.style.display === 'none'));

                if (isTabOpen) {
                    // When a tab is open, swiping from left does the same as back button (e.g. return to library)
                    const backBtn = document.getElementById('topBarBackToLibraryBtn');
                    if (backBtn && backBtn.offsetParent !== null && backBtn.style.display !== 'none') {
                        backBtn.click();
                    } else if (typeof handleGlobalBack === 'function') {
                        handleGlobalBack();
                    }
                } else {
                    // At root level of library, swiping from left edge opens settings menu
                    const fileMenu = document.getElementById('fileMenu');
                    if (fileMenu) {
                        if (window.bootstrap?.Offcanvas) {
                            window.bootstrap.Offcanvas.getOrCreateInstance(fileMenu).show();
                        } else {
                            document.getElementById('menuToggleBtn')?.click();
                        }
                    }
                }
                isTrackingOpen = false;
            }
        } else if (isTrackingClose) {
            const deltaX = touch.clientX - startX;
            const deltaY = Math.abs(touch.clientY - startY);

            // Cancel if swiping right (deeper into screen) or primarily vertical scroll
            if (deltaX > 15 || (deltaY > 20 && deltaY > Math.abs(deltaX))) {
                isTrackingClose = false;
                return;
            }

            // Trigger closing when threshold reached
            if (deltaX <= -SWIPE_MIN_DISTANCE && Math.abs(deltaX) > deltaY * 1.2) {
                const fileMenu = document.getElementById('fileMenu');
                if (fileMenu) {
                    if (window.bootstrap?.Offcanvas) {
                        window.bootstrap.Offcanvas.getOrCreateInstance(fileMenu).hide();
                    } else {
                        fileMenu.querySelector('.btn-close')?.click();
                    }
                }
                isTrackingClose = false;
            }
        }
    }, { passive: true });

    window.addEventListener('touchend', () => {
        isTrackingOpen = false;
        isTrackingClose = false;
    }, { passive: true });

    window.addEventListener('touchcancel', () => {
        isTrackingOpen = false;
        isTrackingClose = false;
    }, { passive: true });
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
            let confirmingDelete = false;
            let resetConfirmTimer = null;
            deleteButton.addEventListener('click', () => {
                if (!confirmingDelete) {
                    confirmingDelete = true;
                    deleteButton.classList.add('text-danger');
                    deleteButton.innerHTML = '<i class="bi-exclamation-triangle-fill"></i>';
                    deleteButton.title = `Click again to confirm delete "${label}"`;
                    resetConfirmTimer = setTimeout(() => {
                        confirmingDelete = false;
                        deleteButton.classList.remove('text-danger');
                        deleteButton.innerHTML = '<i class="bi-trash"></i>';
                        deleteButton.title = `Delete ${label}`;
                    }, 3000);
                    return;
                }
                clearTimeout(resetConfirmTimer);
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

async function checkNativeOpenedFiles() {
    if (!window.__TAURI__?.core?.invoke) return false;

    // Listen for runtime file open events
    if (window.__TAURI__?.event?.listen) {
        window.__TAURI__.event.listen('app-open-file', async (event) => {
            const opened = event.payload;
            if (opened && opened.name && opened.data) {
                const blob = new Blob([new Uint8Array(opened.data)]);
                const file = new File([blob], opened.name, { type: blob.type || 'application/octet-stream' });
                await loadFile(file);
            }
        });
    }

    try {
        const opened = await window.__TAURI__.core.invoke('get_opened_file');
        if (opened && opened.name && opened.data) {
            const blob = new Blob([new Uint8Array(opened.data)]);
            const file = new File([blob], opened.name, { type: blob.type || 'application/octet-stream' });
            await loadFile(file);
            return true;
        }
    } catch (e) {
        console.warn('[Native Open] Failed to get opened file:', e);
    }

    return false;
}

// --- INITIALIZATION ---
window.addEventListener('DOMContentLoaded', async () => {
    // Debug: Always log that we're starting
    console.log('[App Init] DOMContentLoaded fired');
    console.log('[App Init] Current URL:', window.location.href);
    console.log('[App Init] Query string:', window.location.search);

    initIOSAudioUnlock();
    setupExportPDFButton();
    setupSaveToLibraryButton();
    setupAddToSetlistButton();
    setupSetlistNav(getCurrentFile);
    setupDrivePicker();
    setupSettings();
    setupPinchToZoom();
    setupExtensionSettings();
    initUpdater();
    initYouTubePlayer();
    initSynthPlayer();
    initSoundFontPanel();
    initMixerPanel();
    initAudioLatencyModal();
    wireModal('aboutModal', 'aboutModalBtn');
    initScoreOptionsPanel();
    initPdfBookmarksUI();
    initFretboard();
    initTuner();
    initUrlRouter();
    setupGlobalRewindButton();
    initTauriDownloadListener();
    initGamepadManager();
    initJamMode({ loadFile, getCurrentFile, recordFileToRecents });
    initToolsMenu();

    document.getElementById('topBarBackToLibraryBtn')?.addEventListener('click', () => {
        openLibraryModal('library');
    });

    document.getElementById('libraryToggleBtn')?.addEventListener('click', () => {
        if (isLibraryOpen() && getCurrentFile()) {
            closeLibraryModal();
        } else {
            openLibraryModal('library');
        }
    });

    let hasNativeFile = false;
    if (window.__TAURI__) {
        hasNativeFile = await checkNativeOpenedFiles();
    }

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

            if (testFile.toLowerCase().endsWith('.mtbackup')) {
                console.log('[Test Mode] Detected .mtbackup file! Opening backupModal restore test...');
                const { openBackupModal } = await import('./backupRestore.js');
                await openBackupModal('restore');
                const modal = document.getElementById('backupModal');
                if (modal && typeof modal._handleSelectedBackupFile === 'function') {
                    console.log('[Test Mode] Calling modal._handleSelectedBackupFile directly...');
                    await modal._handleSelectedBackupFile(file, 'Local Device');
                } else {
                    const fileInput = modal ? modal.querySelector('#restoreFileInput') : null;
                    if (fileInput) {
                        try {
                            const dt = new DataTransfer();
                            dt.items.add(file);
                            fileInput.files = dt.files;
                        } catch (_) {}
                        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
                console.log('[Test Mode] ✅ Test backup file dispatched to restore handler');
                if (urlParams.get('auto_execute') === '1') {
                    console.log('[Test Mode] auto_execute=1: waiting 1s then clicking restoreExecuteBtn...');
                    await new Promise(r => setTimeout(r, 1000));
                    const execBtn = modal ? modal.querySelector('#restoreExecuteBtn') : null;
                    if (execBtn) {
                        execBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
                        console.log('[Test Mode] Clicking restoreExecuteBtn...');
                        execBtn.click();
                    }
                }
                return;
            }

            // Load the file automatically
            console.log('[Test Mode] Calling loadFile...');
            await loadFile(file);
            console.log('[Test Mode] ✅ Test file loaded successfully');
            // A deep-link hash (e.g. #recents) should show over the loaded test file
            const testRoute = getRouteFromUrl();
            if (testRoute) {
                const { navigateToUrlRoute } = await import('./utils/urlRouter.js');
                await navigateToUrlRoute(testRoute, true);
            }
        } catch (error) {
            console.error('[Test Mode] ❌ Failed to load test file:', error);
            console.error('[Test Mode] Error stack:', error.stack);
            showToast(`Test mode error: Could not load tests/${testFile}\n${error.message}`, 'error');
            openLibraryModal('library');
        }
    } else if (!hasNativeFile) {
        const hash = window.location.hash || '';
        const isAuthRedirect = hash.includes('access_token=') || hash.includes('state=restore_backup') || hash.includes('state=backup_create') || hash.includes('state=open_');
        const driveModalEl = document.getElementById('driveModal');
        const driveModalOpen = driveModalEl && driveModalEl.style.display === 'flex';
        const route = getRouteFromUrl();
        if (!driveModalOpen && !isAuthRedirect && !route) {
            console.log('[Normal Mode] Opening Tab Library as default home page');
            openLibraryModal('library');
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
    setupMouseNavigation(getNavigationConfig);
    setupSystemBackNavigation(getNavigationConfig);
    setupViewModeToggles(pageModeRadio, continuousModeRadio, getNavigationConfig);
    setupTapClickNavigation(output, getNavigationConfig);
    setupPageScrubber(pageIndicator, getNavigationConfig);
});

// --- LOAD PDF ---
let pdfLoadingProcessing = null;
async function loadPDF(file) {
    if (currentProcessing) currentProcessing.aborted = true;
    const processing = { aborted: false };
    currentProcessing = processing;
    pdfLoadingProcessing = processing;
    pageIndicator.textContent = 'Loading…';
    
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
        startPage: file.startPage,
        endPage: file.endPage,
        abortSignal: processing,
        onPdfLoaded: (pdfDoc) => {
            setPdfDocument(file, pdfDoc, (targetPage) => {
                const isPageMode = pageModeRadio.checked;
                if (isPageMode) {
                    if (pages.length > 0) {
                        currentPageIndex = Math.max(0, Math.min(pages.length - 1, targetPage));
                        updatePageDisplay();
                        renderCurrentPage();
                        output.focus();
                    }
                } else {
                    scrollToPage(output, condensedCanvases, targetPage);
                    currentPageIndex = Math.max(0, Math.min(condensedCanvases.length - 1, targetPage));
                    updatePageDisplay();
                }
            });
        },
        onCanvasRendered: (canvas) => {
            if (processing.aborted) return;

            // Always check current mode at render time
            const isPageMode = pageModeRadio.checked;
            continuous = !isPageMode;
            
            if (isPageMode) {
                // Lay out only the first page while loading; full layout happens once at the end
                if (condensedCanvases.length > 1) return;
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

    // Finalize: compute the full page count once
    if (pdfLoadingProcessing === processing) pdfLoadingProcessing = null;
    if (processing.aborted) return;
    if (pageModeRadio.checked) {
        const oldIndex = currentPageIndex;
        clearOutput(output);
        const result = layoutPages(condensedCanvases, pages);
        pages = result.pages;
        currentPageIndex = oldIndex < pages.length ? oldIndex : result.newIndex;
        updatePageDisplay();
        renderCurrentPage();
        output.focus();
    } else {
        const scrollPercent = (output.scrollTop / (output.scrollHeight - output.clientHeight) * 100) || 0;
        pageIndicator.textContent = `${Math.round(scrollPercent)}%`;
    }
}

/**
 * Record a file in Recents / the library. Jam Mode songs are transient and skip this
 * until the user chooses "Save to Library".
 */
export function recordFileToRecents(file) {
    const buildRecentPayload = (primaryTuning, stringCount, tunings) => ({
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
        driveFileId: file.driveFileId || null,
        librarySongId: file.librarySongId || null,
        providerId: file.providerId || 'local',
        relativePath: file.relativePath || file.name,
        songTitle: file.librarySongTitle || file.songTitle || file.name.replace(/\.[^/.]+$/, ''),
        artist: file.artist || '',
        album: file.album || '',
        coverUrl: file.coverUrl || null,
        tuning: primaryTuning,
        stringCount: stringCount,
        tunings: tunings || [],
        preferredStringCount: file.preferredStringCount || null
    });

    detectFileMetadata(file, file.name).then(meta => {
        addRecentOpened(buildRecentPayload(meta.primaryTuning, meta.stringCount, meta.tunings)).then(recent => {
            if (recent?.librarySongId && !file.librarySongId) {
                file.librarySongId = recent.librarySongId;
                file.tabId = file.tabId || recent.tabId;
            }
        }).catch(() => {});
    }).catch(() => {
        const detectedTuning = inferTuningFromTextOrName(file.name);
        addRecentOpened(buildRecentPayload(detectedTuning, null, detectedTuning ? [detectedTuning] : [])).then(recent => {
            if (recent?.librarySongId && !file.librarySongId) {
                file.librarySongId = recent.librarySongId;
                file.tabId = file.tabId || recent.tabId;
            }
        }).catch(() => {});
    });
}

export async function loadFile(file, { hideMenu = true, keepMode = false } = {}) {
    if (hideMenu) {
        fileMenu.hide();
    }
    currentFile = file;
    refreshSetlistNav(file);
    closeLibraryModal(true);
    resetView();
    currentProcessing.aborted = true;
    currentProcessing = { aborted: false };
    
    // Update YouTube player metadata with filename
    updateSongForYouTube({ filename: file.name });
    
    if (!file.jamTransient) {
        recordFileToRecents(file);
    }

    // Show navigation controls for all supported file types
    navButtons.style.display = 'flex';
    modeButtons.style.display = 'flex';
    updateGlobalAudioControls();
    
    // Make output focusable and focus it for keyboard navigation
    output.tabIndex = 0;
    output.focus();
    
    // Apply default view mode based on file type preference
    const modeParam = new URLSearchParams(window.location.search).get('mode');
    if (keepMode && (pageModeRadio.checked || continuousModeRadio.checked)) {
        // Reload of the current file (resize, settings change): keep the user's chosen mode
    } else if (modeParam === 'page') {
        pageModeRadio.checked = true;
        continuousModeRadio.checked = false;
    } else if (modeParam === 'continuous' || modeParam === 'scroll') {
        continuousModeRadio.checked = true;
        pageModeRadio.checked = false;
    } else if (isFileType(file, ['gp', 'gp3', 'gp4', 'gp5', 'gpx'])) {
        const gpDefault = localStorage.getItem('gpDefaultView') || getDefaultView('gp');
        if (gpDefault === 'continuous') {
            continuousModeRadio.checked = true;
            pageModeRadio.checked = false;
        } else {
            pageModeRadio.checked = true;
            continuousModeRadio.checked = false;
        }
    } else if (isFileType(file, ['txt'])) {
        const txtDefault = localStorage.getItem('txtDefaultView') || getDefaultView('txt');
        continuousModeRadio.checked = txtDefault === 'continuous';
        pageModeRadio.checked = txtDefault !== 'continuous';
    } else if (isFileType(file, ['pdf'])) {
        const pdfDefault = localStorage.getItem('pdfDefaultView') || getDefaultView('pdf');
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
            showToast(error?.message || 'Unable to process this file.', 'error');
            return;
        } finally {
            hideProgress(progressContainer, progressBar);
        }
    }

    if (isFileType(file, ['pdf'])) {
        showScoreOptions('pdf');
        await loadPDF(fileToLoad);
    } else if (isFileType(file, ['gp', 'gp3', 'gp4', 'gp5', 'gpx'])) {
        showProgress(progressContainer, progressBar);
        await loadGP(fileToLoad, output, pageModeRadio, continuousModeRadio);
        hideProgress(progressContainer, progressBar);
    } else if (isFileType(file, ['txt'])) {
        showScoreOptions('txt');
        await loadText(fileToLoad, output, pageModeRadio, continuousModeRadio);
        hideProgress(progressContainer, progressBar);
    } else {
        hideScoreOptions();
        console.warn('Unsupported file type:', file.name.split('.').pop().toLowerCase());
        // Hide navigation controls for unsupported files
        navButtons.style.display = 'none';
        modeButtons.style.display = 'none';
    }
    window.dispatchEvent(new CustomEvent('majestictab:file-loaded', { detail: { file } }));
}

// --- RESET FUNCTION ---
function resetView() {
    if (currentProcessing) currentProcessing.aborted = true;

    // Reset file states
    condensedCanvases.length = 0;
    pages.length = 0;
    currentPageIndex = 0;
    gpState.reset();
    clearPdfBookmarks();

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
    // Remember the first canvas of the current page so we can stay on it after re-layout
    const anchorCanvas = pages[currentPageIndex]?.[0]?.canvas;
    const result = layoutPages(condensedCanvases, pages);
    pages = result.pages;
    let newIndex = result.newIndex;
    if (anchorCanvas) {
        const found = pages.findIndex(p => p.some(item => item.canvas === anchorCanvas));
        if (found >= 0) newIndex = found;
    }
    if (newIndex !== currentPageIndex) {
        currentPageIndex = newIndex;
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
    if (pdfLoadingProcessing && !pdfLoadingProcessing.aborted) {
        pageIndicator.textContent = 'Loading…';
        return;
    }
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
        setBookmarkCurrentPageIndex(currentPageIndex);
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
    const appWindow = window.__TAURI__?.window?.getCurrentWindow?.();
    const request = root.requestFullscreen || root.webkitRequestFullscreen;

    // The native macOS green button handles fullscreen on macOS.
    // Gamescope / Steam Deck Gaming Mode is dedicated fullscreen.
    // iOS is already a full-screen app shell without windowed mode.
    if (root.classList.contains('tauri-gamescope') || isIOSDevice() || (window.__TAURI__ && /Mac/i.test(navigator.platform))) {
        if (btn.parentElement) btn.parentElement.style.display = "none";
        return;
    }

    if (!request && !nativeImmersive && !appWindow) {
        if (btn.parentElement) btn.parentElement.style.display = "none";
        return;
    }

    const getFsState = async () => {
        if (nativeImmersive) return !!immersive;
        if (appWindow?.isFullscreen) {
            try { return await appWindow.isFullscreen(); } catch {}
        }
        return !!(document.fullscreenElement || document.webkitFullscreenElement);
    };

    const exit = () => (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    let wasMaximizedBeforeFullscreen = false;
    let lastFsState = false;

    btn.addEventListener("click", async () => {
        if (nativeImmersive) {
            immersive = !immersive;
            nativeImmersive.setImmersive(immersive);
            onChange();
            btn.blur();
            return;
        }
        if (appWindow?.isFullscreen && appWindow?.setFullscreen) {
            try {
                const current = await appWindow.isFullscreen();
                if (!current) {
                    let isMax = false;
                    try {
                        if (appWindow.isMaximized) {
                            isMax = await appWindow.isMaximized();
                        }
                    } catch {}
                    wasMaximizedBeforeFullscreen = isMax;
                    // On Windows, if an undecorated window is maximized when setFullscreen(true) is invoked,
                    // Tao / Win32 fails to clear the maximized work-area restriction, causing a ~40px offset
                    // that glitches over the taskbar area and prevents true fullscreen (Tauri #11788).
                    // Unmaximizing first allows the window to expand cleanly to the true monitor bounds.
                    if (isMax && appWindow.unmaximize) {
                        try {
                            await appWindow.unmaximize();
                            await new Promise(r => setTimeout(r, 60));
                        } catch (e) {
                            console.warn("Unmaximize before fullscreen failed:", e);
                        }
                    }
                    await appWindow.setFullscreen(true);
                } else {
                    await appWindow.setFullscreen(false);
                    if (wasMaximizedBeforeFullscreen && appWindow.maximize) {
                        await new Promise(r => setTimeout(r, 60));
                        try {
                            await appWindow.maximize();
                        } catch (e) {
                            console.warn("Restore maximize after fullscreen failed:", e);
                        }
                    }
                    wasMaximizedBeforeFullscreen = false;
                }
                onChange();
            } catch (err) {
                console.error("Tauri setFullscreen failed:", err);
            }
            btn.blur();
            return;
        }
        try {
            const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
            if (isFs) {
                const result = exit();
                if (result && result.catch) result.catch(err => console.error("Exit fullscreen failed:", err));
            } else {
                let result;
                try {
                    // navigationUI: "hide" instructs browsers and convertible/tablet devices (e.g. Lenovo Yoga)
                    // to hide browser & OS navigation bars rather than reserving space for them
                    result = request.call(root, { navigationUI: "hide" });
                } catch {
                    result = request.call(root);
                }
                if (result && result.catch) {
                    result.catch(() => {
                        try { request.call(root); } catch (e) { console.error("Fullscreen failed:", e); }
                    });
                }
            }
        } catch (err) {
            console.error("Fullscreen failed:", err);
        }
        btn.blur();
    });

    const onChange = async () => {
        const fs = await getFsState();
        icon.className = fs ? "bi-fullscreen-exit" : "bi-arrows-fullscreen";
        btn.title = fs ? "Exit Fullscreen" : "Enter Fullscreen";
        if (lastFsState && !fs && wasMaximizedBeforeFullscreen && appWindow?.maximize) {
            wasMaximizedBeforeFullscreen = false;
            try { await appWindow.maximize(); } catch {}
        }
        lastFsState = fs;
        if (typeof window.__syncWindowState === 'function') {
            window.__syncWindowState();
        }
    };

    window.addEventListener("resize", onChange);
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    onChange();
})();
