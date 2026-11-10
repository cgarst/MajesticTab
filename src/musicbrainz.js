// musicbrainz.js
// MusicBrainz API & Cover Art Archive client with rate limiting, US release preference, and client caching.

const MB_BASE = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'MajesticTab/1.0.0 (https://github.com/cgarst/MajesticTab; admin@localhost)';
const CACHE_PREFIX = 'mb_cache_';

// Polite rate limiting. MusicBrainz measures how often requests ARRIVE (about 1 per second per IP, averaged; over that,
// every request is declined until the rate drops), so the gap is counted from when the last request was sent, not from when its
// answer came back: a slow search no longer costs a second more than it has to. Exponential backoff on 503.
const MIN_REQUEST_INTERVAL = 1150;
const MAX_RETRIES = 4;

let lastRequestTime = 0;
const requestQueue = [];
let isProcessingQueue = false;
const inFlightRequests = new Map();

/**
 * Execute a single HTTP request to MusicBrainz with automatic exponential backoff retry.
 */
async function executeWithRetry(url, maxRetries = MAX_RETRIES, signal = null) {
    let attempt = 0;
    let delay = 1500;

    while (attempt <= maxRetries) {
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        // Enforce minimum rate limiting interval before each request
        const now = Date.now();
        const elapsed = now - lastRequestTime;
        if (elapsed < MIN_REQUEST_INTERVAL) {
            await new Promise((r, rej) => {
                const timer = setTimeout(r, MIN_REQUEST_INTERVAL - elapsed);
                if (signal) {
                    signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        rej(new DOMException('Aborted', 'AbortError'));
                    }, { once: true });
                }
            });
        }
        lastRequestTime = Date.now();

        try {
            // The native shell's HTTP client sends no CORS preflight and really sends the User-Agent. A webview fetch cannot set
            // User-Agent, and trying makes it send an OPTIONS preflight first: a second request against MusicBrainz's rate limit,
            // which is the one that came back 503. So the header goes only on the native path.
            const native = typeof window !== 'undefined' && typeof window.__TAURI__?.http?.fetch === 'function';
            const res = await (native ? window.__TAURI__.http.fetch : fetch)(url, {
                headers: native
                    ? { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
                    : { 'Accept': 'application/json' },
                signal
            });

            if (res.ok) {
                return await res.json();
            }

            const status = res.status;
            // Retryable HTTP statuses (429 Rate Limit, 503 Unavailable, 502 Bad Gateway, 504 Gateway Timeout, 500 Server Error)
            const isRetryable = status === 429 || status === 503 || status === 502 || status === 504 || status === 500;

            if (isRetryable && attempt < maxRetries) {
                attempt++;
                // Check Retry-After header if provided
                const retryAfterHeader = res.headers?.get ? res.headers.get('Retry-After') : null;
                let waitTime = delay + Math.floor(Math.random() * 500); // add jitter
                if (retryAfterHeader) {
                    const parsedSeconds = parseInt(retryAfterHeader, 10);
                    if (!isNaN(parsedSeconds) && parsedSeconds > 0) {
                        waitTime = Math.max(parsedSeconds * 1000, waitTime);
                    }
                }
                console.warn(`[MusicBrainz] HTTP ${status} for ${url}. Retrying attempt ${attempt}/${maxRetries} in ${waitTime}ms...`);
                await new Promise((r, rej) => {
                    const timer = setTimeout(r, waitTime);
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            rej(new DOMException('Aborted', 'AbortError'));
                        }, { once: true });
                    }
                });
                delay *= 2; // exponential backoff (1.5s -> 3s -> 6s -> 12s)
                continue;
            }

            throw new Error(`MusicBrainz HTTP ${status}`);
        } catch (err) {
            if (err.name === 'AbortError' || signal?.aborted) {
                throw err;
            }
            const isNetworkError = !err.message?.startsWith('MusicBrainz HTTP');
            if (isNetworkError && attempt < maxRetries) {
                attempt++;
                const waitTime = delay + Math.floor(Math.random() * 500);
                console.warn(`[MusicBrainz] Network error (${err.message}). Retrying attempt ${attempt}/${maxRetries} in ${waitTime}ms...`);
                await new Promise((r, rej) => {
                    const timer = setTimeout(r, waitTime);
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            rej(new DOMException('Aborted', 'AbortError'));
                        }, { once: true });
                    }
                });
                delay *= 2;
                continue;
            }
            throw err;
        }
    }
}

async function processQueue() {
    if (isProcessingQueue || requestQueue.length === 0) return;
    isProcessingQueue = true;

    while (requestQueue.length > 0) {
        const item = requestQueue.shift();
        if (item.signal?.aborted) {
            item.reject(new DOMException('Aborted', 'AbortError'));
            continue;
        }
        try {
            const data = await executeWithRetry(item.url, MAX_RETRIES, item.signal);
            item.resolve(data);
        } catch (err) {
            item.reject(err);
        }
    }

    isProcessingQueue = false;
}

