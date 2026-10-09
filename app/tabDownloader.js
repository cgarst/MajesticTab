// tabDownloader.js
// In-App Tab Downloader browser for Native (Tauri child Webview + FS) and Web environments.

import { saveStoredFile } from './fileStore.js';
import { loadFile } from './main.js';
import { addTabOptionToSong, getSongById } from './libraryStore.js';
import { inferTuningFromTextOrName } from './utils/tuningUtils.js';
import { openLibraryModal } from './libraryModal.js';

const SOURCES_STORAGE_KEY = 'majestictab_tab_sources';

export const UG_DEFAULT_USERSCRIPT = `
// MajesticTab UG Userscript v8-native-stream
(function() {
    // 1. Responsive layout fix & CSS hiding of tab player
    const STYLE_ID = 'majestic-ug-custom-style-v8';
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = \`
            html, body {
                overflow-x: hidden !important;
                max-width: 100% !important;
                width: 100% !important;
            }
            main, section, article, header, footer,
            div.js-page, div.cy3pC, div.C3TYC, div.qvYYh, div._5nhnB, div._62GmN, div._9w4TK,
            [class*="content"], [class*="wrapper"], [class*="container"] {
                max-width: 100% !important;
                box-sizing: border-box !important;
            }
            div._9w4TK {
                width: 100% !important;
            }
            div._9w4TK > div {
                width: 100% !important;
                box-sizing: border-box !important;
            }
            /* Hide the sticky tab player on Guitar Pro song pages */
            .is_sticky_player,
            [class*="is_sticky_player"],
            [class*="sticky_player"],
            #pro-player-scroll-container {
                display: none !important;
            }
        \`;
        (document.head || document.documentElement).appendChild(style);
    }

    // 2. Remove sticky player DOM element on song pages
    document.querySelectorAll('.is_sticky_player, [class*="is_sticky_player"], [class*="sticky_player"], #pro-player-scroll-container').forEach(el => {
        try {
            const container = el.closest('.is_sticky_player') || el.closest('[class*="sticky_player"]') || el;
            container.remove();
        } catch(e) {}
    });

    // 3. Hide promotional "Official" & "Pro" tabs in search results only
    function cleanSearchRows() {
        if (!window.location.pathname.includes('search') && !window.location.pathname.includes('explore')) return;

        document.querySelectorAll('a[href*="/pro/"], a[href*="/pro?"], a[href*="/tab/official/"], a[href*="marketing_type=official"]').forEach(link => {
            let cur = link.parentElement;
            while (cur && cur !== document.body && cur !== document.documentElement) {
                const tag = cur.tagName.toLowerCase();
                if (tag === 'article' || tag === 'main' || tag === 'section' || tag === 'header' || tag === 'nav') break;
                const tabLinks = cur.querySelectorAll('a[href*="/tab/"], a[href*="/pro/"]');
                if (tabLinks.length > 3) break;
                
                if (cur.nextElementSibling || cur.previousElementSibling) {
                    if (tabLinks.length >= 1 && tabLinks.length <= 3) {
                        cur.style.setProperty('display', 'none', 'important');
                        break;
                    }
                }
                cur = cur.parentElement;
            }
        });
    }
    cleanSearchRows();
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
    }
];

let activeTargetSong = null;
let activeArtistName = '';
let activeSongName = '';
let activeSourceId = 'ug';
let currentSearchQuery = '';
let nativeResizeObserver = null;
let lastDownloadedTime = 0;
let lastDownloadedName = '';

/**
 * Format search query for a specific source configuration
 */
let debugLogs = [];
let isDebugDrawerOpen = false;

/**
 * Append message to debug log drawer
 */
function appendDebugLog(msg) {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${msg}`;
    debugLogs.push(formatted);
    if (debugLogs.length > 100) debugLogs.shift();

    const container = document.getElementById('downloaderLogsContent');
    if (container) {
        const el = document.createElement('div');
        el.className = 'text-break';
        if (msg.includes('ERROR') || msg.includes('Error')) {
            el.style.color = '#f87171';
        } else if (msg.includes('WARN') || msg.includes('warn')) {
            el.style.color = '#fde047';
        } else if (msg.includes('MajesticTab') || msg.includes('download')) {
            el.style.color = '#67e8f9';
        }
        el.textContent = formatted;
        container.appendChild(el);
        container.scrollTop = container.scrollHeight;
    }
}

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
                        if (!existing.queryFormat || (existing.id === 'metaltabs' && existing.queryFormat !== 'song_only') || (existing.id === 'ug' && existing.queryFormat !== 'artist_song')) {
                            existing.queryFormat = seed.queryFormat;
                        }
                        // If userscript is missing, empty, or an older stock script version, update it to the latest seed script
                        if (!existing.userscript || !existing.isUserModified || !existing.userscript.includes('v8-native-stream')) {
                            existing.userscript = seed.userscript;
                        }
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
 * Set up Tauri native event listener for completed downloads and debug logs
 */
