// navigationUtils.js
import { showToast } from './toast.js';
import { isIOSDevice } from './iosAudioUnlock.js';
import { scrollByViewport } from './scrollUtils.js';
import { switchToContinuous, switchToPageMode, getPagesPerView, isPhoneReader, phoneTapZone } from './viewModeUtils.js';
import { clearOutput } from './renderUtils.js';
import { playPauseSynth, pauseSynthPlayer, isSynthAvailable, isSynthPlaying, clearSynthHighlights, rewindSynth, rewindSynth10Seconds, toggleSynthNoGuitars, toggleMetronome, toggleCountIn, adjustPlaybackSpeed, toggleSynthPanel, toggleScoreOptionsPanel } from '../gpProcessor/gpPlayer.js';
import { gamepadManager } from './gamepadManager.js';
import { stepSetlist } from '../setlistPlayer.js';
import { isYouTubeAvailable, rewindYouTubeToBeginning, toggleYouTubePanel, getSongKey } from '../youtubePlayer.js';
import { songHasSyncPoints } from '../audioSync/syncStore.js';
import {
    isRealAudioAvailable, isRealAudioPlaying, playPauseRealAudio, rewindRealAudio10Seconds
} from '../audioSync/realAudioController.js';

// Navigation action constants
export const NavigationAction = {
    NEXT: 'NEXT',
    PREV: 'PREV',
    FIRST: 'FIRST',
    TOGGLE_VIEW_MODE: 'TOGGLE_VIEW_MODE'
};

/**
 * Core navigation function that handles all types of navigation
 * @param {Object} config Navigation configuration
 * @param {HTMLElement} config.output Output container element
 * @param {boolean} config.isNext True for next, false for previous
 * @param {boolean} config.pageModeChecked Whether page mode is active
 * @param {Object} config.gpState Guitar Pro state object
 * @param {Array} config.pages Array of pages (for PDF)
 * @param {number} config.currentPageIndex Current page index (for PDF)
 * @param {number} config.step Number of pages to move
 * @param {Function} config.renderPage Function to render PDF page
 * @param {Function} config.renderGPPage Function to render GP page
 * @param {Function} config.nextGPPage Function to go to next GP page
 * @param {Function} config.prevGPPage Function to go to previous GP page
 * @param {Function} config.continuousModeRadio Radio button for continuous mode
 * @returns {Object} New state {newPageIndex} if changed
 */
export function navigate(config) {
    const {
        output,
        isNext,
        pageModeChecked,
        gpState,
        pages,
        currentPageIndex,
        step = 1,
        renderGPPage,
        nextGPPage,
        prevGPPage,
        continuousModeRadio
    } = config;

    // Handle GP files
    if (gpState?.canvases[0]) {
        if (pageModeChecked) {
            const navigated = isNext ? nextGPPage?.(output) : prevGPPage?.(output);
            if (navigated && renderGPPage) {
                renderGPPage(output, pageModeChecked, continuousModeRadio);
            }
        } else {
            scrollByViewport(output, isNext);
        }
        return null;
    }

    // Handle text files
    if (config.textState?.pages?.length > 0 || config.textState?.fullContent) {
        if (pageModeChecked) {
            const navigated = isNext ? config.nextTextPage?.() : config.prevTextPage?.();
            if (navigated && config.renderTextPage) {
                config.renderTextPage(output, pageModeChecked);
            }
        } else {
            scrollByViewport(output, isNext);
        }
        return null;
    }

    // Handle PDFs
    if (pageModeChecked) {
        const currentPages = pages || config.getPages?.();
        const currentIdx = currentPageIndex || config.getCurrentPageIndex?.();
        
        if (!currentPages || !currentPages.length) return null;

        const newIndex = isNext 
            ? Math.min(currentIdx + step, Math.max(0, currentPages.length - getPagesPerView()))
            : Math.max(0, currentIdx - step);

        if (newIndex !== currentIdx) {
            return { newPageIndex: newIndex };
        }
    } else {
        scrollByViewport(output, isNext);
    }
    
    return null;
}

/**
 * Class to handle navigation state and actions
 */
export class NavigationHandler {
    constructor(config) {
        this.config = config;
    }

    /**
     * Process a navigation action
     * @param {string} action - The navigation action to perform
     * @returns {Object|null} New state if changed
     */
    handleAction(action) {
        const { config } = this;
        const isGP = config.gpState?.canvases[0];
        const isPageMode = config.pageModeChecked || config.pageModeRadio?.checked;

        switch (action) {
            case NavigationAction.NEXT:
            case NavigationAction.PREV:
                return navigate({
                    ...config,
                    isNext: action === NavigationAction.NEXT,
                    pageModeChecked: isPageMode
                });
            case NavigationAction.FIRST:
                return this._handleFirstPage();
            default:
                return null;
        }
    }

    _handleDirectionalNavigation(isNext) {
        const { config } = this;
        const isGP = config.gpState?.canvases[0];
        const isPageMode = config.pageModeChecked || config.pageModeRadio?.checked;

        if (isGP) {
            if (isPageMode) {
                if (isNext) config.nextGPPage(config.output);
                else config.prevGPPage(config.output);
                config.renderGPPage(config.output, isPageMode, config.continuousModeRadio);
            } else {
                scrollByViewport(config.output, isNext);
            }
            return null;
        }

        if (isPageMode) {
            const pages = config.pages || config.getPages?.();
            const currentPageIndex = config.currentPageIndex || config.getCurrentPageIndex?.();
            
            if (!pages || !pages.length) return null;

            const step = config.step || config.getPageStep?.() || 1;
            const newIndex = isNext 
                ? Math.min(currentPageIndex + step, Math.max(0, pages.length - getPagesPerView()))
                : Math.max(0, currentPageIndex - step);

            if (newIndex !== currentPageIndex) {
                return { newPageIndex: newIndex };
            }
        } else {
            scrollByViewport(config.output, isNext);
        }
        
        return null;
    }

