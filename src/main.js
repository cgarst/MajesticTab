// main.js
import { initScoreCursor } from './utils/scoreCursor.js';
import './utils/pointerFocus.js';
import './utils/functionKeyGuard.js';
import { processPDF } from './pdfProcessor/pdfProcessor.js';
import { canvasSize, getActiveLazy, disposeActiveLazy } from './pdfProcessor/lazyPages.js';
// @googleDrive:begin
import { setupDrivePicker, migrateGoogleAuth } from './googleDrive.js';
// @googleDrive:end
import { setupExportPDFButton } from './exportPdf.js';
import { setupSaveToLibraryButton } from './saveToLibrary.js';
import { setupEditableText } from './editableText.js';
import { setupSongPinButton } from './songPin.js';
import { setupAddToSetlistButton } from './setlistUi.js';
import { setupSetlistNav, refreshSetlistNav } from './setlistPlayer.js';
import { showLoadingCard, setLoadingProgress, hideLoadingCard } from './utils/loadingCard.js';
import { loadGP, renderGPPage, applyGpDisplayScale, gpState, nextGPPage, prevGPPage, layoutGPPages, applyGpNotationMode, syncGpNotationRadios, setGpLayoutMode } from './gpProcessor/gpHandler.js';
import { setGpDisplayScale, applySavedGpDisplayScale, setGpDensity, getGpDensity, applySavedGpDensity, updateAutoGpDensity, getGpNotationMode, getGpDisplayScalePercent, getDefaultGpDisplayScalePercent } from './gpProcessor/gpProcessor.js';
import { initPageStrip } from './utils/pageStrip.js';
import { initTextSync } from './textSync/textSync.js';
import { loadText, renderTextPage, textState, nextTextPage, prevTextPage, setTextLayoutMode, setPendingTextResume } from './textProcessor/textHandler.js';
import { getTextMaxScalePercent } from './textProcessor/textProcessor.js';
import { isFileType, showProgress, hideProgress } from './utils/fileHandlingUtils.js';
import { setupFirstPageNavigation, setupPrevNextNavigation, setupKeyboardNavigation, setupMouseNavigation, setupSystemBackNavigation, setupViewModeToggles, setupTapClickNavigation, setupGlobalRewindButton, updateGlobalAudioControls, handleGlobalBack } from './utils/navigationUtils.js';
import { getPagesPerView, setTextPagesPerView } from './utils/viewModeUtils.js';
import { clearOutput, updatePageIndicator, layoutPages, renderPage } from './utils/renderUtils.js';
import { enableContinuousScrollTracking, scrollToPage } from './utils/scrollUtils.js';
import { initYouTubePlayer, updateActiveSong } from './soundPlayer.js';
import { initAudioSyncUi } from './audioSync/audioSyncUi.js';
import { initAudioFilePlayer, updateSongForAudioFile } from './audioSync/audioFilePlayer.js';
import { initAddStems } from './audioSync/addStems.js';
import { initRealAudioController, updateSongForRealAudio } from './audioSync/realAudioController.js';
import { restoreDebugBackup } from './debugRestore.js';
import { initSoundFontPanel } from './gpProcessor/soundFontPanel.js';
import { initMixerPanel, wireModal, closeModal } from './gpProcessor/mixerPanel.js';
import { initAudioLatencyModal } from './gpProcessor/audioLatencyModal.js';
import { initMidiSynthUi, midiSynthIsFor } from './classtab/midiSynth.js';
import { initClasstabSongMenu } from './classtab/songMenu.js';
import { initSynthPlayer, synthPlayerState, playClick, initScoreOptionsPanel, showScoreOptions, hideScoreOptions, syncSynthTrackModeLabels, setKeepPlayerOnReset } from './gpProcessor/gpPlayer.js';
import { setPdfDocument, setBookmarkCurrentPageIndex, clearPdfBookmarks, initPdfBookmarksUI } from './pdfProcessor/pdfBookmarks.js';
import { initTheming } from './themeEngine.js';
import { initUpdater } from './updater.js';
import { initSecureStore } from './secureStore.js';
import { initSyncRecordStore } from './audioSync/syncRecordStore.js';
import { migrateS3Secret } from './s3Client.js';
import { openLibraryModal, closeLibraryModal, isLibraryOpen } from './libraryModal.js';
import { initTauriDownloadListener } from './tabDownloader.js';
import { addRecentOpened, updateRecentPosition, migrateCorruptedCustomContainers } from './libraryStore.js';
import { inferTuningFromTextOrName, detectFileMetadata, getInstrumentMode, setInstrumentMode, getDefaultGpStringCount, setDefaultGpStringCount } from './utils/tuningUtils.js';
import { initBackupRestore } from './backupRestore.js';
import { initSync } from './syncUi.js';
import { showToast } from './utils/toast.js';
import { initGamepadManager } from './utils/gamepadManager.js';
import { initJamMode } from './jam/jamManager.js';
import { applyPlatformDefaults, getDefaultView, getDefaultLandscapePageLayout } from './utils/platformUtils.js';
import { initIOSAudioUnlock, isIOSDevice } from './utils/iosAudioUnlock.js';
import { canQuitApp } from './utils/quitApp.js';
import { isTvMode } from './tvMode.js';
import { initFretboard } from './fretboard/fretboardController.js';
import { initTuner } from './tuner/tuner.js';
import { initMetronome } from './metronome/metronome.js';
import { initToolsMenu } from './utils/toolsMenu.js';
import { initReaderViewMenu } from './utils/readerViewMenu.js';
import { initGuitarMenu } from './utils/guitarMenu.js';
import { initSongTuningMenu } from './utils/songTuningMenu.js';
import { initPracticeMenu } from './utils/practiceMenu.js';
import { initFreeClick } from './utils/freeClick.js';
import { initReaderPanels } from './utils/readerPanels.js';
import { initBarRuler } from './gpProcessor/barRuler.js';
import { initScoreRecordingStrip } from './audioSync/scoreRecordingStrip.js';
import { initLooseFollow } from './audioSync/looseFollow.js';
import { initSettingsPage } from './utils/settingsPage.js';
import { initSlidingPills } from './utils/slidingPill.js';
import { initFloating } from './utils/floating.js';
import { initUrlRouter, getRouteFromUrl } from './utils/urlRouter.js';
import { initNativeTabBar, nativeChromeReady } from './nativeTabBar.js';
import { initFoldState } from './foldState.js';
import { initNarrowAlias } from './utils/narrowAlias.js';
import { initTabletopRows } from './utils/tabletopRows.js';
import { initTabletopLayout } from './utils/tabletopLayout.js';
import { initBookMode } from './utils/bookMode.js';
import { initLicenseText } from './utils/licenseText.js';

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
        // The system tab bar belongs to the library; starting it here (not when the library first renders) lets it hear
        // that a page with a score open wants none
        initNativeTabBar();
        // iPhone Duo: where the fold is and which way it runs, for tabletop and book layouts
        initFoldState();
    }
}
// Plain browser: ?fold=tabletop or ?fold=book drives the same layouts without the device
if (!window.__TAURI__ && new URLSearchParams(window.location.search).has('fold')) initFoldState();