export function initTauriDownloadListener() {
    if (window.__TAURI__ && window.__TAURI__.event) {
        // Download event
        window.__TAURI__.event.listen('tab-downloaded', async (event) => {
            console.log('[Tab Downloader] Received downloaded file event:', event.payload);
            appendDebugLog(`[Download Event] Received ${event.payload?.name} (${event.payload?.data?.length || 0} bytes)`);
            const { name, data, path } = event.payload || {};
            const now = Date.now();
            if (now - lastDownloadedTime < 2000 && lastDownloadedName === name) {
                console.log('[Tab Downloader] Skipping duplicate download event');
                return;
            }
            lastDownloadedTime = now;
            lastDownloadedName = name;

            if (data && Array.isArray(data)) {
                const uint8 = new Uint8Array(data);
                const blob = new Blob([uint8], { type: 'application/octet-stream' });
                const file = new File([blob], name || 'downloaded.gp', { type: blob.type, lastModified: Date.now() });

                const targetSong = activeTargetSong;

                // Close downloader modal first
                closeTabDownloaderModal();

                // Save to file store
                const stored = await saveStoredFile(file, 'tab-downloader', {
                    name: file.name,
                    relativePath: path || file.name,
                    targetSongId: targetSong?.id || null
                });

                // Attach to library song if target active
                if (targetSong?.id) {
                    await addTabOptionToSong(targetSong.id, {
                        name: file.name,
                        providerId: 'tab-downloader',
                        relativePath: path || file.name,
                        fileStoreId: stored.id,
                        tuning: inferTuningFromTextOrName(file.name),
                        fileType: file.name.split('.').pop().toLowerCase()
                    });
                }

                // Load file directly into player viewer
                await loadFile(file);
            }
        });

        // Debug log event from webview
        window.__TAURI__.event.listen('tab-downloader-log', (event) => {
            const msg = event.payload || '';
            console.log('[Tab Downloader Webview]', msg);
            appendDebugLog(msg);
        });
    }
}

/**
 * Open the In-App Tab Downloader UI
 * @param {Object} [options]
 * @param {string} [options.query]
 * @param {string} [options.artist]
 * @param {string} [options.songName]
 * @param {Object} [options.targetSong]
 */
export async function openTabDownloader(options = {}) {
    activeTargetSong = options.targetSong || null;
    if (options.songId && !activeTargetSong) {
        try { activeTargetSong = await getSongById(options.songId); } catch {}
    }

    activeArtistName = options.artist || activeTargetSong?.artist || '';
    activeSongName = options.songName || activeTargetSong?.title || '';

    const sources = getSources();
    const activeSource = sources.find(s => s.id === activeSourceId) || sources[0] || DEFAULT_SOURCES[0];

    // Build search query based on active source's query format
    let query = options.query || '';
    if (!query) {
        query = formatSearchQueryForSource(activeSource, activeArtistName, activeSongName);
    }
    currentSearchQuery = query;

    renderTabDownloaderModal(query);
}

/**
 * Closes the Tab Downloader Modal & hides native child webview
 */
export function closeTabDownloaderModal() {
    const modal = document.getElementById('tabDownloaderModal');
    if (modal) modal.style.display = 'none';

    if (nativeResizeObserver) {
        nativeResizeObserver.disconnect();
        nativeResizeObserver = null;
    }

    if (window.__TAURI__ && window.__TAURI__.core) {
        window.__TAURI__.core.invoke('tab_downloader_hide').catch(() => {});
    }
}

