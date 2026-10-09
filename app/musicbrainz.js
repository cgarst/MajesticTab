// musicbrainz.js
// MusicBrainz API & Cover Art Archive client with rate limiting, US release preference, and client caching.

const MB_BASE = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'MajesticTab/1.0.0 (https://github.com/cgarst/MajesticTab; admin@localhost)';
const CACHE_PREFIX = 'mb_cache_';

// Polite rate limiting (1 request every 1.15s with exponential backoff on rate limits)
const MIN_REQUEST_INTERVAL = 1150;
const MAX_RETRIES = 4;

let lastRequestTime = 0;
const requestQueue = [];
let isProcessingQueue = false;
const inFlightRequests = new Map();

/**
 * Execute a single HTTP request to MusicBrainz with automatic exponential backoff retry.
 */
async function executeWithRetry(url, maxRetries = MAX_RETRIES) {
    let attempt = 0;
    let delay = 1500;

    while (attempt <= maxRetries) {
        // Enforce minimum rate limiting interval before each request
        const now = Date.now();
        const elapsed = now - lastRequestTime;
        if (elapsed < MIN_REQUEST_INTERVAL) {
            await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - elapsed));
        }
        lastRequestTime = Date.now();

        try {
            const res = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': USER_AGENT
                }
            });
            lastRequestTime = Date.now();

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
                await new Promise(r => setTimeout(r, waitTime));
                delay *= 2; // exponential backoff (1.5s -> 3s -> 6s -> 12s)
                continue;
            }

            throw new Error(`MusicBrainz HTTP ${status}`);
        } catch (err) {
            lastRequestTime = Date.now();
            const isNetworkError = !err.message?.startsWith('MusicBrainz HTTP');
            if (isNetworkError && attempt < maxRetries) {
                attempt++;
                const waitTime = delay + Math.floor(Math.random() * 500);
                console.warn(`[MusicBrainz] Network error (${err.message}). Retrying attempt ${attempt}/${maxRetries} in ${waitTime}ms...`);
                await new Promise(r => setTimeout(r, waitTime));
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
        try {
            const data = await executeWithRetry(item.url);
            item.resolve(data);
        } catch (err) {
            item.reject(err);
        }
    }

    isProcessingQueue = false;
}

export function fetchMusicBrainz(url) {
    // Check in-memory/session cache
    try {
        const cached = sessionStorage.getItem(CACHE_PREFIX + url);
        if (cached) {
            return Promise.resolve(JSON.parse(cached));
        }
    } catch {}

    // Check if there is already an in-flight request for this exact URL
    if (inFlightRequests.has(url)) {
        return inFlightRequests.get(url);
    }

    const promise = new Promise((resolve, reject) => {
        requestQueue.push({
            url,
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
        });
        processQueue();
    });

    inFlightRequests.set(url, promise);
    return promise;
}

/**
 * Placeholder SVG for missing cover artwork
 */
