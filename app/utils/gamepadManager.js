// gamepadManager.js
// Cross-platform game controller manager for MajesticTab (Web, Tauri Linux / Steam Deck, Windows, macOS).
// Uses the W3C Gamepad API with standard XInput / Xbox / Steam Deck controller layout.

import { showToast } from './toast.js';
import { performAppBack } from './navigationUtils.js';

// Controller configuration constants
const STICK_DEADZONE = 0.18;
const STICK_NAV_THRESHOLD = 0.45;
const STICK_NAV_RELEASE = 0.25;
const TRIGGER_THRESHOLD = 0.15;
const BUTTON_REPEAT_DELAY_MS = 360;
const BUTTON_REPEAT_INTERVAL_MS = 90;
const ZOOM_REPEAT_INTERVAL_MS = 200;

const COMPOSITE_ROW_SELECTOR = [
    '.library-song-row',
    '.library-card',
    '.library-row-card[tabindex="0"]',
    '.library-row-card.library-row-clickable',
    '.library-row-card[data-row-action]',
    '.library-pinned-card',
    '.library-track-row:not(.is-filtered-out)',
    '.open-file-dropzone',
    '.open-file-provider-item',
    '.theme-card'
].join(', ');

const DUPLICATE_ROW_ACTION_SELECTOR = [
    '.library-pinned-card button',
    '.play-default-tab-btn',
    '.open-recent-btn',
    '.explore-artist-btn',
    '.add-single-song-btn',
    '.explore-band-albums-btn',
    '.add-single-track-btn',
    '.setlist-search-add-btn',
    '#openFileBrowseBtn'
].join(', ');

const PRIMARY_CONTENT_SELECTOR = [
    '.library-pinned-card',
    '.library-card',
    '.library-song-row',
    '.library-row-card[tabindex="0"]',
    '.library-row-card.library-row-clickable',
    '.library-row-card[data-row-action]',
    '.library-track-row:not(.is-filtered-out)',
    '.open-file-dropzone',
    '.open-file-provider-item',
    '.theme-card',
    '#emptyStateAddBtn',
    '#newSetlistBtn',
    '#recentsEmptyOpenBtn',
    '#mbSearchInput',
    '#customDocTitle'
].join(', ');

import { isSteamDeck, setIsSteamDeck, applyPlatformDefaults } from './platformUtils.js';

export { isSteamDeck, setIsSteamDeck };

let customButtonX = null;
let customButtonY = null;

// Map standard buttons, adjusting X/Y for Steam Deck if hardware inversion occurs
export const GamepadButton = {
    A: 0,
    B: 1,
    get X() { return customButtonX !== null ? customButtonX : (isSteamDeck() ? 3 : 2); }, // Swapped on Steam Deck virtual mapping if needed
    set X(val) { customButtonX = val; },
    get Y() { return customButtonY !== null ? customButtonY : (isSteamDeck() ? 2 : 3); },
    set Y(val) { customButtonY = val; },
    LB: 4,
    RB: 5,
    LT: 6,
    RT: 7,
    VIEW: 8,       // Back / Select / Share
    MENU: 9,       // Start / Options / Hamburger
    L3: 10,        // Left Stick Click
    R3: 11,        // Right Stick Click
    DPAD_UP: 12,
    DPAD_DOWN: 13,
    DPAD_LEFT: 14,
    DPAD_RIGHT: 15,
    GUIDE: 16      // Xbox / Steam Guide
};

// Internal manager state
class GamepadManager {
    constructor() {
        this.connectedGamepads = new Map();
        this.activeGamepadIndex = null;
        this.isPolling = false;
        this.rafId = null;

        // Button tracking: { [index]: { isDown, pressedAt, nextRepeatAt } }
        this.buttonStates = new Map();
        this.leftStickState = { direction: null, pressedAt: 0, nextRepeatAt: 0 };
        this.viewButtonPressedAt = 0;
        this.lastZoomTime = 0;

        // Spatial navigation focus tracking
        this.currentNavElement = null;
        this.lastInputWasNavigation = false;

        // HUD / Top Bar state
        this.isHudHidden = false;
        this.hudTransientTimeout = null;

        // UI elements
        this.topBar = null;
        this.controllerPill = null;
        this.controllerModal = null;
    }