    _handleFirstPage() {
        const { config } = this;
        const isGP = config.gpState?.canvases[0];
        const isPageMode = config.pageModeChecked || config.pageModeRadio?.checked;

        // Trigger rewind to beginning action for active/available audio players
        if (isSynthAvailable()) {
            rewindSynth();
        }
        if (isYouTubeAvailable()) {
            rewindYouTubeToBeginning();
        }

        if (isGP) {
            if (isPageMode) {
                config.gpState.currentPageIndex = 0;
                config.renderGPPage(config.output, isPageMode, config.continuousModeRadio);
            } else {
                config.output.scrollTo({ top: 0, behavior: 'smooth' });
            }
        } else {
            if (isPageMode) {
                return { newPageIndex: 0 };
            } else {
                config.output.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }
        return null;
    }
}



const PLAYBACK_SPEED_KEY_STEP = 5;

/**
 * Handle keyboard navigation
 * @param {Function} getConfig Function to get current navigation configuration
 */
export function setupKeyboardNavigation(getConfig) {
    // WebKitGTK and Chromium keep a button focused after it is clicked; WKWebView on macOS does not. A focused top bar
    // button counts as keyboard/gamepad navigation, so Space would activate it again (reopening the menu) instead of
    // toggling playback. Drop focus after real mouse and touch clicks (detail 0 marks keyboard and scripted clicks).
    document.addEventListener('click', (e) => {
        if (e.detail === 0) return;
        const control = e.target.closest?.('button, [role="button"], a.btn');
        if (control && document.activeElement === control) control.blur();
    });

    window.addEventListener('keydown', (e) => {
        const config = getConfig();

        const nextPageKeys = ['ArrowRight', 'ArrowDown', 'PageDown'];
        const prevPageKeys = ['ArrowLeft', 'ArrowUp', 'PageUp'];

        const isSpace = (e.key === ' ' || e.code === 'Space');
        const isB = (e.key === 'b' || e.key === 'B');
        // Remote and keyboard media keys act like Space; MediaPlay / MediaPause only do their half of the toggle
        const isMediaToggle = e.key === 'MediaPlayPause'
            || (e.key === 'MediaPlay' && !(isSynthPlaying() || isRealAudioPlaying()))
            || (e.key === 'MediaPause' && (isSynthPlaying() || isRealAudioPlaying()));

        // Avoid handling keys when focused on editable text elements
        const activeEl = document.activeElement;
        const isTextInput = activeEl && (
            (activeEl.tagName === 'INPUT' && !['radio', 'checkbox', 'button', 'submit', 'range'].includes(activeEl.type)) ||
            activeEl.tagName === 'TEXTAREA' ||
            activeEl.tagName === 'SELECT' ||
            activeEl.isContentEditable
        );

        const isSpatialMode = gamepadManager.isSpatialNavActive();

        if (isTextInput) {
            if (isSpatialMode && activeEl.tagName !== 'SELECT' && activeEl.tagName !== 'TEXTAREA') {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    gamepadManager.navigateSpatial(e.key === 'ArrowDown' ? 'down' : 'up');
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    activeEl.blur();
                    gamepadManager.clearNavFocus();
                    return;
                }
                if (e.key === 'Enter' && gamepadManager.openTvKeyboard(activeEl)) {
                    e.preventDefault();
                    return;
                }
                if (e.key === 'Enter' && !activeEl.closest('form')) {
                    e.preventDefault();
                    gamepadManager.navigateSpatial('down');
                    return;
                }
            }
            return;
        }

        // Back / Forward keyboard shortcuts (especially macOS mouse 4 / 5 translation: Cmd+[ and Cmd+], Alt+Left/Right, Cmd+Left/Right)
        const isMacBack = (e.metaKey && (e.key === '[' || e.code === 'BracketLeft')) || (e.altKey && e.key === 'ArrowLeft') || (e.metaKey && e.key === 'ArrowLeft');
        const isMacForward = (e.metaKey && (e.key === ']' || e.code === 'BracketRight')) || (e.altKey && e.key === 'ArrowRight') || (e.metaKey && e.key === 'ArrowRight');

        if (isMacBack) {
            e.preventDefault();
            performAppBack(getConfig);
            return;
        }

        if (isMacForward) {
            e.preventDefault();
            performAppForward(getConfig);
            return;
        }

        // R key toggles reading mode (hides the top and the playback controls)
        if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && !document.body.classList.contains('modal-open')) {
            e.preventDefault();
            gamepadManager.toggleTopBar();
            return;
        }

        // Spatial keyboard navigation when in Library or a Modal/Drawer/Dropdown
        if (isSpatialMode && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const arrowMap = {
                ArrowUp: 'up',
                ArrowDown: 'down',
                ArrowLeft: 'left',
                ArrowRight: 'right'
            };
            const dir = arrowMap[e.key];
            if (dir) {
                if (activeEl && activeEl.tagName === 'INPUT' && activeEl.type === 'range' && (dir === 'left' || dir === 'right')) {
                    return;
                }
                e.preventDefault();
                gamepadManager.navigateSpatial(dir);
                return;
            }
            // Space plays and pauses unless the user is navigating the interface (Tab, arrows, controller) or something
            // blocks the score. A synth or options panel left open does not: its buttons are not Space targets.
            const spaceIsPlayback = isSpace && !gamepadManager.lastInputWasNavigation
                && !gamepadManager.isLibraryViewOpen() && !gamepadManager.isBlockingOverlayOpen();
            if ((e.key === 'Enter' || isSpace) && !spaceIsPlayback) {
                if (!e.defaultPrevented) {
                    e.preventDefault();
                    gamepadManager.handleButtonA(gamepadManager.isLibraryViewOpen(), gamepadManager.isAnyModalOpen());
                }
                return;
            }
            if (e.key === 'Escape' || e.key === 'Backspace') {
                if (!e.defaultPrevented) {
                    if (performAppBack(getConfig)) {
                        e.preventDefault();
                    }
                }
                return;
            }
        }

        if (!config.currentFile) return;

        // B key rewinds audio playback by 10 seconds
        if (isB && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (isSynthAvailable() || isRealAudioAvailable() || isSynthPlaying() || isRealAudioPlaying()) {
                e.preventDefault();
                handleGlobalRewind10Seconds();
                return;
            }
        }

        // G key toggles the soundfont between full band and no guitars (no bass in bass mode)
        if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey && !e.altKey && isSynthAvailable()) {
            const mode = toggleSynthNoGuitars();
            if (mode) {
                e.preventDefault();
                const isBass = document.getElementById('synthTrackNoGuitarsLabel')?.textContent === 'No Bass';
                showToast(mode === 'noGuitars' ? (isBass ? 'No bass' : 'No guitars') : 'Full band', 'info', 1500, 'synth-track-mode');
                return;
            }
        }

