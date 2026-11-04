// tabDownloader.js
// Native Tab Downloader bridge for MajesticTab across all native platforms (Desktop & Mobile).

import { saveStoredFile } from './fileStore.js';
import { loadFile } from './main.js';
import { addTabOptionToSong, addTabOptionToAlbum, getSongById } from './libraryStore.js';
import { detectFileMetadata } from './utils/tuningUtils.js';
import { closeLibraryModal } from './libraryModal.js';
import { showToast } from './utils/toast.js';
import {
    isWsaTabUrl,
    getDownloaderUrlFromMatchedUrl,
    unwrapGoogleUrl,
    attachSyncForMatchedUrl
} from './utils/downloaderIntercept.js';

export const SOURCES_STORAGE_KEY = 'majestictab_tab_sources';
export const SOURCES_DELETED_KEY = 'majestictab_tab_sources_deleted';
export const DUCKDUCKGO_FIRST_KEY = 'majestictab_tab_sources_duckduckgo_first';

export const ADBLOCK_ENABLED_KEY = 'majestictab_downloader_adblock_enabled';
export const ADBLOCK_HOSTS_KEY = 'majestictab_downloader_adblock_hosts';
export const ADBLOCK_UPDATED_KEY = 'majestictab_downloader_adblock_updated';
export const DEFAULT_ADBLOCK_SOURCE_URL = 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=plain&showintro=0&mimetype=plaintext';

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
        urlTemplate: 'https://duckduckgo.com/?q=$s+guitar+pro+tab',
        defaultUrl: 'https://duckduckgo.com/?q=$s+guitar+pro+tab',
        queryFormat: 'artist_song',
        isSeed: true
    },
    {
        id: 'google',
        name: 'Google',
        urlTemplate: 'https://www.google.com/search?q=$s+guitar+pro+tab',
        defaultUrl: 'https://www.google.com/search?q=$s+guitar+pro+tab',
        queryFormat: 'artist_song',
        isSeed: true
    }
];

let activeTargetSong = null;
let activeTargetAlbum = null;
let activeDownloaderOnFileSelected = null;
let activeArtistName = '';
let activeSongName = '';
let activeSourceId = 'duckduckgo';
let currentSearchQuery = '';
// Source the user just clicked: the tab bar keeps it selected until its page starts loading,
// instead of flickering back to the old page's source while the new one loads.
let pendingSourceId = null;
// Real address of the page in the downloader webview (the bar text can read "Loading...")
let currentDownloaderUrl = '';
// Hidden ephemeral source spawned only when a matched endpoint link is clicked
let activeEphemeralSource = null;
let pendingMatchedTabUrl = null;
let pendingSourceTimer = null;
let loadingBarTimer = null;

/**
 * Show "Loading <source>..." in the URL bar, falling back to the real address if the
 * native page-load event never arrives to replace it.
 * @param {string} sourceName
 */
function showLoadingInUrlBar(sourceName) {
    const urlText = document.getElementById('downloaderUrlText');
    const urlGroup = document.getElementById('downloaderUrlGroup');
    const loadingMsg = 'Loading ' + sourceName + '...';
    if (urlText) urlText.textContent = loadingMsg;
    if (urlGroup) urlGroup.title = loadingMsg;
    clearTimeout(loadingBarTimer);
    loadingBarTimer = setTimeout(() => {
        if (!currentDownloaderUrl) return;
        if (urlText && urlText.textContent === loadingMsg) urlText.textContent = currentDownloaderUrl;
        if (urlGroup && urlGroup.title === loadingMsg) urlGroup.title = currentDownloaderUrl;
    }, 4000);
}
let lastDownloadedTime = 0;
let lastDownloadedName = '';

/**
 * Format search query for a specific source configuration
 */
export function formatSearchQueryForSource(source, artist = '', songName = '') {
    const art = (artist || '').trim();
    const song = (songName || '').trim();

    if (source?.queryFormat === 'song_only') {
        return song || art;
    }
    // Default: 'artist_song'
    if (art && song) {
        return `${art} ${song}`;
    }
    return song || art;
}

/**
 * Get configured sources with fallback to defaults
 */