/**
 * Synchronize the native child webview position & dimensions with the in-app container
 */
async function syncNativeWebview(url = null, userscript = null) {
    if (!window.__TAURI__ || !window.__TAURI__.core) return;
    const container = document.getElementById('tabDownloaderBrowserContainer');
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const modal = document.getElementById('tabDownloaderModal');
    const isVisible = modal && modal.style.display !== 'none' && rect.width > 10 && rect.height > 10;

    const sources = getSources();
    const source = sources.find(s => s.id === activeSourceId) || sources[0] || DEFAULT_SOURCES[0];
    const targetUrl = url || buildSearchUrl(source, currentSearchQuery);
    const targetScript = userscript !== null ? userscript : (source.userscriptEnabled ? (source.userscript || '') : '');

    try {
        await window.__TAURI__.core.invoke('tab_downloader_update', {
            url: targetUrl,
            userscript: targetScript || null,
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            visible: isVisible
        });
    } catch (err) {
        console.error('[Tab Downloader] Failed to sync native webview:', err);
    }
}

/**
 * Renders the In-App Tab Downloader Modal
 */
function renderTabDownloaderModal(initialQuery = '') {
    let modal = document.getElementById('tabDownloaderModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'tabDownloaderModal';
        modal.className = 'theme-modal-backdrop';
        document.body.appendChild(modal);
    }
    modal.style.display = 'flex';

    const isNative = !!(window.__TAURI__);
    const sources = getSources();
    const activeSource = sources.find(s => s.id === activeSourceId) || sources[0] || DEFAULT_SOURCES[0];
    activeSourceId = activeSource.id;

    const currentUrl = buildSearchUrl(activeSource, currentSearchQuery);

    modal.innerHTML = `
    <div class="theme-modal-card tab-downloader-card">
      <!-- In-App Browser Header & Navigation Bar -->
      <div class="theme-modal-header py-2 px-3 border-bottom border-secondary-subtle">
        <div class="d-flex align-items-center gap-2 flex-grow-1 min-w-0">
          <!-- Browser History Navigation (Native Mode) -->
          ${isNative ? `
            <div class="btn-group btn-group-sm flex-shrink-0" role="group">
              <button type="button" class="btn btn-theme-outline py-1 px-2" id="downloaderBrowserBackBtn" title="Go Back">
                <i class="bi-chevron-left"></i>
              </button>
              <button type="button" class="btn btn-theme-outline py-1 px-2" id="downloaderBrowserForwardBtn" title="Go Forward">
                <i class="bi-chevron-right"></i>
              </button>
              <button type="button" class="btn btn-theme-outline py-1 px-2" id="downloaderBrowserReloadBtn" title="Reload Page">
                <i class="bi-arrow-clockwise"></i>
              </button>
            </div>
          ` : ''}

          <!-- Song Context Pill (if attached to a song) -->
          ${activeTargetSong ? `
            <span class="badge bg-secondary text-truncate d-none d-lg-inline-flex align-items-center gap-1 flex-shrink-0 py-1.5 px-2" style="max-width: 220px;" title="${escapeHtml(activeTargetSong.artist)} — ${escapeHtml(activeTargetSong.title)}">
              <i class="bi-music-note"></i> ${escapeHtml(activeTargetSong.artist)} — ${escapeHtml(activeTargetSong.title)}
            </span>
          ` : ''}

          <!-- Search / Address Bar -->
          <form id="downloaderSearchForm" class="d-flex align-items-center flex-grow-1 min-w-0 gap-1 mb-0">
            <div class="input-group input-group-sm flex-grow-1 min-w-0">
              <span class="input-group-text bg-dark border-secondary text-white-50"><i class="bi-search"></i></span>
              <input type="text" class="form-control bg-dark text-white border-secondary" id="downloaderSearchInput" value="${escapeHtml(currentSearchQuery)}" placeholder="Search song or artist...">
            </div>
            <button type="submit" class="btn btn-primary btn-sm px-2.5 flex-shrink-0" id="downloaderGoBtn" title="Search">
              <i class="bi-arrow-right"></i>
            </button>
          </form>
        </div>

        <!-- Header Actions -->
        <div class="d-flex align-items-center gap-1.5 ms-2 flex-shrink-0">
          ${isNative ? `
            <button type="button" class="btn btn-sm btn-theme-primary py-1 px-2.5 d-flex align-items-center gap-1" id="downloaderDirectDownloadBtn" title="Download Guitar Pro Tab from current page">
              <i class="bi-cloud-arrow-down-fill"></i> <span class="d-none d-sm-inline">Download Tab</span>
            </button>
            <button type="button" class="btn btn-sm ${isDebugDrawerOpen ? 'btn-info' : 'btn-theme-outline'} py-1 px-2" id="downloaderToggleDebugBtn" title="Toggle Webview Debug Console">
              <i class="bi-terminal"></i>
            </button>
          ` : ''}
          <button type="button" class="btn btn-sm btn-theme-outline py-1 px-2" id="downloaderManageSourcesBtn" title="Configure Tab Sources">
            <i class="bi-gear"></i>
          </button>
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="tabDownloaderCloseBtn" aria-label="Close">
            <i class="bi-x-lg"></i>
          </button>
        </div>
      </div>

      <!-- Live Debug Drawer (Collapsible) -->
      <div class="tab-downloader-debug-drawer" id="tabDownloaderDebugDrawer" style="${isDebugDrawerOpen ? 'display: block;' : 'display: none;'} background: #0b0f19; color: #cbd5e1; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.72rem; border-bottom: 1px solid var(--border-subtle); max-height: 150px; overflow-y: auto; padding: 6px 12px; z-index: 20; position: relative;">
        <div class="d-flex align-items-center justify-content-between mb-1 pb-1 border-bottom border-secondary-subtle">
          <span class="text-info fw-bold"><i class="bi-terminal me-1"></i> Webview Debug Console</span>
          <div class="d-flex align-items-center gap-1">
            <button class="btn btn-sm btn-outline-secondary py-0 px-1 text-white-50" id="downloaderClearLogsBtn" style="font-size: 0.68rem;">Clear Logs</button>
            <button class="btn btn-sm btn-outline-info py-0 px-1" id="downloaderInspectBtn" style="font-size: 0.68rem;"><i class="bi-bug me-1"></i> DevTools</button>
          </div>
        </div>
        <div id="downloaderLogsContent" class="d-flex flex-column gap-1">
          ${debugLogs.length === 0 ? '<div class="text-muted small">Listening for webview console events and downloads...</div>' : debugLogs.map(l => `<div class="text-break">${escapeHtml(l)}</div>`).join('')}
        </div>
      </div>

      <!-- Source Tabs Row -->
      <div class="tab-downloader-nav d-flex align-items-center gap-1 px-3 pt-2 overflow-x-auto border-bottom border-secondary-subtle" id="downloaderTabsList">
        ${sources.map(s => `
          <button type="button" class="btn btn-sm downloader-tab-btn ${s.id === activeSourceId ? 'active' : ''}" data-source-id="${s.id}">
            <i class="bi bi-globe me-1"></i> ${s.name}
          </button>
        `).join('')}
        <button type="button" class="btn btn-sm btn-outline-secondary py-0 px-2" id="downloaderAddSourceTabBtn" title="Add Source">
          <i class="bi-plus-lg"></i>
        </button>
      </div>

      <!-- In-App Browser View Container -->
      <div class="tab-downloader-browser-container" id="tabDownloaderBrowserContainer">
        ${!isNative ? `
          <div class="p-4 d-flex flex-column align-items-center justify-content-center h-100 text-center">
            <h6 class="text-white mb-2">Search Tabs on ${escapeHtml(activeSource.name)}</h6>
            <p class="small text-muted mb-3" style="max-width: 500px;">
              Click below to search in a browser tab, then drag and drop the downloaded file here.
            </p>
            <a href="${escapeHtml(currentUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm px-4 mb-4">
              <i class="bi-box-arrow-up-right me-1"></i> Open Search on ${escapeHtml(activeSource.name)}
            </a>
            <!-- Dropzone -->
            <div class="downloader-dropzone p-4 text-center rounded-3 border border-2 border-dashed border-secondary w-100" style="max-width: 500px;" id="downloaderDropzone">
              <i class="bi-cloud-arrow-up text-info fs-1 mb-2 d-block"></i>
              <div class="fw-semibold text-white mb-1">Drop downloaded tab here</div>
              <div class="small text-muted mb-2">Supports .gp, .gp3, .gp4, .gp5, .gpx, .pdf, .txt</div>
              <label class="btn btn-outline-light btn-sm px-3">
                <i class="bi-folder2-open me-1"></i> Browse File
                <input type="file" class="d-none" id="downloaderFileInput" accept=".pdf,.gp,.gp3,.gp4,.gp5,.gpx,.txt">
              </label>
            </div>
          </div>
        ` : ''}
      </div>
    </div>
    `;

    // Back to Library / Viewer
    modal.querySelector('#tabDownloaderBackBtn')?.addEventListener('click', () => {
        closeTabDownloaderModal();
        openLibraryModal('library');
    });

    // Close button
    modal.querySelector('#tabDownloaderCloseBtn')?.addEventListener('click', closeTabDownloaderModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeTabDownloaderModal();
    });

    // Browser navigation controls (Native mode)
    if (isNative) {
        modal.querySelector('#downloaderBrowserBackBtn')?.addEventListener('click', () => {
            window.__TAURI__.core.invoke('tab_downloader_nav', { action: 'back' }).catch(() => {});
        });
        modal.querySelector('#downloaderBrowserForwardBtn')?.addEventListener('click', () => {
            window.__TAURI__.core.invoke('tab_downloader_nav', { action: 'forward' }).catch(() => {});
        });
        modal.querySelector('#downloaderBrowserReloadBtn')?.addEventListener('click', () => {
            window.__TAURI__.core.invoke('tab_downloader_nav', { action: 'reload' }).catch(() => {});
        });

        // Direct download button in header toolbar
        modal.querySelector('#downloaderDirectDownloadBtn')?.addEventListener('click', () => {
            appendDebugLog('[Direct Download] Triggering __majesticDownloadCurrentTab from header button...');
            window.__TAURI__.core.invoke('tab_downloader_eval', {
                script: "if (typeof window.__majesticDownloadCurrentTab === 'function') { window.__majesticDownloadCurrentTab(); } else { alert('Download handler is initializing or this page does not contain a Guitar Pro tab.'); }"
            }).catch(err => {
                appendDebugLog(`[Direct Download Error] ${err}`);
            });
        });

        // Debug drawer toggle
        modal.querySelector('#downloaderToggleDebugBtn')?.addEventListener('click', () => {
            isDebugDrawerOpen = !isDebugDrawerOpen;
            const drawer = modal.querySelector('#tabDownloaderDebugDrawer');
            const btn = modal.querySelector('#downloaderToggleDebugBtn');
            if (drawer) drawer.style.display = isDebugDrawerOpen ? 'block' : 'none';
            if (btn) {
                btn.className = `btn btn-sm ${isDebugDrawerOpen ? 'btn-info' : 'btn-theme-outline'} py-1 px-2`;
            }
            syncNativeWebview();
        });

        // Clear logs
        modal.querySelector('#downloaderClearLogsBtn')?.addEventListener('click', () => {
            debugLogs = [];
            const container = modal.querySelector('#downloaderLogsContent');
            if (container) container.innerHTML = '<div class="text-muted small">Logs cleared.</div>';
        });

        // Inspect element / DevTools
        modal.querySelector('#downloaderInspectBtn')?.addEventListener('click', () => {
            window.__TAURI__.core.invoke('tab_downloader_open_devtools').catch(err => {
                appendDebugLog(`[DevTools Error] ${err}`);
            });
        });
    }

    // Source tab switching
    modal.querySelectorAll('.downloader-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const nextSourceId = btn.dataset.sourceId;
            activeSourceId = nextSourceId;
            const sources = getSources();
            const nextSource = sources.find(s => s.id === nextSourceId) || sources[0];

            let nextQuery = currentSearchQuery;
            if (activeSongName || activeArtistName) {
                nextQuery = formatSearchQueryForSource(nextSource, activeArtistName, activeSongName);
            }
            currentSearchQuery = nextQuery;
            renderTabDownloaderModal(nextQuery);
        });
    });

    // Search submit
    const searchForm = modal.querySelector('#downloaderSearchForm');
    searchForm?.addEventListener('submit', (e) => {
        e.preventDefault();
        const inputVal = modal.querySelector('#downloaderSearchInput')?.value || '';
        currentSearchQuery = inputVal;
        const newUrl = buildSearchUrl(activeSource, inputVal);
        if (isNative) {
            syncNativeWebview(newUrl);
        } else {
            renderTabDownloaderModal(inputVal);
        }
    });

    // Add source button
    modal.querySelector('#downloaderAddSourceTabBtn')?.addEventListener('click', () => {
        if (isNative && window.__TAURI__?.core) {
            window.__TAURI__.core.invoke('tab_downloader_hide').catch(() => {});
        }
        openSourceEditorModal();
    });

    // Manage sources button
    modal.querySelector('#downloaderManageSourcesBtn')?.addEventListener('click', () => {
        if (isNative && window.__TAURI__?.core) {
            window.__TAURI__.core.invoke('tab_downloader_hide').catch(() => {});
        }
        openSourceEditorModal();
    });

    // Native child webview positioning & resize observer
    if (isNative) {
        const container = modal.querySelector('#tabDownloaderBrowserContainer');
        if (container) {
            // Initial multi-pass positioning
            syncNativeWebview();
            requestAnimationFrame(() => syncNativeWebview());
            setTimeout(() => syncNativeWebview(), 80);
            setTimeout(() => syncNativeWebview(), 250);

            if (nativeResizeObserver) nativeResizeObserver.disconnect();
            nativeResizeObserver = new ResizeObserver(() => {
                syncNativeWebview();
            });
            nativeResizeObserver.observe(container);
            window.addEventListener('resize', () => syncNativeWebview(), { passive: true });
        }
    } else {
        setupWebDropzone(modal);
    }
}