export function fetchMusicBrainz(url, options = {}) {
    const signal = options?.signal;
    if (signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    // Check in-memory/session cache
    try {
        const cached = sessionStorage.getItem(CACHE_PREFIX + url);
        if (cached) {
            return Promise.resolve(JSON.parse(cached));
        }
    } catch {}

    // Check if there is already an in-flight request for this exact URL without signal or matching
    if (!signal && inFlightRequests.has(url)) {
        return inFlightRequests.get(url);
    }

    const promise = new Promise((resolve, reject) => {
        const item = {
            url,
            signal,
            resolve: (data) => {
                inFlightRequests.delete(url);
                try {
                    sessionStorage.setItem(CACHE_PREFIX + url, JSON.stringify(data));
                } catch {
                    // If sessionStorage is full, prune old mb_cache keys
                    try {
                        for (let i = sessionStorage.length - 1; i >= 0; i--) {
                            const key = sessionStorage.key(i);
                            if (key && key.startsWith(CACHE_PREFIX)) {
                                sessionStorage.removeItem(key);
                            }
                        }
                    } catch {}
                }
                resolve(data);
            },
            reject: (err) => {
                inFlightRequests.delete(url);
                reject(err);
            }
        };

        if (signal) {
            signal.addEventListener('abort', () => {
                const idx = requestQueue.indexOf(item);
                if (idx !== -1) requestQueue.splice(idx, 1);
                inFlightRequests.delete(url);
                reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        }

        requestQueue.push(item);
        processQueue();
    });

    if (!signal) {
        inFlightRequests.set(url, promise);
    }
    return promise;
}

/**
 * Placeholder SVG for missing cover artwork
 */
export function getPlaceholderCoverSvg(title = 'Tab') {
    // A flat tile with the initial: a muted color picked from the name, so the same artist always looks the same
    const initial = (title || 'T').trim().charAt(0).toUpperCase() || 'T';
    let hash = 0;
    for (const ch of String(title)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const tiles = ['#4a3a34', '#2f3a5c', '#3c2a58', '#563838', '#35414f', '#3a3868', '#47382c', '#2c4a47'];
    const fill = tiles[hash % tiles.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="${fill}"/><text x="100" y="134" font-size="108" font-family="Barlow Condensed,Arial Narrow,Helvetica Neue,Arial,sans-serif" font-weight="700" fill="#f4f1f8" fill-opacity="0.92" text-anchor="middle">${initial}</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function getCoverArtUrl(releaseGroupMbid, releaseMbid, size = 250) {
    if (releaseGroupMbid) {
        return `https://coverartarchive.org/release-group/${releaseGroupMbid}/front-${size}`;
    }
    if (releaseMbid) {
        return `https://coverartarchive.org/release/${releaseMbid}/front-${size}`;
    }
    return null;
}

const ART_CACHE_NAME = 'majestictab_art_cache_v1';
const artMemoryCache = new Map();
const inFlightArt = new Map();
// Art URLs the server refused this session (the art server returns 500s for some releases); not asked for again.
const failedArt = new Set();

/**
 * Returns synchronous in-memory cached artwork URL if already resolved, otherwise the given URL.
 */
export function getSynchronousCachedArtUrl(url) {
    if (!url || typeof url !== 'string') return url;
    return artMemoryCache.get(url) || url;
}

/**
 * Warm in-memory art cache from persistent Cache Storage in background.
 */
export async function warmArtMemoryCache() {
    if (typeof caches === 'undefined') return;
    try {
        const cache = await caches.open(ART_CACHE_NAME);
        const requests = await cache.keys();
        for (const req of requests) {
            const url = req.url;
            if (artMemoryCache.has(url)) continue;
            try {
                const matched = await cache.match(req);
                if (matched && matched.ok) {
                    const blob = await matched.blob();
                    if (blob && blob.size > 0 && !artMemoryCache.has(url)) {
                        artMemoryCache.set(url, URL.createObjectURL(blob));
                    }
                }
            } catch (_) {}
        }
    } catch (_) {}
}

if (typeof caches !== 'undefined' && typeof window !== 'undefined') {
    warmArtMemoryCache();
}

/**
 * Get or fetch cached artwork as a local blob URL.
 * Stored persistently in Cache Storage (separate from database backups).
 */
export async function getCachedArtUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;

    if (artMemoryCache.has(url)) {
        return artMemoryCache.get(url);
    }

    if (inFlightArt.has(url)) {
        return inFlightArt.get(url);
    }

    if (failedArt.has(url)) return url;

    const promise = (async () => {
        try {
            if (typeof caches !== 'undefined') {
                const cache = await caches.open(ART_CACHE_NAME);
                const matched = await cache.match(url);
                if (matched && matched.ok) {
                    const blob = await matched.blob();
                    if (blob && blob.size > 0) {
                        const objUrl = URL.createObjectURL(blob);
                        artMemoryCache.set(url, objUrl);
                        return objUrl;
                    }
                }

                // Fetch and store in cache
                const res = await fetch(url, { mode: 'cors' });
                if (res.ok) {
                    try {
                        await cache.put(url, res.clone());
                    } catch {}
                    const blob = await res.blob();
                    const objUrl = URL.createObjectURL(blob);
                    artMemoryCache.set(url, objUrl);
                    return objUrl;
                }
                failedArt.add(url);
            }
        } catch (e) {
            // Silently fall back to remote URL on error
        }
        return url;
    })();

    inFlightArt.set(url, promise);
    try {
        const result = await promise;
        return result;
    } finally {
        inFlightArt.delete(url);
    }
}

/**
 * Clear persistent artwork cache and session MusicBrainz API query cache
 * @returns {Promise<number>} Number of cache items removed
 */
export async function clearArtCache() {
    artMemoryCache.clear();
    let count = 0;
    if (typeof caches !== 'undefined') {
        try {
            const cache = await caches.open(ART_CACHE_NAME);
            const keys = await cache.keys();
            count += keys.length;
            await caches.delete(ART_CACHE_NAME);
        } catch (_) {}
    }
    try {
        const keysToRemove = [];
        for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            if (k && k.startsWith(CACHE_PREFIX)) keysToRemove.push(k);
        }
        count += keysToRemove.length;
        keysToRemove.forEach(k => sessionStorage.removeItem(k));
    } catch (_) {}
    return count;
}

// Covers are only fetched into the cache once they are near the viewport, so a long library does not request every
// image up front (and nothing is requested for images that were removed before they scrolled into view).
let artObserver = null;
function getArtObserver() {
    if (artObserver || typeof IntersectionObserver === 'undefined') return artObserver;
    artObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const img = entry.target;
            artObserver.unobserve(img);
            const src = img.getAttribute('src');
            if (!src || !img.isConnected) continue;
            getCachedArtUrl(src).then(cached => {
                if (cached && cached !== src && img.isConnected) {
                    img.src = cached;
                }
            }).catch(() => {});
        }
    }, { rootMargin: '300px' });
    return artObserver;
}

/**
 * Hydrate remote cover images in a DOM container from the persistent art cache
 */
export function hydrateCachedImages(container) {
    if (!container || typeof document === 'undefined') return;
    const images = container.querySelectorAll('img.album-cover-img, img.album-cover-banner, img.artist-collage-img, img.artist-thumbnail, img.recent-cover-img, img.pinned-cover-img, img.setrow-cover, img.song-cover, img.shelf-cover, img.album-header-cover, img.resume-cover');
    const observer = getArtObserver();
    images.forEach(img => {
        img.setAttribute('draggable', 'false');
        const src = img.getAttribute('src');
        if (src && src.startsWith('https://coverartarchive.org')) {
            if (artMemoryCache.has(src)) {
                img.src = artMemoryCache.get(src);
                return;
            }
            if (observer) {
                observer.observe(img);
                return;
            }
            getCachedArtUrl(src).then(cached => {
                if (cached && cached !== src && img.isConnected) {
                    img.src = cached;
                }
            }).catch(() => {});
        }
    });
}

/**
 * Score, rank, and deduplicate MusicBrainz recording results so canonical studio tracks
 * from major releases appear first, while live bootlegs, karaoke, tributes, and covers are demoted.
 */
function scoreAndRankRecordings(recordings, query) {
    if (!Array.isArray(recordings) || recordings.length === 0) return [];
    const qLower = query.toLowerCase().trim();

    const scored = recordings.map(rec => {
        const title = (rec.title || '').toLowerCase().trim();
        const artistCredit = rec['artist-credit']?.map(ac => ac.name || ac.artist?.name).join('') || 'Unknown Artist';
        const artistLower = artistCredit.toLowerCase().trim();
        const disambig = (rec.disambiguation || '').toLowerCase().trim();
        
        let score = (rec.score || 50) * 2;

        // 1. Exact vs partial title match
        if (title === qLower) {
            score += 120;
        } else if (title.startsWith(qLower) || title.endsWith(qLower)) {
            score += 40;
        } else if (title.includes(qLower)) {
            score += 20;
        }

        // Artist query match (e.g. user typed 'Metallica Master of Puppets')
        if (qLower.includes(artistLower) && artistLower.length > 2) {
            score += 100;
        }

        // 2. Heavy penalties for negative keywords in title, disambiguation, or artist name
        const negativeKeywords = [
            'live', 'bootleg', 'karaoke', 'tribute', 'cover', 'instrumental', 
            'remix', 'rehearsal', 'demo', 'interview', 'medley', 'parody', 
            'acoustic version', 'string quartet', 'orchestra', 'lullaby', 
            'tribute band', 'piano version', 'backing track', 'acoustic tribute',
            'originally performed', 'fitness', 'workout', '8-bit', 'rso performs',
            'great metal covers', 'dark trance'
        ];
        for (const kw of negativeKeywords) {
            if (!qLower.includes(kw)) {
                if (title.includes(kw)) score -= 120;
                if (disambig.includes(kw)) score -= 100;
                if (artistLower.includes(kw)) score -= 110;
            }
        }

        if (rec.video) score -= 80;

        // 3. Release scoring & Best release selection
        let bestRelease = null;
        let bestRelScore = -999;
        const releases = rec.releases || [];

        // Track total releases count as a strong indicator of canonical hit tracks
        score += Math.min(releases.length * 2, 100);

        for (const rel of releases) {
            let rScore = 0;
            const relTitle = (rel.title || '').toLowerCase();
            const status = rel.status || '';
            const rg = rel['release-group'] || {};
            const primaryType = rg['primary-type'] || '';
            const secTypes = (rg['secondary-types'] || []).map(t => String(t).toLowerCase());
            const country = (rel.country || '').toUpperCase();

            if (status === 'Official') rScore += 50;
            else if (status === 'Bootleg') rScore -= 100;
            else if (status === 'Promotion') rScore += 10;

            // Big boost for full studio Albums over Singles/EPs
            if (primaryType === 'Album') rScore += 60;
            else if (primaryType === 'Single' || primaryType === 'EP') rScore += 25;

            // Secondary types penalties
            if (secTypes.includes('live')) rScore -= 90;
            if (secTypes.includes('compilation')) rScore -= 45;
            if (secTypes.includes('tribute') || secTypes.includes('dj-mix') || secTypes.includes('soundtrack')) rScore -= 70;

            // Release title junk filter
            if (relTitle.includes('tribute') || relTitle.includes('karaoke') || relTitle.includes('fitness') || 
                relTitle.includes('workout') || relTitle.includes('party') || relTitle.includes('greatest') || 
                relTitle.includes('compilation') || relTitle.includes('hits') || relTitle.includes('cover') ||
                relTitle.includes('8-bit') || relTitle.includes('lullaby') || relTitle.includes('dark trance')) {
                rScore -= 60;
            }

            // Country preference (US / UK / Europe / Worldwide)
            if (country === 'US') rScore += 20;
            else if (country === 'GB' || country === 'UK') rScore += 15;
            else if (country === 'XW' || country === 'XE') rScore += 10;

            // Same name as album (title track on an Album)
            if (relTitle === title && primaryType === 'Album') rScore += 30;

            if (rScore > bestRelScore) {
                bestRelScore = rScore;
                bestRelease = rel;
            }
        }

        if (bestRelease) {
            score += Math.max(bestRelScore, 0);
        } else {
            score -= 50; // No releases associated
        }

        // Earliest release date bonus (original release year)
        const year = rec['first-release-date'] ? parseInt(rec['first-release-date'].slice(0, 4), 10) : (bestRelease?.date ? parseInt(bestRelease.date.slice(0, 4), 10) : null);
        if (year && year >= 1950 && year <= 2030) {
            score += (2030 - year) / 3;
        }

        const releaseGroup = bestRelease?.['release-group'];
        const albumTitle = releaseGroup?.title || bestRelease?.title || '';
        const albumMbid = releaseGroup?.id || bestRelease?.id || '';

        let recTitle = rec.title || 'Untitled';
        if (disambig) {
            const cleanD = disambig.replace(/^\((.+)\)$/, '$1').trim();
            if (cleanD && !recTitle.toLowerCase().includes(cleanD.toLowerCase())) {
                recTitle = `${recTitle} (${cleanD})`;
            }
        }

        return {
            id: rec.id,
            recordingMbid: rec.id,
            title: recTitle,
            artist: artistCredit,
            artistMbid: rec['artist-credit']?.[0]?.artist?.id || '',
            album: albumTitle,
            albumMbid: albumMbid,
            year,
            length: rec.length ? Math.round(rec.length / 1000) : null,
            coverUrl: getCoverArtUrl(albumMbid),
            score
        };
    });

    // Sort by calculated score descending
    scored.sort((a, b) => b.score - a.score);

    // Deduplicate by artist + title so the user gets distinct, high quality options
    const seen = new Set();
    const deduped = [];
    for (const item of scored) {
        const key = item.artist.toLowerCase() + '___' + item.title.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(item);
        }
    }

    return deduped.slice(0, 25);
}