export function getSources() {
    try {
        const raw = localStorage.getItem(SOURCES_STORAGE_KEY);
        if (raw) {
            let parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
                // Seeds removed from DEFAULT_SOURCES (Ultimate Guitar, Classical Tab) linger in
                // storage as undeletable isSeed entries; drop them.
                const seedIds = new Set(DEFAULT_SOURCES.map(s => s.id));
                const pruned = parsed.filter(s => !s.isSeed || seedIds.has(s.id));
                let changed = pruned.length !== parsed.length;
                if (changed) {
                    parsed = pruned;
                    saveSources(parsed.length > 0 ? parsed : []);
                }
                if (parsed.length === 0) return resetToDefaultSources();
                // Strip legacy userscript fields from restored/stored sources
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
                        if (existing.id === 'google' && /^https:\/\/www\.google\.com\/search\?q=(SEARCH\+TERM|\$s)\+tab$/.test(existing.urlTemplate || '')) {
                            existing.urlTemplate = seed.urlTemplate;
                            existing.defaultUrl = seed.defaultUrl;
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
                // One-time: put DuckDuckGo first, the default source (later user reordering is preserved)
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

/**
 * Persist sources list to localStorage
 */
export function saveSources(sources) {
    try {
        localStorage.setItem(SOURCES_STORAGE_KEY, JSON.stringify(sources));
    } catch {}
}

/**
 * Reset sources list back to built-in defaults
 */
export function resetToDefaultSources() {
    const sources = [];
    for (const seed of DEFAULT_SOURCES) {
        sources.push(JSON.parse(JSON.stringify(seed)));
    }
    saveSources(sources);
    return sources;
}

/**
 * Build target search URL from template and query
 */
export function buildSearchUrl(source, query) {
    if (!source) return GOOGLE_HOME_URL;

    const term = (query || '').trim();
    let template = (source.urlTemplate || '').trim();
    if (template && !/^https?:\/\//i.test(template)) {
        template = 'https://' + template;
    }
    const hasPlaceholder = template.includes('$s') || template.includes('SEARCH+TERM') || template.includes('{search}');

    // If the template is a fixed URL without templating placeholders, navigate directly to it
    if (template && !hasPlaceholder) {
        return template;
    }

    // If no query/term was provided, return the home/base URL for the provider
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

/**
 * Core handler for downloaded tab binary payload across all platforms
 * @param {string} name
 * @param {Uint8Array} uint8
 * @param {string|null} [path]
 */
export async function handleDownloadedTabFile(name, uint8, path = null) {
    console.log('[Tab Downloader] Processing downloaded tab file:', name, uint8?.length, 'bytes');

    const now = Date.now();
    if (now - lastDownloadedTime < 2000 && lastDownloadedName === name) {
        console.log('[Tab Downloader] Skipping duplicate download event');
        return;
    }
    lastDownloadedTime = now;
    lastDownloadedName = name;

    if (!uint8 || !uint8.length) {
        console.warn('[Tab Downloader] Received empty byte array for download');
        return;
    }

    const blob = new Blob([uint8], { type: 'application/octet-stream' });
    const file = new File([blob], name || 'downloaded.gp', { type: blob.type, lastModified: Date.now() });

    const targetSong = activeTargetSong;
    const targetAlbum = activeTargetAlbum;
    const onFileSelectedCb = activeDownloaderOnFileSelected;
    const matchedUrl = pendingMatchedTabUrl;

    // Reset targets once consumed
    activeTargetSong = null;
    activeTargetAlbum = null;
    activeDownloaderOnFileSelected = null;
    pendingMatchedTabUrl = null;
    activeEphemeralSource = null;

    // Close / hide downloader
    closeTabDownloaderModal();

    if (typeof onFileSelectedCb === 'function') {
        const meta = await detectFileMetadata(file, file.name);
        const stored = await saveStoredFile(file, 'tab-downloader', {
            name: file.name,
            relativePath: path || file.name
        });
        closeLibraryModal(true);
        onFileSelectedCb({ file, providerId: 'tab-downloader', fileStoreId: stored.id, name: file.name, meta });
        return;
    }

    // Persist to file store and attach to library song if bound (stay in library, matching Local & Google Drive)
    if (targetSong?.id) {
        const meta = await detectFileMetadata(file, file.name);
        const stored = await saveStoredFile(file, 'tab-downloader', {
            name: file.name,
            relativePath: path || file.name,
            targetSongId: targetSong.id
        });

        await addTabOptionToSong(targetSong.id, {
            name: file.name,
            providerId: 'tab-downloader',
            relativePath: path || file.name,
            fileStoreId: stored.id,
            tuning: meta.primaryTuning,
            tunings: meta.tunings,
            stringCount: meta.stringCount,
            fileType: file.name.split('.').pop().toLowerCase()
        });

        showToast(`Added "${file.name}" to ${targetSong.title || 'song'}`, 'success');
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));

        if (matchedUrl) {
            const songKey = [targetSong.artist, targetSong.title].filter(Boolean).join(' - ') || targetSong.title || file.name;
            attachSyncForMatchedUrl(matchedUrl, { showToast, file, songKey }).catch(err => {
                console.warn('[Tab Downloader] Background sync point attachment failed:', err);
            });
        }

        return; // Do not auto-open into player viewer when adding a tab to a library song
    }

    if (targetAlbum?.albumTitle) {
        const meta = await detectFileMetadata(file, file.name);
        const stored = await saveStoredFile(file, 'tab-downloader', {
            name: file.name,
            relativePath: path || file.name
        });

        await addTabOptionToAlbum(targetAlbum.collectionId, targetAlbum.artistName, targetAlbum.albumTitle, {
            name: file.name,
            providerId: 'tab-downloader',
            relativePath: path || file.name,
            fileStoreId: stored.id,
            tuning: meta.primaryTuning,
            tunings: meta.tunings,
            stringCount: meta.stringCount,
            fileType: file.name.split('.').pop().toLowerCase()
        });

        showToast(`Added "${file.name}" to album`, 'success');
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
        return; // Do not auto-open into player viewer when adding a tab to an album
    }

    // Load file directly into player viewer
    closeLibraryModal(true);
    await loadFile(file);

    try {
        window.focus();
        const output = document.getElementById('output');
        if (output && output.style.display !== 'none') {
            output.focus();
        }
    } catch {}

    if (matchedUrl) {
        attachSyncForMatchedUrl(matchedUrl, { showToast, file });
    }
}

// Global hook for direct evaluation from Kotlin or Rust
if (typeof window !== 'undefined') {
    window.__onTabDownloaded = (name, base64OrData, path = null) => {
        try {
            let uint8;
            if (typeof base64OrData === 'string') {
                const binary = atob(base64OrData);
                uint8 = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    uint8[i] = binary.charCodeAt(i);
                }
            } else if (Array.isArray(base64OrData)) {
                uint8 = new Uint8Array(base64OrData);
            } else if (base64OrData instanceof Uint8Array) {
                uint8 = base64OrData;
            } else {
                console.warn('[Tab Downloader] Unknown data format in __onTabDownloaded:', typeof base64OrData);
                return;
            }
            handleDownloadedTabFile(name, uint8, path);
        } catch (e) {
            console.error('[Tab Downloader] Error handling downloaded tab:', e);
        }
    };
}

let isDomInitialized = false;
let resizeObserver = null;
let currentEditingSourceId = null;
let localEditingSources = [];

/**
 * Initialize event listeners for the native split-webview tab downloader top bar and settings modal
 */
export function initTabDownloaderDomEvents() {
    if (isDomInitialized || typeof document === 'undefined') return;
    isDomInitialized = true;

    // Dismissible hint banner
    const hintBanner = document.getElementById('downloaderHintBanner');
    try {
        if (localStorage.getItem('downloaderHintDismissed') === '1' && hintBanner) hintBanner.style.display = 'none';
    } catch {}
    document.getElementById('downloaderHintDismissBtn')?.addEventListener('click', () => {
        if (hintBanner) hintBanner.style.display = 'none';
        try { localStorage.setItem('downloaderHintDismissed', '1'); } catch {}
    });

    // Navigation buttons
    document.getElementById('downloaderNavBackBtn')?.addEventListener('click', () => {
        if (window.__TAURI__?.core?.invoke) {
            window.__TAURI__.core.invoke('tab_downloader_nav', { action: 'back' }).catch(() => {});
        }
    });

    document.getElementById('downloaderNavForwardBtn')?.addEventListener('click', () => {
        if (window.__TAURI__?.core?.invoke) {
            window.__TAURI__.core.invoke('tab_downloader_nav', { action: 'forward' }).catch(() => {});
        }
    });

    document.getElementById('downloaderNavReloadBtn')?.addEventListener('click', () => {
        if (window.__TAURI__?.core?.invoke) {
            window.__TAURI__.core.invoke('tab_downloader_nav', { action: 'reload' }).catch(() => {});
        }
    });

    document.getElementById('downloaderCopyUrlBtn')?.addEventListener('click', async () => {
        const url = currentDownloaderUrl;
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            showToast('Web address copied', 'success');
        } catch {
            showToast('Could not copy the web address', 'error');
        }
    });

    // DevTools button
    document.getElementById('downloaderDevToolsBtn')?.addEventListener('click', () => {
        if (window.__TAURI__?.core?.invoke) {
            window.__TAURI__.core.invoke('tab_downloader_open_devtools').catch(() => {});
        }
    });

    // Adblock button
    const adblockBtn = document.getElementById('downloaderAdblockBtn');
    if (adblockBtn) {
        syncDownloaderAdblockButton();
        adblockBtn.addEventListener('click', async () => {
            const next = !isAdblockEnabled();
            const status = getAdblockStatus();
            if (next && status.count === 0) {
                showToast('Enabling adblock (downloading community list)...', 3000);
            }
            try {
                const res = await setAdblockEnabled(next);
                if (res.enabled) {
                    showToast(`Adblock active (${res.count.toLocaleString()} domains)`, 2500);
                } else {
                    showToast('Adblock disabled', 2500);
                }
            } catch (err) {
                showToast('Failed to update adblock rules', 3000);
            }
        });
    }

    // Initialize native adblock rules if enabled
    if (isAdblockEnabled()) {
        try {
            const cached = JSON.parse(localStorage.getItem(ADBLOCK_HOSTS_KEY) || '[]');
            if (cached.length) {
                dispatchNativeAdblock(cached, true);
            } else {
                setAdblockEnabled(true).catch(() => {});
            }
        } catch {}
    }

    // Close button
    document.getElementById('downloaderCloseBtn')?.addEventListener('click', () => {
        closeTabDownloaderModal(true);
    });

    // Keyboard shortcut Escape
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const bar = document.getElementById('tabDownloaderBar');
            if (bar && bar.style.display !== 'none') {
                closeTabDownloaderModal(true);
                e.preventDefault();
                e.stopPropagation();
            }
        }
    });
}

