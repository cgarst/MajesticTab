// tabDownloader.js
// Native Tab Downloader bridge for MajesticTab across all native platforms (Desktop & Mobile).

import { saveStoredFile } from './fileStore.js';
import { loadFile } from './main.js';
import { addTabOptionToSong, addTabOptionToAlbum, getSongById } from './libraryStore.js';
import { detectFileMetadata } from './utils/tuningUtils.js';
import { closeLibraryModal } from './libraryModal.js';
import { showToast } from './utils/toast.js';

const SOURCES_STORAGE_KEY = 'majestictab_tab_sources';

export function isNative() {
    return typeof window !== 'undefined' && Boolean(window.__TAURI__);
}

export function isDesktopNative() {
    return typeof window !== 'undefined' && Boolean(window.__TAURI__) && !/android|iphone|ipad|ipod/i.test(navigator.userAgent || '');
}

export const UG_DEFAULT_USERSCRIPT = `
// MajesticTab UG Userscript v12-focus
(function() {
    const isSongPage = window.location.pathname.includes('/tab/');

    // 1. Hide and remove sticky tab player strictly on song pages
    if (isSongPage) {
        const STYLE_ID = 'majestic-ug-custom-style-v12';
        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = \`
                /* Hide the sticky tab player on Guitar Pro song pages */
                .is_sticky_player,
                [class*="is_sticky_player"],
                [class*="sticky_player"],
                #pro-player-scroll-container,
                [id*="pro-player"] {
                    display: none !important;
                }
            \`;
            (document.head || document.documentElement).appendChild(style);
        }

        document.querySelectorAll('.is_sticky_player, [class*="is_sticky_player"], [class*="sticky_player"], #pro-player-scroll-container, [id*="pro-player"]').forEach(el => {
            try {
                const container = el.closest('.is_sticky_player') || el.closest('[class*="sticky_player"]') || el;
                container.remove();
            } catch(e) {}
        });
    }

    // 2. Hide "Official" tabs in search results and listings
    function hideOfficialTabRow(el) {
        let cur = el.parentElement;
        while (cur && cur !== document.body && cur !== document.documentElement) {
            const tag = cur.tagName.toLowerCase();
            if (tag === 'article' || tag === 'main' || tag === 'section' || tag === 'header' || tag === 'nav') break;
            const tabLinks = cur.querySelectorAll('a[href*="/tab/"], a[href*="/pro/"]');
            if (tabLinks.length > 3) break;

            const isRowLike = tag === 'tr' || cur.getAttribute('role') === 'row' || /\\b(row|entry|item)\\b/i.test(cur.className || '');
            if (isRowLike) {
                if (tabLinks.length >= 1 && tabLinks.length <= 3) {
                    if (cur.dataset && cur.dataset.majesticHidden === 'true') break;
                    if (cur.dataset) cur.dataset.majesticHidden = 'true';

                    const artistLink = cur.querySelector('a[href*="/artist/"]');
                    if (artistLink && cur.nextElementSibling) {
                        const nextRowFirstCell = cur.nextElementSibling.firstElementChild;
                        if (nextRowFirstCell && !nextRowFirstCell.dataset?.majesticArtistAdded && !nextRowFirstCell.querySelector('a[href*="/artist/"]')) {
                            if (nextRowFirstCell.dataset) nextRowFirstCell.dataset.majesticArtistAdded = 'true';
                            nextRowFirstCell.innerHTML = artistLink.outerHTML;
                        }
                    }
                    cur.style.setProperty('display', 'none', 'important');
                    break;
                }
            }
            cur = cur.parentElement;
        }
    }

    // Hide by link pattern
    document.querySelectorAll('a[href*="/pro/"], a[href*="/pro?"], a[href*="/tab/official/"], a[href*="marketing_type=official"]').forEach(hideOfficialTabRow);

    // Hide by "Official" label / badge text (targeted lookup, avoids full DOM scan)
    const candidates = document.querySelectorAll('tr span, tr div, [role="row"] span, [role="row"] div, [class*="badge"], [class*="tag"], [class*="type"], [class*="version"], [class*="label"]');
    for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (el.dataset && el.dataset.majesticChecked) continue;
        if (el.dataset) el.dataset.majesticChecked = '1';
        if (el.children.length === 0) {
            const text = el.textContent.trim().toLowerCase();
            if (text === 'official' || text === 'official tab') {
                hideOfficialTabRow(el);
            }
        }
    }
})();
`;

