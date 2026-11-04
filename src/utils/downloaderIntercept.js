// utils/downloaderIntercept.js
// Handles pattern-based link interception, dynamic downloader URL construction,
// input pre-filling, and sync point population for tab downloads.

const SONG_ID_PATTERN = /(?:-|\/)s(\d+)(?=\/|$)/i;

/**
 * Extracts target URL if wrapped in a known search engine or proxy redirect endpoint
 * (e.g. Google /url?q=..., DuckDuckGo /l/?uddg=..., or generic /url?url=...)
 * @param {string} rawUrl
 * @returns {string}
 */
export function unwrapRedirectUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
        const u = new URL(rawUrl);
        const host = u.hostname.toLowerCase();
        const path = u.pathname.toLowerCase();

        // 1. Google redirect wrapper: ONLY on /url endpoint
        if (host.includes('google.') && (path === '/url' || path.startsWith('/url/'))) {
            const val = u.searchParams.get('url') || u.searchParams.get('q');
            if (val && /^https?:/i.test(val)) return val;
        }

        // 2. DuckDuckGo redirect wrapper: ONLY on /l/ endpoint with uddg
        if (host.includes('duckduckgo.com') && (path === '/l' || path.startsWith('/l/'))) {
            const val = u.searchParams.get('uddg');
            if (val && /^https?:/i.test(val)) return val;
        }

        // 3. Generic redirect wrappers on explicit redirect endpoints
        if (path.includes('url') || path.includes('redirect') || path.includes('goto') || path.includes('link') || path.includes('out')) {
            for (const key of ['url', 'target', 'dest', 'u', 'r', 'uddg']) {
                const val = u.searchParams.get(key);
                if (val && /^https?:/i.test(val)) return val;
            }
        }
    } catch {}
    return rawUrl;
}

// Backward-compatible alias
export const unwrapGoogleUrl = unwrapRedirectUrl;

/**
 * Checks if a URL matches the target score endpoint pattern (/a/wsa/*-s{id})
 * Evaluates only the URL's actual pathname, never inspecting query strings.
 * @param {string} url
 * @returns {boolean}
 */
export function isWsaTabUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const u = new URL(url);
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

/**
 * Fetches sync points for the matched score URL and attaches them to the opened score.
 * @param {string} matchedUrl
 * @param {object} [options]
 * @param {Function} [options.showToast]
 * @param {Function} [options.loadFromUrlFn]
 * @param {Function} [options.attachSyncSetsFn]
 * @param {File|Blob|Uint8Array} [options.file]
 * @param {string} [options.songKey]
 * @returns {Promise<{saved: string[], skipped: string[]}>}
 */
export async function attachSyncForMatchedUrl(matchedUrl, { showToast = null, loadFromUrlFn = null, attachSyncSetsFn = null, file = null, songKey = null } = {}) {
    if (!matchedUrl) return { saved: [], skipped: [] };
    try {
        const load = loadFromUrlFn || (await import('../audioSync/importers/index.js')).loadFromUrl;
        const { fetchText } = await import('../urlImport/openFromUrl.js');
        const sets = await load(matchedUrl, fetchText);
        if (!sets?.length) return { saved: [], skipped: ['No sync points found in source'] };

        let bars = null;
        if (file) {
            const { extractPlayedBarsFromFile } = await import('../urlImport/attachSync.js');
            bars = await extractPlayedBarsFromFile(file);
        }

        const attach = attachSyncSetsFn || (await import('../urlImport/attachSync.js')).attachSyncSets;
        const result = await attach(sets, { songKey, bars });
        if (typeof showToast === 'function') {
            if (result?.saved?.length) {
                showToast(`Added sync points for ${result.saved.length === 1 ? result.saved[0] : `${result.saved.length} videos`}`, 'success');
            } else if (result?.skipped?.length) {
                showToast(`Sync points not added: ${result.skipped[0]}`, 'warning', 6000);
            }
        }
        return result;
    } catch (e) {
        console.warn('[Tab Downloader] Auto-sync points error:', e);
        if (typeof showToast === 'function') showToast(`Sync points not added: ${e?.message || 'could not fetch them'}`, 'warning', 6000);
        return { saved: [], skipped: [e?.message || 'Failed to fetch sync points'] };
    }
}