export function isAdblockEnabled() {
    try {
        return localStorage.getItem(ADBLOCK_ENABLED_KEY) === 'true';
    } catch {
        return false;
    }
}

export function getAdblockStatus() {
    let hostsCount = 0;
    try {
        const raw = localStorage.getItem(ADBLOCK_HOSTS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            hostsCount = Array.isArray(parsed) ? parsed.length : 0;
        }
    } catch {}
    const lastUpdated = Number(localStorage.getItem(ADBLOCK_UPDATED_KEY) || 0);
    return {
        enabled: isAdblockEnabled(),
        count: hostsCount,
        lastUpdated
    };
}

export async function setAdblockEnabled(enabled, forceRefresh = false) {
    try {
        localStorage.setItem(ADBLOCK_ENABLED_KEY, enabled ? 'true' : 'false');
    } catch {}

    if (!enabled) {
        await dispatchNativeAdblock([], false);
        syncDownloaderAdblockButton();
        return { enabled: false, count: 0, lastUpdated: 0 };
    }

    let hosts = [];
    try {
        hosts = JSON.parse(localStorage.getItem(ADBLOCK_HOSTS_KEY) || '[]');
    } catch {}

    let lastUpdated = Number(localStorage.getItem(ADBLOCK_UPDATED_KEY) || 0);
    const isStale = (Date.now() - lastUpdated) > (7 * 24 * 60 * 60 * 1000);

    if (!hosts.length || isStale || forceRefresh) {
        try {
            const fetchFn = (typeof window !== 'undefined' && typeof window.__TAURI__?.http?.fetch === 'function')
                ? window.__TAURI__.http.fetch
                : fetch;
            const res = await fetchFn(DEFAULT_ADBLOCK_SOURCE_URL);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            let text = '';
            if (typeof res.arrayBuffer === 'function') {
                try {
                    const buf = await res.arrayBuffer();
                    const bytes = new Uint8Array(buf);
                    if (bytes[0] === 0x1f && bytes[1] === 0x8b && typeof DecompressionStream === 'function') {
                        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
                        text = await new Response(stream).text();
                    } else {
                        text = new TextDecoder().decode(bytes);
                    }
                } catch {
                    text = await res.text();
                }
            } else {
                text = await res.text();
            }
            hosts = text.split('\n')
                .map(line => line.trim().toLowerCase())
                .filter(line => line && !line.startsWith('#') && !line.startsWith('!') && !line.startsWith('//'));

            lastUpdated = Date.now();
            try {
                localStorage.setItem(ADBLOCK_HOSTS_KEY, JSON.stringify(hosts));
                localStorage.setItem(ADBLOCK_UPDATED_KEY, String(lastUpdated));
            } catch {}
        } catch (err) {
            console.warn('[Tab Downloader] Failed to fetch adblock list:', err);
            if (forceRefresh || !hosts.length) {
                throw err;
            }
        }
    }

    await dispatchNativeAdblock(hosts, true);
    syncDownloaderAdblockButton();
    return { enabled: true, count: hosts.length, lastUpdated };
}

