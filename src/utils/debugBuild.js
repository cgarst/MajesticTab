// debugBuild.js
// Whether this is a debug build: the native shell built with the `debug-tools` feature (`npm run tauri:dev -- --features
// debug-tools`). Release builds, the web app, Android and iOS are not. The native command answers false everywhere
// but a desktop debug build, and does not exist outside the native shell.

let cached = null;

/** @returns {Promise<boolean>} */
export function isDebugBuild() {
    cached ||= (async () => {
        const invoke = window.__TAURI__?.core?.invoke;
        if (!invoke) return false;
        try { return (await invoke('is_debug_tools_enabled')) === true; } catch { return false; }
    })();
    return cached;
}

/**
 * Settings: the "Debug PDF Overlay" switch is shown, and takes its saved value, only in a debug build. Until that is
 * known (and always elsewhere) it is off, so a saved or restored flag never draws the overlay in a release build.
 */
export async function applyDebugOverlaySetting() {
    const input = document.getElementById('debugMode');
    const row = input?.closest('.form-check');
    if (!input || !row) return;
    if (await isDebugBuild()) {
        input.checked = localStorage.getItem('debugMode') === 'true';
        row.hidden = false;
    } else {
        input.checked = false;
        row.hidden = true;
    }
}
