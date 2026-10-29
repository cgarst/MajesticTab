// Build channel capabilities. Store builds ship a channel.json (written by prepare-tauri-frontend.mjs
// from build/channels.mjs). With no file (web build, ?test= dev server) the defaults below apply.

const DEFAULTS = {
    channel: 'web',
    tabDownloader: 'google-only',
    userscripts: true,
    extensions: 'full',
    selfUpdate: true,
    googleDrive: true,
    youtube: 'full',
    monetization: 'none',
    supporterProductId: null,
    storeName: null,
    supporterManageUrl: null,
    supporterFeatures: []
};

let config = { ...DEFAULTS };
let supporterOwned = false;

// Store reviewers can't buy anything, so a review code (see supporter.js) unlocks Supporter locally.
const REVIEW_UNLOCK_KEY = 'majestictab_review_unlock';
let reviewUnlocked = false;
try {
    reviewUnlocked = localStorage.getItem(REVIEW_UNLOCK_KEY) === '1';
} catch {}

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
    return config.monetization !== 'iap' || supporterOwned || reviewUnlocked;
}

/** Called by the native purchase bridge (StoreKit / Play Billing) on launch and on entitlement changes. */
export function setSupporterOwned(owned) {
    const next = Boolean(owned);
    if (next === supporterOwned) return;
    supporterOwned = next;
    window.dispatchEvent(new CustomEvent('supporterchange', { detail: { owned: next } }));
}

export function isReviewUnlocked() {
    return reviewUnlocked;
}

/** Grant or remove the local review unlock. Persists across launches until removed. */
export function setReviewUnlocked(on) {
    const next = Boolean(on);
    if (next === reviewUnlocked) return;
    reviewUnlocked = next;
    try {
        if (next) localStorage.setItem(REVIEW_UNLOCK_KEY, '1');
        else localStorage.removeItem(REVIEW_UNLOCK_KEY);
    } catch {}
    window.dispatchEvent(new CustomEvent('supporterchange', { detail: { owned: hasSupporter() } }));
}

export function isSupporterFeature(name) {
    return config.supporterFeatures.includes(name);
}