        // M key toggles the metronome
        if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey && isSynthAvailable()) {
            e.preventDefault();
            toggleMetronome();
            return;
        }

        // C key toggles the count-in
        if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey && isSynthAvailable()) {
            e.preventDefault();
            toggleCountIn();
            return;
        }

        // [ and ] step to the previous / next tab of the open setlist
        if ((e.key === '[' || e.key === ']') && !e.ctrlKey && !e.metaKey && !e.altKey && config.currentFile.setlistId) {
            e.preventDefault();
            stepSetlist(e.key === ']' ? 1 : -1, config.currentFile);
            return;
        }

        // , and . slow down / speed up playback
        if ((e.key === ',' || e.key === '.') && !e.ctrlKey && !e.metaKey && !e.altKey && isSynthAvailable()) {
            e.preventDefault();
            const pct = adjustPlaybackSpeed(e.key === '.' ? PLAYBACK_SPEED_KEY_STEP : -PLAYBACK_SPEED_KEY_STEP);
            showToast(`Speed ${pct}%`, 'info', 1200, 'playback-speed');
            return;
        }

        // Prevent default browser scrolling and radio group switching for navigation and spacebar
        if (nextPageKeys.includes(e.key) || prevPageKeys.includes(e.key) || isSpace || isMediaToggle) {
            e.preventDefault();
        }

        // Spacebar and the media play/pause keys toggle playback
        if (isSpace || isMediaToggle) {
            // 1. If a player is playing, pause it; otherwise resume the last
            //    active/selected source (synth or recording), falling back to
            //    whichever is available
            if (isSynthPlaying() || isRealAudioPlaying() || isSynthAvailable() || isRealAudioAvailable()) {
                handleGlobalPlayPause();
                return;
            }

            // 2. If neither player is loaded (e.g. plain PDF), advance page
            const navigationHandler = new NavigationHandler(config);
            const result = navigationHandler.handleAction(NavigationAction.NEXT);
            if (result?.newPageIndex !== undefined && config.setCurrentPageIndex) {
                config.setCurrentPageIndex(result.newPageIndex);
            }
            return;
        }

        const isNext = nextPageKeys.includes(e.key);
        const isPrev = prevPageKeys.includes(e.key);

        if (isNext || isPrev) {
            // Up at the start of the score moves into the top bar
            const isPageMode = config.pageModeChecked || config.pageModeRadio?.checked;
            if (e.key === 'ArrowUp' && !isPageMode && gamepadManager.isScoreScrolledToTop() && gamepadManager.enterTopBar()) return;
            const pageSnapshot = document.getElementById('pageIndicator')?.textContent;
            const navigationHandler = new NavigationHandler(config);
            const action = isNext ? NavigationAction.NEXT : NavigationAction.PREV;
            const result = navigationHandler.handleAction(action);
            
            if (result?.newPageIndex !== undefined && config.setCurrentPageIndex) {
                config.setCurrentPageIndex(result.newPageIndex);
            }
            if (e.key === 'ArrowUp' && isPageMode) {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    if (document.getElementById('pageIndicator')?.textContent === pageSnapshot) gamepadManager.enterTopBar();
                }));
            }
        }
    });
}

/**
 * Unified application back handler across Android system back button, Mouse 4, and browser popstate
 * @param {Function|null} getConfig Function to get current navigation configuration
 * @returns {boolean} Whether a back action was performed
 */