// Tabletop (iPhone Duo): the phone reader's narrow-screen rules, switched on by the fold instead of the width
initNarrowAlias();
// Tabletop: page buttons beside play, Synth | Original in the song row
initTabletopRows();
// Tabletop: spare height shared equally between the rows of the controls half
initTabletopLayout();
// Book pose (iPhone Duo): Page mode with two pages, one per half, until the fold opens flat
initBookMode();

// The fold pose arrives after the window has its size (the window itself does not resize): lay the open file out again
window.addEventListener('foldchange', () => setTimeout(() => window.dispatchEvent(new Event('resize')), 350));

// The synth's audio died (iOS closed its AudioContext, which can never run again): reopening the song builds a new player
window.addEventListener('majestictab:synth-dead', () => {
    if (currentFile && isFileType(currentFile, ['gp', 'gp3', 'gp4', 'gp5', 'gpx']) && !document.body.classList.contains('library-view-active')) {
        loadFile(currentFile, { hideMenu: false, keepMode: true });
    }
});

// Handle window resizing 
let resizeTimeout;
window.addEventListener('resize', () => {
    // Debounce resize handling
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(async () => {
        const pageModeRadio = document.getElementById('pageModeRadio');
        const continuousModeRadio = document.getElementById('continuousModeRadio');
        const output = document.getElementById('output');
        
        const autoDensityChanged = getGpDensity() === 'auto' && updateAutoGpDensity();

        // Only re-render if we have a file loaded and the reader (not the library) is showing
        if (currentFile && pageModeRadio && output && !document.body.classList.contains('library-view-active')) {
            if (isFileType(currentFile, ['gp', 'gp3', 'gp4', 'gp5', 'gpx'])) {
                if (autoDensityChanged) {
                    if (applyGpDisplayScale(output, pageModeRadio.checked, continuousModeRadio)) {
                        return;
                    }
                }
            }
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
    root.classList.add('tauri-macos');
    const appWindow = window.__TAURI__.window?.getCurrentWindow?.();
    // Traffic lights are hidden in fullscreen, so revert to the standard layout then.
    let syncToken = 0;
    const syncTitleBarInset = async () => {
        const token = ++syncToken;
        let fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (!fs && appWindow) {
            try { fs = await appWindow.isFullscreen(); } catch {}
        }
        if (token === syncToken) {
            root.classList.toggle('window-fullscreen', fs);
            initNativeTabBar();
        }
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
    root.classList.add('tauri-windows');
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
        root.classList.toggle('window-fullscreen', fs);
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

// Prevent browser from opening dropped files as webpages outside drop targets,
// and open a dropped tab file straight away, without saving it to the library
window.addEventListener('dragover', (e) => {
    e.preventDefault();
}, false);

window.addEventListener('drop', async (e) => {
    // A specific drop target (library folder or album, Open file dropzone, backup restore) calls
    // preventDefault when it handles a drop. Everything else, anywhere in the UI, opens the file here.
    const claimed = e.defaultPrevented;
    e.preventDefault();
    if (claimed) return;

    const file = e.dataTransfer?.files?.[0];
    if (!file) return;

    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'mpak') {
        const { openLocalFile } = await import('./fileProviders.js');
        await openLocalFile(file);
        return;
    }
    const { SUPPORTED_TAB_EXTENSIONS } = await import('./utils/fileHandlingUtils.js');
    if (!SUPPORTED_TAB_EXTENSIONS.includes(ext)) return;

    await loadFile(file);
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
let lastScaleRange = { min: 50, max: 150, value: 80, capWord: '' };

export function syncGpSheetScale(nextValue) {
    const currentScale = Number.parseInt(nextValue, 10);
    // A text tab stops zooming where its widest line still fits the page, so nothing is cut off
    const cap = currentFile && isFileType(currentFile, ['txt']) ? getTextMaxScalePercent(!!pageModeRadio?.checked) : null;
    const max = cap ? Math.max(5, Math.min(150, cap)) : 150;
    const min = Math.min(50, max);
    const safeValue = Number.isFinite(currentScale) ? Math.min(max, Math.max(min, currentScale)) : Math.min(max, getDefaultGpDisplayScalePercent());
    const input = document.getElementById('gpSheetScale');
    if (input) { input.max = String(max); input.min = String(min); }
    const valueEl = document.getElementById('gpSheetScaleValue');
    if (input) input.value = String(safeValue);
    const atMax = safeValue >= max;
    const atMin = safeValue <= min;
    const capWord = atMax ? 'Max' : atMin ? 'Min' : '';
    if (valueEl) {
        valueEl.textContent = capWord ? `${safeValue}% \u00b7 ${capWord}` : `${safeValue}%`;
        valueEl.dataset.cap = capWord.toLowerCase();
    }
    if (input) input.dataset.cap = capWord.toLowerCase();
    lastScaleRange = { min, max, value: safeValue, capWord };
    return safeValue;
}

document.addEventListener('change', (e) => {
    if (e.target === pageModeRadio || e.target === continuousModeRadio) syncGpSheetScale(getGpDisplayScalePercent());
});

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

export async function applyGpDensity(density) {
    const safe = setGpDensity(density);
    const radio = document.getElementById(`gpDensity${safe[0].toUpperCase()}${safe.slice(1)}`);
    if (radio) radio.checked = true;
    if (currentFile && isFileType(currentFile, ['gp', 'gp3', 'gp4', 'gp5', 'gpx'])) {
        if (!applyGpDisplayScale(output, pageModeRadio?.checked, continuousModeRadio)) {
            await loadFile(currentFile, { hideMenu: false, keepMode: true });
        }
    }
    return safe;
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
        if (isLibraryOpen() || document.querySelector('.modal.show')) return true;
        if (e && e.target && e.target.closest && e.target.closest('.modal, input, textarea, select')) return true;
        return false;
    };

    // Live readout that mirrors the Size slider. It is drawn from the gesture value
    // right away, so it does not wait for the re-render to finish.
    let readoutEl = null;
    let readoutTimer = null;
    const showReadout = () => {
        if (!readoutEl) {
            readoutEl = document.createElement('div');
            readoutEl.id = 'pinchScaleReadout';
            readoutEl.setAttribute('role', 'status');
            readoutEl.innerHTML = '<span class="pinch-scale-label">Tab size</span><span class="pinch-scale-track"><span class="pinch-scale-fill"></span></span><span class="pinch-scale-value"></span>';
            document.body.appendChild(readoutEl);
        }
        const { min, max, value, capWord } = lastScaleRange;
        const span = Math.max(1, max - min);
        readoutEl.querySelector('.pinch-scale-fill').style.transform = `scaleX(${(value - min) / span})`;
        readoutEl.querySelector('.pinch-scale-value').textContent = capWord ? `${value}% \u00b7 ${capWord}` : `${value}%`;
        readoutEl.dataset.cap = capWord.toLowerCase();
        readoutEl.classList.add('is-shown');
        clearTimeout(readoutTimer);
        readoutTimer = setTimeout(() => readoutEl.classList.remove('is-shown'), 1200);
    };

    const commitScale = (requested) => {
        const previous = latestTargetScale ?? getGpDisplayScalePercent();
        const targetPercent = syncGpSheetScale(requested);
        showReadout();
        if (targetPercent === previous) return;
        latestTargetScale = targetPercent;
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
            commitScale(targetPercent);
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
            commitScale(targetPercent);
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
            commitScale(nextPercent);
        }
    }, { passive: false });
}


// --- SETTINGS MANAGEMENT ---
function setupSettings() {
    // Apply platform defaults on initial launch/install (e.g. Steam Deck defaults to Page view and 1-page landscape)
    applyPlatformDefaults();

    // Load settings from localStorage
    // The PDF debug overlay is for debug builds only: off until the build is known to be one
    import('./utils/debugBuild.js').then((m) => m.applyDebugOverlaySetting());

    // Load condense mode settings with different defaults
    const savedCondensePdfMode = localStorage.getItem('condensePdfMode');

    // Apply saved settings
    debugMode.checked = false;
    // Default: Condense PDFs off by default (false)
    condensePdfMode.checked = savedCondensePdfMode === null ? false : savedCondensePdfMode === 'true';

    const gpSheetScaleInput = document.getElementById('gpSheetScale');
    const gpSheetScaleMinus = document.getElementById('gpSheetScaleMinus');
    const gpSheetScalePlus = document.getElementById('gpSheetScalePlus');
    const savedGpSheetScale = applySavedGpDisplayScale();
    syncGpSheetScale(savedGpSheetScale);

    const savedDensity = applySavedGpDensity();
    const savedDensityRadio = document.getElementById(`gpDensity${savedDensity[0].toUpperCase()}${savedDensity.slice(1)}`);
    if (savedDensityRadio) savedDensityRadio.checked = true;
    document.querySelectorAll('input[name="gpDensityRadio"]').forEach((r) => {
        r.addEventListener('change', () => { if (r.checked) applyGpDensity(r.value); });
    });

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
    
    // Initialize modern theme engine
    initTheming();

    initScoreCursor();

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

    document.getElementById('bulkExportBtn')?.addEventListener('click', async () => {
        const { openToolOnNextRender } = await import('./utils/toolsPage.js');
        const { switchView } = await import('./libraryModal.js');
        openToolOnNextRender('bulkexport');
        await switchView('tools');
    });

    // Initialize Backup & Restore
    initBackupRestore();
    initSync();

    // Quit button in Settings > About: native desktop apps only (Windows, macOS, Linux), never Android, iOS or the web
    if (canQuitApp()) {
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
}

async function fetchUrlResponse(url) {
    if (window.__TAURI__?.http?.fetch) {
        return window.__TAURI__.http.fetch(url);
    }
    return fetch(url);
}

async function handleAppOpenUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    let parsed;
    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        return false;
    }
    if (parsed.protocol !== 'majestictab:') return false;

    const singleUrl = parsed.searchParams.get('url');
    if (singleUrl) {
        const { openTabFromUrl } = await import('./fileProviders.js');
        await openTabFromUrl(singleUrl);
        return true;
    }

    const batchManifestUrl = parsed.searchParams.get('batch');
    if (batchManifestUrl) {
        const { showToast } = await import('./utils/toast.js');
        const { saveMpakToLibrary } = await import('./mpak.js');
        try {
            showToast('Fetching batch manifest…', 'info', 2500);
            const res = await fetchUrlResponse(batchManifestUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
            if (!items.length) {
                showToast('No tabs ready in that batch.', 'info');
                return true;
            }
            let added = 0;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (!item?.mpakUrl) continue;
                showToast(`Syncing ${i + 1} of ${items.length} tabs…`, 'info', 2000);
                try {
                    const mpakRes = await fetchUrlResponse(item.mpakUrl);
                    if (!mpakRes.ok) continue;
                    const buf = await mpakRes.arrayBuffer();
                    const name = item.fileName || `${item.artist || 'Song'} - ${item.title || i + 1}.mpak`;
                    const file = new File([buf], name, { type: 'application/x-majestictab-song' });
                    await saveMpakToLibrary(file, {
                        targetSongId: item.songId || null,
                        queryMusicBrainz: true
                    });
                    added++;
                } catch (e) {
                    console.warn('[App Open URL] Batch item failed:', item.mpakUrl, e);
                }
            }
            if (added > 0) {
                window.dispatchEvent(new CustomEvent('libraryDataChanged'));
                showToast(`Synced ${added} ${added === 1 ? 'tab' : 'tabs'} to your library`, 'success');
            } else {
                showToast('Could not sync any tabs from that batch.', 'warning');
            }
        } catch (err) {
            showToast(err?.message || 'Could not sync batch.', 'error');
        }
        return true;
    }
    return false;
}

function androidMpakSource(meta) {
    return {
        name: meta.name,
        size: meta.size,
        slice(start = 0, end = meta.size) {
            const len = Math.max(0, Math.min(end, meta.size) - start);
            return {
                async arrayBuffer() {
                    if (!len) return new ArrayBuffer(0);
                    const b64 = window.AndroidOpen?.readOpenedMpakRange?.(start, len);
                    if (!b64) throw new Error('Could not read the song file');
                    const bin = atob(b64);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    return bytes.buffer;
                }
            };
        }
    };
}

async function openAndroidMpakMeta(metaJson) {
    if (!metaJson) return false;
    try {
        const meta = typeof metaJson === 'string' ? JSON.parse(metaJson) : metaJson;
        if (!meta?.name || !meta?.size) return false;
        const { openMpak } = await import('./mpak.js');
        await openMpak(androidMpakSource(meta));
        return true;
    } catch (err) {
        const { showToast } = await import('./utils/toast.js');
        showToast(err?.message || 'Could not open that song file', 'error');
        return false;
    }
}

async function checkNativeOpenedFiles() {
    if (typeof window !== 'undefined') {
        window.__onAppOpenUrl = (url) => { handleAppOpenUrl(url); };
        window.__onAndroidOpenMpak = (meta) => { openAndroidMpakMeta(meta); };
    }

    if (window.AndroidOpen) {
        try {
            const pendingUrl = window.AndroidOpen.takePendingUrl?.();
            if (pendingUrl && await handleAppOpenUrl(pendingUrl)) return true;
            const pendingMpak = window.AndroidOpen.takePendingMpak?.();
            if (pendingMpak && await openAndroidMpakMeta(pendingMpak)) return true;
        } catch (e) {
            console.warn('[Native Open] Android pending intent check failed:', e);
        }
    }

    if (!window.__TAURI__?.core?.invoke) return false;

    // Listen for runtime file and URL open events
    if (window.__TAURI__?.event?.listen) {
        window.__TAURI__.event.listen('app-open-file', async (event) => {
            const opened = event.payload;
            await openNativePayload(opened);
        });
        window.__TAURI__.event.listen('app-open-url', async (event) => {
            await handleAppOpenUrl(event.payload);
        });
    }

    try {
        const openedUrl = await window.__TAURI__.core.invoke('get_opened_url');
        if (openedUrl && await handleAppOpenUrl(openedUrl)) return true;
    } catch (e) {
        console.warn('[Native Open] Failed to get opened URL:', e);
    }

    try {
        const opened = await window.__TAURI__.core.invoke('get_opened_file');
        if (await openNativePayload(opened)) return true;
    } catch (e) {
        console.warn('[Native Open] Failed to get opened file:', e);
    }

    return false;
}

// A file the operating system handed to the app: a song bundle opens with its recordings, anything else is a tab
// Rust hands over a tab's bytes, but only the path and size of a song bundle (see read_opened_file_range)
async function openNativePayload(opened) {
    if (!opened?.name) return false;
    if (opened.path && /\.mpak$/i.test(opened.name)) {
        try {
            const { openMpak, nativeMpakSource } = await import('./mpak.js');
            await openMpak(nativeMpakSource(opened));
        } catch (err) {
            const { showToast } = await import('./utils/toast.js');
            showToast(err?.message || 'Could not open that song file', 'error');
        }
        return true;
    }
    if (!opened.data) return false;
    const blob = new Blob([new Uint8Array(opened.data)]);
    await loadFile(new File([blob], opened.name, { type: blob.type || 'application/octet-stream' }));
    return true;
}

// --- INITIALIZATION ---
async function initAppInner() {
    // Debug: Always log that we're starting
    console.log('[App Init] DOMContentLoaded fired');
    console.log('[App Init] Current URL:', window.location.href);
    console.log('[App Init] Query string:', window.location.search);

    // Detects the keychain only; secrets are read on first use so the OS password prompt isn't shown at launch
    await initSecureStore();
    await initSyncRecordStore(); // sync points live in IndexedDB: load them before anything reads them
    migrateS3Secret();
    // @googleDrive:begin
    migrateGoogleAuth();
    // @googleDrive:end
    migrateCorruptedCustomContainers().catch(console.warn);

    initIOSAudioUnlock();
    setupExportPDFButton();
    setupSaveToLibraryButton();
    setupEditableText();
    setupSongPinButton();
    setupAddToSetlistButton();
    setupSetlistNav(getCurrentFile);
    // @googleDrive:begin
    setupDrivePicker();
    // @googleDrive:end
    setupSettings();
    setupPinchToZoom();
    initUpdater();
    initYouTubePlayer();
    initAudioSyncUi();
    initAudioFilePlayer();
    initAddStems();
    initRealAudioController();
    import('./audioSync/libraryAudio.js').then((m) => m.adoptAllUnassignedAudio()).catch(() => {});
    initSynthPlayer();
    initMidiSynthUi(getCurrentFile);
    initClasstabSongMenu(getCurrentFile);
    // A pack opened from a file keeps its data only while it is open: remove what an earlier session left, and what this one
    // leaves when the page closes
    import('./mpakSession.js').then((m) => {
        m.clearPackStorage();
        window.addEventListener('pagehide', () => { const id = getCurrentFile()?.mpakPackId; if (id) m.clearPackStorage(id); });
    }).catch(() => {});
    initSoundFontPanel();
    initMixerPanel();
    initAudioLatencyModal();
    wireModal('aboutModal', 'aboutModalBtn');
    initLicenseText();
    initScoreOptionsPanel();
    initPdfBookmarksUI();
    initFretboard();
    initTuner();
    initMetronome();
    initUrlRouter();
    setupGlobalRewindButton();
    initTauriDownloadListener();
    initGamepadManager();
    initJamMode({ loadFile, getCurrentFile, recordFileToRecents });
    initToolsMenu();
    initReaderViewMenu();
    initGuitarMenu();
    initSongTuningMenu();
    initFreeClick({ playClick, isMetronomeOn: () => synthPlayerState.metronomeEnabled, isCountInOn: () => synthPlayerState.countInEnabled });
    initPracticeMenu();
    initReaderPanels();
    initBarRuler();
    initScoreRecordingStrip();
    initLooseFollow();
    initSettingsPage();
    initSlidingPills();
    initFloating();

    document.getElementById('topBarBackToLibraryBtn')?.addEventListener('click', async () => {
        // A song opened from a tool in Tools goes back to that tool, not to the library
        const { hasResumeTool } = await import('./utils/toolsPage.js');
        openLibraryModal(hasResumeTool() ? 'tools' : 'library');
    });

    document.getElementById('libraryToggleBtn')?.addEventListener('click', () => {
        if (isLibraryOpen() && getCurrentFile()) {
            closeLibraryModal();
        } else {
            openLibraryModal('library');
        }
    });

    // Dev builds started with run.sh --restore-backup restore it before the library opens
    if (window.__TAURI__) await restoreDebugBackup();

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
            // test_base lets a native build (which doesn't bundle tests/) fetch fixtures from a dev server,
            // over `adb reverse`. Loopback only.
            const testBase = urlParams.get('test_base');
            let response;
            if (testBase && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(testBase)) {
                response = await fetch(`${testBase}${encodeURIComponent(testFile)}`);
            } else {
                response = await fetch(`tests/${testFile}`);
                if (!response.ok) {
                    response = await fetch(`../tests/${testFile}`);
                }
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
        const route = getRouteFromUrl();
        if (!isAuthRedirect && !route && !document.documentElement.classList.contains('jam-web-guest')) {
            console.log('[Normal Mode] Opening Tab Library as default home page');
            bootRender = openLibraryModal('library');
        }
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

    if (firstBtn) setupFirstPageNavigation(firstBtn, getNavigationConfig);
    setupPrevNextNavigation(prevBtn, nextBtn, getNavigationConfig);
    setupKeyboardNavigation(getNavigationConfig);
    setupMouseNavigation(getNavigationConfig);
    setupSystemBackNavigation(getNavigationConfig);
    setupViewModeToggles(pageModeRadio, continuousModeRadio, getNavigationConfig);
    setupTapClickNavigation(output, getNavigationConfig);
    initPageStrip(getNavigationConfig);
    initTextSync({ getConfig: getNavigationConfig, getCurrentFile });
}

let bootRender = null;

// The boot screen in index.html stays up until the library (or the opened file) is on screen
async function initApp() {
    try {
        await initAppInner();
        await bootRender;
        // The native rail and search field set the page's room once they are up: wait, so nothing moves after the boot screen goes
        await nativeChromeReady();
    } catch (error) {
        console.error('[App Init] failed:', error);
    } finally {
        const splash = document.getElementById('bootSplash');
        if (splash) {
            splash.classList.add('boot-done');
            setTimeout(() => splash.remove(), 200);
        }
    }
}

// Modules with top-level await (channel.js) can finish evaluating after DOMContentLoaded has fired.
if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// --- LOAD PDF ---
let pdfLoadingProcessing = null;
async function loadPDF(file) {
    if (currentProcessing) currentProcessing.aborted = true;
    const processing = { aborted: false };
    currentProcessing = processing;
    pdfLoadingProcessing = processing;
    pageIndicator.textContent = 'Loading…';
    
    // The loading card (same as Guitar Pro files) shows the progress
    const loadingToken = showLoadingCard(output, {
        title: file.librarySongTitle || file.songTitle || file.tabName || (file.name || '').replace(/\.[^/.]+$/, ''),
        subtitle: file.artist || '',
        coverUrl: file.coverUrl || '',
        stage: 'Reading file…'
    });
    try {
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
    const lazyPages = await processPDF(file, {
        debugMode: { checked: debugMode.checked },
        onLazyChange: () => scheduleLazyRelayout(),
        originalMode: { checked: !condensePdfMode.checked },
        onProgress: (pct, stage) => setLoadingProgress(loadingToken, pct, stage),
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
                            appendContinuousCanvas(canvas);
                            updatePageDisplay();
                        }
                        canvas._appendScheduled = false;
                    }, 0);
                }
            }
        }
    });
    
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
        if (lazyPages) {
            // Long PDFs come as placeholders: show them all, and process the ones that scroll into view
            condensedCanvases.forEach(appendContinuousCanvas);
            lazyPages.observe(output);
        }
        const scrollPercent = (output.scrollTop / (output.scrollHeight - output.clientHeight) * 100) || 0;
        pageIndicator.textContent = `${Math.round(scrollPercent)}%`;
    }
    if (pendingPdfResume) {
        const resume = pendingPdfResume;
        pendingPdfResume = null;
        if (pageModeRadio.checked) {
            if (pages.length > 0) {
                currentPageIndex = Math.max(0, Math.min(pages.length - 1, (resume.page || 1) - 1));
                renderCurrentPage();
                output.focus();
            }
        } else {
            const maxScroll = output.scrollHeight - output.clientHeight;
            if (typeof resume.scrollRatio === 'number' && maxScroll > 0) {
                output.scrollTop = Math.max(0, Math.min(1, resume.scrollRatio)) * maxScroll;
            } else if (resume.page > 1 && condensedCanvases.length > 0) {
                scrollToPage(output, condensedCanvases, resume.page - 1);
            }
            if (condensedCanvases.length > 0) {
                currentPageIndex = Math.max(0, Math.min(condensedCanvases.length - 1, (resume.page || 1) - 1));
            }
        }
        updatePageDisplay();
    } else if (pages.length > 0 || condensedCanvases.length > 0) {
        savePdfReadingPosition(true);
    }
    setLoadingProgress(loadingToken, 100, 'Ready');
    } finally {
        // Let the freshly laid-out pages paint before the card fades out
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        hideLoadingCard(loadingToken, output);
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
        standalone: Boolean(file.mpakStandalone),
        providerId: file.providerId || 'local',
        relativePath: file.relativePath || file.name,
        songTitle: file.librarySongTitle || file.songTitle || file.name.replace(/\.[^/.]+$/, ''),
        artist: file.artist || '',
        album: file.album || '',
        coverUrl: file.coverUrl || null,
        tuning: primaryTuning,
        stringCount: stringCount,
        tunings: tunings || [],
        hiddenTunings: Array.isArray(file.hiddenTunings) ? file.hiddenTunings : [],
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
    // The pack that was open is closed when another file replaces it: its temporary storage goes
    const closedPack = currentFile?.mpakPackId && currentFile.mpakPackId !== file.mpakPackId ? currentFile.mpakPackId : null;
    currentFile = file;
    if (!file.addedAt) {
        file.addedAt = file.lastModified || Date.now();
    }
    if (!file.providerId && file.sourceUrl) {
        file.providerId = 'url';
    }
    refreshSetlistNav(file);
    closeLibraryModal(true);
    // Re-laying out the same tab (resize, reader mode, rotation) must not stop its MIDI synth
    setKeepPlayerOnReset(midiSynthIsFor(file));
    try { resetView(); } finally { setKeepPlayerOnReset(false); }
    currentProcessing.aborted = true;
    currentProcessing = { aborted: false };
    
    // Update YouTube player metadata with filename
    updateActiveSong({
        filename: file.name,
        scoreTitle: file.songTitle || '',
        scoreArtist: file.songTitle ? (file.artist || '') : '',
        librarySongId: file.librarySongId,
        packId: file.mpakPackId || null,
        tabName: file.tabName || file.name,
        sourceWebsite: file.sourceWebsite || null,
        sourceUrl: file.sourceUrl || null
    });
    updateSongForAudioFile();
    updateSongForRealAudio();
    if (closedPack) import('./mpakSession.js').then((m) => m.clearPackStorage(closedPack)).catch(() => {});
    
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
        setGpLayoutMode(gpDefault === 'horizontal' ? 'horizontal' : 'vertical');
        if (gpDefault === 'continuous' || gpDefault === 'horizontal') {
            continuousModeRadio.checked = true;
            pageModeRadio.checked = false;
        } else {
            pageModeRadio.checked = true;
            continuousModeRadio.checked = false;
        }
    } else if (isFileType(file, ['txt'])) {
        const txtDefault = localStorage.getItem('txtDefaultView') || getDefaultView('txt');
        const txtScroll = txtDefault === 'continuous' || txtDefault === 'horizontal';
        setTextLayoutMode(txtDefault === 'horizontal' ? 'horizontal' : 'vertical');
        continuousModeRadio.checked = txtScroll;
        pageModeRadio.checked = !txtScroll;
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

    const fileToLoad = file;
    setTextPagesPerView(null); // only a text tab sets its own count

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
    syncGpSheetScale(getGpDisplayScalePercent()); // the zoom control's range follows the file just opened
    window.dispatchEvent(new CustomEvent('majestictab:file-loaded', { detail: { file, converted: fileToLoad } }));
}

