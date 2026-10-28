// Build channel capabilities. Store builds ship a channel.json (written by prepare-tauri-frontend.mjs
// from build/channels.mjs). With no file (web build, ?test= dev server) everything is on.

const DEFAULTS = {
    channel: 'web',
    tabDownloader: 'full',
    userscripts: true,
    extensions: 'full',
    selfUpdate: true,
    googleDrive: true,
    youtube: 'full',
    monetization: 'none',
    supporterProductId: null,
    supporterFeatures: []
};

let config = { ...DEFAULTS };
let supporterOwned = false;

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

/**
 * Whether a Supporter-gated feature is available. Channels without monetization have everything
 * unlocked; on 'iap' channels it needs the native purchase bridge to report ownership.
 */
export function hasSupporter() {
    return config.monetization !== 'iap' || supporterOwned;
}

/** Called by the native purchase bridge (StoreKit / Play Billing) on launch and on entitlement changes. */
export function setSupporterOwned(owned) {
    const next = Boolean(owned);
    if (next === supporterOwned) return;
    supporterOwned = next;
    window.dispatchEvent(new CustomEvent('supporterchange', { detail: { owned: next } }));
}

export function isSupporterFeature(name) {
    return config.supporterFeatures.includes(name);
}
