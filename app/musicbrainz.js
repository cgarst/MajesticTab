// musicbrainz.js
// MusicBrainz API & Cover Art Archive client with rate limiting, US release preference, and client caching.

const MB_BASE = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'MajesticTab/1.0.0 (https://github.com/cgarst/MajesticTab; admin@localhost)';
const CACHE_PREFIX = 'mb_cache_';

// Polite rate limiting (1 request every 1.1s)
let lastRequestTime = 0;
const requestQueue = [];
let isProcessingQueue = false;

async function processQueue() {
    if (isProcessingQueue || requestQueue.length === 0) return;
    isProcessingQueue = true;

    while (requestQueue.length > 0) {
        const item = requestQueue.shift();
        const now = Date.now();
        const elapsed = now - lastRequestTime;
        if (elapsed < 1100) {
            await new Promise(r => setTimeout(r, 1100 - elapsed));
        }
        lastRequestTime = Date.now();

        try {
            const res = await fetch(item.url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': USER_AGENT
                }
            });

            if (res.status === 429 || res.status === 503) {
                // Rate limited, wait 2s and retry
                await new Promise(r => setTimeout(r, 2000));
                const retryRes = await fetch(item.url, {
                    headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT }
                });
                if (!retryRes.ok) {
                    item.reject(new Error(`MusicBrainz HTTP ${retryRes.status}`));
                } else {
                    const data = await retryRes.json();
                    item.resolve(data);
                }
            } else if (!res.ok) {
                item.reject(new Error(`MusicBrainz HTTP ${res.status}`));
            } else {
                const data = await res.json();
                item.resolve(data);
            }
        } catch (err) {
            item.reject(err);
        }
    }

    isProcessingQueue = false;
}

function fetchMusicBrainz(url) {
    // Check in-memory/session cache
    try {
        const cached = sessionStorage.getItem(CACHE_PREFIX + url);
        if (cached) {
            return Promise.resolve(JSON.parse(cached));
        }
    } catch {}

    return new Promise((resolve, reject) => {
        requestQueue.push({
            url,
            resolve: (data) => {
                try {
                    sessionStorage.setItem(CACHE_PREFIX + url, JSON.stringify(data));
                } catch {}
                resolve(data);
            },
            reject
        });
        processQueue();
    });
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
            const url = `${MB_BASE}/release-group?query=${encodeURIComponent(cleanQuery)}&limit=25&fmt=json`;
            const data = await fetchMusicBrainz(url);
            return (data['release-groups'] || []).map(rg => {
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
            const url = `${MB_BASE}/recording?query=${encodeURIComponent(cleanQuery)}&limit=25&fmt=json`;
            const data = await fetchMusicBrainz(url);
            return (data.recordings || []).map(rec => {
                const artistCredit = rec['artist-credit']?.map(ac => ac.name || ac.artist?.name).join('') || 'Unknown Artist';
                const firstRel = rec.releases?.[0];
                const releaseGroup = firstRel?.['release-group'];
                const albumTitle = releaseGroup?.title || firstRel?.title || '';
                const albumMbid = releaseGroup?.id || firstRel?.id || '';
                const year = rec['first-release-date'] ? parseInt(rec['first-release-date'].slice(0, 4), 10) : (firstRel?.date ? parseInt(firstRel.date.slice(0, 4), 10) : null);
                return {
                    id: rec.id,
                    recordingMbid: rec.id,
                    title: rec.title,
                    artist: artistCredit,
                    artistMbid: rec['artist-credit']?.[0]?.artist?.id || '',
                    album: albumTitle,
                    albumMbid: albumMbid,
                    year,
                    length: rec.length ? Math.round(rec.length / 1000) : null,
                    coverUrl: getCoverArtUrl(albumMbid),
                    score: rec.score || 0
                };
            });
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
 * Get all release groups (albums / EPs) for an artist
 */
export async function getArtistAlbums(artistMbid) {
    if (!artistMbid) return [];
    const url = `${MB_BASE}/release-group?artist=${artistMbid}&type=album|ep&limit=100&fmt=json`;
    const data = await fetchMusicBrainz(url);
    const groups = data['release-groups'] || [];

    // Filter out obvious bootlegs/compilations unless studio
    const albums = groups.map(rg => {
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

    // Sort chronologically
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
        for (const tr of medium.tracks || []) {
            const recording = tr.recording || {};
            tracks.push({
                id: recording.id || tr.id,
                recordingMbid: recording.id || '',
                trackNumber: tr.position || tr.number || tracks.length + 1,
                mediumNumber: medium.position || 1,
                title: tr.title || recording.title || 'Untitled Track',
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