export function performAppBack(getConfig = null) {
    // 0. If any Bootstrap dropdown or Tools menu is open, dismiss it first
    const openDropdownMenu = document.querySelector('.dropdown-menu.show');
    if (openDropdownMenu) {
        const toggle = openDropdownMenu.parentElement?.querySelector('[data-bs-toggle="dropdown"]');
        if (toggle && window.bootstrap?.Dropdown) {
            const inst = window.bootstrap.Dropdown.getInstance(toggle);
            if (inst) { inst.hide(); return true; }
        }
        if (toggle) { toggle.click(); return true; }
        openDropdownMenu.classList.remove('show');
        return true;
    }
    // Back from the top bar in the score view returns focus to the score
    if (gamepadManager.isTopBarFocused() && !gamepadManager.isLibraryViewOpen() && !gamepadManager.isAnyModalOpen()) {
        gamepadManager.exitTopBar();
        return true;
    }
    const toolsMenu = document.getElementById('toolsMenu');
    if (toolsMenu && (toolsMenu.style.display === 'block' || toolsMenu.style.display === 'flex' || toolsMenu.classList.contains('show'))) {
        document.getElementById('toolsMenuBtn')?.click();
        return true;
    }

    // 1. If any synth/score/youtube dropdown panels are open, dismiss them
    const openSynth = document.getElementById('synthDropdownPanel');
    if (openSynth && openSynth.style.display !== 'none') {
        toggleSynthPanel(false);
        return true;
    }
    const openScore = document.getElementById('scoreOptionsDropdownPanel');
    if (openScore && openScore.style.display !== 'none') {
        toggleScoreOptionsPanel(false);
        return true;
    }
    const openYt = document.getElementById('ytDropdownPanel');
    if (openYt && openYt.style.display !== 'none') {
        toggleYouTubePanel(false);
        return true;
    }

    // 2. If an open modal or offcanvas is present, dismiss it first
    const openBackdrops = Array.from(document.querySelectorAll('.theme-modal-backdrop')).filter(el => el.style.display === 'flex' || el.style.display === 'block');
    if (openBackdrops.length > 0) {
        const topModal = openBackdrops[openBackdrops.length - 1];
        const closeBtn = topModal.querySelector('.theme-modal-close-btn, .btn-close, [data-bs-dismiss="modal"]');
        if (closeBtn) {
            closeBtn.click();
            return true;
        }
        topModal.style.display = 'none';
        return true;
    }

    const openModal = document.querySelector('.modal.show');
    if (openModal) {
        const closeBtn = openModal.querySelector('[data-bs-dismiss="modal"], .btn-close, .theme-modal-close-btn');
        if (closeBtn) {
            closeBtn.click();
            return true;
        }
    }

    // 3. If Library Page is currently open
    const libPage = document.getElementById('libraryPage');
    const isLibOpen = libPage && libPage.style.display !== 'none';
    if (isLibOpen) {
        if (typeof window.__majesticLibraryCanGoBack === 'function' && window.__majesticLibraryCanGoBack()) {
            if (typeof window.__majesticLibraryBack === 'function') {
                window.__majesticLibraryBack();
                return true;
            }
        }
        const libBackBtn = document.getElementById('libBrowseBackBtn');
        if (libBackBtn && libBackBtn.offsetParent !== null && libBackBtn.style.display !== 'none') {
            libBackBtn.click();
            return true;
        }
        const libSearchBackBtn = document.getElementById('libSearchBackBtn');
        if (libSearchBackBtn && libSearchBackBtn.offsetParent !== null && libSearchBackBtn.style.display !== 'none') {
            libSearchBackBtn.click();
            return true;
        }
        if (window.returnToOpenSong?.()) return true;
        return false;
    }

    // 4. In Score View: return to library
    const backToLibBtn = document.getElementById('topBarBackToLibraryBtn');
    if (backToLibBtn && backToLibBtn.offsetParent !== null && backToLibBtn.style.display !== 'none') {
        backToLibBtn.click();
        return true;
    }

    // 5. In Score View fallback: navigate previous page if configured
    if (typeof getConfig === 'function') {
        const config = getConfig();
        if (config && config.currentFile) {
            const navigationHandler = new NavigationHandler(config);
            const result = navigationHandler.handleAction(NavigationAction.PREV);
            if (result?.newPageIndex !== undefined && config.setCurrentPageIndex) {
                config.setCurrentPageIndex(result.newPageIndex);
                return true;
            }
        }
    }

    return false;
}

/**
 * Perform global app back action (modals -> library navigation -> return to library)
 * @param {Function} [getConfig]
 */
export function handleGlobalBack(getConfig) {
    return performAppBack(getConfig);
}

/**
 * Unified application forward handler across Mouse 5, forward shortcuts, and browser popstate
 * @param {Function|null} getConfig Function to get current navigation configuration
 * @returns {boolean} Whether a forward action was performed
 */
export function performAppForward(getConfig = null) {
    // 1. If Library Page is currently open
    const libPage = document.getElementById('libraryPage');
    const isLibOpen = libPage && libPage.style.display !== 'none';
    if (isLibOpen) {
        if (typeof window.__majesticLibraryCanGoForward === 'function' && window.__majesticLibraryCanGoForward()) {
            if (typeof window.__majesticLibraryForward === 'function') {
                window.__majesticLibraryForward();
                return true;
            }
        }
        if (window.returnToOpenSong?.()) return true;
        return false;
    }

    // 2. In Score View: advance to next page
    if (typeof getConfig === 'function') {
        const config = getConfig();
        if (config && config.currentFile) {
            const navigationHandler = new NavigationHandler(config);
            const result = navigationHandler.handleAction(NavigationAction.NEXT);
            if (result?.newPageIndex !== undefined && config.setCurrentPageIndex) {
                config.setCurrentPageIndex(result.newPageIndex);
                return true;
            }
        }
    }

    return false;
}

