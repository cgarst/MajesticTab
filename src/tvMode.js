// Android TV runs the regular APK; MainActivity exposes AndroidTv.isTelevision() on the app webview.
// The TV is already fullscreen, so the root flag also keeps the Fullscreen control hidden everywhere.

let tv = false;
try {
    tv = Boolean(window.AndroidTv?.isTelevision?.());
} catch {
    tv = false;
}

if (tv) {
    document.documentElement.classList.add('tv-mode', 'fullscreen-unavailable');
}

export function isTvMode() {
    return tv;
}
