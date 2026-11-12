// build/tauri/stubs/system-browser/tabDownloader.js
// System-browser search stub for store builds (Google Play, Apple App Store, Microsoft Store).
// Replaces the in-app browser with direct handoff to the system's default web browser.

export const SOURCES_STORAGE_KEY = 'majestictab_tab_sources';
export const SOURCES_DELETED_KEY = 'majestictab_tab_sources_deleted';
export const DUCKDUCKGO_FIRST_KEY = 'majestictab_tab_sources_duckduckgo_first';

export function isNative() {
    return typeof window !== 'undefined' && (Boolean(window.__TAURI__) || Boolean(window.MajesticDownloaderNative));
}

export function isDesktopNative() {
    return typeof window !== 'undefined' && Boolean(window.__TAURI__) && !/android|iphone|ipad|ipod/i.test(navigator.userAgent || '');
}

const GOOGLE_HOME_URL = 'https://www.google.com/';
const DUCKDUCKGO_HOME_URL = 'https://duckduckgo.com/';

export const DEFAULT_SOURCES = [
    {
        id: 'duckduckgo',
        name: 'DuckDuckGo',
        urlTemplate: 'https://duckduckgo.com/?q=$s+guitar+tab',
        defaultUrl: 'https://duckduckgo.com/?q=$s+guitar+tab',
        queryFormat: 'artist_song',
        isSeed: true
    },
    {
        id: 'google',
        name: 'Google',
        urlTemplate: 'https://www.google.com/search?q=$s+guitar+tab',
        defaultUrl: 'https://www.google.com/search?q=$s+guitar+tab',
        queryFormat: 'artist_song',
        isSeed: true
    }
];

export function formatSearchQueryForSource(source, artist = '', songName = '') {
    const art = (artist || '').trim();
    const song = (songName || '').trim();

    if (source?.queryFormat === 'song_only') {
        return song || art;
    }
    if (art && song) {
        return `${art} ${song}`;
    }
    return song || art;
}

export function getSources() {
    try {
        const raw = localStorage.getItem(SOURCES_STORAGE_KEY);
        if (raw) {
            let parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
                const seedIds = new Set(DEFAULT_SOURCES.map(s => s.id));
                const pruned = parsed.filter(s => !s.isSeed || seedIds.has(s.id));
                let changed = pruned.length !== parsed.length;
                if (changed) {
                    parsed = pruned;
                    saveSources(parsed.length > 0 ? parsed : []);
                }
                if (parsed.length === 0) return resetToDefaultSources();
                for (let j = 0; j < parsed.length; j++) {
                    const s = parsed[j];
                    if ('userscript' in s || 'userscriptEnabled' in s || 'defaultUserscript' in s) {
                        delete s.userscript;
                        delete s.userscriptEnabled;
                        delete s.defaultUserscript;
                        changed = true;
                    }
                }
                for (let i = 0; i < DEFAULT_SOURCES.length; i++) {
                    const seed = DEFAULT_SOURCES[i];
                    const existing = parsed.find(s => s.id === seed.id);
                    if (existing && existing.isSeed) {
                        if (!existing.queryFormat || ((existing.id === 'google' || existing.id === 'duckduckgo') && existing.queryFormat !== 'artist_song')) {
                            existing.queryFormat = seed.queryFormat;
                        }
                        if ((existing.id === 'google' || existing.id === 'duckduckgo') && /\+guitar\+pro\+tab$/.test(existing.urlTemplate || '')) {
                            existing.urlTemplate = seed.urlTemplate;
                            existing.defaultUrl = seed.defaultUrl;
                            changed = true;
                        }
                    } else if (!existing) {
                        const prevSeedId = i > 0 ? DEFAULT_SOURCES[i - 1].id : null;
                        const prevIdx = prevSeedId ? parsed.findIndex(s => s.id === prevSeedId) : -1;
                        if (prevIdx !== -1) {
                            parsed.splice(prevIdx + 1, 0, JSON.parse(JSON.stringify(seed)));
                        } else {
                            parsed.push(JSON.parse(JSON.stringify(seed)));
                        }
                        changed = true;
                    }
                }
                if (!localStorage.getItem(DUCKDUCKGO_FIRST_KEY)) {
                    const di = parsed.findIndex(s => s.id === 'duckduckgo');
                    if (di > 0) parsed.unshift(...parsed.splice(di, 1));
                    localStorage.setItem(DUCKDUCKGO_FIRST_KEY, '1');
                    changed = true;
                }
                if (changed) {
                    saveSources(parsed);
                }
                return parsed;
            }
        }
    } catch {}
    return resetToDefaultSources();
}

export function saveSources(sources) {
    try {
        localStorage.setItem(SOURCES_STORAGE_KEY, JSON.stringify(sources));
    } catch {}
}

export function resetToDefaultSources() {
    const sources = [];
    for (const seed of DEFAULT_SOURCES) {
        sources.push(JSON.parse(JSON.stringify(seed)));
    }
    saveSources(sources);
    return sources;
}