export async function dispatchNativeAdblock(hosts, enabled) {
    if (window.MajesticDownloaderNative?.setBlockedHosts) {
        try {
            window.MajesticDownloaderNative.setBlockedHosts(enabled ? JSON.stringify(hosts) : '[]');
        } catch (e) {
            console.warn('[Tab Downloader] Android setBlockedHosts bridge failed:', e);
        }
    }
    if (window.__TAURI__?.core?.invoke) {
        try {
            await window.__TAURI__.core.invoke('tab_downloader_set_adblock_rules', {
                enabled,
                hosts: enabled ? hosts : []
            });
        } catch (e) {
            console.warn('[Tab Downloader] Tauri tab_downloader_set_adblock_rules failed:', e);
        }
    }
}

export function syncDownloaderAdblockButton() {
    const btn = document.getElementById('downloaderAdblockBtn');
    if (!btn) return;
    const enabled = isAdblockEnabled();
    btn.setAttribute('aria-pressed', String(enabled));
    btn.classList.toggle('active', enabled);
    btn.title = enabled ? 'Adblock active (click to turn off)' : 'Block ads and trackers';
    const icon = btn.querySelector('i');
    if (icon) {
        icon.className = enabled ? 'bi-shield-check' : 'bi-shield';
    }
}

/**
 * Tell the native shell how tall the top bar is so the content webview starts below it.
 * @param {number} cssHeight
 */
