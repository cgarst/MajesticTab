// Quit is offered in the native desktop apps (Windows, macOS, Linux). Phones and the web have nothing to quit.
import { isIOSDevice } from './iosAudioUnlock.js';

export function canQuitApp() {
    return Boolean(window.__TAURI__) && !isIOSDevice() && !/Android/i.test(navigator.userAgent);
}
