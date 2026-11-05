// tabDownloader.js
// Native Tab Downloader bridge for MajesticTab across all native platforms (Desktop & Mobile).

import { saveStoredFile } from './fileStore.js';
import { loadFile } from './main.js';
import { addTabOptionToSong, addTabOptionToAlbum, getSongById, removeTabOptionFromSong } from './libraryStore.js';
import { detectFileMetadata } from './utils/tuningUtils.js';
import { closeLibraryModal, navigateToAlbumInLibrary } from './libraryModal.js';
import { showToast } from './utils/toast.js';
import { SUPPORTED_TAB_EXTENSIONS } from './utils/fileHandlingUtils.js';
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

let activeTargetSong = null;
let activeTargetAlbum = null;
let activeDownloaderOnFileSelected = null;
let activeArtistName = '';
let activeSongName = '';
let activeSourceId = 'duckduckgo';
let currentSearchQuery = '';
// Batch Assistant state
let activeBatchMode = false;
let activeBatchQueue = [];
let activeBatchIndex = 0;
let activeBatchAlbumTitle = '';
let activeBatchArtistName = '';
let activeBatchAlbumId = null;
let activeAutoOpenOnDownload = false;
let lastAcquiredTrack = null;
let transientUndoTimer = null;
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

const escapeHtml = str => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Navigate native webview to a URL
 * @param {string} nextUrl
 */
export function navigateToDownloaderUrl(nextUrl) {
    if (!nextUrl) return;
    currentDownloaderUrl = nextUrl;
    const urlText = document.getElementById('downloaderUrlText');
    if (urlText) urlText.textContent = nextUrl;
    if (window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('tab_downloader_navigate', { url: nextUrl }).catch(err => {
            console.error('[Tab Downloader] Failed to navigate to url:', err);
        });
    }
    try { window.MajesticDownloaderNative?.loadUrl?.(nextUrl); } catch {}
}

/**
 * Show 6-second transient undo feedback banner
 */
export function showTransientFeedback(text, onUndo) {
    clearTimeout(transientUndoTimer);
    const banner = document.getElementById('downloaderTransientBanner');
    const textEl = document.getElementById('downloaderTransientText');
    const undoBtn = document.getElementById('downloaderTransientUndoBtn');
    if (!banner || !textEl) return;
    textEl.textContent = text;
    if (undoBtn) {
        undoBtn.style.display = onUndo ? '' : 'none';
        undoBtn.onclick = () => {
            hideTransientFeedback();
            if (typeof onUndo === 'function') onUndo();
        };
    }
    banner.style.display = 'flex';
    transientUndoTimer = setTimeout(() => {
        hideTransientFeedback();
    }, 6000);
}

export function hideTransientFeedback() {
    clearTimeout(transientUndoTimer);
    const banner = document.getElementById('downloaderTransientBanner');
    if (banner) banner.style.display = 'none';
}

/**
 * Show non-modal advisory badge
 */
export function showAdvisoryBadge(text, onSwitch) {
    const badge = document.getElementById('downloaderAdvisoryBadge');
    const textEl = document.getElementById('downloaderAdvisoryText');
    const switchBtn = document.getElementById('downloaderAdvisorySwitchBtn');
    if (!badge || !textEl) return;
    textEl.textContent = text;
    if (switchBtn) {
        switchBtn.style.display = onSwitch ? '' : 'none';
        switchBtn.onclick = () => {
            hideAdvisoryBadge();
            if (typeof onSwitch === 'function') onSwitch();
        };
    }
    badge.style.display = 'flex';
}

export function hideAdvisoryBadge() {
    const badge = document.getElementById('downloaderAdvisoryBadge');
    if (badge) badge.style.display = 'none';
}

/**
 * Present picker for multi-file ZIP archive
 */