/**
 * Handle system back button and gesture navigation (Android & popstate)
 * @param {Function} getConfig Function to get current navigation configuration
 */
export function setupSystemBackNavigation(getConfig) {
    let lastNavTime = 0;

    const handleBack = () => {
        const now = Date.now();
        if (now - lastNavTime < 180) return true;
        lastNavTime = now;
        return performAppBack(getConfig);
    };

    if (typeof window !== 'undefined' && window.history) {
        try {
            if (!window.history.state?.appNav) {
                window.history.replaceState({ appNav: true, depth: 0 }, '');
            }
            window.history.pushState({ appNav: true, depth: 1 }, '');
        } catch {}

        window.addEventListener('popstate', () => {
            // If the URL has an active route (library, recents, tuner, reference), let urlRouter handle it
            // The bottom guard entry (depth 0) must always be caught, otherwise a further
            // back gesture leaves the app (blank screen in an iOS PWA).
            const atBottom = window.history.state?.appNav && !window.history.state.depth;
            const rawHash = (window.location.hash || '').replace(/^#\/?/, '').trim();
            if (!atBottom && rawHash && ['library', 'recents', 'tuner', 'reference'].some(r => rawHash.startsWith(r))) {
                return;
            }
            const handled = handleBack();
            // Re-arm the guard entry so the next back gesture is also caught
            if (handled || !window.history.state?.depth) {
                try {
                    window.history.pushState({ appNav: true, depth: 1 }, '');
                } catch {}
            }
        });
    }

    if (typeof window !== 'undefined' && window.__TAURI__?.event) {
        window.__TAURI__.event.listen('tauri://back', handleBack).catch(() => {});
        window.__TAURI__.event.listen('tauri://back-button', handleBack).catch(() => {});
        window.__TAURI__.event.listen('android:back', handleBack).catch(() => {});
    }
}

/**
 * Handle mouse button navigation (Mouse 4 / Mouse 5) like a browser across native clients and web
 * @param {Function} getConfig Function to get current navigation configuration
 */
export function setupMouseNavigation(getConfig) {
    let lastNavTime = 0;

    const performBack = () => performAppBack(getConfig);
    const performForward = () => performAppForward(getConfig);

    const triggerNav = (isBack) => {
        // Avoid handling when focused on editable text elements
        const activeEl = document.activeElement;
        const isTextInput = activeEl && (
            (activeEl.tagName === 'INPUT' && !['radio', 'checkbox', 'button', 'submit', 'range'].includes(activeEl.type)) ||
            activeEl.tagName === 'TEXTAREA' ||
            activeEl.tagName === 'SELECT' ||
            activeEl.isContentEditable
        );
        if (isTextInput) return;

        const now = Date.now();
        if (now - lastNavTime < 220) return;
        lastNavTime = now;

        if (isBack) {
            performBack();
        } else {
            performForward();
        }
    };

    const handleMouseNav = (e) => {
        // e.button === 3: Browser Back (Mouse 4)
        // e.button === 4: Browser Forward (Mouse 5)
        const isBack = (e.button === 3);
        const isForward = (e.button === 4);
        if (!isBack && !isForward) return;

        e.preventDefault();
        triggerNav(isBack);
    };

    const preventMouseNavDefaults = (e) => {
        if (e.button === 3 || e.button === 4) {
            e.preventDefault();
        }
    };

    window.addEventListener('mousedown', handleMouseNav, true);
    window.addEventListener('pointerdown', handleMouseNav, true);
    window.addEventListener('mouseup', handleMouseNav, true);
    window.addEventListener('pointerup', preventMouseNavDefaults, true);
    window.addEventListener('auxclick', handleMouseNav, true);

    if (window.__TAURI__?.event?.listen) {
        window.__TAURI__.event.listen('mouse-nav-back', () => triggerNav(true)).catch(() => {});
        window.__TAURI__.event.listen('mouse-nav-forward', () => triggerNav(false)).catch(() => {});
    }
}

/**
 * Two-finger trackpad swipe back/forward for the native macOS app. WKWebView ships with
 * history swipe gestures off and never fires popstate for them, so read the horizontal
 * wheel deltas directly. (Browsers handle the swipe natively through popstate.)
 * @param {Function} getConfig Function to get current navigation configuration
 */
export function setupTrackpadSwipeNavigation() {
    // Swipe navigation gestures disabled
}

/**
 * Setup first page button navigation
 */
export function setupFirstPageNavigation(firstBtn, getConfig) {
    firstBtn.addEventListener('click', () => {
        const config = getConfig();
        if (!config.currentFile) return;

        const navigationHandler = new NavigationHandler(config);
        const result = navigationHandler.handleAction(NavigationAction.FIRST);
        
        if (result?.newPageIndex !== undefined) {
            config.setCurrentPageIndex(result.newPageIndex);
        }
    });
}

/**
 * Setup previous and next button navigation
 */
export function setupPrevNextNavigation(prevBtn, nextBtn, getConfig) {
    const setupButton = (button, action) => {
        button.addEventListener('click', () => {
            const config = getConfig();
            if (!config.currentFile) return;
            
            const navigationHandler = new NavigationHandler(config);
            const result = navigationHandler.handleAction(action);
            
            if (result?.newPageIndex !== undefined) {
                config.setCurrentPageIndex(result.newPageIndex);
            }
        });
    };

    setupButton(prevBtn, NavigationAction.PREV);
    setupButton(nextBtn, NavigationAction.NEXT);
}

/**
 * Setup view mode toggle handlers
 */
export function setupViewModeToggles(pageModeRadio, continuousModeRadio, getConfig) {
    const updateIndicator = (config, isPageMode) => {
        const indicator = document.getElementById('pageIndicator');
        if (!indicator || !config.output || !config.currentFile) return;

        if (isPageMode) {
            // Update to page numbers
            if (config.gpState?.canvases[0]) {
                indicator.textContent = `${config.gpState.currentPageIndex + 1} of ${config.gpState.pages.length}`;
            } else if (config.condensedCanvases) {
                indicator.textContent = `${config.currentPageIndex + 1} of ${config.condensedCanvases.length}`;
            }
        } else {
            // Update to scroll percentage
            // Use requestAnimationFrame to ensure we get accurate scroll values after layout
            requestAnimationFrame(() => {
                const scrollPercent = (config.output.scrollTop / (config.output.scrollHeight - config.output.clientHeight) * 100) || 0;
                indicator.textContent = `${Math.round(scrollPercent)}%`;
            });
        }
    };

    pageModeRadio.addEventListener('change', () => {
        pageModeRadio.blur();
        const config = getConfig();
        if (!config.output || !config.currentFile) return;

        pauseSynthPlayer();
        clearSynthHighlights();
        config.continuous = !pageModeRadio.checked;
        const isPageMode = pageModeRadio.checked;
        
        // Update UI immediately to reflect mode change
        const indicator = document.getElementById('pageIndicator');
        clearOutput(config.output);

        if (config.gpState.canvases[0]) {
            // For Guitar Pro files
            if (isPageMode) {
                // Switch to page mode
                if (indicator) {
                    indicator.textContent = `${config.gpState.currentPageIndex + 1} of ${config.gpState.pages.length}`;
                }
                switchToPageMode(
                    config.output, 
                    config.gpState.currentPageIndex,
                    config.gpState.pages.length
                );
                // Immediate render
                config.renderGPPage(config.output, true, continuousModeRadio);
                // Focus the output element to enable keyboard navigation
                config.output.focus();
            } else {
                // For GP files, just render directly in continuous mode
                config.renderGPPage(config.output, false, continuousModeRadio);
                
                // Force immediate scroll indicator update
                if (indicator) {
                    const scrollPercent = (config.output.scrollTop / (config.output.scrollHeight - config.output.clientHeight) * 100) || 0;
                    indicator.textContent = `${Math.round(scrollPercent)}%`;
                }
            }
        } else {
            if (isPageMode) {
                if (config.textState?.pages?.length > 0) {
                    // Handle text files
                    config.output.style.overflowY = 'hidden';
                    // Switch to page mode for text files
                    switchToPageMode(
                        config.output,
                        config.textState.currentPageIndex,
                        config.textState.pages.length
                    );
                    config.renderTextPage(config.output, true);
                    config.output.focus();
                } else {
                    // Switch to page mode for PDFs
                    switchToPageMode(
                        config.output,
                        config.currentPageIndex,
                        config.condensedCanvases.length
                    );
                    // Update page indicator and layout
                    updateIndicator(config, true);
                    config.doLayoutPages();
                    // Focus the output element to enable keyboard navigation
                    config.output.focus();
                }
            } else {
                if (config.textState?.pages?.length > 0) {
                    // Handle text files in continuous mode
                    switchToContinuous(
                        config.output,
                        [config.textState.fullContent],
                        (newPage) => {
                            config.textState.currentPageIndex = newPage;
                            if (indicator) {
                                const scrollPercent = (config.output.scrollTop / (config.output.scrollHeight - config.output.clientHeight) * 100) || 0;
                                indicator.textContent = `${Math.round(scrollPercent)}%`;
                            }
                        }
                    );
                    config.renderTextPage(config.output, false);
                } else {
                    // Switch to continuous mode for PDFs
                    switchToContinuous(
                        config.output,
                        config.condensedCanvases,
                        (newPage) => {
                            config.currentPageIndex = newPage;
                            config.updatePageDisplay();
                            updateIndicator(config, false);
                        }
                    );
                }
            }
        }
    });

    continuousModeRadio.addEventListener('change', () => {
        continuousModeRadio.blur();
        if (!continuousModeRadio.checked) return;
        
        pauseSynthPlayer();
        clearSynthHighlights();
        const config = getConfig();
        config.continuous = true;
        
        // Update UI immediately to reflect mode change
        const indicator = document.getElementById('pageIndicator');
        clearOutput(config.output);

        if (config.gpState.canvases[0]) {
            // For GP files, just render directly in continuous mode
            config.renderGPPage(config.output, false, continuousModeRadio);
            updateIndicator(config, false);
        } else if (config.textState?.pages?.length > 0) {
            // Handle text files in continuous mode
            switchToContinuous(
                config.output,
                [config.textState.fullContent],
                (newPage) => {
                    config.textState.currentPageIndex = newPage;
                    if (indicator) {
                        const scrollPercent = (config.output.scrollTop / (config.output.scrollHeight - config.output.clientHeight) * 100) || 0;
                        indicator.textContent = `${Math.round(scrollPercent)}%`;
                    }
                }
            );
            config.renderTextPage(config.output, false);
        } else {
            // Switch to continuous mode for PDFs
            switchToContinuous(
                config.output,
                config.condensedCanvases,
                (newPage) => {
                    config.currentPageIndex = newPage;
                    config.updatePageDisplay();
                    updateIndicator(config, false);
                }
            );
        }
        
        // Queue a second UI update to ensure indicator is correct after layout
        requestAnimationFrame(() => {
            if (indicator) {
                const scrollPercent = (config.output.scrollTop / (config.output.scrollHeight - config.output.clientHeight) * 100) || 0;
                indicator.textContent = `${Math.round(scrollPercent)}%`;
            }
        });
        
        config.output.focus();
    });
}

/**
 * Handle tap/click navigation
 */
export function setupTapClickNavigation(output, getConfig) {
    output.addEventListener('click', (e) => {
        const config = getConfig();
        handleTapNavigation(e, config);
    });
}

/**
 * Handle tap/click navigation in page mode
 * @param {MouseEvent} e Mouse/Touch event
 * @param {Object} config Navigation configuration object
 */
export function handleTapNavigation(e, config) {
    // Skip if there's no file loaded or not in page mode
    if (!config.pageModeRadio?.checked) {
        console.log('Click ignored: not in page mode');
        return;
    }
    if (config.currentFile == null) {
        console.log('Click ignored: no file loaded');
        return;
    }

    const outputRect = config.output.getBoundingClientRect();
    if (e.clientY < outputRect.top) {
        console.log('Click ignored: above content area');
        return;
    }

    // Phone: the left half turns the page back and the right half forward; no tap moves a bar
    if (isPhoneReader()) {
        const zone = phoneTapZone(e.clientX, e.clientY, outputRect);
        const navigationHandler = new NavigationHandler(config);
        const result = navigationHandler.handleAction(zone === 'next' ? NavigationAction.NEXT : NavigationAction.PREV);
        if (result?.newPageIndex !== undefined) config.setCurrentPageIndex(result.newPageIndex);
        return;
    }

    // Handle both regular page wrappers and GP-specific wrappers
    const pageContainers = config.output.querySelectorAll('.pageWrapper, .gp-page-wrapper');
    console.log('Found page containers:', pageContainers.length);
    
    for (let i = 0; i < pageContainers.length; i++) {
        const rect = pageContainers[i].getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
            const clickX = e.clientX;
            const midX = rect.left + rect.width / 2;
            const action = clickX >= midX ? NavigationAction.NEXT : NavigationAction.PREV;
            
            const navigationHandler = new NavigationHandler(config);
            const result = navigationHandler.handleAction(action);
            if (result?.newPageIndex !== undefined) {
                config.setCurrentPageIndex(result.newPageIndex);
            }
            break;
        }
    }
}