export const DEFAULT_SOURCES = [
    {
        id: 'ug',
        name: 'Ultimate Guitar',
        urlTemplate: 'https://www.ultimate-guitar.com/search.php?title=SEARCH+TERM',
        defaultUrl: 'https://www.ultimate-guitar.com/search.php?title=SEARCH+TERM',
        queryFormat: 'artist_song',
        userscriptEnabled: true,
        userscript: UG_DEFAULT_USERSCRIPT,
        defaultUserscript: UG_DEFAULT_USERSCRIPT,
        isSeed: true
    },
    {
        id: 'metaltabs',
        name: 'MetalTabs',
        urlTemplate: 'https://metaltabs.org/search?search=SEARCH+TERM&bands=true&albums=false&tracks=true',
        defaultUrl: 'https://metaltabs.org/search?search=SEARCH+TERM&bands=true&albums=false&tracks=true',
        queryFormat: 'song_only',
        userscriptEnabled: false,
        userscript: '',
        defaultUserscript: '',
        isSeed: true
    },
    {
        id: 'gprotab',
        name: 'GProTab',
        urlTemplate: 'https://gprotab.net/en/search?type=song&q=SEARCH+TERM',
        defaultUrl: 'https://gprotab.net/en/search?type=song&q=SEARCH+TERM',
        queryFormat: 'song_only',
        userscriptEnabled: false,
        userscript: '',
        defaultUserscript: '',
        isSeed: true
    },
    {
        id: 'guitarprotabs',
        name: 'guitarprotabs.org',
        urlTemplate: 'https://guitarprotabs.org/search.php?search=SEARCH+TERM&in=songs&page=1',
        defaultUrl: 'https://guitarprotabs.org/search.php?search=SEARCH+TERM&in=songs&page=1',
        queryFormat: 'song_only',
        userscriptEnabled: false,
        userscript: '',
        defaultUserscript: '',
        isSeed: true
    }
];

