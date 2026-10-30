// Build channel capabilities. Store builds ship a channel.json (written by prepare-tauri-frontend.mjs
// from build/channels.mjs). With no file (web build, ?test= dev server) the defaults below apply.

const DEFAULTS = {
    channel: 'web',
    tabDownloader: 'google-only',
    userscripts: true,
    extensions: 'full',
    selfUpdate: true,
    googleDrive: true,
    youtube: 'full'
};

let config = { ...DEFAULTS };
try {
    const response = await fetch('./channel.json', { cache: 'no-store' });
    if (response.ok) config = { ...DEFAULTS, ...(await response.json()) };
    else if (window.__TAURI__) config.selfUpdate = false;
} catch {
    // No channel.json: keep defaults, except that a native build never assumes it may self-update.
    if (window.__TAURI__) config.selfUpdate = false;
}

export function getChannel() {
    return config.channel;
}

export function getFeature(name) {
    return config[name];
}

/** True when the capability is on: not false, 'off' or 'none'. */
export function hasFeature(name) {
    const value = config[name];
    return value !== false && value !== 'off' && value !== 'none' && value != null;
}