// --- RESET FUNCTION ---
function resetView() {
    if (currentProcessing) currentProcessing.aborted = true;
    disposeActiveLazy();

    // Reset file states
    condensedCanvases.length = 0;
    pages.length = 0;
    currentPageIndex = 0;
    lastSavedPdfKey = '';
    lastPdfSaveAt = 0;
    gpState.reset();
    textState.reset();
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
    renderPage(output, pages, currentPageIndex, updatePageDisplay, (index) => { currentPageIndex = index; updatePageDisplay(); });
    requestLazyPagesForView();
}

// Long PDFs: process the pages on screen and a few ahead of the reader
function requestLazyPagesForView() {
    const lazy = getActiveLazy();
    if (!lazy || !pageModeRadio.checked) return;
    let first = Infinity;
    let last = -1;
    const perView = getPagesPerView('pdf');
    for (let i = 0; i < perView; i++) {
        const set = pages[currentPageIndex + i];
        if (!set) break;
        for (const item of set) {
            const idx = item.canvas._lazy?.index;
            if (idx == null) continue;
            first = Math.min(first, idx);
            last = Math.max(last, idx);
        }
    }
    if (last < 0) return;
    lazy.setWindow(first - 2, last + 5, first);
}

// Processed pages come out a different size than their placeholders, so the page layout is redone, staying on the
// page the reader is on
let lazyRelayoutTimer = null;
function scheduleLazyRelayout() {
    if (lazyRelayoutTimer) return;
    lazyRelayoutTimer = setTimeout(() => {
        lazyRelayoutTimer = null;
        if (pageModeRadio.checked && getActiveLazy()) doLayoutPages();
    }, 120);
}