function promptMultiFileZipChoice(files = []) {
    const picker = document.getElementById('downloaderZipPicker');
    const list = document.getElementById('downloaderZipPickerFiles');
    if (!picker || !list) return;
    list.innerHTML = files.map((f, i) => `
        <button type="button" class="btn btn-sm btn-theme-outline text-truncate w-100 mb-1 zip-choice-btn" data-file-index="${i}">
            <i class="bi-file-earmark-music me-1"></i>${escapeHtml(f.name)}
        </button>
    `).join('');
    list.querySelectorAll('.zip-choice-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            picker.style.display = 'none';
            const idx = parseInt(btn.dataset.fileIndex, 10);
            const chosen = files[idx];
            if (chosen) {
                handleDownloadedTabFile(chosen.name, chosen.data, chosen.path);
            }
        });
    });
    picker.style.display = 'flex';
}

/**
 * Update Batch HUD elements (stepper button, counter, checklist popover)
 */
export function updateBatchHUD() {
    if (!activeBatchMode) return;
    const albumTitleEl = document.getElementById('downloaderBatchAlbumTitle');
    const trackInfoEl = document.getElementById('downloaderBatchTrackInfo');
    const doneBtn = document.getElementById('downloaderBatchDoneBtn');
    const popoverList = document.getElementById('downloaderBatchTracklist');

    if (albumTitleEl) albumTitleEl.textContent = activeBatchAlbumTitle || 'Album';
    const currentTrack = activeBatchQueue[activeBatchIndex];
    if (trackInfoEl) {
        if (currentTrack) {
            trackInfoEl.innerHTML = `<span class="downloader-batch-progress tnum">${activeBatchIndex + 1} of ${activeBatchQueue.length}</span><span class="mx-1 text-muted">·</span><span class="downloader-batch-track-name text-truncate">${escapeHtml(currentTrack.title)}</span>`;
        } else {
            trackInfoEl.textContent = `${activeBatchQueue.length} tracks`;
        }
    }

    const acquiredCount = activeBatchQueue.filter(t => t.acquired).length;
    const totalCount = activeBatchQueue.length;
    if (doneBtn) {
        doneBtn.textContent = `Done (${acquiredCount}/${totalCount})`;
    }

    if (popoverList) {
        popoverList.innerHTML = activeBatchQueue.map((track, idx) => {
            const isCurrent = idx === activeBatchIndex;
            const statusIcon = track.acquired ? '✓' : (isCurrent ? '▶' : '○');
            const statusClass = track.acquired ? 'text-success' : (isCurrent ? 'fw-bold' : 'text-muted');
            const badgeText = track.alreadyInLibrary ? 'Already in Library' : (track.acquired ? (track.fileName ? `Saved (${track.fileName.split('.').pop().toUpperCase()})` : 'Acquired') : (isCurrent ? 'Active in browser' : 'Pending'));
            let actionBtn = '';
            if (track.acquired) {
                actionBtn = `<button type="button" class="btn btn-sm btn-theme-outline py-0 px-2 batch-track-action-btn" data-track-index="${idx}">${track.alreadyInLibrary ? 'Re-download' : 'Replace'}</button>`;
            } else if (!isCurrent) {
                actionBtn = `<button type="button" class="btn btn-sm btn-theme-outline py-0 px-2 batch-track-action-btn" data-track-index="${idx}">Jump</button>`;
            }
            return `
            <div class="downloader-batch-popover-row ${isCurrent ? 'is-active' : ''}" data-track-index="${idx}">
              <span class="batch-popover-status ${statusClass}">${statusIcon}</span>
              <span class="batch-popover-num">${idx + 1}.</span>
              <span class="batch-popover-title text-truncate">${escapeHtml(track.title)}</span>
              <span class="batch-popover-meta text-muted text-truncate">${badgeText}</span>
              <div class="ms-auto">${actionBtn}</div>
            </div>
            `;
        }).join('');

        popoverList.querySelectorAll('.batch-track-action-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.trackIndex, 10);
                jumpToBatchTrack(idx);
            });
        });
    }
}

/**
 * Jump to a specific track in the batch queue
 */