/**
 * Update the visibility and disabled state of the consolidated top bar audio playback controls
 */
export function updateGlobalAudioControls() {
    const controlsContainer = document.getElementById('globalAudioControls');
    const sourcePill = document.getElementById('audioSourcePill');
    const rewindBtn = document.getElementById('globalRewindBtn');
    const playPauseBtn = document.getElementById('globalPlayPauseBtn');
    const playPauseIcon = document.getElementById('globalPlayPauseIcon');

    const synthBtn = document.getElementById('synthToggleBtn');
    const realAudioBtn = document.getElementById('ytToggleBtn');

    const isSynthVisible = Boolean(synthBtn && synthBtn.style.display !== 'none');
    const isRealAudioVisible = Boolean(realAudioBtn && realAudioBtn.style.display !== 'none');
    const anySource = isSynthVisible || isRealAudioVisible;

    if (sourcePill) {
        sourcePill.style.display = anySource ? 'inline-flex' : 'none';
    }

    if (controlsContainer) {
        if (anySource) {
            controlsContainer.style.display = 'inline-flex';
        } else {
            controlsContainer.style.display = 'none';
            const mobileDock = document.getElementById('mobilePlaybackDock');
            if (mobileDock) mobileDock.style.display = 'none';
            return;
        }
    }

    // Whichever sound the transport will use is shown as selected before anything plays
    const synthIsAvailable = isSynthAvailable();
    if (!synthBtn?.classList.contains('active-audio-mode') && !realAudioBtn?.classList.contains('active-audio-mode')) {
        // A synth button with no player behind it (a text or PDF tab with no MIDI linked yet) is not a sound to default to
        const useReal = isRealAudioVisible && (!isSynthVisible || !synthIsAvailable || (isRealAudioAvailable() && songHasSyncPoints(getSongKey())));
        setActiveAudioMode(useReal ? 'real' : 'synth');
    }

    const synthPlayable = isSynthAvailable();
    const realAudioPlayable = isRealAudioAvailable();
    const canPlay = synthPlayable || realAudioPlayable;

    if (rewindBtn) {
        rewindBtn.disabled = !canPlay;
    }

    const isPlaying = isSynthPlaying() || isRealAudioPlaying();

    if (playPauseBtn) {
        playPauseBtn.disabled = !canPlay;
        playPauseBtn.title = isPlaying ? 'Pause' : 'Play';
    }
    if (playPauseIcon) {
        playPauseIcon.className = isPlaying ? 'bi-pause-fill' : 'bi-play-fill';
    }

    // Mirror to mobile floating playback dock
    const mobileDock = document.getElementById('mobilePlaybackDock');
    const mobileRewindBtn = document.getElementById('mobileRewindBtn');
    const mobilePlayPauseBtn = document.getElementById('mobilePlayPauseBtn');
    const mobilePlayPauseIcon = document.getElementById('mobilePlayPauseIcon');
    const mobileSynthBtn = document.getElementById('mobileSynthToggleBtn');
    const mobileRealAudioBtn = document.getElementById('mobileYtToggleBtn');
    const mobileDivider = document.getElementById('mobileAudioSourceDivider');

    if (mobileDock) {
        const mainContent = document.getElementById('mainContent');
        const isScoreMode = mainContent && mainContent.style.display !== 'none';
        mobileDock.classList.toggle('has-audio-sources', Boolean(isScoreMode && anySource));
    }
    if (mobileRewindBtn) mobileRewindBtn.disabled = !canPlay;
    if (mobilePlayPauseBtn) {
        mobilePlayPauseBtn.disabled = !canPlay;
        mobilePlayPauseBtn.title = isPlaying ? 'Pause' : 'Play';
    }
    if (mobilePlayPauseIcon) {
        mobilePlayPauseIcon.className = isPlaying ? 'bi-pause-fill' : 'bi-play-fill';
    }
    if (mobileSynthBtn) {
        mobileSynthBtn.style.display = isSynthVisible ? 'inline-flex' : 'none';
        mobileSynthBtn.classList.toggle('active-audio-mode', Boolean(synthBtn?.classList.contains('active-audio-mode')));
    }
    if (mobileRealAudioBtn) {
        mobileRealAudioBtn.style.display = isRealAudioVisible ? 'inline-flex' : 'none';
        mobileRealAudioBtn.classList.toggle('active-audio-mode', Boolean(realAudioBtn?.classList.contains('active-audio-mode')));
    }
    if (mobileDivider) {
        mobileDivider.style.display = anySource ? 'block' : 'none';
    }
}

