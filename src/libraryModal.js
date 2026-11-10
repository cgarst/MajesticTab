// libraryModal.js
// Artwork-rich MusicBrainz-powered Tab Library Page aligned to themes.

import { initNativeTabBar, setNativeTabActive } from './nativeTabBar.js';
import { mountSettingsPage, parkSettingsPage } from './utils/settingsPage.js';
import {
    getCollections, getLibraryHierarchy, getLibraryTuningsHierarchy,
    getSongsByCollection, saveSongToLibrary, addAlbumToLibrary, deleteSongFromLibrary,
    deleteAlbumFromLibrary, getSongById, addTabOptionToSong, updateTabOptionOnSong, removeTabOptionFromSong, setDefaultTabOption,
    togglePinSong, toggleArtistPinned, isArtistPinned, getAlbumTabOptions, addTabOptionToAlbum, removeTabOptionFromAlbum, setDefaultAlbumTabOption,
    getRecents, clearRecents, deleteRecentItem, getRecentItem, restoreRecentItem, addRecentOpened, DEFAULT_COLLECTION_ID
} from './libraryStore.js';
import {
    searchMusicBrainz, getArtistAlbums, getAlbumTracks,
    getPlaceholderCoverSvg, isDvdOrBlurayMedium, isVinylOrTapeMedium,
    filterInstrumentalBonusDiscs, hydrateCachedImages, getSynchronousCachedArtUrl,
    cleanTrackTitleForMatching
} from './musicbrainz.js';
import { rankCatalogArtists, rankCatalogAlbums, rankCatalogSongs, splitCatalogArtists } from './catalogRank.js';
import { getStoredFile, saveStoredFile } from './fileStore.js';
import { loadFile, getCurrentFile } from './main.js';
import { openFromProvider, getFileProviders } from './fileProviders.js';
import { renderOpenFileView } from './openFileModal.js';
import { renderSetlistsView, openAddToSetlistModal } from './setlistUi.js';
import { detectFileMetadata, getTuningInfo, tuningMatchesQuery, setCustomTuningName, isTuningMatchingInstrument, visibleTuningsForSong, visibleTuningLabel } from './utils/tuningUtils.js';
import { renderTuningBarsSvg } from './utils/tuningVisual.js';
import { updateGlobalAudioControls } from './utils/navigationUtils.js';
import { isSupportedTabFile, canAcceptTabDrop } from './utils/fileHandlingUtils.js';
import { showToast } from './utils/toast.js';
import { scoreOptionsState, pauseSynthPlayer, getAudioLatencyMs } from './gpProcessor/gpPlayer.js';
import { pauseYouTube } from './youtubePlayer.js';
import { metronome } from './metronome/metronome.js';
import { pitchCraftTuner } from './tuner/tuner.js';
import { fretboardController } from './fretboard/fretboardController.js';
import { updateUrl, clearUrl } from './utils/urlRouter.js';
import { gamepadManager } from './utils/gamepadManager.js';
import { songHasSyncPoints } from './audioSync/syncStore.js';
import { isNative, openTabDownloader } from './tabDownloader.js';
import { openSongTabPicker, closeSongTabPicker, isSongTabPickerOpen } from './songTabPicker.js';

export const HIDE_NO_TAB_SONGS_KEY = 'majestictab_hide_no_tab_songs';

export function isHideNoTabSongsEnabled() {
    try {
        return localStorage.getItem(HIDE_NO_TAB_SONGS_KEY) === 'true';
    } catch (_) {
        return false;
    }
}

export function setHideNoTabSongsEnabled(val) {
    try {
        localStorage.setItem(HIDE_NO_TAB_SONGS_KEY, val ? 'true' : 'false');
    } catch (_) {}
    window.dispatchEvent(new CustomEvent('library:refresh'));
}

export function songHasTabs(song) {
    return Boolean(song && Array.isArray(song.tabOptions) && song.tabOptions.length > 0);
}

window.addEventListener('library:refresh', () => {
    if (isLibraryOpen()) {
        renderLibraryModal();
    }
});

// The phone's bottom tab bar is fixed over the bottom of the library, and Popper does not know it is there, so a
// menu opened near the bottom stayed below it. Keep every dropdown clear of the bar: it flips up instead.
try {
    const dropdown = window.bootstrap?.Dropdown;
    if (dropdown) {
        dropdown.Default.popperConfig = (config) => {
            const nav = document.getElementById('libraryBottomNav');
            const rect = nav && nav.offsetParent !== null ? nav.getBoundingClientRect() : null;
            // A bar along the bottom edge (phone); the rail on wider screens sits at the side and needs nothing
            const bottom = rect && rect.top > window.innerHeight / 2 ? Math.ceil(window.innerHeight - rect.top) : 0;
            if (!bottom) return config;
            const pad = { top: 8, left: 8, right: 8, bottom };
            return {
                ...config,
                modifiers: [
                    ...(config.modifiers || []),
                    { name: 'flip', options: { padding: pad } },
                    { name: 'preventOverflow', options: { padding: pad } }
                ]
            };
        };
    }
} catch { /* the menus still work, they may sit under the bar */ }