let activeTargetSong = null;
let activeTargetAlbum = null;
let activeDownloaderOnFileSelected = null;
let activeArtistName = '';
let activeSongName = '';
let activeSourceId = 'ug';
let currentSearchQuery = '';
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
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
                for (const seed of DEFAULT_SOURCES) {
                    const existing = parsed.find(s => s.id === seed.id);
                    if (existing && existing.isSeed) {
                        existing.defaultUserscript = seed.defaultUserscript;
                        if (!existing.queryFormat || (existing.id === 'metaltabs' && existing.queryFormat !== 'song_only') || (existing.id === 'ug' && existing.queryFormat !== 'artist_song') || (existing.id === 'gprotab' && existing.queryFormat !== 'song_only') || (existing.id === 'guitarprotabs' && existing.queryFormat !== 'song_only')) {
                            existing.queryFormat = seed.queryFormat;
                        }
                        if (existing.id === 'ug') {
                            if (!existing.userscript || !existing.isUserModified || !existing.userscript.includes('v12-focus')) {
                                existing.userscript = seed.userscript;
                            }
                        }
                    } else if (!existing) {
                        parsed.push(JSON.parse(JSON.stringify(seed)));
                    }
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
    const term = (query || '').trim();
    if (!term) {
        if (source.id === 'ug') return 'https://www.ultimate-guitar.com/';
        if (source.id === 'metaltabs') return 'https://metaltabs.org/';
        if (source.id === 'gprotab') return 'https://gprotab.net/';
        if (source.id === 'guitarprotabs') return 'https://guitarprotabs.org/';
        if (source.defaultUrl) {
            return source.defaultUrl.replace('SEARCH+TERM', '').replace('{search}', '');
        }
        return 'https://www.ultimate-guitar.com/';
    }
    const encodedPlus = encodeURIComponent(term).replace(/%20/g, '+');
    const encodedStandard = encodeURIComponent(term);

    let url = source.urlTemplate || '';
    if (url.includes('SEARCH+TERM')) {
        url = url.replace('SEARCH+TERM', encodedPlus);
    } else if (url.includes('{search}')) {
        url = url.replace('{search}', encodedStandard);
    } else {
        url = `${url}${url.includes('?') ? '&' : '?'}q=${encodedStandard}`;
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

    // Reset targets once consumed
    activeTargetSong = null;
    activeTargetAlbum = null;
    activeDownloaderOnFileSelected = null;

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

    // Persist to file store and attach to library song if bound, then load into player
    if (targetSong?.id) {
        const meta = await detectFileMetadata(file, file.name);
        const stored = await saveStoredFile(file, 'tab-downloader', {
            name: file.name,
            relativePath: path || file.name,
            targetSongId: targetSong.id
        });

        const addedOption = await addTabOptionToSong(targetSong.id, {
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

        // Close library modal so viewer is visible
        closeLibraryModal(true);

        // Decorate file with library song metadata so loadFile displays song title/artist in header
        file.librarySongId = targetSong.id;
        file.librarySongTitle = targetSong.title;
        file.artist = targetSong.artist;
        file.album = targetSong.album || '';
        file.coverUrl = targetSong.coverUrl || null;
        file.tabId = addedOption?.id || null;
        file.tabName = addedOption?.name || file.name;
        file.fileStoreId = stored.id;
        file.providerId = 'tab-downloader';

        await loadFile(file);
        return;
    }

    if (targetAlbum?.albumTitle) {
        const meta = await detectFileMetadata(file, file.name);
        const stored = await saveStoredFile(file, 'tab-downloader', {
            name: file.name,
            relativePath: path || file.name
        });

        const addedOption = await addTabOptionToAlbum(targetAlbum.collectionId, targetAlbum.artistName, targetAlbum.albumTitle, {
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

        closeLibraryModal(true);

        file.artist = targetAlbum.artistName;
        file.album = targetAlbum.albumTitle;
        file.tabId = addedOption?.id || null;
        file.tabName = addedOption?.name || file.name;
        file.fileStoreId = stored.id;
        file.providerId = 'tab-downloader';

        await loadFile(file);
        return;
    }

    // Load file directly into player viewer
    closeLibraryModal(true);
    await loadFile(file);
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

/**
 * Handle incoming updated sources payload from native webview toolbar
 */
export function handleSaveSourcesPayload(sourcesData) {
    try {
        const parsed = typeof sourcesData === 'string' ? JSON.parse(sourcesData) : sourcesData;
        if (Array.isArray(parsed) && parsed.length > 0) {
            saveSources(parsed);
            console.log('[Tab Downloader] Saved updated sources from native webview:', parsed.length);
        }
    } catch (e) {
        console.error('[Tab Downloader] Failed to save sources from native webview:', e);
    }
}

if (typeof window !== 'undefined') {
    window.__onSaveSources = handleSaveSourcesPayload;
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

        // Window closed event from native webview toolbar
        window.__TAURI__.event.listen('tab-downloader-closed', () => {
            console.log('[Tab Downloader] Received close event from native webview');
            closeTabDownloaderModal();
        });

        // Saved sources event from native webview toolbar
        window.__TAURI__.event.listen('tab-downloader-save-sources', (event) => {
            handleSaveSourcesPayload(event.payload);
        });
    }
}

/**
 * Open the Native Tab Downloader UI
 * @param {Object} [options]
 * @param {string} [options.query]
 * @param {string} [options.artist]
 * @param {string} [options.songName]
 * @param {Object} [options.targetSong]
 */
export async function openTabDownloader(options = {}) {
    if (!isNative()) return;

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

    let isDebugToolsEnabled = false;
    if (window.__TAURI__?.core?.invoke) {
        try {
            isDebugToolsEnabled = await window.__TAURI__.core.invoke('tab_downloader_is_debug_tools_enabled');
        } catch {
            isDebugToolsEnabled = false;
        }
    }

    const sources = getSources();
    const activeSource = sources.find(s => s.id === activeSourceId) || sources[0] || DEFAULT_SOURCES[0];
    activeSourceId = activeSource.id;

    // Build search query based on active source's query format
    let query = options.query || '';
    if (!query) {
        query = formatSearchQueryForSource(activeSource, activeArtistName, activeSongName);
    }
    currentSearchQuery = query;

    const targetUrl = buildSearchUrl(activeSource, currentSearchQuery);
    const config = {
        showToolbar: true,
        activeSourceId: activeSource.id,
        artist: activeArtistName || null,
        song: activeSongName || null,
        query: currentSearchQuery || null,
        isDebugToolsEnabled: Boolean(isDebugToolsEnabled),
        platform: (!/android|iphone|ipad|ipod/i.test(navigator.userAgent || '') && /mac/i.test(navigator.platform || navigator.userAgent)) ? 'macos' : ((!/android|iphone|ipad|ipod/i.test(navigator.userAgent || '') && /win/i.test(navigator.platform || navigator.userAgent)) ? 'windows' : 'other'),
        sources: sources.map(s => ({
            id: s.id,
            name: s.name,
            urlTemplate: s.urlTemplate,
            defaultUrl: s.defaultUrl,
            queryFormat: s.queryFormat,
            userscriptEnabled: Boolean(s.userscriptEnabled),
            userscript: s.userscript || null,
            defaultUserscript: s.defaultUserscript || null,
            isSeed: Boolean(s.isSeed)
        }))
    };
    const targetScript = activeSource.userscriptEnabled ? (activeSource.userscript || '') : '';
    await window.__TAURI__.core.invoke('open_tab_downloader', {
        url: targetUrl,
        userscript: targetScript || null,
        config
    });
}

/**
 * Closes / hides the native tab downloader
 */
export function closeTabDownloaderModal() {
    activeDownloaderOnFileSelected = null;
    activeTargetSong = null;
    activeTargetAlbum = null;

    if (window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('tab_downloader_hide').catch(() => {});
    }
}