// --- Answers kept between sessions -----------------------------------------------------------------------------------------
// MusicBrainz answers about one request a second, so an answer that was already fetched is worth keeping: searching the same
// folder again, reopening an album or asking the library search the same thing costs nothing. What is kept is the small,
// already-shaped answer of searchMusicBrainz, getAlbumTracks and getArtistAlbums (not the raw responses, which can be 300 KB
// each). Entries expire after two weeks and the oldest go when there are more than PC_MAX. Anywhere IndexedDB is missing or
// refuses (private windows), nothing is kept and everything still works.

const PC_DB = 'majestictab_mb_answers';
const PC_STORE = 'answers';
const PC_TTL = 14 * 24 * 3600 * 1000;
const PC_MAX = 1500;
let pcDbPromise = null;
let pcWrites = 0;

function pcOpen() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (!pcDbPromise) {
        pcDbPromise = new Promise((resolve) => {
            try {
                const req = indexedDB.open(PC_DB, 1);
                req.onupgradeneeded = () => {
                    const store = req.result.createObjectStore(PC_STORE, { keyPath: 'key' });
                    store.createIndex('t', 't');
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
                req.onblocked = () => resolve(null);
            } catch { resolve(null); }
        });
    }
    return pcDbPromise;
}

async function pcGet(key) {
    const db = await pcOpen();
    if (!db) return undefined;
    return new Promise((resolve) => {
        try {
            const req = db.transaction(PC_STORE, 'readonly').objectStore(PC_STORE).get(key);
            req.onsuccess = () => {
                const rec = req.result;
                resolve(rec && Date.now() - rec.t < PC_TTL ? rec.value : undefined);
            };
            req.onerror = () => resolve(undefined);
        } catch { resolve(undefined); }
    });
}