// The library page scrolls and clips what hangs past it, so the last song's menu was cut off at the bottom edge.
// Once a menu opens inside it, scroll it into view.
document.addEventListener('shown.bs.dropdown', (e) => {
    const menu = e.target?.closest?.('.library-page-body') ? e.target.querySelector('.dropdown-menu.show') : null;
    if (menu) menu.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

import { closeToolsMenu } from './utils/toolsMenu.js';
import { closeAllReaderPanels } from './utils/readerPanels.js';
import { renderToolsPage, releaseEmbeddedTools, forgetResume } from './utils/toolsPage.js';
import { hasStemDeckSupport } from './stemdeck/stemdeckClient.js';
import { stemdeckReadout } from './stemdeck/stemdeckTool.js';
import { bulkExportReadout } from './bulkExport/bulkExportTool.js';
import { missingTabsReadout } from './bulkFill/missingTabsTool.js';
import { bulkImportReadout } from './bulkImport/bulkImportTool.js';

let activeView = 'library'; // 'library', 'recents', 'openFile', 'setlists', 'tools', 'settings'
let activeCollectionId = DEFAULT_COLLECTION_ID;
let libraryBrowseMode = 'artists'; // 'artists' | 'tunings'
let activeLibraryPane = 'list'; // 'list' | 'songs'
let selectedArtist = null;
// The Pinned songs group at the top of the artist list: true when picked, false when an artist was, null for the default
let pinnedGroupSelected = null; // 'recents' when the Recents group is picked
let selectedAlbum = null;
// Library search text, kept across the re-renders that picking an artist triggers
let libraryFilterQuery = '';
let selectedAlbumFilter = 'all';
let selectedFolderPath = []; // Array of folder path segments e.g. ['Exercises', 'Technique']
let selectedTuning = null;
let tuningsArtistFilter = ''; // artist name limiting the Tunings view, '' for all
let isAlbumEditMode = false;
let isRecentsEditMode = false;
let searchSubView = null; // null | { type: 'tracks', releaseGroupMbid, fromView: 'library' }
let viewHistory = [];

function formatTrackDuration(duration) {
    if (!duration || duration <= 0) return '';
    let totalSecs = Number(duration);
    if (isNaN(totalSecs) || totalSecs <= 0) return '';
    if (totalSecs > 10000) {
        totalSecs = Math.round(totalSecs / 1000);
    }
    const mins = Math.floor(totalSecs / 60);
    const secs = Math.floor(totalSecs % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

let topBarInitialized = false;
let currentArtistAlbumsViewHandler = null;

function initLibraryTopBar() {
    if (topBarInitialized) return;
    topBarInitialized = true;

    window.addEventListener('libraryDataChanged', () => {
        // The Tools page shows no library data, and drawing it again would close the tool that caused the change
        // (an import, a tab saved from the web search walk)
        if (isLibraryOpen() && activeView !== 'tools') {
            renderLibraryModal();
        }
    });
}

let currentExploreTracklistToken = 0;
let currentExploreArtistToken = 0;

/**
 * Check if the library page can go back to a parent view
 */
let forwardHistory = [];

// Scroll offsets per library view, restored when navigating back or forward
const libraryScrollPositions = new Map();
let libraryScrollKey = null;
let restoreLibraryScroll = false;

function currentLibraryScrollKey() {
    return JSON.stringify([
        activeView, libraryBrowseMode, selectedArtist?.name || '', selectedAlbum?.title || selectedAlbum?.name || '',
        selectedFolderPath, selectedTuning?.key || ''
    ]);
}

export function captureCurrentLibraryState() {
    return {
        view: activeView,
        libraryBrowseMode,
        activeLibraryPane,
        selectedArtist,
        selectedAlbum,
        selectedAlbumFilter,
        selectedFolderPath: [...selectedFolderPath],
        selectedTuning,
        isAlbumEditMode,
        searchSubView: searchSubView ? { ...searchSubView } : null
    };
}

export function pushLibraryNavigationState() {
    viewHistory.push(captureCurrentLibraryState());
    forwardHistory = [];
}

export function canGoBack() {
    if (searchSubView) return true;
    if (activeView === 'library') {
        if (libraryBrowseMode === 'tunings') return activeLibraryPane === 'songs';
        if (selectedFolderPath.length > 0) return true;
        if (selectedAlbum) return true;
        if (window.innerWidth < 1000) {
            if (activeLibraryPane === 'songs') return true;
        } else {
            if (selectedArtist) return true;
        }
    }
    return viewHistory.length > 0;
}

export function canGoForward() {
    return forwardHistory.length > 0;
}

export async function restoreLibraryState(state) {
    if (!state) return;
    activeView = state.view || 'library';
    libraryBrowseMode = state.libraryBrowseMode || 'artists';
    selectedArtist = state.selectedArtist || null;
    pinnedGroupSelected = state.selectedArtist ? false : null;
    selectedAlbum = state.selectedAlbum || null;
    selectedAlbumFilter = state.selectedAlbumFilter || 'all';
    selectedFolderPath = state.selectedFolderPath ? [...state.selectedFolderPath] : [];
    selectedTuning = state.selectedTuning || null;
    isAlbumEditMode = false;
    searchSubView = state.searchSubView || null;
    await renderLibraryModal();
}

export async function handleForward() {
    if (forwardHistory.length === 0) return false;
    const currentState = captureCurrentLibraryState();
    const nextState = forwardHistory.pop();
    viewHistory.push(currentState);
    restoreLibraryScroll = true;
    await restoreLibraryState(nextState);
    return true;
}

/**
 * Unified back handler for library page (used by in-view back buttons & shortcuts)
 */
export async function handleBack() {
    if (!canGoBack()) return false;
    const currentState = captureCurrentLibraryState();
    const content = document.getElementById('libraryModalContent');
    restoreLibraryScroll = true;

    const executeBack = async () => {
        if (searchSubView && searchSubView.type === 'artist-albums') {
            searchSubView = null;
            const filterInput = document.querySelector('#libFilterInput');
            if (filterInput) filterInput.dispatchEvent(new Event('input'));
            else await renderLibraryModal();
            return true;
        }
        if (searchSubView && searchSubView.type === 'tracks' && searchSubView.parentArtistMbid) {
            const pMbid = searchSubView.parentArtistMbid;
            const pName = searchSubView.parentArtistName;
            searchSubView = null;
            const filterResults = document.querySelector('#libFilteredSearchResults') || document.querySelector('#libraryModalContent');
            if (filterResults && currentArtistAlbumsViewHandler) {
                await currentArtistAlbumsViewHandler(pMbid, pName, filterResults, libraryFilterQuery);
                return true;
            }
        }
        if (searchSubView && searchSubView.fromView === 'library') {
            searchSubView = null;
            if (viewHistory.length > 0) {
                const prev = viewHistory.pop();
                activeView = prev.view || 'library';
                libraryBrowseMode = prev.libraryBrowseMode || 'artists';
                selectedArtist = prev.selectedArtist || null;
                pinnedGroupSelected = prev.selectedArtist ? false : null;
                selectedAlbum = prev.selectedAlbum || null;
                selectedAlbumFilter = prev.selectedAlbumFilter || 'all';
                selectedFolderPath = prev.selectedFolderPath || [];
                selectedTuning = prev.selectedTuning || null;
                isAlbumEditMode = false;
                await renderLibraryModal();
                return true;
            } else {
                await renderLibraryModal();
                return true;
            }
        }
        if (activeView === 'library') {
            if (libraryBrowseMode === 'tunings') {
                if (activeLibraryPane === 'songs') {
                    activeLibraryPane = 'list';
                    await renderView();
                    return true;
                }
            }
            if (selectedFolderPath.length > 0) {
                const poppedFolder = selectedFolderPath.pop();
                selectedAlbum = (selectedFolderPath.length > 0 && selectedArtist?.albums)
                    ? (selectedArtist.albums.find(a => (a.folderPath || a.title) === selectedFolderPath.join('/')) || null)
                    : null;
                isAlbumEditMode = false;
                await renderView();
                if (poppedFolder) {
                    const card = Array.from(document.querySelectorAll('#libraryModalContent .album-card')).find(el => el.dataset.albumTitle === poppedFolder || el.dataset.folderName === poppedFolder);
                    if (card) gamepadManager.setNavFocus(card);
                }
                return true;
            }
            if (selectedAlbum) {
                const prevAlbumTitle = currentState.selectedAlbum?.title || currentState.selectedAlbum?.name || '';
                selectedAlbum = null;
                isAlbumEditMode = false;
                await renderView();
                if (prevAlbumTitle) {
                    const card = Array.from(document.querySelectorAll('#libraryModalContent .album-card')).find(el => el.dataset.albumTitle === prevAlbumTitle);
                    if (card) gamepadManager.setNavFocus(card);
                }
                return true;
            }
            if (selectedArtist && (window.innerWidth >= 1000 || activeLibraryPane === 'songs')) {
                const prevArtistName = currentState.selectedArtist?.name || '';
                selectedArtist = null;
                selectedFolderPath = [];
                isAlbumEditMode = false;
                activeLibraryPane = 'list';
                await renderView();
                if (prevArtistName) {
                    const card = Array.from(document.querySelectorAll('#libraryModalContent .artist-card')).find(el => el.dataset.artistName === prevArtistName);
                    if (card) gamepadManager.setNavFocus(card);
                }
                return true;
            }
            if (viewHistory.length > 0) {
                const prev = viewHistory.pop();
                activeView = prev.view || 'library';
                libraryBrowseMode = prev.libraryBrowseMode || 'artists';
                activeLibraryPane = prev.activeLibraryPane || 'list';
                selectedArtist = prev.selectedArtist || null;
                pinnedGroupSelected = prev.selectedArtist ? false : null;
                selectedAlbum = prev.selectedAlbum || null;
                selectedAlbumFilter = prev.selectedAlbumFilter || 'all';
                selectedFolderPath = prev.selectedFolderPath || [];
                selectedTuning = prev.selectedTuning || null;
                isAlbumEditMode = false;
                searchSubView = prev.searchSubView || null;
                await renderLibraryModal();
                return true;
            }
            if (libraryBrowseMode === 'tunings') {
                libraryBrowseMode = 'artists';
                await renderView();
                return true;
            }
        } else if (activeView === 'recents' || activeView === 'openFile' || activeView === 'setlists' || activeView === 'tools' || activeView === 'settings') {
            if (viewHistory.length > 0) {
                const prev = viewHistory.pop();
                activeView = prev.view || 'library';
                selectedArtist = prev.selectedArtist || null;
                pinnedGroupSelected = prev.selectedArtist ? false : null;
                selectedAlbum = prev.selectedAlbum || null;
                searchSubView = prev.searchSubView || null;
                await renderLibraryModal();
                return true;
            } else {
                await switchView('library', false);
                return true;
            }
        }
        return false;
    };

    const didBack = await executeBack();
    restoreLibraryScroll = false;
    if (didBack) {
        forwardHistory.push(currentState);
        return true;
    }
    return false;
}

if (typeof window !== 'undefined') {
    window.__majesticLibraryBack = handleBack;
    window.__majesticLibraryForward = handleForward;
    window.__majesticLibraryCanGoBack = canGoBack;
    window.__majesticLibraryCanGoForward = canGoForward;
}

function updateBackBtnVisibility() {
    // Navigation is now handled by in-view back buttons and breadcrumbs
}

/**
 * Check if the library page is currently visible
 */
export function isLibraryOpen() {
    const page = document.getElementById('libraryPage');
    return page && page.style.display !== 'none';
}

export function getActiveLibraryView() {
    return activeView;
}

let libraryTouchBlurInitialized = false;

function blurActiveLibraryElement(page, onlyNonInputs = false) {
    const active = document.activeElement;
    if (!active || typeof active.blur !== 'function') return;
    if (page && (page.contains(active) || active.closest?.('.library-card, .library-row-card, .library-song-row, .library-track-row, .library-pinned-card, .tab-row, .library-page-view'))) {
        if (onlyNonInputs) {
            const isInput = active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT';
            if (isInput) return;
        }
        active.blur();
    }
}

function setupLibraryTouchListeners(page) {
    if (!page || libraryTouchBlurInitialized) return;
    libraryTouchBlurInitialized = true;

    let isTouchScrolling = false;

    page.addEventListener('touchstart', () => {
        isTouchScrolling = false;
    }, { passive: true });

    page.addEventListener('touchmove', () => {
        isTouchScrolling = true;
        blurActiveLibraryElement(page);
    }, { passive: true });

    page.addEventListener('touchend', () => {
        if (isTouchScrolling) {
            blurActiveLibraryElement(page);
            setTimeout(() => blurActiveLibraryElement(page), 50);
        } else {
            blurActiveLibraryElement(page, true);
            setTimeout(() => blurActiveLibraryElement(page, true), 50);
        }
        isTouchScrolling = false;
    }, { passive: true });

    page.addEventListener('touchcancel', () => {
        isTouchScrolling = false;
    }, { passive: true });
}

/**
 * Open the Tab Library Page
 */
export async function openLibraryModal(initialView = 'library') {
    // Web Jam guests only follow the host's tab
    if (document.documentElement.classList.contains('jam-web-guest')) return;
    // Leaving a tab keeps where you were in it, for Resume
    import('./gpProcessor/gpPlayer.js').then((m) => m.savePlaybackPosition(true)).catch(() => {});
    // Going back to the library stops whatever song is playing
    pauseSynthPlayer();
    pauseYouTube();
    initLibraryTopBar();
    // 'tunings' is the Tunings tab of the library view
    const wantTunings = initialView === 'tunings';
    if (wantTunings) {
        initialView = 'library';
        libraryBrowseMode = 'tunings';
        selectedArtist = null;
        selectedAlbum = null;
        selectedFolderPath = [];
        selectedTuning = null;
        activeLibraryPane = 'list';
    }
    if (initialView !== activeView) {
        viewHistory = [];
    }
    activeView = initialView;
    updateUrl(wantTunings ? 'tunings' : initialView.toLowerCase(), null, false);

    let page = document.getElementById('libraryPage');
    if (!page) {
        page = createLibraryPageElement();
    }
    setupLibraryTouchListeners(page);

    const mainContent = document.getElementById('mainContent');
    if (mainContent) mainContent.style.display = 'none';

    // Update top bar for Library Mode
    const modeButtons = document.getElementById('modeButtons');
    const globalAudio = document.getElementById('globalAudioControls');
    const audioSourcePill = document.getElementById('audioSourcePill');
    const navButtons = document.getElementById('navButtons');
    const brandText = document.getElementById('brand-text');
    const songBreadcrumb = document.getElementById('songBreadcrumb');

    if (modeButtons) modeButtons.style.display = 'none';
    if (globalAudio) globalAudio.style.display = 'none';
    if (audioSourcePill) audioSourcePill.style.display = 'none';
    if (navButtons) navButtons.style.display = 'none';
    if (songBreadcrumb) songBreadcrumb.style.display = 'none';
    if (brandText) brandText.style.display = '';

    const mobileDock = document.getElementById('mobilePlaybackDock');
    if (mobileDock) mobileDock.style.display = 'none';
    document.body.classList.add('library-view-active');
    closeAllReaderPanels();

    // Hide the fretboard in the library without clearing the saved open preference
    try {
        fretboardController?.setScoreAvailable(false);
    } catch (_) {}


    page.style.display = 'flex';
    await renderLibraryModal();
}

/**
 * Close the Tab Library Page and return to tab viewer if a file is loaded
 */
export function closeLibraryModal(force = false) {
    const page = document.getElementById('libraryPage');
    const currentOpen = getCurrentFile();

    if (force === true || currentOpen) {
        releaseEmbeddedTools(true);
        parkSettingsPage();
        if (page) page.style.display = 'none';
        // Drop the hidden library's DOM: covers still loading (or retrying 500s from the art server) are cancelled, and
        // nothing keeps requesting art while a tab is open. Opening the library renders it again.
        document.getElementById('libraryModalContent')?.replaceChildren();
        clearUrl();
        const mainContent = document.getElementById('mainContent');
        if (mainContent) mainContent.style.display = '';

        // Restore top bar for Song Mode
        const modeButtons = document.getElementById('modeButtons');
        const navButtons = document.getElementById('navButtons');
        const brandText = document.getElementById('brand-text');
        const songBreadcrumb = document.getElementById('songBreadcrumb');
        const songTitleEl = document.getElementById('topBarSongTitle');

        if (modeButtons) modeButtons.style.display = currentOpen ? 'flex' : 'none';

        // The library hid the fretboard; coming back to a Guitar Pro song brings it back
        try {
            if (currentOpen && fretboardController?.currentApi?.score && scoreOptionsState.isAvailable) fretboardController.setScoreAvailable(true);
        } catch (_) {}

        if (currentOpen) {
            if (brandText) brandText.style.display = 'none';
            if (songBreadcrumb) songBreadcrumb.style.display = 'inline-flex';
            if (songTitleEl) {
                const displayName = currentOpen.songTitle || currentOpen.librarySongTitle || (currentOpen.name ? currentOpen.name.replace(/\.[^/.]+$/, '') : '');
                songTitleEl.textContent = displayName;
                songTitleEl.title = displayName || currentOpen.name || '';
                const songTitleBtn = document.getElementById('topBarSongTitleBtn');
                if (songTitleBtn) {
                    if (scoreOptionsState.isAvailable) {
                        songTitleBtn.title = displayName ? `${displayName} - Notation Options` : 'Notation Options';
                    } else {
                        songTitleBtn.title = displayName || '';
                    }
                }
            }
        } else {
            if (brandText) brandText.style.display = 'inline-flex';
            if (songBreadcrumb) songBreadcrumb.style.display = 'none';
        }

        document.body.classList.remove('library-view-active');

        if (navButtons && currentOpen) {
            navButtons.style.display = 'flex';
        }

        updateGlobalAudioControls();
    }
}

/**
 * Navigate directly to an album inside the library
 */
export async function navigateToAlbumInLibrary(artistName, albumTitle) {
    await openLibraryModal('library');
    libraryBrowseMode = 'artists';
    activeView = 'library';
    const hierarchy = await getLibraryHierarchy(activeCollectionId);
    const targetArtist = (hierarchy.artists || []).find(a => cleanTrackTitleForMatching(a.name) === cleanTrackTitleForMatching(artistName));
    if (targetArtist) {
        selectedArtist = targetArtist;
        const targetAlbum = (targetArtist.albums || []).find(al => cleanTrackTitleForMatching(al.title || al.name) === cleanTrackTitleForMatching(albumTitle));
        selectedAlbum = targetAlbum || null;
        selectedFolderPath = selectedAlbum ? (selectedAlbum.folderPath && selectedAlbum.isCustom ? selectedAlbum.folderPath.split('/') : [selectedAlbum.title || selectedAlbum.name]) : [];
    } else {
        selectedArtist = null;
        selectedAlbum = null;
        selectedFolderPath = [];
    }
    isAlbumEditMode = false;
    activeLibraryPane = 'songs';
    const container = document.getElementById('libraryPage');
    if (container) {
        await renderLibraryBrowseView(container);
    }
}

/**
 * Handle 1-click single song fulfillment: creates library song shell and opens downloader pre-targeted
 */
export async function handleGetTabSingleSong(songItem) {
    if (!songItem) return;
    const title = songItem.title || '';
    const artist = songItem.artist || '';

    // Check if song already exists in library
    let targetSong = songItem.id ? await getSongById(songItem.id) : null;
    if (!targetSong) {
        const hierarchy = await getLibraryHierarchy(activeCollectionId);
        for (const art of hierarchy.artists || []) {
            if (cleanTrackTitleForMatching(art.name) === cleanTrackTitleForMatching(artist)) {
                for (const s of art.songs || []) {
                    if (cleanTrackTitleForMatching(s.title) === cleanTrackTitleForMatching(title)) {
                        targetSong = s;
                        break;
                    }
                }
                if (!targetSong) {
                    for (const alb of art.albums || []) {
                        for (const s of alb.songs || []) {
                            if (cleanTrackTitleForMatching(s.title) === cleanTrackTitleForMatching(title)) {
                                targetSong = s;
                                break;
                            }
                        }
                        if (targetSong) break;
                    }
                }
            }
            if (targetSong) break;
        }
    }

    if (!targetSong) {
        targetSong = await saveSongToLibrary({
            title,
            artist,
            album: songItem.album || '',
            collectionId: activeCollectionId,
            recordingMbid: songItem.recordingMbid || songItem.id || '',
            artistMbid: songItem.artistMbid || '',
            coverUrl: songItem.coverUrl || null,
            year: songItem.year || null,
            length: songItem.length || null
        });
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
    }

    if (isNative()) {
        const query = `${artist} ${title}`;
        await openTabDownloader({
            targetSong,
            artist,
            songName: title,
            query,
            autoOpenOnDownload: true
        });
    } else {
        const query = `${artist} ${title} guitar tab`;
        window.open(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, '_blank');
        showToast('Waiting for downloaded tab — drop it here when finished', 'info');
    }
}

/**
 * Handle Guided Batch Tab Assistant for albums:
 * Pre-flights library for existing tabs, builds smart queue, launches downloader in batch mode
 */
export async function handleAddAlbumBatch(albumItem, btnEl) {
    if (!albumItem) return;
    const albumTitle = albumItem.title || albumItem.name || '';
    const artistName = albumItem.artist || albumItem.artistName || '';

    if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = 'Preparing...';
    }

    try {
        const hierarchy = await getLibraryHierarchy(activeCollectionId);
        let artistObj = (hierarchy.artists || []).find(a => cleanTrackTitleForMatching(a.name) === cleanTrackTitleForMatching(artistName));
        let albumObj = artistObj?.albums?.find(al => cleanTrackTitleForMatching(al.title || al.name) === cleanTrackTitleForMatching(albumTitle));

        // If album does not exist in library, fetch tracks and add album
        if (!albumObj) {
            let albumData = null;
            const releaseGroupMbid = albumItem.id || albumItem.releaseGroupMbid || albumItem.albumMbid;
            if (releaseGroupMbid) {
                try {
                    albumData = await getAlbumTracks(releaseGroupMbid);
                } catch (e) {
                    console.warn('[Batch Assistant] Failed to fetch album tracks from MusicBrainz:', e);
                }
            }
            await addAlbumToLibrary({
                title: albumTitle,
                artist: artistName,
                artistMbid: albumData?.artistMbid || albumItem.artistMbid || null,
                releaseGroupId: releaseGroupMbid || albumData?.releaseGroupId || '',
                releaseId: albumData?.releaseId || null,
                year: albumData?.year || albumItem.year || null,
                coverUrl: albumData?.coverUrl || albumItem.coverUrl || null
            }, albumData?.tracks || [], activeCollectionId);
            window.dispatchEvent(new CustomEvent('libraryDataChanged'));
            const updatedHierarchy = await getLibraryHierarchy(activeCollectionId);
            artistObj = (updatedHierarchy.artists || []).find(a => cleanTrackTitleForMatching(a.name) === cleanTrackTitleForMatching(artistName));
            albumObj = artistObj?.albums?.find(al => cleanTrackTitleForMatching(al.title || al.name) === cleanTrackTitleForMatching(albumTitle));
        }

        const albumTracks = albumObj?.songs || [];
        if (albumTracks.length === 0) {
            showToast(`No tracks found for album "${albumTitle}"`, 'warning');
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.textContent = 'Add album';
            }
            return;
        }

        // Pre-flight library scan: match against existing artist songs with tabs
        const existingArtistSongs = [
            ...(artistObj?.songs || []),
            ...(artistObj?.albums || []).flatMap(al => al.songs || [])
        ];

        const queue = albumTracks.map((track, idx) => {
            const cleanTitle = cleanTrackTitleForMatching(track.title);
            let hasTab = songHasTabs(track);
            let alreadyInLib = false;
            let fileName = track.tabOptions?.[0]?.name || null;

            if (!hasTab) {
                const matchSong = existingArtistSongs.find(s => s.id !== track.id && cleanTrackTitleForMatching(s.title) === cleanTitle && songHasTabs(s));
                if (matchSong && matchSong.tabOptions?.[0]) {
                    hasTab = true;
                    alreadyInLib = true;
                    fileName = matchSong.tabOptions[0].name;
                    addTabOptionToSong(track.id, matchSong.tabOptions[0]).catch(() => {});
                }
            } else {
                alreadyInLib = true;
            }

            return {
                trackNumber: track.trackNumber || (idx + 1),
                title: track.title,
                artist: artistName,
                songId: track.id,
                acquired: Boolean(hasTab),
                alreadyInLibrary: Boolean(alreadyInLib),
                fileName
            };
        });

        const unacquiredCount = queue.filter(t => !t.acquired).length;
        if (unacquiredCount === 0) {
            showToast(`All ${queue.length} tracks already in library with tabs`, 'info');
            await navigateToAlbumInLibrary(artistName, albumTitle);
            return;
        }

        if (!isNative()) {
            showToast('Batch tab downloading requires the MajesticTab desktop or mobile app. On the web, you can add songs individually or drop tab files.', 'warning');
            await navigateToAlbumInLibrary(artistName, albumTitle);
            return;
        }

        const firstMissingIdx = queue.findIndex(t => !t.acquired);
        await openTabDownloader({
            batchMode: true,
            albumTitle,
            artistName,
            albumId: albumObj?.id || null,
            queue,
            currentIndex: firstMissingIdx >= 0 ? firstMissingIdx : 0
        });
    } catch (err) {
        console.error('[Batch Assistant] Error preparing batch download:', err);
        showToast('Error preparing album batch download', 'error');
        if (btnEl) {
            btnEl.disabled = false;
            btnEl.textContent = 'Add album';
        }
    }
}

// Expose closeLibraryModal on window for automation/tests
if (typeof window !== 'undefined') {
    window.closeLibraryModal = closeLibraryModal;
    // Back, forward and the gamepad menu button go back to the open song from the library
    window.returnToOpenSong = () => {
        if (!getCurrentFile()) return false;
        closeLibraryModal(false);
        return true;
    };
    window.openLibraryModal = openLibraryModal;
}

/**
 * Create DOM element for Library Page if needed
 */
function createLibraryPageElement() {
    let page = document.getElementById('libraryPage');
    if (!page) {
        page = document.createElement('div');
        page.id = 'libraryPage';
        page.className = 'library-page-view';
        const mainContent = document.getElementById('mainContent');
        if (mainContent && mainContent.parentNode) {
            mainContent.parentNode.insertBefore(page, mainContent);
        } else {
            document.body.appendChild(page);
        }
    }
    setupLibraryTouchListeners(page);
    return page;
}

/**
 * Main render function for Tab Library Page
 */
export async function renderLibraryModal() {
    initLibraryTopBar();
    const page = document.getElementById('libraryPage') || createLibraryPageElement();
    if (!page) return;
    if (!page.dataset.tabNavBound) {
        page.dataset.tabNavBound = '1';
        page.addEventListener('click', (e) => {
            const tab = e.target.closest('[data-lib-tab]');
            if (tab) goLibraryTab(tab.dataset.libTab);
        });
    }

    const collections = await getCollections();
    const currentCollection = collections.find(c => c.id === activeCollectionId) || collections[0] || { id: DEFAULT_COLLECTION_ID, name: 'My Library' };
    activeCollectionId = currentCollection.id;

    updateBackBtnVisibility();

    // Ensure content container is present
    let content = document.getElementById('libraryModalContent');
    if (!content) {
        page.innerHTML = `<div class="library-page-body" id="libraryModalContent"></div>`;
        content = document.getElementById('libraryModalContent');
    }

    await renderView();
}

export async function switchLibraryView(view, pushHistory = true) {
    await switchView(view, pushHistory);
}

async function switchView(view, pushHistory = true) {
    if (pushHistory && activeView !== view) {
        pushLibraryNavigationState();
    }
    activeView = view;
    activeLibraryPane = 'list';
    updateUrl(view.toLowerCase());
    await renderLibraryModal();
}

function clearCardInteractionState(card) {
    if (!card) return;
    card.style.boxShadow = 'none';
    card.style.transform = 'none';
    card.blur();
}

async function renderView() {
    const content = document.getElementById('libraryModalContent');
    if (!content) return;
    const restoring = restoreLibraryScroll;
    restoreLibraryScroll = false;
    const nextKey = currentLibraryScrollKey();
    if (libraryScrollKey !== null && libraryScrollKey !== nextKey) {
        libraryScrollPositions.set(libraryScrollKey, content.scrollTop);
    }
    libraryScrollKey = nextKey;
    const savedScroll = restoring ? libraryScrollPositions.get(nextKey) : 0;
    content.scrollTop = 0;
    blurActiveLibraryElement(content);
    syncLibraryBottomNav();
    try {
        await renderViewContent(content);
    } finally {
        if (savedScroll) content.scrollTop = savedScroll;
    }
}

async function renderViewContent(content) {
    if (activeView !== 'tools') { releaseEmbeddedTools(); forgetResume(); }
    // Settings is a view like Tools. Its page is built once and moved in here, so it is parked before anything else draws
    parkSettingsPage();
    if (activeView === 'settings') {
        mountSettingsPage(content);
        return;
    }
    if (activeView === 'library') {
        await renderLibraryBrowseView(content);
    } else if (activeView === 'recents') {
        // Recents is a group in the library list now; the old route opens it there
        activeView = 'library';
        libraryBrowseMode = 'artists';
        pinnedGroupSelected = 'recents';
        activeLibraryPane = 'songs';
        await renderLibraryBrowseView(content);
    } else if (activeView === 'tools') {
        renderToolsView(content);
    } else if (activeView === 'setlists') {
        await renderSetlistsView(content, { onBack: () => switchView('library') });
    } else if (activeView === 'openFile') {
        renderOpenFileView(content, {
            onBack: () => switchView('library'),
        });
    }
}

function renderMiniBarRulerHtml(currentBar, totalBars) {
    const total = Math.max(1, Number(totalBars) || 32);
    const cur = Math.max(1, Math.min(Number(currentBar) || 1, total));
    const ratio = Math.max(0, Math.min(1, (cur - 0.5) / total));
    const pct = (ratio * 100).toFixed(1);
    const W = 1000;
    const H = 28;
    let ticks = '';
    for (let i = 0; i < total; i++) {
        const x = (((i + 0.5) / total) * W).toFixed(1);
        const maj = i === 0 || (i + 1) % 10 === 0;
        ticks += `<line x1="${x}" x2="${x}" y1="${maj ? 10 : 17}" y2="28"/>`;
    }
    return `
    <div class="ruler mini" data-ruler aria-hidden="true">
      <div class="fill-clip"><div class="fill" style="transform: scaleX(${ratio});"></div></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${ticks}</svg>
      <div class="head" style="left: ${pct}%;"></div>
    </div>`;
}

// // -----------------------------------------------------------------------------
// 1. LIBRARY BROWSER VIEW (Collection > Artist > Album > Song / Tunings)
// -----------------------------------------------------------------------------
async function renderLibraryBrowseView(container) {
    if (container) {
        container.scrollTop = 0;
        blurActiveLibraryElement(container);
    }
    syncLibraryBottomNav();
    const collections = await getCollections();
    const currentCollection = collections.find(c => c.id === activeCollectionId) || collections[0] || { id: DEFAULT_COLLECTION_ID, name: 'My Library' };
    activeCollectionId = currentCollection.id;

    const hierarchy = await getLibraryHierarchy(activeCollectionId);
    let artists = hierarchy.artists || [];
    let pinnedSongs = hierarchy.pinnedSongs || [];

    if (isHideNoTabSongsEnabled()) {
        pinnedSongs = pinnedSongs.filter(songHasTabs);
        hierarchy.pinnedSongs = pinnedSongs;
        artists = artists.map(art => ({
            ...art,
            songs: (art.songs || []).filter(songHasTabs),
            albums: (art.albums || []).map(alb => ({
                ...alb,
                songs: (alb.songs || []).filter(songHasTabs)
            }))
        }));
        hierarchy.artists = artists;
    }

    // Re-sync selectedArtist and selectedAlbum against latest hierarchy data
    if (selectedArtist) {
        selectedArtist = artists.find(a => a.name === selectedArtist.name || (selectedArtist.artistMbid && a.artistMbid === selectedArtist.artistMbid)) || null;
    }
    if (selectedAlbum && selectedArtist) {
        selectedAlbum = selectedArtist.albums.find(a => a.title === selectedAlbum.title || (selectedAlbum.albumMbid && a.albumMbid === selectedAlbum.albumMbid)) || null;
    }

    // Top Library Body Toolbar (Collection Selector + Mode Selector + Universal Search/Filter + Add Music)
    const inTunings = libraryBrowseMode === 'tunings';
    const collectionSelectOnlyHtml = collections.length > 1 ? `<div class="collection-pill-group">
        <select class="theme-select collection-select-input" id="libCollectionSelect" title="Select Collection" aria-label="Select Collection">
          ${collections.map(c => `<option value="${c.id}" ${c.id === activeCollectionId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>` : '';
    const groupByRowHtml = (extraHtml = '') => artists.length === 0 ? '' : `<div class="lib-groupby-row"><div class="hud-pill-group lib-groupby" role="group" aria-label="Group by">
        <button type="button" class="btn btn-sm ${inTunings ? '' : 'active'}" data-lib-groupby="artists" aria-pressed="${!inTunings}">Artists</button>
        <button type="button" class="btn btn-sm ${inTunings ? 'active' : ''}" data-lib-groupby="tunings" aria-pressed="${inTunings}">Tunings</button>
      </div>${extraHtml}</div>`;
    const collectionSelectHtml = collectionSelectOnlyHtml;
    const headerHtml = `
    <div class="library-page-container ${inTunings ? 'tunings-view' : ''}">
      ${libraryHeaderHtml({
        activeTab: 'library',
        searchId: 'libFilterInput',
        clearId: 'libFilterClearBtn',
        placeholder: 'Search your library',
        searchLabel: 'Search library'
    })}
    `;

    if (artists.length === 0) {
        container.innerHTML = headerHtml + libraryListToolbarHtml({ leftHtml: collectionSelectHtml }) + `
          <div id="libBrowseContent">
          ${libraryEmptyStateHtml({
            icon: 'bi-music-note-list',
            title: 'This collection is empty',
            message: 'Add your favorite songs and albums to build your personalized tab catalog, or link existing files from your device.',
            actionsHtml: `<button class="btn btn-theme-primary btn-sm px-4" id="emptyStateSearchBtn">Search the catalog and web</button>
              <button class="btn btn-sm lib-ghost-action" id="emptyStateOpenFileBtn">Link existing files</button>
              <button class="btn btn-sm lib-ghost-action" id="emptyStateRestoreBtn">Restore backup</button>`
          })}
          </div>
          <div id="libFilteredSearchResults" style="display: none;"></div>
        </div>
        `;

        bindLibraryToolbarEvents(container);
        // An empty library still searches the catalog and the web
        setupLibraryFilter(container, { hierarchy, artists: [], selectedArtist: null, selectedAlbum: null, selectedTuning: null, pinnedSongs: [] });
        container.querySelector('#emptyStateSearchBtn')?.addEventListener('click', () => {
            const input = container.querySelector('#libFilterInput');
            if (input) {
                // Say what to type: the field takes a song or artist and searches the catalog and the web
                input.placeholder = 'Type a song or artist';
                input.scrollIntoView({ block: 'nearest' });
                input.focus();
                input.select();
            }
        });
        container.querySelector('#emptyStateOpenFileBtn')?.addEventListener('click', () => switchView('openFile'));
        container.querySelector('#emptyStateRestoreBtn')?.addEventListener('click', async () => {
            try {
                const { openBackupModal } = await import('./backupRestore.js');
                await openBackupModal('restore');
            } catch (_) {
                switchView('settings');
            }
        });
        return;
    }

    let tuningArtistSelectHtml = '';
    let breadcrumbHtml = '';
    let bodyHtml = '';
    let toolbarHtml = '';
    // Library header toolbar actions (none: sync button removed, search bar stretches full width)
    const toolbarActionsHtml = '';

    // The resume card is the same whichever way the library is grouped
    let resumeHtml = '';
    try {
        const [last] = await getRecents(1);
        if (last) {
            const name = last.songTitle || last.name || 'Untitled';
            const lastBar = Number(last.lastBar) || 1;
            const totalBars = Number(last.totalBars) || 32;
            const subParts = [last.artist, last.album].filter(Boolean);
            const subText = subParts.length > 0 ? `${subParts.join(', ')}. ` : '';
            const rulerHtml = renderMiniBarRulerHtml(lastBar, totalBars);
            resumeHtml = `<div class="resume-card" id="libResumeCard">
              <img class="resume-cover" alt="" src="${getSynchronousCachedArtUrl(last.coverUrl) || last.coverUrl || getPlaceholderCoverSvg(last.artist || name)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(last.artist || name)}'">
              <div class="resume-meta">
                <h2 class="resume-title">${escapeHtml(name)}</h2>
                <div class="resume-sub tnum">${escapeHtml(subText)}Bar <span data-bar>${lastBar}</span> of ${totalBars}</div>
              </div>
              <button type="button" class="btn btn-theme-primary resume-btn" id="libResumeBtn">Resume</button>
              ${rulerHtml}
            </div>`;
        }
    } catch (_) { resumeHtml = ''; }

    // ==========================================
    // A. TUNINGS BROWSE MODE
    // ==========================================
    if (libraryBrowseMode === 'tunings') {
        const tuningsHierarchy = await getLibraryTuningsHierarchy(activeCollectionId);
        let allTuningGroups = tuningsHierarchy.tunings || [];
        if (isHideNoTabSongsEnabled()) {
            allTuningGroups = allTuningGroups
                .map(g => ({ ...g, songs: (g.songs || []).filter(songHasTabs) }))
                .filter(g => g.songs.length > 0);
        }
        const tuningArtists = Array.from(new Set(allTuningGroups.flatMap(g => g.songs.map(s => s.artist).filter(Boolean))))
            .sort((a, b) => a.localeCompare(b));
        if (tuningsArtistFilter && !tuningArtists.includes(tuningsArtistFilter)) tuningsArtistFilter = '';
        const tuningGroups = tuningsArtistFilter
            ? allTuningGroups
                .map(g => ({ ...g, songs: g.songs.filter(s => s.artist === tuningsArtistFilter) }))
                .filter(g => g.songs.length > 0)
            : allTuningGroups;
        if (tuningArtists.length > 0) {
            tuningArtistSelectHtml = `<div class="collection-pill-group">
        <select class="theme-select collection-select-input" id="libTuningArtistSelect" title="Filter by artist" aria-label="Filter by artist">
          <option value="">All artists</option>
          ${tuningArtists.map(a => `<option value="${escapeHtml(a)}" ${a === tuningsArtistFilter ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
        </select>
      </div>`;
        }

        if (tuningGroups.length === 0) {
            toolbarHtml = libraryListToolbarHtml({
                leftHtml: collectionSelectHtml,
                actionsHtml: toolbarActionsHtml,
                count: '0 tunings'
            });
            bodyHtml = `
            <div class="tunings-body">
              ${libraryEmptyStateHtml({
                icon: 'bi-sliders',
                title: 'No tunings yet',
                message: 'Add tab files with guitar or bass scores to see your songs categorized by tuning.',
                actionsHtml: '<button type="button" class="btn btn-sm lib-ghost-action" data-lib-tab="library">Go to Library</button>'
              })}
            </div>
            `;
        } else {
            if (selectedTuning && !tuningGroups.some(g => (g.key || g.tuning || g.name) === selectedTuning)) {
                selectedTuning = null;
            }
            if (!selectedTuning) {
                selectedTuning = tuningGroups[0]?.key || tuningGroups[0]?.tuning || tuningGroups[0]?.name;
            }
            const currentGroup = tuningGroups.find(g => (g.key || g.tuning || g.name) === selectedTuning) || tuningGroups[0];

            toolbarHtml = libraryListToolbarHtml({
                leftHtml: collectionSelectHtml,
                actionsHtml: toolbarActionsHtml,
                count: `${tuningGroups.length} ${tuningGroups.length === 1 ? 'tuning' : 'tunings'}`
            });

            const cardHtml = (group) => {
                const rawNotes = (group.notes || group.key || group.tuning || '').trim().split(/[\s,]+/);
                const notesList = rawNotes.map(n => n.replace(/\d+$/, '')).filter(Boolean);
                const notesDisplay = notesList.join(' ');
                const isCurrent = (group.key || group.tuning || group.name) === (currentGroup.key || currentGroup.tuning || currentGroup.name);
                return `
                <div class="library-card tuning-card p-3" data-tuning-key="${escapeHtml(group.key || group.tuning)}" data-tuning-name="${escapeHtml(group.name)}" data-tuning-notes="${escapeHtml(group.notes || group.key || group.tuning)}" data-name="${escapeHtml(String(group.name || '').toLowerCase())}" data-search="${escapeHtml([group.name, group.notes, group.key, group.tuning, ...group.songs.map(sg => `${sg.title || ''} ${sg.artist || ''} ${sg.album || ''}`)].filter(Boolean).join(' ').toLowerCase())}" ${isCurrent ? 'aria-current="true"' : ''} role="button" tabindex="0">
                  <div class="d-flex align-items-center gap-3 min-w-0">
                    <span class="pinned-group-glyph" aria-hidden="true">${renderTuningBarsSvg(group, 36)}</span>
                    <div class="min-w-0 flex-grow-1">
                      <h6 class="mb-1 fw-bold text-white text-truncate" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</h6>
                      <div class="small text-muted text-truncate tnum">${escapeHtml(notesDisplay)}${notesDisplay ? ' \u00b7 ' : ''}${group.songs.length} ${group.songs.length === 1 ? 'song' : 'songs'}</div>
                    </div>
                    <i class="bi-chevron-right text-muted flex-shrink-0"></i>
                  </div>
                </div>`;
            };

            const listPaneHtml = `
              <section class="pane list" aria-label="Tunings">
                ${groupByRowHtml(tuningArtistSelectHtml)}
                <h3 class="pane-head"><span>Tunings <span class="tnum">(${tuningGroups.length})</span></span></h3>
                <div class="pane-scroll">
                  <div class="library-artists-grid" id="libTuningsList">
                    ${tuningGroups.map(cardHtml).join('')}
                  </div>
                </div>
              </section>`;

            const rawNotes = (currentGroup.notes || currentGroup.key || currentGroup.tuning || '').trim().split(/[\s,]+/);
            const notesList = rawNotes.map(n => n.replace(/\d+$/, '')).filter(Boolean);
            const notesDisplay = notesList.join(' ');
            const summary = [notesDisplay, `${currentGroup.songs.length} ${currentGroup.songs.length === 1 ? 'song' : 'songs'}`].filter(Boolean).join(' \u00b7 ');

            const songsPaneHtml = `
              <section class="pane songs" aria-label="${escapeHtml(currentGroup.name)}">
                ${libraryPaneHeadHtml({
                    backLabel: 'Tunings',
                    backId: 'tuningsBackBtn',
                    countText: summary,
                    title: currentGroup.name
                })}
                <div class="tuning-actions">
                  <button class="btn btn-sm theme-control-btn edit-tuning-btn" data-tuning-key="${escapeHtml(currentGroup.key || currentGroup.tuning)}" title="Rename this tuning">Rename</button>
                </div>
                <div class="pane-scroll">
                  <div class="artist-detail-view">
                    <div class="library-songs-list d-flex flex-column gap-2" id="libSongsList">
                      ${currentGroup.songs.map(song => renderSongRow(song, { showArtistAlbum: true, showTrackNumber: false, showCover: true })).join('')}
                    </div>
                  </div>
                </div>
              </section>`;

            bodyHtml = `
            <div class="collection-root-view tunings-body">
              ${resumeHtml}
              <div class="panes" data-pane="${activeLibraryPane}">
                ${listPaneHtml}
                ${songsPaneHtml}
              </div>
            </div>`;
        }
    } else {
        // ==========================================
        // B. ARTISTS / ALBUMS / TRACKS / CUSTOM FOLDERS BROWSE MODE
        // ==========================================
        if (artists.length === 0) {
            bodyHtml = `
            ${libraryEmptyStateHtml({
              icon: 'bi-collection',
              title: 'Your library is empty',
              message: 'Add songs by importing local tab files or connecting Google Drive.'
            })}
            `;
            toolbarHtml = libraryListToolbarHtml({
                leftHtml: collectionSelectHtml,
                count: '0 artists',
                actionsHtml: toolbarActionsHtml
            });
        } else {
            // Keep selectedArtist in sync; default to first artist if not set
            const hadSelectedArtist = Boolean(selectedArtist);
            if (!selectedArtist || !artists.some(a => a.name === selectedArtist.name || (selectedArtist.artistMbid && a.artistMbid === selectedArtist.artistMbid))) {
                selectedArtist = artists[0];
            }

            const isCustomArtist = Boolean(selectedArtist.isCustom);
            const currentPath = selectedFolderPath.join('/');

            // Find immediate subfolders at currentPath
            const subfolderMap = new Map();
            for (const alb of selectedArtist.albums) {
                const fullFolder = (alb.folderPath || alb.title || '').trim();
                if (!fullFolder) continue;
                let rest = '';
                // MusicBrainz titles may contain "/" (e.g. "Closure / Continuation"); only custom folders nest
                if (!isCustomArtist) {
                    if (currentPath !== '') continue;
                    rest = fullFolder;
                } else if (currentPath === '') {
                    rest = fullFolder;
                } else if (fullFolder === currentPath) {
                    continue;
                } else if (fullFolder.startsWith(currentPath + '/')) {
                    rest = fullFolder.slice(currentPath.length + 1);
                } else {
                    continue;
                }
                const immediateName = isCustomArtist ? rest.split('/')[0] : rest;
                if (!immediateName) continue;
                const subPath = currentPath ? `${currentPath}/${immediateName}` : immediateName;
                if (!subfolderMap.has(immediateName)) {
                    subfolderMap.set(immediateName, {
                        name: immediateName,
                        path: subPath,
                        year: alb.year || null,
                        coverUrl: alb.coverUrl || null,
                        songsCount: 0,
                        booksCount: 0,
                        isCustom: isCustomArtist,
                        songs: []
                    });
                }
                const subEntry = subfolderMap.get(immediateName);
                subEntry.booksCount += alb.tabOptions ? alb.tabOptions.length : 0;
                subEntry.songsCount += alb.songs.length;
                subEntry.songs.push(...alb.songs);
            }
            const currentSubfolders = isCustomArtist ? Array.from(subfolderMap.values()) : [];

            // Find direct songs at currentPath
            let currentSongs = [];
            let matchingAlbum = null;
            if (currentPath === '') {
                if (!isCustomArtist) {
                    currentSongs = [
                        ...(selectedArtist.songs || []),
                        ...selectedArtist.albums.flatMap(a => (a.songs || []).map(s => ({ ...s, album: s.album || a.title })))
                    ];
                } else {
                    currentSongs = selectedArtist.songs || [];
                }
            } else {
                matchingAlbum = selectedArtist.albums.find(a => (a.folderPath || a.title) === currentPath) || null;
                if (matchingAlbum) {
                    currentSongs = matchingAlbum.songs || [];
                }
            }

            // Books in the current folder, including subfolders (custom music only)
            const currentBooks = (currentPath === '' ? (selectedArtist.rootBooks || 0) : 0) + selectedArtist.albums
                .filter(a => {
                    const f = (a.folderPath || a.title || '').trim();
                    return currentPath === '' || f === currentPath || f.startsWith(currentPath + '/');
                })
                .reduce((acc, a) => acc + (a.tabOptions ? a.tabOptions.length : 0), 0);
            // Check if standard MusicBrainz Album detail view
            const isStandardAlbumView = !isCustomArtist && selectedFolderPath.length === 1 && currentSubfolders.length === 0 && matchingAlbum;

            // BREADCRUMBS
            let breadcrumbsTrailHtml = `
                <button class="theme-breadcrumb-btn flex-shrink-0" id="bcRoot">
                    <i class="bi-collection"></i> <span>All Artists</span>
                </button>
                <i class="bi-chevron-right breadcrumb-separator flex-shrink-0"></i>
                <button class="theme-breadcrumb-btn ${selectedFolderPath.length === 0 ? 'active' : ''} text-truncate" id="bcArtist" title="${escapeHtml(selectedArtist.name)}" style="max-width: 240px;">
                    <span class="text-truncate">${escapeHtml(selectedArtist.name)}</span>
                </button>
            `;

            for (let i = 0; i < selectedFolderPath.length; i++) {
                const seg = selectedFolderPath[i];
                const isLast = (i === selectedFolderPath.length - 1);
                breadcrumbsTrailHtml += `
                    <i class="bi-chevron-right breadcrumb-separator flex-shrink-0"></i>
                    <button class="theme-breadcrumb-btn ${isLast ? 'active' : ''} text-truncate bc-folder-segment" data-segment-index="${i}" title="${escapeHtml(seg)}" style="max-width: 200px;">
                        <span class="text-truncate">${escapeHtml(seg)}</span>
                    </button>
                `;
            }

            const customTopLevel = isCustomArtist && selectedFolderPath.length === 0;
            breadcrumbHtml = customTopLevel ? '' : `
            <div class="library-sticky-breadcrumbs d-flex align-items-center justify-content-between gap-3 small mb-3">
              <div class="d-flex align-items-center gap-3 flex-wrap min-w-0">
                <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2 flex-shrink-0" id="libBrowseBackBtn" title="Back">
                  <i class="bi-arrow-left"></i> <span>Back</span>
                </button>
                <div class="library-breadcrumbs-trail d-flex align-items-center min-w-0">
                  ${breadcrumbsTrailHtml}
                </div>
              </div>
              <div class="d-flex align-items-center gap-2 flex-shrink-0">
                <span class="badge-theme-secondary d-none d-sm-inline-flex">
                  ${isCustomArtist
                    ? `${currentSubfolders.length > 0 ? `${formatCount(currentSubfolders.length, 'folder')} · ` : ''}${formatBooksSongsLabel(currentBooks, currentSongs.length + currentSubfolders.reduce((acc, f) => acc + f.songsCount, 0))}`
                  : currentSubfolders.length > 0 && currentSongs.length > 0
                    ? `${formatCount(currentSubfolders.length, 'folder')} · ${formatCount(currentSongs.length, 'song')}`
                    : currentSubfolders.length > 0
                      ? formatCount(currentSubfolders.length, 'album')
                      : formatCount(currentSongs.length, 'song')
                  }
                </span>
                ${(!isStandardAlbumView && (currentSongs.length > 0 || isCustomArtist)) ? `
                  <button class="btn btn-sm ${isAlbumEditMode ? 'btn-theme-primary' : 'btn-theme-outline'} py-1 px-3 d-inline-flex align-items-center gap-1 toggle-album-edit-btn" id="toggleAlbumEditBtn" title="${isAlbumEditMode ? 'Done editing' : 'Edit and delete songs'}">
                    <i class="bi-${isAlbumEditMode ? 'check-lg' : 'pencil'}"></i>
                    <span>${isAlbumEditMode ? 'Done' : 'Edit'}</span>
                  </button>
                ` : ''}
              </div>
            </div>
            `;

            let shelfHtml = '';
            let detailBodyHtml = '';

            if (!isCustomArtist) {
                const totalArtistSongs = (selectedArtist.songs?.length || 0) + selectedArtist.albums.reduce((acc, a) => acc + (a.songs?.length || 0), 0);

                // Fetch album tabs for all albums concurrently
                const albumTabsMap = new Map();
                if (selectedArtist.albums.length > 0) {
                    const tabsResults = await Promise.all(
                        selectedArtist.albums.map(a => getAlbumTabOptions(activeCollectionId, selectedArtist.name, a.title).catch(() => []))
                    );
                    selectedArtist.albums.forEach((a, i) => {
                        albumTabsMap.set(a.title, tabsResults[i] || []);
                    });
                }

                // If selectedAlbumFilter is set to an album that doesn't exist, reset to 'all'
                if (selectedAlbumFilter !== 'all' && selectedAlbumFilter !== 'other' && !selectedArtist.albums.some(a => a.title === selectedAlbumFilter)) {
                    selectedAlbumFilter = 'all';
                }

                // Build Discography Shelf if there are albums
                if (selectedArtist.albums.length > 0) {
                    shelfHtml = `
                    <div class="discography-shelf" role="tablist" aria-label="Discography filter">
                      <button type="button" class="shelf-item ${selectedAlbumFilter === 'all' ? 'active' : ''}" data-album-filter="all" role="tab" aria-selected="${selectedAlbumFilter === 'all'}" aria-label="All albums" title="All albums, ${totalArtistSongs} ${totalArtistSongs === 1 ? 'track' : 'tracks'}">
                        <div class="shelf-cover shelf-cover-all">
                          <i class="bi-collection-play"></i>
                        </div>
                        <div class="shelf-meta">
                          <div class="shelf-title">All Albums</div>
                          <div class="shelf-sub tnum">${selectedArtist.albums.length} ${selectedArtist.albums.length === 1 ? 'album' : 'albums'} · ${totalArtistSongs} ${totalArtistSongs === 1 ? 'track' : 'tracks'}</div>
                        </div>
                      </button>
                      ${selectedArtist.albums.map(alb => {
                        const coverSrc = getSynchronousCachedArtUrl(alb.coverUrl) || alb.coverUrl || getPlaceholderCoverSvg(alb.title);
                        const isSel = selectedAlbumFilter === alb.title;
                        return `
                        <button type="button" class="shelf-item ${isSel ? 'active' : ''}" data-album-filter="${escapeHtml(alb.title)}" role="tab" aria-selected="${isSel}" aria-label="${escapeHtml(alb.title)}" title="${escapeHtml(alb.title)}${alb.year ? `, ${alb.year}` : ''}">
                          <img src="${coverSrc}" class="shelf-cover" alt="" loading="lazy" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(alb.title)}'">
                          <div class="shelf-meta">
                            <div class="shelf-title" title="${escapeHtml(alb.title)}">${escapeHtml(alb.title)}</div>
                            <div class="shelf-sub tnum">${alb.year ? `${alb.year} · ` : ''}${alb.songs.length} ${alb.songs.length === 1 ? 'track' : 'tracks'}</div>
                          </div>
                        </button>
                        `;
                      }).join('')}
                    </div>
                    `;
                }

                const albumsToRender = selectedAlbumFilter === 'all'
                    ? selectedArtist.albums
                    : (selectedAlbumFilter === 'other' ? [] : selectedArtist.albums.filter(a => a.title === selectedAlbumFilter));

                const hasAnyAlbumTab = selectedArtist.albums.some(a => (albumTabsMap.get(a.title) || []).length > 0);
                const showArtistEmptyState = totalArtistSongs === 0 && isHideNoTabSongsEnabled() && !hasAnyAlbumTab && selectedAlbumFilter === 'all';

                const albumBlocksHtml = showArtistEmptyState ? '' : albumsToRender.map(alb => {
                    const coverSrc = getSynchronousCachedArtUrl(alb.coverUrl) || alb.coverUrl || getPlaceholderCoverSvg(alb.title);
                    const totalSecs = (alb.songs || []).reduce((acc, s) => acc + (typeof s.length === 'number' ? s.length : 0), 0);
                    const albumDurationText = totalSecs > 0 ? formatTrackDuration(totalSecs) : '';
                    const albTabs = albumTabsMap.get(alb.title) || [];
                    const hasAlbumTabs = albTabs.length > 0;

                    return `
                    <div class="album-block" data-album-name="${escapeHtml(alb.title)}">
                      <div class="album-header d-flex align-items-center justify-content-between gap-3">
                        <div class="d-flex align-items-center gap-3 min-w-0">
                          <img src="${coverSrc}" class="album-header-cover flex-shrink-0" alt="" loading="lazy" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(alb.title)}'">
                          <div class="min-w-0">
                            <h4 class="album-header-title text-truncate" title="${escapeHtml(alb.title)}">${escapeHtml(alb.title)}</h4>
                            <div class="album-header-sub tnum">
                              ${alb.year ? `<span>${alb.year}</span><span class="sep">·</span>` : ''}
                              <span>${alb.songs.length} ${alb.songs.length === 1 ? 'track' : 'tracks'}</span>
                              ${albumDurationText ? `<span class="sep">·</span><span>${albumDurationText}</span>` : ''}
                              ${albTabs.map(t => `<span class="sep">·</span><button type="button" class="play-album-tab-chip-btn album-book-link" data-album-title="${escapeHtml(alb.title)}" data-tab-id="${t.id}" title="Open book: ${escapeHtml(t.name)}">Open book</button>`).join('')}
                            </div>
                          </div>
                        </div>

                        <div class="album-header-actions d-flex align-items-center gap-2 flex-shrink-0">
                          ${alb.songs && alb.songs.some(s => !songHasTabs(s)) ? `
                            <button type="button" class="btn btn-sm btn-theme-primary batch-album-find-tabs-btn py-1 px-2 d-inline-flex align-items-center gap-1" data-album-title="${escapeHtml(alb.title)}" data-artist-name="${escapeHtml(selectedArtist.name)}" title="Find tabs for missing tracks in this album">
                              <span>Find tabs</span>
                            </button>
                          ` : ''}
                          <button type="button" class="btn btn-sm btn-theme-outline explore-album-tracklist-btn py-1 px-2 d-none d-sm-inline-flex align-items-center gap-1" data-album-title="${escapeHtml(alb.title)}" title="Explore complete album tracklist on MusicBrainz">
                            <span>Tracklist</span>
                          </button>
                          <div class="dropdown">
                            <button class="btn btn-sm btn-theme-outline py-1 px-2 dropdown-toggle d-flex align-items-center gap-1" type="button" data-bs-toggle="dropdown" data-bs-popper-config='{"strategy":"fixed"}' aria-expanded="false" title="Attach tab or book to album">
                              <span>Album tab</span>
                            </button>
                            <ul class="dropdown-menu dropdown-menu-end theme-dropdown-menu">
                              ${addTabProviderItemsHtml('import-album-tab-btn', `data-album-title="${escapeHtml(alb.title)}"`)}
                              ${isAlbumEditMode ? `
                                <li><hr class="dropdown-divider"></li>
                                <li><button class="dropdown-item small text-danger delete-album-btn" data-album-title="${escapeHtml(alb.title)}"><i class="bi-trash me-2"></i> Delete Album</button></li>
                              ` : ''}
                            </ul>
                          </div>
                          ${isAlbumEditMode ? `
                            <button type="button" class="btn btn-sm btn-theme-danger p-1 px-2 delete-album-btn" data-album-title="${escapeHtml(alb.title)}" title="Delete album from library">
                              <i class="bi-trash"></i>
                            </button>
                          ` : ''}
                        </div>
                      </div>

                      <div class="album-block-tracks library-songs-list">
                        ${renderAlbumSongsList(alb.songs, { albumTabs: albTabs })}
                      </div>
                    </div>
                    `;
                }).join('');

                let looseSongsBlockHtml = '';
                if ((selectedAlbumFilter === 'all' || selectedAlbumFilter === 'other') && selectedArtist.songs && selectedArtist.songs.length > 0) {
                    looseSongsBlockHtml = `
                    <div class="album-block" data-album-name="other">
                      <div class="album-header d-flex align-items-center justify-content-between gap-3">
                        <div class="d-flex align-items-center gap-3 min-w-0">
                          <div class="album-header-cover album-header-cover-icon flex-shrink-0">
                            <i class="bi-music-note-beamed"></i>
                          </div>
                          <div class="min-w-0">
                            <h4 class="album-header-title text-truncate">Other Tracks</h4>
                            <div class="album-header-sub tnum">
                              <span>${selectedArtist.songs.length} ${selectedArtist.songs.length === 1 ? 'track' : 'tracks'}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div class="album-block-tracks library-songs-list">
                        ${renderAlbumSongsList(selectedArtist.songs, { showAlbum: true })}
                      </div>
                    </div>
                    `;
                }

                let emptyHtml = '';
                if (selectedArtist.albums.length === 0 && (!selectedArtist.songs || selectedArtist.songs.length === 0)) {
                    emptyHtml = `
                    <div class="text-center py-5 text-muted">
                      <i class="bi-folder2-open fs-2 mb-2 d-block text-white-50"></i>
                      <div>${isHideNoTabSongsEnabled() ? 'No songs with tabs for this artist.' : 'No songs in this artist.'}</div>
                    </div>
                    `;
                } else if (showArtistEmptyState) {
                    emptyHtml = `
                    <div class="text-center py-5 text-muted">
                      <i class="bi-folder2-open fs-2 mb-2 d-block text-white-50"></i>
                      <div>No songs with tabs for this artist.</div>
                    </div>
                    `;
                }

                detailBodyHtml = `
                <div class="artist-detail-view">
                  ${albumBlocksHtml}
                  ${looseSongsBlockHtml}
                  ${emptyHtml}
                </div>
                `;
            } else {
                // Subfolders Grid and/or Songs List (Supports Infinite Layers and Layer 1 Songs)
                let subfoldersHtml = '';
                if (currentSubfolders.length > 0) {
                    subfoldersHtml = `
                    <div class="library-albums-grid mb-3" id="libAlbumsGrid">
                      ${currentSubfolders.map(sub => renderAlbumCard(sub)).join('')}
                    </div>
                    `;
                }

                // Custom folders can hold a whole book PDF that gets split into songs by page range
                let bookPdfHtml = '';
                let folderAlbumTabs = [];
                if (isCustomArtist) {
                    folderAlbumTabs = await getAlbumTabOptions(activeCollectionId, selectedArtist.name, matchingAlbum ? matchingAlbum.title : 'Custom Music');
                    const bookPdfs = folderAlbumTabs.filter(t => (t.name || '').toLowerCase().endsWith('.pdf') || t.fileType === 'pdf');
                    bookPdfHtml = `
                    <div class="library-book-pdf-bar d-flex flex-wrap align-items-center gap-2 mb-3">
                      <span class="book-row-label">Books</span>
                      ${bookPdfs.map(t => `
                         <span class="book-item d-inline-flex align-items-center">
                           <button type="button" class="play-album-tab-chip-btn album-book-link text-truncate" data-tab-id="${t.id}" title="Open book: ${escapeHtml(t.name)}">${escapeHtml(String(t.name).replace(/\.pdf$/i, ''))}</button>
                           ${isAlbumEditMode ? `<button class="btn btn-link p-0 text-muted remove-album-tab-chip-btn ms-1" data-tab-id="${t.id}" aria-label="Remove ${escapeHtml(t.name)}" title="Remove book"><i class="bi-x"></i></button>` : ''}
                         </span>
                       `).join('')}
                      <div class="dropdown flex-shrink-0">
                        <button class="btn btn-sm btn-theme-outline dropdown-toggle" type="button" data-bs-toggle="dropdown" data-bs-popper-config='{"strategy":"fixed"}' aria-expanded="false" title="Attach a whole-book PDF to this folder">Add book</button>
                        <ul class="dropdown-menu dropdown-menu-end theme-dropdown-menu">
                          ${addTabProviderItemsHtml('import-album-tab-btn')}
                        </ul>
                      </div>
                      ${bookPdfs.length > 0 ? `<button class="btn btn-sm btn-theme-outline flex-shrink-0" id="addSongsFromBookPdfBtn" title="Create songs from page ranges of a book PDF">Set book pages</button>` : ''}
                    </div>
                    `;
                }

                let songsHtml = '';
                if (currentSongs.length > 0) {
                    songsHtml = `
                    <div class="library-songs-list d-flex flex-column gap-2" id="libSongsList">
                      ${currentSubfolders.length > 0 ? `<div class="small text-white-50 fw-semibold mb-1"><i class="bi-music-note me-1 text-info"></i>Songs:</div>` : ''}
                      ${renderAlbumSongsList(currentSongs, { albumTabs: folderAlbumTabs, showAlbum: !isCustomArtist, showTrackNumber: Boolean(isCustomArtist) })}
                    </div>
                    `;
                }

                let emptyHtml = '';
                if (currentSubfolders.length === 0 && currentSongs.length === 0) {
                    emptyHtml = `
                    <div class="text-center py-5 text-muted">
                      <i class="bi-folder2-open fs-2 mb-2 d-block text-white-50"></i>
                      <div>${isHideNoTabSongsEnabled() ? 'No songs with tabs in this folder.' : 'This folder is empty.'}</div>
                    </div>
                    `;
                }

                detailBodyHtml = `
                <div class="artist-detail-view">
                  ${bookPdfHtml}
                  ${subfoldersHtml}
                  ${songsHtml}
                  ${emptyHtml}
                </div>
                `;
            }

            // Pinned songs are their own group above the artists, and the default one when there are any
            const pinnedActive = pinnedSongs.length > 0 && (pinnedGroupSelected === true || (pinnedGroupSelected === null && !hadSelectedArtist));
            let recentsList = [];
            try { recentsList = await getRecents(15); } catch (_) { recentsList = []; }
            const recentsActive = recentsList.length > 0 && pinnedGroupSelected === 'recents';
            const recentsGroupHtml = recentsList.length > 0 ? `
              <button type="button" class="library-card pinned-group-card" id="libRecentsGroupBtn" ${recentsActive ? 'aria-current="true"' : ''}>
                <span class="pinned-group-glyph" aria-hidden="true"><i class="bi-clock-history"></i></span>
                <span class="min-w-0 flex-grow-1 text-start">
                  <span class="d-block fw-bold text-white">Recents</span>
                  <span class="d-block small text-muted tnum">${formatCount(recentsList.length, 'song')}</span>
                </span>
                <i class="bi-chevron-right text-muted flex-shrink-0"></i>
              </button>` : '';
            const pinnedGroupHtml = pinnedSongs.length > 0 ? `
              <button type="button" class="library-card pinned-group-card" id="libPinnedGroupBtn" ${pinnedActive ? 'aria-current="true"' : ''}>
                <span class="pinned-group-glyph" aria-hidden="true"><i class="bi-pin-angle-fill"></i></span>
                <span class="min-w-0 flex-grow-1 text-start">
                  <span class="d-block fw-bold text-white">Pinned songs</span>
                  <span class="d-block small text-muted tnum">${pinnedSongs.length} ${pinnedSongs.length === 1 ? 'song' : 'songs'}</span>
                </span>
                <i class="bi-chevron-right text-muted flex-shrink-0"></i>
              </button>` : '';

            toolbarHtml = libraryListToolbarHtml({
                leftHtml: collectionSelectHtml,
                count: (() => { const n = artists.filter(a => !a.isCustom).length; return `${n} ${n === 1 ? 'artist' : 'artists'}`; })(), // Custom Music is not one of the artists, as in the list's own count
                actionsHtml: toolbarActionsHtml
            });


            // Custom Music sits with Pinned songs above the artists; it is not one of the artists
            const customGroup = artists.filter(a => a.isCustom);
            const regularArtists = artists.filter(a => !a.isCustom);
            const artistCardHtml = (artist) => ((pinnedActive || recentsActive) ? renderArtistCard(artist).replace(' aria-current="true"', '') : renderArtistCard(artist));
            const listPaneHtml = `
            <section class="pane list" aria-label="Artists">
              ${groupByRowHtml()}
              ${pinnedGroupHtml}
              ${recentsGroupHtml}
              ${customGroup.map(artistCardHtml).join('')}
              <h3 class="pane-head"><span>Artists <span class="tnum">(${regularArtists.length})</span></span></h3>
              <div class="pane-scroll">
                <div class="library-artists-grid" id="libArtistsGrid">
                  ${regularArtists.map(artistCardHtml).join('')}
                </div>
              </div>
            </section>
            `;

            const totalSongsForPane = isCustomArtist
                ? (currentSongs.length + currentSubfolders.reduce((acc, f) => acc + f.songsCount, 0))
                : ((selectedArtist.songs?.length || 0) + selectedArtist.albums.reduce((acc, a) => acc + (a.songs?.length || 0), 0));

            const pinnedPaneHtml = `
            <section class="pane songs" aria-label="Pinned songs">
              ${libraryPaneHeadHtml({
                  backLabel: 'Library',
                  backId: 'paneBackBtn',
                  backAct: 'paneback',
                  countText: `${pinnedSongs.length} ${pinnedSongs.length === 1 ? 'song' : 'songs'}`,
                  actionsHtml: pinnedSongs.length > 0 ? `<button class="btn btn-sm btn-theme-outline toggle-album-edit-btn" id="toggleAlbumEditBtn" title="${isAlbumEditMode ? 'Done editing' : 'Edit and delete songs'}">${isAlbumEditMode ? 'Done' : 'Edit'}</button>` : '',
                  title: 'Pinned songs'
              })}
              <div class="pane-scroll" id="libArtistDetailScroll">
                <div class="artist-detail-view">
                  <div class="library-songs-list d-flex flex-column gap-2" id="libSongsList">
                    ${pinnedSongs.length > 0
                      ? pinnedSongs.map(song => renderSongRow(song, { showArtistAlbum: true, hideAlbum: true, showTrackNumber: false, showCover: true })).join('')
                      : `<div class="text-muted p-4 text-center">${isHideNoTabSongsEnabled() ? 'No pinned songs with tabs.' : 'No pinned songs.'}</div>`}
                  </div>
                </div>
              </div>
            </section>
            `;

            const recentsPaneHtml = `
            <section class="pane songs" aria-label="Recents">
              ${libraryPaneHeadHtml({
                  backLabel: 'Library',
                  backId: 'paneBackBtn',
                  backAct: 'paneback',
                  countText: formatCount(recentsList.length, 'song'),
                  actionsHtml: `${isRecentsEditMode ? `<button class="btn btn-sm btn-theme-danger" id="clearRecentsBtn" title="Clear all recent history">Clear history</button>` : ''}
                <button class="btn btn-sm btn-theme-outline" id="toggleRecentsEditBtn" title="${isRecentsEditMode ? 'Done editing' : 'Edit recents list'}">${isRecentsEditMode ? 'Done' : 'Edit'}</button>`,
                  title: 'Recents'
              })}
              <div class="pane-scroll" id="libArtistDetailScroll">
                <div class="artist-detail-view">
                  <div class="d-flex flex-column gap-2" id="recentsList">
                    ${recentsList.map(recentRowHtml).join('')}
                  </div>
                </div>
              </div>
            </section>
            `;

            const isArtistPinnedState = selectedArtist && isArtistPinned(selectedArtist.name);
            const songsPaneHtml = recentsActive ? recentsPaneHtml : pinnedActive ? pinnedPaneHtml : `
            <section class="pane songs" aria-label="Songs">
              ${libraryPaneHeadHtml({
                  backLabel: 'Library',
                  backId: 'paneBackBtn',
                  backAct: 'paneback',
                  countText: `${totalSongsForPane} ${totalSongsForPane === 1 ? 'song' : 'songs'}${!isCustomArtist && selectedArtist.albums.length > 0 ? ` · ${selectedArtist.albums.length} ${selectedArtist.albums.length === 1 ? 'album' : 'albums'}` : ''}`,
                  actionsHtml: `${!isCustomArtist && selectedArtist ? `<button class="btn btn-sm btn-theme-icon pin-artist-btn me-1 ${isArtistPinnedState ? 'text-warning' : 'text-muted'}" data-artist-name="${escapeHtml(selectedArtist.name)}" title="${isArtistPinnedState ? 'Unpin artist' : 'Pin artist'}"><i class="bi-pin-angle${isArtistPinnedState ? '-fill' : ''}"></i></button>` : ''}<button class="btn btn-sm btn-theme-outline toggle-album-edit-btn" id="toggleAlbumEditBtn" title="${isAlbumEditMode ? 'Done editing' : 'Edit and delete songs'}">${isAlbumEditMode ? 'Done' : 'Edit'}</button>`,
                  title: selectedArtist.name
              })}
              ${isCustomArtist ? breadcrumbHtml : ''}
              ${shelfHtml}
              <div class="pane-scroll" id="libArtistDetailScroll">
                ${detailBodyHtml}
              </div>
            </section>
            `;

            bodyHtml = `
            <div class="collection-root-view">
              ${resumeHtml}
              <div class="panes" data-pane="${activeLibraryPane}">
                ${listPaneHtml}
                ${songsPaneHtml}
              </div>
            </div>
            `;
        }
    }

    if (!toolbarHtml) toolbarHtml = libraryListToolbarHtml({ leftHtml: collectionSelectHtml, actionsHtml: toolbarActionsHtml });
    container.innerHTML = headerHtml + toolbarHtml + `
      <div id="libBrowseContent">${bodyHtml}</div>
      <div id="libFilteredSearchResults" style="display: none;"></div>
    </div>
    `;

    bindLibraryToolbarEvents(container);

    // Resume opens the newest recent directly
    container.querySelector('#libResumeBtn')?.addEventListener('click', async () => {
        const [latest] = await getRecents(1);
        if (!latest) return;
        // Straight into the tab, then to the bar it was left at
        await openRecentItem(latest);
        if (latest.lastBar > 1) {
            const { seekToBarWhenReady } = await import('./gpProcessor/gpPlayer.js');
            seekToBarWhenReady(latest.lastBar);
        }
    });

    // In-view Back button click
    container.querySelectorAll('#libBrowseBackBtn, [data-act="paneback"]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (selectedFolderPath.length > 0 || selectedAlbum) {
                handleBack();
            } else {
                activeLibraryPane = 'list';
                const panes = container.querySelector('.panes');
                if (panes) panes.dataset.pane = 'list';
                handleBack();
            }
        });
    });

    // Drop a file on the custom music space (the whole library pane, or the Custom Music card) to add it directly
    const getCustomDropTarget = (e) => {
        if (activeView !== 'library') return null;
        if (selectedArtist?.isCustom) return { folderPath: selectedFolderPath.join('/') };
        const card = e.target.closest?.('.artist-card');
        if (!selectedArtist && card && artists.find(a => a.name === card.dataset.artistName)?.isCustom) return { folderPath: '' };
        return null;
    };
    // Assigned as properties so re-renders replace the handlers instead of stacking them
    container.ondragover = (e) => {
        if (!getCustomDropTarget(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = canAcceptTabDrop(e) ? 'copy' : 'none';
    };
    container.ondrop = async (e) => {
        const target = getCustomDropTarget(e);
        if (!target) return;
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        if (!(await isSupportedTabFile(file))) {
            showToast(`"${file.name}" is not a supported tab file (.gp, .gp3, .gp4, .gp5, .gpx, .pdf, .txt)`, 'warning');
            return;
        }
        try {
            const meta = await detectFileMetadata(file, file.name);
            const stored = await saveStoredFile(file, 'local');
            const songTitle = file.name.replace(/\.[^/.]+$/, '').trim();
            const tabOption = {
                id: `tab_local_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
                name: file.name,
                source: 'local',
                providerId: 'local',
                fileStoreId: stored.id,
                fileSize: file.size,
                tunings: meta.tuning ? [meta.tuning] : [],
                stringCount: meta.stringCount || null,
                addedAt: Date.now()
            };
            const song = {
                id: `song_custom_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
                collectionId: activeCollectionId,
                title: songTitle,
                artist: 'Custom Music',
                album: target.folderPath,
                folderPath: target.folderPath,
                isCustom: true,
                tunings: meta.tuning ? [meta.tuning] : [],
                stringCount: meta.stringCount || null,
                tabOptions: [tabOption],
                defaultTabId: tabOption.id,
                addedAt: Date.now()
            };
            await saveSongToLibrary(song, activeCollectionId);
            showToast(`Added "${songTitle}" to Custom Music${target.folderPath ? ' / ' + target.folderPath : ''}`, 'success');
            window.dispatchEvent(new CustomEvent('libraryDataChanged'));
            renderLibraryBrowseView(container);
        } catch (err) {
            console.warn('Could not attach dropped file:', err);
            showToast('Error attaching dropped file', 'error');
        }
    };

    // Breadcrumb clicks
    container.querySelector('#bcRoot')?.addEventListener('click', () => {
        pushLibraryNavigationState();
        selectedAlbum = null;
        selectedAlbumFilter = 'all';
        selectedFolderPath = [];
        isAlbumEditMode = false;
        activeLibraryPane = 'list';
        renderLibraryBrowseView(container);
    });
    container.querySelector('#bcArtist')?.addEventListener('click', () => {
        pushLibraryNavigationState();
        selectedAlbum = null;
        selectedAlbumFilter = 'all';
        selectedFolderPath = [];
        isAlbumEditMode = false;
        renderLibraryBrowseView(container);
    });
    container.querySelectorAll('.bc-folder-segment').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.segmentIndex, 10);
            if (!isNaN(idx)) {
                pushLibraryNavigationState();
                selectedFolderPath = selectedFolderPath.slice(0, idx + 1);
                selectedAlbum = selectedArtist?.albums?.find(a => (a.folderPath || a.title) === selectedFolderPath.join('/')) || null;
                selectedAlbumFilter = selectedAlbum ? selectedAlbum.title : 'all';
                isAlbumEditMode = false;
                renderLibraryBrowseView(container);
            }
        });
    });

    container.querySelector('#bcTuningRoot')?.addEventListener('click', () => {
        pushLibraryNavigationState();
        selectedTuning = null;
        renderLibraryBrowseView(container);
    });

    // Pinned songs group
    container.querySelector('#libPinnedGroupBtn')?.addEventListener('click', () => {
        pushLibraryNavigationState();
        pinnedGroupSelected = true;
        activeLibraryPane = 'songs';
        renderLibraryBrowseView(container);
    });


    // Recents group
    container.querySelector('#libRecentsGroupBtn')?.addEventListener('click', () => {
        pushLibraryNavigationState();
        pinnedGroupSelected = 'recents';
        activeLibraryPane = 'songs';
        renderLibraryBrowseView(container);
    });
    if (container.querySelector('#recentsList')) bindRecentRows(container, () => renderLibraryBrowseView(container));

    // Artist card clicks
    container.querySelectorAll('.artist-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.pin-artist-btn')) return;
            clearCardInteractionState(card);
            pushLibraryNavigationState();
            const artistName = card.dataset.artistName;
            selectedArtist = artists.find(a => a.name === artistName);
            pinnedGroupSelected = false;
            selectedAlbum = null;
            selectedAlbumFilter = 'all';
            selectedFolderPath = [];
            isAlbumEditMode = false;
            activeLibraryPane = 'songs';
            renderLibraryBrowseView(container);
        });
    });

    // Toggle Pin Artist
    container.querySelectorAll('.pin-artist-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const artistName = btn.dataset.artistName;
            const pinned = toggleArtistPinned(artistName);
            showToast(pinned ? `Pinned ${artistName}` : `Unpinned ${artistName}`, 'info');
            renderLibraryBrowseView(container);
        });
    });

    // Discography shelf clicks
    container.querySelectorAll('.discography-shelf [data-album-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            const filterVal = btn.dataset.albumFilter;
            selectedAlbumFilter = filterVal;
            if (filterVal !== 'all' && filterVal !== 'other') {
                selectedAlbum = selectedArtist?.albums?.find(a => a.title === filterVal) || null;
            } else {
                selectedAlbum = null;
            }
            renderLibraryBrowseView(container);
        });
    });

    // Tuning card clicks & back button
    container.querySelectorAll('.tuning-card').forEach(card => {
        const selectCard = () => {
            clearCardInteractionState(card);
            pushLibraryNavigationState();
            const tuningKey = card.dataset.tuningKey || card.dataset.tuningName;
            selectedTuning = tuningKey;
            activeLibraryPane = 'songs';
            renderLibraryBrowseView(container);
        };
        card.addEventListener('click', (e) => {
            if (e.target.closest('.edit-tuning-btn')) return;
            selectCard();
        });
        card.addEventListener('keydown', (e) => {
            if (e.target === card && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                selectCard();
            }
        });
    });

    container.querySelector('#tuningsBackBtn')?.addEventListener('click', () => {
        handleBack();
    });

    // Edit tuning name buttons (in grid cards and detail header)
    container.querySelectorAll('.edit-tuning-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const key = btn.dataset.tuningKey;
            if (!key) return;
            const info = getTuningInfo(key) || { key, notes: key, displayName: key, defaultName: key };
            openThemedInputModal({
                title: 'Edit Tuning Name',
                subtitle: `Tuning Notes: ${info.notes} (${info.key})`,
                icon: 'bi-pencil-square',
                inputLabel: 'Tuning Display Name',
                placeholder: `e.g. ${info.defaultName || info.notes}`,
                initialValue: info.displayName,
                confirmText: 'Save Name',
                onConfirm: async (newName) => {
                    setCustomTuningName(key, newName);
                    await renderLibraryBrowseView(container);
                }
            });
        });
    });

    // Album / Subfolder card clicks & drag-and-drop
    container.querySelectorAll('.album-card').forEach(card => {
        const folderName = card.dataset.folderName || card.dataset.albumTitle;

        card.addEventListener('click', () => {
            clearCardInteractionState(card);
            pushLibraryNavigationState();
            if (selectedArtist?.isCustom) {
                selectedFolderPath.push(folderName);
                selectedAlbum = selectedArtist?.albums?.find(a => (a.folderPath || a.title) === selectedFolderPath.join('/')) || null;
            } else {
                selectedAlbum = selectedArtist?.albums?.find(a => a.title === folderName);
                selectedFolderPath = [folderName];
            }
            isAlbumEditMode = false;
            renderLibraryBrowseView(container);
        });

        const targetAlbum = selectedArtist?.albums?.find(a => (a.folderPath || a.title) === folderName);
        if (targetAlbum) {
            card.addEventListener('dragenter', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!canAcceptTabDrop(e)) {
                    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
                    return;
                }
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                card.classList.add('album-drop-active');
            });

            card.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!canAcceptTabDrop(e)) {
                    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
                    card.classList.remove('album-drop-active');
                    return;
                }
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                if (!card.classList.contains('album-drop-active')) {
                    card.classList.add('album-drop-active');
                }
            });

            card.addEventListener('dragleave', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!card.contains(e.relatedTarget)) {
                    card.classList.remove('album-drop-active');
                }
            });

            card.addEventListener('drop', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                card.classList.remove('album-drop-active');

                const files = Array.from(e.dataTransfer?.files || []);
                if (files.length === 0) return;

                let attachedCount = 0;
                for (const file of files) {
                    const matchedSong = matchSongInAlbum(targetAlbum.songs, file.name);
                    if (matchedSong) {
                        const ok = await attachFileToSong(file, matchedSong.id);
                        if (ok) attachedCount++;
                    } else if (targetAlbum.songs?.length > 0) {
                        const ok = await attachFileToSong(file, targetAlbum.songs[0].id);
                        if (ok) attachedCount++;
                    } else {
                        if (!(await isSupportedTabFile(file))) {
                            showToast(`"${file.name}" is not a supported tab file (.gp, .gp3, .gp4, .gp5, .gpx, .pdf, .txt)`, 'warning');
                        }
                    }
                }

                if (attachedCount > 0) {
                    await renderLibraryBrowseView(container);
                }
            });
        }
    });

    // Search / Filter setup
    setupLibraryFilter(container, { hierarchy, artists, selectedArtist, selectedAlbum, selectedTuning, pinnedSongs: hierarchy.pinnedSongs || [] });

    // Song actions & album tab actions
    setupSongRowActions(container);

    // Hydrate cached images
    hydrateCachedImages(container);
}