function appendContinuousCanvas(canvas) {
    const wrapper = document.createElement('div');
    wrapper.style.width = '100%';
    wrapper.style.textAlign = 'center';

    // Scale canvas to fit width
    const size = canvasSize(canvas);
    if (size.w) {
        const scale = output.clientWidth / size.w;
        canvas.style.width = `${size.w * scale}px`;
        canvas.style.height = 'auto';
    }

    wrapper.appendChild(canvas);
    output.appendChild(wrapper);
}

let pendingPdfResume = null;
let lastSavedPdfKey = '';
let lastPdfSaveAt = 0;

/** Records a page/scroll target to restore once the next PDF finishes loading. */
export function setPendingPdfResume(pos) {
    pendingPdfResume = pos ? { page: Number(pos.page) || 1, scrollRatio: typeof pos.scrollRatio === 'number' ? pos.scrollRatio : null } : null;
}

/** Clears any unconsumed PDF resume target. */
export function clearPendingPdfResume() {
    pendingPdfResume = null;
}

/** Saves the current PDF page/scroll position to the newest recent (throttled unless `force`). */
export function savePdfReadingPosition(force = false) {
    if (pdfLoadingProcessing && !pdfLoadingProcessing.aborted) return;
    if (!currentFile || !isFileType(currentFile, ['pdf'])) return;
    const total = pageModeRadio.checked ? pages.length : condensedCanvases.length;
    if (!total) return;
    const page = Math.max(1, Math.min(total, currentPageIndex + 1));
    const maxScroll = output.scrollHeight - output.clientHeight;
    const scrollRatio = !pageModeRadio.checked && maxScroll > 0
        ? Math.max(0, Math.min(1, output.scrollTop / maxScroll))
        : null;
    const key = `${page}/${total}/${scrollRatio !== null ? scrollRatio.toFixed(3) : ''}`;
    const now = Date.now();
    if (!force && (key === lastSavedPdfKey || now - lastPdfSaveAt < 1500)) return;
    if (force && key === lastSavedPdfKey) return;
    lastSavedPdfKey = key;
    lastPdfSaveAt = now;
    updateRecentPosition(page, total, { positionUnit: 'page', scrollRatio }).catch(() => {});
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
        savePdfReadingPosition();
    }
}