export function buildSearchUrl(source, query) {
    if (!source) return GOOGLE_HOME_URL;

    const term = (query || '').trim();
    let template = (source.urlTemplate || '').trim();
    if (template && !/^https?:\/\//i.test(template)) {
        template = 'https://' + template;
    }
    const hasPlaceholder = template.includes('$s') || template.includes('SEARCH+TERM') || template.includes('{search}');

    if (template && !hasPlaceholder) {
        return template;
    }

    if (!term) {
        if (source.id === 'google') return GOOGLE_HOME_URL;
        if (source.id === 'duckduckgo') return DUCKDUCKGO_HOME_URL;
        if (source.defaultUrl) {
            return source.defaultUrl.replace(/\$s|SEARCH\+TERM/g, '').replace(/\{search\}/g, '').replace(/[?&]$/, '');
        }
        if (template) {
            try {
                const u = new URL(template);
                return u.origin + (u.pathname && u.pathname !== '/' ? u.pathname : '/');
            } catch {
                return template.replace(/\$s|SEARCH\+TERM/g, '').replace(/\{search\}/g, '').replace(/[?&]$/, '');
            }
        }
        return GOOGLE_HOME_URL;
    }

    const encodedPlus = encodeURIComponent(term).replace(/%20/g, '+');
    const encodedStandard = encodeURIComponent(term);

    let url = template;
    if (url.includes('$s') || url.includes('SEARCH+TERM')) {
        url = url.replace(/\$s|SEARCH\+TERM/g, () => encodedPlus);
    } else if (url.includes('{search}')) {
        url = url.replace(/\{search\}/g, encodedStandard);
    }
    return url;
}

export function extractSourceWebsite(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./i, '').toLowerCase();
        const sources = getSources();
        for (const s of sources) {
            try {
                const su = new URL(s.defaultUrl || s.urlTemplate);
                const shost = su.hostname.replace(/^www\./i, '').toLowerCase();
                if (shost && (host === shost || host.endsWith('.' + shost))) {
                    return s.name || host;
                }
            } catch {}
        }
        return host;
    } catch {
        return null;
    }
}

export function stampSourceChanges(edited) {
    const now = Date.now();
    const before = new Map(getSources().map(s => [s.id, s]));
    let tombs = {};
    try { tombs = JSON.parse(localStorage.getItem(SOURCES_DELETED_KEY)) || {}; } catch {}
    for (const s of edited) {
        const old = before.get(s.id);
        if (!old || JSON.stringify({ ...old, updatedAt: 0 }) !== JSON.stringify({ ...s, updatedAt: 0 })) {
            s.updatedAt = now;
            delete tombs[s.id];
        }
    }
    const kept = new Set(edited.map(s => s.id));
    for (const [id, old] of before) {
        if (!kept.has(id) && !old.isSeed) tombs[id] = now;
    }
    try { localStorage.setItem(SOURCES_DELETED_KEY, JSON.stringify(tombs)); } catch {}
}

export async function openTabDownloader(options = {}) {
    const sources = getSources();
    const activeSource = (options.targetSourceId && sources.find(s => s.id === options.targetSourceId))
        || sources[0]
        || DEFAULT_SOURCES[0];

    let query = options.query || '';
    if (!query) {
        const artist = options.artist || options.targetSong?.artist || '';
        const songName = options.songName || options.targetSong?.title || '';
        query = formatSearchQueryForSource(activeSource, artist, songName);
    }
    if (!query) {
        query = 'Carulli Duo No 2 In G Major';
    }

    const startUrl = /^https?:\/\//i.test(options.startUrl || '') ? options.startUrl : '';
    const targetUrl = startUrl || buildSearchUrl(activeSource, query);

    const opener = window.__TAURI__?.opener;
    if (opener?.openUrl) {
        await opener.openUrl(targetUrl);
    } else {
        window.open(targetUrl, '_blank', 'noopener');
    }
}

// Inert shims for store builds
export function renderDownloaderTabs() {}
export function initTauriDownloadListener() {}
export function closeTabDownloaderModal() {}
export async function handleWsaUrlIntercept() { return false; }
export function offerWsaUrlBanner() {}
export function navigateToDownloaderUrl() {}
export function showTransientFeedback() {}
export function hideTransientFeedback() {}
export function showAdvisoryBadge() {}
export function hideAdvisoryBadge() {}
export function updateBatchHUD() {}
export function jumpToBatchTrack() {}
export function skipCurrentBatchTrack() {}
export function finishBatchSession() {}
export function undoLastBatchDownload() {}
export async function handleDownloadedTabFile() {}
export function initTabDownloaderDomEvents() {}
export function reloadDownloaderWebview() {}
export async function dispatchNativeAdblock() {}
export function syncDownloaderAdblockButton() {}
export function switchActiveSource() {}
export function highlightSourceTabForUrl() {}
export function showTabDownloaderBar() {}
export function hideTabDownloaderBar() {}