const LIBRARY_TABS = [
    { id: 'library', label: 'Library', title: 'Browse your tab library', icon: 'mt-ico mt-ico-library' },
    { id: 'setlists', label: 'Setlists', title: 'Build and play setlists of tabs', icon: 'mt-ico mt-ico-setlists' },
    { id: 'tools', label: 'Tools', title: 'Tuner, metronome, reference library and Jam', icon: 'bi-grid-3x3-gap' },
    { id: 'tunings', label: 'Tunings', title: 'Browse songs by guitar and bass tuning', icon: 'bi-sliders' }
];

// Desktop view switcher shared by every library page header (phones use the bottom nav instead)
export function libraryViewSwitchHtml(activeTab = null) {
    return `<div class="hud-pill-group lib-view-switch" role="group" aria-label="Library views">
      ${LIBRARY_TABS.filter(t => t.id !== 'tunings').map(t => `<button type="button" class="btn btn-sm ${t.id === activeTab ? 'active' : ''}" data-lib-tab="${t.id}" title="${t.title}"><i class="${t.icon}"></i><span class="lib-view-switch-label">${t.label}</span></button>`).join('')}
    </div>`;
}

// Shared chrome for every library view: centered view switcher, then its own search box, then (below, via
// libraryListToolbarHtml) a count on the left and the primary action on the right.
export function libraryHeaderHtml({ activeTab, searchId, clearId, placeholder, searchLabel, searchDisabled = false }) {
    if (window.matchMedia?.('(max-width: 576px)').matches) {
        placeholder = 'Search';
    } else if (!placeholder || placeholder === 'Search your library') {
        placeholder = 'Search your library or find any artist, song, or album…';
    }
    const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
    const shortcutHint = isMac ? '⌘K' : 'Ctrl+K';
    return `<div class="lib-view-switch-row">${libraryViewSwitchHtml(activeTab)}</div>
      <div class="library-search-box mb-3">
        <div class="library-search-bar">
          <i class="bi-search search-icon"></i>
          <input type="text" class="search-input" id="${searchId}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" aria-label="${searchLabel}" ${searchDisabled ? 'disabled' : ''}>
          <button class="search-clear-btn" type="button" id="${clearId}" title="Clear search" aria-label="Clear search" style="display: none;">
            <i class="bi-x-lg"></i>
          </button>
          <kbd class="search-key-hint" aria-hidden="true">${shortcutHint}</kbd>
          <button class="search-close-btn" type="button" aria-label="Close search">Cancel</button>
        </div>
      </div>`;
}