export function jumpToBatchTrack(targetIndex) {
    if (!activeBatchMode || targetIndex < 0 || targetIndex >= activeBatchQueue.length) return;
    activeBatchIndex = targetIndex;
    const popover = document.getElementById('downloaderBatchPopover');
    if (popover) { popover.style.display = 'none'; refreshDownloaderOffset(); }
    const stepperBtn = document.getElementById('downloaderBatchStepperBtn');
    if (stepperBtn) stepperBtn.setAttribute('aria-expanded', 'false');

    updateBatchHUD();

    const targetTrack = activeBatchQueue[targetIndex];
    if (targetTrack) {
        const sources = getSources();
        const activeSource = sources.find(s => s.id === activeSourceId) || sources[0] || DEFAULT_SOURCES[0];
        const nextQuery = formatSearchQueryForSource(activeSource, activeBatchArtistName, targetTrack.title);
        currentSearchQuery = nextQuery;
        showLoadingInUrlBar(activeSource.name);
        navigateToDownloaderUrl(buildSearchUrl(activeSource, nextQuery));
    }
}

/**
 * Skip current track in batch queue
 */
export function skipCurrentBatchTrack() {
    if (!activeBatchMode || activeBatchQueue.length === 0) return;
    let nextIdx = activeBatchQueue.findIndex((t, i) => i > activeBatchIndex && !t.acquired);
    if (nextIdx === -1) nextIdx = activeBatchQueue.findIndex((t, i) => i !== activeBatchIndex && !t.acquired);
    if (nextIdx !== -1) {
        jumpToBatchTrack(nextIdx);
    } else {
        finishBatchSession();
    }
}

/**
 * Complete the batch session and return to library
 */
export function finishBatchSession() {
    const albumTitle = activeBatchAlbumTitle;
    const artistName = activeBatchArtistName;
    closeTabDownloaderModal();
    if (albumTitle) {
        showToast(`Finished album session for ${albumTitle}`, 'success');
        navigateToAlbumInLibrary(artistName, albumTitle);
    }
}

/**
 * Undo last batch download
 */