async function pcSet(key, value) {
    const db = await pcOpen();
    if (!db) return;
    try {
        const store = db.transaction(PC_STORE, 'readwrite').objectStore(PC_STORE);
        store.put({ key, t: Date.now(), value });
        if (++pcWrites % 40 === 0) {
            const countReq = store.count();
            countReq.onsuccess = () => {
                let extra = countReq.result - PC_MAX;
                if (extra <= 0) return;
                const cursorReq = store.index('t').openCursor();
                cursorReq.onsuccess = () => {
                    const cursor = cursorReq.result;
                    if (cursor && extra-- > 0) { cursor.delete(); cursor.continue(); }
                };
            };
        }
    } catch { /* not kept; asked again next time */ }
}

/** Forget every kept answer (Settings > Clear cached data). */
export async function clearMusicBrainzAnswers() {
    const db = await pcOpen();
    if (!db) return;
    try { db.transaction(PC_STORE, 'readwrite').objectStore(PC_STORE).clear(); } catch { /* nothing to clear */ }
}

/** Run `compute` unless this key has an answer kept; keep what it gives when `worthKeeping` says so. */
async function remembered(key, compute, worthKeeping = (v) => Array.isArray(v) ? v.length > 0 : Boolean(v)) {
    const kept = await pcGet(key);
    if (kept !== undefined) return kept;
    const value = await compute();
    if (worthKeeping(value)) pcSet(key, value);
    return value;
}

/**
 * Search MusicBrainz by entity type (artist, album, song, musician)
 */
export function searchMusicBrainz(query, type = 'artist', options = {}) {
    if (!query || !query.trim()) return Promise.resolve([]);
    return remembered(`s|${type}|${options.limit || ''}|${query.trim().toLowerCase()}`, () => searchMusicBrainzFresh(query, type, options));
}