/**
 * Handles dropzone and file input in Web mode
 */
function setupWebDropzone(modal) {
    const dropzone = modal.querySelector('#downloaderDropzone');
    const fileInput = modal.querySelector('#downloaderFileInput');

    if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (file) await handleImportedDownloadedFile(file);
        });
    }

    if (dropzone) {
        ['dragenter', 'dragover'].forEach(name => {
            dropzone.addEventListener(name, (e) => {
                e.preventDefault();
                dropzone.classList.add('border-primary');
            });
        });
        ['dragleave', 'drop'].forEach(name => {
            dropzone.addEventListener(name, (e) => {
                e.preventDefault();
                dropzone.classList.remove('border-primary');
            });
        });
        dropzone.addEventListener('drop', async (e) => {
            const file = e.dataTransfer?.files?.[0];
            if (file) await handleImportedDownloadedFile(file);
        });
    }
}

async function handleImportedDownloadedFile(file) {
    try {
        const stored = await saveStoredFile(file, 'tab-downloader-web', {
            name: file.name,
            relativePath: file.name,
            targetSongId: activeTargetSong?.id || null
        });

        if (activeTargetSong?.id) {
            await addTabOptionToSong(activeTargetSong.id, {
                name: file.name,
                providerId: 'tab-downloader-web',
                relativePath: file.name,
                fileStoreId: stored.id,
                tuning: inferTuningFromTextOrName(file.name),
                fileType: file.name.split('.').pop().toLowerCase()
            });
        }

        await loadFile(file);
        closeTabDownloaderModal();
    } catch (err) {
        console.error('Error importing downloaded tab file:', err);
        alert(`Error importing tab: ${err.message}`);
    }
}