// ⌘K / Ctrl+K and "/" focus the library search from anywhere that is not a text field
let librarySearchShortcutBound = false;
function bindLibrarySearchShortcut() {
    if (librarySearchShortcutBound || typeof document === 'undefined') return;
    librarySearchShortcutBound = true;
    document.addEventListener('keydown', (e) => {
        const isSlash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey;
        const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
        if (!isSlash && !isCmdK) return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        const input = document.querySelector('.library-page-view .library-search-bar .search-input:not([disabled])');
        if (!input || input.offsetParent === null) return;
        e.preventDefault();
        input.focus();
        input.select();
    });
}
bindLibrarySearchShortcut();


// Two-pane songs detail pane header (Artists, Tunings, Setlists, Pinned, Recents)
export function libraryPaneHeadHtml({ backLabel = 'Library', backId = 'paneBackBtn', backAct = '', countText = '', actionsHtml = '', title = '' }) {
    return `
      <h3 class="pane-head">
        <button class="btn btn-sm btn-ghost in-view-back-btn p-1 px-2" id="${escapeHtml(backId)}" ${backAct ? `data-act="${escapeHtml(backAct)}"` : ''} type="button"><i class="bi-chevron-left"></i> ${escapeHtml(backLabel)}</button>
        ${countText ? `<span class="tnum ms-auto">${escapeHtml(countText)}</span>` : ''}
        ${actionsHtml}
      </h3>
      ${title ? `
      <div class="pane-head-title artist-head-title">
        <h2 class="text-truncate">${escapeHtml(title)}</h2>
      </div>` : ''}
    `;
}

// Centered page title for library pages that are not a switcher tab (Open File, Add Music)
export function libraryPageTitleHtml({ icon, title, subtitle = '' }) {
    return `<div class="library-page-title" data-tauri-drag-region>
        <h5 class="library-page-title-text" data-tauri-drag-region>${title}</h5>
        ${subtitle ? `<p class="library-page-title-sub" data-tauri-drag-region>${subtitle}</p>` : ''}
      </div>`;
}

// Same icon, title, message and button sizes for every "nothing here yet" state
export function libraryEmptyStateHtml({ icon, title, message, actionsHtml = '' }) {
    return `<div class="library-empty py-5 text-muted">
          <h6 class="text-white fw-semibold">${title}</h6>
          <p class="text-muted ${actionsHtml ? 'mb-3' : 'mb-0'}">${message}</p>
          ${actionsHtml ? `<div class="d-flex gap-2 flex-wrap">${actionsHtml}</div>` : ''}
        </div>`;
}

// Count on the left, primary action (plus any secondary controls) on the right
export function libraryListToolbarHtml({ count = '', leftHtml = '', actionsHtml = '' }) {
    return `<div class="library-list-toolbar">
        <div class="d-flex align-items-center gap-2 min-w-0">${leftHtml}<span class="small text-white-50">${count}</span></div>
        <div class="d-flex align-items-center gap-2 flex-shrink-0">${actionsHtml}</div>
      </div>`;
}

// Search for the two-pane pages (setlists, tunings): cards on the left that do not match are hidden, the
// selection moves to the first match, and the right pane keeps showing the selected card's rows, filtered.
// Cards carry data-name and data-search (name plus the songs inside) in lower case.
const twoPaneFilterQueries = {};
export function bindTwoPaneFilter(container, { inputId, clearId, key, cardSelector, rowSelector }) {
    const input = container.querySelector('#' + inputId);
    const clear = container.querySelector('#' + clearId);
    if (!input) return;
    const apply = () => {
        const q = input.value.trim().toLowerCase();
        twoPaneFilterQueries[key] = input.value;
        if (clear) clear.style.display = q ? 'inline-flex' : 'none';
        container.querySelectorAll('.library-filter-empty-msg').forEach(el => el.remove());
        const cards = [...container.querySelectorAll(cardSelector)];
        cards.forEach(card => card.classList.toggle('lib-filter-hidden', Boolean(q) && !(card.dataset.search || '').includes(q)));
        const visible = cards.filter(c => !c.classList.contains('lib-filter-hidden'));
        const count = container.querySelector('.pane.list .pane-head .tnum');
        if (count) {
            if (count.dataset.total === undefined) count.dataset.total = count.textContent;
            count.textContent = q ? `(${visible.length})` : count.dataset.total;
        }
        const current = cards.find(c => c.getAttribute('aria-current') === 'true');
        if (q && current && current.classList.contains('lib-filter-hidden') && visible.length) { visible[0].click(); return; }
        const nameHit = !q || (current?.dataset.name || '').includes(q);
        const rows = container.querySelectorAll(rowSelector);
        let shown = 0;
        rows.forEach(row => {
            const hit = nameHit || (row.textContent || '').toLowerCase().includes(q);
            row.classList.toggle('lib-filter-hidden', !hit);
            if (hit) shown++;
        });
        const note = (host, text) => {
            if (!host) return;
            const el = document.createElement('div');
            el.className = 'library-filter-empty-msg text-center py-4 text-muted';
            el.textContent = text;
            host.appendChild(el);
        };
        if (q && !visible.length) note(container.querySelector('.pane.list .pane-scroll'), `Nothing matches "${input.value.trim()}". Clear the search to see everything.`);
        else if (q && rows.length && !shown) note(container.querySelector('.pane.songs .pane-scroll'), 'Nothing matches that search.');
    };
    input.addEventListener('input', apply);
    clear?.addEventListener('click', () => { input.value = ''; apply(); input.focus(); });
    // After the caller has attached its card click handlers, so moving the selection can click a card
    if (twoPaneFilterQueries[key] && !input.disabled) { input.value = twoPaneFilterQueries[key]; queueMicrotask(apply); }
}

// Client-side filter for simple list views (setlists, recents)
export function bindListFilter(container, { inputId, clearId, rowSelector, emptyId }) {
    const input = container.querySelector('#' + inputId);
    const clear = container.querySelector('#' + clearId);
    if (!input) return;
    const apply = () => {
        const q = input.value.trim().toLowerCase();
        let shown = 0;
        container.querySelectorAll(rowSelector).forEach(row => {
            const hit = !q || row.textContent.toLowerCase().includes(q);
            row.style.display = hit ? '' : 'none';
            if (hit) shown++;
        });
        if (clear) clear.style.display = q ? '' : 'none';
        const empty = emptyId && container.querySelector('#' + emptyId);
        if (empty) empty.style.display = shown === 0 && q ? '' : 'none';
    };
    input.addEventListener('input', apply);
    clear?.addEventListener('click', () => { input.value = ''; apply(); input.focus(); });
}

function getActiveLibraryTab() {
    if (activeView === 'library') return 'library'; // the Tunings browse is still the Library destination
    return activeView === 'setlists' || activeView === 'recents' || activeView === 'tools' || activeView === 'settings' ? activeView : null;
}

// Shared by the desktop view switcher and the phone bottom nav
export async function goLibraryTab(tab) {
    // Choosing a destination always starts it fresh: a search typed there is cleared
    libraryFilterQuery = '';
    searchSubView = null;
    if (tab === 'setlists' || tab === 'recents' || tab === 'tools' || tab === 'settings') {
        if (activeView !== tab) await switchView(tab);
        else { activeLibraryPane = 'list'; await renderLibraryModal(); }
        return;
    }
    tuningsArtistFilter = '';
    const wantTunings = tab === 'tunings';
    const alreadyThere = activeView === 'library' && (libraryBrowseMode === 'tunings') === wantTunings;
    if (!alreadyThere) pushLibraryNavigationState();
    activeView = 'library';
    libraryBrowseMode = wantTunings ? 'tunings' : 'artists';
    activeLibraryPane = 'list';
    selectedArtist = null;
    pinnedGroupSelected = null;
    selectedAlbum = null;
    selectedFolderPath = [];
    selectedTuning = null;
    isAlbumEditMode = false;
    updateUrl(wantTunings ? 'tunings' : 'library');
    await renderLibraryModal();
}

// Phone-only bottom nav (CSS hides it elsewhere); created once and kept in sync with the active view
function syncLibraryBottomNav() {
    let nav = document.getElementById('libraryBottomNav');
    if (!nav) {
        const tabHtml = (t) => `<button type="button" class="library-nav-tab" data-lib-tab="${t.id}" title="${t.title}"><i class="${t.icon}"></i><span>${t.label}</span></button>`;
        const [lib, setlists, tools] = LIBRARY_TABS; // Tunings is a Browse by row inside Library, not a destination
        nav = document.createElement('nav');
        nav.id = 'libraryBottomNav';
        nav.className = 'library-bottom-nav';
        nav.setAttribute('aria-label', 'Library');
        nav.setAttribute('data-tauri-drag-region', '');
        // Phones: bottom tab bar. Wide windows: left rail (CSS). Settings sits last; Add music stays in each list's toolbar.
        nav.innerHTML = `${tabHtml(lib)}${tabHtml(setlists)}${tabHtml(tools)}
          <button type="button" class="library-nav-tab library-nav-settings" id="libraryNavSettingsBtn" title="Settings"><i class="bi-gear"></i><span>Settings</span></button>`;
        nav.addEventListener('click', (e) => {
            // Settings is a destination like the rest: one path, and the view decides what is on screen
            const tab = e.target.closest('[data-lib-tab], #libraryNavSettingsBtn');
            if (!tab) return;
            closeToolsMenu();
            return goLibraryTab(tab.id === 'libraryNavSettingsBtn' ? 'settings' : tab.dataset.libTab);
        });
        document.body.appendChild(nav);
    }
    // One current destination, Settings included
    const active = getActiveLibraryTab();
    nav.querySelectorAll('[data-lib-tab]').forEach(b => b.classList.toggle('active', b.dataset.libTab === active));
    const settingsBtn = nav.querySelector('#libraryNavSettingsBtn');
    const settingsOpen = active === 'settings';
    settingsBtn?.classList.toggle('active', settingsOpen);
    if (settingsBtn) settingsOpen ? settingsBtn.setAttribute('aria-current', 'page') : settingsBtn.removeAttribute('aria-current');
    // The iOS app shows the system tab bar in its place (iOS 26 and later); this keeps it on the same destination
    initNativeTabBar();
    setNativeTabActive(active);
}

function bindLibraryToolbarEvents(container) {
    const collectionSelect = container.querySelector('#libCollectionSelect');
    collectionSelect?.addEventListener('change', (e) => {
        activeCollectionId = e.target.value;
        tuningsArtistFilter = '';
        selectedArtist = null;
        selectedAlbum = null;
        selectedTuning = null;
        isAlbumEditMode = false;
        renderLibraryBrowseView(container);
    });

    // Group by: Artists or Tunings, two ways to slice the same library (no history entry, no back step)
    container.querySelectorAll('[data-lib-groupby]').forEach(btn => btn.addEventListener('click', () => {
        const wantTunings = btn.dataset.libGroupby === 'tunings';
        if ((libraryBrowseMode === 'tunings') === wantTunings) return;
        libraryBrowseMode = wantTunings ? 'tunings' : 'artists';
        libraryFilterQuery = '';
        tuningsArtistFilter = '';
        activeLibraryPane = 'list';
        selectedTuning = null;
        updateUrl(wantTunings ? 'tunings' : 'library', null, false);
        renderLibraryBrowseView(container);
    }));

    container.querySelector('#libTuningArtistSelect')?.addEventListener('change', (e) => {
        tuningsArtistFilter = e.target.value;
        renderLibraryBrowseView(container);
    });

    container.querySelectorAll('[data-lib-sync]').forEach(b => b.addEventListener('click', () => import('./syncUi.js').then(m => m.openSyncModal())));
}

// "5 songs", "1 album": count plus its unit, lowercase, plural unless exactly 1
function formatCount(n, unit) {
    return `${n} ${n === 1 ? unit : `${unit}s`}`;
}

// "2 books · 5 songs" for custom music spaces
function formatBooksSongsLabel(books, songs) {
    return `${formatCount(books, 'book')} · ${formatCount(songs, 'song')}`;
}

function renderArtistCard(artist) {
    const isCustomArtist = Boolean(artist.isCustom);
    const albumCount = artist.albums ? artist.albums.length : 0;
    const isPinned = Boolean(artist.pinned ?? isArtistPinned(artist.name));
    const hideNoTabs = isHideNoTabSongsEnabled();
    const artistSongs = hideNoTabs ? (artist.songs || []).filter(songHasTabs) : (artist.songs || []);
    const songCount = artistSongs.length + (artist.albums ? artist.albums.reduce((acc, a) => {
        const aSongs = hideNoTabs ? (a.songs || []).filter(songHasTabs) : (a.songs || []);
        return acc + aSongs.length;
    }, 0) : 0);
    const bookCount = (artist.rootBooks || 0) + (artist.albums ? artist.albums.reduce((acc, a) => acc + (a.tabOptions ? a.tabOptions.length : 0), 0) : 0);
    const collageHtml = renderArtistCollageHtml(artist);
    const isCurrent = selectedArtist && (artist.name === selectedArtist.name || (selectedArtist.artistMbid && artist.artistMbid === selectedArtist.artistMbid));
    return `
    <div class="library-card artist-card p-3 ${isPinned ? 'artist-card-pinned' : ''}" data-artist-name="${escapeHtml(artist.name)}" ${isCurrent ? 'aria-current="true"' : ''} role="button" tabindex="0">
      <div class="d-flex align-items-center gap-3 min-w-0">
        ${collageHtml}
        <div class="min-w-0 flex-grow-1">
          <h6 class="mb-1 fw-bold text-white text-truncate d-flex align-items-center gap-1" title="${escapeHtml(artist.name)}">
            <span>${escapeHtml(artist.name)}</span>
            ${isPinned ? '<i class="bi-pin-angle-fill text-warning small ms-1" title="Pinned artist"></i>' : ''}
          </h6>
          <div class="small text-muted text-truncate">${albumCount > 0 ? `${formatCount(albumCount, isCustomArtist ? 'folder' : 'album')} · ` : ''}${isCustomArtist ? formatBooksSongsLabel(bookCount, songCount) : formatCount(songCount, 'song')}</div>
        </div>
        <button type="button" class="btn btn-sm btn-theme-icon pin-artist-btn ${isPinned ? 'text-warning' : 'text-muted'} flex-shrink-0" data-artist-name="${escapeHtml(artist.name)}" title="${isPinned ? 'Unpin artist' : 'Pin artist'}">
          <i class="bi-pin-angle${isPinned ? '-fill' : ''}"></i>
        </button>
        <i class="bi-chevron-right text-muted flex-shrink-0"></i>
      </div>
    </div>
    `;
}

