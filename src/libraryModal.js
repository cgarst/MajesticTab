// libraryModal.js
// Artwork-rich MusicBrainz-powered Tab Library Page aligned to themes.

import { settingsPanel } from './utils/settingsPanel.js';
import {
    getCollections, deleteCollection, getLibraryHierarchy, getLibraryTuningsHierarchy,
    getSongsByCollection, saveSongToLibrary, addAlbumToLibrary, deleteSongFromLibrary,
    deleteAlbumFromLibrary, getSongById, addTabOptionToSong, updateTabOptionOnSong, removeTabOptionFromSong, setDefaultTabOption,
    togglePinSong, getAlbumTabOptions, addTabOptionToAlbum, removeTabOptionFromAlbum, setDefaultAlbumTabOption,
    mapOpenFileToSong, getRecents, clearRecents, deleteRecentItem, getRecentItem, restoreRecentItem, addRecentOpened, DEFAULT_COLLECTION_ID
} from './libraryStore.js';
import {
    searchMusicBrainz, getArtistAlbums, getAlbumTracks, getMusicianRelations,
    getCoverArtUrl, getPlaceholderCoverSvg, isDvdOrBlurayMedium, isVinylOrTapeMedium, isNonCdMedium,
    filterInstrumentalBonusDiscs, hydrateCachedImages
} from './musicbrainz.js';
import { getStoredFile, saveStoredFile } from './fileStore.js';
import { loadFile, getCurrentFile } from './main.js';
import { openFromProvider, getFileProviders } from './fileProviders.js';
import { renderOpenFileView } from './openFileModal.js';
import { renderSetlistsView, openAddToSetlistModal } from './setlistUi.js';
import { extractScoreTunings, inferTuningFromTextOrName, detectFileMetadata, getTuningInfo, setCustomTuningName, getCustomTuningName, getTuningCategory, isTuningMatchingInstrument, getInstrumentMode } from './utils/tuningUtils.js';
import { updateGlobalAudioControls } from './utils/navigationUtils.js';
import { isSupportedTabFile, canAcceptTabDrop } from './utils/fileHandlingUtils.js';
import { showToast } from './utils/toast.js';
import { scoreOptionsState, pauseSynthPlayer } from './gpProcessor/gpPlayer.js';
import { pauseYouTube } from './youtubePlayer.js';
import { fretboardController } from './fretboard/fretboardController.js';
import { updateUrl, clearUrl } from './utils/urlRouter.js';
import { gamepadManager } from './utils/gamepadManager.js';
import { toggleToolsMenu, closeToolsMenu } from './utils/toolsMenu.js';
import { renderToolsPage, releaseEmbeddedTools } from './utils/toolsPage.js';

let activeView = 'library'; // 'library', 'search', 'recents', 'openFile', 'setlists', 'tools'
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
// File dropped on a custom folder, consumed by the Add Custom Music form: { file, folderPath }
let pendingCustomDrop = null;
let selectedFolderPath = []; // Array of folder path segments e.g. ['Exercises', 'Technique']
let selectedTuning = null;
let tuningsArtistFilter = ''; // artist name limiting the Tunings view, '' for all
let isAlbumEditMode = false;
let isRecentsEditMode = false;
let searchType = 'artist'; // 'artist' (default), 'song', 'album', 'musician', 'custom'
let currentSearchQuery = '';
let currentSearchResults = [];
let searchSubView = null; // null | { type: 'albums', artistMbid, artistName } | { type: 'bands', musicianMbid, musicianName } | { type: 'tracks', releaseGroupMbid, parentView }
let viewHistory = [];
let searchHistory = [];
let isSearching = false;
let searchDebounceTimer = null;

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

function initLibraryTopBar() {
    if (topBarInitialized) return;
    topBarInitialized = true;

    document.getElementById('libraryReturnToSongBtn')?.addEventListener('click', () => closeLibraryModal(false));

    window.addEventListener('libraryDataChanged', () => {
        // The add-music view updates its own buttons; a full re-render would reset it to the start
        if (isLibraryOpen() && activeView !== 'search') {
            renderLibraryModal();
        }
    });
}

let currentExploreTracklistToken = 0;
let currentExploreArtistToken = 0;
let currentExploreMusicianToken = 0;

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
        searchSubView: searchSubView ? { ...searchSubView } : null,
        searchType,
        currentSearchQuery,
        currentSearchResults: [...currentSearchResults],
        searchHistory: [...searchHistory]
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
        if (selectedArtist || selectedAlbum) return true;
    }
    if (activeView === 'search' && (searchSubView || searchHistory.length > 0)) return true;
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
    searchType = state.searchType || 'artist';
    currentSearchQuery = state.currentSearchQuery || '';
    currentSearchResults = state.currentSearchResults ? [...state.currentSearchResults] : [];
    searchHistory = state.searchHistory ? [...state.searchHistory] : [];
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
            if (selectedArtist) {
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
        } else if (activeView === 'search') {
            const searchHeader = document.querySelector('.search-sticky-header');
            let resContainer = document.getElementById('mbSearchResultsContainer');
            if (!searchHeader || !resContainer) {
                renderSearchMusicBrainzView(content);
                resContainer = document.getElementById('mbSearchResultsContainer') || content;
            }

            if (searchHistory.length > 0) {
                const prevSearch = searchHistory.pop();
                if (prevSearch.type === 'results') {
                    searchSubView = null;
                    const header = document.querySelector('.search-sticky-header');
                    if (header) header.style.display = '';
                    renderSearchResults(currentSearchResults, searchType, resContainer);
                } else if (prevSearch.type === 'albums') {
                    searchSubView = prevSearch;
                    const header = document.querySelector('.search-sticky-header');
                    if (header) header.style.display = 'none';
                    await exploreArtistAlbums(prevSearch.artistMbid, prevSearch.artistName, resContainer, false);
                } else if (prevSearch.type === 'bands') {
                    searchSubView = prevSearch;
                    const header = document.querySelector('.search-sticky-header');
                    if (header) header.style.display = 'none';
                    await exploreMusicianBands(prevSearch.musicianMbid, prevSearch.musicianName, resContainer, false);
                }
                return true;
            }
            if (searchSubView) {
                searchSubView = null;
                const header = document.querySelector('.search-sticky-header');
                if (header) header.style.display = '';
                renderSearchResults(currentSearchResults, searchType, resContainer);
                return true;
            }
            if (viewHistory.length > 0) {
                const prev = viewHistory.pop();
                activeView = prev.view || 'library';
                selectedArtist = prev.selectedArtist || null;
                pinnedGroupSelected = prev.selectedArtist ? false : null;
                selectedAlbum = prev.selectedAlbum || null;
                selectedAlbumFilter = prev.selectedAlbumFilter || 'all';
                selectedFolderPath = prev.selectedFolderPath || [];
                selectedTuning = prev.selectedTuning || null;
                searchSubView = prev.searchSubView || null;
                await renderLibraryModal();
                return true;
            } else {
                await switchView('library', false);
                return true;
            }
        } else if (activeView === 'recents' || activeView === 'openFile' || activeView === 'setlists' || activeView === 'tools') {
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
    let startX = 0;
    let startY = 0;
    let isTrackingNav = false;
    const SWIPE_MIN_DISTANCE = 50;

    page.addEventListener('touchstart', (e) => {
        isTouchScrolling = false;
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            // Ignore if touching interactive sliders or form inputs
            if (e.target && e.target.closest && e.target.closest('input, textarea, select')) {
                isTrackingNav = false;
            } else {
                isTrackingNav = true;
            }
        } else {
            isTrackingNav = false;
        }
    }, { passive: true });

    page.addEventListener('touchmove', () => {
        isTouchScrolling = true;
        blurActiveLibraryElement(page);
    }, { passive: true });

    page.addEventListener('touchend', (e) => {
        if (isTouchScrolling) {
            blurActiveLibraryElement(page);
            setTimeout(() => blurActiveLibraryElement(page), 50);
        } else {
            blurActiveLibraryElement(page, true);
            setTimeout(() => blurActiveLibraryElement(page, true), 50);
        }
        isTouchScrolling = false;

        if (isTrackingNav && e.changedTouches && e.changedTouches.length === 1) {
            const touch = e.changedTouches[0];
            const deltaX = touch.clientX - startX;
            const deltaY = Math.abs(touch.clientY - startY);

            // Require strong horizontal intent (deltaX significantly larger than vertical deltaY)
            if (Math.abs(deltaX) >= SWIPE_MIN_DISTANCE && Math.abs(deltaX) > deltaY * 1.5) {
                if (deltaX > 0) {
                    // Swiping right -> Safari Back
                    if (canGoBack()) {
                        handleBack();
                    }
                } else {
                    // Swiping left -> Safari Forward
                    if (canGoForward()) {
                        handleForward();
                    }
                }
            }
        }
        isTrackingNav = false;
    }, { passive: true });

    page.addEventListener('touchcancel', () => {
        isTouchScrolling = false;
        isTrackingNav = false;
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
    const returnBtn = document.getElementById('libraryReturnToSongBtn');
    const returnName = document.getElementById('libraryReturnSongName');
    const brandText = document.getElementById('brand-text');
    const songBreadcrumb = document.getElementById('songBreadcrumb');
    const currentOpen = getCurrentFile();

    if (modeButtons) modeButtons.style.display = 'none';
    if (globalAudio) globalAudio.style.display = 'none';
    if (audioSourcePill) audioSourcePill.style.display = 'none';
    if (navButtons) navButtons.style.display = 'none';
    if (songBreadcrumb) songBreadcrumb.style.display = 'none';
    if (brandText) brandText.style.display = '';

    const brandSection = document.getElementById('brandSection');
    const mobileDock = document.getElementById('mobilePlaybackDock');
    if (mobileDock) mobileDock.style.display = 'none';
    document.body.classList.add('library-view-active');

    // Hide the fretboard in the library without clearing the saved open preference
    try {
        fretboardController?.setScoreAvailable(false);
    } catch (_) {}

    if (returnBtn) {
        if (currentOpen && (currentOpen.songTitle || currentOpen.librarySongTitle || currentOpen.name)) {
            const displayName = currentOpen.songTitle || currentOpen.librarySongTitle || currentOpen.name.replace(/\.[^/.]+$/, '');
            returnBtn.style.display = 'inline-flex';
            if (returnName) returnName.textContent = displayName;
            returnBtn.title = `Return to score: ${displayName}`;
            if (brandSection) brandSection.classList.add('has-return-song');
        } else {
            returnBtn.style.display = 'none';
            if (brandSection) brandSection.classList.remove('has-return-song');
        }
    }

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
        releaseEmbeddedTools();
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
        const returnBtn = document.getElementById('libraryReturnToSongBtn');
        const brandText = document.getElementById('brand-text');
        const songBreadcrumb = document.getElementById('songBreadcrumb');
        const songTitleEl = document.getElementById('topBarSongTitle');

        if (modeButtons) modeButtons.style.display = currentOpen ? 'flex' : 'none';
        if (returnBtn) returnBtn.style.display = 'none';

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
        const brandSection = document.getElementById('brandSection');
        if (brandSection) brandSection.classList.remove('has-return-song');

        if (navButtons && currentOpen) {
            navButtons.style.display = 'flex';
        }

        updateGlobalAudioControls();
    }
}

// Expose closeLibraryModal on window for automation/tests
if (typeof window !== 'undefined') {
    window.closeLibraryModal = closeLibraryModal;
    window.openLibraryModal = openLibraryModal;
}

/**
 * Toggle Tab Library Page
 */