async function searchMusicBrainzFresh(query, type = 'artist', options = {}) {
    if (!query || !query.trim()) return [];
    const cleanQuery = query.trim().replace(/['"()]/g, '');

    switch (type) {
        case 'artist': {
            const url = `${MB_BASE}/artist?query=${encodeURIComponent(cleanQuery)}&limit=25&fmt=json`;
            const data = await fetchMusicBrainz(url, options);
            return (data.artists || []).map(a => ({
                id: a.id,
                name: a.name,
                disambiguation: a.disambiguation || '',
                type: a.type || 'Artist',
                country: a.country || a.area?.name || '',
                lifeSpan: a['life-span'] ? `${a['life-span'].begin?.slice(0, 4) || ''} - ${a['life-span'].ended ? a['life-span'].end?.slice(0, 4) || 'Present' : 'Present'}` : '',
                score: a.score || 0,
                tagCount: (a.tags || []).reduce((n, t) => n + (t.count || 0), 0)
            }));
        }

        case 'album': {
            const url = `${MB_BASE}/release-group?query=${encodeURIComponent(cleanQuery)}&limit=40&fmt=json`;
            const data = await fetchMusicBrainz(url, options);
            return (data['release-groups'] || [])
                .filter(rg => {
                    const sec = (rg['secondary-types'] || []).map(t => String(t).toLowerCase());
                    return !sec.includes('live');
                })
                .slice(0, 25)
                .map(rg => {
                    const artistCredit = rg['artist-credit']?.map(ac => ac.name || ac.artist?.name).join('') || 'Unknown Artist';
                    const year = rg['first-release-date'] ? parseInt(rg['first-release-date'].slice(0, 4), 10) : null;
                    return {
                        id: rg.id,
                        title: rg.title,
                        artist: artistCredit,
                        artistMbid: rg['artist-credit']?.[0]?.artist?.id || '',
                        primaryType: rg['primary-type'] || 'Album',
                        secondaryTypes: rg['secondary-types'] || [],
                        year,
                        coverUrl: getCoverArtUrl(rg.id),
                        score: rg.score || 0
                    };
                });
        }

        case 'song': {
            // High-precision Lucene query: exact title boosted, term matches, title track release matches, and live exclusion
            const lucene = `(recording:"${cleanQuery}"^10 OR recording:(${cleanQuery})^4 OR (recording:(${cleanQuery}) AND release:(${cleanQuery})^3) OR (recording:(${cleanQuery}) AND artist:(${cleanQuery})^5)) AND NOT comment:live AND NOT video:true`;
            // A search that names the artist finds the song in the first few; one by title alone needs a wide net
            const url = `${MB_BASE}/recording?query=${encodeURIComponent(lucene)}&limit=${options.limit || 100}&fmt=json`;
            const data = await fetchMusicBrainz(url, options);
            return scoreAndRankRecordings(data.recordings || [], cleanQuery);
        }

        case 'musician': {
            // Search artists with Person type prioritized, then relations
            const url = `${MB_BASE}/artist?query=${encodeURIComponent(cleanQuery)}&limit=25&fmt=json`;
            const data = await fetchMusicBrainz(url, options);
            return (data.artists || []).map(a => ({
                id: a.id,
                name: a.name,
                disambiguation: a.disambiguation || '',
                type: a.type || 'Person',
                country: a.country || a.area?.name || '',
                lifeSpan: a['life-span'] ? `${a['life-span'].begin?.slice(0, 4) || ''} - ${a['life-span'].ended ? a['life-span'].end?.slice(0, 4) || 'Present' : 'Present'}` : '',
                score: a.score || 0
            }));
        }

        default:
            return [];
    }
}

/**
 * Get all release groups (albums / EPs) for an artist, filtered to studio releases only
 */
export function getArtistAlbums(artistMbid) {
    if (!artistMbid) return Promise.resolve([]);
    return remembered(`g|${artistMbid}`, () => getArtistAlbumsFresh(artistMbid));
}

async function getArtistAlbumsFresh(artistMbid) {
    const url = `${MB_BASE}/release-group?artist=${artistMbid}&type=album|ep&limit=100&fmt=json`;
    const data = await fetchMusicBrainz(url);
    const groups = data['release-groups'] || [];

    // Filter to studio albums only (exclude Live, Compilation, DJ-mix, Interview, Demo)
    const albums = groups
        .filter(rg => {
            const sec = (rg['secondary-types'] || []).map(t => String(t).toLowerCase());
            const title = (rg.title || '').toLowerCase();
            if (sec.includes('live') || sec.includes('compilation') || sec.includes('dj-mix') || sec.includes('interview') || sec.includes('demo')) {
                return false;
            }
            if (title.includes('(live') || title.includes('[live') || title.includes(' - live')) {
                return false;
            }
            return true;
        })
        .map(rg => {
            const year = rg['first-release-date'] ? parseInt(rg['first-release-date'].slice(0, 4), 10) : null;
            return {
                id: rg.id,
                title: rg.title,
                primaryType: rg['primary-type'] || 'Album',
                secondaryTypes: rg['secondary-types'] || [],
                year,
                coverUrl: getCoverArtUrl(rg.id)
            };
        });

    // Sort chronologically (oldest first)
    albums.sort((a, b) => (a.year || 9999) - (b.year || 9999));
    return albums;
}

/**
 * Get musician's related bands / artists (e.g. John Petrucci -> Dream Theater, Liquid Tension Experiment)
 */
export async function getMusicianRelations(musicianMbid) {
    if (!musicianMbid) return [];
    const url = `${MB_BASE}/artist/${musicianMbid}?inc=artist-rels&fmt=json`;
    const data = await fetchMusicBrainz(url);
    const relations = data.relations || [];

    const bands = [];
    const seen = new Set();

    for (const rel of relations) {
        if (rel['target-type'] === 'artist' && rel.artist) {
            const target = rel.artist;
            if (!seen.has(target.id) && target.id !== musicianMbid) {
                seen.add(target.id);
                bands.push({
                    id: target.id,
                    name: target.name,
                    type: rel.type || 'Member of',
                    role: rel.attributes?.join(', ') || '',
                    disambiguation: target.disambiguation || ''
                });
            }
        }
    }

    return bands;
}

/**
 * Detect whether a medium format or medium title indicates a DVD, Blu-ray, or non-CD video medium.
 * Preserves CD audio formats (including Blu-spec CD, SACD, Digital Media, Vinyl, Cassette).
 */
export function isDvdOrBlurayMedium(mediumOrFormat) {
    if (!mediumOrFormat) return false;
    const format = typeof mediumOrFormat === 'string'
        ? mediumOrFormat
        : (mediumOrFormat.mediumFormat || mediumOrFormat.format || '');
    const title = typeof mediumOrFormat === 'object'
        ? (mediumOrFormat.mediumTitle || mediumOrFormat.title || '')
        : '';

    const fLower = format.toLowerCase().trim();
    const tLower = title.toLowerCase().trim();

    // Preserve Blu-spec CD / BSCD (which are standard audio CDs, NOT Blu-ray)
    if (fLower.includes('blu-spec') || fLower.includes('bscd') || tLower.includes('blu-spec') || tLower.includes('bscd')) {
        return false;
    }

    // Match DVD formats: DVD, DVD-Video, DVD-Audio, DVD-R, DVD+R, DVD-RAM, HD-DVD
    if (/\bdvd\b/i.test(fLower) || fLower.includes('dvd-') || fLower.includes('-dvd') || fLower.startsWith('dvd') || fLower.endsWith('dvd')) {
        return true;
    }

    // Match Blu-ray / BD formats: Blu-ray, Blu-ray-R, BD-Video, BD-Audio, BD-R, BD
    if (fLower.includes('blu-ray') || fLower.includes('bluray') || fLower === 'bd' || fLower.startsWith('bd-') || fLower.includes('bd-video') || fLower.includes('bd-audio')) {
        return true;
    }

    // Video media formats
    if (['vcd', 'svcd', 'vhs', 'laserdisc', 'umd', 'betamax', 'video8', 'hd-dvd'].includes(fLower)) {
        return true;
    }

    // Also check medium title if title explicitly mentions DVD / Blu-ray (e.g. "Bonus DVD", "Live Blu-ray", "DVD: ...")
    if (/\b(dvd|blu-ray|bluray|vhs|laserdisc)\b/i.test(tLower)) {
        return true;
    }

    return false;
}

/**
 * Detect whether a medium format or medium title indicates a Vinyl or Cassette/Tape medium.
 */
export function isVinylOrTapeMedium(mediumOrFormat) {
    if (!mediumOrFormat) return false;
    const format = typeof mediumOrFormat === 'string'
        ? mediumOrFormat
        : (mediumOrFormat.mediumFormat || mediumOrFormat.format || '');
    const title = typeof mediumOrFormat === 'object'
        ? (mediumOrFormat.mediumTitle || mediumOrFormat.title || '')
        : '';

    const fLower = format.toLowerCase().trim();
    const tLower = title.toLowerCase().trim();

    if (fLower.includes('vinyl') || fLower.includes('cassette') || fLower.includes('tape') || fLower === 'lp' || fLower.includes('flexi-disc')) {
        return true;
    }
    if (/\b(vinyl|cassette|tape|flexi-disc)\b/i.test(tLower)) {
        return true;
    }
    return false;
}

/**
 * Strips instrumental markers and cleans track title for comparison.
 */
export function cleanTrackTitleForMatching(title) {
    if (!title) return '';
    return title
        .replace(/\s*[\(\[](?:[^)\]]*\b)?instrumental(?:\b[^)\]]*)?[\)\]]/gi, '')
        .replace(/\s*-\s*instrumental(\s+(version|mix))?/gi, '')
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Checks if a track title or its medium title indicates an instrumental version.
 */
