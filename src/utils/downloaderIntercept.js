// utils/downloaderIntercept.js
// Handles pattern-based link interception, dynamic downloader URL construction,
// input pre-filling, and sync point population for tab downloads.

const SONG_ID_PATTERN = /(?:-|\/)s(\d+)(?=\/|$)/i;

/**
 * Extracts target URL if wrapped in a search engine or proxy redirect
 * (e.g. Google /url?q=..., DuckDuckGo /l/?uddg=..., or generic ?url=...)
 * @param {string} rawUrl
 * @returns {string}
 */
export function unwrapRedirectUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
        const u = new URL(rawUrl);
        // Check standard redirect query parameters used by Google, DuckDuckGo, Yahoo, and proxies
        for (const key of ['q', 'url', 'uddg', 'target', 'dest', 'u', 'r']) {
            const val = u.searchParams.get(key);
            if (val && /^https?:/i.test(val)) {
                return val;
            }
        }
    } catch {}
    return rawUrl;
}

// Backward-compatible alias
export const unwrapGoogleUrl = unwrapRedirectUrl;

/**
 * Checks if a URL matches the target score endpoint pattern (/a/wsa/*-s{id})
 * @param {string} url
 * @returns {boolean}
 */
export function isWsaTabUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const u = new URL(unwrapGoogleUrl(url));
        return u.pathname.startsWith('/a/wsa/') && SONG_ID_PATTERN.test(u.pathname);
    } catch {
        return false;
    }
}

/**
 * Dynamically derives the downloader URL by injecting the domain label into -downloader.com
 * e.g. a /a/wsa/ page on host "www.<name>.com" maps to host "www.<name>-downloader.com" (no full URLs here: the Tauri build rejects unapproved hosts, even in comments)
 * @param {string} targetUrl
 * @returns {string|null}
 */
export function getDownloaderUrlFromMatchedUrl(targetUrl) {
    try {
        const u = new URL(unwrapGoogleUrl(targetUrl));
        const host = u.hostname.replace(/^www\./i, '').toLowerCase();
        const parts = host.split('.');
        // Extract primary domain name (handle multi-part TLDs like .co.uk if present)
        let label = parts[0];
        if (parts.length > 2 && (parts[parts.length - 2] === 'co' || parts[parts.length - 2] === 'com')) {
            label = parts[parts.length - 3] || parts[0];
        } else if (parts.length > 1) {
            label = parts[parts.length - 2];
        }
        if (!label) return null;
        return `https://www.${label}-downloader.com/`;
    } catch {
        return null;
    }
}

export const VIEWPORT_OPTIMIZER_USERSCRIPT = `(function() {
    if (window !== window.top) return;

    const CLEANUP_STYLE_ID = 'mt-view-optimizer-style';
    const OVERLAY_SELECTOR = '.is_sticky_player, [class*="is_sticky_player"], [class*="sticky_player"], #pro-player-scroll-container, [id*="pro-player"], [class*="BottomControls-fixed"], [class*="styles-containerWrapper"]';

    function ensureStyle() {
        if (!document.getElementById(CLEANUP_STYLE_ID)) {
            const parent = document.head || document.body || document.documentElement;
            if (parent) {
                const style = document.createElement('style');
                style.id = CLEANUP_STYLE_ID;
                style.textContent = OVERLAY_SELECTOR + ' { display: none !important; }';
                parent.appendChild(style);
            }
        }
    }

    function runCleanup() {
        ensureStyle();

        const overlayNodes = document.querySelectorAll(OVERLAY_SELECTOR);
        if (overlayNodes.length > 0) {
            overlayNodes.forEach(node => {
                try {
                    const box = node.closest('.is_sticky_player') || node.closest('[class*="sticky_player"]') || node;
                    box.remove();
                } catch (_) {}
            });
        }
    }

    ensureStyle();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runCleanup);
    } else {
        runCleanup();
    }
    window.addEventListener('load', runCleanup);

    setInterval(runCleanup, 300);

    try {
        const observer = new MutationObserver(() => runCleanup());
        const root = document.documentElement || document.body;
        if (root) {
            observer.observe(root, { childList: true, subtree: true });
        }
    } catch (_) {}
})();`;

/**
 * Generates an in-page userscript that populates the input field with targetUrl
 * without triggering submission or clicking any download buttons.
 * @param {string} targetUrl
 * @returns {string}
 */
export function buildPrefillUserscript(targetUrl) {
    const jsonTarget = JSON.stringify(targetUrl);
    return `(function() {
    function tryFill() {
        const input = document.querySelector('input[type="text"], input:not([type])');
        if (!input) return false;
        if (input.value === ${jsonTarget}) return true;
        input.value = ${jsonTarget};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
    if (!tryFill()) {
        const observer = new MutationObserver(() => {
            if (tryFill()) observer.disconnect();
        });
        if (document.documentElement || document.body) {
            observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
        }
        setTimeout(() => observer.disconnect(), 10000);
    }
})();`;
}

/**
 * Fetches sync points for the matched score URL and attaches them to the opened score.
 * @param {string} matchedUrl
 * @param {object} [options]
 * @param {Function} [options.showToast]
 * @param {Function} [options.loadFromUrlFn]
 * @param {Function} [options.attachSyncSetsFn]
 * @returns {Promise<{saved: string[], skipped: string[]}>}
 */
export async function attachSyncForMatchedUrl(matchedUrl, { showToast = null, loadFromUrlFn = null, attachSyncSetsFn = null } = {}) {
    if (!matchedUrl) return { saved: [], skipped: [] };
    try {
        const load = loadFromUrlFn || (await import('../audioSync/importers/index.js')).loadFromUrl;
        const { fetchText } = await import('../urlImport/openFromUrl.js');
        const sets = await load(matchedUrl, fetchText);
        if (!sets?.length) return { saved: [], skipped: ['No sync points found in source'] };

        const attach = attachSyncSetsFn || (await import('../urlImport/attachSync.js')).attachSyncSets;
        const result = await attach(sets);
        if (result?.saved?.length && typeof showToast === 'function') {
            showToast(`Added sync points for ${result.saved.length === 1 ? result.saved[0] : `${result.saved.length} videos`}`, 'success');
        }
        return result;
    } catch (e) {
        console.warn('[Tab Downloader] Auto-sync points error:', e);
        return { saved: [], skipped: [e?.message || 'Failed to fetch sync points'] };
    }
}
