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
        let direct = url;
        const uRaw = new URL(url);
        const host = uRaw.hostname.toLowerCase();
        const path = uRaw.pathname.toLowerCase();
        if ((host.includes('google.') && (path === '/url' || path.startsWith('/url/'))) ||
            (host.includes('duckduckgo.com') && (path === '/l' || path.startsWith('/l/')))) {
            direct = unwrapRedirectUrl(url);
        }
        const u = new URL(direct);
        return u.pathname.startsWith('/a/wsa/') && SONG_ID_PATTERN.test(u.pathname);
    } catch {
        return false;
    }
}

export function extractTabSongId(urlOrPath) {
    if (!urlOrPath || typeof urlOrPath !== 'string') return null;
    try {
        const path = urlOrPath.startsWith('http') ? new URL(urlOrPath).pathname : urlOrPath;
        const matches = path.match(/(?:-|\/)s(\d+)(?:\/|$)/g);
        if (matches && matches.length > 0) {
            const last = matches[matches.length - 1];
            const num = last.match(/\d+/);
            return num ? Number(num[0]) : null;
        }
        const m = path.match(/-s(\d+)/g);
        return m ? Number(m[m.length - 1].slice(2)) : null;
    } catch {
        return null;
    }
}

export function encodeTabDownloaderPayload(current, targetUrl) {
    if (!current || typeof current !== 'object') return '';
    let byLinkUrl = '';
    try {
        const u = new URL(unwrapRedirectUrl(targetUrl));
        byLinkUrl = u.origin + u.pathname;
    } catch {
        byLinkUrl = targetUrl || '';
    }
    const tracks = (current.tracks || []).map(u => ({
        partId: u.partId,
        instrumentId: u.instrumentId,
        title: u.title,
        name: u.name,
        tuning: u.tuning,
        isDrums: u.isDrums
    }));
    const payloadObj = {
        songId: current.songId,
        revisionId: current.revisionId,
        image: current.image,
        title: current.title,
        artist: current.artist,
        artistId: current.artistId,
        tracks,
        byLinkUrl
    };
    if (current.syncPoints && Array.isArray(current.syncPoints) && current.syncPoints.length > 0) {
        payloadObj.syncPoints = current.syncPoints;
    }
    const payload = JSON.stringify(payloadObj);
    const bytes = new TextEncoder().encode(payload);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeTabDownloaderPayload(hashOrUrl) {
    if (!hashOrUrl || typeof hashOrUrl !== 'string') return null;
    try {
        let hash = hashOrUrl;
        if (hash.includes('#')) hash = hash.split('#')[1];
        if (hash.includes('=')) {
            const parts = hash.split('=');
            hash = parts.slice(1).join('=');
        }
        if (hash.includes('&')) hash = hash.split('&')[0];
        if (!hash) return null;
        let base64Std = hash.replace(/-/g, '+').replace(/_/g, '/');
        while (base64Std.length % 4) base64Std += '=';
        let binary = '';
        if (typeof atob === 'function') {
            binary = atob(base64Std);
        } else if (typeof Buffer !== 'undefined') {
            binary = Buffer.from(base64Std, 'base64').toString('binary');
        }
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const text = new TextDecoder().decode(bytes);
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export function extractTabMetaFromHtml(html, targetUrl) {
    if (!html || typeof html !== 'string') return null;
    const songId = targetUrl ? extractTabSongId(targetUrl) : null;
    let jsonText = null;
    if (typeof DOMParser !== 'undefined') {
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const el = doc.getElementById('state');
            if (el && el.textContent) jsonText = el.textContent;
        } catch {}
    }
    if (!jsonText) {
        const match = html.match(/<script[^>]*id=["']state["'][^>]*>([\s\S]*?)<\/script>/i);
        if (match && match[1]) jsonText = match[1];
    }
    if (!jsonText) return null;
    try {
        const d = JSON.parse(jsonText);
        const current = d && d.meta && d.meta.current ? d.meta.current : null;
        if (!current) return null;
        if (songId !== null && current.songId && current.songId !== songId) return null;
        return current;
    } catch {
        return null;
    }
}

export function generateDownloaderTransferScript() {
    return `(function() {
    const host = location.hostname.replace(/^www\\./i, '').toLowerCase();
    const parts = host.split('.');
    let label = parts[0];
    if (parts.length > 2 && (parts[parts.length - 2] === 'co' || parts[parts.length - 2] === 'com')) {
        label = parts[parts.length - 3] || parts[0];
    } else if (parts.length > 1) {
        label = parts[parts.length - 2];
    }
    if (!label) return;
    const base = 'https:/' + '/www.' + label + '-downloader.com/';
    function getSongId(path) {
        const o = path.match(/(?:-|\\/)s(\\d+)(?:\\/|$)/g);
        if (o && o.length > 0) {
            const m = o[o.length - 1].match(/\\d+/);
            if (m) return Number(m[0]);
        }
        const m = path.match(/-s(\\d+)/g);
        return m ? Number(m[m.length - 1].slice(2)) : null;
    }
    function readState(doc) {
        const el = doc.getElementById('state');
        if (!el || !el.textContent) return null;
        try {
            const d = JSON.parse(el.textContent);
            return d && d.meta && d.meta.current ? d.meta.current : null;
        } catch (_) {
            return null;
        }
    }
    function encode(curr) {
        const tracks = (curr.tracks || []).map(function(u) {
            return {
                partId: u.partId,
                instrumentId: u.instrumentId,
                title: u.title,
                name: u.name,
                tuning: u.tuning,
                isDrums: u.isDrums
            };
        });
        const obj = {
            songId: curr.songId,
            revisionId: curr.revisionId,
            image: curr.image,
            title: curr.title,
            artist: curr.artist,
            artistId: curr.artistId,
            tracks: tracks,
            byLinkUrl: location.origin + location.pathname
        };
        if (curr.syncPoints && curr.syncPoints.length > 0) {
            obj.syncPoints = curr.syncPoints;
        }
        const d = JSON.stringify(obj);
        const g = new TextEncoder().encode(d);
        let m = '';
        for (let u = 0; u < g.length; u++) m += String.fromCharCode(g[u]);
        return btoa(m).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    }
    function send(curr) {
        try {
            if (curr.syncPoints && curr.syncPoints.length > 0) {
                const msg = 'MAJESTIC_SYNC_POINTS:' + JSON.stringify({
                    matchedUrl: location.origin + location.pathname,
                    songId: curr.songId,
                    revisionId: curr.revisionId,
                    artist: curr.artist,
                    title: curr.title,
                    syncPoints: curr.syncPoints
                });
                const ifr = document.createElement('iframe');
                ifr.style.display = 'none';
                ifr.src = 'majestictab://log?msg=' + encodeURIComponent(msg);
                (document.body || document.documentElement).appendChild(ifr);
                setTimeout(function() { try { ifr.remove(); } catch(_) {} }, 1000);
            }
        } catch(_) {}
        const dest = base + '#' + label + '=' + encode(curr);
        window.open(dest, label + '-downloader') || (location.href = dest);
    }
    function withSyncPointsAndSend(curr) {
        let sent = false;
        function done() {
            if (sent) return;
            sent = true;
            send(curr);
        }
        const timer = setTimeout(done, 2500);
        if (!curr.songId) { done(); return; }

        function tryPoints(points) {
            if (Array.isArray(points) && points.length > 0) {
                curr.syncPoints = points.map(function(p) {
                    return {
                        videoId: p.videoId,
                        points: p.points,
                        status: p.status,
                        feature: p.feature
                    };
                });
                clearTimeout(timer);
                done();
                return true;
            }
            return false;
        }

        function fetchRevisionPoints(revId) {
            return fetch('/api/video-points/' + curr.songId + '/' + revId + '/list', { credentials: 'include' })
                .then(function(r) { return r.ok ? r.json() : null; })
                .catch(function() { return null; });
        }

        function fetchOtherRevisions() {
            fetch('/api/meta/' + curr.songId + '/revisions', { credentials: 'include' })
                .then(function(r) { return r.ok ? r.json() : null; })
                .then(function(revs) {
                    const list = (Array.isArray(revs) ? revs : [])
                        .map(function(r) { return r && r.revisionId; })
                        .filter(Boolean)
                        .filter(function(id) { return id !== curr.revisionId; })
                        .sort(function(a, b) { return b - a; })
                        .slice(0, 3);
                    if (!list.length) { done(); return; }
                    let idx = 0;
                    function checkNext() {
                        if (idx >= list.length) { done(); return; }
                        fetchRevisionPoints(list[idx++]).then(function(pts) {
                            if (!tryPoints(pts)) checkNext();
                        }).catch(checkNext);
                    }
                    checkNext();
                })
                .catch(done);
        }

        if (curr.revisionId) {
            fetchRevisionPoints(curr.revisionId).then(function(pts) {
                if (tryPoints(pts)) return;
                fetchOtherRevisions();
            }).catch(fetchOtherRevisions);
        } else {
            fetchOtherRevisions();
        }
    }
    const songId = getSongId(location.pathname);
    if (!songId) return;
    const docMeta = readState(document);
    if (docMeta && docMeta.songId === songId) {
        withSyncPointsAndSend(docMeta);
        return;
    }
    fetch(location.href, { credentials: 'include' })
        .then(function(r) { return r.text(); })
        .then(function(html) {
            const parsed = readState(new DOMParser().parseFromString(html, 'text/html'));
            if (parsed && parsed.songId === songId) {
                withSyncPointsAndSend(parsed);
            }
        })
        .catch(function() {});
})();`;
}

export function getDownloaderUrlFromMatchedUrl(targetUrl, currentMeta = null) {
    try {
        const u = new URL(unwrapGoogleUrl(targetUrl));
        const host = u.hostname.replace(/^www\./i, '').toLowerCase();
        const parts = host.split('.');
        let label = parts[0];
        if (parts.length > 2 && (parts[parts.length - 2] === 'co' || parts[parts.length - 2] === 'com')) {
            label = parts[parts.length - 3] || parts[0];
        } else if (parts.length > 1) {
            label = parts[parts.length - 2];
        }
        if (!label) return null;
        const baseUrl = `https://www.${label}-downloader.com/`;
        if (currentMeta) {
            const hashPayload = encodeTabDownloaderPayload(currentMeta, targetUrl);
            if (hashPayload) return `${baseUrl}#${label}=${hashPayload}`;
        }
        return baseUrl;
    } catch {
        return null;
    }
}

/** Puts the dock on Original (the synced recording) the way pressing it would, on every platform. */
export async function switchToOriginalSound() {
    try {
        const { switchRealAudioSlot } = await import('../audioSync/realAudioController.js');
        const { setActiveAudioMode } = await import('./navigationUtils.js');
        const { pauseSynthPlayer, clearSynthHighlights } = await import('../gpProcessor/gpPlayer.js');
        const { toggleYouTubePanel } = await import('../youtubePlayer.js');
        switchRealAudioSlot('original');
        if (typeof setActiveAudioMode === 'function') setActiveAudioMode('youtube');
        if (typeof toggleYouTubePanel === 'function') toggleYouTubePanel(false);
        if (typeof pauseSynthPlayer === 'function') pauseSynthPlayer();
        if (typeof clearSynthHighlights === 'function') clearSynthHighlights();
    } catch (e) {
        console.warn('[Tab Downloader] Could not switch to original audio:', e);
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
 * @param {string[]} [options.aliasKeys] additional song keys to store the sync points under
 * @param {boolean} [options.switchToOriginal] switch the dock to the Original sound once points were saved (the score is open in the reader)
 * @param {Array|string} [options.syncPoints] pre-extracted sync points from DOM transfer or payload
 * @returns {Promise<{saved: string[], skipped: string[]}>}
 */
export async function attachSyncForMatchedUrl(matchedUrl, { showToast = null, loadFromUrlFn = null, attachSyncSetsFn = null, file = null, songKey = null, aliasKeys = [], switchToOriginal = false, syncPoints = null } = {}) {
    if (!matchedUrl && !syncPoints) return { saved: [], skipped: [] };
    try {
        let sets = null;
        if (syncPoints) {
            try {
                const { detectSets } = await import('../audioSync/importers/detect.js');
                const raw = typeof syncPoints === 'string' ? syncPoints : JSON.stringify(syncPoints);
                sets = detectSets(raw);
            } catch (err) {
                console.warn('[Tab Downloader] Failed to detect sync sets from provided syncPoints:', err);
            }
        }
        if (!sets?.length && matchedUrl) {
            const load = loadFromUrlFn || (await import('../audioSync/importers/index.js')).loadFromUrl;
            const { fetchText } = await import('../urlImport/openFromUrl.js');
            sets = await load(matchedUrl, fetchText);
        }
        if (!sets?.length) return { saved: [], skipped: ['No sync points found in source'] };

        let bars = null;
        if (file) {
            const { extractPlayedBarsFromFile } = await import('../urlImport/attachSync.js');
            bars = await extractPlayedBarsFromFile(file);
        }

        const attach = attachSyncSetsFn || (await import('../urlImport/attachSync.js')).attachSyncSets;
        const result = await attach(sets, { songKey, aliasKeys, bars });
        if (switchToOriginal && result?.saved?.length) await switchToOriginalSound();
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
