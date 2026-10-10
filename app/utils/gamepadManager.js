// gamepadManager.js
// Cross-platform game controller manager for MajesticTab (Web, Tauri Linux / Steam Deck, Windows, macOS).
// Uses the W3C Gamepad API with standard XInput / Xbox / Steam Deck controller layout.

import { showToast } from './toast.js';
import { performAppBack } from './navigationUtils.js';

// Controller configuration constants
const STICK_DEADZONE = 0.18;
const TRIGGER_THRESHOLD = 0.15;
const BUTTON_REPEAT_DELAY_MS = 360;
const BUTTON_REPEAT_INTERVAL_MS = 90;
const ZOOM_REPEAT_INTERVAL_MS = 200;

// Standard Gamepad button indexes (W3C standard mapping)
export const GamepadButton = {
    A: 0,
    B: 1,
    X: 2,
    Y: 3,
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
        this.viewButtonPressedAt = 0;
        this.lastZoomTime = 0;

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
        window.addEventListener('touchstart', () => this.handlePointerActivity(), { passive: true });

        // Setup close button on Controller Help Modal
        const closeBtn = document.getElementById('controllerHelpModalCloseBtn');
        closeBtn?.addEventListener('click', () => this.closeHelpModal());
        const modalBackdrop = document.getElementById('controllerHelpModal');
        modalBackdrop?.addEventListener('click', (e) => {
            if (e.target === modalBackdrop) this.closeHelpModal();
        });

        // Top bar pill trigger
        const pillBtn = document.getElementById('controllerHelpBtn');
        pillBtn?.addEventListener('click', () => this.toggleHelpModal());

        // Drawer menu trigger
        const drawerBtn = document.getElementById('openControllerHelpMenuBtn');
        drawerBtn?.addEventListener('click', () => {
            // Dismiss offcanvas drawer first if needed
            const fileMenu = document.getElementById('fileMenu');
            if (fileMenu) {
                const offcanvas = window.bootstrap?.Offcanvas?.getInstance?.(fileMenu);
                offcanvas?.hide();
            }
            this.openHelpModal();
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
                this.openHelpModal();
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
            const isDown = typeof btn === 'object' ? btn.pressed : btn > 0.5;
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
                GamepadButton.RB
            ];
            if (!repeatable.includes(buttonIndex)) return;
        }

        const isModalOpen = this.isAnyModalOpen();
        const isHelpOpen = this.isHelpModalOpen();
        const isLibOpen = this.isLibraryViewOpen();

        // If Help modal is open, B or Y or Menu dismisses it
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
                    // In Library mode, Y toggles Top Bar or triggers item actions
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
                this.handleButtonLB(isLibOpen, isModalOpen);
                break;

            case GamepadButton.RB:
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
                this.handleDpadLeft(isLibOpen);
                break;

            case GamepadButton.DPAD_RIGHT:
                this.handleDpadRight(isLibOpen);
                break;

            case GamepadButton.DPAD_UP:
                this.handleDpadUp(isLibOpen);
                break;

            case GamepadButton.DPAD_DOWN:
                this.handleDpadDown(isLibOpen);
                break;
        }
    }

    handleButtonRelease(buttonIndex, pressedAt, now) {
        const duration = now - pressedAt;

        // View (Back/Select): Long press (>400ms) opens Help Diagram; Quick tap cycles audio source
        if (buttonIndex === GamepadButton.VIEW) {
            if (duration >= 400) {
                this.toggleHelpModal();
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
        const rightX = axes.length >= 4 ? axes[2] || 0 : 0;
        const rightY = axes.length >= 4 ? axes[3] || 0 : 0;

        // Check Left Stick for continuous smooth scroll
        const leftMag = Math.hypot(leftX, leftY);
        if (leftMag > STICK_DEADZONE) {
            // Apply quadratic curve for precision low-speed and fast high-speed panning
            const normalizedY = (Math.abs(leftY) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
            const signY = Math.sign(leftY);
            const triggerBoost = this.getTriggerScrollMultiplier(gp);
            const scrollDelta = signY * Math.pow(normalizedY, 1.8) * 18 * triggerBoost;

            this.scrollActiveContainer(scrollDelta);
        }

        // Check Right Stick Y for score zoom in/out
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

        if (this.isHudHidden) {
            this.topBar.classList.add('hud-hidden');
            this.topBar.classList.remove('hud-transient');
            showToast('Top Bar Hidden (Zen Mode) — Press (Y) to restore', 'info', 2000);
        } else {
            this.topBar.classList.remove('hud-hidden', 'hud-transient');
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

        this.topBar.classList.add('hud-transient');
        if (this.hudTransientTimeout) {
            clearTimeout(this.hudTransientTimeout);
        }

        this.hudTransientTimeout = setTimeout(() => {
            if (this.isHudHidden && this.topBar) {
                this.topBar.classList.remove('hud-transient');
            }
            this.hudTransientTimeout = null;
        }, 3200);
    }

    handleButtonA(isLibOpen, isModalOpen) {
        if (isModalOpen) {
            const activeEl = document.activeElement;
            if (activeEl && typeof activeEl.click === 'function' && activeEl !== document.body) {
                activeEl.click();
            }
            return;
        }

        if (isLibOpen) {
            const focusedCard = document.querySelector('.library-song-row:focus, .library-card:focus, .library-track-row:focus');
            if (focusedCard) {
                focusedCard.click();
                return;
            }
            // If nothing focused, click the first available song row
            const firstRow = document.querySelector('.library-song-row, .library-card');
            firstRow?.click();
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
        // Unified app back handler
        const handled = performAppBack();
        if (!handled && !isLibOpen) {
            // Return to library if no modal was open
            document.getElementById('topBarBackToLibraryBtn')?.click();
        }
    }

    handleButtonX(isLibOpen, isModalOpen) {
        if (isLibOpen) {
            // Focus library search
            const searchInput = document.getElementById('libSearchInput') || document.getElementById('libUnifiedInput');
            if (searchInput) {
                searchInput.focus();
                // If SteamOS OSK is supported, invoke keyboard protocol
                if (window.__TAURI__ || navigator.userAgent.includes('Steam')) {
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

    handleButtonLB(isLibOpen, isModalOpen) {
        if (isLibOpen) {
            document.getElementById('navBtnLibrary')?.click();
            return;
        }
        // Score Mode: Previous page
        document.getElementById('prevPage')?.click();
    }

    handleButtonRB(isLibOpen, isModalOpen) {
        if (isLibOpen) {
            document.getElementById('navBtnRecents')?.click();
            return;
        }
        // Score Mode: Next page
        document.getElementById('nextPage')?.click();
    }

    handleButtonMenu(isLibOpen, isModalOpen) {
        if (isLibOpen) {
            // Return to currently loaded song if available
            document.getElementById('libraryReturnToSongBtn')?.click();
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

    handleDpadLeft(isLibOpen) {
        if (isLibOpen) return;
        document.getElementById('prevPage')?.click();
    }

    handleDpadRight(isLibOpen) {
        if (isLibOpen) return;
        document.getElementById('nextPage')?.click();
    }

    handleDpadUp(isLibOpen) {
        if (isLibOpen) {
            this.navigateFocusVertical(-1);
            return;
        }
        this.scrollActiveContainer(-140);
    }

    handleDpadDown(isLibOpen) {
        if (isLibOpen) {
            this.navigateFocusVertical(1);
            return;
        }
        this.scrollActiveContainer(140);
    }

    navigateFocusVertical(direction) {
        const focusable = Array.from(document.querySelectorAll(
            '.library-song-row, .library-card, .library-track-row, button:not([disabled]):not([style*="display: none"]), input:not([type="hidden"])'
        )).filter(el => el.offsetParent !== null);

        if (!focusable.length) return;

        const currentIdx = focusable.indexOf(document.activeElement);
        let nextIdx = 0;
        if (currentIdx !== -1) {
            nextIdx = Math.max(0, Math.min(focusable.length - 1, currentIdx + direction));
        }
        focusable[nextIdx]?.focus({ preventScroll: false });
        focusable[nextIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
        const openBackdrops = Array.from(document.querySelectorAll('.theme-modal-backdrop'))
            .some(el => el.style.display === 'flex' || el.style.display === 'block');
        const openOffcanvas = !!document.querySelector('.offcanvas.show');
        return openBackdrops || openOffcanvas;
    }

    isHelpModalOpen() {
        return this.controllerModal && this.controllerModal.style.display === 'flex';
    }

    isLibraryViewOpen() {
        const libPage = document.getElementById('libraryPage');
        return libPage && libPage.style.display !== 'none';
    }

    openHelpModal() {
        if (!this.controllerModal) {
            this.controllerModal = document.getElementById('controllerHelpModal');
        }
        if (!this.controllerModal) return;

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

    toggleHelpModal() {
        if (this.isHelpModalOpen()) {
            this.closeHelpModal();
        } else {
            this.openHelpModal();
        }
    }
}

// Singleton instance
export const gamepadManager = new GamepadManager();

export function initGamepadManager() {
    gamepadManager.init();
    return gamepadManager;
}