export function getPlaceholderCoverSvg(title = 'Tab') {
    const initial = (title || 'T').trim().charAt(0).toUpperCase() || 'T';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="#1a1528"/><circle cx="100" cy="100" r="45" fill="#2c2440"/><path d="M90 80 L120 100 L90 120 Z" fill="#a855f7"/><text x="100" y="170" font-size="20" font-family="sans-serif" font-weight="bold" fill="#94a3b8" text-anchor="middle">${initial}</text></svg>`;
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

/**
 * Search MusicBrainz by entity type (artist, album, song, musician)
 */
export async function searchMusicBrainz(query, type = 'artist') {
    if (!query || !query.trim()) return [];
    const cleanQuery = query.trim().replace(/['"()]/g, '');

    switch (type) {
        case 'artist': {
            const url = `${MB_BASE}/artist?query=${encodeURIComponent(cleanQuery)}&limit=25&fmt=json`;
            const data = await fetchMusicBrainz(url);
            return (data.artists || []).map(a => ({
                id: a.id,
                name: a.name,
                disambiguation: a.disambiguation || '',
                type: a.type || 'Artist',
                country: a.country || a.area?.name || '',
                lifeSpan: a['life-span'] ? `${a['life-span'].begin?.slice(0, 4) || ''} - ${a['life-span'].ended ? a['life-span'].end?.slice(0, 4) || 'Present' : 'Present'}` : '',
                score: a.score || 0
            }));
        }

        case 'album': {
            const url = `${MB_BASE}/release-group?query=${encodeURIComponent(cleanQuery)}&limit=40&fmt=json`;
            const data = await fetchMusicBrainz(url);
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
            const url = `${MB_BASE}/recording?query=${encodeURIComponent(lucene)}&limit=100&fmt=json`;
            const data = await fetchMusicBrainz(url);
            return scoreAndRankRecordings(data.recordings || [], cleanQuery);
        }

        case 'musician': {
            // Search artists with Person type prioritized, then relations
            const url = `${MB_BASE}/artist?query=${encodeURIComponent(cleanQuery)}&limit=25&fmt=json`;
            const data = await fetchMusicBrainz(url);
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
export async function getArtistAlbums(artistMbid) {
    if (!artistMbid) return [];
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
 * Get album details and full tracklist from MusicBrainz.
 * Explicitly prefers US release as specified in requirements.
 */
export async function getAlbumTracks(releaseGroupMbid) {
    if (!releaseGroupMbid) return null;

    // 1. Fetch releases in this release-group
    const releasesUrl = `${MB_BASE}/release?release-group=${releaseGroupMbid}&limit=50&fmt=json`;
    const releasesData = await fetchMusicBrainz(releasesUrl);
    const releases = releasesData.releases || [];

    if (releases.length === 0) return null;

    // Sort & select best release (prefer US release, official status)
    const scoredReleases = releases.map(rel => {
        let score = 0;
        const country = (rel.country || '').toUpperCase();
        if (country === 'US') score += 100;
        if (country === 'GB' || country === 'UK') score += 30;
        if (rel.status === 'Official') score += 50;
        if (rel.date) score += 10;
        return { rel, score };
    });

    scoredReleases.sort((a, b) => b.score - a.score);
    const chosenRelease = scoredReleases[0].rel;

    // 2. Fetch full release details with recordings
    const releaseDetailUrl = `${MB_BASE}/release/${chosenRelease.id}?inc=recordings+artists+media&fmt=json`;
    const detailData = await fetchMusicBrainz(releaseDetailUrl);

    const artistCredit = detailData['artist-credit']?.map(ac => ac.name || ac.artist?.name).join('') || 'Unknown Artist';
    const year = detailData.date ? parseInt(detailData.date.slice(0, 4), 10) : null;
    const coverUrl = getCoverArtUrl(releaseGroupMbid, chosenRelease.id);

    const tracks = [];
    const media = detailData.media || [];

    for (const medium of media) {
        const mediumTitle = medium.title || '';
        const mediumFormat = medium.format || 'CD';
        const mediumNumber = medium.position || 1;

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

            const parsedTrackNum = typeof tr.position === 'number' ? tr.position : (parseInt(tr.position || tr.number, 10) || tracks.length + 1);

            tracks.push({
                id: recording.id || tr.id,
                recordingMbid: recording.id || '',
                trackNumber: parsedTrackNum,
                mediumNumber,
                mediumTitle,
                mediumFormat,
                title,
                length: tr.length ? Math.round(tr.length / 1000) : (recording.length ? Math.round(recording.length / 1000) : null),
                artist: artistCredit,
                album: detailData.title,
                year,
                coverUrl
            });
        }
    }

    return {
        releaseGroupId: releaseGroupMbid,
        releaseId: chosenRelease.id,
        title: detailData.title,
        artist: artistCredit,
        artistMbid: detailData['artist-credit']?.[0]?.artist?.id || '',
        country: chosenRelease.country || 'US',
        year,
        coverUrl,
        tracks
    };
}
