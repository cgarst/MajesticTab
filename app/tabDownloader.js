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

    // DevTools button
    document.getElementById('downloaderDevToolsBtn')?.addEventListener('click', () => {
        if (window.__TAURI__?.core?.invoke) {
            window.__TAURI__.core.invoke('tab_downloader_open_devtools').catch(() => {});
        }
    });

    // Settings button
    document.getElementById('downloaderSettingsBtn')?.addEventListener('click', () => {
        openDownloaderSettings();
    });

    // Close button
    document.getElementById('downloaderCloseBtn')?.addEventListener('click', () => {
        closeTabDownloaderModal(true);
    });

    // Settings modal events
    document.getElementById('downloaderCfgCloseBtn')?.addEventListener('click', closeDownloaderSettings);
    document.getElementById('downloaderCfgCancelBtn')?.addEventListener('click', closeDownloaderSettings);
    document.getElementById('downloaderCfgSaveBtn')?.addEventListener('click', saveAndCloseSettings);

    const cfgBackdrop = document.getElementById('downloaderSettingsModal');
    if (cfgBackdrop) {
        cfgBackdrop.addEventListener('click', (e) => {
            if (e.target === cfgBackdrop) {
                closeDownloaderSettings();
            }
        });
    }

    document.getElementById('downloaderCfgNewBtn')?.addEventListener('click', () => {
        saveCurrentFormValues();
        const newId = 'source_' + Date.now();
        const newSrc = {
            id: newId,
            name: 'Custom Source',
            urlTemplate: 'https://www.ultimate-guitar.com/search.php?title=SEARCH+TERM',
            defaultUrl: '',
            queryFormat: 'artist_song',
            userscriptEnabled: false,
            userscript: '',
            defaultUserscript: '',
            isSeed: false
        };
        localEditingSources.push(newSrc);
        currentEditingSourceId = newId;
        renderSettingsPills();
        populateSettingsForm(newId);
    });

    document.getElementById('downloaderCfgDeleteBtn')?.addEventListener('click', () => {
        const src = localEditingSources.find(s => s.id === currentEditingSourceId);
        if (!src || src.isSeed) return;
        localEditingSources = localEditingSources.filter(s => s.id !== currentEditingSourceId);
        currentEditingSourceId = localEditingSources[0]?.id || null;
        renderSettingsPills();
        if (currentEditingSourceId) {
            populateSettingsForm(currentEditingSourceId);
        }
    });

    document.getElementById('downloaderCfgResetUrlBtn')?.addEventListener('click', () => {
        const src = localEditingSources.find(s => s.id === currentEditingSourceId);
        if (src && src.defaultUrl) {
            const inp = document.getElementById('downloaderCfgUrl');
            if (inp) inp.value = src.defaultUrl;
        }
    });

    document.getElementById('downloaderCfgResetScriptBtn')?.addEventListener('click', () => {
        const src = localEditingSources.find(s => s.id === currentEditingSourceId);
        if (src && src.defaultUserscript) {
            const txt = document.getElementById('downloaderCfgUserscriptCode');
            const chk = document.getElementById('downloaderCfgUserscriptEnabled');
            if (txt) txt.value = src.defaultUserscript;
            if (chk) chk.checked = true;
        }
    });

    // Keyboard shortcut Escape
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const settingsModal = document.getElementById('downloaderSettingsModal');
            if (settingsModal && settingsModal.style.display !== 'none') {
                closeDownloaderSettings();
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const bar = document.getElementById('tabDownloaderBar');
            if (bar && bar.style.display !== 'none') {
                closeTabDownloaderModal(true);
                e.preventDefault();
                e.stopPropagation();
            }
        }
    });
}

/**
 * Open the Configure Tab Sources modal
 * @param {string} [targetSourceId]
 */
export function openDownloaderSettings(targetSourceId = null) {
    if (window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('tab_downloader_set_visible', { visible: false }).catch(() => {});
    }
    localEditingSources = JSON.parse(JSON.stringify(getSources()));
    currentEditingSourceId = targetSourceId || activeSourceId || localEditingSources[0]?.id;
    renderSettingsPills();
    if (currentEditingSourceId) {
        populateSettingsForm(currentEditingSourceId);
    }
    const modal = document.getElementById('downloaderSettingsModal');
    if (modal) modal.style.display = 'flex';
}

/**
 * Close the Configure Tab Sources modal
 */
export function closeDownloaderSettings() {
    const modal = document.getElementById('downloaderSettingsModal');
    if (modal) modal.style.display = 'none';
    const bar = document.getElementById('tabDownloaderBar');
    if (bar && bar.style.display !== 'none' && window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('tab_downloader_set_visible', { visible: true }).catch(() => {});
    }
}