function syncDownloaderTopOffset(cssHeight) {
    if (window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('tab_downloader_update', { topOffset: cssHeight }).catch(() => {});
    }
    try { window.MajesticDownloaderNative?.setTopInsetPx?.(Math.round(cssHeight * (window.devicePixelRatio || 1))); } catch {}
}

/**
 * Mark the sources this save edited or added with updatedAt, and record the deleted ones with the
 * time, so sync can tell a newer edit or a deletion from a stale copy on another device.
 * @param {object[]} edited
 */
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

/**
 * Render tab provider pills in the top bar
 */
export function renderDownloaderTabs() {
    const container = document.getElementById('downloaderTabsRow');
    if (!container) return;

    const sources = [...getSources()];
    if (activeEphemeralSource) {
        sources.push({
            id: activeEphemeralSource.id,
            name: activeEphemeralSource.name,
            defaultUrl: activeEphemeralSource.url,
            urlTemplate: activeEphemeralSource.url
        });
    }
    let html = sources.map(s => `
        <button type="button" class="downloader-source-tab-btn ${s.id === activeSourceId ? 'active' : ''}" data-source-id="${s.id}" title="${s.name}">
            <i class="bi-globe"></i>
            <span>${s.name}</span>
        </button>
    `).join('');

    container.innerHTML = html;

    container.querySelectorAll('.downloader-source-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const sid = btn.dataset.sourceId;
            const src = sources.find(s => s.id === sid);
            if (src) {
                switchActiveSource(src);
            }
        });
    });
}

/**
 * Switch active source and navigate the webview
 * @param {Object} src
 */
export function switchActiveSource(src) {
    activeSourceId = src.id;
    pendingSourceId = src.id;
    clearTimeout(pendingSourceTimer);
    pendingSourceTimer = setTimeout(() => { pendingSourceId = null; }, 10000);
    const container = document.getElementById('downloaderTabsRow');
    if (container) {
        container.querySelectorAll('.downloader-source-tab-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.sourceId === src.id);
        });
    }

    showLoadingInUrlBar(src.name);

    let nextUrl;
    if (src.id === 'downloader' && activeEphemeralSource) {
        nextUrl = activeEphemeralSource.url;
    } else {
        const query = formatSearchQueryForSource(src, activeArtistName, activeSongName) || currentSearchQuery;
        nextUrl = buildSearchUrl(src, query);
    }
    currentDownloaderUrl = nextUrl;

    if (window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('tab_downloader_navigate', { url: nextUrl }).then(() => {
            if (src.id === 'downloader' && activeEphemeralSource?.targetUrl) {
                window.__TAURI__.core.invoke('tab_downloader_prefill', { targetUrl: activeEphemeralSource.targetUrl }).catch(() => {});
            }
        }).catch(err => {
            console.error('[Tab Downloader] Failed to navigate to source:', err);
        });
    }
}