function renderAlbumCard(album, artistName = '') {
    const isCustom = Boolean(album.isCustom);
    const title = album.title || album.name || '';
    const cover = getSynchronousCachedArtUrl(album.coverUrl) || album.coverUrl || (isCustom ? null : getPlaceholderCoverSvg(title));
    const hideNoTabs = isHideNoTabSongsEnabled();
    const songCount = Array.isArray(album.songs)
        ? (hideNoTabs ? album.songs.filter(songHasTabs).length : album.songs.length)
        : (album.songsCount || 0);
    const year = album.year;
    return `
    <div class="library-card album-card p-3" data-artist-name="${escapeHtml(artistName)}" data-album-title="${escapeHtml(title)}" data-folder-name="${escapeHtml(title)}" role="button" tabindex="0">
      <div class="album-card-body d-flex min-w-0">
        <div class="album-cover-container">
          ${cover
              ? `<img loading="lazy" decoding="async" src="${cover}" class="album-cover-img" alt="${escapeHtml(title)}" draggable="false" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(title)}'">`
              : `<i class="bi-folder2 fs-1 text-info opacity-75"></i>`
          }
          ${year ? `<span class="badge badge-theme-year position-absolute bottom-0 end-0 m-2 album-year-badge">${year}</span>` : ''}
        </div>
        <div class="album-card-content min-w-0 flex-grow-1">
          <h6 class="mb-1 fw-bold text-white text-truncate" title="${escapeHtml(title)}">${escapeHtml(title)}</h6>
          <div class="small text-muted text-truncate">${artistName ? `<span class="fw-semibold text-white-50">${escapeHtml(artistName)}</span> · ` : ''}${year ? `${year} · ` : ''}${album.isCustom ? formatBooksSongsLabel(album.booksCount ?? (album.tabOptions ? album.tabOptions.length : 0), songCount) : formatCount(songCount, 'song')}</div>
        </div>
        <i class="bi-chevron-right text-muted flex-shrink-0 album-card-chevron"></i>
      </div>
    </div>
    `;
}

// Text a song's tunings answer to in search: the tuning's name, its notes and its key
function songTuningSearchText(song) {
    const keys = new Set([song.tuning, ...(Array.isArray(song.tunings) ? song.tunings : []), ...((song.tabOptions || []).flatMap(t => [t.tuning, ...(Array.isArray(t.tunings) ? t.tunings : [])]))].filter(Boolean));
    return [...keys].map(k => { const info = getTuningInfo(k); return [k, info?.displayName, info?.notes, info?.key].filter(Boolean).join(' '); }).join(' ').toLowerCase();
}

function setupLibraryFilter(container, context = {}) {
    const filterInput = container.querySelector('#libFilterInput');
    const clearBtn = container.querySelector('#libFilterClearBtn');
    if (!filterInput) return;

    const browseContent = container.querySelector('#libBrowseContent');
    const filterResults = container.querySelector('#libFilteredSearchResults');

    let localTimer = null;
    let catalogTimer = null;
    let searchAbortController = null;
    let activeNavIndex = -1;

    // 1. Song List View (Album Detail - specifically #libSongsList)
    if (context.selectedAlbum) {
        const applyAlbumFilter = () => {
            const rawQuery = (filterInput.value || '').trim();
            const query = rawQuery.toLowerCase();
            if (clearBtn) clearBtn.style.display = query.length > 0 ? 'inline-flex' : 'none';
            container.querySelectorAll('.library-filter-empty-msg').forEach(el => el.remove());
            const songsList = container.querySelector('#libSongsList');
            if (songsList) {
                const songRows = songsList.querySelectorAll('.library-song-row');
                let visibleCount = 0;
                songRows.forEach(row => {
                    const title = (row.dataset.songTitle || '').toLowerCase();
                    const artist = (row.dataset.songArtist || '').toLowerCase();
                    const matches = !query || title.includes(query) || artist.includes(query);
                    row.style.display = matches ? '' : 'none';
                    if (matches) visibleCount++;
                });
                if (visibleCount === 0 && query) {
                    const emptyMsg = document.createElement('div');
                    emptyMsg.className = 'library-filter-empty-msg text-center py-4 text-muted';
                    emptyMsg.innerHTML = `<i class="bi-search fs-3 mb-2 d-block text-white-50"></i>No songs match "${escapeHtml(query)}"`;
                    songsList.appendChild(emptyMsg);
                }
            }
        };
        filterInput.addEventListener('input', applyAlbumFilter);
        clearBtn?.addEventListener('click', () => {
            filterInput.value = '';
            applyAlbumFilter();
            filterInput.focus();
        });
        return;
    }

    const viewArtistCatalogAlbums = async (artistMbid, artistName, targetContainer, originalQuery) => {
        searchSubView = { type: 'artist-albums', artistMbid, artistName, originalQuery, fromView: 'library' };
        const thisFetchToken = ++currentExploreArtistToken;

        targetContainer.innerHTML = `
        <div class="search-artist-albums-view">
          <div class="search-subview-head d-flex align-items-center justify-content-between mb-3">
            <button type="button" class="search-back-btn" id="backToSearchCatalogBtn">
              <i class="bi-chevron-left" aria-hidden="true"></i> <span>Search</span>
            </button>
            <div class="d-flex align-items-center gap-2 min-w-0">
              <span class="fw-semibold text-truncate" style="color: var(--ink);">${escapeHtml(artistName)}</span>
              <span class="small" style="color: var(--ink2);">· Studio Albums</span>
            </div>
          </div>
          <div class="text-center py-5 text-muted">
            <div class="spinner-border spinner-border-sm text-info mb-2" role="status"></div>
            <div>Loading studio albums for ${escapeHtml(artistName)}…</div>
          </div>
        </div>
        `;

        targetContainer.querySelector('#backToSearchCatalogBtn')?.addEventListener('click', () => {
            searchSubView = null;
            runLocalFilter();
        });

        try {
            const albums = await getArtistAlbums(artistMbid);
            if (thisFetchToken !== currentExploreArtistToken) return;

            if (!albums || albums.length === 0) {
                targetContainer.innerHTML = `
                <div class="search-artist-albums-view">
                  <div class="search-subview-head d-flex align-items-center justify-content-between mb-3">
                    <button type="button" class="search-back-btn" id="backToSearchCatalogBtn">
                      <i class="bi-chevron-left" aria-hidden="true"></i> <span>Search</span>
                    </button>
                  </div>
                  <div class="text-center py-4 text-muted">No studio albums found for ${escapeHtml(artistName)}.</div>
                </div>`;
                targetContainer.querySelector('#backToSearchCatalogBtn')?.addEventListener('click', () => {
                    searchSubView = null;
                    runLocalFilter();
                });
                return;
            }

            const songs = await getSongsByCollection(activeCollectionId);
            const existingAlbumKeys = new Set(songs.map(s => {
                if (s.albumMbid) return `mbid:${s.albumMbid}`;
                return `${(s.artist || '').toLowerCase().trim()}:::${(s.album || '').toLowerCase().trim()}`;
            }));
            const artistLower = artistName.toLowerCase().trim();

            let html = `
            <div class="search-artist-albums-view">
              <div class="search-subview-head d-flex align-items-center justify-content-between mb-3">
                <button type="button" class="search-back-btn" id="backToSearchCatalogBtn">
                  <i class="bi-chevron-left" aria-hidden="true"></i> <span>Search</span>
                </button>
                <div class="search-subview-title">
                  <span class="search-subview-name">${escapeHtml(artistName)}</span>
                  <span class="search-subview-sub">${albums.length} ${albums.length === 1 ? 'release' : 'releases'} · albums first, then EPs and singles</span>
                </div>
              </div>
              <div class="search-stream-list">
            `;

            // Albums first, then EPs, singles and other types; release order within each group.
            const isPlainAlbum = a => !a.primaryType || /^album$/i.test(a.primaryType);
            const orderedAlbums = [...albums.filter(isPlainAlbum), ...albums.filter(a => !isPlainAlbum(a))];
            for (const alb of orderedAlbums) {
                const isInLib = existingAlbumKeys.has(`mbid:${alb.id}`) || existingAlbumKeys.has(`${artistLower}:::${(alb.title || '').toLowerCase().trim()}`);
                const cover = alb.coverUrl || getPlaceholderCoverSvg(alb.title);
                html += `
                <div class="search-stream-row search-album-row is-navigable" data-type="artist-album-row" data-album-id="${alb.id}" tabindex="0">
                  <img loading="lazy" decoding="async" src="${cover}" class="shelf-cover flex-shrink-0" style="width: 44px; height: 44px; border-radius: var(--r); object-fit: cover; background: var(--s3);" alt="" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(alb.title)}'">
                  <div class="search-row-meta min-w-0 flex-grow-1">
                    <div class="search-row-title text-truncate">${escapeHtml(alb.title)}</div>
                    <div class="search-row-sub text-truncate">${alb.year ? `${alb.year} · ` : ''}${escapeHtml(alb.primaryType || 'Album')}${isInLib ? ' · <span class="text-info">In Library</span>' : ''}</div>
                  </div>
                  <div class="search-album-actions d-flex align-items-center gap-2 flex-shrink-0 ms-2">
                    <button type="button" class="btn btn-sm lib-ghost-action view-album-tracks-btn" data-album-id="${alb.id}" data-album-title="${escapeHtml(alb.title)}" title="View tracks">
                      Tracks
                    </button>
                    <button type="button" class="btn btn-sm lib-ghost-action catalog-album-batch-btn" data-album-id="${alb.id}" data-album-title="${escapeHtml(alb.title)}" data-artist-name="${escapeHtml(artistName)}" data-year="${alb.year || ''}" aria-label="Add album and find tabs">
                      Add album
                    </button>
                  </div>
                </div>
                `;
            }

            html += `
              </div>
            </div>
            `;

            targetContainer.innerHTML = html;

            targetContainer.querySelector('#backToSearchCatalogBtn')?.addEventListener('click', () => {
                searchSubView = null;
                runLocalFilter();
            });

            targetContainer.querySelectorAll('.catalog-album-batch-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    handleAddAlbumBatch({
                        id: btn.dataset.albumId,
                        title: btn.dataset.albumTitle,
                        artist: btn.dataset.artistName,
                        year: btn.dataset.year
                    }, btn);
                });
            });

            targetContainer.querySelectorAll('.view-album-tracks-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const albId = btn.dataset.albumId;
                    const alb = albums.find(a => a.id === albId);
                    await exploreAlbumTracklist(albId, targetContainer, { mbid: artistMbid, name: artistName }, alb ? {
                        title: alb.title,
                        artist: artistName,
                        year: alb.year,
                        coverUrl: alb.coverUrl,
                        primaryType: alb.primaryType
                    } : null);
                });
            });

            targetContainer.querySelectorAll('.search-stream-row[data-type="artist-album-row"]').forEach(row => {
                row.addEventListener('click', (e) => {
                    if (e.target.closest('button, a')) return;
                    const albId = row.dataset.albumId;
                    const alb = albums.find(a => a.id === albId);
                    if (albId) exploreAlbumTracklist(albId, targetContainer, { mbid: artistMbid, name: artistName }, alb ? {
                        title: alb.title,
                        artist: artistName,
                        year: alb.year,
                        coverUrl: alb.coverUrl,
                        primaryType: alb.primaryType
                    } : null);
                });
            });
        } catch (err) {
            if (thisFetchToken !== currentExploreArtistToken) return;
            targetContainer.innerHTML = `
            <div class="search-artist-albums-view">
              <div class="search-subview-head d-flex align-items-center justify-content-between mb-3">
                <button type="button" class="search-back-btn" id="backToSearchCatalogBtn">
                  <i class="bi-chevron-left" aria-hidden="true"></i> <span>Search</span>
                </button>
              </div>
              <div class="text-danger py-4 text-center">Failed to load studio albums: ${escapeHtml(err.message)}</div>
            </div>`;
            targetContainer.querySelector('#backToSearchCatalogBtn')?.addEventListener('click', () => {
                searchSubView = null;
                runLocalFilter();
            });
        }
    };
    currentArtistAlbumsViewHandler = viewArtistCatalogAlbums;

    const renderCatalogTier = (catalogSongs, catalogAlbums, catalogArtists, rawQuery) => {
        const catalogContainer = filterResults.querySelector('#libSearchCatalogResults');
        const statusSlot = filterResults.querySelector('#libSearchCatalogStatus');
        if (!catalogContainer) return;

        if (catalogArtists.length === 0 && catalogSongs.length === 0 && catalogAlbums.length === 0) {
            if (statusSlot) {
                statusSlot.innerHTML = `<span class="text-muted">No music catalog matches found for "${escapeHtml(rawQuery)}"</span>`;
                statusSlot.style.display = 'flex';
            }
            catalogContainer.innerHTML = '';
            return;
        }

        if (statusSlot) {
            statusSlot.innerHTML = '';
            statusSlot.style.display = 'none';
        }

        let html = `
        <div class="search-stream-section">
          <div class="search-stream-section-title">From the music catalog and web</div>
          <div class="search-stream-list">
        `;

        // Exact-name artists lead; partial-name matches trail the albums and songs
        const { lead: leadArtists, rest: weakArtists } = splitCatalogArtists(catalogArtists, rawQuery);
        const artistRow = (art) => `
            <div class="search-stream-row is-navigable" data-type="catalog-artist" data-artist-id="${art.id}" data-artist-name="${escapeHtml(art.name)}" tabindex="0">
              <div class="search-row-meta min-w-0 flex-grow-1">
                <div class="search-row-title text-truncate">${escapeHtml(art.name)} <span class="text-muted fw-normal" style="font-size: 13px;">(${escapeHtml(art.type || 'Artist')})</span></div>
                <div class="search-row-sub text-truncate">${escapeHtml([art.disambiguation, art.country, art.lifeSpan].filter(Boolean).join(' · ') || 'Artist')}</div>
              </div>
              <button type="button" class="btn btn-sm lib-ghost-action catalog-artist-albums-btn flex-shrink-0 ms-2" data-artist-id="${art.id}" data-artist-name="${escapeHtml(art.name)}" aria-label="View albums">Albums</button>
            </div>
            `;

        // Render catalog artists (Bands)
        for (const art of leadArtists.slice(0, 3)) html += artistRow(art);

        // Render catalog albums
        for (const alb of catalogAlbums.slice(0, 5)) {
            html += `
            <div class="search-stream-row is-navigable" data-type="catalog-album" tabindex="0">
              <div class="search-row-meta min-w-0 flex-grow-1">
                <div class="search-row-title text-truncate">${escapeHtml(alb.title)} (Album)</div>
                <div class="search-row-sub text-truncate">${escapeHtml(alb.artist)}${alb.year ? ` · ${alb.year}` : ''}${alb.trackCount ? ` · ${alb.trackCount} tracks` : ''}</div>
              </div>
              <button type="button" class="btn btn-sm lib-ghost-action catalog-album-batch-btn flex-shrink-0 ms-2" data-album-id="${alb.id}" data-album-title="${escapeHtml(alb.title)}" data-artist-name="${escapeHtml(alb.artist)}" data-year="${alb.year || ''}" aria-label="Add album and find tabs">Add album</button>
            </div>
            `;
        }

        // Render catalog songs
        for (const song of catalogSongs.slice(0, 10)) {
            html += `
            <div class="search-stream-row is-navigable" data-type="catalog-song" tabindex="0">
              <div class="search-row-meta min-w-0 flex-grow-1">
                <div class="search-row-title text-truncate">${escapeHtml(song.title)}</div>
                <div class="search-row-sub text-truncate">${escapeHtml(song.artist)}${song.album ? ` · ${escapeHtml(song.album)}` : ''}${song.year ? ` · ${song.year}` : ''}</div>
              </div>
              <button type="button" class="btn btn-sm lib-ghost-action catalog-song-get-tab-btn flex-shrink-0 ms-2" data-song-id="${song.id}" data-title="${escapeHtml(song.title)}" data-artist="${escapeHtml(song.artist)}" data-album="${escapeHtml(song.album || '')}" data-year="${song.year || ''}" data-recording-mbid="${song.recordingMbid || song.id || ''}" aria-label="Add song and find tab">Add song</button>
            </div>
            `;
        }

        for (const art of weakArtists.slice(0, 2)) html += artistRow(art);

        html += `
          </div>
        </div>
        `;

        catalogContainer.innerHTML = html;
        catalogContainer.style.opacity = '0';
        catalogContainer.style.transition = 'opacity var(--dur-fast, 150ms) ease';
        requestAnimationFrame(() => {
            catalogContainer.style.opacity = '1';
        });

        // Wire catalog action buttons
        catalogContainer.querySelectorAll('.catalog-artist-albums-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                viewArtistCatalogAlbums(btn.dataset.artistId, btn.dataset.artistName, filterResults, rawQuery);
            });
        });

        catalogContainer.querySelectorAll('.search-stream-row[data-type="catalog-artist"]').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('button, a')) return;
                row.querySelector('.catalog-artist-albums-btn')?.click();
            });
        });

        catalogContainer.querySelectorAll('.catalog-album-batch-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleAddAlbumBatch({
                    id: btn.dataset.albumId,
                    title: btn.dataset.albumTitle,
                    artist: btn.dataset.artistName,
                    year: btn.dataset.year
                }, btn);
            });
        });

        catalogContainer.querySelectorAll('.catalog-song-get-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleGetTabSingleSong({
                    id: btn.dataset.songId,
                    title: btn.dataset.title,
                    artist: btn.dataset.artist,
                    album: btn.dataset.album,
                    year: btn.dataset.year,
                    recordingMbid: btn.dataset.recordingMbid
                });
            });
        });
    };

    const runCatalogSearch = async (rawQuery, matchingSongs, allOwnedSongs) => {
        if (!filterResults || filterResults.style.display === 'none') return;
        const statusSlot = filterResults.querySelector('#libSearchCatalogStatus');
        const catalogContainer = filterResults.querySelector('#libSearchCatalogResults');
        if (!catalogContainer || !statusSlot) return;

        if (!navigator.onLine) {
            statusSlot.innerHTML = `<span class="text-muted">Offline · Showing local library results only</span>`;
            statusSlot.style.display = 'flex';
            catalogContainer.innerHTML = '';
            return;
        }

        if (rawQuery.length < 3) {
            statusSlot.innerHTML = '';
            statusSlot.style.display = 'none';
            catalogContainer.innerHTML = '';
            return;
        }

        statusSlot.innerHTML = `<span class="search-catalog-pulse-dot"></span><span>Searching music catalog…</span>`;
        statusSlot.style.display = 'flex';

        if (searchAbortController) searchAbortController.abort();
        searchAbortController = new AbortController();
        const signal = searchAbortController.signal;

        try {
            const [songsRes, albumsRes, artistsRes] = await Promise.allSettled([
                searchMusicBrainz(rawQuery, 'song', { signal }),
                searchMusicBrainz(rawQuery, 'album', { signal }),
                searchMusicBrainz(rawQuery, 'artist', { signal })
            ]);

            if (signal.aborted) return;

            const remoteSongs = songsRes.status === 'fulfilled' && Array.isArray(songsRes.value) ? songsRes.value : [];
            const remoteAlbums = albumsRes.status === 'fulfilled' && Array.isArray(albumsRes.value) ? albumsRes.value : [];
            const remoteArtists = artistsRes.status === 'fulfilled' && Array.isArray(artistsRes.value) ? artistsRes.value : [];

            // Real artist first (exact name, then popularity); tribute/same-name acts are demoted
            const catalogArtists = rankCatalogArtists(remoteArtists, rawQuery);
            const topArtist = catalogArtists[0] || null;

            // Deduplicate against user's owned songs
            const cleanOwnedKeys = new Set(allOwnedSongs.map(s => `${cleanTrackTitleForMatching(s.artist)}___${cleanTrackTitleForMatching(s.title)}`));
            const catalogSongs = rankCatalogSongs(remoteSongs, rawQuery, topArtist).filter(s => !cleanOwnedKeys.has(`${cleanTrackTitleForMatching(s.artist)}___${cleanTrackTitleForMatching(s.title)}`));
            const catalogAlbums = rankCatalogAlbums(remoteAlbums, rawQuery, topArtist);

            renderCatalogTier(catalogSongs, catalogAlbums, catalogArtists, rawQuery);
        } catch (err) {
            if (err.name === 'AbortError') return;
            console.warn('[Master Search] Catalog query error:', err);
            statusSlot.innerHTML = `<span class="text-muted">Unable to reach music catalog</span>`;
        }
    };

    const runLocalFilter = () => {
        const rawQuery = (filterInput.value || '').trim();
        const query = rawQuery.toLowerCase();
        libraryFilterQuery = filterInput.value || '';
        if (clearBtn) clearBtn.style.display = query.length > 0 ? 'inline-flex' : 'none';

        if (!query) {
            if (searchAbortController) searchAbortController.abort();
            if (browseContent) browseContent.style.display = 'block';
            if (filterResults) {
                filterResults.style.display = 'none';
                filterResults.innerHTML = '';
            }
            activeNavIndex = -1;
            return;
        }

        if (browseContent) browseContent.style.display = 'none';
        if (!filterResults) return;
        filterResults.style.display = 'block';

        const matchingSongs = [];
        const allOwnedSongs = [];
        const artistsList = context.artists || [];

        for (const art of artistsList) {
            if (Array.isArray(art.songs)) {
                for (const s of art.songs) {
                    const songObj = { ...s, artist: s.artist || art.name, album: s.album || '' };
                    allOwnedSongs.push(songObj);
                    if (isHideNoTabSongsEnabled() && !songHasTabs(s)) continue;
                    const titleMatch = (s.title || '').toLowerCase().includes(query);
                    const artistMatch = (art.name || '').toLowerCase().includes(query);
                    const tabMatch = (s.tabOptions && s.tabOptions.some(t => (t.name || '').toLowerCase().includes(query))) || songTuningSearchText(s).includes(query);
                    if (titleMatch || artistMatch || tabMatch) {
                        matchingSongs.push(songObj);
                    }
                }
            }
            if (Array.isArray(art.albums)) {
                for (const alb of art.albums) {
                    const albTitle = alb.title || alb.name || '';
                    if (Array.isArray(alb.songs)) {
                        for (const s of alb.songs) {
                            const songObj = { ...s, artist: s.artist || art.name, album: s.album || albTitle, coverUrl: s.coverUrl || alb.coverUrl || null };
                            allOwnedSongs.push(songObj);
                            if (isHideNoTabSongsEnabled() && !songHasTabs(s)) continue;
                            const titleMatch = (s.title || '').toLowerCase().includes(query);
                            const artistMatch = (art.name || '').toLowerCase().includes(query);
                            const tabMatch = (s.tabOptions && s.tabOptions.some(t => (t.name || '').toLowerCase().includes(query))) || songTuningSearchText(s).includes(query);
                            if (titleMatch || artistMatch || tabMatch) {
                                matchingSongs.push(songObj);
                            }
                        }
                    }
                }
            }
        }

        let html = `
        <div class="search-stream-section" id="libLocalSearchSection">
          <div class="search-stream-section-title">
            <span>In your library</span>
            ${matchingSongs.length > 0 ? `<span class="search-stream-count">· ${matchingSongs.length}</span>` : ''}
          </div>
          ${matchingSongs.length > 0 ? `
            <div class="search-stream-list" id="libLocalSearchResultsList">
              ${matchingSongs.slice(0, 10).map(s => {
                const hasTabs = songHasTabs(s);
                const tuningDisplay = visibleTuningLabel(s, s.tabOptions?.[0]?.tuning || s.tuning || '');
                return `
                <div class="search-stream-row is-navigable" data-type="local-song" data-song-id="${s.id}" tabindex="0">
                  ${hasTabs ? `
                  <button type="button" class="btn btn-sm btn-theme-icon play-default-tab-btn flex-shrink-0" data-song-id="${s.id}" title="Play ${escapeHtml(s.title)}">
                    <i class="bi-play-fill fs-5"></i>
                  </button>
                  ` : ''}
                  <div class="search-row-meta min-w-0 flex-grow-1">
                    <div class="search-row-title text-truncate">${escapeHtml(s.title)}</div>
                    <div class="search-row-sub text-truncate">
                      ${escapeHtml(s.artist || '')}${s.album ? ` · ${escapeHtml(s.album)}` : ''}${tuningDisplay ? ` · ${escapeHtml(tuningDisplay)}` : ''}
                    </div>
                  </div>
                  ${hasTabs ? `
                  <button type="button" class="btn btn-sm btn-theme-outline play-default-tab-btn flex-shrink-0 ms-2" data-song-id="${s.id}">Play</button>
                  ` : `
                  <button type="button" class="btn btn-sm lib-ghost-action local-song-find-tab-btn flex-shrink-0 ms-2" data-song-id="${s.id}" data-title="${escapeHtml(s.title)}" data-artist="${escapeHtml(s.artist || '')}" data-album="${escapeHtml(s.album || '')}">Find tab</button>
                  `}
                </div>
                `;
              }).join('')}
            </div>
          ` : `
            <div class="search-stream-empty-text text-muted py-2 px-3">No local songs match "${escapeHtml(rawQuery)}"</div>
          `}
        </div>

        <div class="search-stream-section" id="libTuningSearch" hidden></div>

        <div class="search-stream-section" id="libClasstabSearch" hidden></div>

        <div class="search-catalog-status-slot" id="libSearchCatalogStatus">
          ${!navigator.onLine ? `Offline · Showing local library results only` : (rawQuery.length >= 3 ? `<span class="search-catalog-pulse-dot"></span><span>Searching music catalog…</span>` : '')}
        </div>

        <div class="search-catalog-results" id="libSearchCatalogResults"></div>
        `;

        filterResults.innerHTML = html;

        renderTuningSearchSection(filterResults.querySelector('#libTuningSearch'), rawQuery, (key) => {
            pushLibraryNavigationState();
            libraryBrowseMode = 'tunings';
            selectedTuning = key;
            tuningsArtistFilter = '';
            activeLibraryPane = 'songs';
            libraryFilterQuery = '';
            updateUrl('tunings', null, false);
            renderLibraryBrowseView(container);
        });
        renderClasstabSearchSection(filterResults.querySelector('#libClasstabSearch'), rawQuery);

        // Wire song row play actions
        setupSongRowActions(filterResults);

        // Wire local song find tab buttons
        filterResults.querySelectorAll('.local-song-find-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleGetTabSingleSong({
                    id: btn.dataset.songId,
                    title: btn.dataset.title,
                    artist: btn.dataset.artist,
                    album: btn.dataset.album
                });
            });
        });

        // Wire local song row click
        filterResults.querySelectorAll('.search-stream-row[data-type="local-song"]').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('button, a, input')) return;
                const playBtn = row.querySelector('.play-default-tab-btn');
                const findBtn = row.querySelector('.local-song-find-tab-btn');
                if (playBtn) playBtn.click();
                else if (findBtn) findBtn.click();
            });
        });

        // Trigger catalog query debounce
        clearTimeout(catalogTimer);
        catalogTimer = setTimeout(() => {
            runCatalogSearch(rawQuery, matchingSongs, allOwnedSongs);
        }, 450);
    };

    filterInput.addEventListener('input', () => {
        clearTimeout(localTimer);
        localTimer = setTimeout(runLocalFilter, 50);
    });

    clearBtn?.addEventListener('click', () => {
        filterInput.value = '';
        runLocalFilter();
        filterInput.focus();
    });

    // Keyboard navigation
    filterInput.addEventListener('keydown', (e) => {
        if (!filterResults || filterResults.style.display === 'none') return;
        const rows = Array.from(filterResults.querySelectorAll('.search-stream-row.is-navigable'));

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!rows.length) return;
            activeNavIndex = (activeNavIndex + 1) % rows.length;
            rows.forEach((r, idx) => r.classList.toggle('is-selected', idx === activeNavIndex));
            rows[activeNavIndex]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (!rows.length) return;
            activeNavIndex = activeNavIndex <= 0 ? rows.length - 1 : activeNavIndex - 1;
            rows.forEach((r, idx) => r.classList.toggle('is-selected', idx === activeNavIndex));
            rows[activeNavIndex]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (activeNavIndex >= 0 && activeNavIndex < rows.length) {
                const selectedRow = rows[activeNavIndex];
                const primaryBtn = selectedRow.querySelector('.catalog-song-get-tab-btn, .catalog-album-batch-btn, .catalog-artist-albums-btn, .local-song-find-tab-btn, .play-default-tab-btn');
                if (primaryBtn) primaryBtn.click();
                else selectedRow.click();
            } else {
                // If local matches exist, trigger top local song action
                const topLocalBtn = filterResults.querySelector('#libLocalSearchResultsList .play-default-tab-btn, #libLocalSearchResultsList .local-song-find-tab-btn');
                if (topLocalBtn) {
                    topLocalBtn.click();
                }
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            filterInput.value = '';
            runLocalFilter();
            filterInput.blur();
        }
    });

    // Initial query if any
    if (libraryFilterQuery && !filterInput.value && libraryBrowseMode === 'artists') {
        filterInput.value = libraryFilterQuery;
        runLocalFilter();
    }
}

// Tuning results in the library search: tunings in the library by name or notes ("Drop D", "DADGAD", "D A D G A D"); a row opens it in Tunings
async function renderTuningSearchSection(slot, rawQuery, openTuning) {
    if (!slot) return;
    let groups;
    try {
        groups = (await getLibraryTuningsHierarchy(activeCollectionId)).tunings || [];
    } catch { return; }
    if (!slot.isConnected) return;
    if (isHideNoTabSongsEnabled()) groups = groups.map(g => ({ ...g, songs: (g.songs || []).filter(songHasTabs) })).filter(g => g.songs.length > 0);
    const hits = groups.filter(g => tuningMatchesQuery(g, rawQuery)).slice(0, 8);
    if (!hits.length) return;
    slot.innerHTML = `
      <div class="search-stream-section-title"><span>Tunings</span><span class="search-stream-count">· ${hits.length}</span></div>
      <div class="search-stream-list">
        ${hits.map((g, i) => `<div class="search-stream-row is-navigable" data-tuning-hit="${i}" tabindex="0">
          <div class="search-row-meta min-w-0 flex-grow-1"><div class="search-row-title text-truncate">${escapeHtml(g.name || g.notes)}</div>
          <div class="search-row-sub text-truncate">${escapeHtml(g.notes || '')} · ${formatCount(g.songs.length, 'song')}</div></div>
          <button type="button" class="btn btn-sm lib-ghost-action flex-shrink-0 ms-2" data-tuning-hit="${i}">Open</button></div>`).join('')}
      </div>`;
    slot.hidden = false;
    slot.addEventListener('click', (e) => {
        const el = e.target.closest('[data-tuning-hit]');
        if (el) openTuning(hits[Number(el.dataset.tuningHit)].key);
    });
    slot.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('.search-stream-row')) e.target.click();
    });
}

// Classical tab results in the library search: pieces and composers from the installed archive (nothing when there is none)
async function renderClasstabSearchSection(slot, rawQuery) {
    if (!slot) return;
    let res;
    try {
        res = await (await import('./classtab/search.js')).searchClasstab(rawQuery);
    } catch { return; }
    if (!res || !slot.isConnected || !res.total) return;
    const { nameParts } = await import('./classtab/catalog.js');
    const nameHtml = (name) => { const p = nameParts(name); return `${escapeHtml(p.before)}${p.key ? `<b>${escapeHtml(p.key)}</b>` : ''}${escapeHtml(p.after)}`; };
    const pin = (on) => (on ? '<i class="bi-pin-angle-fill" aria-label="Pinned"></i> ' : '');
    slot.innerHTML = `
      <div class="search-stream-section-title"><span>Classical tab browser</span><span class="search-stream-count">· ${res.total.toLocaleString()}</span></div>
      <div class="search-stream-list">
        ${res.composers.map((c) => `<div class="search-stream-row is-navigable" data-ct-composer="${escapeHtml(c.name)}" tabindex="0">
          <div class="search-row-meta min-w-0 flex-grow-1"><div class="search-row-title text-truncate">${pin(c.pinned)}${nameHtml(c.name)}</div>
          <div class="search-row-sub text-truncate">Composer · ${c.count.toLocaleString()} ${c.count === 1 ? 'piece' : 'pieces'}</div></div>
          <button type="button" class="btn btn-sm lib-ghost-action flex-shrink-0 ms-2" data-ct-composer="${escapeHtml(c.name)}">Browse</button></div>`).join('')}
        ${res.pieces.map((m, i) => `<div class="search-stream-row is-navigable" data-ct-piece="${i}" tabindex="0">
          <div class="search-row-meta min-w-0 flex-grow-1"><div class="search-row-title text-truncate">${pin(m.pinned)}${escapeHtml(m.piece.title)}</div>
          <div class="search-row-sub text-truncate">${escapeHtml(m.composer.name)}</div></div>
          <button type="button" class="btn btn-sm btn-theme-outline flex-shrink-0 ms-2" data-ct-open="${i}">Open</button></div>`).join('')}
        ${res.total > res.pieces.length ? `<div class="search-stream-row is-navigable" data-ct-all tabindex="0"><div class="search-row-meta flex-grow-1"><div class="search-row-title">See all ${res.total.toLocaleString()} in Classical tab</div></div></div>` : ''}
      </div>`;
    slot.hidden = false;
    const goTool = async (query) => {
        const { requestClasstabView } = await import('./classtab/classtabTool.js');
        const { openToolOnNextRender } = await import('./utils/toolsPage.js');
        requestClasstabView({ query });
        openToolOnNextRender('classtab');
        libraryFilterQuery = '';
        await goLibraryTab('tools');
    };
    const open = async (i) => {
        try {
            const m = res.pieces[i];
            await (await import('./classtab/classtabTool.js')).openPiece(m.piece, m.composer);
        } catch (err) { showToast(err?.message || 'Could not open that piece.', 'error'); }
    };
    slot.addEventListener('click', (e) => {
        const openBtn = e.target.closest('[data-ct-open]');
        if (openBtn) { open(Number(openBtn.dataset.ctOpen)); return; }
        const row = e.target.closest('[data-ct-piece]');
        if (row) { open(Number(row.dataset.ctPiece)); return; }
        const comp = e.target.closest('[data-ct-composer]');
        if (comp) { goTool(comp.dataset.ctComposer); return; }
        if (e.target.closest('[data-ct-all]')) goTool(rawQuery);
    });
    slot.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('.search-stream-row')) e.target.click();
    });
}

function renderArtistCollageHtml(artist) {
    const isCustom = Boolean(artist.isCustom);
    const covers = Array.from(new Set(
        (artist.albums || []).map(a => getSynchronousCachedArtUrl(a.coverUrl) || a.coverUrl).filter(Boolean)
    )).slice(0, 4);

    if (covers.length === 0) {
        if (isCustom) {
            return `<div class="artist-thumbnail artist-thumbnail-empty flex-shrink-0 d-flex align-items-center justify-content-center" style="background: rgba(255, 255, 255, 0.05); border-radius: 50%;"><i class="bi-music-note-list text-info fs-4"></i></div>`;
        }
        return `<img loading="lazy" decoding="async" src="${getPlaceholderCoverSvg(artist.name)}" class="artist-thumbnail flex-shrink-0" alt="${escapeHtml(artist.name)}" draggable="false">`;
    }

    if (covers.length === 1) {
        return `<div class="artist-thumbnail artist-thumbnail-collage artist-collage-1 flex-shrink-0"><img loading="lazy" decoding="async" src="${covers[0]}" class="artist-collage-img" alt="${escapeHtml(artist.name)}" draggable="false" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(artist.name)}'"></div>`;
    }

    if (covers.length === 2) {
        return `
        <div class="artist-thumbnail artist-thumbnail-collage artist-collage-2 flex-shrink-0" title="${escapeHtml(artist.name)}">
          <img loading="lazy" decoding="async" src="${covers[0]}" class="artist-collage-img" alt="" draggable="false" onerror="this.style.display='none'">
          <img loading="lazy" decoding="async" src="${covers[1]}" class="artist-collage-img" alt="" draggable="false" onerror="this.style.display='none'">
        </div>`;
    }

    if (covers.length === 3) {
        return `
        <div class="artist-thumbnail artist-thumbnail-collage artist-collage-3 flex-shrink-0" title="${escapeHtml(artist.name)}">
          <img loading="lazy" decoding="async" src="${covers[0]}" class="artist-collage-img" alt="" draggable="false" onerror="this.style.display='none'">
          <img loading="lazy" decoding="async" src="${covers[1]}" class="artist-collage-img" alt="" draggable="false" onerror="this.style.display='none'">
          <img loading="lazy" decoding="async" src="${covers[2]}" class="artist-collage-img artist-collage-span-2" alt="" draggable="false" onerror="this.style.display='none'">
        </div>`;
    }

    return `
    <div class="artist-thumbnail artist-thumbnail-collage artist-collage-4 flex-shrink-0" title="${escapeHtml(artist.name)}">
      <img loading="lazy" decoding="async" src="${covers[0]}" class="artist-collage-img" alt="" draggable="false" onerror="this.style.display='none'">
      <img loading="lazy" decoding="async" src="${covers[1]}" class="artist-collage-img" alt="" draggable="false" onerror="this.style.display='none'">
      <img loading="lazy" decoding="async" src="${covers[2]}" class="artist-collage-img" alt="" draggable="false" onerror="this.style.display='none'">
      <img loading="lazy" decoding="async" src="${covers[3]}" class="artist-collage-img" alt="" draggable="false" onerror="this.style.display='none'">
    </div>`;
}

function renderPinnedSongTile(song) {
    const artistName = song.artist || '';
    const albumName = song.album || '';
    const subtext = [artistName, albumName].filter(Boolean).join(' • ');
    const coverUrl = getSynchronousCachedArtUrl(song.coverUrl) || song.coverUrl;

    return `
    <div class="library-pinned-card d-flex align-items-center gap-2 p-2 rounded-3 position-relative" 
         data-song-id="${song.id}" 
         data-song-title="${escapeHtml(song.title)}" 
         data-song-artist="${escapeHtml(artistName)}" 
         data-song-album="${escapeHtml(albumName)}"
         role="button"
         tabindex="0">
      
      <div class="pinned-play-badge flex-shrink-0 ${coverUrl ? 'has-cover' : ''}">
        ${coverUrl ? `
          <img loading="lazy" decoding="async" src="${coverUrl}" class="pinned-cover-img" alt="" draggable="false" onerror="this.style.display='none'; this.parentElement.classList.remove('has-cover');">
          <div class="pinned-play-scrim"></div>
        ` : ''}
        <i class="bi-play-fill pinned-play-icon"></i>
      </div>

      <div class="min-w-0 flex-grow-1 pinned-info-zone">
        <div class="fw-bold text-white text-truncate song-title" style="font-size: 0.88rem;">${escapeHtml(song.title)}</div>
        <div class="small text-muted text-truncate song-subtitle" style="font-size: 0.72rem;">${escapeHtml(subtext || 'Unknown Artist')}</div>
      </div>

      <div class="d-flex align-items-center gap-1 flex-shrink-0 ms-1">
        ${(artistName || albumName) ? `
          <button type="button" class="btn btn-sm btn-theme-icon navigate-to-album-btn p-1 px-2" 
                  data-song-id="${song.id}"
                  data-artist-name="${escapeHtml(artistName)}" 
                  data-album-title="${escapeHtml(albumName)}" 
                  title="${albumName ? `Go to album: ${escapeHtml(albumName)}` : `Go to artist: ${escapeHtml(artistName)}`}">
            <i class="bi-folder2-open text-info"></i>
          </button>
        ` : ''}

        <button type="button" class="btn btn-sm btn-theme-icon pin-song-btn text-warning p-1 px-2" 
                data-song-id="${song.id}" 
                title="Unpin from collection">
          <i class="bi-pin-angle-fill"></i>
        </button>
      </div>
    </div>
    `;
}

// Folder title that keys book PDFs; the Custom Music root has no album, so it uses a sentinel the hierarchy treats as root
function getBookFolderTitle() {
    if (selectedAlbum) return selectedAlbum.title;
    if (selectedAlbumFilter && selectedAlbumFilter !== 'all' && selectedAlbumFilter !== 'other') return selectedAlbumFilter;
    if (selectedArtist?.isCustom && selectedFolderPath.length === 0) return 'Custom Music';
    return null;
}

// "p. 152" for a single page, "pp. 152-155" for a range
function formatPageRange(start, end) {
    return start && end && String(start) !== String(end) ? `pp. ${start}\u2013${end}` : `p. ${start || end}`;
}

// Opens a source for a song's tab: the file picker or URL box, Drive, or the tab downloader prefilled with the song
function importTabFromProvider(songId, providerId) {
    if (providerId === 'local' || providerId === 'url') {
        openFromProvider(providerId, { songId });
        return;
    }
    // @googleDrive:begin
    if (providerId === 'google-drive') {
        getSongById(songId).then(song => {
            openFromProvider('google-drive', {
                songId,
                targetSong: song,
                songName: song?.title,
                artist: song?.artist,
                query: song ? `${song.artist} ${song.title}` : ''
            });
        }).catch(() => {
            openFromProvider('google-drive', { songId });
        });
        return;
    }
    // @googleDrive:end
    getSongById(songId).then(song => {
        if (!song) return;
        openFromProvider(providerId, {
            songId: song.id,
            targetSong: song,
            songName: song.title,
            artist: song.artist,
            query: `${song.artist} ${song.title}`
        });
    });
}