export function undoLastBatchDownload() {
    if (!lastAcquiredTrack) return;
    const track = activeBatchQueue.find(t => (lastAcquiredTrack.songId && t.songId === lastAcquiredTrack.songId) || t.title === lastAcquiredTrack.title);
    if (track) {
        track.acquired = false;
        track.fileName = null;
        if (lastAcquiredTrack.tabOptionId && lastAcquiredTrack.songId) {
            removeTabOptionFromSong(lastAcquiredTrack.songId, lastAcquiredTrack.tabOptionId).catch(() => {});
        }
        const idx = activeBatchQueue.indexOf(track);
        if (idx !== -1) {
            jumpToBatchTrack(idx);
        }
    }
    lastAcquiredTrack = null;
}

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
                        if ((existing.id === 'google' || existing.id === 'duckduckgo') && /\+guitar\+pro\+tab$/.test(existing.urlTemplate || '')) {
                            existing.urlTemplate = seed.urlTemplate;
                            existing.defaultUrl = seed.defaultUrl;
                            changed = true;
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
 * Extracts a clean friendly website name from a URL, preferring configured source names if matched
 * @param {string|null} url
 * @returns {string|null}
 */
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

    // HTML payload guard (paywall / login trap / web error page)
    try {
        const sample = new TextDecoder().decode(uint8.subarray(0, 256)).toLowerCase().trim();
        if (sample.startsWith('<!doctype html') || sample.startsWith('<html') || sample.includes('<head>') || sample.includes('<body>')) {
            const warnMsg = '⚠️ Download was a web page or invalid file. Try an alternate tab link.';
            if (activeBatchMode) {
                showTransientFeedback(warnMsg, null);
            } else {
                showToast(warnMsg, 'warning');
            }
            return;
        }
    } catch {}

    // In-memory .zip archive extraction
    // A GP7/8 .gp file is itself a ZIP container, so only unpack when the name is not a tab extension.
    const nameExt = (name || '').split('.').pop()?.toLowerCase();
    const looksZip = uint8.length > 4 && uint8[0] === 0x50 && uint8[1] === 0x4B && uint8[2] === 0x03 && uint8[3] === 0x04;
    const isZip = nameExt === 'zip' || (looksZip && !SUPPORTED_TAB_EXTENSIONS.includes(nameExt));
    if (isZip && typeof window !== 'undefined' && window.fflate?.unzipSync) {
        try {
            const unzipped = window.fflate.unzipSync(uint8);
            const tabEntries = Object.keys(unzipped).filter(filename => {
                if (filename.includes('__MACOSX') || filename.endsWith('/')) return false;
                const ext = filename.split('.').pop()?.toLowerCase();
                return SUPPORTED_TAB_EXTENSIONS.includes(ext);
            });
            const isGpContainer = Object.keys(unzipped).some(f => /(^|\/)score\.gpif$/i.test(f));
            if (tabEntries.length === 0 && isGpContainer) {
                // Extensionless GP7/8 file: it is the tab itself, not an archive of tabs.
                if (!/\.gp$/i.test(name || '')) name = `${name || 'tab'}.gp`;
            } else if (tabEntries.length === 0) {
                const warnMsg = '⚠️ Archive contains no supported tab files. Try an alternate tab link.';
                if (activeBatchMode) {
                    showTransientFeedback(warnMsg, null);
                } else {
                    showToast(warnMsg, 'warning');
                }
                return;
            } else if (tabEntries.length === 1) {
                name = tabEntries[0].split('/').pop();
                uint8 = unzipped[tabEntries[0]];
            } else {
                promptMultiFileZipChoice(tabEntries.map(entry => ({
                    name: entry.split('/').pop(),
                    path: entry,
                    data: unzipped[entry]
                })));
                return;
            }
        } catch (zipErr) {
            console.warn('[Tab Downloader] Failed to uncompress zip archive:', zipErr);
        }
    }

    const blob = new Blob([uint8], { type: 'application/octet-stream' });
    const file = new File([blob], name || 'downloaded.gp', { type: blob.type, lastModified: Date.now() });

    const sourceUrl = pendingMatchedTabUrl || currentDownloaderUrl || null;
    const sourceWebsite = extractSourceWebsite(sourceUrl);
    file.sourceUrl = sourceUrl;
    file.sourceWebsite = sourceWebsite;
    file.providerId = 'tab-downloader';
    file.addedAt = Date.now();

    // 1. Batch Assistant mode
    if (activeBatchMode && activeBatchQueue.length > 0) {
        const currentTrack = activeBatchQueue[activeBatchIndex];
        if (currentTrack) {
            const meta = await detectFileMetadata(file, file.name);
            const stored = await saveStoredFile(file, 'tab-downloader', {
                name: file.name,
                relativePath: path || file.name,
                targetSongId: currentTrack.songId,
                sourceUrl,
                sourceWebsite
            });
            const addedOption = await addTabOptionToSong(currentTrack.songId, {
                name: file.name,
                providerId: 'tab-downloader',
                relativePath: path || file.name,
                fileStoreId: stored.id,
                tuning: meta.primaryTuning,
                tunings: meta.tunings,
                stringCount: meta.stringCount,
                fileType: file.name.split('.').pop().toLowerCase(),
                sourceUrl,
                sourceWebsite
            });
            currentTrack.acquired = true;
            currentTrack.fileName = file.name;
            lastAcquiredTrack = {
                ...currentTrack,
                fileStoreId: stored.id,
                tabOptionId: addedOption?.id
            };
            window.dispatchEvent(new CustomEvent('libraryDataChanged'));

            let nextIdx = activeBatchQueue.findIndex((t, i) => i > activeBatchIndex && !t.acquired);
            if (nextIdx === -1) nextIdx = activeBatchQueue.findIndex(t => !t.acquired);

            const nextTrack = nextIdx !== -1 ? activeBatchQueue[nextIdx] : null;
            const feedbackMsg = `✓ ${currentTrack.title} saved! · Next: ${nextTrack ? nextTrack.title : 'Finish'}…`;
            showTransientFeedback(feedbackMsg, () => {
                undoLastBatchDownload();
            });

            if (!nextTrack) {
                updateBatchHUD();
                setTimeout(() => {
                    finishBatchSession();
                }, 1200);
                return;
            }

            activeBatchIndex = nextIdx;
            updateBatchHUD();

            const sources = getSources();
            const activeSource = sources.find(s => s.id === activeSourceId) || sources[0] || DEFAULT_SOURCES[0];
            const nextQuery = formatSearchQueryForSource(activeSource, activeBatchArtistName, nextTrack.title);
            currentSearchQuery = nextQuery;
            showLoadingInUrlBar(activeSource.name);
            navigateToDownloaderUrl(buildSearchUrl(activeSource, nextQuery));
            return;
        }
    }

    const targetSong = activeTargetSong;
    const targetAlbum = activeTargetAlbum;
    const onFileSelectedCb = activeDownloaderOnFileSelected;
    const matchedUrl = pendingMatchedTabUrl;
    const autoOpen = activeAutoOpenOnDownload;

    // Reset targets once consumed
    activeTargetSong = null;
    activeTargetAlbum = null;
    activeDownloaderOnFileSelected = null;
    pendingMatchedTabUrl = null;
    activeEphemeralSource = null;
    activeAutoOpenOnDownload = false;

    // 2. 1-Step Single Song Fulfillment (autoOpenOnDownload)
    if (autoOpen && targetSong?.id) {
        closeTabDownloaderModal();
        const meta = await detectFileMetadata(file, file.name);
        const stored = await saveStoredFile(file, 'tab-downloader', {
            name: file.name,
            relativePath: path || file.name,
            targetSongId: targetSong.id,
            sourceUrl,
            sourceWebsite
        });
        await addTabOptionToSong(targetSong.id, {
            name: file.name,
            providerId: 'tab-downloader',
            relativePath: path || file.name,
            fileStoreId: stored.id,
            tuning: meta.primaryTuning,
            tunings: meta.tunings,
            stringCount: meta.stringCount,
            fileType: file.name.split('.').pop().toLowerCase(),
            sourceUrl,
            sourceWebsite
        });
        showToast(`Added "${file.name}" to ${targetSong.title || 'song'}`, 'success');
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
        closeLibraryModal(true);
        await loadFile(file);
        try {
            window.focus();
            const output = document.getElementById('output');
            if (output && output.style.display !== 'none') output.focus();
        } catch {}
        if (matchedUrl) {
            const songKey = [targetSong.artist, targetSong.title].filter(Boolean).join(' - ') || targetSong.title || file.name;
            attachSyncForMatchedUrl(matchedUrl, { showToast, file, songKey }).catch(err => {
                console.warn('[Tab Downloader] Background sync point attachment failed:', err);
            });
        }
        return;
    }

    // Close / hide downloader
    closeTabDownloaderModal();

    if (typeof onFileSelectedCb === 'function') {
        const meta = await detectFileMetadata(file, file.name);
        const stored = await saveStoredFile(file, 'tab-downloader', {
            name: file.name,
            relativePath: path || file.name,
            sourceUrl,
            sourceWebsite
        });
        closeLibraryModal(true);
        onFileSelectedCb({ file, providerId: 'tab-downloader', fileStoreId: stored.id, name: file.name, meta, sourceUrl, sourceWebsite });
        return;
    }

    // Persist to file store and attach to library song if bound (stay in library, matching Local & Google Drive)
    if (targetSong?.id) {
        const meta = await detectFileMetadata(file, file.name);
        const stored = await saveStoredFile(file, 'tab-downloader', {
            name: file.name,
            relativePath: path || file.name,
            targetSongId: targetSong.id,
            sourceUrl,
            sourceWebsite
        });

        await addTabOptionToSong(targetSong.id, {
            name: file.name,
            providerId: 'tab-downloader',
            relativePath: path || file.name,
            fileStoreId: stored.id,
            tuning: meta.primaryTuning,
            tunings: meta.tunings,
            stringCount: meta.stringCount,
            fileType: file.name.split('.').pop().toLowerCase(),
            sourceUrl,
            sourceWebsite
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
            relativePath: path || file.name,
            sourceUrl,
            sourceWebsite
        });

        await addTabOptionToAlbum(targetAlbum.collectionId, targetAlbum.artistName, targetAlbum.albumTitle, {
            name: file.name,
            providerId: 'tab-downloader',
            relativePath: path || file.name,
            fileStoreId: stored.id,
            tuning: meta.primaryTuning,
            tunings: meta.tunings,
            stringCount: meta.stringCount,
            fileType: file.name.split('.').pop().toLowerCase(),
            sourceUrl,
            sourceWebsite
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
let isSourcesDropdownOpen = false;
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
        reloadDownloaderWebview();
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
        adblockBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const next = !isAdblockEnabled();

            // Optimistic UI sync
            try {
                localStorage.setItem(ADBLOCK_ENABLED_KEY, next ? 'true' : 'false');
            } catch {}
            syncDownloaderAdblockButton();

            try {
                const res = await setAdblockEnabled(next);
                if (res.enabled) {
                    showToast(`Adblock active (${res.count.toLocaleString()} domains)`, 'success', 2500);
                } else {
                    showToast('Adblock disabled', 'info', 2500);
                }
            } catch (err) {
                console.warn('[Tab Downloader] Failed to update adblock rules:', err);
                showToast('Failed to update adblock rules', 'error', 3000);
                try {
                    localStorage.setItem(ADBLOCK_ENABLED_KEY, (!next) ? 'true' : 'false');
                } catch {}
            } finally {
                syncDownloaderAdblockButton();
                reloadDownloaderWebview();
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

    // Sources dropdown height synchronization with native webview
    let sourcesMenuResizeObserver = null;
    const sourcesDropdown = document.getElementById('downloaderSourcesDropdown');
    const sourcesMenu = document.getElementById('downloaderSourcesMenu');
    sourcesDropdown?.addEventListener('show.bs.dropdown', () => {
        isSourcesDropdownOpen = true;
        refreshDownloaderOffset();
        if (typeof ResizeObserver !== 'undefined' && sourcesMenu) {
            if (!sourcesMenuResizeObserver) {
                sourcesMenuResizeObserver = new ResizeObserver(() => {
                    if (isSourcesDropdownOpen) refreshDownloaderOffset();
                });
            }
            sourcesMenuResizeObserver.observe(sourcesMenu);
        }
    });
    sourcesDropdown?.addEventListener('shown.bs.dropdown', () => {
        isSourcesDropdownOpen = true;
        refreshDownloaderOffset();
    });
    sourcesDropdown?.addEventListener('hide.bs.dropdown', () => {
        isSourcesDropdownOpen = false;
        if (sourcesMenuResizeObserver) sourcesMenuResizeObserver.disconnect();
        refreshDownloaderOffset();
    });
    sourcesDropdown?.addEventListener('hidden.bs.dropdown', () => {
        isSourcesDropdownOpen = false;
        if (sourcesMenuResizeObserver) sourcesMenuResizeObserver.disconnect();
        refreshDownloaderOffset();
    });

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

    // Batch Assistant: Stepper button opens popover
    const stepperBtn = document.getElementById('downloaderBatchStepperBtn');
    const popover = document.getElementById('downloaderBatchPopover');
    stepperBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!popover) return;
        const isOpen = popover.style.display === 'block';
        popover.style.display = isOpen ? 'none' : 'block';
        stepperBtn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
        refreshDownloaderOffset();
    });

    document.getElementById('downloaderBatchPopoverCloseBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (popover) { popover.style.display = 'none'; refreshDownloaderOffset(); }
        stepperBtn?.setAttribute('aria-expanded', 'false');
        refreshDownloaderOffset();
    });

    // Close popover when clicking outside
    document.addEventListener('click', (e) => {
        if (popover && popover.style.display === 'block' && !e.target.closest('#downloaderBatchStepperContainer')) {
            popover.style.display = 'none';
            stepperBtn?.setAttribute('aria-expanded', 'false');
            refreshDownloaderOffset();
        }
    });

    // Batch Skip & Done buttons
    document.getElementById('downloaderBatchSkipBtn')?.addEventListener('click', () => {
        skipCurrentBatchTrack();
    });

    document.getElementById('downloaderBatchDoneBtn')?.addEventListener('click', () => {
        finishBatchSession();
    });

    // ZIP picker cancel
    document.getElementById('downloaderZipPickerCancelBtn')?.addEventListener('click', () => {
        const picker = document.getElementById('downloaderZipPicker');
        if (picker) picker.style.display = 'none';
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

export function reloadDownloaderWebview() {
    if (window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('tab_downloader_nav', { action: 'reload' }).catch(() => {});
    }
    if (window.MajesticDownloaderNative?.reload) {
        try { window.MajesticDownloaderNative.reload(); } catch {}
    } else if (currentDownloaderUrl) {
        navigateToDownloaderUrl(currentDownloaderUrl);
    }
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
        icon.className = enabled ? 'bi-shield-fill-check' : 'bi-shield';
    }
}

/**
 * The album tracklist and sources dropdown drop below the bar, but the site webview is a separate
 * native view that would cover them. While either is open, push the site webview down to its bottom edge.
 * @returns {number}
 */
function downloaderPopoverReach() {
    let reach = 0;
    const pop = document.getElementById('downloaderBatchPopover');
    if (pop && pop.style.display === 'block') {
        reach = Math.max(reach, Math.ceil(pop.getBoundingClientRect().bottom + 12));
    }
    const sourcesMenu = document.getElementById('downloaderSourcesMenu');
    if (sourcesMenu && (isSourcesDropdownOpen || sourcesMenu.classList.contains('show'))) {
        const rect = sourcesMenu.getBoundingClientRect();
        if (rect.bottom > 0) {
            reach = Math.max(reach, Math.ceil(rect.bottom + 12));
        } else {
            const btn = document.getElementById('downloaderSourcesBtn');
            const btnBottom = btn ? btn.getBoundingClientRect().bottom : 44;
            const items = sourcesMenu.querySelectorAll('li').length || 3;
            reach = Math.max(reach, Math.ceil(btnBottom + (items * 38) + 20));
        }
    }
    return reach;
}

function refreshDownloaderOffset() {
    const bar = document.getElementById('tabDownloaderBar');
    const h = bar ? Math.floor(bar.getBoundingClientRect().height) : 0;
    syncDownloaderTopOffset(h);
}

/**
 * Tell the native shell how tall the top bar is so the content webview starts below it.
 * @param {number} cssHeight
 */
function syncDownloaderTopOffset(cssHeight) {
    cssHeight = Math.max(cssHeight, downloaderPopoverReach());
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
 * Render tab provider choices in the Sources dropdown menu
 */
export function renderDownloaderTabs() {
    const menu = document.getElementById('downloaderSourcesMenu');
    const label = document.getElementById('downloaderActiveSourceName');

    const sources = [...getSources()];
    if (activeEphemeralSource) {
        sources.push({
            id: activeEphemeralSource.id,
            name: activeEphemeralSource.name,
            defaultUrl: activeEphemeralSource.url,
            urlTemplate: activeEphemeralSource.url
        });
    }

    const currentSrc = sources.find(s => s.id === activeSourceId) || sources[0];
    if (label && currentSrc) {
        label.textContent = currentSrc.name;
    }

    if (menu) {
        menu.innerHTML = sources.map(s => `
            <li>
                <button type="button" class="dropdown-item small d-flex align-items-center justify-content-between downloader-source-menu-item ${s.id === activeSourceId ? 'active' : ''}" data-source-id="${s.id}">
                    <span>${escapeHtml(s.name)}</span>
                    ${s.id === activeSourceId ? '<i class="bi-check2 ms-2" aria-hidden="true"></i>' : ''}
                </button>
            </li>
        `).join('');

        menu.querySelectorAll('.downloader-source-menu-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const sid = btn.dataset.sourceId;
                const src = sources.find(s => s.id === sid);
                if (src) {
                    switchActiveSource(src);
                }
            });
        });
    }
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
    syncDownloaderAdblockButton();
    renderDownloaderTabs();

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
            syncDownloaderAdblockButton();
    renderDownloaderTabs();
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

    // Update target context row (Single Song Context vs Album Batch Stepper)
    const targetRow = document.getElementById('downloaderTargetRow');
    const singleTarget = document.getElementById('downloaderSingleTarget');
    const batchRow = document.getElementById('downloaderBatchRow');

    if (activeBatchMode) {
        if (singleTarget) singleTarget.style.display = 'none';
        if (batchRow) batchRow.style.display = 'flex';
        if (targetRow) targetRow.style.display = 'flex';
        updateBatchHUD();
    } else {
        if (batchRow) batchRow.style.display = 'none';
        const hasSong = Boolean(activeSongName);
        const hasArtist = Boolean(activeArtistName);
        const hasAlbum = Boolean(activeTargetAlbum?.albumTitle);
        if (hasSong || hasArtist || hasAlbum) {
            if (singleTarget) {
                const artistEl = document.getElementById('downloaderTargetArtist');
                const dotEl = document.getElementById('downloaderTargetDot');
                const albumEl = document.getElementById('downloaderTargetAlbum');
                const dot2El = document.getElementById('downloaderTargetDot2');
                const titleEl = document.getElementById('downloaderTargetTitle');

                if (artistEl) {
                    artistEl.textContent = activeArtistName || '';
                    artistEl.style.display = activeArtistName ? 'inline' : 'none';
                }
                if (dotEl) {
                    dotEl.style.display = (activeArtistName && (hasAlbum || hasSong)) ? 'inline' : 'none';
                }
                if (albumEl) {
                    const alb = activeTargetAlbum?.albumTitle || '';
                    albumEl.textContent = alb;
                    albumEl.style.display = alb ? 'inline' : 'none';
                }
                if (dot2El) {
                    dot2El.style.display = (hasAlbum && hasSong) ? 'inline' : 'none';
                }
                if (titleEl) {
                    titleEl.textContent = activeSongName || activeArtistName || '';
                    titleEl.style.display = (activeSongName || activeArtistName) ? 'inline' : 'none';
                }
                singleTarget.style.display = 'flex';
            }
            if (targetRow) targetRow.style.display = 'flex';
        } else {
            if (singleTarget) singleTarget.style.display = 'none';
            if (targetRow) targetRow.style.display = 'none';
        }
    }

    // DevTools button
    const devToolsBtn = document.getElementById('downloaderDevToolsBtn');
    if (devToolsBtn) {
        devToolsBtn.style.display = isDebugToolsEnabled ? 'inline-flex' : 'none';
    }

    syncDownloaderAdblockButton();
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
    syncDownloaderAdblockButton();
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

    if (activeBatchMode && activeBatchQueue.length > 0) {
        const curTrack = activeBatchQueue[activeBatchIndex];
        const matchIdx = activeBatchQueue.findIndex((t, i) => i !== activeBatchIndex && t.title && url.toLowerCase().includes(encodeURIComponent(t.title.toLowerCase())));
        if (matchIdx !== -1 && curTrack) {
            showAdvisoryBadge(`Viewing prior page · Target remains: Track ${activeBatchIndex + 1} (${curTrack.title})`, () => {
                jumpToBatchTrack(matchIdx);
            });
        } else {
            hideAdvisoryBadge();
        }
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

    activeBatchMode = Boolean(options.batchMode);
    activeBatchQueue = Array.isArray(options.queue) ? options.queue : [];
    activeBatchIndex = Number.isInteger(options.currentIndex) ? options.currentIndex : 0;
    activeBatchAlbumTitle = options.albumTitle || '';
    activeBatchArtistName = options.artistName || options.artist || '';
    activeBatchAlbumId = options.albumId || null;
    activeAutoOpenOnDownload = Boolean(options.autoOpenOnDownload);
    lastAcquiredTrack = null;

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

    if (activeBatchMode && activeBatchQueue.length > 0 && activeBatchIndex < activeBatchQueue.length) {
        activeArtistName = activeBatchArtistName;
        activeSongName = activeBatchQueue[activeBatchIndex]?.title || '';
    } else {
        activeArtistName = options.artist || activeTargetSong?.artist || activeTargetAlbum?.artistName || '';
        activeSongName = options.songName || activeTargetSong?.title || activeTargetAlbum?.albumTitle || '';
    }

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
    isSourcesDropdownOpen = false;
    activeDownloaderOnFileSelected = null;
    activeTargetSong = null;
    activeTargetAlbum = null;
    activeEphemeralSource = null;
    pendingMatchedTabUrl = null;
    activeBatchMode = false;
    activeBatchQueue = [];
    activeBatchIndex = 0;
    activeBatchAlbumTitle = '';
    activeBatchArtistName = '';
    activeBatchAlbumId = null;
    activeAutoOpenOnDownload = false;
    lastAcquiredTrack = null;

    hideTransientFeedback();
    hideAdvisoryBadge();
    const popover = document.getElementById('downloaderBatchPopover');
    if (popover) { popover.style.display = 'none'; refreshDownloaderOffset(); }
    const picker = document.getElementById('downloaderZipPicker');
    if (picker) picker.style.display = 'none';

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