/**
 * Drop fragments that ad scripts append to the page URL (e.g. #google_vignette, #aswift_1)
 * @param {string} url
 */
function stripAdFragment(url) {
    return url.replace(/#(google_vignette|aswift_\d+[^#]*|gpt-[^#]*)$/i, '');
}

/**
 * Highlight matching source tab if webview navigates to a known source domain
 * @param {string} url
 */
export function highlightSourceTabForUrl(url) {
    if (!url) return;
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        let matchedId = null;
        const sources = [...getSources()];
        if (activeEphemeralSource) {
            sources.push({
                id: activeEphemeralSource.id,
                defaultUrl: activeEphemeralSource.url,
                urlTemplate: activeEphemeralSource.url
            });
        }
        for (const s of sources) {
            try {
                const su = new URL(s.defaultUrl || s.urlTemplate);
                if (su.hostname && host.includes(su.hostname)) {
                    matchedId = s.id;
                    break;
                }
            } catch {}
        }
        if (pendingSourceId) {
            // Ignore URL events from the page being left; the target source's page ends the wait
            if (matchedId && matchedId !== pendingSourceId) return false;
            if (matchedId) {
                pendingSourceId = null;
                clearTimeout(pendingSourceTimer);
            }
        }
        if (matchedId && matchedId !== activeSourceId) {
            activeSourceId = matchedId;
            const container = document.getElementById('downloaderTabsRow');
            if (container) {
                container.querySelectorAll('.downloader-source-tab-btn').forEach(b => {
                    b.classList.toggle('active', b.dataset.sourceId === matchedId);
                });
            }
        }
    } catch {}
}

/**
 * Show the native split-webview top bar
 * @param {boolean} isDebugToolsEnabled
 */
export function showTabDownloaderBar(isDebugToolsEnabled = false) {
    initTabDownloaderDomEvents();

    const topBar = document.getElementById('topBar');
    if (topBar) topBar.style.display = 'none';

    const bar = document.getElementById('tabDownloaderBar');
    if (bar) bar.style.display = 'flex';

    // Update song pill
    const songText = activeArtistName && activeSongName ? `${activeArtistName} - ${activeSongName}` : (activeSongName || activeArtistName || '');
    const songPill = document.getElementById('downloaderSongPill');
    const songTextEl = document.getElementById('downloaderSongText');
    if (songPill && songTextEl) {
        if (songText) {
            songTextEl.textContent = songText;
            songPill.style.display = 'flex';
            songPill.title = songText;
        } else {
            songPill.style.display = 'none';
        }
    }

    // DevTools button
    const devToolsBtn = document.getElementById('downloaderDevToolsBtn');
    if (devToolsBtn) {
        devToolsBtn.style.display = isDebugToolsEnabled ? 'inline-flex' : 'none';
    }

    renderDownloaderTabs();

    // Setup ResizeObserver to synchronize top bar height with native webview
    if (typeof ResizeObserver !== 'undefined' && bar) {
        if (resizeObserver) resizeObserver.disconnect();
        let lastHeight = 0;
        // Border-box height, floored so a fractional height never leaves a seam where the app shows through
        const syncBarHeight = () => {
            const height = Math.floor(bar.getBoundingClientRect().height);
            if (height > 0 && height !== lastHeight) {
                lastHeight = height;
                syncDownloaderTopOffset(height);
            }
        };
        resizeObserver = new ResizeObserver(syncBarHeight);
        resizeObserver.observe(bar);
        // The tab pills and safe-area padding settle after the first paint
        requestAnimationFrame(() => requestAnimationFrame(syncBarHeight));
    }
}

/**
 * Hide the native split-webview top bar and restore standard top bar
 */
export function hideTabDownloaderBar() {
    stopUrlPolling();
    if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
    }

    const bar = document.getElementById('tabDownloaderBar');
    if (bar) bar.style.display = 'none';

    const topBar = document.getElementById('topBar');
    if (topBar) topBar.style.display = '';
}

/**
 * Intercepts links to the score endpoint, constructs the dynamic downloader URL,
 * creates the ephemeral Downloader tab, and navigates to the converter.
 * @param {string} url
 * @returns {boolean} true if intercepted
 */
export function handleWsaUrlIntercept(url) {
    const cleanUrl = unwrapGoogleUrl(url);
    if (pendingMatchedTabUrl === cleanUrl && activeSourceId === 'downloader') {
        return true;
    }
    const downloaderUrl = getDownloaderUrlFromMatchedUrl(cleanUrl);
    if (!downloaderUrl) return false;

    pendingMatchedTabUrl = cleanUrl;
    activeEphemeralSource = {
        id: 'downloader',
        name: 'Downloader',
        url: downloaderUrl,
        targetUrl: cleanUrl
    };
    renderDownloaderTabs();
    switchActiveSource(activeEphemeralSource);
    return true;
}