export function hasInstrumentalIndicator(title, mediumTitle = '') {
    if (mediumTitle && /\binstrumentals?\b/i.test(mediumTitle)) return true;
    if (!title) return false;
    return /\binstrumentals?\b/i.test(title);
}

/**
 * Detects whether a medium (position > 1) is an instrumental duplicate disc
 * where all tracks on this medium are instrumental versions of tracks from an earlier medium (e.g. CD1).
 */
export function isInstrumentalBonusMedium(tracksOnMedium, earlierTracks, mediumTitle = '') {
    if (!tracksOnMedium || tracksOnMedium.length === 0) return false;
    if (!earlierTracks || earlierTracks.length === 0) return false;

    const earlierCleanTitles = new Set(
        earlierTracks.map(t => cleanTrackTitleForMatching(t.title || t.name || ''))
    );

    return tracksOnMedium.every(t => {
        const rawTitle = t.title || t.name || '';
        const hasMarker = hasInstrumentalIndicator(rawTitle, mediumTitle || t.mediumTitle || '');
        const clean = cleanTrackTitleForMatching(rawTitle);
        return hasMarker && earlierCleanTitles.has(clean);
    });
}

/**
 * Filter out instrumental bonus discs from a list of tracks or songs.
 */
export function filterInstrumentalBonusDiscs(tracks = []) {
    if (!tracks || tracks.length === 0) return [];

    const mediaMap = new Map();
    for (const t of tracks) {
        const medNum = t.mediumNumber || 1;
        if (!mediaMap.has(medNum)) {
            mediaMap.set(medNum, []);
        }
        mediaMap.get(medNum).push(t);
    }

    const sortedMediumNumbers = Array.from(mediaMap.keys()).sort((a, b) => a - b);
    if (sortedMediumNumbers.length <= 1) {
        return tracks;
    }

    const earlierTracks = [];
    const scrubbedMediumNumbers = new Set();

    for (const medNum of sortedMediumNumbers) {
        const mTracks = mediaMap.get(medNum);
        if (medNum > 1 && isInstrumentalBonusMedium(mTracks, earlierTracks, mTracks[0]?.mediumTitle || '')) {
            scrubbedMediumNumbers.add(medNum);
        } else {
            earlierTracks.push(...mTracks);
        }
    }

    if (scrubbedMediumNumbers.size === 0) {
        return tracks;
    }

    return tracks.filter(t => !scrubbedMediumNumbers.has(t.mediumNumber || 1));
}