export function toggleLibraryModal() {
    if (isLibraryOpen() && getCurrentFile()) {
        closeLibraryModal();
    } else {
        openLibraryModal(activeView || 'library');
    }
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

    const currentOpen = getCurrentFile();
    const returnBtn = document.getElementById('libraryReturnToSongBtn');
    const returnName = document.getElementById('libraryReturnSongName');
    const brandSection = document.getElementById('brandSection');
    if (returnBtn) {
        if (currentOpen && (currentOpen.songTitle || currentOpen.librarySongTitle || currentOpen.name)) {
            const displayName = currentOpen.songTitle || currentOpen.librarySongTitle || currentOpen.name.replace(/\.[^/.]+$/, '');
            returnBtn.style.display = 'inline-flex';
            if (returnName) returnName.textContent = displayName;
            returnBtn.title = `Return to score: ${displayName}`;
            if (brandSection) brandSection.classList.add('has-return-song');
        } else {
            returnBtn.style.display = 'none';
            if (brandSection) brandSection.classList.remove('has-return-song');
        }
    }

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
    if (activeView !== 'tools') releaseEmbeddedTools();
    if (activeView === 'library') {
        await renderLibraryBrowseView(content);
    } else if (activeView === 'search') {
        renderSearchMusicBrainzView(content);
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
            onAddToLibrary: () => switchView('search')
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
    const artists = hierarchy.artists || [];
    const pinnedSongs = hierarchy.pinnedSongs || [];

    // Re-sync selectedArtist and selectedAlbum against latest hierarchy data
    if (selectedArtist) {
        selectedArtist = artists.find(a => a.name === selectedArtist.name || (selectedArtist.artistMbid && a.artistMbid === selectedArtist.artistMbid)) || null;
    }
    if (selectedAlbum && selectedArtist) {
        selectedAlbum = selectedArtist.albums.find(a => a.title === selectedAlbum.title || (selectedAlbum.albumMbid && a.albumMbid === selectedAlbum.albumMbid)) || null;
    }

    // Top Library Body Toolbar (Collection Selector + Mode Selector + Universal Search/Filter + Add Music)
    const inTunings = libraryBrowseMode === 'tunings';
    const collectionSelectHtml = collections.length > 1 ? `<div class="collection-pill-group">
        <select class="theme-select collection-select-input" id="libCollectionSelect" title="Select Collection" aria-label="Select Collection">
          ${collections.map(c => `<option value="${c.id}" ${c.id === activeCollectionId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>` : '';
    const headerHtml = `
    <div class="library-page-container ${inTunings ? 'tunings-view' : ''}">
      ${libraryHeaderHtml({
        activeTab: inTunings ? 'tunings' : 'library',
        searchId: 'libFilterInput',
        clearId: 'libFilterClearBtn',
        placeholder: inTunings
            ? 'Search tunings...'
            : 'Search your library',
        searchLabel: inTunings ? 'Search tunings' : 'Search library'
    })}
    `;

    if (artists.length === 0) {
        container.innerHTML = headerHtml + libraryListToolbarHtml({ leftHtml: collectionSelectHtml }) + `
          ${libraryEmptyStateHtml({
            icon: 'bi-music-note-list',
            title: 'This collection is empty',
            message: 'Add your favorite songs and albums to build your personalized tab catalog, or add custom music and exercises.',
            actionsHtml: `<button class="btn btn-theme-outline btn-sm px-4" id="emptyStateOpenFileBtn"><i class="bi-folder2-open me-1"></i> Open File</button>
              <button class="btn btn-theme-primary btn-sm px-4" id="emptyStateAddBtn"><i class="bi-plus-lg me-1"></i> Add Music</button>`
          })}
        </div>
        `;

        bindLibraryToolbarEvents(container);
        container.querySelector('#emptyStateAddBtn')?.addEventListener('click', () => { searchType = 'artist'; switchView('search'); });
        container.querySelector('#emptyStateOpenFileBtn')?.addEventListener('click', () => switchView('openFile'));
        return;
    }

    let tuningArtistSelectHtml = '';
    let breadcrumbHtml = '';
    let bodyHtml = '';
    let toolbarHtml = '';
    const addMusicBtnHtml = `<button type="button" class="btn btn-sm btn-theme-primary p-1 px-3 d-flex align-items-center gap-1" id="libAddMusicBtn" title="Search catalog or add custom music"><i class="bi-plus-lg"></i> <span>Add Music</span></button>`;

    // ==========================================
    // A. TUNINGS BROWSE MODE
    // ==========================================
    if (libraryBrowseMode === 'tunings') {
        const tuningsHierarchy = await getLibraryTuningsHierarchy(activeCollectionId);
        const allTuningGroups = tuningsHierarchy.tunings || [];
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
                actionsHtml: tuningArtistSelectHtml,
                count: '0 tunings'
            });
            bodyHtml = `
            <div class="tunings-body">
              ${libraryEmptyStateHtml({
                icon: 'bi-sliders',
                title: 'No tunings yet',
                message: 'Add tab files with guitar or bass scores to see your songs categorized by tuning.'
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
                actionsHtml: tuningArtistSelectHtml,
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
                    <span class="pinned-group-glyph" aria-hidden="true"><i class="bi-sliders"></i></span>
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
                <h3 class="pane-head"><span>Tunings</span><span class="tnum">${tuningGroups.length}</span></h3>
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
                <h3 class="pane-head">
                  <button class="btn btn-sm btn-ghost in-view-back-btn p-1 px-2 d-md-none" id="tuningsBackBtn" type="button"><i class="bi-chevron-left"></i> Tunings</button>
                  <span class="text-white fw-semibold" style="flex:1;">${escapeHtml(currentGroup.name)}</span>
                  <span class="tnum">${escapeHtml(summary)}</span>
                </h3>
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
            <div class="tunings-body">
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
                actionsHtml: addMusicBtnHtml
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
                <span class="badge badge-theme-secondary d-none d-sm-inline-flex py-1 px-2" style="font-size: 0.72rem;">
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
                        const coverSrc = alb.coverUrl || getPlaceholderCoverSvg(alb.title);
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

                const albumBlocksHtml = albumsToRender.map(alb => {
                    const coverSrc = alb.coverUrl || getPlaceholderCoverSvg(alb.title);
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
                          <button type="button" class="btn btn-sm btn-theme-outline explore-album-tracklist-btn py-1 px-2 d-none d-sm-inline-flex align-items-center gap-1" data-album-title="${escapeHtml(alb.title)}" title="Explore complete album tracklist on MusicBrainz">
                            <span>Tracklist</span>
                          </button>
                          <div class="dropdown">
                            <button class="btn btn-sm btn-theme-outline py-1 px-2 dropdown-toggle d-flex align-items-center gap-1" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="Attach tab or book to album">
                              <span>Album tab</span>
                            </button>
                            <ul class="dropdown-menu dropdown-menu-end theme-dropdown-menu">
                              ${window.__TAURI__ ? `<li><button class="dropdown-item small import-album-tab-btn" data-album-title="${escapeHtml(alb.title)}" data-provider-id="tab-downloader"><i class="bi-search me-2 text-info"></i> Web Search</button></li>` : ''}
                              <li><button class="dropdown-item small import-album-tab-btn" data-album-title="${escapeHtml(alb.title)}" data-provider-id="local"><i class="bi-folder2-open me-2 text-primary"></i> Local Device</button></li>
                              <!-- @googleDrive:begin -->
                              <li><button class="dropdown-item small import-album-tab-btn" data-album-title="${escapeHtml(alb.title)}" data-provider-id="google-drive"><i class="icon-gdrive me-2"></i> Google Drive</button></li>
                              <!-- @googleDrive:end -->
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
                      <div>No songs in this artist.</div>
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
                        <button class="btn btn-sm btn-theme-outline dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="Attach a whole-book PDF to this folder">Add book</button>
                        <ul class="dropdown-menu dropdown-menu-end theme-dropdown-menu">
                          <li><button class="dropdown-item small import-album-tab-btn" data-provider-id="local"><i class="bi-folder2-open me-2 text-primary"></i> Local Device</button></li>
                          <!-- @googleDrive:begin -->
                          <li><button class="dropdown-item small import-album-tab-btn" data-provider-id="google-drive"><i class="icon-gdrive me-2"></i> Google Drive</button></li>
                          <!-- @googleDrive:end -->
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
                      <div>This folder is empty.</div>
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
                count: `${artists.length} ${artists.length === 1 ? 'artist' : 'artists'}`,
                actionsHtml: addMusicBtnHtml
            });

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
                      <img class="resume-cover" alt="" src="${last.coverUrl || getPlaceholderCoverSvg(last.artist || name)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(last.artist || name)}'">
                      <div class="resume-meta">
                        <div class="resume-kicker">Pick up where you left off</div>
                        <h2 class="resume-title">${escapeHtml(name)}</h2>
                        <div class="resume-sub tnum">${escapeHtml(subText)}Bar <span data-bar>${lastBar}</span> of ${totalBars}</div>
                      </div>
                      <button type="button" class="btn btn-theme-primary resume-btn" id="libResumeBtn"><i class="bi-play"></i> Resume</button>
                      ${rulerHtml}
                    </div>`;
                }
            } catch (_) { resumeHtml = ''; }

            // Custom Music sits with Pinned songs above the artists; it is not one of the artists
            const customGroup = artists.filter(a => a.isCustom);
            const regularArtists = artists.filter(a => !a.isCustom);
            const artistCardHtml = (artist) => ((pinnedActive || recentsActive) ? renderArtistCard(artist).replace(' aria-current="true"', '') : renderArtistCard(artist));
            const listPaneHtml = `
            <section class="pane list" aria-label="Artists">
              ${pinnedGroupHtml}
              ${recentsGroupHtml}
              ${customGroup.map(artistCardHtml).join('')}
              <h3 class="pane-head"><span>Artists</span><span class="tnum">${regularArtists.length}</span></h3>
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
              <h3 class="pane-head">
                <button class="btn btn-sm btn-ghost in-view-back-btn p-1 px-2 d-md-none" id="paneBackBtn" data-act="paneback" type="button"><i class="bi-chevron-left"></i> Library</button>
                <span class="text-white fw-semibold" style="flex:1;">Pinned songs</span>
                <span class="tnum">${pinnedSongs.length} ${pinnedSongs.length === 1 ? 'song' : 'songs'}</span>
              </h3>
              <div class="pane-scroll" id="libArtistDetailScroll">
                <div class="artist-detail-view">
                  <div class="library-songs-list d-flex flex-column gap-2" id="libSongsList">
                    ${pinnedSongs.map(song => renderSongRow(song, { showArtistAlbum: true, showTrackNumber: false, showCover: true })).join('')}
                  </div>
                </div>
              </div>
            </section>
            `;

            const recentsPaneHtml = `
            <section class="pane songs" aria-label="Recents">
              <h3 class="pane-head">
                <button class="btn btn-sm btn-ghost in-view-back-btn p-1 px-2 d-md-none" id="paneBackBtn" data-act="paneback" type="button"><i class="bi-chevron-left"></i> Library</button>
                <span class="text-white fw-semibold" style="flex:1;">Recents</span>
                <span class="tnum">${formatCount(recentsList.length, 'song')}</span>
                ${isRecentsEditMode ? `<button class="btn btn-sm btn-theme-danger" id="clearRecentsBtn" title="Clear all recent history">Clear history</button>` : ''}
                <button class="btn btn-sm btn-theme-outline" id="toggleRecentsEditBtn" title="${isRecentsEditMode ? 'Done editing' : 'Edit recents list'}">${isRecentsEditMode ? 'Done' : 'Edit'}</button>
              </h3>
              <div class="pane-scroll" id="libArtistDetailScroll">
                <div class="artist-detail-view">
                  <div class="d-flex flex-column gap-2" id="recentsList">
                    ${recentsList.map(recentRowHtml).join('')}
                  </div>
                </div>
              </div>
            </section>
            `;

            const songsPaneHtml = recentsActive ? recentsPaneHtml : pinnedActive ? pinnedPaneHtml : `
            <section class="pane songs" aria-label="Songs">
              <h3 class="pane-head">
                <button class="btn btn-sm btn-ghost in-view-back-btn p-1 px-2 d-md-none" id="paneBackBtn" data-act="paneback" type="button"><i class="bi-chevron-left"></i> Library</button>
                <span class="text-white fw-semibold" style="flex:1;">${escapeHtml(selectedArtist.name)}</span>
                <span class="tnum">${totalSongsForPane} ${totalSongsForPane === 1 ? 'song' : 'songs'}${!isCustomArtist && selectedArtist.albums.length > 0 ? ` · ${selectedArtist.albums.length} ${selectedArtist.albums.length === 1 ? 'album' : 'albums'}` : ''}</span>
                ${customTopLevel ? `<button class="btn btn-sm btn-theme-outline toggle-album-edit-btn" id="toggleAlbumEditBtn" title="${isAlbumEditMode ? 'Done editing' : 'Edit and delete songs'}">${isAlbumEditMode ? 'Done' : 'Edit'}</button>` : ''}
              </h3>
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

    if (!toolbarHtml) toolbarHtml = libraryListToolbarHtml({ leftHtml: collectionSelectHtml, actionsHtml: tuningArtistSelectHtml });
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

    // Drop a file on the custom music space (the whole library pane, or the Custom Music card) to open Add Custom Music with it attached
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
        pendingCustomDrop = { file, folderPath: target.folderPath };
        searchType = 'custom';
        await switchView('search');
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
        card.addEventListener('click', () => {
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
        activeLibraryPane = 'list';
        renderLibraryBrowseView(container);
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
    { id: 'library', label: 'Library', title: 'Browse your tab library', icon: 'bi-music-note-list' },
    { id: 'setlists', label: 'Setlists', title: 'Build and play setlists of tabs', icon: 'bi-collection-play' },
    { id: 'tools', label: 'Tools', title: 'Tuner, reference library and Jam', icon: 'bi-grid-3x3-gap' },
    { id: 'tunings', label: 'Tunings', title: 'Browse songs by guitar and bass tuning', icon: 'bi-sliders' }
];

// Desktop view switcher shared by every library page header (phones use the bottom nav instead)
export function libraryViewSwitchHtml(activeTab = null) {
    return `<div class="hud-pill-group lib-view-switch" role="group" aria-label="Library views">
      ${LIBRARY_TABS.map(t => `<button type="button" class="btn btn-sm ${t.id === activeTab ? 'active' : ''}" data-lib-tab="${t.id}" title="${t.title}"><i class="${t.icon}"></i><span class="lib-view-switch-label">${t.label}</span></button>`).join('')}
    </div>`;
}

// Shared chrome for every library view: centered view switcher, then its own search box, then (below, via
// libraryListToolbarHtml) a count on the left and the primary action on the right.
export function libraryHeaderHtml({ activeTab, searchId, clearId, placeholder, searchLabel, searchDisabled = false }) {
    return `<div class="lib-view-switch-row">${libraryViewSwitchHtml(activeTab)}</div>
      <div class="library-search-box mb-3">
        <div class="library-search-bar">
          <i class="bi-search search-icon"></i>
          <input type="text" class="search-input" id="${searchId}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" aria-label="${searchLabel}" ${searchDisabled ? 'disabled' : ''}>
          <button class="search-clear-btn" type="button" id="${clearId}" title="Clear search" aria-label="Clear search" style="display: none;">
            <i class="bi-x-lg"></i>
          </button>
          <kbd class="search-key-hint" aria-hidden="true">/</kbd>
        </div>
      </div>`;
}

// "/" focuses the library search from anywhere that is not a text field (one listener for the app)
let librarySearchShortcutBound = false;
function bindLibrarySearchShortcut() {
    if (librarySearchShortcutBound) return;
    librarySearchShortcutBound = true;
    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
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

// Centered page title for library pages that are not a switcher tab (Open File, Add Music)
export function libraryPageTitleHtml({ icon, title, subtitle = '' }) {
    return `<div class="library-page-title">
        <h5 class="library-page-title-text">${title}</h5>
        ${subtitle ? `<p class="library-page-title-sub">${subtitle}</p>` : ''}
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
            count.textContent = q ? String(visible.length) : count.dataset.total;
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
    if (activeView === 'library') return libraryBrowseMode === 'tunings' ? 'tunings' : 'library';
    return activeView === 'setlists' || activeView === 'recents' || activeView === 'tools' ? activeView : null;
}

// Shared by the desktop view switcher and the phone bottom nav
export async function goLibraryTab(tab) {
    if (tab === 'setlists' || tab === 'recents' || tab === 'tools') {
        if (activeView !== tab) await switchView(tab);
        return;
    }
    const wantTunings = tab === 'tunings';
    const alreadyThere = activeView === 'library' && (libraryBrowseMode === 'tunings') === wantTunings;
    if (!alreadyThere) pushLibraryNavigationState();
    activeView = 'library';
    libraryBrowseMode = wantTunings ? 'tunings' : 'artists';
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
        const [lib, setlists, tools, tunings] = LIBRARY_TABS;
        nav = document.createElement('nav');
        nav.id = 'libraryBottomNav';
        nav.className = 'library-bottom-nav';
        nav.setAttribute('aria-label', 'Library');
        // Phones: bottom tab bar. Wide windows: left rail (CSS). Settings sits last; Add music stays in each list's toolbar.
        const PICK_D = "M243.89,410.70C231.98,405.69 222.99,398.82 207.45,382.85C140.70,314.27 93.23,213.94 105.31,167.00C114.73,130.40 146.89,109.16 207.00,99.85C226.60,96.81 281.05,96.50 301.00,99.31C373.92,109.58 407.60,136.53 407.46,184.50C407.32,232.23 371.35,306.44 318.76,367.50C286.51,404.94 262.77,418.64 243.89,410.70Z";
        const LETTERS_D = "M232.00,343.05L232.00,330.10L237.25,329.80L242.50,329.50L242.77,306.25L243.04,283.00L228.27,283.00L213.50,283.00L213.84,289.00L214.18,295.00L218.09,295.00L222.00,295.00L222.00,307.50L222.00,320.00L198.00,320.00L174.00,320.00L174.00,307.50L174.00,295.00L178.00,295.00L182.00,295.00L182.00,237.50L182.00,180.00L175.00,180.00L168.00,180.00L168.00,163.98L168.00,147.96L191.10,148.23L214.20,148.50L232.67,178.50C242.83,195.00 252.24,210.64 253.59,213.25C254.93,215.86 256.20,218.00 256.41,218.00C256.61,218.00 266.17,202.26 277.64,183.03L298.50,148.05L321.25,148.03L344.00,148.00L344.00,164.00L344.00,180.00L337.00,180.00L330.00,180.00L330.00,237.50L330.00,295.00L334.50,295.00L339.00,295.00L339.00,307.50L339.00,320.00L314.50,320.00L290.00,320.00L290.00,307.50L290.00,295.00L294.50,295.00L299.00,295.00L299.00,288.75L299.00,282.50L284.50,282.80L270.00,283.10L270.00,306.55L270.00,330.00L275.50,330.00L281.00,330.00L281.00,343.00L281.00,356.00L256.50,356.00L232.00,356.00L232.00,343.05ZM239.24,251.75C238.16,249.96 232.42,240.40 226.49,230.50C220.55,220.60 215.31,212.07 214.85,211.55C214.38,211.03 214.00,220.57 214.00,232.80L214.00,255.00L227.60,255.00L241.20,255.00L239.24,251.75ZM299.00,232.27L299.00,209.55L291.04,223.30C286.67,230.87 280.59,241.10 277.54,246.03L271.99,255.00L285.49,255.00L299.00,255.00L299.00,232.27Z";
        const PICK = `<svg class="rail-pick" viewBox="105 97 303 316" aria-hidden="true"><path fill="var(--action)" d="${PICK_D}"/><path fill="var(--on-action, #fff)" d="${LETTERS_D}"/></svg>`;
        nav.innerHTML = `<div class="rail-brand">${PICK}<span class="rail-wordmark">Majestic<b>Tab</b></span></div>${tabHtml(lib)}${tabHtml(setlists)}${tabHtml(tunings)}${tabHtml(tools)}
          <button type="button" class="library-nav-tab library-nav-settings" id="libraryNavSettingsBtn" title="Settings" aria-controls="fileMenu"><i class="bi-gear"></i><span>Settings</span></button>`;
        nav.addEventListener('click', (e) => {
            const tab = e.target.closest('[data-lib-tab]');
            if (tab) {
                // Settings is a page beside the rail: leaving it for another destination closes it
                closeSettingsPage();
                closeToolsMenu();
                return goLibraryTab(tab.dataset.libTab);
            }
            if (e.target.closest('#libraryNavSettingsBtn')) {
                const panel = document.getElementById('fileMenu');
                if (panel) {
                    // Opened from the navigation, Settings is a page: it fills the content area beside the rail
                    if (!panel.dataset.pageHooked) {
                        panel.dataset.pageHooked = '1';
                        panel.addEventListener('settings:shown', syncLibraryBottomNav);
                        panel.addEventListener('settings:hidden', syncLibraryBottomNav);
                    }
                    closeToolsMenu();
                    settingsPanel.toggle();
                    syncLibraryBottomNav();
                }
            }
        });
        document.body.appendChild(nav);
    }
    // While the Settings page is open it is the one current destination, not the tab underneath it
    const settingsOpen = isSettingsPageOpen();
    const active = settingsOpen ? null : getActiveLibraryTab();
    nav.querySelectorAll('[data-lib-tab]').forEach(b => b.classList.toggle('active', b.dataset.libTab === active));
    const settingsBtn = nav.querySelector('#libraryNavSettingsBtn');
    settingsBtn?.classList.toggle('active', settingsOpen);
    if (settingsBtn) settingsOpen ? settingsBtn.setAttribute('aria-current', 'page') : settingsBtn.removeAttribute('aria-current');
}

function isSettingsPageOpen() {
    return document.body.classList.contains('settings-as-page') && document.getElementById('fileMenu')?.classList.contains('show');
}

function closeSettingsPage() {
    settingsPanel.hide();
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

    container.querySelector('#libTuningArtistSelect')?.addEventListener('change', (e) => {
        tuningsArtistFilter = e.target.value;
        renderLibraryBrowseView(container);
    });

    container.querySelector('#libAddMusicBtn')?.addEventListener('click', () => {
        searchType = 'artist';
        switchView('search');
    });
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
    const songCount = (artist.songs ? artist.songs.length : 0) + (artist.albums ? artist.albums.reduce((acc, a) => acc + (a.songs ? a.songs.length : 0), 0) : 0);
    const bookCount = (artist.rootBooks || 0) + (artist.albums ? artist.albums.reduce((acc, a) => acc + (a.tabOptions ? a.tabOptions.length : 0), 0) : 0);
    const collageHtml = renderArtistCollageHtml(artist);
    const isCurrent = selectedArtist && (artist.name === selectedArtist.name || (selectedArtist.artistMbid && artist.artistMbid === selectedArtist.artistMbid));
    return `
    <div class="library-card artist-card p-3" data-artist-name="${escapeHtml(artist.name)}" ${isCurrent ? 'aria-current="true"' : ''} role="button" tabindex="0">
      <div class="d-flex align-items-center gap-3 min-w-0">
        ${collageHtml}
        <div class="min-w-0 flex-grow-1">
          <h6 class="mb-1 fw-bold text-white text-truncate" title="${escapeHtml(artist.name)}">${escapeHtml(artist.name)}</h6>
          <div class="small text-muted text-truncate">${albumCount > 0 ? `${formatCount(albumCount, isCustomArtist ? 'folder' : 'album')} · ` : ''}${isCustomArtist ? formatBooksSongsLabel(bookCount, songCount) : formatCount(songCount, 'song')}</div>
        </div>
        <i class="bi-chevron-right text-muted flex-shrink-0"></i>
      </div>
    </div>
    `;
}

function renderAlbumCard(album, artistName = '') {
    const isCustom = Boolean(album.isCustom);
    const title = album.title || album.name || '';
    const cover = album.coverUrl || (isCustom ? null : getPlaceholderCoverSvg(title));
    const songCount = Array.isArray(album.songs) ? album.songs.length : (album.songsCount || 0);
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

function renderDownloaderSearchButton(rawQuery) {
    if (!window.__TAURI__) return '';
    return `
      <div class="text-center mt-3 mb-4">
        <button type="button" class="btn btn-sm btn-theme-outline d-inline-flex align-items-center gap-2" id="libFilterDownloaderBtn">
          <i class="bi-search text-info"></i>
          <span>Search "${escapeHtml(rawQuery)}" on the web</span>
        </button>
      </div>`;
}

function wireDownloaderSearchButton(root, rawQuery) {
    root.querySelector('#libFilterDownloaderBtn')?.addEventListener('click', () => {
        openFromProvider('tab-downloader', { query: rawQuery });
    });
}

function setupLibraryFilter(container, context = {}) {
    const filterInput = container.querySelector('#libFilterInput');
    const clearBtn = container.querySelector('#libFilterClearBtn');
    if (!filterInput) return;

    if (libraryBrowseMode === 'tunings' && !context.selectedAlbum) {
        bindTwoPaneFilter(container, { inputId: 'libFilterInput', clearId: 'libFilterClearBtn', key: 'tunings', cardSelector: '.tuning-card', rowSelector: '.pane.songs .library-song-row' });
        return;
    }

    const browseContent = container.querySelector('#libBrowseContent');
    const filterResults = container.querySelector('#libFilteredSearchResults');

    const applyFilter = () => {
        const rawQuery = (filterInput.value || '').trim();
        const query = rawQuery.toLowerCase();
        libraryFilterQuery = filterInput.value || '';
        if (clearBtn) {
            clearBtn.style.display = query.length > 0 ? 'inline-flex' : 'none';
        }

        // Clean up previous filter empty message if any
        container.querySelectorAll('.library-filter-empty-msg').forEach(el => el.remove());

        // 1. Song List View (Album Detail - specifically #libSongsList)
        if (context.selectedAlbum) {
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
            return;
        }

        // 2. Tunings View (#libTuningsList)
        if (libraryBrowseMode === 'tunings') {
            const tuningsList = container.querySelector('#libTuningsList');
            if (tuningsList) {
                const tuningCards = tuningsList.querySelectorAll('.tuning-card');
                let totalVisibleCount = 0;
                tuningCards.forEach(card => {
                    const name = (card.dataset.tuningName || '').toLowerCase();
                    const notes = (card.dataset.tuningNotes || '').toLowerCase();
                    const key = (card.dataset.tuningKey || '').toLowerCase();
                    const text = (card.textContent || '').toLowerCase();
                    const matches = !query || name.includes(query) || notes.includes(query) || key.includes(query) || text.includes(query);
                    card.style.display = matches ? '' : 'none';
                    if (matches) totalVisibleCount++;
                });
                if (totalVisibleCount === 0 && query) {
                    const emptyMsg = document.createElement('div');
                    emptyMsg.className = 'library-filter-empty-msg text-center py-4 text-muted w-100';
                    emptyMsg.innerHTML = `<i class="bi-search fs-3 mb-2 d-block text-white-50"></i>No tunings match "${escapeHtml(query)}"`;
                    tuningsList.appendChild(emptyMsg);
                }
            }
            return;
        }

        // 3a. Two-pane library: search inside it. Artists that match stay in the list, the songs pane
        // follows the selected artist, and nothing is replaced by a results page.
        const rootView = container.querySelector('.collection-root-view');
        if (rootView) {
            const artistMatches = (art) => {
                if ((art.name || '').toLowerCase().includes(query)) return true;
                const songMatch = (s) => (s.title || '').toLowerCase().includes(query)
                    || (s.tabOptions || []).some(t => (t.name || '').toLowerCase().includes(query));
                if ((art.songs || []).some(songMatch)) return true;
                return (art.albums || []).some(alb => (alb.title || alb.name || '').toLowerCase().includes(query) || (alb.songs || []).some(songMatch));
            };
            const byName = new Map((context.artists || []).map(a => [a.name, a]));
            let visibleArtists = 0, visibleRegular = 0;
            rootView.querySelectorAll('.artist-card').forEach(card => {
                const art = byName.get(card.dataset.artistName);
                const hit = !query || (art ? artistMatches(art) : (card.textContent || '').toLowerCase().includes(query));
                card.classList.toggle('lib-filter-hidden', !hit);
                if (hit) { visibleArtists++; if (card.closest('#libArtistsGrid')) visibleRegular++; }
            });
            const listCount = rootView.querySelector('.pane.list .pane-head .tnum');
            if (listCount) {
                if (listCount.dataset.total === undefined) listCount.dataset.total = listCount.textContent;
                listCount.textContent = query ? String(visibleRegular) : listCount.dataset.total;
            }
            const pinnedBtn = rootView.querySelector('#libPinnedGroupBtn');
            const pinnedHit = !query || (context.pinnedSongs || []).some(sg => `${sg.title || ''} ${sg.artist || ''} ${sg.album || ''}`.toLowerCase().includes(query));
            pinnedBtn?.classList.toggle('lib-filter-hidden', !pinnedHit);
            const recentsBtn = rootView.querySelector('#libRecentsGroupBtn');
            recentsBtn?.classList.toggle('lib-filter-hidden', Boolean(query) && !'recents recent tabs'.includes(query));
            const pinnedActive = pinnedBtn?.getAttribute('aria-current') === 'true' || recentsBtn?.getAttribute('aria-current') === 'true';
            const selectedName = context.selectedArtist?.name;
            const selectedCard = [...rootView.querySelectorAll('.artist-card')].find(c => c.dataset.artistName === selectedName);
            // The selected artist dropped out of the list: move to the first one that still matches
            if (query && !pinnedActive && selectedCard && selectedCard.classList.contains('lib-filter-hidden')) {
                const first = [...rootView.querySelectorAll('.artist-card')].find(c => !c.classList.contains('lib-filter-hidden'));
                if (first) { first.click(); return; }
            }
            const selectedArtistMatches = !query || (!pinnedActive && (selectedName || '').toLowerCase().includes(query));
            const rows = rootView.querySelectorAll('.pane.songs .library-song-row');
            let shownRows = 0;
            rows.forEach(row => {
                const hit = selectedArtistMatches || (row.textContent || '').toLowerCase().includes(query);
                row.classList.toggle('lib-filter-hidden', !hit);
                if (hit) shownRows++;
            });
            const songsPane = rootView.querySelector('.pane.songs .pane-scroll');
            if (songsPane && rows.length && shownRows === 0 && query) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'library-filter-empty-msg text-center py-4 text-muted';
                emptyMsg.textContent = 'Nothing matches that search.';
                songsPane.appendChild(emptyMsg);
            }
            const noneAtAll = query && visibleArtists === 0 && !pinnedHit;
            if (browseContent) browseContent.style.display = noneAtAll ? 'none' : 'block';
            if (filterResults) {
                filterResults.style.display = noneAtAll ? 'block' : 'none';
                filterResults.innerHTML = noneAtAll ? `
                <div class="library-filter-empty-msg text-center py-5 text-muted">
                  <div>No artist or song matches "${escapeHtml(rawQuery)}". Clear the search to see everything.</div>
                </div>
                ${renderDownloaderSearchButton(rawQuery)}` : '';
                if (noneAtAll) wireDownloaderSearchButton(filterResults, rawQuery);
            }
            return;
        }

        // 3. Collection Root View OR Artist Detail View (Artists browse mode)
        if (!query) {
            if (browseContent) browseContent.style.display = 'block';
            if (filterResults) {
                filterResults.style.display = 'none';
                filterResults.innerHTML = '';
            }
            return;
        }

        // A query is active: filter down directly to the searched objects!
        if (browseContent) browseContent.style.display = 'none';
        if (!filterResults) return;
        filterResults.style.display = 'block';

        const artistsList = context.selectedArtist ? [context.selectedArtist] : (context.artists || []);
        const matchingSongs = [];
        const matchingAlbums = [];
        const matchingArtists = [];

        // Check matching artists (only if at collection root)
        if (!context.selectedArtist) {
            for (const art of artistsList) {
                if ((art.name || '').toLowerCase().includes(query)) {
                    matchingArtists.push(art);
                }
            }
        }

        // Collect matching songs and albums
        for (const art of artistsList) {
            if (Array.isArray(art.songs)) {
                for (const s of art.songs) {
                    const titleMatch = (s.title || '').toLowerCase().includes(query);
                    const tabMatch = s.tabOptions && s.tabOptions.some(t => (t.name || '').toLowerCase().includes(query));
                    if (titleMatch || tabMatch) {
                        matchingSongs.push({
                            ...s,
                            artist: s.artist || art.name,
                            album: s.album || ''
                        });
                    }
                }
            }

            if (Array.isArray(art.albums)) {
                for (const alb of art.albums) {
                    const albTitle = alb.title || alb.name || '';
                    if (albTitle.toLowerCase().includes(query)) {
                        matchingAlbums.push({
                            ...alb,
                            artistName: art.name
                        });
                    }

                    if (Array.isArray(alb.songs)) {
                        for (const s of alb.songs) {
                            const titleMatch = (s.title || '').toLowerCase().includes(query);
                            const tabMatch = s.tabOptions && s.tabOptions.some(t => (t.name || '').toLowerCase().includes(query));
                            if (titleMatch || tabMatch) {
                                matchingSongs.push({
                                    ...s,
                                    artist: s.artist || art.name,
                                    album: s.album || albTitle,
                                    coverUrl: s.coverUrl || alb.coverUrl || null
                                });
                            }
                        }
                    }
                }
            }
        }

        const hasMatches = matchingSongs.length > 0 || matchingAlbums.length > 0 || matchingArtists.length > 0;

        if (!hasMatches) {
            filterResults.innerHTML = `
            <div class="library-filter-empty-msg text-center py-5 text-muted">
              <i class="bi-search fs-3 mb-2 d-block text-white-50"></i>
              <div>No songs, albums, or artists match "${escapeHtml(query)}"</div>
            </div>
            ${renderDownloaderSearchButton(rawQuery)}
            `;
            wireDownloaderSearchButton(filterResults, rawQuery);
            return;
        }

        let html = '';

        // 1. Render Songs
        if (matchingSongs.length > 0) {
            html += `
            <div class="library-filter-section mb-4">
              <div class="small text-white-50 fw-semibold mb-2 d-flex align-items-center gap-2">
                <i class="bi-music-note-beamed text-info"></i> Songs
                <span class="badge badge-theme-secondary py-0 px-2" style="font-size:0.65rem;">${matchingSongs.length}</span>
              </div>
              <div class="library-songs-list d-flex flex-column gap-2" id="libFilterSongsList">
                ${matchingSongs.map(s => renderSongRow(s, { showArtistAlbum: true, showTrackNumber: false })).join('')}
              </div>
            </div>
            `;
        }

        // 2. Render Albums
        if (matchingAlbums.length > 0) {
            html += `
            <div class="library-filter-section mb-4">
              <div class="small text-white-50 fw-semibold mb-2 d-flex align-items-center gap-2">
                <i class="bi-disc text-primary"></i> Albums
                <span class="badge badge-theme-secondary py-0 px-2" style="font-size:0.65rem;">${matchingAlbums.length}</span>
              </div>
              <div class="library-albums-grid" id="libFilterAlbumsGrid">
                ${matchingAlbums.map(alb => renderAlbumCard(alb, alb.artistName)).join('')}
              </div>
            </div>
            `;
        }

        // 3. Render Artists
        if (matchingArtists.length > 0) {
            html += `
            <div class="library-filter-section mb-4">
              <div class="small text-white-50 fw-semibold mb-2 d-flex align-items-center gap-2">
                <i class="bi-person text-info"></i> Artists
                <span class="badge badge-theme-secondary py-0 px-2" style="font-size:0.65rem;">${matchingArtists.length}</span>
              </div>
              <div class="library-artists-grid" id="libFilterArtistsGrid">
                ${matchingArtists.map(art => renderArtistCard(art)).join('')}
              </div>
            </div>
            `;
        }

        filterResults.innerHTML = html + renderDownloaderSearchButton(rawQuery);
        wireDownloaderSearchButton(filterResults, rawQuery);

        // Wire up song row actions (play default tab, + tab, dropdowns, pin)
        setupSongRowActions(filterResults);

        // Click artist cards in filter results
        filterResults.querySelectorAll('.artist-card').forEach(card => {
            card.addEventListener('click', () => {
                clearCardInteractionState(card);
                pushLibraryNavigationState();
                const artistName = card.dataset.artistName;
                selectedArtist = (context.artists || []).find(a => a.name === artistName);
                selectedAlbum = null;
                selectedFolderPath = [];
                isAlbumEditMode = false;
                renderLibraryBrowseView(container);
            });
        });

        // Click album cards in filter results
        filterResults.querySelectorAll('.album-card').forEach(card => {
            card.addEventListener('click', () => {
                clearCardInteractionState(card);
                pushLibraryNavigationState();
                const artistName = card.dataset.artistName;
                const albumTitle = card.dataset.albumTitle;
                const targetArtist = (context.artists || []).find(a => a.name === artistName);
                if (targetArtist) {
                    selectedArtist = targetArtist;
                    selectedAlbum = targetArtist.albums?.find(al => al.title === albumTitle || al.name === albumTitle) || null;
                    selectedFolderPath = selectedAlbum ? (selectedAlbum.folderPath && selectedAlbum.isCustom ? selectedAlbum.folderPath.split('/') : [selectedAlbum.title || selectedAlbum.name]) : [];
                    isAlbumEditMode = false;
                    renderLibraryBrowseView(container);
                }
            });
        });

        // Hydrate images
        hydrateCachedImages(filterResults);
    };

    filterInput.addEventListener('input', applyFilter);

    clearBtn?.addEventListener('click', () => {
        filterInput.value = '';
        applyFilter();
        filterInput.focus();
    });

    // Re-rendered by picking an artist while a search is active: put the text back and filter again
    if (libraryFilterQuery && !filterInput.value && libraryBrowseMode === 'artists') {
        filterInput.value = libraryFilterQuery;
        applyFilter();
    } else if (!filterInput.value) {
        libraryFilterQuery = '';
    }
}

function renderArtistCollageHtml(artist) {
    const isCustom = Boolean(artist.isCustom);
    const covers = Array.from(new Set(
        (artist.albums || []).map(a => a.coverUrl).filter(Boolean)
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
    const coverUrl = song.coverUrl;

    return `
    <div class="library-pinned-card d-flex align-items-center gap-2 p-2 rounded-3 position-relative" 
         data-song-id="${song.id}" 
         data-song-title="${escapeHtml(song.title)}" 
         data-song-artist="${escapeHtml(artistName)}" 
         data-song-album="${escapeHtml(albumName)}"
         role="button"
         tabindex="0"
         title="Play ${escapeHtml(song.title)}">
      
      <div class="pinned-play-badge flex-shrink-0 ${coverUrl ? 'has-cover' : ''}" title="Play default tab">
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

function renderSongRow(song, options = {}) {
    const pdfPagesNoun = selectedArtist?.isCustom ? 'Book' : 'Album';
    const tabOptions = Array.isArray(song.tabOptions) ? song.tabOptions : [];
    const hasTabs = tabOptions.length > 0;
    const tunings = (Array.isArray(song.tunings) ? song.tunings : []).filter(t => isTuningMatchingInstrument(t));
    const durationText = formatTrackDuration(song.length);
    const isPinned = Boolean(song.pinned);
    const defaultTabId = song.defaultTabId || (tabOptions[0]?.id || null);
    const albumPdfTabs = (options.albumTabs || []).filter(t => (t.name || '').toLowerCase().endsWith('.pdf') || t.isPdf || t.fileType === 'pdf');
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

    const tuningChipsHtml = tunings.map(t => {
        const info = getTuningInfo(t);
        const label = info?.displayName || t;
        const isStandard = label.toLowerCase().includes('standard');
        return `<span class="chip ${isStandard ? '' : 'hot'}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
    }).join('');

    const pdfTab = tabOptions.find(t => t.startPage && t.endPage);
    const pdfChipHtml = pdfTab ? `<span class="chip sec" title="PDF ${formatPageRange(pdfTab.startPage, pdfTab.endPage)}">${formatPageRange(pdfTab.startPage, pdfTab.endPage)}</span>` : '';

    const multiTabsChipHtml = tabOptions.length > 1
        ? `<span class="chip sec" title="${tabOptions.length} tab versions attached"><i class="bi-file-earmark-music me-1 text-info"></i>${tabOptions.length} tabs</span>`
        : (!hasTabs ? `<span class="chip text-muted" style="opacity: 0.6;"><i class="bi-plus-circle me-1"></i>No tab</span>` : '');

    const isSynced = Boolean(song.hasSyncedAudio || song.syncedAudioUrl || (song.tabOptions && song.tabOptions.some(t => t.syncedAudio)));
    const syncDotHtml = isSynced ? `<span class="sync-dot" title="Synced audio available"></span>` : '';

    const tabOptionsListHtml = tabOptions.length > 1 ? `
      <div class="tab-options-container">
        <div class="tab-options-chips" role="list" aria-label="Tabs for ${escapeHtml(song.title)}">
        ${tabOptions.map((t, idx) => {
          const isDefault = (t.id === defaultTabId) || (!defaultTabId && idx === 0);
          const isPdfRange = Boolean(t.isAlbumRange || t.startPage);
          const tuningLabel = (t.tuning && isTuningMatchingInstrument(t.tuning)) ? (getTuningInfo(t.tuning)?.displayName || t.tuning) : '';
          const meta = [(t.startPage && t.endPage) ? formatPageRange(t.startPage, t.endPage) : '', tuningLabel].filter(Boolean).join(' \u00b7 ');
          return `
          <div class="tab-row ${isDefault ? 'tab-row-default' : ''} play-tab-chip-btn" role="listitem" data-song-id="${song.id}" data-tab-id="${t.id}" tabindex="0" title="Load ${escapeHtml(t.name)}">
            <span class="tab-option-name text-truncate">${escapeHtml(t.name)}</span>
            ${meta ? `<span class="tab-option-meta">${escapeHtml(meta)}</span>` : ''}
            <button class="btn btn-link p-0 set-default-tab-btn ${isDefault ? 'is-default' : ''}" data-song-id="${song.id}" data-tab-id="${t.id}" ${isDefault ? 'aria-pressed="true"' : ''} title="${isDefault ? 'This tab opens by default' : 'Open this tab by default'}">${isDefault ? 'Default' : 'Make default'}</button>
            ${isPdfRange && isAlbumEditMode ? `<button class="btn btn-link p-0 text-muted edit-tab-chip-btn" data-song-id="${song.id}" data-tab-id="${t.id}" aria-label="Edit page range" title="Edit tab range"><i class="bi-pencil" style="font-size:0.7rem;"></i></button>` : ''}
            ${isAlbumEditMode ? `<button class="btn btn-link p-0 text-muted remove-tab-chip-btn" data-song-id="${song.id}" data-tab-id="${t.id}" aria-label="Remove tab" title="Remove tab"><i class="bi-x"></i></button>` : ''}
          </div>
          `;
        }).join('')}
        </div>
      </div>
    ` : '';

    return `
    <div class="rowwrap library-song-rowwrap ${isPinned ? 'library-song-row-pinned' : ''}">
      <div class="song-row-container">
        <div class="song-row library-song-row" data-song-id="${song.id}" data-song-title="${escapeHtml(song.title)}" data-song-artist="${escapeHtml(song.artist || '')}" role="button" tabindex="0" title="Drag &amp; drop a tab file (.gp, .pdf, .txt) here to attach">
          ${trackNumStr === '\u2022' ? '' : `<span class="num tnum">${trackNumStr}</span>`}
          ${options.showCover ? `<img loading="lazy" decoding="async" class="song-cover" src="${song.coverUrl || getPlaceholderCoverSvg(song.album || song.title || 'Tab')}" alt="" draggable="false" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(song.title || 'Tab')}'">` : ''}
          <span class="t">
            <b>${escapeHtml(song.title)}</b>
            <span class="sub">
              ${options.showArtistAlbum ? `<span class="album-label text-truncate">${escapeHtml(song.artist || '')}${song.album ? ` • ${escapeHtml(song.album)}` : ''}</span>` : (options.showAlbum && song.album ? `<span class="album-label text-truncate">${escapeHtml(song.album)}</span>` : '')}
              ${tuningChipsHtml}
              ${pdfChipHtml}
              ${multiTabsChipHtml}
              ${syncDotHtml}
            </span>
          </span>
          ${durationText ? `<span class="end tnum">${durationText}</span>` : ''}
          ${hasTabs ? `<button type="button" class="play-default-tab-btn visually-hidden" data-song-id="${song.id}" aria-label="Play ${escapeHtml(song.title)}"></button>` : ''}
        </div>
        <div class="song-actions">
          <button type="button" class="btn btn-sm btn-theme-icon pin-song-btn ${isPinned ? 'text-warning' : 'text-muted'}" data-song-id="${song.id}" title="${isPinned ? 'Unpin song from collection' : 'Pin song to collection'}">
            <i class="bi-pin-angle${isPinned ? '-fill' : ''}"></i>
          </button>
          <div class="dropdown">
            ${!hasTabs ? `
              <button class="btn btn-sm btn-theme-outline py-0 px-2 dropdown-toggle d-flex align-items-center gap-1" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="Import Tab">
                <span>Add tab</span>
              </button>
            ` : `
              <button class="btn btn-sm btn-theme-icon text-muted dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="Song options">
                <i class="bi-three-dots"></i>
              </button>
            `}
            <ul class="dropdown-menu dropdown-menu-end theme-dropdown-menu">
              ${hasTabs ? `<li><button class="dropdown-item small add-to-setlist-btn" data-song-id="${song.id}"><i class="bi-collection-play me-2 text-info"></i> Add to Setlist</button></li>` : ''}
              ${albumPdfTabs.length > 0 ? (() => {
                const existingPdfTab = tabOptions.find(t => t.isAlbumRange || t.startPage);
                if (existingPdfTab) {
                  return `<li><button class="dropdown-item small set-album-pdf-pages-btn" data-song-id="${song.id}" data-tab-id="${existingPdfTab.id}"><i class="bi-file-earmark-pdf me-2 text-warning"></i> Edit ${pdfPagesNoun} PDF Pages...</button></li>
                  <li><hr class="dropdown-divider"></li>`;
                }
                return `<li><button class="dropdown-item small set-album-pdf-pages-btn" data-song-id="${song.id}"><i class="bi-file-earmark-pdf me-2 text-warning"></i> Set ${pdfPagesNoun} PDF Pages...</button></li>
                <li><hr class="dropdown-divider"></li>`;
              })() : ''}
              ${window.__TAURI__ ? `<li><button class="dropdown-item small import-tab-provider-btn" data-song-id="${song.id}" data-provider-id="tab-downloader"><i class="bi-search me-2 text-info"></i> Web Search</button></li>` : ''}
              <li><button class="dropdown-item small import-tab-provider-btn" data-song-id="${song.id}" data-provider-id="local"><i class="bi-folder2-open me-2 text-primary"></i> Local Device</button></li>
              <!-- @googleDrive:begin -->
              <li><button class="dropdown-item small import-tab-provider-btn" data-song-id="${song.id}" data-provider-id="google-drive"><i class="icon-gdrive me-2"></i> Google Drive</button></li>
              <!-- @googleDrive:end -->
              ${isAlbumEditMode ? `
                <li><hr class="dropdown-divider"></li>
                <li><button class="dropdown-item small text-danger delete-song-btn" data-song-id="${song.id}"><i class="bi-trash me-2"></i> Remove from Library</button></li>
              ` : ''}
            </ul>
          </div>
          ${isAlbumEditMode ? `
            <button type="button" class="btn btn-sm btn-theme-danger p-1 px-2 delete-song-btn ms-1" data-song-id="${song.id}" title="Remove song from library">
              <i class="bi-trash"></i>
            </button>
          ` : ''}
        </div>
      </div>
      ${tabOptionsListHtml}
    </div>
    `;
}

function renderAlbumSongsList(songs, options = {}) {
    const hasCd = (songs || []).some(s => !isDvdOrBlurayMedium(s) && !isVinylOrTapeMedium(s));
    let cleanSongs = (songs || []).filter(s => !isDvdOrBlurayMedium(s) && !(hasCd && isVinylOrTapeMedium(s)));
    cleanSongs = filterInstrumentalBonusDiscs(cleanSongs);
    if (!cleanSongs || cleanSongs.length === 0) {
        return '<div class="text-muted p-4 text-center">No songs in this album.</div>';
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
            <span class="badge badge-theme-secondary py-0 px-2 ms-auto text-muted font-monospace" style="font-size:0.68rem;">${grp.songs.length} ${grp.songs.length === 1 ? 'Track' : 'Tracks'}</span>
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
    container.querySelector('#toggleAlbumEditBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        isAlbumEditMode = !isAlbumEditMode;
        renderLibraryBrowseView(container);
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

    // Set Default Tab for Song
    container.querySelectorAll('.set-default-tab-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const songId = btn.dataset.songId;
            const tabId = btn.dataset.tabId;
            await setDefaultTabOption(songId, tabId);
            showToast('Set default tab', 'success');
            await renderView();
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

    // Play specific tab chip
    container.querySelectorAll('.play-tab-chip-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            if (e.target.closest('.remove-tab-chip-btn') || e.target.closest('.edit-tab-chip-btn') || e.target.closest('.set-default-tab-btn')) return;
            e.stopPropagation();
            const songId = btn.dataset.songId;
            const tabId = btn.dataset.tabId;
            const song = await getSongById(songId);
            const tab = song?.tabOptions?.find(t => t.id === tabId);
            if (song && tab) {
                await loadSongTab(song, tab);
            }
        });
    });

    // Edit tab chip range
    container.querySelectorAll('.edit-tab-chip-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const songId = btn.dataset.songId;
            const tabId = btn.dataset.tabId;
            const song = await getSongById(songId);
            if (!song) return;
            const existingTab = (song.tabOptions || []).find(t => t.id === tabId);
            if (!existingTab) return;
            const albumTabs = (selectedArtist && selectedAlbum)
                ? await getAlbumTabOptions(activeCollectionId, selectedArtist.name, selectedAlbum.title)
                : [];
            let albumPdfTabs = albumTabs.filter(t => (t.name || '').toLowerCase().endsWith('.pdf') || t.isPdf || t.fileType === 'pdf');
            if (albumPdfTabs.length === 0 && existingTab.fileStoreId) {
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
        });
    });

    // Remove tab chip
    container.querySelectorAll('.remove-tab-chip-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const songId = btn.dataset.songId;
            const tabId = btn.dataset.tabId;
            await removeTabOptionFromSong(songId, tabId);
            await renderView();
        });
    });

    // Set Album PDF page range for song
    container.querySelectorAll('.set-album-pdf-pages-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const songId = btn.dataset.songId;
            const tabId = btn.dataset.tabId;
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
        btn.addEventListener('click', (e) => {
            const songId = btn.dataset.songId;
            const providerId = btn.dataset.providerId;

            if (providerId === 'local') {
                openFromProvider('local', { songId });
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

            // Tab downloader
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
        });
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
            file.startPage = (tabOption.startPage !== undefined && tabOption.startPage !== null) ? parseInt(tabOption.startPage, 10) : null;
            file.endPage = (tabOption.endPage !== undefined && tabOption.endPage !== null) ? parseInt(tabOption.endPage, 10) : null;
            file.tabId = tabOption.id;
            file.tabName = tabOption.name || file.name;
            file.fileStoreId = tabOption.fileStoreId;
            file.preferredStringCount = tabOption.preferredStringCount || null;
            file.librarySongId = song.id;
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

// -----------------------------------------------------------------------------
// 2. SEARCH & ADD TO LIBRARY VIEW (Supports Song, Album, Artist, Musician, Custom Music)
// -----------------------------------------------------------------------------
function renderSearchMusicBrainzView(container) {
    container.innerHTML = `
    <div class="library-page-container search-mb-view">
      <div class="search-sticky-header search-view-header">
      <div class="lib-view-switch-row">${libraryViewSwitchHtml()}</div>
      ${libraryPageTitleHtml({
        icon: 'bi-plus-circle',
        title: 'Add music',
        subtitle: 'Find an artist, song or album, or create your own folders.'
      })}
      <div class="hud-pill-group library-type-pills" role="group" id="searchTypePill">
        <button type="button" class="btn btn-sm ${searchType === 'artist' ? 'active' : ''}" data-type="artist">Artist</button>
        <button type="button" class="btn btn-sm ${searchType === 'song' ? 'active' : ''}" data-type="song">Song</button>
        <button type="button" class="btn btn-sm ${searchType === 'album' ? 'active' : ''}" data-type="album">Album</button>
        <button type="button" class="btn btn-sm ${searchType === 'musician' ? 'active' : ''}" data-type="musician">Musician</button>
        <button type="button" class="btn btn-sm ${searchType === 'custom' ? 'active' : ''}" data-type="custom" title="Add custom music, exercises, and custom folder structure">
          Custom Music
        </button>
      </div>

      ${searchType === 'custom' ? '' : `
        <form id="mbSearchForm" class="library-search-box library-search-form mb-3">
          <div class="library-search-bar">
            <i class="bi-search search-icon"></i>
            <input type="text" class="search-input" id="mbSearchInput" placeholder="Search ${searchType} to add music..." value="${escapeHtml(currentSearchQuery)}" autocomplete="off" spellcheck="false" aria-label="Search ${searchType}" autofocus>
          </div>
          <button type="submit" class="btn btn-theme-primary btn-sm px-3 flex-shrink-0" id="mbSearchSubmitBtn">Search</button>
        </form>
      `}
      </div>

      <!-- Search Results / Custom Form Area -->
      <div id="mbSearchResultsContainer" class="search-results-container">
        ${searchType === 'custom' ? renderCustomDocFormHtml() : `
          <p class="library-empty py-4 text-muted mb-0">Type a name to find music to add to your library.</p>
        `}
      </div>
    </div>
    `;


    // Type pills
    container.querySelectorAll('#searchTypePill button').forEach(btn => {
        btn.addEventListener('click', () => {
            if (searchType !== btn.dataset.type) {
                searchType = btn.dataset.type;
                currentSearchResults = [];
                searchSubView = null;
                searchHistory = [];
                renderSearchMusicBrainzView(container);
            }
        });
    });

    if (searchType === 'custom') {
        setupCustomDocForm(container);
        return;
    }

    // Form submit
    const searchForm = container.querySelector('#mbSearchForm');
    const searchInput = container.querySelector('#mbSearchInput');

    searchForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const query = searchInput?.value.trim();
        if (query) {
            await performMusicBrainzSearch(query, searchType);
        }
    });

    // Debounced search on typing
    searchInput?.addEventListener('input', (e) => {
        clearTimeout(searchDebounceTimer);
        const query = e.target.value.trim();
        if (query.length >= 3) {
            searchDebounceTimer = setTimeout(() => {
                performMusicBrainzSearch(query, searchType);
            }, 500);
        }
    });

    gamepadManager.onLibraryViewRendered();
}

function renderCustomDocFormHtml() {
    return `
    <div class="library-card p-4 custom-doc-card">
      <div class="d-flex align-items-center gap-3 mb-3">
        <i class="bi-music-note-list text-info fs-3"></i>
        <div>
          <h6 class="text-white fw-bold mb-0">Add Custom Music</h6>
          <div class="small text-muted">Add non-MusicBrainz exercises, original songs, or custom tabs, and organize into folders.</div>
        </div>
      </div>

      <form id="customDocForm" class="d-flex flex-column gap-3">
        <div>
          <label class="form-label small text-white-50 mb-1 fw-semibold">Title *</label>
          <input type="text" class="form-control form-control-sm" id="customDocTitle" placeholder="e.g. Major Triad Inversions, Sweep Picking #1, Original Song" required autofocus>
        </div>

        <div>
          <label class="form-label small text-white-50 mb-1 fw-semibold">Folder / Path (Optional)</label>
          <input type="text" class="form-control form-control-sm" id="customDocFolder" placeholder="e.g. Exercises, Originals/Acoustic, Technique/Arpeggios (Leave blank for Custom Music root)">
          <div class="small text-muted mt-1" style="font-size:0.75rem;">Use <code class="text-info font-monospace">/</code> for nested subfolders (infinite layers), or leave blank for root Custom Music layer 1.</div>
        </div>

        <div class="form-check form-switch d-flex align-items-center gap-2 ps-0">
          <input class="form-check-input theme-switch ms-0 flex-shrink-0" type="checkbox" role="switch" id="customDocIsBook">
          <label class="form-check-label small text-white" for="customDocIsBook">
            This is a book (PDF)
            <span class="d-block text-muted" style="font-size:0.75rem;">Saves the PDF to the folder as a book, then use Set Book PDF Pages to create songs from page ranges.</span>
          </label>
        </div>

        <div class="row g-3">
          <div class="col-md-6">
            <label class="form-label small text-white-50 mb-1 fw-semibold">Tuning (Optional)</label>
            <select class="form-select form-select-sm" id="customDocTuning">
              <option value="" selected>None / Unspecified (Auto-detect from file)</option>
              <option value="E Standard">E Standard (6-String)</option>
              <option value="Drop D">Drop D (6-String)</option>
              <option value="Eb Standard">Eb Standard (6-String)</option>
              <option value="D Standard">D Standard (6-String)</option>
              <option value="Drop C">Drop C (6-String)</option>
              <option value="7-String Standard">7-String Standard (B E A D G B E)</option>
              <option value="7-String Drop A">7-String Drop A</option>
              <option value="8-String Standard">8-String Standard</option>
              <option value="Bass Standard">Bass Standard (4-String)</option>
              <option value="5-String Bass Standard">5-String Bass Standard</option>
              <option value="6-String Bass Standard">6-String Bass Standard</option>
              <option value="Open D">Open D</option>
              <option value="DADGAD">DADGAD</option>
            </select>
          </div>
          <div class="col-md-6">
            <label class="form-label small text-white-50 mb-1 fw-semibold">String Count (Optional)</label>
            <select class="form-select form-select-sm" id="customDocStrings">
              <option value="" selected>None / Unspecified (Auto-detect from file)</option>
              <option value="6">6 Strings (Guitar)</option>
              <option value="7">7 Strings</option>
              <option value="8">8 Strings</option>
              <option value="4">4 Strings (Bass / Ukulele)</option>
              <option value="5">5 Strings (Bass / Banjo)</option>
            </select>
          </div>
        </div>

        <div>
          <label class="form-label small text-white-50 mb-1 fw-semibold">Attach Tab / Score File (Optional)</label>
          
          <!-- Attached Tab Preview (Hidden when no file is attached) -->
          <div id="customDocAttachedPreview" class="p-3 rounded-3 mb-2 align-items-center justify-content-between gap-2 border border-secondary-subtle" style="display: none; background: rgba(255, 255, 255, 0.04);">
            <div class="d-flex align-items-center gap-2 min-w-0">
              <i class="bi-file-earmark-music text-info fs-5 flex-shrink-0"></i>
              <div class="min-w-0">
                <div class="fw-semibold text-white text-truncate small" id="customDocAttachedName">filename.gp</div>
                <div class="d-flex align-items-center gap-2 mt-1">
                  <span class="badge badge-theme-secondary py-0 px-2" style="font-size:0.65rem;" id="customDocAttachedProvider">Local Device</span>
                  <span class="badge badge-tuning py-0 px-2 font-monospace" style="font-size:0.65rem; display: none;" id="customDocAttachedTuning">E Standard</span>
                </div>
              </div>
            </div>
            <button type="button" class="btn btn-sm btn-theme-icon text-danger p-1" id="customDocRemoveFileBtn" title="Remove attached file">
              <i class="bi-x-lg"></i>
            </button>
          </div>

          <!-- Provider Attachment Buttons & Dropzone -->
          <div id="customDocAttachOptions" class="d-flex flex-column gap-2">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <button type="button" class="btn btn-sm btn-theme-outline d-inline-flex align-items-center gap-2" id="customDocPickLocalBtn">
                <i class="bi-folder2-open text-primary"></i> Local Device
              </button>
              <!-- @googleDrive:begin -->
              <button type="button" class="btn btn-sm btn-theme-outline d-inline-flex align-items-center gap-2" id="customDocPickDriveBtn">
                <i class="icon-gdrive"></i> Google Drive
              </button>
              <!-- @googleDrive:end -->
              ${window.__TAURI__ ? `
                <button type="button" class="btn btn-sm btn-theme-outline d-inline-flex align-items-center gap-2" id="customDocPickDownloaderBtn">
                  <i class="bi-search text-info"></i> Web Search
                </button>
              ` : ''}
            </div>
            <div id="customDocDropzone" class="p-3 text-center border border-secondary-subtle border-dashed rounded-3 text-muted small" style="cursor: pointer; background: rgba(255, 255, 255, 0.02);">
              <i class="bi-cloud-upload d-block fs-4 text-white-50 mb-1"></i>
              <span>Or click or drag &amp; drop a tab file here (.gp, .gp5, .pdf, .txt)</span>
            </div>
          </div>
        </div>

        <div class="d-flex justify-content-end gap-2 pt-2 border-top border-secondary-subtle">
          <button type="button" class="btn btn-sm btn-theme-outline px-3" id="customDocCancelBtn">Cancel</button>
          <button type="submit" class="btn btn-sm btn-theme-primary px-4" id="customDocSaveBtn">
            <i class="bi-check-lg me-1"></i> Save to Library
          </button>
        </div>
      </form>
    </div>
    `;
}

function setupCustomDocForm(container) {
    const form = container.querySelector('#customDocForm');
    if (!form) return;

    let attachedTab = null; // { file, providerId, fileStoreId, name, meta }

    const updateAttachedUi = () => {
        const preview = container.querySelector('#customDocAttachedPreview');
        const optionsArea = container.querySelector('#customDocAttachOptions');
        const nameEl = container.querySelector('#customDocAttachedName');
        const providerEl = container.querySelector('#customDocAttachedProvider');
        const tuningEl = container.querySelector('#customDocAttachedTuning');

        if (attachedTab) {
            if (preview) preview.style.display = 'flex';
            if (optionsArea) optionsArea.style.display = 'none';
            if (nameEl) nameEl.textContent = attachedTab.name;
            if (providerEl) {
                let pName = 'Local Device';
                if (attachedTab.providerId === 'google-drive') pName = 'Google Drive';
                else if (attachedTab.providerId.startsWith('tab-downloader')) pName = 'Web Search';
                providerEl.textContent = pName;
            }
            if (tuningEl) {
                if (attachedTab.meta?.primaryTuning) {
                    tuningEl.textContent = attachedTab.meta.primaryTuning;
                    tuningEl.style.display = 'inline-flex';
                } else {
                    tuningEl.style.display = 'none';
                }
            }
        } else {
            if (preview) preview.style.display = 'none';
            if (optionsArea) optionsArea.style.display = 'flex';
        }
    };

    const handleFileAttached = (result) => {
        attachedTab = result;
        updateAttachedUi();

        // Auto-fill title if empty
        const titleInput = form.querySelector('#customDocTitle');
        if (titleInput && !titleInput.value.trim() && result.name) {
            const cleanName = result.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
            titleInput.value = cleanName;
        }

        // Auto-fill tuning if blank and detected
        const tuningSelect = form.querySelector('#customDocTuning');
        if (tuningSelect && !tuningSelect.value && result.meta?.primaryTuning) {
            const exists = Array.from(tuningSelect.options).some(o => o.value === result.meta.primaryTuning);
            if (exists) {
                tuningSelect.value = result.meta.primaryTuning;
            }
        }

        // Auto-fill strings if blank and detected
        const stringsSelect = form.querySelector('#customDocStrings');
        if (stringsSelect && !stringsSelect.value && result.meta?.stringCount) {
            stringsSelect.value = String(result.meta.stringCount);
        }
    };

    container.querySelector('#customDocCancelBtn')?.addEventListener('click', () => switchView('library'));

    // File dropped on the library: attach it and prefill the target folder
    if (pendingCustomDrop) {
        const { file, folderPath } = pendingCustomDrop;
        pendingCustomDrop = null;
        const folderInput = form.querySelector('#customDocFolder');
        if (folderInput && folderPath) folderInput.value = folderPath;
        (async () => {
            try {
                const meta = await detectFileMetadata(file, file.name);
                const stored = await saveStoredFile(file, 'local');
                handleFileAttached({ file, providerId: 'local', fileStoreId: stored.id, name: file.name, meta });
            } catch (err) {
                console.warn('Could not attach dropped file:', err);
                showToast('Error attaching dropped file', 'error');
            }
        })();
    }

    container.querySelector('#customDocRemoveFileBtn')?.addEventListener('click', () => {
        attachedTab = null;
        updateAttachedUi();
    });

    // Pick Local
    container.querySelector('#customDocPickLocalBtn')?.addEventListener('click', () => {
        openFromProvider('local', { onFileSelected: handleFileAttached });
    });

    // @googleDrive:begin
    // Pick Google Drive
    container.querySelector('#customDocPickDriveBtn')?.addEventListener('click', () => {
        openFromProvider('google-drive', { onFileSelected: handleFileAttached });
    });

    // @googleDrive:end
    // Pick Tab Downloader
    container.querySelector('#customDocPickDownloaderBtn')?.addEventListener('click', () => {
        const query = form.querySelector('#customDocTitle')?.value?.trim() || '';
        openFromProvider('tab-downloader', { query, onFileSelected: handleFileAttached });
    });

    // Dropzone click / drag-and-drop
    const dropzone = container.querySelector('#customDocDropzone');
    if (dropzone) {
        dropzone.addEventListener('click', () => {
            openFromProvider('local', { onFileSelected: handleFileAttached });
        });
        ['dragenter', 'dragover'].forEach(name => {
            dropzone.addEventListener(name, (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!canAcceptTabDrop(e)) {
                    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
                    dropzone.classList.remove('border-info');
                    return;
                }
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                dropzone.classList.add('border-info');
            });
        });
        ['dragleave', 'drop'].forEach(name => {
            dropzone.addEventListener(name, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.remove('border-info');
            });
        });
        dropzone.addEventListener('drop', async (e) => {
            const file = e.dataTransfer?.files?.[0];
            if (file) {
                if (!(await isSupportedTabFile(file))) {
                    showToast(`"${file.name}" is not a supported tab file (.gp, .gp3, .gp4, .gp5, .gpx, .pdf, .txt)`, 'warning');
                    return;
                }
                const meta = await detectFileMetadata(file, file.name);
                const stored = await saveStoredFile(file, 'local');
                handleFileAttached({ file, providerId: 'local', fileStoreId: stored.id, name: file.name, meta });
            }
        });
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = form.querySelector('#customDocTitle')?.value?.trim();
        if (!title) return;

        let folderPath = form.querySelector('#customDocFolder')?.value?.trim() || '';
        folderPath = folderPath.replace(/^\/+|\/+$/g, '');

        const tuning = form.querySelector('#customDocTuning')?.value || null;
        const stringsVal = form.querySelector('#customDocStrings')?.value;
        const stringCount = stringsVal ? parseInt(stringsVal, 10) : null;

        if (form.querySelector('#customDocIsBook')?.checked) {
            if (!attachedTab || !/\.pdf$/i.test(attachedTab.name)) {
                showToast('Attach a PDF file to save it as a book.', 'warning');
                return;
            }
            await addTabOptionToAlbum(activeCollectionId, 'Custom Music', folderPath || 'Custom Music', {
                name: title,
                providerId: attachedTab.providerId,
                relativePath: attachedTab.name,
                fileStoreId: attachedTab.fileStoreId,
                tuning: tuning || attachedTab.meta?.primaryTuning || null,
                tunings: tuning ? [tuning] : (attachedTab.meta?.tunings || []),
                stringCount: stringCount || attachedTab.meta?.stringCount || null,
                fileType: 'pdf',
                isCustom: true
            });
            showToast(`Added book "${title}" to Custom Music${folderPath ? ' / ' + folderPath : ''}`, 'success');
            window.dispatchEvent(new CustomEvent('libraryDataChanged'));
            await switchView('library');
            return;
        }

        const songId = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const tabOptions = [];

        if (attachedTab) {
            tabOptions.push({
                id: `tab_${Date.now()}`,
                name: attachedTab.name,
                providerId: attachedTab.providerId,
                relativePath: attachedTab.name,
                fileStoreId: attachedTab.fileStoreId,
                tuning: tuning || attachedTab.meta?.primaryTuning || null,
                tunings: tuning ? [tuning] : (attachedTab.meta?.tunings || []),
                stringCount: stringCount || attachedTab.meta?.stringCount || null,
                fileType: attachedTab.name.split('.').pop().toLowerCase(),
                isDefault: true
            });
        }

        const song = {
            id: songId,
            collectionId: activeCollectionId,
            title,
            artist: 'Custom Music',
            album: folderPath,
            folderPath,
            isCustom: true,
            tunings: tuning ? [tuning] : (tabOptions[0]?.tunings || []),
            stringCount: stringCount || tabOptions[0]?.stringCount || null,
            tabOptions,
            defaultTabId: tabOptions[0]?.id || null,
            addedAt: Date.now()
        };

        await saveSongToLibrary(song, activeCollectionId);
        showToast(`Added "${title}" to Custom Music${folderPath ? ' / ' + folderPath : ''}`, 'success');
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
        await switchView('library');
    });
}

async function performMusicBrainzSearch(query, type) {
    currentSearchQuery = query;
    const resultsContainer = document.getElementById('mbSearchResultsContainer');
    if (!resultsContainer) return;

    resultsContainer.innerHTML = `
    <div class="text-center py-5 text-muted">
      <div class="spinner-border spinner-border-sm text-info mb-2" role="status"></div>
      <div>Searching for "${escapeHtml(query)}"...</div>
    </div>
    `;

    try {
        const rawResults = await searchMusicBrainz(query, type);

        // Fetch existing library songs to check actual album / song / artist presence
        const songs = await getSongsByCollection(activeCollectionId);
        const existingArtists = new Set(songs.map(s => (s.artist || '').toLowerCase().trim()));
        const existingAlbumKeys = new Set(songs.map(s => {
            if (s.albumMbid) return `mbid:${s.albumMbid}`;
            return `${(s.artist || '').toLowerCase().trim()}:::${(s.album || '').toLowerCase().trim()}`;
        }));
        const existingSongKeys = new Set(songs.map(s => {
            if (s.recordingMbid) return `rec:${s.recordingMbid}`;
            return `${(s.artist || '').toLowerCase().trim()}:::${(s.title || '').toLowerCase().trim()}`;
        }));

        let sortedResults = rawResults;
        if (type === 'song' || type === 'album') {
            const inLib = [];
            const notInLib = [];

            for (const item of rawResults) {
                const artistName = (item.artist || '').toLowerCase().trim();
                const artistInLib = existingArtists.has(artistName);

                let isItemInLib = false;
                if (type === 'album') {
                    isItemInLib = (item.id && existingAlbumKeys.has(`mbid:${item.id}`)) ||
                                  existingAlbumKeys.has(`${artistName}:::${(item.title || '').toLowerCase().trim()}`);
                } else if (type === 'song') {
                    isItemInLib = (item.recordingMbid && existingSongKeys.has(`rec:${item.recordingMbid}`)) ||
                                  (item.id && existingSongKeys.has(`rec:${item.id}`)) ||
                                  existingSongKeys.has(`${artistName}:::${(item.title || '').toLowerCase().trim()}`);
                }

                const enriched = { ...item, inLibrary: isItemInLib, artistInLibrary: artistInLib };
                // Prioritize results from artists in your library or items already in library
                if (isItemInLib || artistInLib) {
                    inLib.push(enriched);
                } else {
                    notInLib.push(enriched);
                }
            }
            sortedResults = [...inLib, ...notInLib];
        } else if (type === 'artist' || type === 'musician') {
            sortedResults = rawResults.map(a => ({
                ...a,
                inLibrary: existingArtists.has((a.name || '').toLowerCase().trim())
            }));
            sortedResults.sort((a, b) => (b.inLibrary ? 1 : 0) - (a.inLibrary ? 1 : 0));
        }

        currentSearchResults = sortedResults;
        renderSearchResults(sortedResults, type, resultsContainer);
    } catch (err) {
        resultsContainer.innerHTML = `
        <div class="text-center py-4 text-danger-emphasis">
          <i class="bi-exclamation-triangle fs-3 mb-2 d-block"></i>
          <div>Search failed: ${escapeHtml(err.message)}</div>
        </div>
        `;
    }
}

function renderSearchResults(results, type, container) {
    // Clicking anywhere on a result row/card triggers its primary action button
    container.onclick = (e) => {
        if (e.target.closest('button, a, input')) return;
        const row = e.target.closest('[data-row-action]');
        if (!row || !container.contains(row)) return;
        const btn = row.querySelector(row.dataset.rowAction);
        if (btn && !btn.disabled && !btn.classList.contains('disabled')) btn.click();
    };
    const searchHeader = document.querySelector('.search-sticky-header');
    if (searchHeader) searchHeader.style.display = '';

    if (results.length === 0) {
        container.innerHTML = `
        <div class="text-center py-5 text-muted">
          <i class="bi-emoji-frown fs-2 mb-2 d-block"></i>
          <div>No results found. Try a different search term.</div>
        </div>
        `;
        return;
    }

    if (type === 'artist' || type === 'musician') {
        container.innerHTML = `
        <div class="d-flex flex-column gap-2">
          ${results.map(a => `
            <div class="library-row-card d-flex align-items-center justify-content-between gap-3" role="button" tabindex="0" data-row-action=".explore-artist-btn" style="cursor:pointer;">
              <div class="min-w-0 flex-grow-1">
                <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</h6>
                <div class="small text-muted text-truncate">${a.type || 'Artist'} • ${a.country || 'International'} ${a.lifeSpan ? `• ${a.lifeSpan}` : ''}</div>
                ${a.disambiguation ? `<div class="small text-white-50 text-truncate" style="font-size:0.75rem;" title="${escapeHtml(a.disambiguation)}">${escapeHtml(a.disambiguation)}</div>` : ''}
              </div>
              <div class="d-flex align-items-center gap-2 flex-shrink-0 ms-2">
                <!-- 'Add Artist' button hidden per requirements -->
                <button class="btn btn-sm btn-theme-outline explore-artist-btn" data-artist-id="${a.id}" data-artist-name="${escapeHtml(a.name)}" data-is-musician="${type === 'musician'}">
                  <i class="bi-${type === 'musician' ? 'people' : 'disc'} me-1"></i> ${type === 'musician' ? 'View Bands' : 'Browse Albums'}
                </button>
              </div>
            </div>
          `).join('')}
        </div>
        `;

        container.querySelectorAll('.explore-artist-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const artistId = btn.dataset.artistId;
                const artistName = btn.dataset.artistName;
                const isMusician = btn.dataset.isMusician === 'true';

                if (isMusician) {
                    await exploreMusicianBands(artistId, artistName, container);
                } else {
                    await exploreArtistAlbums(artistId, artistName, container);
                }
            });
        });
    } else if (type === 'album') {
        container.innerHTML = `
        <div class="library-albums-grid">
          ${results.map(rg => {
            const cover = rg.coverUrl || getPlaceholderCoverSvg(rg.title);
            return `
            <div class="library-card album-card p-3" role="button" tabindex="0" data-row-action=".view-album-tracks-btn">
              <div class="album-card-body d-flex min-w-0">
                <div class="album-cover-container">
                  <img loading="lazy" decoding="async" src="${cover}" class="album-cover-img" alt="${escapeHtml(rg.title)}" draggable="false" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(rg.title)}'">
                  ${rg.year ? `<span class="badge badge-theme-year position-absolute bottom-0 end-0 m-2 album-year-badge">${rg.year}</span>` : ''}
                </div>
                <div class="album-card-content min-w-0 flex-grow-1">
                  <h6 class="mb-1 fw-bold text-white text-truncate" title="${escapeHtml(rg.title)}">${escapeHtml(rg.title)}</h6>
                  <div class="small text-muted text-truncate" title="${escapeHtml(rg.artist)}">
                    ${rg.inLibrary ? `<span class="badge badge-theme-primary me-1" style="font-size:0.62rem;"><i class="bi-collection-play me-1"></i>In Library</span>` : ''}
                    ${escapeHtml(rg.artist)} ${rg.year ? `• ${rg.year}` : ''}
                  </div>
                </div>
              </div>
              <div class="album-card-actions d-flex gap-2 mt-2">
                <button class="btn btn-sm ${rg.inLibrary ? 'btn-theme-success disabled' : 'btn-theme-primary'} flex-grow-1 add-album-btn" data-rg-id="${rg.id}" data-rg-title="${escapeHtml(rg.title)}">
                  <i class="${rg.inLibrary ? 'bi-check-lg' : 'bi-plus-lg'} me-1"></i> ${rg.inLibrary ? 'In Library' : 'Add Album'}
                </button>
                <button class="btn btn-sm btn-theme-outline view-album-tracks-btn px-2 flex-shrink-0" data-rg-id="${rg.id}" title="View Tracks">
                  <i class="bi-music-note-list"></i>
                </button>
              </div>
            </div>
            `;
          }).join('')}
        </div>
        `;

        container.querySelectorAll('.add-album-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await handleAddAlbum(btn.dataset.rgId, btn);
            });
        });

        container.querySelectorAll('.view-album-tracks-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const rgId = btn.dataset.rgId;
                await exploreAlbumTracklist(rgId, container);
            });
        });
    } else if (type === 'song') {
        container.innerHTML = `
        <div class="d-flex flex-column gap-2">
          ${results.map(song => `
            <div class="library-row-card d-flex align-items-center justify-content-between gap-3" role="button" tabindex="0" data-row-action=".add-single-song-btn" style="cursor:pointer;">
              <div class="min-w-0 flex-grow-1">
                <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</h6>
                <div class="small text-muted text-truncate" title="${escapeHtml(song.artist)} • ${escapeHtml(song.album || 'Single')} ${song.year ? `• ${song.year}` : ''}">
                  ${song.inLibrary ? `<span class="badge badge-theme-primary me-1" style="font-size:0.62rem;"><i class="bi-collection-play me-1"></i>In Library</span>` : ''}
                  ${escapeHtml(song.artist)} • ${escapeHtml(song.album || 'Single')} ${song.year ? `• ${song.year}` : ''}
                </div>
              </div>
              <button class="btn btn-sm ${song.inLibrary ? 'btn-theme-success disabled' : 'btn-theme-primary'} flex-shrink-0 add-single-song-btn" data-song='${escapeHtml(JSON.stringify(song))}'>
                <i class="${song.inLibrary ? 'bi-check-lg' : 'bi-plus-lg'} me-1"></i> ${song.inLibrary ? 'In Library' : 'Add Song'}
              </button>
            </div>
          `).join('')}
        </div>
        `;

        container.querySelectorAll('.add-single-song-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const songData = JSON.parse(btn.dataset.song);
                await saveSongToLibrary(songData, activeCollectionId);
                btn.className = 'btn btn-sm btn-theme-success flex-shrink-0 disabled';
                btn.innerHTML = '<i class="bi-check-lg me-1"></i> In Library';
            });
        });
    }

    gamepadManager.onLibraryViewRendered();
}

async function handleAddAlbum(releaseGroupMbid, btn) {
    if (!btn || btn.disabled) return;
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status"></span> Adding tracks...';

    try {
        const albumData = await getAlbumTracks(releaseGroupMbid);
        if (!albumData || !albumData.tracks || albumData.tracks.length === 0) {
            btn.className = 'btn btn-sm btn-theme-outline flex-grow-1';
            btn.innerHTML = '<i class="bi-exclamation-circle me-1"></i> No tracks found';
            setTimeout(() => { btn.innerHTML = origHtml; btn.disabled = false; }, 3000);
            return;
        }

        const added = await addAlbumToLibrary(albumData, albumData.tracks, activeCollectionId);
        btn.className = 'btn btn-sm btn-theme-success flex-grow-1 disabled';
        btn.innerHTML = `<i class="bi-check-lg me-1"></i> In Library (${added.length} tracks)`;
    } catch (err) {
        console.error('Failed to add album:', err);
        btn.className = 'btn btn-sm btn-theme-danger flex-grow-1';
        btn.innerHTML = '<i class="bi-arrow-clockwise me-1"></i> Retry Add';
        btn.disabled = false;
    }
}

async function exploreArtistAlbums(artistMbid, artistName, container, pushHistory = true) {
    const searchHeader = document.querySelector('.search-sticky-header');
    if (searchHeader) searchHeader.style.display = 'none';

    if (pushHistory) {
        searchHistory.push({ type: 'results' });
    }
    searchSubView = { type: 'albums', artistMbid, artistName };
    updateBackBtnVisibility();

    const targetContainer = (activeView === 'search' ? (document.getElementById('mbSearchResultsContainer') || container) : container);
    const thisFetchToken = ++currentExploreArtistToken;

    targetContainer.innerHTML = `
    <div class="library-sticky-breadcrumbs mb-3 d-flex align-items-center justify-content-between pb-2 border-bottom border-secondary-subtle">
      <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2 flex-shrink-0" id="cancelExploreArtistBtn">
        <i class="bi-arrow-left"></i> <span>Back</span>
      </button>
    </div>
    <div class="text-center py-5 text-muted">
      <div class="spinner-border spinner-border-sm text-info mb-2" role="status"></div>
      <div class="mb-3">Loading studio albums for ${escapeHtml(artistName)}...</div>
      <button class="btn btn-sm btn-theme-outline px-3" id="cancelExploreArtistActionBtn">
        <i class="bi-x-lg me-1"></i> Cancel
      </button>
    </div>
    `;

    const handleCancelFetch = () => {
        currentExploreArtistToken++;
        handleBack();
    };
    targetContainer.querySelector('#cancelExploreArtistBtn')?.addEventListener('click', handleCancelFetch);
    targetContainer.querySelector('#cancelExploreArtistActionBtn')?.addEventListener('click', handleCancelFetch);

    try {
        const albums = await getArtistAlbums(artistMbid);
        if (thisFetchToken !== currentExploreArtistToken) return;

        if (albums.length === 0) {
            targetContainer.innerHTML = `
            <div class="mb-3">
              <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2" id="backToSearchResultsBtn">
                <i class="bi-arrow-left"></i> <span>Back to Search</span>
              </button>
            </div>
            <div class="text-center py-4 text-muted">No studio albums found for ${escapeHtml(artistName)}.</div>`;
            targetContainer.querySelector('#backToSearchResultsBtn')?.addEventListener('click', handleBack);
            return;
        }

        const existingSongs = await getSongsByCollection(activeCollectionId);
        const existingAlbumKeys = new Set(existingSongs.map(s => {
            if (s.albumMbid) return `mbid:${s.albumMbid}`;
            return `${(s.artist || '').toLowerCase().trim()}:::${(s.album || '').toLowerCase().trim()}`;
        }));

        targetContainer.innerHTML = `
        <div class="library-sticky-breadcrumbs mb-3 d-flex align-items-center justify-content-between flex-wrap gap-2 pb-2 border-bottom border-secondary-subtle">
          <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2 flex-shrink-0" id="backToSearchResultsBtn">
            <i class="bi-arrow-left"></i> <span>Back to Search</span>
          </button>
          <div class="d-flex align-items-center gap-2 min-w-0">
            <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(artistName)}">${escapeHtml(artistName)} (${albums.length} Studio Albums)</h6>
          </div>
        </div>
        <div class="library-albums-grid">
          ${albums.map(a => {
            const isAlbumInLib = (a.id && existingAlbumKeys.has(`mbid:${a.id}`)) ||
                                 existingAlbumKeys.has(`${artistName.toLowerCase().trim()}:::${(a.title || '').toLowerCase().trim()}`);
            return `
            <div class="library-card album-card p-3" role="button" tabindex="0" data-row-action=".view-album-tracks-btn">
              <div class="album-card-body d-flex min-w-0">
                <div class="album-cover-container">
                  <img loading="lazy" decoding="async" src="${a.coverUrl || getPlaceholderCoverSvg(a.title)}" class="album-cover-img" alt="${escapeHtml(a.title)}" draggable="false" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(a.title)}'">
                  ${a.year ? `<span class="badge badge-theme-year position-absolute bottom-0 end-0 m-2 album-year-badge">${a.year}</span>` : ''}
                </div>
                <div class="album-card-content min-w-0 flex-grow-1">
                  <h6 class="mb-1 fw-bold text-white text-truncate" title="${escapeHtml(a.title)}">${escapeHtml(a.title)}</h6>
                  <div class="small text-muted text-truncate">
                    ${isAlbumInLib ? `<span class="badge badge-theme-primary me-1" style="font-size:0.62rem;"><i class="bi-collection-play me-1"></i>In Library</span>` : ''}
                    ${a.year || 'Album'}
                  </div>
                </div>
              </div>
              <div class="album-card-actions d-flex gap-2 mt-2">
                <button class="btn btn-sm ${isAlbumInLib ? 'btn-theme-success disabled' : 'btn-theme-primary'} flex-grow-1 add-album-btn" data-rg-id="${a.id}" data-rg-title="${escapeHtml(a.title)}">
                  <i class="${isAlbumInLib ? 'bi-check-lg' : 'bi-plus-lg'} me-1"></i> ${isAlbumInLib ? 'In Library' : 'Add Album'}
                </button>
                <button class="btn btn-sm btn-theme-outline view-album-tracks-btn px-2 flex-shrink-0" data-rg-id="${a.id}" title="View Tracks">
                  <i class="bi-music-note-list"></i>
                </button>
              </div>
            </div>
            `;
          }).join('')}
        </div>
        `;

        targetContainer.querySelector('#backToSearchResultsBtn')?.addEventListener('click', handleBack);

        targetContainer.querySelectorAll('.add-album-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await handleAddAlbum(btn.dataset.rgId, btn);
            });
        });

        targetContainer.querySelectorAll('.view-album-tracks-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await exploreAlbumTracklist(btn.dataset.rgId, targetContainer);
            });
        });

        targetContainer.querySelectorAll('.album-card[data-row-action]').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('button, a, input')) return;
                card.querySelector(card.dataset.rowAction)?.click();
            });
        });

        gamepadManager.onLibraryViewRendered();
    } catch (err) {
        if (thisFetchToken !== currentExploreArtistToken) return;
        targetContainer.innerHTML = `
        <div class="mb-3">
          <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2" id="backToSearchResultsBtn">
            <i class="bi-arrow-left"></i> <span>Back</span>
          </button>
        </div>
        <div class="text-danger py-4 text-center">Failed to load albums: ${escapeHtml(err.message)}</div>`;
        targetContainer.querySelector('#backToSearchResultsBtn')?.addEventListener('click', handleBack);
    }
}

async function exploreMusicianBands(musicianMbid, musicianName, container, pushHistory = true) {
    const searchHeader = document.querySelector('.search-sticky-header');
    if (searchHeader) searchHeader.style.display = 'none';

    if (pushHistory) {
        searchHistory.push({ type: 'results' });
    }
    searchSubView = { type: 'bands', musicianMbid, musicianName };

    const targetContainer = (activeView === 'search' ? (document.getElementById('mbSearchResultsContainer') || container) : container);
    const thisFetchToken = ++currentExploreMusicianToken;

    targetContainer.innerHTML = `
    <div class="library-sticky-breadcrumbs mb-3 d-flex align-items-center justify-content-between pb-2 border-bottom border-secondary-subtle">
      <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2 flex-shrink-0" id="cancelExploreMusicianBtn">
        <i class="bi-arrow-left"></i> <span>Back</span>
      </button>
    </div>
    <div class="text-center py-5 text-muted">
      <div class="spinner-border spinner-border-sm text-info mb-2" role="status"></div>
      <div class="mb-3">Finding bands &amp; projects for ${escapeHtml(musicianName)}...</div>
      <button class="btn btn-sm btn-theme-outline px-3" id="cancelExploreMusicianActionBtn">
        <i class="bi-x-lg me-1"></i> Cancel
      </button>
    </div>
    `;

    const handleCancelFetch = () => {
        currentExploreMusicianToken++;
        handleBack();
    };
    targetContainer.querySelector('#cancelExploreMusicianBtn')?.addEventListener('click', handleCancelFetch);
    targetContainer.querySelector('#cancelExploreMusicianActionBtn')?.addEventListener('click', handleCancelFetch);

    try {
        const bands = await getMusicianRelations(musicianMbid);
        if (thisFetchToken !== currentExploreMusicianToken) return;

        if (bands.length === 0) {
            targetContainer.innerHTML = `
            <div class="mb-3">
              <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2" id="backToSearchResultsBtn">
                <i class="bi-arrow-left"></i> <span>Back to Search</span>
              </button>
            </div>
            <div class="text-center py-4 text-muted">No associated bands found for ${escapeHtml(musicianName)}.</div>`;
            targetContainer.querySelector('#backToSearchResultsBtn')?.addEventListener('click', handleBack);
            return;
        }

        targetContainer.innerHTML = `
        <div class="library-sticky-breadcrumbs mb-3 d-flex align-items-center justify-content-between pb-2 border-bottom border-secondary-subtle">
          <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2 flex-shrink-0" id="backToSearchResultsBtn">
            <i class="bi-arrow-left"></i> <span>Back</span>
          </button>
          <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(musicianName)}">${escapeHtml(musicianName)} — Associated Bands</h6>
        </div>
        <div class="d-flex flex-column gap-2">
          ${bands.map(b => `
            <div class="library-row-card d-flex align-items-center justify-content-between gap-3" role="button" tabindex="0" data-row-action=".explore-band-albums-btn" style="cursor:pointer;">
              <div class="min-w-0 flex-grow-1">
                <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(b.name)}">${escapeHtml(b.name)}</h6>
                <div class="small text-muted text-truncate">${b.role ? escapeHtml(b.role) : 'Band Member'}</div>
              </div>
              <button class="btn btn-sm btn-theme-outline flex-shrink-0 ms-2 explore-band-albums-btn" data-band-id="${b.id}" data-band-name="${escapeHtml(b.name)}">
                <i class="bi-disc me-1"></i> View Albums
              </button>
            </div>
          `).join('')}
        </div>
        `;

        targetContainer.querySelector('#backToSearchResultsBtn')?.addEventListener('click', handleBack);

        targetContainer.querySelectorAll('.explore-band-albums-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await exploreArtistAlbums(btn.dataset.bandId, btn.dataset.bandName, targetContainer);
            });
        });

        targetContainer.querySelectorAll('.library-row-card[data-row-action]').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('button, a, input')) return;
                row.querySelector(row.dataset.rowAction)?.click();
            });
        });

        gamepadManager.onLibraryViewRendered();
    } catch (err) {
        if (thisFetchToken !== currentExploreMusicianToken) return;
        targetContainer.innerHTML = `
        <div class="mb-3">
          <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2" id="backToSearchResultsBtn">
            <i class="bi-arrow-left"></i> <span>Back</span>
          </button>
        </div>
        <div class="text-danger py-4 text-center">Failed to load bands: ${escapeHtml(err.message)}</div>`;
        targetContainer.querySelector('#backToSearchResultsBtn')?.addEventListener('click', handleBack);
    }
}

async function exploreAlbumTracklist(releaseGroupMbid, container, pushHistory = true) {
    const searchHeader = document.querySelector('.search-sticky-header');
    if (searchHeader) searchHeader.style.display = 'none';

    if (pushHistory) {
        searchHistory.push(searchSubView ? { ...searchSubView } : { type: 'results' });
    }
    const fromView = searchSubView?.fromView || (activeView === 'library' ? 'library' : 'search');
    searchSubView = { type: 'tracks', releaseGroupMbid, fromView };

    const targetContainer = (activeView === 'search' ? (document.getElementById('mbSearchResultsContainer') || container) : container);
    const thisFetchToken = ++currentExploreTracklistToken;

    targetContainer.innerHTML = `
    <div class="album-tracks-view">
      <div class="library-sticky-breadcrumbs d-flex align-items-center justify-content-between mb-3 pb-2 border-bottom border-secondary-subtle">
        <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2 flex-shrink-0" id="cancelFetchTracklistBtn">
          <i class="bi-arrow-left"></i> <span>Back</span>
        </button>
      </div>
      <div class="text-center py-5 text-muted">
        <div class="spinner-border spinner-border-sm text-info mb-2" role="status"></div>
        <div class="mb-3">Fetching album tracklist...</div>
        <button class="btn btn-sm btn-theme-outline px-3" id="cancelFetchTracklistActionBtn">
          <i class="bi-x-lg me-1"></i> Cancel
        </button>
      </div>
    </div>
    `;

    const handleCancelFetch = () => {
        currentExploreTracklistToken++;
        handleBack();
    };
    targetContainer.querySelector('#cancelFetchTracklistBtn')?.addEventListener('click', handleCancelFetch);
    targetContainer.querySelector('#cancelFetchTracklistActionBtn')?.addEventListener('click', handleCancelFetch);

    try {
        const albumData = await getAlbumTracks(releaseGroupMbid);
        if (thisFetchToken !== currentExploreTracklistToken) return;

        if (!albumData || !albumData.tracks || albumData.tracks.length === 0) {
            targetContainer.innerHTML = `
            <div class="mb-3">
              <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2" id="backToAlbumsListBtn">
                <i class="bi-arrow-left"></i> <span>Back</span>
              </button>
            </div>
            <div class="text-center py-4 text-muted">No tracklist available for this album.</div>`;
            targetContainer.querySelector('#backToAlbumsListBtn')?.addEventListener('click', handleBack);
            return;
        }

        const existingSongs = await getSongsByCollection(activeCollectionId);
        const existingSongKeys = new Set(existingSongs.map(s => {
            if (s.recordingMbid) return `rec:${s.recordingMbid}`;
            return `${(s.artist || '').toLowerCase().trim()}:::${(s.title || '').toLowerCase().trim()}`;
        }));

        const hasCd = (albumData.tracks || []).some(t => !isDvdOrBlurayMedium(t) && !isVinylOrTapeMedium(t));
        let cleanTracks = (albumData.tracks || []).filter(t => !isDvdOrBlurayMedium(t) && !(hasCd && isVinylOrTapeMedium(t)));
        cleanTracks = filterInstrumentalBonusDiscs(cleanTracks);

        const missingTracks = cleanTracks.filter(t => {
            const inLib = (t.recordingMbid && existingSongKeys.has(`rec:${t.recordingMbid}`)) ||
                          (t.id && existingSongKeys.has(`rec:${t.id}`)) ||
                          existingSongKeys.has(`${(albumData.artist || '').toLowerCase().trim()}:::${(t.title || '').toLowerCase().trim()}`);
            return !inLib;
        });

        const allInLib = cleanTracks.length > 0 && missingTracks.length === 0;
        const partialInLib = missingTracks.length > 0 && missingTracks.length < cleanTracks.length;

        const cover = albumData.coverUrl || getPlaceholderCoverSvg(albumData.title);

        let addAllBtnHtml = '';
        if (allInLib) {
            addAllBtnHtml = `
            <button class="btn btn-sm btn-theme-success px-3 flex-shrink-0 disabled" id="addAllAlbumTracksBtn">
              <i class="bi-check-lg me-1"></i> All Tracks in Library
            </button>
            `;
        } else if (partialInLib) {
            addAllBtnHtml = `
            <button class="btn btn-sm btn-theme-primary px-3 flex-shrink-0" id="addAllAlbumTracksBtn">
              <i class="bi-plus-circle me-1"></i> Add Missing Tracks (${missingTracks.length})
            </button>
            `;
        } else {
            addAllBtnHtml = `
            <button class="btn btn-sm btn-theme-primary px-3 flex-shrink-0" id="addAllAlbumTracksBtn">
              <i class="bi-plus-circle me-1"></i> Add Full Album to Library
            </button>
            `;
        }

        targetContainer.innerHTML = `
        <div class="album-tracks-view">
          <div class="library-sticky-breadcrumbs d-flex align-items-center justify-content-between mb-3 pb-2 border-bottom border-secondary-subtle">
            <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2 flex-shrink-0" id="backToAlbumsListBtn">
              <i class="bi-arrow-left"></i> <span>Back</span>
            </button>
            <div class="d-flex align-items-center gap-2 flex-shrink-0">
              <button class="btn btn-sm btn-theme-outline px-3 flex-shrink-0 ${cleanTracks.length > missingTracks.length ? '' : 'd-none'}" id="viewAlbumInLibraryBtn">
                <i class="bi-collection-play me-1"></i> View in Library
              </button>
              ${addAllBtnHtml}
            </div>
          </div>

          <div class="library-album-banner d-flex align-items-center gap-3 mb-3">
            <img loading="lazy" decoding="async" src="${cover}" class="album-cover-banner flex-shrink-0" alt="${escapeHtml(albumData.title)}" draggable="false" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(albumData.title)}'">
            <div class="min-w-0 flex-grow-1">
              <span class="badge badge-theme-success mb-1" style="font-size:0.68rem;">Release (${albumData.country || 'International'})</span>
              <h5 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(albumData.title)}">${escapeHtml(albumData.title)}</h5>
              <div class="small text-muted text-truncate" title="${escapeHtml(albumData.artist)}">${escapeHtml(albumData.artist)} ${albumData.year ? `• ${albumData.year}` : ''} • ${albumData.tracks.length} Tracks</div>
              <a class="small text-info text-decoration-none d-inline-flex align-items-center gap-1 mt-1" href="https://musicbrainz.org/release-group/${encodeURIComponent(albumData.releaseGroupId || releaseGroupMbid)}" target="_blank" rel="noopener noreferrer" title="Open this album on MusicBrainz">
                <i class="bi-box-arrow-up-right"></i> View on MusicBrainz
              </a>
            </div>
          </div>

          <!-- Tracks Checklist -->
          <div class="d-flex flex-column gap-2" id="albumTracksChecklist">
            ${renderAddAlbumTracksList(albumData.tracks, existingSongKeys, albumData.artist, albumData.excludedTracks)}
          </div>
        </div>
        `;

        targetContainer.querySelector('#backToAlbumsListBtn')?.addEventListener('click', handleBack);

        // Add missing tracks or full album button
        if (!allInLib) {
            targetContainer.querySelector('#addAllAlbumTracksBtn')?.addEventListener('click', async () => {
                const tracksToAdd = partialInLib ? missingTracks : albumData.tracks;
                await addAlbumToLibrary(albumData, tracksToAdd, activeCollectionId);
                showToast(`Added ${tracksToAdd.length} ${tracksToAdd.length === 1 ? 'track' : 'tracks'} to library`, 'success');
                window.dispatchEvent(new CustomEvent('libraryDataChanged'));
                await exploreAlbumTracklist(releaseGroupMbid, container, false);
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

        // Add single track
        targetContainer.querySelectorAll('.add-single-track-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const idx = parseInt(btn.dataset.trackIdx, 10);
                const track = albumData.tracks[idx];
                const song = {
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
                await saveSongToLibrary(song, activeCollectionId);
                window.dispatchEvent(new CustomEvent('libraryDataChanged'));
                btn.className = 'btn btn-sm btn-theme-success py-1 px-3 disabled flex-shrink-0 ms-2';
                btn.innerHTML = '<i class="bi-check-lg me-1"></i> In Library';
                targetContainer.querySelector('#viewAlbumInLibraryBtn')?.classList.remove('d-none');
            });
        });

        targetContainer.querySelectorAll('.library-track-row:not(.is-filtered-out)').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('button, a, input')) return;
                const addBtn = row.querySelector('.add-single-track-btn');
                if (addBtn && !addBtn.disabled && !addBtn.classList.contains('disabled')) {
                    addBtn.click();
                }
            });
        });

        gamepadManager.onLibraryViewRendered();
    } catch (err) {
        if (thisFetchToken !== currentExploreTracklistToken) return;
        targetContainer.innerHTML = `
        <div class="mb-3">
          <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2" id="backToAlbumsListBtn">
            <i class="bi-arrow-left"></i> <span>Back</span>
          </button>
        </div>
        <div class="text-danger py-4 text-center">Failed to load tracklist: ${escapeHtml(err.message)}</div>`;
        targetContainer.querySelector('#backToAlbumsListBtn')?.addEventListener('click', handleBack);
    }
}

function renderAddAlbumTracksList(tracks, existingSongKeys = new Set(), artistName = '', excludedTracks = []) {
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
    const renderExcludedItem = (t, idx) => `
        <div class="library-track-row is-filtered-out d-flex align-items-center justify-content-between gap-2 gap-sm-3" title="Not added: ${escapeHtml(excludedLabels[t.excludedReason] || 'Filtered out')}">
          <div class="d-flex align-items-center gap-2 gap-sm-3 min-w-0 flex-grow-1">
            <span class="badge-track-num flex-shrink-0">${t.trackNumber || idx + 1}</span>
            <span class="library-song-title fw-semibold text-white" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
          </div>
          <span class="badge badge-theme-secondary flex-shrink-0 ms-1 ms-sm-2">${escapeHtml(excludedLabels[t.excludedReason] || 'Filtered out')}</span>
        </div>
        `;

    const renderTrackItem = (t, idx) => {
        const isSongInLib = (t.recordingMbid && existingSongKeys.has(`rec:${t.recordingMbid}`)) ||
                            (t.id && existingSongKeys.has(`rec:${t.id}`)) ||
                            existingSongKeys.has(`${(artistName || '').toLowerCase().trim()}:::${(t.title || '').toLowerCase().trim()}`);
        return `
        <div class="library-track-row d-flex align-items-center justify-content-between gap-2 gap-sm-3" role="button" tabindex="0">
          <div class="d-flex align-items-center gap-2 gap-sm-3 min-w-0 flex-grow-1">
            <span class="badge-track-num flex-shrink-0">${t.trackNumber || idx + 1}</span>
            <span class="library-song-title fw-semibold text-white" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
          </div>
          ${isSongInLib ? `
            <button class="btn btn-sm btn-theme-success py-1 px-2 px-sm-3 disabled flex-shrink-0 ms-1 ms-sm-2" title="Track already in library">
              <i class="bi-check-lg me-1"></i> <span class="d-none d-sm-inline">In Library</span><span class="d-inline d-sm-none">Saved</span>
            </button>
          ` : `
            <button class="btn btn-sm btn-theme-outline py-1 px-2 px-sm-3 add-single-track-btn flex-shrink-0 ms-1 ms-sm-2" data-track-idx="${idx}">
              <i class="bi-plus"></i> Add
            </button>
          `}
        </div>
        `;
    };

    const renderItem = ({ track: t, idx, excluded }) => (excluded ? renderExcludedItem(t, idx) : renderTrackItem(t, idx));

    if (groups.length === 1 && !groups[0].mediumTitle) {
        return groups[0].items.map(renderItem).join('');
    }

    return groups.map(grp => {
        const formatLabel = grp.mediumFormat || 'CD';
        const discTitle = grp.mediumTitle ? `: ${escapeHtml(grp.mediumTitle)}` : '';
        const headerText = `${formatLabel} ${grp.mediumNumber}${discTitle}`;
        const keptCount = grp.items.filter(item => !item.excluded).length;

        return `
        <div class="library-medium-section mb-2">
          <div class="library-disc-header d-flex align-items-center gap-2 py-2 px-3 mb-2">
            <i class="bi-disc text-accent"></i>
            <span class="fw-bold small text-white text-uppercase" style="letter-spacing: 0.04em; font-size: 0.78rem;">${headerText}</span>
            <span class="badge badge-theme-secondary py-0 px-2 ms-auto text-muted font-monospace" style="font-size:0.68rem;">${keptCount ? `${keptCount} ${keptCount === 1 ? 'Track' : 'Tracks'}` : 'Filtered out'}</span>
          </div>
          <div class="d-flex flex-column gap-2">
            ${grp.items.map(renderItem).join('')}
          </div>
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
                closeLibraryModal();
                await loadFile(stored.file);
                return;
            }
        }
        showToast(`File "${r.name}" could not be restored from storage.`, 'warning');
}

// Tools page: laid out like Settings. Tuner, Reference library and Jam render in the page. The fretboard belongs to the open tab, so it lives only in the reader's Tools menu.
function renderToolsView(container) {
    const $ = (id) => document.getElementById(id);
    const tools = [
        { id: 'reference', title: 'Reference library' },
        { id: 'tuner', title: 'Tuner' }
    ];
    if ($('jamToggleBtn') && $('jamPill') && $('jamPill').style.display !== 'none') tools.push({ id: 'jam', title: 'Jam' });
    renderToolsPage(container, { tools, escapeHtml });
}

function recentRowHtml(r) {
            const cover = r.coverUrl || getPlaceholderCoverSvg(r.songTitle || r.name);
            const tunings = (Array.isArray(r.tunings) ? r.tunings : []).filter(t => isTuningMatchingInstrument(t));
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
            <div class="library-row-card recent-row d-flex align-items-center gap-3 open-recent-row ${isRecentsEditMode ? '' : 'library-row-clickable'}" data-recent-id="${escapeHtml(r.id)}" data-recent='${escapeHtml(JSON.stringify(r))}' ${isRecentsEditMode ? '' : 'role="button" tabindex="0"'} title="${escapeHtml(rowTitle)}">
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