// Pick the whole-album PDF and the page range for a song's tab (new range, or edit the one on `tabId`)
async function openAlbumPdfPagesFor(songId, tabId) {
    const song = await getSongById(songId);
    if (!song) return;
    const albumTabs = (selectedArtist && selectedAlbum)
        ? await getAlbumTabOptions(activeCollectionId, selectedArtist.name, selectedAlbum.title)
        : [];
    let albumPdfTabs = albumTabs.filter(t => (t.name || '').toLowerCase().endsWith('.pdf') || t.isPdf || t.fileType === 'pdf');
    const existingTab = tabId ? song.tabOptions?.find(t => t.id === tabId) : (song.tabOptions?.find(t => t.isAlbumRange || t.startPage) || null);
    if (albumPdfTabs.length === 0 && existingTab?.fileStoreId) {
        albumPdfTabs = [{
            id: existingTab.fileStoreId,
            name: existingTab.name?.replace(/\s*\(pp\.\s*\d+-\d+\)/, '') || 'Album PDF',
            fileStoreId: existingTab.fileStoreId,
            relativePath: existingTab.relativePath,
            fileType: 'pdf'
        }];
    }
    if (albumPdfTabs.length === 0) {
        showToast('No whole-album PDF found for this album.', 'warning');
        return;
    }
    openSetAlbumPdfPagesModal(song, albumPdfTabs, existingTab, { isCustom: Boolean(selectedArtist?.isCustom) });
}

// One panel for adding, choosing and managing a song's tabs, so the row stays one line however many there are
async function toggleSongTabsPicker(anchor, songId, mode, { forceOpen = false } = {}) {
    if (!forceOpen && anchor.getAttribute('aria-expanded') === 'true' && isSongTabPickerOpen()) {
        closeSongTabPicker();
        return;
    }
    const song = await getSongById(songId);
    if (!song) return;
    const providers = getFileProviders().map(p => ({ id: p.id, name: p.name }));
    openSongTabPicker({
        anchor,
        song,
        mode,
        providers,
        canEditRange: true,
        isSynced: (t) => songHasSyncPoints(t.name) || Boolean(t.syncedAudio),
        tabMeta: (t) => {
            const tuning = (t.tuning && isTuningMatchingInstrument(t.tuning)) ? visibleTuningLabel(song, t.tuning) : '';
            return [(t.startPage && t.endPage) ? formatPageRange(t.startPage, t.endPage) : '', tuning].filter(Boolean).join(' \u00b7 ');
        },
        on: {
            openTab: (tab) => loadSongTab(song, tab),
            makeDefault: async (tabId) => { await setDefaultTabOption(songId, tabId); showToast('Set default tab', 'success'); await renderView(); },
            removeTab: async (tabId) => { await removeTabOptionFromSong(songId, tabId); await renderView(); },
            editRange: (tab) => openAlbumPdfPagesFor(songId, tab.id),
            addFrom: (providerId) => importTabFromProvider(songId, providerId)
        }
    });
}