function renderSettingsPills() {
    const container = document.getElementById('downloaderCfgSourcePills');
    if (!container) return;
    container.innerHTML = localEditingSources.map(s => `
        <button type="button" class="downloader-cfg-pill ${s.id === currentEditingSourceId ? 'active' : ''}" data-source-id="${s.id}">
            ${s.name}
        </button>
    `).join('');

    container.querySelectorAll('.downloader-cfg-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            saveCurrentFormValues();
            currentEditingSourceId = btn.dataset.sourceId;
            renderSettingsPills();
            populateSettingsForm(currentEditingSourceId);
        });
    });
}

function populateSettingsForm(sourceId) {
    const src = localEditingSources.find(s => s.id === sourceId);
    if (!src) return;

    const nameInp = document.getElementById('downloaderCfgName');
    const urlInp = document.getElementById('downloaderCfgUrl');
    const querySel = document.getElementById('downloaderCfgQueryFormat');
    const scriptChk = document.getElementById('downloaderCfgUserscriptEnabled');
    const scriptTxt = document.getElementById('downloaderCfgUserscriptCode');
    const deleteBtn = document.getElementById('downloaderCfgDeleteBtn');

    if (nameInp) nameInp.value = src.name || '';
    if (urlInp) urlInp.value = src.urlTemplate || '';
    if (querySel) querySel.value = src.queryFormat || 'artist_song';
    if (scriptChk) scriptChk.checked = Boolean(src.userscriptEnabled);
    if (scriptTxt) scriptTxt.value = src.userscript || '';
    if (deleteBtn) {
        deleteBtn.disabled = Boolean(src.isSeed);
        deleteBtn.style.opacity = src.isSeed ? '0.5' : '1';
        deleteBtn.style.cursor = src.isSeed ? 'not-allowed' : 'pointer';
    }
}

function saveCurrentFormValues() {
    const src = localEditingSources.find(s => s.id === currentEditingSourceId);
    if (!src) return;

    const nameInp = document.getElementById('downloaderCfgName');
    const urlInp = document.getElementById('downloaderCfgUrl');
    const querySel = document.getElementById('downloaderCfgQueryFormat');
    const scriptChk = document.getElementById('downloaderCfgUserscriptEnabled');
    const scriptTxt = document.getElementById('downloaderCfgUserscriptCode');

    if (nameInp) src.name = nameInp.value.trim() || src.name;
    if (urlInp) src.urlTemplate = urlInp.value.trim() || src.urlTemplate;
    if (querySel) src.queryFormat = querySel.value;
    if (scriptChk) src.userscriptEnabled = scriptChk.checked;
    if (scriptTxt) src.userscript = scriptTxt.value;
}

function saveAndCloseSettings() {
    saveCurrentFormValues();
    saveSources(localEditingSources);
    renderDownloaderTabs();
    closeDownloaderSettings();
}

/**
 * Render tab provider pills in the top bar
 */
export function renderDownloaderTabs() {
    const container = document.getElementById('downloaderTabsRow');
    if (!container) return;

    const sources = getSources();
    let html = sources.map(s => `
        <button type="button" class="downloader-source-tab-btn ${s.id === activeSourceId ? 'active' : ''}" data-source-id="${s.id}" title="${s.name}">
            <i class="bi-globe"></i>
            <span>${s.name}</span>
        </button>
    `).join('');

    html += `
        <button type="button" class="downloader-source-tab-btn downloader-source-tab-add" id="downloaderAddSourceBtn" title="Add New Tab Source">
            <i class="bi-plus-lg"></i>
            <span>Add Source</span>
        </button>
    `;

    container.innerHTML = html;

    container.querySelectorAll('.downloader-source-tab-btn:not(.downloader-source-tab-add)').forEach(btn => {
        btn.addEventListener('click', () => {
            const sid = btn.dataset.sourceId;
            const src = sources.find(s => s.id === sid);
            if (src) {
                switchActiveSource(src);
            }
        });
    });

    container.querySelector('#downloaderAddSourceBtn')?.addEventListener('click', () => {
        openDownloaderSettings();
        document.getElementById('downloaderCfgNewBtn')?.click();
    });
}

/**
 * Switch active source and navigate the webview
 * @param {Object} src
 */