/**
 * Detect whether a medium is non-CD (DVD, Blu-ray, or Vinyl/Tape when CD is present).
 */
export function isNonCdMedium(mediumOrFormat, hasCdMedia = true) {
    if (isDvdOrBlurayMedium(mediumOrFormat)) return true;
    if (hasCdMedia && isVinylOrTapeMedium(mediumOrFormat)) return true;
    return false;
}

/**
 * Get album details and full tracklist from MusicBrainz.
 * Explicitly prefers US CD/Digital releases, filters out DVD/Blu-ray/Vinyl media (when CD is present), and preserves original release dates.
 */
export function getAlbumTracks(releaseGroupMbid) {
    if (!releaseGroupMbid) return Promise.resolve(null);
    return remembered(`a|${releaseGroupMbid}`, () => getAlbumTracksFresh(releaseGroupMbid), (v) => Boolean(v && v.tracks && v.tracks.length));
}

async function getAlbumTracksFresh(releaseGroupMbid) {
    // 1. Fetch the releases in this release-group with media formats included (one request)
    const releasesUrl = `${MB_BASE}/release?release-group=${releaseGroupMbid}&inc=media&limit=100&fmt=json`;
    const releasesData = await fetchMusicBrainz(releasesUrl);
    const releases = releasesData.releases || [];

    if (releases.length === 0) return null;

    // The canonical year is the earliest release's. It used to be asked of the release group on its own, a request more.
    const releaseYears = releases.map((r) => parseInt(String(r.date || '').slice(0, 4), 10)).filter((y) => y > 1900);
    const originalYear = releaseYears.length ? Math.min(...releaseYears) : null;

    // Sort & select best release (prefer pure CD / Digital Media releases, official status, original year, penalize Vinyl & DVD-only)
    const scoredReleases = releases.map(rel => {
        let score = 0;
        const country = (rel.country || '').toUpperCase();
        if (country === 'US') score += 100;
        else if (country === 'GB' || country === 'UK') score += 50;
        else if (country === 'XE' || country === 'XW' || country === 'CA') score += 30;

        if (rel.status === 'Official') score += 80;
        else if (rel.status === 'Promotion' || rel.status === 'Bootleg') score -= 60;

        const formats = (rel.media || []).map(m => m.format).filter(Boolean);
        const hasCdOrDigital = formats.some(f => !isDvdOrBlurayMedium(f) && !isVinylOrTapeMedium(f) && ['CD', 'Digital Media', 'Enhanced CD', 'Hybrid SACD', 'SACD', 'Blu-spec CD', 'Blu-spec CD2', 'SHM-CD', 'HQCD'].some(cf => f.toLowerCase().includes(cf.toLowerCase())));
        const hasVinylOrTape = formats.some(f => isVinylOrTapeMedium(f));
        const isAllVideoOrDvd = formats.length > 0 && formats.every(f => isDvdOrBlurayMedium(f));
        const isPureCdOrDigital = formats.length > 0 && formats.every(f => !isDvdOrBlurayMedium(f) && !isVinylOrTapeMedium(f));

        if (isPureCdOrDigital) score += 160;
        else if (hasCdOrDigital) score += 80;

        if (hasVinylOrTape) score -= 120;
        if (isAllVideoOrDvd) score -= 300;

        const dateStr = rel.date || '';
        if (dateStr && dateStr.length >= 4 && /^\d{4}/.test(dateStr)) {
            const relYear = parseInt(dateStr.slice(0, 4), 10);
            if (originalYear) {
                if (relYear === originalYear) {
                    score += 80;
                } else {
                    score += Math.max(0, 50 - Math.abs(relYear - originalYear) * 4);
                }
            } else {
                score += 20;
            }
        }

        return { rel, score };
    });

    scoredReleases.sort((a, b) => b.score - a.score);

    // 3. Fetch candidate release details, filtering out DVD, Blu-ray, and Vinyl media (when CD media exist)
    let chosenRelease = null;
    let detailData = null;
    let tracks = [];
    let excludedTracks = [];
    const scrubbedRecordingMbids = new Set();
    const scrubbedMediumNumbers = new Set();

    // Try top candidate releases to ensure we extract CD tracks
    const candidatesToTry = scoredReleases.slice(0, 5);
    for (const { rel } of candidatesToTry) {
        const releaseDetailUrl = `${MB_BASE}/release/${rel.id}?inc=recordings+artists+media&fmt=json`;
        const candidateDetail = await fetchMusicBrainz(releaseDetailUrl);
        const candidateMedia = candidateDetail.media || [];
        const candidateTracks = [];
        const candidateExcluded = [];

        const hasAnyCdOrDigital = candidateMedia.some(m => !isDvdOrBlurayMedium(m) && !isVinylOrTapeMedium(m));

        const earlierMediaTracks = [];

        // Tracks dropped from the list are still returned so the UI can show them grayed out
        const collectExcluded = (medium, mediumNumber, reason) => {
            for (const tr of medium.tracks || []) {
                const recording = tr.recording || {};
                candidateExcluded.push({
                    id: recording.id || tr.id,
                    recordingMbid: recording.id || '',
                    trackNumber: typeof tr.position === 'number' ? tr.position : (parseInt(tr.position || tr.number, 10) || candidateExcluded.length + 1),
                    mediumNumber,
                    mediumTitle: medium.title || '',
                    mediumFormat: medium.format || 'CD',
                    title: tr.title || recording.title || 'Untitled Track',
                    length: tr.length ? Math.round(tr.length / 1000) : (recording.length ? Math.round(recording.length / 1000) : null),
                    excludedReason: reason
                });
            }
        };

        for (const medium of candidateMedia) {
            const mediumTitle = medium.title || '';
            const mediumFormat = medium.format || 'CD';
            const mediumNumber = medium.position || 1;

            const isDvd = isDvdOrBlurayMedium(medium);
            const isVinyl = isVinylOrTapeMedium(medium);

            // Filter out DVD/Blu-ray always, and filter out Vinyl/Tape if CD/Digital media exist in the release
            if (isDvd || (isVinyl && hasAnyCdOrDigital)) {
                scrubbedMediumNumbers.add(mediumNumber);
                collectExcluded(medium, mediumNumber, isDvd ? 'video' : 'vinyl');
                for (const tr of medium.tracks || []) {
                    const recording = tr.recording || {};
                    if (recording.id) scrubbedRecordingMbids.add(recording.id);
                    if (tr.id) scrubbedRecordingMbids.add(tr.id);
                }
                continue;
            }

            // Filter out instrumental duplicate bonus media (e.g. CD2/CD3 where all tracks are instrumental versions of CD1)
            const medTracks = (medium.tracks || []).map(tr => ({
                title: tr.title || tr.recording?.title || '',
                id: tr.recording?.id || tr.id,
                recording: tr.recording
            }));

            if (mediumNumber > 1 && isInstrumentalBonusMedium(medTracks, earlierMediaTracks, mediumTitle)) {
                scrubbedMediumNumbers.add(mediumNumber);
                collectExcluded(medium, mediumNumber, 'instrumental');
                for (const tr of medium.tracks || []) {
                    const recording = tr.recording || {};
                    if (recording.id) scrubbedRecordingMbids.add(recording.id);
                    if (tr.id) scrubbedRecordingMbids.add(tr.id);
                }
                continue;
            }

            earlierMediaTracks.push(...medTracks);

            for (const tr of medium.tracks || []) {
                const recording = tr.recording || {};
                let title = tr.title || recording.title || 'Untitled Track';
                const disambig = (tr.disambiguation || recording.disambiguation || '').trim();
                if (disambig) {
                    const cleanD = disambig.replace(/^\((.+)\)$/, '$1').trim();
                    if (cleanD && !title.toLowerCase().includes(cleanD.toLowerCase())) {
                        title = `${title} (${cleanD})`;
                    }
                }

                const parsedTrackNum = typeof tr.position === 'number' ? tr.position : (parseInt(tr.position || tr.number, 10) || candidateTracks.length + 1);

                candidateTracks.push({
                    id: recording.id || tr.id,
                    recordingMbid: recording.id || '',
                    trackNumber: parsedTrackNum,
                    mediumNumber,
                    mediumTitle,
                    mediumFormat,
                    title,
                    length: tr.length ? Math.round(tr.length / 1000) : (recording.length ? Math.round(recording.length / 1000) : null),
                    artist: candidateDetail['artist-credit']?.map(ac => ac.name || ac.artist?.name).join('') || 'Unknown Artist',
                    album: candidateDetail.title,
                    year: originalYear || (candidateDetail.date ? parseInt(candidateDetail.date.slice(0, 4), 10) : null),
                    coverUrl: getCoverArtUrl(releaseGroupMbid, rel.id)
                });
            }
        }

        if (candidateTracks.length > 0 || !chosenRelease) {
            chosenRelease = rel;
            detailData = candidateDetail;
            tracks = candidateTracks;
            excludedTracks = candidateExcluded;
            if (candidateTracks.length > 0) {
                break;
            }
        }
    }

    if (!chosenRelease || !detailData) {
        chosenRelease = scoredReleases[0].rel;
        const releaseDetailUrl = `${MB_BASE}/release/${chosenRelease.id}?inc=recordings+artists+media&fmt=json`;
        detailData = await fetchMusicBrainz(releaseDetailUrl);
    }

    const artistCredit = detailData['artist-credit']?.map(ac => ac.name || ac.artist?.name).join('') || 'Unknown Artist';
    const year = originalYear || (detailData.date ? parseInt(detailData.date.slice(0, 4), 10) : null);
    const coverUrl = getCoverArtUrl(releaseGroupMbid, chosenRelease.id);

    return {
        releaseGroupId: releaseGroupMbid,
        releaseId: chosenRelease.id,
        title: detailData.title,
        artist: artistCredit,
        artistMbid: detailData['artist-credit']?.[0]?.artist?.id || '',
        country: chosenRelease.country || 'US',
        year,
        coverUrl,
        tracks,
        excludedTracks,
        hasCdMedia: Boolean(tracks.some(t => !isVinylOrTapeMedium(t) && !isDvdOrBlurayMedium(t))),
        scrubbedRecordingMbids: Array.from(scrubbedRecordingMbids),
        scrubbedMediumNumbers: Array.from(scrubbedMediumNumbers)
    };
}