/**
 * Show a downloader page address in the URL bar and highlight its source tab
 * @param {string} rawUrl
 */
function applyDownloaderUrl(rawUrl) {
    const url = stripAdFragment(rawUrl || '');
    if (url && isWsaTabUrl(url)) {
        if (handleWsaUrlIntercept(url)) return;
    }
    const urlText = document.getElementById('downloaderUrlText');
    const urlGroup = document.getElementById('downloaderUrlGroup');
    if (highlightSourceTabForUrl(url) === false) return;
    if (url) {
        currentDownloaderUrl = url;
        clearTimeout(loadingBarTimer);
    }
    if (urlText && url) {
        urlText.textContent = url;
    }
    if (urlGroup && url) {
        urlGroup.title = url;
    }
    if (activeSourceId === 'downloader' && activeEphemeralSource?.targetUrl) {
        if (window.__TAURI__?.core?.invoke) {
            window.__TAURI__.core.invoke('tab_downloader_prefill', { targetUrl: activeEphemeralSource.targetUrl }).catch(() => {});
        }
    }
}

// Android never delivers the shell's URL events to the app, so its bar reads the address from the webview.
let urlPollTimer = null;
function startUrlPolling() {
    if (urlPollTimer || typeof window.MajesticDownloaderNative?.currentUrl !== 'function') return;
    urlPollTimer = setInterval(() => {
        let url = '';
        try { url = window.MajesticDownloaderNative.currentUrl() || ''; } catch {}
        if (/^https?:/i.test(url) && stripAdFragment(url) !== currentDownloaderUrl) applyDownloaderUrl(url);
    }, 1000);
}
function stopUrlPolling() {
    clearInterval(urlPollTimer);
    urlPollTimer = null;
}

/**
 * Set up Tauri native event listeners for completed downloads, logs, and closing
 */
export function initTauriDownloadListener() {
    if (window.__TAURI__ && window.__TAURI__.event) {
        // Download event
        window.__TAURI__.event.listen('tab-downloaded', async (event) => {
            console.log('[Tab Downloader] Received downloaded file event:', event.payload);
            const { name, data, path } = event.payload || {};
            if (data && Array.isArray(data)) {
                await handleDownloadedTabFile(name, new Uint8Array(data), path);
            }
        });

        // Debug log event from webview
        window.__TAURI__.event.listen('tab-downloader-log', (event) => {
            console.log('[Tab Downloader Webview]', event.payload || '');
        });

        // URL changed event from native webview
        window.__TAURI__.event.listen('tab-downloader-url-changed', (event) => applyDownloaderUrl(event.payload));

        // Window closed event from the native shell
        window.__TAURI__.event.listen('tab-downloader-closed', () => {
            console.log('[Tab Downloader] Received close event from native webview');
            closeTabDownloaderModal(false);
        });

        initTabDownloaderDomEvents();
    }
}

let debugToolsEnabled = null;

/**
 * Open the Native Tab Downloader UI
 * @param {Object} [options]
 * @param {string} [options.query]
 * @param {string} [options.artist]
 * @param {string} [options.songName]
 * @param {Object} [options.targetSong]
 */