/**
 * Modal to add / edit / delete sources and edit userscripts
 */
export function openSourceEditorModal(editingSourceId = null) {
    let modal = document.getElementById('sourceEditorModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'sourceEditorModal';
        modal.className = 'theme-modal-backdrop';
        document.body.appendChild(modal);
    }

    const sources = getSources();
    let currentEditing = editingSourceId ? sources.find(s => s.id === editingSourceId) : (sources[0] || DEFAULT_SOURCES[0]);
    if (!currentEditing && sources.length > 0) currentEditing = sources[0];

    modal.innerHTML = `
    <div class="theme-modal-card" style="max-width: 600px;">
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          <button type="button" class="brand-btn theme-modal-back-btn p-1 px-2" id="sourceEditorBackBtn" title="Back to Tab Downloader" aria-label="Back">
            <i class="bi-arrow-left"></i>
          </button>
          <div class="brand-btn p-2" style="width: 36px; height: 36px;">
            <i class="bi-sliders text-info"></i>
          </div>
          <div class="theme-modal-titles">
            <h6 class="mb-0 fw-bold text-white">Configure Tab Sources</h6>
            <small class="text-muted">Manage search providers and custom userscripts</small>
          </div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="sourceEditorCloseBtn">
            <i class="bi-x-lg"></i>
          </button>
        </div>
      </div>

      <div class="theme-modal-body p-3">
        <!-- Source Selector & Add New -->
        <div class="d-flex align-items-center justify-content-between mb-2">
          <label class="form-label small fw-semibold text-muted mb-0">Select Source:</label>
          <button type="button" class="btn btn-sm btn-outline-secondary py-0 px-2" id="sourceCreateNewBtn">
            <i class="bi-plus-lg me-1"></i> New Source
          </button>
        </div>
        <div class="hud-pill-group w-100 mb-3" id="sourceSelectorPill">
          ${sources.map(s => `
            <button type="button" class="btn btn-sm ${currentEditing && currentEditing.id === s.id ? 'active' : ''}" data-edit-id="${s.id}" style="flex:1;">
              ${escapeHtml(s.name)}
            </button>
          `).join('')}
        </div>

        <form id="sourceEditForm">
          <div class="mb-2">
            <label class="form-label small text-white-50 mb-1">Source Name</label>
            <input type="text" class="form-control form-control-sm bg-dark text-white border-secondary" id="editSourceName" value="${currentEditing ? escapeHtml(currentEditing.name) : ''}" required>
          </div>

          <div class="mb-2">
            <div class="d-flex justify-content-between align-items-center mb-1">
              <label class="form-label small text-white-50 mb-0">Search URL Template</label>
              ${currentEditing?.defaultUrl ? `<button type="button" class="btn btn-link btn-sm p-0 text-info" id="resetUrlBtn" style="font-size:0.75rem;">Reset URL</button>` : ''}
            </div>
            <input type="text" class="form-control form-control-sm bg-dark text-white border-secondary font-monospace" id="editSourceUrl" value="${currentEditing ? escapeHtml(currentEditing.urlTemplate) : ''}" placeholder="https://www.ultimate-guitar.com/search.php?title=SEARCH+TERM" required>
            <div class="text-muted mt-1" style="font-size: 0.72rem;">Use <code>SEARCH+TERM</code> where the search keywords should be inserted.</div>
          </div>

          <div class="mb-3">
            <label class="form-label small text-white-50 mb-1">Search Query Format</label>
            <select class="form-select form-select-sm bg-dark text-white border-secondary" id="editQueryFormat">
              <option value="artist_song" ${currentEditing?.queryFormat !== 'song_only' ? 'selected' : ''}>Artist + Song Name (e.g. Metallica Master of Puppets)</option>
              <option value="song_only" ${currentEditing?.queryFormat === 'song_only' ? 'selected' : ''}>Song Name Only (e.g. Master of Puppets)</option>
            </select>
            <div class="text-muted mt-1" style="font-size: 0.72rem;">Controls whether search queries sent to this provider include the artist name or only the song title.</div>
          </div>

          <!-- Userscript Section -->
          <div class="p-2 rounded-2 mb-3" style="background: var(--bg-card); border: 1px solid var(--border-subtle);">
            <div class="d-flex align-items-center justify-content-between mb-2">
              <div class="form-check form-switch mb-0">
                <input class="form-check-input theme-switch" type="checkbox" id="editUserscriptEnabled" ${currentEditing?.userscriptEnabled ? 'checked' : ''}>
                <label class="form-check-label small fw-semibold text-white" for="editUserscriptEnabled">Inject Userscript (In-App Webview)</label>
              </div>
              ${currentEditing?.defaultUserscript ? `<button type="button" class="btn btn-link btn-sm p-0 text-info" id="resetUserscriptBtn" style="font-size:0.75rem;">Reset Script</button>` : ''}
            </div>
            <textarea class="form-control form-control-sm bg-dark text-white border-secondary font-monospace" id="editUserscriptCode" rows="4" style="font-size: 0.78rem;" placeholder="// Custom JavaScript injected into webview">${currentEditing?.userscript || ''}</textarea>
          </div>

          <div class="d-flex align-items-center justify-content-between gap-2">
            <div>
              ${currentEditing && !currentEditing.isSeed ? `
                <button type="button" class="btn btn-sm btn-outline-danger" id="deleteSourceBtn">
                  <i class="bi-trash me-1"></i> Delete
                </button>
              ` : ''}
            </div>
            <div class="d-flex gap-2">
              <button type="button" class="btn btn-sm theme-control-btn" id="cancelSourceEditBtn">Cancel</button>
              <button type="submit" class="btn btn-sm btn-primary px-3">Save Changes</button>
            </div>
          </div>
        </form>
      </div>
    </div>
    `;

    modal.style.display = 'flex';

    // Close and Back buttons
    modal.querySelector('#sourceEditorBackBtn')?.addEventListener('click', () => {
        modal.style.display = 'none';
        renderTabDownloaderModal(currentSearchQuery);
    });
    modal.querySelector('#sourceEditorCloseBtn')?.addEventListener('click', () => {
        modal.style.display = 'none';
        renderTabDownloaderModal(currentSearchQuery);
    });
    modal.querySelector('#cancelSourceEditBtn')?.addEventListener('click', () => {
        modal.style.display = 'none';
        renderTabDownloaderModal(currentSearchQuery);
    });

    // Switch active source in editor
    modal.querySelectorAll('[data-edit-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            openSourceEditorModal(btn.dataset.editId);
        });
    });

    // Reset URL button
    modal.querySelector('#resetUrlBtn')?.addEventListener('click', () => {
        if (currentEditing?.defaultUrl) {
            modal.querySelector('#editSourceUrl').value = currentEditing.defaultUrl;
        }
    });

    // Reset Userscript button
    modal.querySelector('#resetUserscriptBtn')?.addEventListener('click', () => {
        if (currentEditing?.defaultUserscript) {
            modal.querySelector('#editUserscriptCode').value = currentEditing.defaultUserscript;
            modal.querySelector('#editUserscriptEnabled').checked = true;
        }
    });

    // Create New Source
    modal.querySelector('#sourceCreateNewBtn')?.addEventListener('click', () => {
        const newSource = {
            id: `source_${Date.now()}`,
            name: 'Custom Source',
            urlTemplate: 'https://www.ultimate-guitar.com/search.php?title=SEARCH+TERM',
            queryFormat: 'artist_song',
            userscriptEnabled: false,
            userscript: '',
            isSeed: false
        };
        const curSources = getSources();
        curSources.push(newSource);
        saveSources(curSources);
        openSourceEditorModal(newSource.id);
    });

    // Delete Source
    modal.querySelector('#deleteSourceBtn')?.addEventListener('click', () => {
        if (!currentEditing || currentEditing.isSeed) return;
        const curSources = getSources().filter(s => s.id !== currentEditing.id);
        saveSources(curSources);
        openSourceEditorModal(curSources[0]?.id || null);
    });

    // Save Form
    modal.querySelector('#sourceEditForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const curSources = getSources();
        const name = modal.querySelector('#editSourceName').value.trim();
        const urlTemplate = modal.querySelector('#editSourceUrl').value.trim();
        const queryFormat = modal.querySelector('#editQueryFormat')?.value || 'artist_song';
        const userscriptEnabled = modal.querySelector('#editUserscriptEnabled').checked;
        const userscript = modal.querySelector('#editUserscriptCode').value;

        if (currentEditing) {
            const idx = curSources.findIndex(s => s.id === currentEditing.id);
            if (idx >= 0) {
                curSources[idx].name = name;
                curSources[idx].urlTemplate = urlTemplate;
                curSources[idx].queryFormat = queryFormat;
                curSources[idx].userscriptEnabled = userscriptEnabled;
                curSources[idx].userscript = userscript;
            }
        }
        saveSources(curSources);
        modal.style.display = 'none';

        // Re-sync current search query if song info is available
        const activeSource = curSources.find(s => s.id === activeSourceId) || curSources[0];
        if (activeSongName || activeArtistName) {
            currentSearchQuery = formatSearchQueryForSource(activeSource, activeArtistName, activeSongName);
        }

        renderTabDownloaderModal(currentSearchQuery);
    });
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