export function switchActiveSource(src) {
    activeSourceId = src.id;
    const container = document.getElementById('downloaderTabsRow');
    if (container) {
        container.querySelectorAll('.downloader-source-tab-btn:not(.downloader-source-tab-add)').forEach(b => {
            b.classList.toggle('active', b.dataset.sourceId === src.id);
        });
    }

    const urlText = document.getElementById('downloaderUrlText');
    const urlGroup = document.getElementById('downloaderUrlGroup');
    const loadingMsg = 'Loading ' + src.name + '...';
    if (urlText) urlText.textContent = loadingMsg;
    if (urlGroup) urlGroup.title = loadingMsg;

    const query = formatSearchQueryForSource(src, activeArtistName, activeSongName) || currentSearchQuery;
    const nextUrl = buildSearchUrl(src, query);
    const userscript = src.userscriptEnabled ? (src.userscript || src.defaultUserscript || null) : null;

    if (window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('tab_downloader_navigate', { url: nextUrl, userscript }).catch(err => {
            console.error('[Tab Downloader] Failed to navigate to source:', err);
        });
    }
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
        if (host.includes('ultimate-guitar.com')) matchedId = 'ug';
        else if (host.includes('metaltabs.org')) matchedId = 'metaltabs';
        else if (host.includes('gprotab.net')) matchedId = 'gprotab';
        else if (host.includes('guitarprotabs.org')) matchedId = 'guitarprotabs';
        else {
            const sources = getSources();
            for (const s of sources) {
                try {
                    const su = new URL(s.defaultUrl || s.urlTemplate);
                    if (su.hostname && host.includes(su.hostname)) {
                        matchedId = s.id;
                        break;
                    }
                } catch {}
            }
        }
        if (matchedId && matchedId !== activeSourceId) {
            activeSourceId = matchedId;
            const container = document.getElementById('downloaderTabsRow');
            if (container) {
                container.querySelectorAll('.downloader-source-tab-btn:not(.downloader-source-tab-add)').forEach(b => {
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
        let lastHeight = Math.ceil(bar.getBoundingClientRect().height) || 84;
        resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const newHeight = Math.ceil(entry.contentRect.height + 1);
                if (newHeight > 0 && Math.abs(newHeight - lastHeight) >= 2) {
                    lastHeight = newHeight;
                    if (window.__TAURI__?.core?.invoke) {
                        window.__TAURI__.core.invoke('tab_downloader_update', { topOffset: newHeight }).catch(() => {});
                    }
                }
            }
        });
        resizeObserver.observe(bar);
    }
}

/**
 * Hide the native split-webview top bar and restore standard top bar
 */
export function hideTabDownloaderBar() {
    if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
    }

    const bar = document.getElementById('tabDownloaderBar');
    if (bar) bar.style.display = 'none';

    closeDownloaderSettings();

    const topBar = document.getElementById('topBar');
    if (topBar) topBar.style.display = '';
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
        window.__TAURI__.event.listen('tab-downloader-url-changed', (event) => {
            const url = event.payload || '';
            const urlText = document.getElementById('downloaderUrlText');
            const urlGroup = document.getElementById('downloaderUrlGroup');
            if (urlText && url) {
                urlText.textContent = url;
            }
            if (urlGroup && url) {
                urlGroup.title = url;
            }
            highlightSourceTabForUrl(url);
        });

        // Window closed event from native webview toolbar
        window.__TAURI__.event.listen('tab-downloader-closed', () => {
            console.log('[Tab Downloader] Received close event from native webview');
            closeTabDownloaderModal(false);
        });

        // Saved sources event from native webview toolbar
        window.__TAURI__.event.listen('tab-downloader-save-sources', (event) => {
            handleSaveSourcesPayload(event.payload);
        });

        initTabDownloaderDomEvents();
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

    const isDesktop = isDesktopNative();
    let barHeight = 84;

    if (isDesktop) {
        showTabDownloaderBar(Boolean(isDebugToolsEnabled));
        const bar = document.getElementById('tabDownloaderBar');
        if (bar) {
            barHeight = Math.ceil(bar.getBoundingClientRect().height) || 84;
        }
    }

    const targetUrl = buildSearchUrl(activeSource, currentSearchQuery);
    const urlTextEl = document.getElementById('downloaderUrlText');
    const urlGroupEl = document.getElementById('downloaderUrlGroup');
    const loadingText = 'Loading ' + activeSource.name + '...';
    if (urlTextEl) urlTextEl.textContent = loadingText;
    if (urlGroupEl) urlGroupEl.title = loadingText;

    const config = {
        showToolbar: !isDesktop, // Disable injected toolbar on desktop (using native split webview)
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
        config,
        topOffset: isDesktop ? barHeight : 0.0
    });
}

/**
 * Closes / hides the native tab downloader
 * @param {boolean} [invokeNative=true] - Whether to invoke native tab_downloader_hide command
 */
export function closeTabDownloaderModal(invokeNative = true) {
    activeDownloaderOnFileSelected = null;
    activeTargetSong = null;
    activeTargetAlbum = null;

    hideTabDownloaderBar();

    if (invokeNative && window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('tab_downloader_hide').catch(() => {});
    }
}