export async function openTabDownloader(options = {}) {
    activeEphemeralSource = null;
    pendingMatchedTabUrl = null;
    if (!isNative()) {
        console.warn('[Tab Downloader] openTabDownloader aborted: isNative() returned false');
        return;
    }

    activeDownloaderOnFileSelected = options.onFileSelected || null;
    activeTargetSong = options.targetSong || null;
    if (options.songId && !activeTargetSong) {
        try { activeTargetSong = await getSongById(options.songId); } catch {}
    }

    if (options.isAlbumTab && options.albumTitle) {
        activeTargetAlbum = {
            collectionId: options.collectionId,
            artistName: options.artistName,
            albumTitle: options.albumTitle
        };
    } else {
        activeTargetAlbum = null;
    }

    activeArtistName = options.artist || activeTargetSong?.artist || activeTargetAlbum?.artistName || '';
    activeSongName = options.songName || activeTargetSong?.title || activeTargetAlbum?.albumTitle || '';

    // A build-time constant, so ask the shell once (on Android its sync commands can stall after a close)
    if (debugToolsEnabled === null) {
        debugToolsEnabled = false;
        if (window.__TAURI__?.core?.invoke) {
            try {
                debugToolsEnabled = await window.__TAURI__.core.invoke('tab_downloader_is_debug_tools_enabled');
            } catch {}
        }
    }
    const isDebugToolsEnabled = debugToolsEnabled;

    const sources = getSources();
    const activeSource = (options.targetSourceId && sources.find(s => s.id === options.targetSourceId)) || sources.find(s => s.id === activeSourceId) || sources[0] || DEFAULT_SOURCES[0];
    activeSourceId = activeSource.id;

    // Build search query based on active source's query format
    let query = options.query || '';
    if (!query) {
        query = formatSearchQueryForSource(activeSource, activeArtistName, activeSongName);
    }
    if (!query) {
        query = 'Carulli Duo No 2 In G Major';
    }
    currentSearchQuery = query;

    // Every platform renders the bar in this webview and the site in a separate native webview below it,
    // so pinch zooming the site never scales the bar.
    let barHeight = 84;
    showTabDownloaderBar(Boolean(isDebugToolsEnabled));
    const bar = document.getElementById('tabDownloaderBar');
    if (bar) {
        barHeight = Math.floor(bar.getBoundingClientRect().height) || 84;
    }
    try { window.MajesticDownloaderNative?.setTopInsetPx?.(Math.round(barHeight * (window.devicePixelRatio || 1))); } catch {}

    const targetUrl = buildSearchUrl(activeSource, currentSearchQuery);
    currentDownloaderUrl = targetUrl;
    showLoadingInUrlBar(activeSource.name);

    const config = {
        activeSourceId: activeSource.id,
        artist: activeArtistName || null,
        song: activeSongName || null,
        query: currentSearchQuery || null,
        isDebugToolsEnabled: Boolean(isDebugToolsEnabled),
        forceDesktop: Boolean(activeSource.forceDesktop),
        platform: (/iphone|ipad|ipod/i.test(navigator.userAgent || '')) ? 'ios' : (/android/i.test(navigator.userAgent || '') ? 'android' : ((/mac/i.test(navigator.platform || navigator.userAgent)) ? 'macos' : ((/win/i.test(navigator.platform || navigator.userAgent)) ? 'windows' : 'other'))),
        sources: sources.map(s => ({
            id: s.id,
            name: s.name,
            urlTemplate: s.urlTemplate,
            defaultUrl: s.defaultUrl,
            queryFormat: s.queryFormat,
            forceDesktop: Boolean(s.forceDesktop),
            isSeed: Boolean(s.isSeed)
        }))
    };
    // Android shows its site view natively; the shell's own eval of this can stall after a close
    try { window.MajesticDownloaderNative?.show?.(); } catch {}
    startUrlPolling();
    try {
        await window.__TAURI__.core.invoke('open_tab_downloader', {
            url: targetUrl,
            config,
            topOffset: barHeight
        });
        if (activeEphemeralSource?.targetUrl) {
            window.__TAURI__.core.invoke('tab_downloader_prefill', { targetUrl: activeEphemeralSource.targetUrl }).catch(() => {});
        }
        // open_tab_downloader overwrites the native offset with the height measured before the pills
        // rendered, and the ResizeObserver won't refire if the bar already settled, so push the final height.
        const settledBar = document.getElementById('tabDownloaderBar');
        const settledHeight = settledBar ? Math.floor(settledBar.getBoundingClientRect().height) : 0;
        if (settledHeight > 0) syncDownloaderTopOffset(settledHeight);
    } catch (err) {
        console.error('[Tab Downloader] Failed to open native webview:', err);
        hideTabDownloaderBar();
        showToast('Unable to open tab downloader', 'error');
    }
}

/**
 * Closes / hides the native tab downloader
 * @param {boolean} [invokeNative=true] - Whether to invoke native tab_downloader_hide command
 */
export function closeTabDownloaderModal(invokeNative = true) {
    activeDownloaderOnFileSelected = null;
    activeTargetSong = null;
    activeTargetAlbum = null;
    activeEphemeralSource = null;
    pendingMatchedTabUrl = null;

    try { window.MajesticDownloaderNative?.close?.(); } catch {}
    stopUrlPolling();
    hideTabDownloaderBar();

    if (invokeNative && window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('tab_downloader_hide').catch(() => {});
    }

    try {
        window.focus();
        const output = document.getElementById('output');
        if (output && output.style.display !== 'none') {
            output.focus();
        }
    } catch {}
}