function renderSongRow(song, options = {}) {
    if (isHideNoTabSongsEnabled() && !options.forceShow && (!song?.tabOptions || song.tabOptions.length === 0)) {
        return '';
    }
    const pdfPagesNoun = selectedArtist?.isCustom ? 'Book' : 'Album';
    const tabOptions = Array.isArray(song.tabOptions) ? song.tabOptions : [];
    const hasTabs = tabOptions.length > 0;
    const tunings = visibleTuningsForSong(song, Array.isArray(song.tunings) ? song.tunings : []).filter(t => isTuningMatchingInstrument(t));
    const durationText = formatTrackDuration(song.length);
    const isPinned = Boolean(song.pinned);
    const defaultTabId = song.defaultTabId || (tabOptions[0]?.id || null);
    const albumPdfTabs = (options.albumTabs || []).filter(t => (t.name || '').toLowerCase().endsWith('.pdf') || t.isPdf || t.fileType === 'pdf');
    const hasMenu = hasTabs || albumPdfTabs.length > 0 || isAlbumEditMode;
    const showTrackNumber = options.showTrackNumber !== undefined ? options.showTrackNumber : !options.showArtistAlbum;

    let trackNumStr = '•';
    if (showTrackNumber) {
        if (typeof song.trackNumber === 'number' || (typeof song.trackNumber === 'string' && /^\d+$/.test(song.trackNumber.trim()))) {
            const num = parseInt(song.trackNumber, 10);
            trackNumStr = num < 10 ? `0${num}` : `${num}`;
        } else if (song.trackNumber) {
            trackNumStr = song.trackNumber;
        }
    }

    // The row's meta describes the song, not each tab: the default tab's tuning, and "+n" when other tabs differ
    const defaultTabOpt = tabOptions.find(t => t.id === defaultTabId) || tabOptions[0] || null;
    const defaultTuning = defaultTabOpt?.tuning && tunings.includes(defaultTabOpt.tuning) ? defaultTabOpt.tuning : null;
    const primaryTuning = defaultTuning || tunings[0] || null;
    const shownTunings = primaryTuning ? [primaryTuning] : [];
    const hiddenTunings = tunings.length - shownTunings.length;
    const tuningChipsHtml = shownTunings.map(t => {
        const info = getTuningInfo(t);
        const label = info?.displayName || t;
        const isStandard = label.toLowerCase().includes('standard');
        const more = hiddenTunings > 0 ? ` (+${hiddenTunings})` : '';
        const title = hiddenTunings > 0 ? ` title="${hiddenTunings} other ${hiddenTunings === 1 ? 'tuning' : 'tunings'}"` : '';
        return `<span class="chip ${isStandard ? '' : 'hot'}"${title}>${escapeHtml(label)}${more}</span>`;
    }).join('');

    const pdfTab = (defaultTabOpt?.startPage && defaultTabOpt?.endPage) ? defaultTabOpt : tabOptions.find(t => t.startPage && t.endPage);
    const pdfChipHtml = pdfTab ? `<span class="chip sec">${formatPageRange(pdfTab.startPage, pdfTab.endPage)}</span>` : '';

    // One tab is the normal state and says nothing; no tab is a plain grey fact; the count of several lives on the row's action
    const multiTabsChipHtml = hasTabs ? '' : `<span class="chip no-tab">No tab yet</span>`;

    const songKeys = [
        [song.artist, song.title].filter(Boolean).join(' - '),
        song.title,
        ...(song.tabOptions || []).map(t => t.name)
    ].filter(Boolean);
    const hasSyncPoints = songKeys.some(k => songHasSyncPoints(k));
    const isSynced = Boolean(hasSyncPoints || song.hasSyncedAudio || song.syncedAudioUrl || (song.tabOptions && song.tabOptions.some(t => t.syncedAudio)));
    // File type and audio, as plain grey text: "GP5 · PDF", "Synth · Recording". Synth exists for Guitar Pro tabs only.
    const tabFormat = (t) => {
        if (t.isPdf || t.startPage || t.isAlbumRange) return 'PDF';
        const ext = (t.fileType || ((t.name || '').includes('.') ? t.name.split('.').pop() : '')).toLowerCase();
        if (ext === 'pdf') return 'PDF';
        if (ext === 'txt') return 'Text';
        if (/^(gp|gp[3-8]|gpx)$/.test(ext)) return 'GP';
        return '';
    };
    const formats = [...new Set(tabOptions.map(tabFormat).filter(Boolean))];
    const hasSynth = Boolean(song.synthMidi) || formats.some(f => f !== 'PDF' && f !== 'Text');
    const audioLabels = [hasSynth ? 'Synth' : '', isSynced ? 'Recording' : ''].filter(Boolean);
    const formatChipHtml = formats.length ? `<span class="chip sec song-format">${escapeHtml(formats.join(' / '))}</span>` : '';
    const audioChipHtml = audioLabels.length ? `<span class="chip sec song-audio">${escapeHtml(audioLabels.join(' + '))}</span>` : '';
    const syncDotHtml = '';

    return `
    <div class="rowwrap library-song-rowwrap ${isPinned ? 'library-song-row-pinned' : ''} ${!hasTabs ? 'no-tab' : ''}">
      <div class="song-row-container">
        <div class="song-row library-song-row ${!hasTabs ? 'no-tab' : ''}" data-song-id="${song.id}" data-song-title="${escapeHtml(song.title)}" data-song-artist="${escapeHtml(song.artist || '')}" role="button" tabindex="0">
          ${trackNumStr === '\u2022' ? '' : `<span class="num tnum">${trackNumStr}</span>`}
          ${options.showCover ? `<img loading="lazy" decoding="async" class="song-cover" src="${getSynchronousCachedArtUrl(song.coverUrl) || song.coverUrl || getPlaceholderCoverSvg(song.album || song.title || 'Tab')}" alt="" draggable="false" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(song.title || 'Tab')}'">` : ''}
          <span class="t">
            <b>${escapeHtml(song.title)}</b>
            <span class="sub">
              ${options.showArtistAlbum ? ([song.artist, options.hideAlbum ? '' : song.album].filter(Boolean).length ? `<span class="album-label text-truncate">${escapeHtml([song.artist, options.hideAlbum ? '' : song.album].filter(Boolean).join(' · '))}</span>` : '') : (options.showAlbum && song.album ? `<span class="album-label text-truncate">${escapeHtml(song.album)}</span>` : '')}
              ${tuningChipsHtml}
              ${pdfChipHtml}
              ${formatChipHtml}
              ${audioChipHtml}
              ${multiTabsChipHtml}
              ${syncDotHtml}
            </span>
          </span>
          ${durationText ? `<span class="end tnum">${durationText}</span>` : ''}
          ${hasTabs ? `<button type="button" class="play-default-tab-btn visually-hidden" data-song-id="${song.id}" aria-label="Play ${escapeHtml(song.title)}"></button>` : ''}
        </div>
        <div class="song-actions">
          ${!hasTabs
            ? `<button type="button" class="song-tabs-btn song-tabs-add" data-song-id="${song.id}" data-tabs-mode="add" aria-haspopup="dialog" aria-expanded="false">Add tab</button>`
            : tabOptions.length > 1
              ? `<button type="button" class="song-tabs-btn" data-song-id="${song.id}" data-tabs-mode="list" aria-haspopup="dialog" aria-expanded="false" aria-label="${tabOptions.length} tabs for ${escapeHtml(song.title)}. Choose one">${tabOptions.length} tabs <span class="song-tabs-chev" aria-hidden="true">\u203a</span></button>`
              : '<span class="song-tabs-spacer" aria-hidden="true"></span>'}
          <button type="button" class="btn btn-sm btn-theme-icon pin-song-btn ${isPinned ? 'text-warning' : 'text-muted'}" data-song-id="${song.id}" title="${isPinned ? 'Unpin song from collection' : 'Pin song to collection'}" aria-label="${isPinned ? 'Unpin song' : 'Pin song'}" aria-pressed="${isPinned}">
            <i class="bi-pin-angle${isPinned ? '-fill' : ''}"></i>
          </button>
          ${hasMenu ? `<div class="dropdown">
            <button class="btn btn-sm btn-theme-icon text-muted dropdown-toggle" type="button" data-bs-toggle="dropdown" data-bs-popper-config='{"strategy":"fixed"}' aria-expanded="false" title="Song options" aria-label="Song options">
              <i class="bi-three-dots"></i>
            </button>
            <ul class="dropdown-menu dropdown-menu-end theme-dropdown-menu">
              ${hasTabs ? `<li><button class="dropdown-item small add-to-setlist-btn" data-song-id="${song.id}">Add to setlist</button></li>` : ''}
              ${hasTabs ? `<li><button class="dropdown-item small song-tabs-menu-btn" data-song-id="${song.id}" data-tabs-mode="add">Add another tab\u2026</button></li>
              <li><button class="dropdown-item small song-tabs-menu-btn" data-song-id="${song.id}" data-tabs-mode="manage">Manage tabs\u2026</button></li>` : ''}
              ${albumPdfTabs.length > 0 ? (() => {
                const existingPdfTab = tabOptions.find(t => t.isAlbumRange || t.startPage);
                return `${hasTabs ? '<li><hr class="dropdown-divider"></li>' : ''}<li><button class="dropdown-item small set-album-pdf-pages-btn" data-song-id="${song.id}"${existingPdfTab ? ` data-tab-id="${existingPdfTab.id}"` : ''}>${existingPdfTab ? 'Edit' : 'Set'} ${pdfPagesNoun} PDF pages\u2026</button></li>`;
              })() : ''}
              ${isAlbumEditMode ? `
                <li><hr class="dropdown-divider"></li>
                <li><button class="dropdown-item small text-danger delete-song-btn" data-song-id="${song.id}">Remove from library</button></li>
              ` : ''}
            </ul>
          </div>` : '<span class="song-actions-spacer" aria-hidden="true"></span>'}
          ${isAlbumEditMode ? `
            <button type="button" class="btn btn-sm btn-theme-danger p-1 px-2 delete-song-btn ms-1" data-song-id="${song.id}" title="Remove song from library">
              <i class="bi-trash"></i>
            </button>
          ` : ''}
        </div>
      </div>
    </div>
    `;
}

export function renderSongList(songs, options = {}) {
    return renderAlbumSongsList(songs, options);
}

function renderAlbumSongsList(songs, options = {}) {
    const hasCd = (songs || []).some(s => !isDvdOrBlurayMedium(s) && !isVinylOrTapeMedium(s));
    let cleanSongs = (songs || []).filter(s => !isDvdOrBlurayMedium(s) && !(hasCd && isVinylOrTapeMedium(s)));
    cleanSongs = filterInstrumentalBonusDiscs(cleanSongs);
    if (isHideNoTabSongsEnabled()) {
        cleanSongs = cleanSongs.filter(songHasTabs);
    }
    if (!cleanSongs || cleanSongs.length === 0) {
        return `<div class="text-muted p-4 text-center">${isHideNoTabSongsEnabled() ? 'No songs with tabs in this album.' : 'No songs in this album.'}</div>`;
    }

    // Group songs by mediumNumber
    const mediaGroups = new Map();
    for (const song of cleanSongs) {
        const medNum = song.mediumNumber || 1;
        if (!mediaGroups.has(medNum)) {
            mediaGroups.set(medNum, {
                mediumNumber: medNum,
                mediumTitle: song.mediumTitle || '',
                mediumFormat: song.mediumFormat || 'CD',
                songs: []
            });
        }
        const grp = mediaGroups.get(medNum);
        if (!grp.mediumTitle && song.mediumTitle) grp.mediumTitle = song.mediumTitle;
        if (!grp.mediumFormat && song.mediumFormat) grp.mediumFormat = song.mediumFormat;
        grp.songs.push(song);
    }

    const groups = Array.from(mediaGroups.values()).sort((a, b) => a.mediumNumber - b.mediumNumber);

    // If only 1 medium and no specific medium title, render song rows directly
    if (groups.length === 1 && !groups[0].mediumTitle) {
        return groups[0].songs.map(song => renderSongRow(song, options)).join('');
    }

    // Multi-disc / multi-medium rendering
    return groups.map(grp => {
        const formatLabel = grp.mediumFormat || 'CD';
        const discTitle = grp.mediumTitle ? `: ${escapeHtml(grp.mediumTitle)}` : '';
        const headerText = `${formatLabel} ${grp.mediumNumber}${discTitle}`;

        return `
        <div class="library-medium-section mb-2">
          <div class="library-disc-header d-flex align-items-center gap-2 py-2 px-3 mb-2">
            <i class="bi-disc text-accent"></i>
            <span class="fw-bold small text-white text-uppercase" style="letter-spacing: 0.04em; font-size: 0.78rem;">${headerText}</span>
            <span class="badge-theme-secondary ms-auto text-muted">${grp.songs.length} ${grp.songs.length === 1 ? 'Track' : 'Tracks'}</span>
          </div>
          <div class="d-flex flex-column gap-2">
            ${grp.songs.map(song => renderSongRow(song, options)).join('')}
          </div>
        </div>
        `;
    }).join('');
}

function setupSongRowActions(container) {
    // Toggle Album Edit Mode
    container.querySelectorAll('.toggle-album-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            isAlbumEditMode = !isAlbumEditMode;
            renderLibraryBrowseView(container);
        });
    });

    // Delete Entire Album
    container.querySelectorAll('.delete-album-btn, #deleteAlbumBtn').forEach(deleteAlbumBtn => {
        deleteAlbumBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const albumTitle = deleteAlbumBtn.dataset.albumTitle || selectedAlbum?.title;
            if (!selectedArtist || !albumTitle) return;
            const targetAlb = selectedArtist.albums?.find(a => a.title === albumTitle) || selectedAlbum;
            if (!targetAlb) return;

            if (deleteAlbumBtn.dataset.confirming === 'true') {
                const songIds = (targetAlb.songs || []).map(s => s.id);
                await deleteAlbumFromLibrary(selectedArtist.name, targetAlb.title, activeCollectionId, songIds);
                if (selectedAlbum?.title === albumTitle) selectedAlbum = null;
                if (selectedAlbumFilter === albumTitle) selectedAlbumFilter = 'all';
                isAlbumEditMode = false;
                await renderView();
            } else {
                deleteAlbumBtn.dataset.confirming = 'true';
                const origHtml = deleteAlbumBtn.innerHTML;
                deleteAlbumBtn.innerHTML = '<i class="bi-exclamation-triangle-fill me-1"></i> <span class="d-none d-sm-inline">Confirm Delete Album?</span><span class="d-inline d-sm-none">Confirm?</span>';
                setTimeout(() => {
                    if (deleteAlbumBtn.dataset.confirming === 'true') {
                        deleteAlbumBtn.dataset.confirming = 'false';
                        deleteAlbumBtn.innerHTML = origHtml;
                    }
                }, 4000);
            }
        });
    });

    // Add song's default tab to a setlist
    container.querySelectorAll('.add-to-setlist-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const song = await getSongById(btn.dataset.songId);
            const tab = song?.tabOptions && ((song.defaultTabId && song.tabOptions.find(t => t.id === song.defaultTabId)) || song.tabOptions[0]);
            if (song && tab) openAddToSetlistModal({ songId: song.id, tabId: tab.id, title: song.title });
        });
    });

    // Toggle Pin Song
    container.querySelectorAll('.pin-song-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const songId = btn.dataset.songId;
            const pinned = await togglePinSong(songId);
            showToast(pinned ? 'Song pinned to collection' : 'Song unpinned from collection', 'info');
            await renderView();
        });
    });

    // Navigate to Album / Folder from Pinned Song Tile
    container.querySelectorAll('.navigate-to-album-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const songId = btn.dataset.songId;
            const artistName = btn.dataset.artistName;
            const albumTitle = btn.dataset.albumTitle;

            const hierarchy = await getLibraryHierarchy(activeCollectionId);
            const artists = hierarchy.artists || [];

            const targetArtist = artists.find(a => a.name === artistName) ||
                                 artists.find(a => (a.songs && a.songs.some(s => s.id === songId)) ||
                                                  (a.albums && a.albums.some(al => al.songs && al.songs.some(s => s.id === songId))));
            if (targetArtist) {
                selectedArtist = targetArtist;
                if (albumTitle) {
                    selectedAlbum = targetArtist.albums?.find(a => a.title === albumTitle || a.name === albumTitle || a.folderPath === albumTitle) || null;
                    selectedFolderPath = selectedAlbum ? (selectedAlbum.folderPath && selectedAlbum.isCustom ? selectedAlbum.folderPath.split('/') : [selectedAlbum.title || selectedAlbum.name]) : [];
                } else {
                    selectedAlbum = null;
                    selectedFolderPath = [];
                }
                isAlbumEditMode = false;
                await renderLibraryBrowseView(container);
            }
        });
    });

    // Pinned Card Click -> Play Default Tab or Jump to Album
    container.querySelectorAll('.library-pinned-card').forEach(card => {
        card.addEventListener('click', async (e) => {
            if (e.target.closest('.navigate-to-album-btn') || e.target.closest('.pin-song-btn')) return;
            const songId = card.dataset.songId;
            const song = await getSongById(songId);
            if (song && song.tabOptions?.length > 0) {
                const targetTab = (song.defaultTabId && song.tabOptions.find(t => t.id === song.defaultTabId)) || song.tabOptions[0];
                await loadSongTab(song, targetTab);
            } else if (song) {
                const artistName = card.dataset.songArtist;
                const albumTitle = card.dataset.songAlbum;
                const hierarchy = await getLibraryHierarchy(activeCollectionId);
                const artists = hierarchy.artists || [];
                const targetArtist = artists.find(a => a.name === artistName);
                if (targetArtist) {
                    selectedArtist = targetArtist;
                    selectedAlbum = targetArtist.albums?.find(a => a.title === albumTitle || a.name === albumTitle) || null;
                    selectedFolderPath = selectedAlbum ? [selectedAlbum.title || selectedAlbum.name] : [];
                    isAlbumEditMode = false;
                    await renderLibraryBrowseView(container);
                } else {
                    showToast('No tab attached to this song yet', 'info');
                }
            }
        });
    });

    // Play default tab
    container.querySelectorAll('.play-default-tab-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const songId = btn.dataset.songId;
            const song = await getSongById(songId);
            if (song && song.tabOptions?.length > 0) {
                const targetTab = (song.defaultTabId && song.tabOptions.find(t => t.id === song.defaultTabId)) || song.tabOptions[0];
                await loadSongTab(song, targetTab);
            }
        });
    });

    // Tab picker: "Add tab" (no tabs), "n tabs" (several) and the row menu's Add / Manage items
    container.querySelectorAll('.song-tabs-btn').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); toggleSongTabsPicker(btn, btn.dataset.songId, btn.dataset.tabsMode); });
    });
    container.querySelectorAll('.song-tabs-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            // The menu closes as the item is pressed; the picker returns focus to the row's menu button
            const anchor = btn.closest('.dropdown')?.querySelector('.dropdown-toggle') || btn;
            toggleSongTabsPicker(anchor, btn.dataset.songId, btn.dataset.tabsMode, { forceOpen: true });
        });
    });

    // Set Album PDF page range for song
    container.querySelectorAll('.set-album-pdf-pages-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openAlbumPdfPagesFor(btn.dataset.songId, btn.dataset.tabId);
        });
    });

    // Create songs from page ranges of a whole-book PDF in a custom folder
    container.querySelector('#addSongsFromBookPdfBtn')?.addEventListener('click', async () => {
        const folderTitle = getBookFolderTitle();
        if (!selectedArtist || !folderTitle) return;
        const albumTabs = await getAlbumTabOptions(activeCollectionId, selectedArtist.name, folderTitle);
        const bookPdfs = albumTabs.filter(t => (t.name || '').toLowerCase().endsWith('.pdf') || t.fileType === 'pdf');
        openBookPdfSongsModal(selectedArtist.name, { title: folderTitle === 'Custom Music' && !selectedAlbum ? '' : folderTitle }, bookPdfs);
    });

    // Batch Find Tabs from Library Album Block
    container.querySelectorAll('.batch-album-find-tabs-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const albumTitle = btn.dataset.albumTitle;
            const artistName = btn.dataset.artistName;
            const targetAlb = selectedArtist?.albums?.find(a => a.title === albumTitle) || selectedAlbum;
            if (targetAlb) {
                handleAddAlbumBatch({ ...targetAlb, artist: artistName, title: albumTitle }, btn);
            }
        });
    });

    // Explore Tracklist from Library Album Detail View
    container.querySelectorAll('.explore-album-tracklist-btn, #exploreLibAlbumTracklistBtn').forEach(exploreLibBtn => {
        exploreLibBtn.addEventListener('click', async () => {
            const albumTitle = exploreLibBtn.dataset.albumTitle || selectedAlbum?.title;
            const targetAlb = selectedArtist?.albums?.find(a => a.title === albumTitle) || selectedAlbum;
            if (!selectedArtist || !targetAlb) return;
            const origHtml = exploreLibBtn.innerHTML;
            exploreLibBtn.disabled = true;
            exploreLibBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status"></span> Looking up...';

            try {
                let releaseGroupMbid = targetAlb.albumMbid || targetAlb.songs?.find(s => s.albumMbid)?.albumMbid;
                if (!releaseGroupMbid) {
                    const q = `${selectedArtist.name} ${targetAlb.title}`;
                    const results = await searchMusicBrainz(q, 'album');
                    const match = results.find(r => (r.title || '').toLowerCase() === targetAlb.title.toLowerCase()) || results[0];
                    if (match) {
                        releaseGroupMbid = match.id;
                    }
                }

                if (!releaseGroupMbid) {
                    showToast(`Could not find "${targetAlb.title}" on MusicBrainz.`, 'warning');
                    exploreLibBtn.innerHTML = origHtml;
                    exploreLibBtn.disabled = false;
                    return;
                }

                // Save library view state to viewHistory
                viewHistory.push({
                    view: 'library',
                    libraryBrowseMode,
                    selectedArtist,
                    selectedAlbum: targetAlb,
                    selectedAlbumFilter,
                    selectedFolderPath: [...selectedFolderPath],
                    selectedTuning
                });

                searchSubView = { type: 'tracks', releaseGroupMbid, fromView: 'library' };
                const content = document.getElementById('libraryModalContent') || container;
                await exploreAlbumTracklist(releaseGroupMbid, content, false);
            } catch (err) {
                console.error('Failed to explore album tracklist:', err);
                showToast(`Failed to load tracklist: ${err.message}`, 'error');
                exploreLibBtn.innerHTML = origHtml;
                exploreLibBtn.disabled = false;
            }
        });
    });

    // Album Tabs Actions
    container.querySelectorAll('.import-album-tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const folderTitle = btn.dataset.albumTitle || getBookFolderTitle();
            if (!selectedArtist || !folderTitle) return;
            openFromProvider(btn.dataset.providerId, {
                isAlbumTab: true,
                collectionId: activeCollectionId,
                artistName: selectedArtist.name,
                albumTitle: folderTitle,
                artist: selectedArtist.name,
                songName: folderTitle,
                query: `${selectedArtist.name} ${folderTitle}`
            });
        });
    });

    container.querySelectorAll('.play-album-tab-chip-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            if (e.target.closest('.remove-album-tab-chip-btn') || e.target.closest('.set-default-album-tab-btn')) return;
            e.stopPropagation();
            const folderTitle = btn.dataset.albumTitle || getBookFolderTitle();
            if (!selectedArtist || !folderTitle) return;
            const tabId = btn.dataset.tabId;
            const albumTabs = await getAlbumTabOptions(activeCollectionId, selectedArtist.name, folderTitle);
            const tab = albumTabs.find(t => t.id === tabId);
            if (tab) {
                const albumSongId = `album_tab_${activeCollectionId}_${selectedArtist.name}_${folderTitle}`.replace(/[^a-zA-Z0-9_-]/g, '_');
                await loadSongTab({
                    id: albumSongId,
                    title: selectedAlbum ? selectedAlbum.title : (btn.dataset.albumTitle || tab.name || folderTitle),
                    artist: selectedArtist.name,
                    album: folderTitle,
                    coverUrl: selectedAlbum?.coverUrl
                }, tab);
            }
        });
    });

    container.querySelectorAll('.set-default-album-tab-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!selectedArtist || !selectedAlbum) return;
            const tabId = btn.dataset.tabId;
            await setDefaultAlbumTabOption(activeCollectionId, selectedArtist.name, selectedAlbum.title, tabId);
            showToast('Set default album tab', 'success');
            await renderView();
        });
    });

    container.querySelectorAll('.remove-album-tab-chip-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const folderTitle = getBookFolderTitle();
            if (!selectedArtist || !folderTitle) return;
            const tabId = btn.dataset.tabId;
            await removeTabOptionFromAlbum(activeCollectionId, selectedArtist.name, folderTitle, tabId);
            showToast('Removed album tab', 'info');
            await renderView();
        });
    });


    // Delete song from library (in Edit Mode)
    container.querySelectorAll('.delete-song-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const songId = btn.dataset.songId;
            if (btn.dataset.confirming === 'true') {
                await deleteSongFromLibrary(songId);
                const hierarchy = await getLibraryHierarchy(activeCollectionId);
                const currentArtist = hierarchy.artists.find(a => a.name === selectedArtist?.name);
                const currentAlbum = currentArtist?.albums.find(a => a.title === selectedAlbum?.title);
                if (selectedAlbum && (!currentAlbum || currentAlbum.songs.length === 0)) {
                    selectedAlbum = null;
                    isAlbumEditMode = false;
                }
                if (!currentArtist || (currentArtist.songs.length === 0 && currentArtist.albums.length === 0)) {
                    selectedArtist = null;
                    selectedAlbum = null;
                    selectedFolderPath = [];
                    isAlbumEditMode = false;
                }
                await renderView();
            } else {
                btn.dataset.confirming = 'true';
                btn.innerHTML = '<i class="bi-exclamation-triangle-fill"></i>';
                btn.title = 'Click again to confirm delete';
                setTimeout(() => {
                    if (btn.dataset.confirming === 'true') {
                        btn.dataset.confirming = 'false';
                        btn.innerHTML = '<i class="bi-trash"></i>';
                        btn.title = 'Remove song from library';
                    }
                }, 3000);
            }
        });
    });

    // Import Tab with Provider (Local, Drive, Tab Downloader)
    container.querySelectorAll('.import-tab-provider-btn').forEach(btn => {
        btn.addEventListener('click', () => importTabFromProvider(btn.dataset.songId, btn.dataset.providerId));
    });

    // Drag & Drop tab files onto individual song rows
    container.querySelectorAll('.library-song-row').forEach(row => {
        const songId = row.dataset.songId;
        if (!songId) return;

        // Click row's empty space (outside actions) to play default tab
        row.addEventListener('click', async (e) => {
            if (e.target.closest('button, .tab-row, .dropdown, a, input')) return;
            const song = await getSongById(songId);
            if (song && song.tabOptions?.length > 0) {
                const targetTab = (song.defaultTabId && song.tabOptions.find(t => t.id === song.defaultTabId)) || song.tabOptions[0];
                await loadSongTab(song, targetTab);
            } else if (song) {
                // Nothing to play: pressing the row asks where the tab comes from
                const addBtn = row.closest('.library-song-rowwrap')?.querySelector('.song-tabs-add');
                if (addBtn) toggleSongTabsPicker(addBtn, songId, 'add');
            }
        });

        row.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!canAcceptTabDrop(e)) {
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
                return;
            }
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            row.classList.add('song-drop-active');
        });

        row.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!canAcceptTabDrop(e)) {
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
                row.classList.remove('song-drop-active');
                return;
            }
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            if (!row.classList.contains('song-drop-active')) {
                row.classList.add('song-drop-active');
            }
        });

        row.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!row.contains(e.relatedTarget)) {
                row.classList.remove('song-drop-active');
            }
        });

        row.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            row.classList.remove('song-drop-active');

            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length === 0) return;

            let addedCount = 0;
            for (const file of files) {
                const ok = await attachFileToSong(file, songId);
                if (ok) addedCount++;
            }

            if (addedCount > 0) {
                await renderView();
            }
        });
    });

    // Drag & Drop tab files onto album detail page container (auto-matches song)
    const albumDetailView = container.querySelector('.album-detail-view');
    if (albumDetailView && selectedAlbum) {
        albumDetailView.addEventListener('dragenter', (e) => {
            e.preventDefault();
            if (!canAcceptTabDrop(e)) {
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
                return;
            }
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        });

        albumDetailView.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!canAcceptTabDrop(e)) {
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
                return;
            }
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        });

        albumDetailView.addEventListener('drop', async (e) => {
            if (e.target.closest('.library-song-row')) return;
            e.preventDefault();
            e.stopPropagation();

            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length === 0) return;

            let addedCount = 0;
            for (const file of files) {
                const matchedSong = matchSongInAlbum(selectedAlbum.songs, file.name);
                if (matchedSong) {
                    const ok = await attachFileToSong(file, matchedSong.id);
                    if (ok) addedCount++;
                } else if (selectedAlbum.songs?.length > 0) {
                    const ok = await attachFileToSong(file, selectedAlbum.songs[0].id);
                    if (ok) addedCount++;
                } else {
                    if (!(await isSupportedTabFile(file))) {
                        showToast(`"${file.name}" is not a supported tab file (.gp, .gp3, .gp4, .gp5, .gpx, .pdf, .txt)`, 'warning');
                    }
                }
            }

            if (addedCount > 0) {
                await renderView();
            }
        });
    }

    gamepadManager.onLibraryViewRendered();
}

/**
 * Helper to save a file to persistent store and attach it as a tab option on a song
 */
async function attachFileToSong(file, songId) {
    if (!file) return false;
    if (!(await isSupportedTabFile(file))) {
        showToast(`"${file.name}" is not a supported tab file (.gp, .gp3, .gp4, .gp5, .gpx, .pdf, .txt)`, 'warning');
        return false;
    }
    try {
        const meta = await detectFileMetadata(file, file.name);
        const stored = await saveStoredFile(file, 'local');
        await addTabOptionToSong(songId, {
            name: file.name,
            providerId: 'local',
            relativePath: file.name,
            fileStoreId: stored.id,
            tuning: meta.primaryTuning,
            tunings: meta.tunings,
            stringCount: meta.stringCount,
            fileType: file.name.split('.').pop().toLowerCase()
        });
        showToast(`Added "${file.name}" to song`, 'success');
        return true;
    } catch (err) {
        console.error('Error attaching dropped tab to song:', err);
        showToast(`Error attaching tab: ${err.message}`, 'error');
        return false;
    }
}

/**
 * Match a tab file name against songs in an album
 */
function matchSongInAlbum(songs, fileName) {
    if (!Array.isArray(songs) || songs.length === 0) return null;

    const base = fileName.replace(/\.[^/.]+$/, '').trim();
    const cleanBase = base
        .replace(/^(\d+[\s.-]+|track\s*\d+[\s.-]+|\d+-\d+[\s.-]+)/i, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim().toLowerCase();

    // 1. Direct match
    for (const song of songs) {
        const cleanTitle = (song.title || '')
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim().toLowerCase();
        if (cleanTitle && (cleanTitle === cleanBase || cleanBase.includes(cleanTitle) || cleanTitle.includes(cleanBase))) {
            return song;
        }
    }

    // 2. Word overlap match
    const baseWords = cleanBase.split(' ').filter(w => w.length >= 3);
    if (baseWords.length > 0) {
        let bestMatch = null;
        let maxOverlap = 0;
        for (const song of songs) {
            const cleanTitle = (song.title || '').toLowerCase();
            let overlap = 0;
            for (const w of baseWords) {
                if (cleanTitle.includes(w)) overlap++;
            }
            if (overlap > maxOverlap) {
                maxOverlap = overlap;
                bestMatch = song;
            }
        }
        if (maxOverlap > 0) return bestMatch;
    }

    return songs.length === 1 ? songs[0] : null;
}

/**
 * Load a song's tab into MajesticTab viewer
 */
/** Open a library song's tab by id (null tabId = default tab), optionally as part of a setlist. */
export async function openLibraryTab(songId, tabId = null, setlistContext = {}) {
    const song = await getSongById(songId);
    if (!song?.tabOptions?.length) return false;
    const tab = (tabId && song.tabOptions.find(t => t.id === tabId))
        || (song.defaultTabId && song.tabOptions.find(t => t.id === song.defaultTabId))
        || song.tabOptions[0];
    return loadSongTab(song, tab, setlistContext);
}

async function loadSongTab(song, tabOption, setlistContext = {}) {
    try {
        let file = null;
        if (tabOption.fileStoreId) {
            const stored = await getStoredFile(tabOption.fileStoreId);
            if (stored && stored.file) {
                file = stored.file;
            }
        }
        if (!file && tabOption.driveFileId) {
            const stored = await getStoredFile(`google-drive_${tabOption.driveFileId}`);
            if (stored && stored.file) {
                file = stored.file;
            }
        }
        // @googleDrive:begin
        if (!file && tabOption.providerId === 'google-drive' && tabOption.driveFileId) {
            try {
                showToast(`Downloading "${tabOption.name}" from Google Drive...`, 'info');
                const { downloadDriveFile, isTokenValid, ensureFreshToken } = await import('./googleDrive.js');
                await ensureFreshToken();
                if (isTokenValid()) {
                    file = await downloadDriveFile(tabOption.driveFileId, tabOption.name);
                    if (file) {
                        const { saveStoredFile } = await import('./fileStore.js');
                        await saveStoredFile(file, 'google-drive', { driveFileId: tabOption.driveFileId, id: tabOption.fileStoreId });
                    }
                }
            } catch (dlErr) {
                console.warn('Could not download tab from Google Drive:', dlErr);
            }
        }
        // @googleDrive:end

        if (file) {
            file.songTitle = song.title;
            file.librarySongTitle = song.title;
            file.artist = song.artist;
            file.album = song.album;
            file.coverUrl = song.coverUrl;
            file.tunings = song.tunings;
            file.hiddenTunings = song.hiddenTunings || [];
            file.startPage = (tabOption.startPage !== undefined && tabOption.startPage !== null) ? parseInt(tabOption.startPage, 10) : null;
            file.endPage = (tabOption.endPage !== undefined && tabOption.endPage !== null) ? parseInt(tabOption.endPage, 10) : null;
            file.tabId = tabOption.id;
            file.tabName = tabOption.name || file.name;
            file.fileStoreId = tabOption.fileStoreId;
            file.preferredStringCount = tabOption.preferredStringCount || null;
            file.librarySongId = song.id;
            file.sourceUrl = tabOption.sourceUrl || null;
            file.sourceWebsite = tabOption.sourceWebsite || null;
            file.providerId = tabOption.providerId || 'local';
            file.addedAt = tabOption.addedAt || song.addedAt || null;
            file.setlistId = setlistContext.setlistId || null;
            file.setlistItemId = setlistContext.setlistItemId || null;
            closeLibraryModal();
            await loadFile(file);

            // Record recent with full library and specific tab metadata
            const recentId = (song.id && tabOption.id) 
                ? `${song.id}_tab_${tabOption.id}` 
                : (file.name + (tabOption.startPage ? `_p${tabOption.startPage}_${tabOption.endPage}` : ''));
            await addRecentOpened({
                id: recentId,
                name: tabOption.name || file.name,
                fileName: file.name,
                tabId: tabOption.id,
                tabName: tabOption.name || file.name,
                startPage: tabOption.startPage,
                endPage: tabOption.endPage,
                fileStoreId: tabOption.fileStoreId,
                providerId: tabOption.providerId || 'local',
                relativePath: tabOption.relativePath || file.name,
                librarySongId: song.id,
                songTitle: song.title,
                artist: song.artist,
                album: song.album,
                coverUrl: song.coverUrl,
                tunings: song.tunings,
                hiddenTunings: song.hiddenTunings || [],
                preferredStringCount: tabOption.preferredStringCount || null
            });
            return true;
        }
        showToast(`Tab file not found locally. Please re-import tab for ${song.title}.`, 'warning');
    } catch (err) {
        console.error('Failed to load song tab:', err);
        showToast(`Error opening tab: ${err.message}`, 'error');
    }
    return false;
}

async function exploreAlbumTracklist(releaseGroupMbid, container, parentArtist = null, albumPreload = null) {
    if (parentArtist) {
        searchSubView = {
            type: 'tracks',
            releaseGroupMbid,
            fromView: 'library',
            parentArtistMbid: parentArtist.mbid,
            parentArtistName: parentArtist.name,
            albumPreload
        };
    } else {
        searchSubView = { type: 'tracks', releaseGroupMbid, fromView: 'library', albumPreload };
    }
    const targetContainer = container;
    const thisFetchToken = ++currentExploreTracklistToken;

    const preloadTitle = albumPreload?.title || '';
    const preloadArtist = albumPreload?.artist || parentArtist?.name || '';
    const preloadYear = albumPreload?.year || '';
    const preloadCover = albumPreload?.coverUrl || (preloadTitle ? getPlaceholderCoverSvg(preloadTitle) : '');

    const goBackToAlbumsOrParent = () => {
        currentExploreTracklistToken++;
        if (parentArtist?.mbid && currentArtistAlbumsViewHandler) {
            searchSubView = null;
            currentArtistAlbumsViewHandler(parentArtist.mbid, parentArtist.name, targetContainer, libraryFilterQuery);
        } else {
            handleBack();
        }
    };

    targetContainer.innerHTML = `
    <div class="search-artist-albums-view">
      <div class="search-subview-head d-flex align-items-center justify-content-between mb-3">
        <button type="button" class="search-back-btn" id="cancelFetchTracklistBtn">
          <i class="bi-chevron-left" aria-hidden="true"></i> <span>Albums</span>
        </button>
      </div>

      ${preloadTitle ? `
      <!-- Album Header Banner (Preloaded) -->
      <div class="d-flex align-items-center gap-3 p-3 mb-3" style="background: var(--s1); border-radius: var(--r-card);">
        <img loading="lazy" decoding="async" src="${preloadCover}" class="flex-shrink-0" style="width: 56px; height: 56px; border-radius: var(--r-control); object-fit: cover; background: var(--s3);" alt="${escapeHtml(preloadTitle)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(preloadTitle)}'">
        <div class="min-w-0 flex-grow-1">
          <div class="fw-bold text-truncate" style="font-family: var(--font-display, inherit); font-size: 1.15rem; color: var(--ink);">${escapeHtml(preloadTitle)}</div>
          <div class="small text-truncate" style="color: var(--ink2);">
            ${escapeHtml(preloadArtist)}${preloadYear ? ` · ${preloadYear}` : ''}
          </div>
        </div>
      </div>
      ` : ''}

      <div class="text-center py-5 text-muted" id="tracklistLoadingSpinner">
        <div class="spinner-border spinner-border-sm text-info mb-2" role="status"></div>
        <div class="mb-3">Fetching album tracklist…</div>
      </div>
      <div class="search-stream-list" id="albumTracksChecklist" style="display: none;"></div>
    </div>
    `;

    targetContainer.querySelector('#cancelFetchTracklistBtn')?.addEventListener('click', goBackToAlbumsOrParent);

    try {
        const albumData = await getAlbumTracks(releaseGroupMbid);
        if (thisFetchToken !== currentExploreTracklistToken) return;

        if (!albumData || !albumData.tracks || albumData.tracks.length === 0) {
            targetContainer.innerHTML = `
            <div class="search-artist-albums-view">
              <div class="search-subview-head d-flex align-items-center justify-content-between mb-3">
                <button type="button" class="search-back-btn" id="backToAlbumsListBtn">
                  <i class="bi-chevron-left" aria-hidden="true"></i> <span>Albums</span>
                </button>
              </div>
              <div class="text-center py-4 text-muted">No tracklist available for this album.</div>
            </div>`;
            targetContainer.querySelector('#backToAlbumsListBtn')?.addEventListener('click', goBackToAlbumsOrParent);
            return;
        }

        const existingSongs = await getSongsByCollection(activeCollectionId);
        const existingSongMap = new Map();
        for (const s of existingSongs) {
            if (s.recordingMbid) existingSongMap.set(`rec:${s.recordingMbid}`, s);
            existingSongMap.set(`${(s.artist || '').toLowerCase().trim()}:::${(s.title || '').toLowerCase().trim()}`, s);
        }

        const hasCd = (albumData.tracks || []).some(t => !isDvdOrBlurayMedium(t) && !isVinylOrTapeMedium(t));
        let cleanTracks = (albumData.tracks || []).filter(t => !isDvdOrBlurayMedium(t) && !(hasCd && isVinylOrTapeMedium(t)));
        cleanTracks = filterInstrumentalBonusDiscs(cleanTracks);

        const missingTracks = cleanTracks.filter(t => {
            const inLib = (t.recordingMbid && existingSongMap.has(`rec:${t.recordingMbid}`)) ||
                          (t.id && existingSongMap.has(`rec:${t.id}`)) ||
                          existingSongMap.has(`${(albumData.artist || '').toLowerCase().trim()}:::${(t.title || '').toLowerCase().trim()}`);
            return !inLib;
        });

        const allInLib = cleanTracks.length > 0 && missingTracks.length === 0;
        const partialInLib = missingTracks.length > 0 && missingTracks.length < cleanTracks.length;

        const cover = albumData.coverUrl || preloadCover || getPlaceholderCoverSvg(albumData.title);

        let addAllBtnHtml = '';
        if (allInLib) {
            addAllBtnHtml = `<span class="text-muted small flex-shrink-0">All tracks in library</span>`;
        } else if (partialInLib) {
            addAllBtnHtml = `
            <button type="button" class="btn btn-sm btn-theme-primary px-3 flex-shrink-0" id="addAllAlbumTracksBtn">
              Add missing tracks (${missingTracks.length})
            </button>
            `;
        } else {
            addAllBtnHtml = `
            <button type="button" class="btn btn-sm btn-theme-primary px-3 flex-shrink-0" id="addAllAlbumTracksBtn">
              Add album to library
            </button>
            `;
        }

        targetContainer.innerHTML = `
        <div class="search-artist-albums-view">
          <div class="search-subview-head d-flex align-items-center justify-content-between mb-3">
            <button type="button" class="search-back-btn" id="backToAlbumsListBtn">
              <i class="bi-chevron-left" aria-hidden="true"></i> <span>Albums</span>
            </button>
            <div class="d-flex align-items-center gap-2 flex-shrink-0">
              <button class="btn btn-sm btn-theme-outline px-3 flex-shrink-0 ${cleanTracks.length > missingTracks.length ? '' : 'd-none'}" id="viewAlbumInLibraryBtn">
                View in library
              </button>
              ${addAllBtnHtml}
            </div>
          </div>

          <!-- Album Header Banner (Flat Ground Ladder) -->
          <div class="d-flex align-items-center gap-3 p-3 mb-3" style="background: var(--s1); border-radius: var(--r-card);">
            <img loading="lazy" decoding="async" src="${cover}" class="flex-shrink-0" style="width: 56px; height: 56px; border-radius: var(--r-control); object-fit: cover; background: var(--s3);" alt="${escapeHtml(albumData.title)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(albumData.title)}'">
            <div class="min-w-0 flex-grow-1">
              <div class="fw-bold text-truncate" style="font-family: var(--font-display, inherit); font-size: 1.15rem; color: var(--ink);">${escapeHtml(albumData.title)}</div>
              <div class="small text-truncate" style="color: var(--ink2);">
                ${escapeHtml(albumData.artist)}${albumData.year ? ` · ${albumData.year}` : ''} · ${cleanTracks.length} ${cleanTracks.length === 1 ? 'track' : 'tracks'}${albumData.country ? ` · ${escapeHtml(albumData.country)}` : ''}
              </div>
            </div>
          </div>

          <!-- Tracks List -->
          <div class="search-stream-list" id="albumTracksChecklist">
            ${renderAddAlbumTracksList(albumData.tracks, existingSongMap, albumData.artist, albumData.excludedTracks)}
          </div>
        </div>
        `;

        targetContainer.querySelector('#backToAlbumsListBtn')?.addEventListener('click', goBackToAlbumsOrParent);

        // Add missing tracks or full album button
        if (!allInLib) {
            targetContainer.querySelector('#addAllAlbumTracksBtn')?.addEventListener('click', async () => {
                const tracksToAdd = partialInLib ? missingTracks : albumData.tracks;
                await addAlbumToLibrary(albumData, tracksToAdd, activeCollectionId);
                showToast(`Added ${tracksToAdd.length} ${tracksToAdd.length === 1 ? 'track' : 'tracks'} to library`, 'success');
                window.dispatchEvent(new CustomEvent('libraryDataChanged'));
                await exploreAlbumTracklist(releaseGroupMbid, container, parentArtist, albumPreload);
            });
        }

        targetContainer.querySelector('#viewAlbumInLibraryBtn')?.addEventListener('click', async () => {
            pushLibraryNavigationState();
            searchSubView = null;
            libraryBrowseMode = 'artists';
            selectedTuning = null;
            selectedFolderPath = [];
            isAlbumEditMode = false;
            selectedArtist = { name: albumData.artist, artistMbid: albumData.artistMbid };
            selectedAlbum = { title: albumData.title, albumMbid: albumData.releaseGroupId || albumData.releaseId || null };
            await switchView('library', false);
        });

        // Add single track / find tab
        targetContainer.querySelectorAll('.add-single-track-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.trackIdx, 10);
                const track = albumData.tracks[idx];
                const songItem = {
                    id: btn.dataset.songId || null,
                    title: track.title,
                    artist: albumData.artist,
                    artistMbid: albumData.artistMbid,
                    album: albumData.title,
                    albumMbid: albumData.releaseGroupId || albumData.releaseId || null,
                    year: albumData.year,
                    length: track.length || null,
                    trackNumber: track.trackNumber,
                    mediumNumber: track.mediumNumber || 1,
                    mediumTitle: track.mediumTitle || null,
                    mediumFormat: track.mediumFormat || null,
                    recordingMbid: track.recordingMbid,
                    coverUrl: albumData.coverUrl || track.coverUrl || null
                };
                await handleGetTabSingleSong(songItem);
                const parent = btn.parentElement;
                btn.remove();
                if (parent) {
                    const statusSpan = document.createElement('span');
                    statusSpan.className = 'text-muted small flex-shrink-0 ms-2';
                    statusSpan.textContent = 'In library';
                    parent.appendChild(statusSpan);
                }
                targetContainer.querySelector('#viewAlbumInLibraryBtn')?.classList.remove('d-none');
            });
        });

        targetContainer.querySelectorAll('.search-stream-row[data-type="album-track-row"]').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('button, a, input')) return;
                const addBtn = row.querySelector('.add-single-track-btn');
                if (addBtn && !addBtn.disabled) {
                    addBtn.click();
                }
            });
        });

        gamepadManager.onLibraryViewRendered();
    } catch (err) {
        if (thisFetchToken !== currentExploreTracklistToken) return;
        targetContainer.innerHTML = `
        <div class="search-artist-albums-view">
          <div class="search-subview-head d-flex align-items-center justify-content-between mb-3">
            <button type="button" class="search-back-btn" id="backToAlbumsListBtn">
              <i class="bi-chevron-left" aria-hidden="true"></i> <span>Albums</span>
            </button>
          </div>
          <div class="text-danger py-4 text-center">Failed to load tracklist: ${escapeHtml(err.message)}</div>
        </div>`;
        targetContainer.querySelector('#backToAlbumsListBtn')?.addEventListener('click', goBackToAlbumsOrParent);
    }
}

function renderAddAlbumTracksList(tracks, existingSongMap = new Map(), artistName = '', excludedTracks = []) {
    const hasCd = (tracks || []).some(t => !isDvdOrBlurayMedium(t) && !isVinylOrTapeMedium(t));
    let cleanTracks = (tracks || []).filter(t => !isDvdOrBlurayMedium(t) && !(hasCd && isVinylOrTapeMedium(t)));
    cleanTracks = filterInstrumentalBonusDiscs(cleanTracks);
    if (!cleanTracks || cleanTracks.length === 0) return '';

    // Tracks left out of the album (instrumental bonus discs, video and vinyl media) stay visible but grayed out
    const keptTracks = new Set(cleanTracks);
    const leftOut = [
        ...(tracks || []).filter(t => !keptTracks.has(t)).map(t => ({
            ...t,
            excludedReason: isDvdOrBlurayMedium(t) ? 'video' : (isVinylOrTapeMedium(t) ? 'vinyl' : 'instrumental')
        })),
        ...(excludedTracks || [])
    ];

    const mediaGroups = new Map();
    const addToGroup = (t, idx, excluded) => {
        const medNum = t.mediumNumber || 1;
        if (!mediaGroups.has(medNum)) {
            mediaGroups.set(medNum, {
                mediumNumber: medNum,
                mediumTitle: t.mediumTitle || '',
                mediumFormat: t.mediumFormat || 'CD',
                items: []
            });
        }
        const grp = mediaGroups.get(medNum);
        if (!grp.mediumTitle && t.mediumTitle) grp.mediumTitle = t.mediumTitle;
        if (!grp.mediumFormat && t.mediumFormat) grp.mediumFormat = t.mediumFormat;
        grp.items.push({ track: t, idx, excluded });
    };
    cleanTracks.forEach((t, idx) => addToGroup(t, idx, false));
    leftOut.forEach((t, idx) => addToGroup(t, idx, true));
    mediaGroups.forEach(grp => grp.items.sort((a, b) => (a.excluded === b.excluded ? (a.track.trackNumber || 0) - (b.track.trackNumber || 0) : 0)));

    const groups = Array.from(mediaGroups.values()).sort((a, b) => a.mediumNumber - b.mediumNumber);

    const excludedLabels = { instrumental: 'Instrumental', video: 'Video disc', vinyl: 'Vinyl or tape' };

    const renderTrackItem = (t, idx, excluded) => {
        const trackNum = t.trackNumber ? (t.trackNumber < 10 ? `0${t.trackNumber}` : `${t.trackNumber}`) : `${idx + 1}`;
        const durationText = formatTrackDuration(t.length);

        if (excluded) {
            const reason = excludedLabels[t.excludedReason] || 'Excluded';
            return `
            <div class="search-stream-row is-excluded opacity-50" title="Not added: ${escapeHtml(reason)}">
              <span class="search-track-num tnum">${trackNum}</span>
              <div class="search-row-meta min-w-0 flex-grow-1">
                <div class="search-row-title text-truncate text-muted">${escapeHtml(t.title)}</div>
                <div class="search-row-sub text-truncate">${escapeHtml(reason)}</div>
              </div>
            </div>
            `;
        }

        const existingSong = (t.recordingMbid && existingSongMap.get(`rec:${t.recordingMbid}`)) ||
                             (t.id && existingSongMap.get(`rec:${t.id}`)) ||
                             existingSongMap.get(`${(artistName || '').toLowerCase().trim()}:::${(t.title || '').toLowerCase().trim()}`) || null;

        const isSongInLib = Boolean(existingSong);
        const hasTabInLib = isSongInLib && songHasTabs(existingSong);

        let actionHtml = '';
        if (hasTabInLib) {
            actionHtml = `<span class="text-muted small flex-shrink-0 ms-2">In library</span>`;
        } else if (isSongInLib) {
            actionHtml = `
            <button type="button" class="btn btn-sm lib-ghost-action add-single-track-btn flex-shrink-0 ms-2" data-track-idx="${idx}" data-song-id="${existingSong.id}" aria-label="Find tab">
              Find tab
            </button>
            `;
        } else {
            actionHtml = `
            <button type="button" class="btn btn-sm lib-ghost-action add-single-track-btn flex-shrink-0 ms-2" data-track-idx="${idx}" aria-label="Add song and find tab">
              Add song
            </button>
            `;
        }

        return `
        <div class="search-stream-row is-navigable" data-type="album-track-row" data-track-idx="${idx}" tabindex="0">
          <span class="search-track-num tnum">${trackNum}</span>
          <div class="search-row-meta min-w-0 flex-grow-1">
            <div class="search-row-title text-truncate">${escapeHtml(t.title)}</div>
            ${durationText ? `<div class="search-row-sub text-truncate">${durationText}</div>` : ''}
          </div>
          ${actionHtml}
        </div>
        `;
    };

    if (groups.length === 1 && !groups[0].mediumTitle) {
        return groups[0].items.map(({ track, idx, excluded }) => renderTrackItem(track, idx, excluded)).join('');
    }

    return groups.map(grp => {
        const formatLabel = grp.mediumFormat || 'CD';
        const discTitle = grp.mediumTitle ? ` · ${escapeHtml(grp.mediumTitle)}` : '';
        const headerText = `${formatLabel} ${grp.mediumNumber}${discTitle}`;
        const keptCount = grp.items.filter(item => !item.excluded).length;

        return `
        <div class="search-stream-section">
          <div class="search-stream-section-title">
            <span>${escapeHtml(headerText)}</span>
            <span class="search-stream-count">· ${keptCount} ${keptCount === 1 ? 'track' : 'tracks'}</span>
          </div>
          ${grp.items.map(({ track, idx, excluded }) => renderTrackItem(track, idx, excluded)).join('')}
        </div>
        `;
    }).join('');
}

// -----------------------------------------------------------------------------
// 3. RECENTS VIEW (Enriched with Library & Metadata, Edit Mode & Individual Delete)
// -----------------------------------------------------------------------------
/** Opens a recent item's tab: its library song and tab first, then the stored file. */
export async function openRecentItem(r) {

        // 1. If associated with a library song, load that specific tab
        if (r.librarySongId) {
            const song = await getSongById(r.librarySongId);
            if (song && Array.isArray(song.tabOptions) && song.tabOptions.length > 0) {
                const specificTab = (r.tabId && song.tabOptions.find(t => t.id === r.tabId))
                    || (r.fileStoreId && song.tabOptions.find(t => t.fileStoreId === r.fileStoreId))
                    || (r.name && song.tabOptions.find(t => t.name === r.name || t.relativePath === r.name))
                    || (r.fileName && song.tabOptions.find(t => t.name === r.fileName || t.relativePath === r.fileName))
                    || (song.defaultTabId && song.tabOptions.find(t => t.id === song.defaultTabId))
                    || song.tabOptions[0];
                if (specificTab) {
                    await loadSongTab(song, specificTab);
                    return;
                }
            }
        }

        // 2. Direct fileStoreId loading
        if (r.fileStoreId) {
            const stored = await getStoredFile(r.fileStoreId);
            if (stored?.file) {
                stored.file.songTitle = r.songTitle || r.name;
                stored.file.librarySongTitle = r.songTitle || r.name;
                stored.file.artist = r.artist || '';
                stored.file.album = r.album || '';
                stored.file.startPage = r.startPage || null;
                stored.file.endPage = r.endPage || null;
                stored.file.tabId = r.tabId || null;
                stored.file.tabName = r.tabName || r.name;
                stored.file.fileStoreId = r.fileStoreId;
                stored.file.preferredStringCount = r.preferredStringCount || null;
                stored.file.sourceUrl = stored.record?.metadata?.sourceUrl || null;
                stored.file.sourceWebsite = stored.record?.metadata?.sourceWebsite || null;
                stored.file.providerId = stored.record?.providerId || r.providerId || 'local';
                stored.file.addedAt = stored.record?.savedAt || null;
                closeLibraryModal();
                await loadFile(stored.file);
                return;
            }
        }
        showToast(`File "${r.name}" could not be restored from storage.`, 'warning');
}

// The "Add tab" sources for this client, straight from the provider registry: Web Search on the desktop app, iCloud Drive
// where it is supported, Google Drive only in builds that include it. `attrs` ties each row to its song or album.
function addTabProviderItemsHtml(buttonClass, attrs = '') {
    const order = ['tab-downloader', 'local', 'google-drive', 'icloud-drive', 's3', 'webdav', 'url'];
    const rank = (p) => { const i = order.indexOf(p.id); return i < 0 ? order.length : i; };
    return [...getFileProviders()].sort((a, b) => rank(a) - rank(b)).map((p) => {
        const tint = String(p.icon).startsWith('icon-') ? '' : ` ${p.iconColorClass || ''}`;
        return `<li><button class="dropdown-item small ${buttonClass}" ${attrs} data-provider-id="${escapeHtml(p.id)}"><i class="${escapeHtml(p.icon || 'bi-file-earmark')} me-2${tint}"></i> ${escapeHtml(p.name)}</button></li>`;
    }).join('');
}

let classtabPieceCount = 0;
let classtabUnsub = null;
// Tools page: a rack of instruments. Rows are grouped by what they are for (a gap, no heading) and carry a plain readout
// of real state where there is some; the open tool fills a stage beside the list. Chords, Scales, Circle of fifths, Tuner,
// Metronome, Jam, Classical tab and Open file render in the page.
function renderToolsView(container) {
    const $ = (id) => document.getElementById(id);
    // A readout is a plain note of real state on the right of a row; a tool with nothing real to say has none.
    const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
    const chordsReadout = () => {
        const parts = [];
        const strings = parseInt(stored('majestictab_string_count'), 10);
        const offset = parseInt(stored('majestictab_tuning_offset'), 10);
        const capo = parseInt(stored('majestictab_capo'), 10);
        if (strings === 7 || strings === 8) parts.push(`${strings} strings`);
        if (capo > 0) parts.push(`Capo ${capo}`);
        if (Number.isInteger(offset) && offset !== 0) parts.push(`${offset > 0 ? '+' : '\u2212'}${Math.abs(offset)} semitones`);
        return parts.join(' \u00b7 ');
    };
    const tunerReadout = () => {
        const letters = (pitchCraftTuner?.selectedInstrument?.tuning || []).map((n) => String(n).replace(/\d/g, '')).join(' ');
        return letters === 'E A D G B E' ? 'Standard' : letters;
    };
    const jamReadout = () => {
        if (!$('jamToggleBtn')?.classList.contains('jam-active')) return '';
        const full = ($('jamStatusLabel')?.textContent || '').trim();
        return full.startsWith('Hosting') ? full.replace('Hosting', 'Host') : full.split(' \u00b7 ')[0];
    };
    // Pieces in the installed archive: the catalog is read asynchronously, so the row fills in once it arrives
    const classtabReadout = () => (classtabPieceCount > 0 ? `${classtabPieceCount.toLocaleString()} pieces` : '');
    import('./classtab/archive.js').then(async (m) => {
        const set = async () => {
            classtabPieceCount = (await m.getCatalogRecord())?.counts?.pieces || 0;
            const el = document.querySelector('[data-read="classtab"]');
            if (el) el.textContent = classtabReadout();
        };
        await set();
        if (!classtabUnsub) classtabUnsub = m.onArchiveChange(() => { m.getCatalogRecord().then(set); });
    }).catch(() => {});
    const tools = [
        { id: 'openfile', group: 'files', title: 'Open file' },
        { id: 'classtab', group: 'files', title: 'Classical tab browser', readout: classtabReadout },
        { id: 'bulkimport', group: 'files', title: 'Bulk import', readout: bulkImportReadout },
        { id: 'bulkexport', group: 'files', title: 'Bulk export', readout: bulkExportReadout },
        { id: 'missingtabs', group: 'files', title: 'Fill in missing tabs', readout: missingTabsReadout }
    ];
    import('./bulkFill/missingTabsTool.js').then((m) => m.refreshMissingTabsCount()).catch(() => {});
    // Sends local audio to the StemDeck app on this computer or network; the web build cannot reach it
    if (hasStemDeckSupport()) tools.push({ id: 'stemdeck', group: 'files', title: 'Backing tracks', readout: stemdeckReadout });
    tools.push(
        { id: 'chords', group: 'reference', title: 'Chord library', readout: chordsReadout },
        { id: 'scales', group: 'reference', title: 'Scales' },
        { id: 'circle', group: 'reference', title: 'Circle of fifths' },
        { id: 'tuner', group: 'play', title: 'Tuner', readout: tunerReadout },
        { id: 'metronome', group: 'play', title: 'Metronome', readout: () => `${metronome.bpm} bpm`, watch: ['metroBpm'] }
    );
    if ($('jamToggleBtn') && $('jamPill') && $('jamPill').style.display !== 'none') tools.push({ id: 'jam', group: 'play', title: 'Jam', readout: jamReadout, watch: ['jamStatusLabel'] });
    // Applies to every sound in the app; in a song the same panel opens as a dialog from the reader's Tools menu
    tools.push({ id: 'latency', group: 'system', title: 'Audio latency', readout: () => { const ms = getAudioLatencyMs(); return ms > 0 ? `${ms} ms` : 'Off'; }, watch: ['latencyModalBadge'] });
    renderToolsPage(container, { tools, escapeHtml });
}

function recentRowHtml(r) {
            const cover = getSynchronousCachedArtUrl(r.coverUrl) || r.coverUrl || getPlaceholderCoverSvg(r.songTitle || r.name);
            const tunings = visibleTuningsForSong({ hiddenTunings: r.hiddenTunings }, Array.isArray(r.tunings) ? r.tunings : []).filter(t => isTuningMatchingInstrument(t));
            const timeAgo = formatTimeAgo(r.openedAt);

            const tabLabel = r.tabName || r.fileName || ((r.name && r.name !== r.songTitle) ? r.name : '');
            const isPdf = Boolean((r.fileName || r.name || '').toLowerCase().endsWith('.pdf') || r.startPage);

            // One quiet line: who, where you stopped, what tuning, how long ago. The file name lives in the tooltip.
            const meta = [
                [r.artist || 'Unknown artist', r.album].filter(Boolean).join(', '),
                r.lastBar && r.totalBars ? `bar ${r.lastBar} of ${r.totalBars}` : '',
                ...tunings.map(t => getTuningInfo(t)?.displayName || t),
                timeAgo
            ].filter(Boolean).join(' \u00b7 ');
            const rowTitle = [tabLabel, isPdf && r.startPage ? `p. ${r.startPage}${r.endPage && r.endPage !== r.startPage ? `-${r.endPage}` : ''}` : ''].filter(Boolean).join(' ');

            return `
            <div class="library-row-card recent-row d-flex align-items-center gap-3 open-recent-row ${isRecentsEditMode ? '' : 'library-row-clickable'}" data-recent-id="${escapeHtml(r.id)}" data-recent='${escapeHtml(JSON.stringify(r))}' ${isRecentsEditMode ? '' : 'role="button" tabindex="0"'}>
              <img loading="lazy" decoding="async" src="${cover}" class="artist-thumbnail flex-shrink-0" style="width: 48px; height: 48px;" alt="" draggable="false" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(r.songTitle || r.name)}'">
              <div class="min-w-0 flex-grow-1">
                <h6 class="mb-0 fw-bold text-white text-truncate">${escapeHtml(r.songTitle || r.name)}</h6>
                <div class="small text-truncate tnum">${escapeHtml(meta)}</div>
              </div>
              <div class="recent-row-actions d-flex align-items-center flex-shrink-0">
                ${isRecentsEditMode ? `
                  <button class="btn btn-sm btn-theme-danger delete-recent-item-btn" data-recent-id="${escapeHtml(r.id)}" aria-label="Remove from recents" title="Remove from recents">
                    <i class="bi-trash"></i>
                  </button>
                ` : `
                  <button class="btn btn-sm btn-theme-icon add-recent-to-setlist-btn" data-song-id="${escapeHtml(r.librarySongId)}" data-tab-id="${escapeHtml(r.tabId || '')}" data-title="${escapeHtml(r.songTitle || r.name)}" aria-label="Add to setlist" title="Add to setlist">
                    <i class="bi-collection-play"></i>
                  </button>
                `}
              </div>
            </div>
            `;
}

function bindRecentRows(container, rerender) {
    container.querySelector('#toggleRecentsEditBtn')?.addEventListener('click', () => {
        isRecentsEditMode = !isRecentsEditMode;
        rerender();
    });

    container.querySelectorAll('.delete-recent-item-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.recentId;
            const removed = await getRecentItem(id);
            await deleteRecentItem(id);
            showToast('Removed item from recents', 'info', 6000, null, removed ? {
                label: 'Undo',
                onClick: async () => { await restoreRecentItem(removed); await rerender(); }
            } : null);
            await rerender();
        });
    });

    const clearBtn = container.querySelector('#clearRecentsBtn');
    clearBtn?.addEventListener('click', async () => {
        if (clearBtn.dataset.confirming === 'true') {
            await clearRecents();
            isRecentsEditMode = false;
            showToast('Cleared recent history', 'info');
            await rerender();
        } else {
            clearBtn.dataset.confirming = 'true';
            clearBtn.innerHTML = '<i class="bi-exclamation-circle me-1"></i> Confirm Clear All?';
            setTimeout(() => {
                if (clearBtn.dataset.confirming === 'true') {
                    clearBtn.dataset.confirming = 'false';
                    clearBtn.innerHTML = '<i class="bi-trash"></i> <span>Clear History</span>';
                }
            }, 4000);
        }
    });

    container.querySelectorAll('.add-recent-to-setlist-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const song = await getSongById(btn.dataset.songId);
            const tabId = (btn.dataset.tabId && song?.tabOptions?.some(t => t.id === btn.dataset.tabId))
                ? btn.dataset.tabId
                : ((song?.defaultTabId && song.tabOptions.find(t => t.id === song.defaultTabId)) || song?.tabOptions?.[0])?.id;
            if (song && tabId) openAddToSetlistModal({ songId: song.id, tabId, title: btn.dataset.title || song.title });
            else showToast('This song has no tab to add.', 'info');
        });
    });

    container.querySelectorAll('.open-recent-row[role="button"]').forEach(btn => {
        const openRecent = () => openRecentItem(JSON.parse(btn.dataset.recent));
        // The whole row opens the tab; the setlist button inside it does not
        btn.addEventListener('click', (e) => {
            if (e.target.closest('button, a')) return;
            openRecent();
        });
        btn.addEventListener('keydown', (e) => {
            if (e.target !== btn) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openRecent();
            }
        });
    });

}

async function renderRecentsView(container) {
    const recents = await getRecents(15);

    if (recents.length === 0) {
        container.innerHTML = `
        <div class="library-page-container">
          ${libraryHeaderHtml({ activeTab: 'recents', searchId: 'recentsFilterInput', clearId: 'recentsFilterClearBtn', placeholder: 'Search recent songs...', searchLabel: 'Search recent songs', searchDisabled: true })}
          ${libraryEmptyStateHtml({
            icon: 'bi-clock-history',
            title: 'No recent tabs yet',
            message: 'Files and tabs you open will appear here with rich metadata and artwork.',
            actionsHtml: `<button class="btn btn-sm btn-theme-primary px-4" id="recentsEmptyOpenBtn"><i class="bi-folder2-open me-1"></i> Open File</button>`
          })}
        </div>
        `;
        container.querySelector('#recentsEmptyOpenBtn')?.addEventListener('click', () => switchView('openFile'));
        return;
    }

    container.innerHTML = `
    <div class="library-page-container recents-view">
      ${libraryHeaderHtml({ activeTab: 'recents', searchId: 'recentsFilterInput', clearId: 'recentsFilterClearBtn', placeholder: 'Search recent songs...', searchLabel: 'Search recent songs' })}

      ${libraryListToolbarHtml({
        count: `${recents.length} recent ${recents.length === 1 ? 'song' : 'songs'}`,
        actionsHtml: `${isRecentsEditMode ? `
            <button class="btn btn-sm btn-theme-danger p-1 px-3 d-flex align-items-center gap-1" id="clearRecentsBtn" title="Clear all recent history">
              <i class="bi-trash"></i> <span>Clear History</span>
            </button>
            <button class="btn btn-sm btn-theme-primary p-1 px-3 d-flex align-items-center gap-1" id="toggleRecentsEditBtn" title="Done editing">
              <i class="bi-check-lg"></i> <span>Done</span>
            </button>
          ` : `
            <button class="btn btn-sm btn-theme-outline p-1 px-3 d-flex align-items-center gap-1" id="toggleRecentsEditBtn" title="Edit recents list">
              <i class="bi-pencil"></i> <span>Edit</span>
            </button>
          `}`
      })}

      <div class="d-flex flex-column gap-2" id="recentsList">
        ${recents.map(recentRowHtml).join('')}
      </div>
    </div>
    `;

    bindListFilter(container, { inputId: 'recentsFilterInput', clearId: 'recentsFilterClearBtn', rowSelector: '#recentsList .library-row-card' });
    bindRecentRows(container, () => renderRecentsView(container));

    hydrateCachedImages(container);
    gamepadManager.onLibraryViewRendered();
}

// -----------------------------------------------------------------------------
// UTILITIES
// -----------------------------------------------------------------------------
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * Displays a themed input modal for text prompts (such as naming collections or editing tuning names)
 */
export function openThemedInputModal({
    title = 'Input',
    subtitle = '',
    icon = 'bi-pencil-square',
    inputLabel = '',
    placeholder = '',
    initialValue = '',
    confirmText = 'Save',
    onConfirm = () => {}
} = {}) {
    let modal = document.getElementById('themedInputModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'themedInputModal';
        modal.className = 'theme-modal-backdrop';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
    <div class="theme-modal-card" style="max-width: 440px; width: 90%;">
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          <div class="theme-modal-icon">
            <i class="${icon} text-primary fs-5"></i>
          </div>
          <div class="theme-modal-titles">
            <h5 class="modal-title mb-0 fs-6 fw-bold text-white">${escapeHtml(title)}</h5>
            ${subtitle ? `<div class="small text-muted" style="font-size: 0.78rem;">${escapeHtml(subtitle)}</div>` : ''}
          </div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="themedInputCloseBtn" aria-label="Close">
            <i class="bi-x-lg"></i>
          </button>
        </div>
      </div>
      <form id="themedInputForm">
        <div class="theme-modal-body p-3">
          ${inputLabel ? `<label class="form-label small text-white-50 mb-2">${escapeHtml(inputLabel)}</label>` : ''}
          <input type="text" class="form-control" id="themedInputField" value="${escapeHtml(initialValue || '')}" placeholder="${escapeHtml(placeholder || '')}" autocomplete="off" required>
        </div>
        <div class="d-flex justify-content-end gap-2 p-3 pt-0 border-0">
          <button type="button" class="btn btn-sm btn-theme-outline px-3" id="themedInputCancelBtn">Cancel</button>
          <button type="submit" class="btn btn-sm btn-theme-primary px-4" id="themedInputConfirmBtn">${escapeHtml(confirmText)}</button>
        </div>
      </form>
    </div>
    `;

    const inputField = modal.querySelector('#themedInputField');
    const form = modal.querySelector('#themedInputForm');
    const closeBtn = modal.querySelector('#themedInputCloseBtn');
    const cancelBtn = modal.querySelector('#themedInputCancelBtn');

    const closeModal = () => {
        modal.classList.remove('show');
        modal.style.display = 'none';
        document.removeEventListener('keydown', handleKeyDown);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
            closeModal();
        }
    };

    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);
    modal.onclick = (e) => {
        if (e.target === modal) closeModal();
    };

    form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const value = (inputField?.value || '').trim();
        if (value) {
            closeModal();
            await onConfirm(value);
        }
    });

    document.addEventListener('keydown', handleKeyDown);
    modal.style.display = 'flex';
    modal.classList.add('show');
    setTimeout(() => {
        if (inputField) {
            inputField.focus();
            inputField.select();
        }
    }, 50);
}