export const updateGlobalRewindButton = updateGlobalAudioControls;

/**
 * Which player the transport buttons drive when the user has not picked one: a recording the song has
 * sync points for beats the synth, otherwise the synth.
 */
function preferRealAudio() {
    const realAudioActive = document.getElementById('ytToggleBtn')?.classList.contains('active-audio-mode');
    const synthActive = document.getElementById('synthToggleBtn')?.classList.contains('active-audio-mode');
    if (realAudioActive) return true;
    if (synthActive) return false;
    return isRealAudioAvailable() && songHasSyncPoints(getSongKey());
}

/**
 * Handle Back 10 Seconds for whichever audio player is active/playing
 */
export function handleGlobalRewind10Seconds() {
    if (isSynthPlaying()) {
        rewindSynth10Seconds();
        return;
    }
    if (isRealAudioPlaying()) {
        rewindRealAudio10Seconds();
        return;
    }
    if (preferRealAudio() && isRealAudioAvailable()) {
        rewindRealAudio10Seconds();
        return;
    }
    if (isSynthAvailable()) {
        rewindSynth10Seconds();
        return;
    }
    if (isRealAudioAvailable()) {
        rewindRealAudio10Seconds();
        return;
    }
}

/**
 * Handle Play / Pause for whichever audio player is active/playing or available
 */