    /**
     * Initialize the controller system
     */
    init() {
        this.topBar = document.getElementById('topBar');
        this.controllerPill = document.getElementById('controllerPill');
        this.controllerModal = document.getElementById('controllerHelpModal');

        // Setup DOM event listeners for controller connections
        window.addEventListener('gamepadconnected', (e) => this.handleGamepadConnected(e.gamepad));
        window.addEventListener('gamepaddisconnected', (e) => this.handleGamepadDisconnected(e.gamepad));

        // Setup mouse / pointer movement listener to temporarily peek HUD when hidden
        window.addEventListener('mousemove', () => this.handlePointerActivity());
        window.addEventListener('touchstart', () => {
            this.handlePointerActivity();
            this.lastInputWasNavigation = false;
            this.clearNavFocus();
        }, { passive: true });
        window.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' || e.pointerType === 'touch' || e.pointerType === 'pen') {
                this.lastInputWasNavigation = false;
                this.clearNavFocus();
            }
        }, { passive: true });
        window.addEventListener('focusin', (e) => {
            if (this.lastInputWasNavigation && e.target && e.target !== document.body && e.target !== document.documentElement) {
                this.applyNavFocusClass(e.target);
            }
        });

        // Setup close button on Controller Help Modal
        const closeBtn = document.getElementById('controllerHelpModalCloseBtn');
        closeBtn?.addEventListener('click', () => this.closeHelpModal());
        const modalBackdrop = document.getElementById('controllerHelpModal');
        modalBackdrop?.addEventListener('click', (e) => {
            if (e.target === modalBackdrop) this.closeHelpModal();
        });

        // Top bar pill trigger
        const pillBtn = document.getElementById('controllerHelpBtn');
        pillBtn?.addEventListener('click', () => this.toggleHelpModal('gamepad'));

        // Keyboard / Game Controller tab switcher
        document.querySelectorAll('input[name="controlsTabRadio"]').forEach(radio => {
            radio.addEventListener('change', () => {
                if (radio.checked) this.setControlsTab(radio.value);
            });
        });

        // Drawer menu trigger
        const drawerBtn = document.getElementById('openControllerHelpMenuBtn');
        drawerBtn?.addEventListener('click', () => {
            // Dismiss offcanvas drawer first if needed
            const fileMenu = document.getElementById('fileMenu');
            if (fileMenu) {
                const offcanvas = window.bootstrap?.Offcanvas?.getInstance?.(fileMenu);
                offcanvas?.hide();
            }
            this.openHelpModal('keyboard');
        });

        // Check if gamepads are already available (e.g. page refreshed with controller plugged in)
        this.scanExistingGamepads();

        // Start polling loop
        this.startPolling();
    }

    /**
     * Check navigator.getGamepads() for already-connected controllers
     */
    scanExistingGamepads() {
        if (!navigator.getGamepads) return;
        const gamepads = navigator.getGamepads();
        for (let i = 0; i < gamepads.length; i++) {
            const gp = gamepads[i];
            if (gp) {
                this.handleGamepadConnected(gp);
                break;
            }
        }
    }

    handleGamepadConnected(gamepad) {
        if (!gamepad) return;
        if (/steam/i.test(gamepad.id)) {
            setIsSteamDeck(true);
            applyPlatformDefaults();
        }
        this.connectedGamepads.set(gamepad.index, gamepad);
        if (this.activeGamepadIndex === null) {
            this.activeGamepadIndex = gamepad.index;
        }

        this.updatePillUI(true, gamepad.id);
        showToast(`Controller connected: ${this.cleanGamepadName(gamepad.id)}`, 'info', 2500);
        this.startPolling();

        // Automatically show the controller guide overlay on first controller connection
        const hasSeenGuide = localStorage.getItem('hasSeenControllerGuide');
        if (!hasSeenGuide) {
            localStorage.setItem('hasSeenControllerGuide', 'true');
            setTimeout(() => {
                this.openHelpModal('gamepad');
            }, 350);
        }
    }

    handleGamepadDisconnected(gamepad) {
        if (!gamepad) return;
        this.connectedGamepads.delete(gamepad.index);
        if (this.activeGamepadIndex === gamepad.index) {
            const remaining = Array.from(this.connectedGamepads.keys());
            this.activeGamepadIndex = remaining.length > 0 ? remaining[0] : null;
        }

        if (this.connectedGamepads.size === 0) {
            this.updatePillUI(false);
            showToast('Controller disconnected', 'warning', 2000);
        }
    }

    cleanGamepadName(rawId) {
        if (!rawId) return 'Gamepad';
        if (/steam/i.test(rawId)) return 'Steam Deck / Controller';
        if (/xbox|x-box|xinput/i.test(rawId)) return 'Xbox Controller';
        if (/playstation|dualshock|dualsense/i.test(rawId)) return 'PlayStation Controller';
        return rawId.split('(')[0].trim() || 'Gamepad';
    }

    updatePillUI(isConnected, name = 'Gamepad') {
        if (!this.controllerPill) {
            this.controllerPill = document.getElementById('controllerPill');
        }
        if (this.controllerPill) {
            this.controllerPill.style.display = isConnected ? 'flex' : 'none';
        }
        const nameBadge = document.getElementById('controllerNameBadge');
        if (nameBadge) {
            nameBadge.textContent = this.cleanGamepadName(name);
        }
    }

    /**
     * Main polling animation frame loop
     */
    startPolling() {
        if (this.isPolling) return;
        this.isPolling = true;

        const poll = () => {
            this.pollGamepads();
            this.rafId = requestAnimationFrame(poll);
        };
        this.rafId = requestAnimationFrame(poll);
    }

    stopPolling() {
        this.isPolling = false;
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    pollGamepads() {
        if (!navigator.getGamepads) return;
        const gamepads = navigator.getGamepads();
        let activeGp = null;

        if (this.activeGamepadIndex !== null && gamepads[this.activeGamepadIndex]) {
            activeGp = gamepads[this.activeGamepadIndex];
        } else {
            for (let i = 0; i < gamepads.length; i++) {
                if (gamepads[i]) {
                    activeGp = gamepads[i];
                    this.activeGamepadIndex = i;
                    break;
                }
            }
        }

        if (!activeGp) {
            if (this.connectedGamepads.size > 0) {
                this.connectedGamepads.clear();
                this.updatePillUI(false);
            }
            return;
        }

        if (!isSteamDeck() && activeGp && /steam/i.test(activeGp.id)) {
            setIsSteamDeck(true);
            applyPlatformDefaults();
        }

        // If pill was hidden but gamepad is active, reveal pill
        if (this.controllerPill && this.controllerPill.style.display === 'none') {
            this.updatePillUI(true, activeGp.id);
        }

        const now = performance.now();
        this.processButtons(activeGp, now);
        this.processAxes(activeGp, now);
    }

    processButtons(gp, now) {
        const buttons = gp.buttons;
        if (!buttons || !buttons.length) return;

        for (let i = 0; i < buttons.length; i++) {
            const btn = buttons[i];
            const isDown = typeof btn === 'object' ? (btn.pressed || (typeof btn.value === 'number' && btn.value > 0.3)) : btn > 0.5;
            const state = this.buttonStates.get(i) || { isDown: false, pressedAt: 0, nextRepeatAt: 0 };

            if (isDown) {
                if (!state.isDown) {
                    // Just pressed (Rising edge)
                    state.isDown = true;
                    state.pressedAt = now;
                    state.nextRepeatAt = now + BUTTON_REPEAT_DELAY_MS;
                    this.handleButtonPress(i, false, now);
                } else if (now >= state.nextRepeatAt) {
                    // Repeating hold
                    state.nextRepeatAt = now + BUTTON_REPEAT_INTERVAL_MS;
                    this.handleButtonPress(i, true, now);
                }
            } else {
                if (state.isDown) {
                    // Just released (Falling edge)
                    state.isDown = false;
                    this.handleButtonRelease(i, state.pressedAt, now);
                }
            }

            this.buttonStates.set(i, state);
        }
    }

    handleButtonPress(buttonIndex, isRepeat, now) {
        // Only allow repeats on D-Pad and Shoulder Triggers to prevent accidental re-triggers on action buttons
        if (isRepeat) {
            const repeatable = [
                GamepadButton.DPAD_UP,
                GamepadButton.DPAD_DOWN,
                GamepadButton.DPAD_LEFT,
                GamepadButton.DPAD_RIGHT,
                GamepadButton.LB,
                GamepadButton.RB,
                GamepadButton.LT,
                GamepadButton.RT
            ];
            if (!repeatable.includes(buttonIndex)) return;
        }

        this.lastInputWasNavigation = true;

        const isModalOpen = this.isAnyModalOpen();
        const isHelpOpen = this.isHelpModalOpen();
        const isLibOpen = this.isLibraryViewOpen();

        // If Help modal is open, B or Y or View dismisses it
        if (isHelpOpen) {
            if (buttonIndex === GamepadButton.B || buttonIndex === GamepadButton.Y || buttonIndex === GamepadButton.VIEW) {
                this.closeHelpModal();
                return;
            }
        }

        switch (buttonIndex) {
            case GamepadButton.Y:
                // Primary requested feature: Toggle Top Bar HUD in score mode
                if (isHelpOpen) {
                    this.closeHelpModal();
                } else if (!isLibOpen && !isModalOpen) {
                    this.toggleTopBar();
                } else if (isLibOpen) {
                    // In Library mode, Y toggles Top Bar
                    this.toggleTopBar();
                }
                break;

            case GamepadButton.A:
                this.handleButtonA(isLibOpen, isModalOpen);
                break;

            case GamepadButton.B:
                this.handleButtonB(isLibOpen, isModalOpen);
                break;

            case GamepadButton.X:
                this.handleButtonX(isLibOpen, isModalOpen);
                break;

            case GamepadButton.LB:
            case GamepadButton.LT:
                this.handleButtonLB(isLibOpen, isModalOpen);
                break;

            case GamepadButton.RB:
            case GamepadButton.RT:
                this.handleButtonRB(isLibOpen, isModalOpen);
                break;

            case GamepadButton.VIEW:
                // Track start time for tap vs hold
                this.viewButtonPressedAt = now;
                break;

            case GamepadButton.MENU:
                this.handleButtonMenu(isLibOpen, isModalOpen);
                break;

            case GamepadButton.L3:
                // Toggle Page Mode vs Continuous Scroll
                this.toggleViewMode();
                break;

            case GamepadButton.R3:
                // Reset zoom to 100%
                this.resetZoom();
                break;

            case GamepadButton.DPAD_LEFT:
                this.handleDpadLeft(isLibOpen, isModalOpen);
                break;

            case GamepadButton.DPAD_RIGHT:
                this.handleDpadRight(isLibOpen, isModalOpen);
                break;

            case GamepadButton.DPAD_UP:
                this.handleDpadUp(isLibOpen, isModalOpen);
                break;

            case GamepadButton.DPAD_DOWN:
                this.handleDpadDown(isLibOpen, isModalOpen);
                break;
        }
    }

    handleButtonRelease(buttonIndex, pressedAt, now) {
        const duration = now - pressedAt;

        // View (Back/Select): Long press (>400ms) opens Help Diagram; Quick tap cycles audio source
        if (buttonIndex === GamepadButton.VIEW) {
            if (duration >= 400) {
                this.toggleHelpModal('gamepad');
            } else {
                this.cycleAudioSource();
            }
        }
    }

    processAxes(gp, now) {
        const axes = gp.axes;
        if (!axes || axes.length < 2) return;

        const leftX = axes[0] || 0;
        const leftY = axes[1] || 0;
        const rightY = axes.length >= 4 ? axes[3] || 0 : 0;

        const isNavMode = this.isSpatialNavActive();

        if (isNavMode) {
            // In Library & Menu Mode: Left Stick performs 2D directional focus navigation (like D-Pad)
            const leftMag = Math.hypot(leftX, leftY);
            const threshold = this.leftStickState.direction ? STICK_NAV_RELEASE : STICK_NAV_THRESHOLD;

            let dir = null;
            if (leftMag >= threshold) {
                if (Math.abs(leftX) > Math.abs(leftY)) {
                    dir = leftX < 0 ? 'left' : 'right';
                } else {
                    dir = leftY < 0 ? 'up' : 'down';
                }
            }

            if (dir !== this.leftStickState.direction) {
                if (dir !== null) {
                    this.leftStickState.direction = dir;
                    this.leftStickState.pressedAt = now;
                    this.leftStickState.nextRepeatAt = now + BUTTON_REPEAT_DELAY_MS;
                    this.lastInputWasNavigation = true;
                    this.navigateSpatial(dir);
                } else {
                    this.leftStickState.direction = null;
                    this.leftStickState.pressedAt = 0;
                    this.leftStickState.nextRepeatAt = 0;
                }
            } else if (dir !== null && now >= this.leftStickState.nextRepeatAt) {
                this.leftStickState.nextRepeatAt = now + BUTTON_REPEAT_INTERVAL_MS;
                this.lastInputWasNavigation = true;
                this.navigateSpatial(dir);
            }

            // In Library & Menu Mode: Right Stick Y scrolls the container smoothly
            if (Math.abs(rightY) > STICK_DEADZONE) {
                const normalizedY = (Math.abs(rightY) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
                const signY = Math.sign(rightY);
                const triggerBoost = this.getTriggerScrollMultiplier(gp);
                const scrollDelta = signY * Math.pow(normalizedY, 1.8) * 18 * triggerBoost;
                this.scrollActiveContainer(scrollDelta);
            }
            return;
        }

        // Reset stick navigation state when in Score Mode
        this.leftStickState.direction = null;

        // Score Mode: Left Stick for continuous smooth scroll
        const leftMag = Math.hypot(leftX, leftY);
        if (leftMag > STICK_DEADZONE) {
            const normalizedY = (Math.abs(Math.abs(leftY) - STICK_DEADZONE)) / (1 - STICK_DEADZONE);
            const signY = Math.sign(leftY);
            const triggerBoost = this.getTriggerScrollMultiplier(gp);
            const scrollDelta = signY * Math.pow(normalizedY, 1.8) * 18 * triggerBoost;

            this.scrollActiveContainer(scrollDelta);
        }

        // Score Mode: Right Stick Y for score zoom in/out
        if (Math.abs(rightY) > STICK_DEADZONE + 0.08) {
            if (now - this.lastZoomTime >= ZOOM_REPEAT_INTERVAL_MS) {
                this.lastZoomTime = now;
                if (rightY < 0) {
                    // Pushing stick UP zooms IN
                    this.adjustZoom(true);
                } else {
                    // Pushing stick DOWN zooms OUT
                    this.adjustZoom(false);
                }
            }
        }
    }

    getTriggerScrollMultiplier(gp) {
        if (!gp.buttons || gp.buttons.length <= GamepadButton.RT) return 1;
        const ltVal = gp.buttons[GamepadButton.LT]?.value || 0;
        const rtVal = gp.buttons[GamepadButton.RT]?.value || 0;
        const maxTrigger = Math.max(ltVal, rtVal);
        return 1 + maxTrigger * 2.5; // Up to 3.5x speed boost
    }

    scrollActiveContainer(deltaY) {
        if (Math.abs(deltaY) < 0.2) return;

        const output = document.getElementById('output');
        const mainContent = document.getElementById('mainContent');
        const libraryPage = document.getElementById('libraryPage');

        if (this.isLibraryViewOpen() && libraryPage) {
            libraryPage.scrollBy({ top: deltaY, behavior: 'auto' });
            return;
        }

        // In continuous score mode, #output has overflow-y: auto
        if (output && output.classList.contains('continuous-mode')) {
            output.scrollBy({ top: deltaY, behavior: 'auto' });
        } else if (mainContent) {
            mainContent.scrollBy({ top: deltaY, behavior: 'auto' });
        }
    }

    // --- Focus State Helpers ---

    clearNavFocus() {
        document.querySelectorAll('.nav-focused').forEach(el => el.classList.remove('nav-focused'));
        this.currentNavElement = null;
    }

    applyNavFocusClass(target) {
        document.querySelectorAll('.nav-focused').forEach(el => {
            if (el !== target) el.classList.remove('nav-focused');
        });
        if (target) {
            target.classList.add('nav-focused');
            this.currentNavElement = target;
        }
    }

    setNavFocus(target, scroll = true) {
        if (!target) return;
        this.lastInputWasNavigation = true;
        this.applyNavFocusClass(target);
        try {
            target.focus({ preventScroll: true });
        } catch {}
        if (scroll && typeof target.scrollIntoView === 'function') {
            const rectTarget = target.classList?.contains('btn-check') && target.nextElementSibling
                ? target.nextElementSibling
                : target;
            rectTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        }
    }

    getCurrentFocusedElement(container = document) {
        const active = document.activeElement;
        if (active && active !== document.body && active !== document.documentElement && container.contains(active) && this.isElementVisible(active)) {
            return active;
        }
        if (this.currentNavElement && this.currentNavElement.isConnected && container.contains(this.currentNavElement) && this.isElementVisible(this.currentNavElement)) {
            return this.currentNavElement;
        }
        const navFocused = container.querySelector?.('.nav-focused');
        if (navFocused && this.isElementVisible(navFocused)) {
            return navFocused;
        }
        return null;
    }

    isElementVisible(el) {
        if (!el || !el.isConnected) return false;
        if (el.classList?.contains('btn-check') && el.nextElementSibling) {
            return this.isElementVisible(el.nextElementSibling);
        }
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (el.offsetParent === null && style.position !== 'fixed' && style.position !== 'sticky') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    getFocusRect(el) {
        if (!el) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
        if (el.classList?.contains('btn-check') && el.nextElementSibling) {
            return el.nextElementSibling.getBoundingClientRect();
        }
        // When a song row has a bottom tab-options bar, use the song row's main header bar for vertical geometry
        // so the song row and its child tab chips have non-overlapping vertical rects.
        if (el.classList?.contains('library-song-row') && el.firstElementChild && el.querySelector('.tab-options-container')) {
            return el.firstElementChild.getBoundingClientRect();
        }
        return el.getBoundingClientRect();
    }

    getFirstPrimaryContentElement(container = this.getActiveFocusContainer()) {
        if (!container) return null;
        const candidates = Array.from(container.querySelectorAll(PRIMARY_CONTENT_SELECTOR));
        for (const el of candidates) {
            if (this.isElementVisible(el)) return el;
        }
        const allFocusable = this.getFocusableElements(container);
        return allFocusable[0] || null;
    }

    /**
     * Called after a library view or sub-view finishes rendering so keyboard/controller highlight
     * stays visible on the newly rendered content (or restores to the item backed out of).
     */
    onLibraryViewRendered(preferredSelector = null) {
        if (!this.lastInputWasNavigation) return;
        const container = this.getActiveFocusContainer();
        if (!container) return;

        const active = document.activeElement;
        if (active && container.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && this.isElementVisible(active)) {
            this.applyNavFocusClass(active);
            return;
        }

        if (preferredSelector) {
            try {
                const preferred = container.querySelector(preferredSelector);
                if (preferred && this.isElementVisible(preferred)) {
                    this.setNavFocus(preferred);
                    return;
                }
            } catch {}
        }

        const primary = this.getFirstPrimaryContentElement(container);
        if (primary) {
            this.setNavFocus(primary);
        }
    }

    // --- Action Implementations ---

    /**
     * Toggle Top Bar HUD visibility (Zen Mode for score reading)
     */
    toggleTopBar(forceState = null) {
        if (!this.topBar) {
            this.topBar = document.getElementById('topBar');
        }
        if (!this.topBar) return;

        const nextHidden = forceState !== null ? forceState : !this.isHudHidden;
        this.isHudHidden = nextHidden;
        const mobileDock = document.getElementById('mobilePlaybackDock');

        if (this.isHudHidden) {
            this.topBar.classList.add('hud-hidden');
            this.topBar.classList.remove('hud-transient');
            mobileDock?.classList.add('hud-hidden');
            mobileDock?.classList.remove('hud-transient');
            showToast('Top Bar Hidden (Zen Mode) — Press Z or (Y) to restore', 'info', 2000);
        } else {
            this.topBar.classList.remove('hud-hidden', 'hud-transient');
            mobileDock?.classList.remove('hud-hidden', 'hud-transient');
            if (this.hudTransientTimeout) {
                clearTimeout(this.hudTransientTimeout);
                this.hudTransientTimeout = null;
            }
            showToast('Top Bar Restored', 'info', 1500);
        }

        // Dispatch window resize event so AlphaTab and sheet layouts recalculate to full viewport height
        requestAnimationFrame(() => {
            window.dispatchEvent(new Event('resize'));
        });
    }

    /**
     * Temporarily peek the top bar when mouse/touch moves in Zen Mode
     */
    handlePointerActivity() {
        if (!this.isHudHidden || !this.topBar) return;

        const mobileDock = document.getElementById('mobilePlaybackDock');
        this.topBar.classList.add('hud-transient');
        mobileDock?.classList.add('hud-transient');
        if (this.hudTransientTimeout) {
            clearTimeout(this.hudTransientTimeout);
        }

        this.hudTransientTimeout = setTimeout(() => {
            if (this.isHudHidden && this.topBar) {
                this.topBar.classList.remove('hud-transient');
                mobileDock?.classList.remove('hud-transient');
            }
            this.hudTransientTimeout = null;
        }, 3200);
    }

    activateElement(el) {
        if (!el) return false;

        if (el.classList?.contains('btn-check') && el.nextElementSibling) {
            el.nextElementSibling.click();
            return true;
        }

        if (el.tagName === 'SELECT') {
            if (typeof el.showPicker === 'function') {
                try {
                    el.showPicker();
                    return true;
                } catch {}
            }
            el.click();
            return true;
        }

        if (el.matches?.('[data-bs-toggle="dropdown"]')) {
            el.click();
            setTimeout(() => {
                const parent = el.closest('.dropdown') || document;
                const firstItem = parent.querySelector('.dropdown-menu.show .dropdown-item:not(:disabled):not(.disabled)');
                if (firstItem) this.setNavFocus(firstItem);
            }, 30);
            return true;
        }

        if (el.classList?.contains('library-song-row')) {
            const playBtn = el.querySelector('.play-default-tab-btn');
            if (playBtn) {
                playBtn.click();
                return true;
            }
            // If the song has no tabs attached yet, open its "+ Tab" dropdown menu so the user can import one
            const dropdownToggle = el.querySelector('[data-bs-toggle="dropdown"]');
            if (dropdownToggle) {
                return this.activateElement(dropdownToggle);
            }
            el.click();
            return true;
        }

        if (el.classList?.contains('library-track-row')) {
            const addBtn = el.querySelector('.add-single-track-btn:not([disabled]):not(.disabled)');
            if (addBtn) {
                addBtn.click();
                return true;
            }
            el.click();
            return true;
        }

        if (el.dataset?.rowAction) {
            const actionBtn = el.querySelector(el.dataset.rowAction);
            if (actionBtn && !actionBtn.disabled && !actionBtn.classList.contains('disabled')) {
                actionBtn.click();
                return true;
            }
        }

        if (el.classList?.contains('library-row-card')) {
            const primaryBtn = el.querySelector('.open-recent-btn, .setlist-search-add-btn, .explore-artist-btn, .add-single-song-btn, .explore-band-albums-btn');
            if (primaryBtn && !primaryBtn.disabled && !primaryBtn.classList.contains('disabled')) {
                primaryBtn.click();
                return true;
            }
        }

        if (typeof el.click === 'function') {
            el.click();
            return true;
        }

        return false;
    }

    handleButtonA(isLibOpen, isModalOpen) {
        this.lastInputWasNavigation = true;
        const container = this.getActiveFocusContainer();

        if (isModalOpen || isLibOpen || (this.topBar && this.topBar.contains(document.activeElement))) {
            const activeEl = this.getCurrentFocusedElement(container);
            if (activeEl) {
                this.activateElement(activeEl);
                return;
            }

            const firstPrimary = this.getFirstPrimaryContentElement(container);
            if (firstPrimary) {
                this.setNavFocus(firstPrimary);
                this.activateElement(firstPrimary);
            }
            return;
        }

        // Score Playback Mode: Play / Pause audio
        const globalPlayPauseBtn = document.getElementById('globalPlayPauseBtn');
        if (globalPlayPauseBtn && !globalPlayPauseBtn.disabled) {
            globalPlayPauseBtn.click();
        } else {
            // Fallback: If neither player active, advance page
            document.getElementById('nextPage')?.click();
        }
    }

    handleButtonB(isLibOpen, isModalOpen) {
        this.lastInputWasNavigation = true;
        // Unified app back handler
        const handled = performAppBack();
        if (!handled && !isLibOpen) {
            // Return to library if no modal was open
            document.getElementById('topBarBackToLibraryBtn')?.click();
        }
    }

    handleButtonX(isLibOpen, isModalOpen) {
        if (isLibOpen) {
            // Focus library search input in the active library view
            const libPage = document.getElementById('libraryPage') || document;
            const searchInputs = Array.from(libPage.querySelectorAll('#libFilterInput, #mbSearchInput, #recentsFilterInput, #setlistsFilterInput, #setlistSongSearch, .search-input:not([disabled])'));
            const searchInput = searchInputs.find(el => this.isElementVisible(el));
            if (searchInput) {
                this.setNavFocus(searchInput);
                if (typeof searchInput.select === 'function') searchInput.select();
                // If SteamOS OSK is supported, invoke keyboard protocol
                if (window.__TAURI__ || navigator.userAgent.includes('Steam') || isSteamDeck()) {
                    try { window.open('steam://open/keyboard'); } catch {}
                }
            }
            return;
        }

        // Score Mode: Rewind 10 seconds / measure
        const rewindBtn = document.getElementById('globalRewindBtn');
        if (rewindBtn && !rewindBtn.disabled) {
            rewindBtn.click();
            showToast('Rewound 10s', 'info', 1200);
        }
    }

    cycleLibraryTab(delta) {
        const libPage = document.getElementById('libraryPage');
        if (!libPage) return;
        const tabs = Array.from(libPage.querySelectorAll('.lib-view-switch [data-lib-tab]')).filter(el => this.isElementVisible(el));
        if (!tabs.length) return;
        const activeIdx = tabs.findIndex(t => t.classList.contains('active'));
        let nextIdx = 0;
        if (activeIdx !== -1) {
            nextIdx = (activeIdx + delta + tabs.length) % tabs.length;
        } else {
            nextIdx = delta > 0 ? 0 : tabs.length - 1;
        }
        tabs[nextIdx]?.click();
    }

    handleButtonLB(isLibOpen, isModalOpen) {
        if (this.isHelpModalOpen()) {
            this.setControlsTab('keyboard');
            return;
        }
        if (isLibOpen && !isModalOpen) {
            this.cycleLibraryTab(-1);
            return;
        }
        // Score Mode: Previous page
        document.getElementById('prevPage')?.click();
    }

    handleButtonRB(isLibOpen, isModalOpen) {
        if (this.isHelpModalOpen()) {
            this.setControlsTab('gamepad');
            return;
        }
        if (isLibOpen && !isModalOpen) {
            this.cycleLibraryTab(1);
            return;
        }
        // Score Mode: Next page
        document.getElementById('nextPage')?.click();
    }

    handleButtonMenu(isLibOpen, isModalOpen) {
        if (isLibOpen) {
            // Only return to the currently loaded song if a tab is actually loaded and the return button is visible
            const returnBtn = document.getElementById('libraryReturnToSongBtn');
            if (returnBtn && this.isElementVisible(returnBtn)) {
                returnBtn.click();
            }
            return;
        }

        // Score Mode: Toggle notation / audio options dropdown
        const songTitleBtn = document.getElementById('topBarSongTitleBtn');
        if (songTitleBtn) {
            songTitleBtn.click();
        } else {
            // Open main offcanvas drawer
            document.getElementById('menuToggleBtn')?.click();
        }
    }

    handleDpadLeft(isLibOpen, isModalOpen) {
        if (this.isSpatialNavActive()) {
            this.navigateSpatial('left');
            return;
        }
        document.getElementById('prevPage')?.click();
    }

    handleDpadRight(isLibOpen, isModalOpen) {
        if (this.isSpatialNavActive()) {
            this.navigateSpatial('right');
            return;
        }
        document.getElementById('nextPage')?.click();
    }

    handleDpadUp(isLibOpen, isModalOpen) {
        if (this.isSpatialNavActive()) {
            this.navigateSpatial('up');
            return;
        }
        this.scrollActiveContainer(-140);
    }

    handleDpadDown(isLibOpen, isModalOpen) {
        if (this.isSpatialNavActive()) {
            this.navigateSpatial('down');
            return;
        }
        this.scrollActiveContainer(140);
    }

    isSpatialNavActive() {
        return this.isLibraryViewOpen() ||
               this.isAnyModalOpen() ||
               Boolean(this.topBar && this.topBar.contains(document.activeElement));
    }

    getActiveFocusContainer() {
        // 1. If a Bootstrap dropdown menu is open inside the page
        const openDropdown = Array.from(document.querySelectorAll('.dropdown-menu.show'))
            .find(el => this.isElementVisible(el));
        if (openDropdown) return openDropdown;

        // 2. If an offcanvas drawer is open (Menu / Settings)
        const openOffcanvas = document.querySelector('.offcanvas.show');
        if (openOffcanvas && this.isElementVisible(openOffcanvas)) return openOffcanvas;

        // 3. If a theme modal is open (e.g. Colorway finish picker, Controller guide, Tuner, etc.)
        const openBackdrops = Array.from(document.querySelectorAll('.theme-modal-backdrop'))
            .filter(el => (el.classList.contains('show') || el.style.display === 'flex' || el.style.display === 'block') && this.isElementVisible(el));
        if (openBackdrops.length > 0) {
            const topModal = openBackdrops[openBackdrops.length - 1];
            const modalCard = topModal.querySelector('.theme-modal-card');
            return modalCard || topModal;
        }

        // 4. If a top-bar popup panel (SoundFont, Notation Options, YouTube, Tools) is open
        for (const panelId of ['synthDropdownPanel', 'scoreOptionsDropdownPanel', 'ytDropdownPanel', 'toolsMenu']) {
            const panel = document.getElementById(panelId);
            if (panel && panel.style.display !== 'none' && this.isElementVisible(panel)) {
                return panel;
            }
        }

        // 5. If Tab Library is open
        const libPage = document.getElementById('libraryPage');
        if (libPage && libPage.style.display !== 'none') {
            return libPage;
        }

        return document;
    }

    getFocusableElements(container = document, currentActive = null, direction = null) {
        const selector = [
            '.library-song-row',
            '.library-card',
            '.library-row-card[tabindex="0"]',
            '.library-row-card.library-row-clickable',
            '.library-row-card[data-row-action]',
            '.library-pinned-card',
            '.library-track-row:not(.is-filtered-out)',
            '.tab-option-chip',
            '.open-file-dropzone',
            '.open-file-provider-item',
            '.theme-card',
            '.dropdown-menu.show .dropdown-item:not(:disabled):not(.disabled)',
            'button:not([disabled]):not([tabindex="-1"])',
            'a[href]:not([tabindex="-1"])',
            'input:not([type="hidden"]):not([disabled]):not([tabindex="-1"])',
            'select:not([disabled]):not([tabindex="-1"])',
            'textarea:not([disabled]):not([tabindex="-1"])',
            '[tabindex]:not([tabindex="-1"])'
        ].join(', ');

        const raw = Array.from(container.querySelectorAll(selector)).filter(el => this.isElementVisible(el));
        const activeParentRow = currentActive?.closest?.(COMPOSITE_ROW_SELECTOR) || null;
        const isHorizontal = direction === 'left' || direction === 'right';

        return raw.filter(el => {
            if (el === currentActive) return true;

            // Inside a .tab-option-chip, keep focus on the chip itself rather than its inner star icon
            const parentChip = el.closest?.('.tab-option-chip');
            if (parentChip && parentChip !== el) {
                return false;
            }

            // A .tab-option-chip inside a .library-song-row is only needed as a separate focus stop
            // when the song row has multiple tab options (with a single tab, activating the row plays it).
            if (el.classList?.contains('tab-option-chip')) {
                const parentSongRow = el.closest?.('.library-song-row');
                if (parentSongRow) {
                    const chips = parentSongRow.querySelectorAll('.tab-option-chip');
                    if (chips.length <= 1) return false;
                }
                return true;
            }

            // Check if el is an inner control inside a composite card/row
            const parentRow = el.closest?.(COMPOSITE_ROW_SELECTOR);
            if (parentRow && parentRow !== el) {
                // Exclude duplicate primary buttons whose action is already triggered by activating parentRow
                if (el.matches?.(DUPLICATE_ROW_ACTION_SELECTOR)) {
                    return false;
                }
                // Secondary action buttons inside a row (e.g. Pin, Add to Setlist, + Tab, Edit, Delete)
                // are only reachable via Left/Right while inside that specific row, never during Up/Down list navigation
                if (!isHorizontal || activeParentRow !== parentRow) {
                    return false;
                }
            }

            return true;
        });
    }

    /**
     * 2D Spatial Navigation:
     * Moves focus in 2D space (up, down, left, right) based on screen geometry (bounding client rects).
     */
    navigateSpatial(direction) {
        this.lastInputWasNavigation = true;
        const container = this.getActiveFocusContainer();
        const currentActive = this.getCurrentFocusedElement(container);
        const focusable = this.getFocusableElements(container, currentActive, direction);

        if (!focusable.length) return;

        const hasValidFocus = currentActive && focusable.includes(currentActive);

        if (!hasValidFocus) {
            const target = this.getFirstPrimaryContentElement(container) || focusable[0];
            this.setNavFocus(target);
            return;
        }

        const activeParentRow = currentActive.closest?.(COMPOSITE_ROW_SELECTOR);
        const isChildOfRow = Boolean(activeParentRow && activeParentRow !== currentActive && !currentActive.classList?.contains('tab-option-chip'));

        // Stepping Right from a full-width row (e.g. .library-song-row, .library-row-card) enters its secondary action buttons
        if (direction === 'right' && currentActive.matches?.('.library-song-row, .library-row-card')) {
            const innerButtons = focusable.filter(el => el !== currentActive && currentActive.contains(el) && !el.classList?.contains('tab-option-chip'));
            if (innerButtons.length > 0) {
                innerButtons.sort((a, b) => this.getFocusRect(a).left - this.getFocusRect(b).left);
                this.setNavFocus(innerButtons[0]);
                return;
            }
        }

        // Stepping Left from a row's secondary action button steps to the previous button in that row, or back onto the row itself
        if (direction === 'left' && isChildOfRow) {
            const curRect = this.getFocusRect(currentActive);
            const siblingsLeft = focusable
                .filter(el => el !== currentActive && el !== activeParentRow && activeParentRow.contains(el) && !el.classList?.contains('tab-option-chip'))
                .filter(el => this.getFocusRect(el).right <= curRect.left + 4)
                .sort((a, b) => this.getFocusRect(b).left - this.getFocusRect(a).left);
            if (siblingsLeft.length > 0) {
                this.setNavFocus(siblingsLeft[0]);
            } else {
                this.setNavFocus(activeParentRow);
            }
            return;
        }

        // When pressing Up or Down while focused on a secondary button inside a row, navigate from the row itself
        const referenceEl = ((direction === 'up' || direction === 'down') && isChildOfRow) ? activeParentRow : currentActive;
        const curRect = this.getFocusRect(referenceEl);
        const curCx = curRect.left + curRect.width / 2;
        const curCy = curRect.top + curRect.height / 2;

        let bestElement = null;
        let minScore = Infinity;

        for (const cand of focusable) {
            if (cand === currentActive || cand === referenceEl) continue;

            // When navigating Left/Right inside a row's secondary buttons, stay within that row
            if ((direction === 'left' || direction === 'right') && isChildOfRow && !activeParentRow.contains(cand)) {
                continue;
            }
            // Do not navigate from a parent card/row into its own inner buttons unless handled above
            if ((direction === 'left' || direction === 'right') && !isChildOfRow && referenceEl.contains?.(cand) && !cand.classList?.contains('tab-option-chip')) {
                continue;
            }

            const r = this.getFocusRect(cand);
            if (r.width <= 0 || r.height <= 0) continue;

            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;

            let isCandidate = false;
            let primaryDist = 0;
            let crossDist = 0;

            if (direction === 'down') {
                if (r.top >= curRect.top + 4 && cy > curCy + 4) {
                    isCandidate = true;
                    primaryDist = r.top >= curRect.bottom ? (r.top - curRect.bottom) : (cy - curCy);
                    const overlapX = Math.max(0, Math.min(curRect.right, r.right) - Math.max(curRect.left, r.left));
                    if (overlapX > 0) {
                        crossDist = Math.abs(cx - curCx) * 0.35;
                    } else {
                        const xGap = r.left >= curRect.right ? (r.left - curRect.right) : (curRect.left - r.right);
                        crossDist = xGap * 1.8 + Math.abs(cx - curCx) * 0.25;
                    }
                }
            } else if (direction === 'up') {
                if (r.bottom <= curRect.bottom - 4 && cy < curCy - 4) {
                    isCandidate = true;
                    primaryDist = curRect.top >= r.bottom ? (curRect.top - r.bottom) : (curCy - cy);
                    const overlapX = Math.max(0, Math.min(curRect.right, r.right) - Math.max(curRect.left, r.left));
                    if (overlapX > 0) {
                        crossDist = Math.abs(cx - curCx) * 0.35;
                    } else {
                        const xGap = r.left >= curRect.right ? (r.left - curRect.right) : (curRect.left - r.right);
                        crossDist = xGap * 1.8 + Math.abs(cx - curCx) * 0.25;
                    }
                }
            } else if (direction === 'right') {
                const overlapY = Math.max(0, Math.min(curRect.bottom, r.bottom) - Math.max(curRect.top, r.top));
                const yGap = r.top >= curRect.bottom ? (r.top - curRect.bottom) : (curRect.top >= r.bottom ? (curRect.top - r.bottom) : 0);
                // Keep horizontal navigation within the same horizontal band so Left/Right never teleports to distant headers
                if (r.left >= curRect.left + 4 && cx > curCx && (overlapY > 0 || yGap <= 24)) {
                    isCandidate = true;
                    primaryDist = r.left >= curRect.right ? (r.left - curRect.right) : (cx - curCx);
                    crossDist = overlapY > 0 ? Math.abs(cy - curCy) * 0.4 : yGap * 2.5;
                }
            } else if (direction === 'left') {
                const overlapY = Math.max(0, Math.min(curRect.bottom, r.bottom) - Math.max(curRect.top, r.top));
                const yGap = r.top >= curRect.bottom ? (r.top - curRect.bottom) : (curRect.top >= r.bottom ? (curRect.top - r.bottom) : 0);
                if (r.right <= curRect.right - 4 && cx < curCx && (overlapY > 0 || yGap <= 24)) {
                    isCandidate = true;
                    primaryDist = curRect.left >= r.right ? (curRect.left - r.right) : (curCx - cx);
                    crossDist = overlapY > 0 ? Math.abs(cy - curCy) * 0.4 : yGap * 2.5;
                }
            }

            if (isCandidate) {
                const score = primaryDist + crossDist;
                if (score < minScore) {
                    minScore = score;
                    bestElement = cand;
                }
            }
        }

        // If pressing Right on a card (e.g. .library-pinned-card, .tuning-card) with no card to its right,
        // allow stepping into its secondary action button if it has one
        if (!bestElement && direction === 'right' && !isChildOfRow) {
            const innerButtons = focusable.filter(el => el !== currentActive && currentActive.contains(el) && !el.classList?.contains('tab-option-chip'));
            if (innerButtons.length > 0) {
                innerButtons.sort((a, b) => this.getFocusRect(a).left - this.getFocusRect(b).left);
                bestElement = innerButtons[0];
            }
        }

        if (bestElement) {
            this.setNavFocus(bestElement);
        }
    }

    navigateFocus(direction) {
        const container = this.getActiveFocusContainer();
        const currentActive = this.getCurrentFocusedElement(container);
        const focusable = this.getFocusableElements(container, currentActive);

        if (!focusable.length) return;

        const currentIdx = focusable.indexOf(currentActive);
        let nextIdx = 0;
        if (currentIdx !== -1) {
            nextIdx = (currentIdx + direction + focusable.length) % focusable.length;
        } else {
            nextIdx = direction > 0 ? 0 : focusable.length - 1;
        }

        const targetEl = focusable[nextIdx];
        if (targetEl) {
            this.setNavFocus(targetEl);
        }
    }

    toggleViewMode() {
        const pageModeRadio = document.getElementById('pageModeRadio');
        const continuousModeRadio = document.getElementById('continuousModeRadio');
        if (!pageModeRadio || !continuousModeRadio) return;

        if (pageModeRadio.checked) {
            continuousModeRadio.click();
            showToast('Continuous Scroll Mode', 'info', 1500);
        } else {
            pageModeRadio.click();
            showToast('Page View Mode', 'info', 1500);
        }
    }

    adjustZoom(isZoomIn) {
        const plusBtn = document.getElementById('gpSheetScalePlus');
        const minusBtn = document.getElementById('gpSheetScaleMinus');
        const scaleVal = document.getElementById('gpSheetScaleValue');

        if (isZoomIn) {
            plusBtn?.click();
        } else {
            minusBtn?.click();
        }

        if (scaleVal) {
            showToast(`Scale: ${scaleVal.textContent}`, 'info', 900);
        }
    }

    resetZoom() {
        const scaleInput = document.getElementById('gpSheetScale');
        if (scaleInput) {
            scaleInput.value = '100';
            scaleInput.dispatchEvent(new Event('input', { bubbles: true }));
            scaleInput.dispatchEvent(new Event('change', { bubbles: true }));
            showToast('Zoom reset to 100%', 'info', 1200);
        }
    }

    cycleAudioSource() {
        const synthBtn = document.getElementById('synthToggleBtn');
        const ytBtn = document.getElementById('ytToggleBtn');

        const synthVisible = synthBtn && synthBtn.style.display !== 'none';
        const ytVisible = ytBtn && ytBtn.style.display !== 'none';

        if (synthVisible && ytVisible) {
            // Both available, toggle between them
            const isSynthActive = synthBtn.classList.contains('active');
            if (isSynthActive) {
                ytBtn.click();
                showToast('Switched to YouTube Audio', 'info', 1500);
            } else {
                synthBtn.click();
                showToast('Switched to MIDI Synth Audio', 'info', 1500);
            }
        } else if (synthVisible) {
            synthBtn.click();
        } else if (ytVisible) {
            ytBtn.click();
        }
    }

    // --- Modal Controls ---

    isAnyModalOpen() {
        const openDropdown = Array.from(document.querySelectorAll('.dropdown-menu.show'))
            .some(el => this.isElementVisible(el));
        if (openDropdown) return true;

        const openBackdrops = Array.from(document.querySelectorAll('.theme-modal-backdrop'))
            .some(el => (el.classList.contains('show') || el.style.display === 'flex' || el.style.display === 'block') && this.isElementVisible(el));
        if (openBackdrops) return true;

        const openOffcanvas = document.querySelector('.offcanvas.show');
        if (openOffcanvas && this.isElementVisible(openOffcanvas)) return true;

        for (const panelId of ['synthDropdownPanel', 'scoreOptionsDropdownPanel', 'ytDropdownPanel', 'toolsMenu']) {
            const panel = document.getElementById(panelId);
            if (panel && panel.style.display !== 'none' && this.isElementVisible(panel)) {
                return true;
            }
        }

        return false;
    }

    isHelpModalOpen() {
        return Boolean(this.controllerModal && this.controllerModal.style.display === 'flex');
    }

    isLibraryViewOpen() {
        const libPage = document.getElementById('libraryPage');
        return Boolean(libPage && libPage.style.display !== 'none');
    }

    setControlsTab(tab) {
        if (!this.controllerModal) {
            this.controllerModal = document.getElementById('controllerHelpModal');
        }
        if (!this.controllerModal) return;
        const value = tab === 'gamepad' ? 'gamepad' : 'keyboard';
        this.controllerModal.dataset.controlsTab = value;
        const radio = document.getElementById(value === 'gamepad' ? 'controlsTabGamepad' : 'controlsTabKeyboard');
        if (radio) radio.checked = true;
    }

    openHelpModal(tab) {
        if (!this.controllerModal) {
            this.controllerModal = document.getElementById('controllerHelpModal');
        }
        if (!this.controllerModal) return;

        this.setControlsTab(tab || (this.controllerModal.dataset.controlsTab) || 'keyboard');

        this.controllerModal.classList.add('show');
        this.controllerModal.style.display = 'flex';
        document.body.classList.add('modal-open');
    }

    closeHelpModal() {
        if (!this.controllerModal) {
            this.controllerModal = document.getElementById('controllerHelpModal');
        }
        if (!this.controllerModal) return;

        this.controllerModal.classList.remove('show');
        this.controllerModal.style.display = 'none';
        document.body.classList.remove('modal-open');
    }

    toggleHelpModal(tab) {
        if (this.isHelpModalOpen()) {
            this.closeHelpModal();
        } else {
            this.openHelpModal(tab);
        }
    }
}

// Singleton instance
export const gamepadManager = new GamepadManager();

export function initGamepadManager() {
    gamepadManager.init();
    return gamepadManager;
}