/**
 * Themed dialog to configure start and end page range from an album-level PDF for a specific track.
 */
export function openSetAlbumPdfPagesModal(song, albumPdfTabs = [], existingTab = null, { isCustom = false } = {}) {
    const pdfPagesNoun = isCustom ? 'Book' : 'Album';
    if (!albumPdfTabs || albumPdfTabs.length === 0) {
        showToast('No whole-album PDF found for this album.', 'warning');
        return;
    }

    let modal = document.getElementById('themedAlbumPdfModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'themedAlbumPdfModal';
        modal.className = 'theme-modal-backdrop';
        document.body.appendChild(modal);
    }

    const isEdit = Boolean(existingTab);
    const selectedSourceId = (existingTab && albumPdfTabs.find(t => (existingTab.fileStoreId && t.fileStoreId === existingTab.fileStoreId) || t.id === existingTab.id)?.id) || albumPdfTabs[0].id;
    const initialTab = albumPdfTabs.find(t => t.id === selectedSourceId) || albumPdfTabs[0];
    const initialStart = existingTab?.startPage || 1;
    const initialEnd = existingTab?.endPage || initialStart;
    const initialName = existingTab?.name || '';

    modal.innerHTML = `
    <div class="theme-modal-card" style="max-width: 480px; width: 90%;">
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          <div class="theme-modal-icon">
            <i class="bi-file-earmark-pdf text-primary fs-5"></i>
          </div>
          <div class="theme-modal-titles">
            <h5 class="modal-title mb-0 fs-6 fw-bold text-white">${isEdit ? 'Edit' : 'Set'} ${pdfPagesNoun} PDF Pages</h5>
            <div class="small text-muted" style="font-size: 0.78rem;">${escapeHtml(song.title)}</div>
          </div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="themedAlbumPdfCloseBtn" aria-label="Close">
            <i class="bi-x-lg"></i>
          </button>
        </div>
      </div>
      <form id="themedAlbumPdfForm">
        <div class="theme-modal-body p-3 d-flex flex-column gap-3">
          ${albumPdfTabs.length > 1 ? `
            <div>
              <label class="form-label small text-white-50 mb-1">Album PDF Source</label>
              <select class="form-select form-select-sm" id="albumPdfSourceSelect">
                ${albumPdfTabs.map((t) => `<option value="${escapeHtml(t.id)}" ${t.id === selectedSourceId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
              </select>
            </div>
          ` : `
            <div>
              <label class="form-label small text-white-50 mb-1">Album PDF Source</label>
              <div class="small text-white fw-semibold"><i class="bi-file-earmark-pdf text-warning me-1"></i>${escapeHtml(initialTab.name)}</div>
            </div>
          `}
          <div class="row g-2">
            <div class="col-6">
              <label class="form-label small text-white-50 mb-1">Start Page</label>
              <input type="number" class="form-control" id="albumPdfStartPage" min="1" step="1" value="${initialStart}" required>
            </div>
            <div class="col-6">
              <label class="form-label small text-white-50 mb-1">End Page</label>
              <input type="number" class="form-control" id="albumPdfEndPage" min="1" step="1" value="${initialEnd}" required>
            </div>
          </div>
          <div>
            <label class="form-label small text-white-50 mb-1">Tab Name (optional)</label>
            <input type="text" class="form-control" id="albumPdfTabName" value="${escapeHtml(initialName)}" placeholder="${escapeHtml(initialTab.name)} (pp. ${initialStart}-${initialEnd})">
          </div>
        </div>
        <div class="d-flex justify-content-end gap-2 p-3 pt-0 border-0">
          <button type="button" class="btn btn-sm btn-theme-outline px-3" id="themedAlbumPdfCancelBtn">Cancel</button>
          <button type="submit" class="btn btn-sm btn-theme-primary px-4" id="themedAlbumPdfConfirmBtn">${isEdit ? 'Save Changes' : 'Save Tab Range'}</button>
        </div>
      </form>
    </div>
    `;

    const form = modal.querySelector('#themedAlbumPdfForm');
    const closeBtn = modal.querySelector('#themedAlbumPdfCloseBtn');
    const cancelBtn = modal.querySelector('#themedAlbumPdfCancelBtn');
    const sourceSelect = modal.querySelector('#albumPdfSourceSelect');
    const startInput = modal.querySelector('#albumPdfStartPage');
    const endInput = modal.querySelector('#albumPdfEndPage');
    const nameInput = modal.querySelector('#albumPdfTabName');

    const updateNamePlaceholder = () => {
        const selId = sourceSelect ? sourceSelect.value : selectedSourceId;
        const selTab = albumPdfTabs.find(t => t.id === selId) || initialTab;
        const s = parseInt(startInput.value, 10) || 1;
        const e = parseInt(endInput.value, 10) || s;
        nameInput.placeholder = `${selTab.name} (pp. ${s}-${e})`;
    };

    startInput.addEventListener('input', () => {
        if (parseInt(endInput.value, 10) < parseInt(startInput.value, 10)) {
            endInput.value = startInput.value;
        }
        updateNamePlaceholder();
    });
    endInput.addEventListener('input', updateNamePlaceholder);
    sourceSelect?.addEventListener('change', updateNamePlaceholder);

    const closeModal = () => {
        modal.classList.remove('show');
        modal.style.display = 'none';
        document.removeEventListener('keydown', handleKeyDown);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Escape') closeModal();
    };

    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);
    modal.onclick = (e) => {
        if (e.target === modal) closeModal();
    };

    form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const selId = sourceSelect ? sourceSelect.value : selectedSourceId;
        const selTab = albumPdfTabs.find(t => t.id === selId) || initialTab;
        const startPage = parseInt(startInput.value, 10) || 1;
        const endPage = parseInt(endInput.value, 10) || startPage;
        const customName = (nameInput.value || '').trim() || `${selTab.name} (pp. ${startPage}-${endPage})`;

        if (isEdit && existingTab) {
            await updateTabOptionOnSong(song.id, existingTab.id, {
                name: customName,
                startPage: startPage,
                endPage: endPage,
                fileStoreId: selTab.fileStoreId || existingTab.fileStoreId,
                relativePath: selTab.relativePath || selTab.name || existingTab.relativePath,
                isAlbumRange: true
            });
            closeModal();
            showToast(`Updated PDF page range for ${song.title}`, 'success');
        } else {
            await addTabOptionToSong(song.id, {
                name: customName,
                fileStoreId: selTab.fileStoreId,
                providerId: selTab.providerId || 'local',
                relativePath: selTab.relativePath || selTab.name,
                startPage: startPage,
                endPage: endPage,
                isAlbumRange: true,
                tuning: selTab.tuning || song.tunings?.[0] || 'E Standard',
                tunings: selTab.tunings || song.tunings || ['E Standard']
            });
            closeModal();
            showToast(`Saved PDF page range for ${song.title}`, 'success');
        }
        await renderView();
    });

    document.addEventListener('keydown', handleKeyDown);
    modal.style.display = 'flex';
    modal.classList.add('show');
    setTimeout(() => {
        if (startInput) {
            startInput.focus();
            startInput.select();
        }
    }, 50);
}



/**
 * Themed dialog to split a whole-book PDF in a custom folder into songs, one per page range.
 */
export function openBookPdfSongsModal(artistName, album, bookPdfs = []) {
    if (!bookPdfs.length) {
        showToast('Attach a book PDF to this folder first.', 'warning');
        return;
    }

    let modal = document.getElementById('themedBookPdfSongsModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'themedBookPdfSongsModal';
        modal.className = 'theme-modal-backdrop';
        document.body.appendChild(modal);
    }

    const rowHtml = (title = '', start = '', end = '') => `
      <div class="book-pdf-song-row d-flex align-items-center gap-2">
        <input type="text" class="form-control form-control-sm book-pdf-title" placeholder="Song title" value="${escapeHtml(title)}">
        <input type="number" class="form-control form-control-sm book-pdf-start flex-shrink-0" min="1" step="1" placeholder="From" value="${start}" style="width: 76px;">
        <input type="number" class="form-control form-control-sm book-pdf-end flex-shrink-0" min="1" step="1" placeholder="To" value="${end}" style="width: 76px;">
        <button type="button" class="btn btn-sm btn-theme-icon book-pdf-remove-row flex-shrink-0" title="Remove row"><i class="bi-x-lg"></i></button>
      </div>`;

    modal.innerHTML = `
    <div class="theme-modal-card" style="max-width: 560px; width: 92%;">
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          <div class="theme-modal-icon"><i class="bi-file-earmark-pdf text-primary fs-5"></i></div>
          <div class="theme-modal-titles">
            <h5 class="modal-title mb-0 fs-6 fw-bold text-white">Set Book PDF Pages</h5>
            <div class="small text-muted" style="font-size: 0.78rem;">${escapeHtml(album.title || artistName)}</div>
          </div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="bookPdfCloseBtn" aria-label="Close"><i class="bi-x-lg"></i></button>
        </div>
      </div>
      <form id="bookPdfSongsForm">
        <div class="theme-modal-body p-3 d-flex flex-column gap-3">
          <div>
            <label class="form-label small text-white-50 mb-1">Book PDF</label>
            ${bookPdfs.length > 1 ? `
              <select class="form-select form-select-sm" id="bookPdfSourceSelect">
                ${bookPdfs.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('')}
              </select>
            ` : `<div class="small text-white fw-semibold"><i class="bi-file-earmark-pdf text-warning me-1"></i>${escapeHtml(bookPdfs[0].name)}</div>`}
          </div>
          <div>
            <div class="d-flex gap-2 small text-white-50 mb-1"><span class="flex-grow-1">Song</span><span style="width: 76px;">First page</span><span style="width: 76px;">Last page</span><span style="width: 31px;"></span></div>
            <div class="d-flex flex-column gap-2" id="bookPdfRows">${rowHtml()}</div>
            <button type="button" class="btn btn-sm btn-theme-outline mt-2 d-inline-flex align-items-center gap-1" id="bookPdfAddRowBtn"><i class="bi-plus-lg"></i> <span>Add Song</span></button>
          </div>
        </div>
        <div class="d-flex justify-content-end gap-2 p-3 pt-0 border-0">
          <button type="button" class="btn btn-sm btn-theme-outline px-3" id="bookPdfCancelBtn">Cancel</button>
          <button type="submit" class="btn btn-sm btn-theme-primary px-4">Save Songs</button>
        </div>
      </form>
    </div>
    `;

    const form = modal.querySelector('#bookPdfSongsForm');
    const rowsEl = modal.querySelector('#bookPdfRows');

    const closeModal = () => {
        modal.classList.remove('show');
        modal.style.display = 'none';
        document.removeEventListener('keydown', handleKeyDown);
    };
    const handleKeyDown = (e) => { if (e.key === 'Escape') closeModal(); };

    modal.querySelector('#bookPdfCloseBtn')?.addEventListener('click', closeModal);
    modal.querySelector('#bookPdfCancelBtn')?.addEventListener('click', closeModal);
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };

    modal.querySelector('#bookPdfAddRowBtn')?.addEventListener('click', () => {
        // Next song most likely starts right after the previous one ends
        const lastEnd = parseInt(Array.from(rowsEl.querySelectorAll('.book-pdf-end')).pop()?.value, 10);
        rowsEl.insertAdjacentHTML('beforeend', rowHtml('', lastEnd ? lastEnd + 1 : '', ''));
        rowsEl.lastElementChild.querySelector('.book-pdf-title')?.focus();
    });

    rowsEl.addEventListener('click', (e) => {
        const rm = e.target.closest('.book-pdf-remove-row');
        if (!rm) return;
        if (rowsEl.children.length > 1) rm.closest('.book-pdf-song-row').remove();
    });

    rowsEl.addEventListener('input', (e) => {
        if (!e.target.classList.contains('book-pdf-start')) return;
        const endInput = e.target.closest('.book-pdf-song-row').querySelector('.book-pdf-end');
        if (!endInput.value || parseInt(endInput.value, 10) < parseInt(e.target.value, 10)) endInput.value = e.target.value;
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const srcId = modal.querySelector('#bookPdfSourceSelect')?.value || bookPdfs[0].id;
        const source = bookPdfs.find(t => t.id === srcId) || bookPdfs[0];
        const entries = [];
        for (const row of rowsEl.querySelectorAll('.book-pdf-song-row')) {
            const title = row.querySelector('.book-pdf-title').value.trim();
            const startPage = parseInt(row.querySelector('.book-pdf-start').value, 10);
            if (!title && !startPage) continue; // untouched row
            const endPage = parseInt(row.querySelector('.book-pdf-end').value, 10) || startPage;
            if (!title || !startPage || endPage < startPage) {
                showToast('Each song needs a title and a valid page range.', 'warning');
                return;
            }
            entries.push({ title, startPage, endPage });
        }
        if (!entries.length) {
            showToast('Add at least one song.', 'warning');
            return;
        }

        const stamp = Date.now();
        for (let i = 0; i < entries.length; i++) {
            const { title, startPage, endPage } = entries[i];
            const song = {
                id: `custom_${stamp}_${i}_${Math.random().toString(36).slice(2, 6)}`,
                collectionId: activeCollectionId,
                title,
                artist: artistName,
                album: album.title,
                folderPath: album.title,
                isCustom: true,
                tunings: source.tunings || (source.tuning ? [source.tuning] : []),
                stringCount: source.stringCount || null,
                addedAt: stamp + i
            };
            await saveSongToLibrary(song, activeCollectionId);
            await addTabOptionToSong(song.id, {
                name: `${title} (pp. ${startPage}-${endPage})`,
                fileStoreId: source.fileStoreId,
                providerId: source.providerId || 'local',
                relativePath: source.relativePath || source.name,
                driveFileId: source.driveFileId || null,
                fileType: 'pdf',
                startPage,
                endPage,
                isAlbumRange: true,
                tuning: source.tuning || null,
                tunings: source.tunings || [],
                isDefault: true
            });
        }
        closeModal();
        showToast(`Added ${entries.length} ${entries.length === 1 ? 'song' : 'songs'} from ${source.name}`, 'success');
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
        await renderView();
    });

    document.addEventListener('keydown', handleKeyDown);
    modal.style.display = 'flex';
    modal.classList.add('show');
    setTimeout(() => modal.querySelector('.book-pdf-title')?.focus(), 50);
}