export function handleGlobalPlayPause() {
    if (isSynthPlaying()) {
        playPauseSynth();
        return;
    }
    if (isRealAudioPlaying()) {
        playPauseRealAudio();
        return;
    }

    if (preferRealAudio() && isRealAudioAvailable()) {
        playPauseRealAudio();
        return;
    }
    if (isSynthAvailable()) {
        playPauseSynth();
        return;
    }
    if (isRealAudioAvailable()) {
        playPauseRealAudio();
        return;
    }
}

/**
 * Initialize the consolidated top bar playback controls
 */
export function setupGlobalAudioControls() {
    const rewindBtn = document.getElementById('globalRewindBtn');
    const playPauseBtn = document.getElementById('globalPlayPauseBtn');
    const mobileRewindBtn = document.getElementById('mobileRewindBtn');
    const mobilePlayPauseBtn = document.getElementById('mobilePlayPauseBtn');
    const mobileSynthBtn = document.getElementById('mobileSynthToggleBtn');
    const mobileRealAudioBtn = document.getElementById('mobileYtToggleBtn');

    rewindBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        handleGlobalRewind10Seconds();
    });

    playPauseBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        handleGlobalPlayPause();
    });

    mobileRewindBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        handleGlobalRewind10Seconds();
    });

    mobilePlayPauseBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        handleGlobalPlayPause();
    });

    // Synth | Recording is a switch in the dock. Pressing either one switches to that sound and opens its panel;
    // pressing it again closes the panel.
    mobileSynthBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('synthToggleBtn')?.click();
    });

    mobileRealAudioBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('ytToggleBtn')?.click();
    });

    updateGlobalAudioControls();
}

export const setupGlobalRewindButton = setupGlobalAudioControls;

/**
 * Highlight the active audio mode toggle button (Synth or Real Audio)
 * @param {'synth'|'youtube'|'audio'|'real'|null} mode
 */
export function setActiveAudioMode(mode) {
    const isReal = mode === 'youtube' || mode === 'audio' || mode === 'real';
    document.getElementById('synthToggleBtn')?.classList.toggle('active-audio-mode', mode === 'synth');
    document.getElementById('mobileSynthToggleBtn')?.classList.toggle('active-audio-mode', mode === 'synth');
    document.getElementById('ytToggleBtn')?.classList.toggle('active-audio-mode', isReal);
    document.getElementById('mobileYtToggleBtn')?.classList.toggle('active-audio-mode', isReal);
    // iOS ignores volume on media elements and the YouTube embed, so the master slider only reaches the synth there
    const slider = document.getElementById('synthVolumeSlider');
    if (slider) {
        const locked = isReal && isIOSDevice();
        slider.dataset.mediaLocked = locked ? '1' : '';
        slider.disabled = locked;
        slider.title = locked ? 'iOS controls volume for this audio. Use the device volume buttons.' : '';
    }
}