export function hideLoadingBar() {
    hideProgress(progressContainer, progressBar);
}


export function getCurrentFile() {
    return currentFile;
}

/**
 * Lays the open text tab out again from `file` (its new content) where the reader stands. Unlike loadFile it leaves the
 * player, the recording and the song's other state alone: only the text and its pages are redrawn.
 */
export async function refreshTextTab(file) {
    if (!currentFile || !isFileType(currentFile, ['txt'])) return false;
    const pageMode = Boolean(pageModeRadio?.checked);
    const maxScroll = output.scrollHeight - output.clientHeight;
    setPendingTextResume({
        page: pageMode ? textState.currentPageIndex + 1 : 1,
        scrollRatio: pageMode ? null : (maxScroll > 0 ? output.scrollTop / maxScroll : 0)
    });
    currentFile = file;
    await loadText(file, output, pageModeRadio, continuousModeRadio);
    return true;
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
    // The library view's stylesheet rule forces the pill visible, so also flag the root for it to honor.
    if (root.classList.contains('tauri-gamescope') || isTvMode() || isIOSDevice() || (window.__TAURI__ && /Mac/i.test(navigator.platform))) {
        if (btn.parentElement) btn.parentElement.style.display = "none";
        root.classList.add('fullscreen-unavailable');
        return;
    }

    if (!request && !nativeImmersive && !appWindow) {
        if (btn.parentElement) btn.parentElement.style.display = "none";
        root.classList.add('fullscreen-unavailable');
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
        const fsLabel = document.getElementById("fullscreenLabel");
        if (fsLabel) fsLabel.textContent = fs ? "Exit fullscreen" : "Fullscreen";
        btn.setAttribute("aria-pressed", fs ? "true" : "false");
        btn.classList.toggle("is-on", fs);
        const fsHint = document.getElementById("fullscreenHint");
        if (fsHint && /Mac/i.test(navigator.platform)) fsHint.textContent = "Command+Control+F";
        if (lastFsState && !fs && wasMaximizedBeforeFullscreen && appWindow?.maximize) {
            wasMaximizedBeforeFullscreen = false;
            try { await appWindow.maximize(); } catch {}
        }
        lastFsState = fs;
        if (typeof window.__syncWindowState === 'function') {
            window.__syncWindowState();
        }
    };

    // Alt+Enter toggles fullscreen on Windows and Linux (macOS uses the native fullscreen shortcut)
    window.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
        if (/Mac/i.test(navigator.platform)) return;
        e.preventDefault();
        btn.click();
    });

    window.addEventListener("resize", onChange);
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    onChange();
})();
