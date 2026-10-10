// platformUtils.js
// Cross-platform detection and platform-specific defaults (Steam Deck / SteamOS, macOS, Windows, Linux, Android)

let _isSteamDeckCached = null;

/**
 * Detect if running on Steam Deck / SteamOS / gamescope environment
 * @returns {boolean}
 */
export function isSteamDeck() {
    if (_isSteamDeckCached !== null) return _isSteamDeckCached;
    if (typeof document !== 'undefined' && document.documentElement?.classList?.contains('tauri-gamescope')) {
        _isSteamDeckCached = true;
        return true;
    }
    if (typeof navigator !== 'undefined') {
        if (/steam/i.test(navigator.userAgent)) {
            _isSteamDeckCached = true;
            return true;
        }
        if (typeof navigator.getGamepads === 'function') {
            try {
                const gamepads = navigator.getGamepads();
                if (gamepads && Array.from(gamepads).some(gp => gp && /steam/i.test(gp.id))) {
                    _isSteamDeckCached = true;
                    return true;
                }
            } catch {}
        }
    }
    return false;
}

/**
 * Manually set or override the Steam Deck environment state (useful for tests or runtime detection)
 * @param {boolean|null} val 
 */
export function setIsSteamDeck(val) {
    _isSteamDeckCached = val;
}

/**
 * Get the platform default view mode for a given file type ('page' vs 'continuous')
 * On Steam Deck: all file types default to 'page' mode.
 * On Desktop: GP and TXT default to 'continuous', PDF defaults to 'page'.
 * @param {string} fileType - 'gp', 'txt', 'pdf', etc.
 * @returns {string} 'page' or 'continuous'
 */
export function getDefaultView(fileType) {
    if (isSteamDeck()) return 'page';
    return fileType === 'pdf' ? 'page' : 'continuous';
}

/**
 * Get the platform default landscape page layout ('single' for 1 page, 'dual' for 2 pages)
 * On Steam Deck: defaults to 'single' (1 page) for handheld screen reading.
 * On Desktop: defaults to 'dual' (2 pages side-by-side).
 * @returns {string} 'single' or 'dual'
 */
export function getDefaultLandscapePageLayout() {
    return isSteamDeck() ? 'single' : 'dual';
}

/**
 * Apply platform-specific defaults to localStorage on initial launch/install if not already customized
 */
export function applyPlatformDefaults() {
    if (isSteamDeck()) {
        try {
            if (localStorage.getItem('gpDefaultView') === null) {
                localStorage.setItem('gpDefaultView', 'page');
            }
            if (localStorage.getItem('txtDefaultView') === null) {
                localStorage.setItem('txtDefaultView', 'page');
            }
            if (localStorage.getItem('pdfDefaultView') === null) {
                localStorage.setItem('pdfDefaultView', 'page');
            }
            if (localStorage.getItem('landscapePageLayout') === null) {
                localStorage.setItem('landscapePageLayout', 'single');
            }
        } catch {}
    }
}
