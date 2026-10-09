// libraryModal.js
// Artwork-rich MusicBrainz-powered Tab Library Page aligned to themes.

import {
    getCollections, createCollection, deleteCollection, getLibraryHierarchy, getLibraryTuningsHierarchy,
    getSongsByCollection, saveSongToLibrary, addAlbumToLibrary, deleteSongFromLibrary,
    deleteAlbumFromLibrary, getSongById, addTabOptionToSong, removeTabOptionFromSong, setDefaultTabOption,
    togglePinSong, getAlbumTabOptions, addTabOptionToAlbum, removeTabOptionFromAlbum, setDefaultAlbumTabOption,
    mapOpenFileToSong, getRecents, clearRecents, deleteRecentItem, addRecentOpened, DEFAULT_COLLECTION_ID
} from './libraryStore.js';
import {
    searchMusicBrainz, getArtistAlbums, getAlbumTracks, getMusicianRelations,
    getCoverArtUrl, getPlaceholderCoverSvg, isDvdOrBlurayMedium, isVinylOrTapeMedium, isNonCdMedium,
    hydrateCachedImages
} from './musicbrainz.js';
import { getStoredFile, saveStoredFile } from './fileStore.js';
import { loadFile, getCurrentFile } from './main.js';
import { openFromProvider, getFileProviders } from './fileProviders.js';
import { openOpenFileModal } from './openFileModal.js';
import { extractScoreTunings, inferTuningFromTextOrName, detectFileMetadata, getTuningInfo, setCustomTuningName, getCustomTuningName, getTuningCategory, isTuningMatchingInstrument, getInstrumentMode } from './utils/tuningUtils.js';
import { updateGlobalAudioControls } from './utils/navigationUtils.js';
import { showToast } from './utils/toast.js';
import { scoreOptionsState } from './gpProcessor/gpPlayer.js';

let activeView = 'library'; // 'library', 'search', 'recents'
let activeCollectionId = DEFAULT_COLLECTION_ID;
let libraryBrowseMode = 'artists'; // 'artists' | 'tunings'
let selectedArtist = null;
let selectedAlbum = null;
let selectedFolderPath = []; // Array of folder path segments e.g. ['Exercises', 'Technique']
let selectedTuning = null;
let isAlbumEditMode = false;
let isRecentsEditMode = false;
let searchType = 'song'; // 'song' (default), 'album', 'artist', 'musician', 'custom'
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

    document.getElementById('navBtnLibrary')?.addEventListener('click', () => switchView('library'));
    document.getElementById('navBtnRecents')?.addEventListener('click', () => switchView('recents'));
    document.getElementById('libraryReturnToSongBtn')?.addEventListener('click', closeLibraryModal);

    window.addEventListener('libraryDataChanged', () => {
        if (isLibraryOpen()) {
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
export function canGoBack() {
    if (searchSubView) return true;
    if (activeView === 'library') {
        if (libraryBrowseMode === 'tunings' && selectedTuning) return true;
        if (selectedFolderPath.length > 0) return true;
        if (selectedArtist || selectedAlbum) return true;
    }
    if (activeView === 'search' && (searchSubView || searchHistory.length > 0)) return true;
    return viewHistory.length > 0;
}

/**
 * Unified back handler for library page (used by in-view back buttons & shortcuts)
 */
export async function handleBack() {
    const content = document.getElementById('libraryModalContent');
    if (searchSubView && searchSubView.fromView === 'library') {
        searchSubView = null;
        if (viewHistory.length > 0) {
            const prev = viewHistory.pop();
            activeView = prev.view || 'library';
            libraryBrowseMode = prev.libraryBrowseMode || 'artists';
            selectedArtist = prev.selectedArtist || null;
            selectedAlbum = prev.selectedAlbum || null;
            selectedFolderPath = prev.selectedFolderPath || [];
            selectedTuning = prev.selectedTuning || null;
            isAlbumEditMode = false;
            await renderLibraryModal();
            return;
        } else {
            await renderLibraryModal();
            return;
        }
    }
    if (activeView === 'library') {
        if (libraryBrowseMode === 'tunings' && selectedTuning) {
            selectedTuning = null;
            await renderView();
            return;
        }
        if (selectedFolderPath.length > 0) {
            selectedFolderPath.pop();
            selectedAlbum = (selectedFolderPath.length > 0 && selectedArtist?.albums)
                ? (selectedArtist.albums.find(a => (a.folderPath || a.title) === selectedFolderPath.join('/')) || null)
                : null;
            isAlbumEditMode = false;
            await renderView();
            return;
        }
        if (selectedAlbum) {
            selectedAlbum = null;
            isAlbumEditMode = false;
            await renderView();
            return;
        }
        if (selectedArtist) {
            selectedArtist = null;
            selectedFolderPath = [];
            isAlbumEditMode = false;
            await renderView();
            return;
        }
        if (viewHistory.length > 0) {
            const prev = viewHistory.pop();
            activeView = prev.view || 'library';
            libraryBrowseMode = prev.libraryBrowseMode || 'artists';
            selectedArtist = prev.selectedArtist || null;
            selectedAlbum = prev.selectedAlbum || null;
            selectedFolderPath = prev.selectedFolderPath || [];
            selectedTuning = prev.selectedTuning || null;
            isAlbumEditMode = false;
            searchSubView = prev.searchSubView || null;
            await renderLibraryModal();
            return;
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
            return;
        }
        if (searchSubView) {
            searchSubView = null;
            const header = document.querySelector('.search-sticky-header');
            if (header) header.style.display = '';
            renderSearchResults(currentSearchResults, searchType, resContainer);
            return;
        }
        if (viewHistory.length > 0) {
            const prev = viewHistory.pop();
            activeView = prev.view || 'library';
            selectedArtist = prev.selectedArtist || null;
            selectedAlbum = prev.selectedAlbum || null;
            selectedFolderPath = prev.selectedFolderPath || [];
            selectedTuning = prev.selectedTuning || null;
            searchSubView = prev.searchSubView || null;
            await renderLibraryModal();
            return;
        } else {
            await switchView('library', false);
            return;
        }
    } else if (activeView === 'recents') {
        if (viewHistory.length > 0) {
            const prev = viewHistory.pop();
            activeView = prev.view || 'library';
            selectedArtist = prev.selectedArtist || null;
            selectedAlbum = prev.selectedAlbum || null;
            searchSubView = prev.searchSubView || null;
            await renderLibraryModal();
            return;
        } else {
            await switchView('library', false);
            return;
        }
    }
    closeLibraryModal();
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

/**
 * Open the Tab Library Page
 */
export async function openLibraryModal(initialView = 'library') {
    initLibraryTopBar();
    if (initialView !== activeView) {
        viewHistory = [];
    }
    activeView = initialView;

    let page = document.getElementById('libraryPage');
    if (!page) {
        page = createLibraryPageElement();
    }

    const mainContent = document.getElementById('mainContent');
    if (mainContent) mainContent.style.display = 'none';

    // Update top bar for Library Mode
    const libraryNav = document.getElementById('libraryNavButtons');
    const modeButtons = document.getElementById('modeButtons');
    const globalAudio = document.getElementById('globalAudioControls');
    const audioSourcePill = document.getElementById('audioSourcePill');
    const navButtons = document.getElementById('navButtons');
    const returnBtn = document.getElementById('libraryReturnToSongBtn');
    const returnName = document.getElementById('libraryReturnSongName');
    const brandText = document.getElementById('brand-text');
    const songBreadcrumb = document.getElementById('songBreadcrumb');
    const currentOpen = getCurrentFile();

    if (libraryNav) libraryNav.style.display = 'flex';
    if (modeButtons) modeButtons.style.display = 'none';
    if (globalAudio) globalAudio.style.display = 'none';
    if (audioSourcePill) audioSourcePill.style.display = 'none';
    if (navButtons) navButtons.style.display = 'none';
    if (songBreadcrumb) songBreadcrumb.style.display = 'none';
    if (brandText) brandText.style.display = 'inline-flex';

    if (returnBtn) {
        if (currentOpen && (currentOpen.songTitle || currentOpen.librarySongTitle || currentOpen.name)) {
            const displayName = currentOpen.songTitle || currentOpen.librarySongTitle || currentOpen.name.replace(/\.[^/.]+$/, '');
            returnBtn.style.display = 'inline-flex';
            if (returnName) returnName.textContent = displayName;
            returnBtn.title = `Return to score: ${displayName}`;
        } else {
            returnBtn.style.display = 'none';
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

    if (force || currentOpen) {
        if (page) page.style.display = 'none';
        const mainContent = document.getElementById('mainContent');
        if (mainContent) mainContent.style.display = '';

        // Restore top bar for Song Mode
        const libraryNav = document.getElementById('libraryNavButtons');
        const modeButtons = document.getElementById('modeButtons');
        const navButtons = document.getElementById('navButtons');
        const returnBtn = document.getElementById('libraryReturnToSongBtn');
        const brandText = document.getElementById('brand-text');
        const songBreadcrumb = document.getElementById('songBreadcrumb');
        const songTitleEl = document.getElementById('topBarSongTitle');

        if (libraryNav) libraryNav.style.display = 'none';
        if (modeButtons) modeButtons.style.display = currentOpen ? 'flex' : 'none';
        if (returnBtn) returnBtn.style.display = 'none';

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

        if (navButtons && currentOpen) {
            navButtons.style.display = 'flex';
        }

        updateGlobalAudioControls();
    }
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
    return page;
}

/**
 * Main render function for Tab Library Page
 */
export async function renderLibraryModal() {
    initLibraryTopBar();
    const page = document.getElementById('libraryPage') || createLibraryPageElement();
    if (!page) return;

    const collections = await getCollections();
    const currentCollection = collections.find(c => c.id === activeCollectionId) || collections[0] || { id: DEFAULT_COLLECTION_ID, name: 'My Library' };
    activeCollectionId = currentCollection.id;

    const currentOpen = getCurrentFile();
    const returnBtn = document.getElementById('libraryReturnToSongBtn');
    const returnName = document.getElementById('libraryReturnSongName');
    if (returnBtn) {
        if (currentOpen && (currentOpen.songTitle || currentOpen.librarySongTitle || currentOpen.name)) {
            const displayName = currentOpen.songTitle || currentOpen.librarySongTitle || currentOpen.name.replace(/\.[^/.]+$/, '');
            returnBtn.style.display = 'inline-flex';
            if (returnName) returnName.textContent = displayName;
            returnBtn.title = `Return to score: ${displayName}`;
        } else {
            returnBtn.style.display = 'none';
        }
    }

    const navLib = document.getElementById('navBtnLibrary');
    const navRec = document.getElementById('navBtnRecents');
    if (navLib) navLib.classList.toggle('active', activeView === 'library' || activeView === 'search');
    if (navRec) navRec.classList.toggle('active', activeView === 'recents');

    updateBackBtnVisibility();

    // Ensure content container is present
    let content = document.getElementById('libraryModalContent');
    if (!content) {
        page.innerHTML = `<div class="library-page-body" id="libraryModalContent"></div>`;
        content = document.getElementById('libraryModalContent');
    }

    await renderView();
}

async function switchView(view, pushHistory = true) {
    if (pushHistory && activeView !== view) {
        viewHistory.push({
            view: activeView,
            selectedArtist,
            selectedAlbum,
            searchSubView
        });
    }
    activeView = view;
    await renderLibraryModal();
}

async function renderView() {
    const content = document.getElementById('libraryModalContent');
    if (!content) return;

    if (activeView === 'library') {
        await renderLibraryBrowseView(content);
    } else if (activeView === 'search') {
        renderSearchMusicBrainzView(content);
    } else if (activeView === 'recents') {
        await renderRecentsView(content);
    }
}

// // -----------------------------------------------------------------------------
// 1. LIBRARY BROWSER VIEW (Collection > Artist > Album > Song / Tunings)
// -----------------------------------------------------------------------------
async function renderLibraryBrowseView(container) {
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
    const headerHtml = `
    <div class="library-page-container">
      <div class="library-body-header mb-3">
        <!-- Collection Selector & Browse Mode Group (Left) -->
        <div class="lib-toolbar-left d-flex align-items-center gap-2 flex-wrap">
          <div class="collection-pill-group">
            <select class="theme-select collection-select-input" id="libCollectionSelect" title="Select Collection" aria-label="Select Collection">
              ${collections.map(c => `<option value="${c.id}" ${c.id === activeCollectionId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
            </select>
            <button class="btn collection-add-btn" id="libNewCollectionBtn" title="Create New Collection" aria-label="New Collection">
              <i class="bi-plus-lg"></i>
            </button>
          </div>

          <!-- Browse Mode Toggle (Artists vs Tunings) -->
          <div class="hud-pill-group" role="group" id="libBrowseModePill">
            <button type="button" class="btn btn-sm ${libraryBrowseMode === 'artists' ? 'active' : ''}" data-mode="artists" title="Browse by Artist &amp; Album">
              <i class="bi-person me-1"></i>Artists
            </button>
            <button type="button" class="btn btn-sm ${libraryBrowseMode === 'tunings' ? 'active' : ''}" data-mode="tunings" title="Browse songs by Guitar &amp; Bass Tuning">
              <i class="bi-music-note me-1"></i>Tunings
            </button>
          </div>
        </div>

        <!-- Universal Search & Filter Bar (True Center) -->
        <div class="lib-toolbar-center">
          <div class="library-search-bar">
            <i class="bi-search search-icon"></i>
            <input type="text" class="search-input" id="libFilterInput" placeholder="${
              libraryBrowseMode === 'tunings'
                ? (selectedTuning ? `Filter songs in ${selectedTuning}...` : 'Filter tunings in library...')
                : (selectedAlbum ? 'Filter tracks in album...' : selectedArtist ? 'Filter albums or songs...' : 'Filter artists, albums, or songs...')
            }" autocomplete="off" spellcheck="false" aria-label="Filter library">
            <button class="search-clear-btn" type="button" id="libFilterClearBtn" title="Clear filter" aria-label="Clear filter" style="display: none;">
              <i class="bi-x-lg"></i>
            </button>
          </div>
        </div>

        <!-- Primary CTAs: Open File + Add Music (Right) -->
        <div class="lib-toolbar-right d-flex align-items-center gap-2">
          <button type="button" class="btn btn-sm btn-theme-outline lib-open-file-btn" id="libOpenFileBtn" title="Open a tab file directly">
            <i class="bi-folder2-open"></i>
            <span>Open File</span>
          </button>
          <button type="button" class="btn btn-sm btn-theme-primary lib-add-music-btn" id="libAddMusicBtn" title="Search catalog or add custom music">
            <i class="bi-plus-lg"></i>
            <span>Add Music</span>
          </button>
        </div>
      </div>
    `;

    if (artists.length === 0) {
        container.innerHTML = headerHtml + `
          <div class="text-center py-5 text-muted">
            <i class="bi-music-note-list fs-1 mb-2 d-block text-white-50"></i>
            <h5 class="text-white fw-semibold">This Collection is Empty</h5>
            <p class="small text-muted mb-4">Add your favorite songs and albums to build your personalized tab catalog, or add custom music and exercises.</p>
            <div class="d-flex justify-content-center gap-2 flex-wrap">
              <button class="btn btn-theme-outline btn-sm px-3 rounded-pill" id="emptyStateOpenFileBtn">
                <i class="bi-folder2-open me-1"></i> Open File
              </button>
              <button class="btn btn-theme-primary btn-sm px-3 rounded-pill" id="emptyStateAddBtn">
                <i class="bi-plus-circle me-1"></i> Add Music
              </button>
            </div>
          </div>
        </div>
        `;

        bindLibraryToolbarEvents(container);
        container.querySelector('#emptyStateAddBtn')?.addEventListener('click', () => switchView('search'));
        container.querySelector('#emptyStateOpenFileBtn')?.addEventListener('click', openOpenFileModal);
        return;
    }

    let breadcrumbHtml = '';
    let bodyHtml = '';

    // ==========================================
    // A. TUNINGS BROWSE MODE
    // ==========================================
    if (libraryBrowseMode === 'tunings') {
        const tuningsHierarchy = await getLibraryTuningsHierarchy(activeCollectionId);
        const tuningGroups = tuningsHierarchy.tunings || [];

        if (selectedTuning) {
            // Tuning Detail View
            const currentGroup = tuningGroups.find(g => g.key === selectedTuning || g.tuning === selectedTuning || g.name === selectedTuning)
                || { key: selectedTuning, tuning: selectedTuning, name: selectedTuning, notes: selectedTuning, stringCount: 6, songs: [] };
            const currentCat = currentGroup.category || getTuningCategory(currentGroup);

            breadcrumbHtml = `
            <div class="library-sticky-breadcrumbs d-flex align-items-center justify-content-between gap-3 small mb-3">
              <div class="d-flex align-items-center gap-2 flex-wrap min-w-0">
                <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2 flex-shrink-0" id="libBrowseBackBtn" title="Back to All Tunings">
                  <i class="bi-arrow-left"></i> <span>Back</span>
                </button>
                <div class="library-breadcrumbs-trail d-flex align-items-center min-w-0">
                  <button class="theme-breadcrumb-btn flex-shrink-0" id="bcTuningRoot">
                    <i class="bi-music-note"></i> <span>All Tunings</span>
                  </button>
                  <i class="bi-chevron-right breadcrumb-separator flex-shrink-0"></i>
                  <span class="theme-breadcrumb-btn active text-truncate" style="max-width: 220px;">${escapeHtml(currentGroup.name)}</span>
                  <button class="btn btn-sm theme-control-btn edit-tuning-btn p-1 px-2 ms-1 flex-shrink-0" data-tuning-key="${escapeHtml(currentGroup.key || currentGroup.tuning)}" title="Edit Tuning Name" aria-label="Edit Tuning Name">
                    <i class="bi-pencil"></i>
                  </button>
                </div>
              </div>
              <div class="d-flex align-items-center gap-2 flex-shrink-0">
                <span class="badge badge-theme-secondary py-1 px-2" style="font-size: 0.72rem;">
                  ${escapeHtml(currentCat.label || `${currentGroup.stringCount}-String`)}
                </span>
                <span class="badge badge-theme-primary py-1 px-2" style="font-size: 0.72rem;">
                  ${currentGroup.songs.length} ${currentGroup.songs.length === 1 ? 'Song' : 'Songs'}
                </span>
              </div>
            </div>
            `;

            bodyHtml = `
            <div class="tuning-detail-view">
              <div class="library-songs-list d-flex flex-column gap-2" id="libSongsList">
                ${currentGroup.songs.map(song => renderSongRow(song, { showArtistAlbum: true })).join('')}
              </div>
            </div>
            </div>
            `;
        } else {
            // Tunings Grid
            if (tuningGroups.length === 0) {
                bodyHtml = `
                <div class="text-center py-5 text-muted">
                  <i class="bi-music-note fs-1 mb-2 d-block text-white-50"></i>
                  <h6 class="text-white fw-semibold mb-1">No Tunings Found</h6>
                  <p class="small text-muted mb-3">Add tab files with guitar or bass scores to see your songs categorized by tuning.</p>
                </div>
                </div>
                `;
            } else {
                // Group tuningGroups into string count / baritone sections
                const sectionsMap = new Map();
                for (const group of tuningGroups) {
                    const cat = group.category || getTuningCategory(group);
                    const catId = cat.id || `${group.stringCount || 6}-string`;
                    if (!sectionsMap.has(catId)) {
                        sectionsMap.set(catId, {
                            id: catId,
                            title: cat.title || `${group.stringCount || 6}-String`,
                            order: cat.order ?? 99,
                            groups: []
                        });
                    }
                    sectionsMap.get(catId).groups.push(group);
                }

                const sortedSections = Array.from(sectionsMap.values()).sort((a, b) => a.order - b.order);

                bodyHtml = `
                <div class="library-tunings-container d-flex flex-column gap-4" id="libTuningsGrid">
                  ${sortedSections.map(sec => `
                    <div class="library-tuning-section" data-tuning-section="${escapeHtml(sec.id)}">
                      <div class="d-flex align-items-center justify-content-between mb-2">
                        <div class="small fw-semibold text-white d-flex align-items-center gap-2">
                          <i class="bi-music-note-list text-info"></i> ${escapeHtml(sec.title)}
                          <span class="badge badge-theme-secondary py-0 px-2" style="font-size:0.65rem;">${sec.groups.length} ${sec.groups.length === 1 ? 'Tuning' : 'Tunings'}</span>
                        </div>
                      </div>
                      <div class="library-tunings-grid">
                        ${sec.groups.map(group => {
                          const sampleArtists = Array.from(new Set(group.songs.map(s => s.artist).filter(Boolean))).slice(0, 3).join(', ');
                          const cat = group.category || getTuningCategory(group);
                          return `
                          <div class="library-card tuning-card p-3 position-relative" data-tuning-key="${escapeHtml(group.key || group.tuning)}" data-tuning-name="${escapeHtml(group.name)}" data-tuning-notes="${escapeHtml(group.notes || group.key || group.tuning)}">
                            <div class="d-flex align-items-center justify-content-between gap-2 mb-2">
                              <span class="badge badge-theme-secondary py-1 px-2" style="font-size: 0.68rem;">${escapeHtml(cat.label || `${group.stringCount || 6}-String`)}</span>
                              <button class="btn btn-sm theme-control-btn edit-tuning-btn p-1 px-2" data-tuning-key="${escapeHtml(group.key || group.tuning)}" title="Edit Tuning Name" aria-label="Edit Tuning Name">
                                <i class="bi-pencil"></i>
                              </button>
                            </div>
                            <h6 class="mb-1 fw-bold text-white text-truncate" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</h6>
                            <div class="fw-semibold text-info small mb-2" style="font-family: var(--font-monospace, monospace); letter-spacing: 0.06em; font-size: 0.78rem;" title="Tuning Notes">
                              ${escapeHtml(group.notes || group.key || group.tuning)}
                            </div>
                            <div class="small text-muted text-truncate mb-1">${group.songs.length} ${group.songs.length === 1 ? 'Song' : 'Songs'}</div>
                            ${sampleArtists ? `<div class="small text-white-50 text-truncate" style="font-size: 0.74rem;">${escapeHtml(sampleArtists)}</div>` : ''}
                          </div>
                          `;
                        }).join('')}
                      </div>
                    </div>
                  `).join('')}
                </div>
                </div>
                `;
            }
        }
    } else {
        // ==========================================
        // B. ARTISTS / ALBUMS / TRACKS / CUSTOM FOLDERS BROWSE MODE
        // ==========================================
        if (selectedArtist) {
            const isCustomArtist = Boolean(selectedArtist.isCustom);
            const currentPath = selectedFolderPath.join('/');

            // Find immediate subfolders at currentPath
            const subfolderMap = new Map();
            for (const alb of selectedArtist.albums) {
                const fullFolder = (alb.folderPath || alb.title || '').trim();
                if (!fullFolder) continue;
                let rest = '';
                if (currentPath === '') {
                    rest = fullFolder;
                } else if (fullFolder === currentPath) {
                    continue;
                } else if (fullFolder.startsWith(currentPath + '/')) {
                    rest = fullFolder.slice(currentPath.length + 1);
                } else {
                    continue;
                }
                const immediateName = rest.split('/')[0];
                if (!immediateName) continue;
                const subPath = currentPath ? `${currentPath}/${immediateName}` : immediateName;
                if (!subfolderMap.has(immediateName)) {
                    subfolderMap.set(immediateName, {
                        name: immediateName,
                        path: subPath,
                        year: alb.year || null,
                        coverUrl: alb.coverUrl || null,
                        songsCount: 0,
                        songs: []
                    });
                }
                const subEntry = subfolderMap.get(immediateName);
                subEntry.songsCount += alb.songs.length;
                subEntry.songs.push(...alb.songs);
            }
            const currentSubfolders = Array.from(subfolderMap.values());

            // Find direct songs at currentPath
            let currentSongs = [];
            let matchingAlbum = null;
            if (currentPath === '') {
                currentSongs = selectedArtist.songs || [];
            } else {
                matchingAlbum = selectedArtist.albums.find(a => (a.folderPath || a.title) === currentPath) || null;
                if (matchingAlbum) {
                    currentSongs = matchingAlbum.songs || [];
                }
            }

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

            breadcrumbHtml = `
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
                  ${currentSubfolders.length > 0 && currentSongs.length > 0
                    ? `${currentSubfolders.length} ${currentSubfolders.length === 1 ? 'Folder' : 'Folders'} • ${currentSongs.length} ${currentSongs.length === 1 ? 'Song' : 'Songs'}`
                    : currentSubfolders.length > 0
                      ? `${currentSubfolders.length} ${currentSubfolders.length === 1 ? (isCustomArtist ? 'Folder' : 'Album') : (isCustomArtist ? 'Folders' : 'Albums')}`
                      : `${currentSongs.length} ${currentSongs.length === 1 ? 'Song' : 'Songs'}`
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

            if (isStandardAlbumView && matchingAlbum) {
                // Standard Album View
                const album = matchingAlbum;
                const cover = album.coverUrl || getPlaceholderCoverSvg(album.title);
                const totalDurationSecs = album.songs.reduce((acc, s) => acc + (typeof s.length === 'number' ? s.length : 0), 0);
                const albumDurationText = totalDurationSecs > 0 ? formatTrackDuration(totalDurationSecs) : '';

                const albumTabs = await getAlbumTabOptions(activeCollectionId, selectedArtist.name, album.title);
                const hasAlbumTabs = albumTabs.length > 0;
                const defaultAlbumTabId = album.defaultTabId || (albumTabs[0]?.id || null);

                bodyHtml = `
                <div class="album-detail-view">
                  <div class="library-album-banner d-flex flex-column gap-3 mb-3">
                    <div class="d-flex align-items-center justify-content-between gap-3 min-w-0">
                      <div class="d-flex align-items-center gap-3 min-w-0 flex-grow-1">
                        <img src="${cover}" class="album-cover-banner flex-shrink-0" alt="${escapeHtml(album.title)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(album.title)}'">
                        <div class="min-w-0 flex-grow-1">
                          <span class="badge badge-theme-primary mb-1" style="font-size:0.68rem;">Album</span>
                          <h5 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(album.title)}">${escapeHtml(album.title)}</h5>
                          <div class="small text-muted text-truncate" title="${escapeHtml(selectedArtist.name)}">
                            ${escapeHtml(selectedArtist.name)} ${album.year ? `• ${album.year}` : ''} • ${album.songs.length} ${album.songs.length === 1 ? 'Track' : 'Tracks'} ${albumDurationText ? `• ${albumDurationText}` : ''}
                          </div>
                        </div>
                      </div>

                      <div class="d-flex align-items-center gap-2 flex-shrink-0 ms-2">
                        ${!isCustomArtist ? `
                          <button class="btn btn-sm btn-theme-outline py-1 px-3 d-flex align-items-center gap-1" id="exploreLibAlbumTracklistBtn" title="Fetch complete album tracklist from MusicBrainz to view all tracks and add missing songs">
                            <i class="bi-music-note-list text-info"></i> <span class="d-none d-sm-inline">Explore Tracklist</span><span class="d-inline d-sm-none">Tracks</span>
                          </button>
                        ` : ''}

                        <div class="dropdown">
                          <button class="btn btn-sm btn-theme-outline py-1 px-3 dropdown-toggle d-flex align-items-center gap-1" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="Attach full album tab book or document">
                            <i class="bi-journal-album"></i> <span>+ Album Tab</span>
                          </button>
                          <ul class="dropdown-menu dropdown-menu-end theme-dropdown-menu">
                            <li><button class="dropdown-item small import-album-tab-btn" data-provider-id="tab-downloader"><i class="bi-cloud-arrow-down me-2 text-info"></i> Tab Downloader</button></li>
                            <li><button class="dropdown-item small import-album-tab-btn" data-provider-id="local"><i class="bi-folder2-open me-2 text-primary"></i> Local Device</button></li>
                            <li><button class="dropdown-item small import-album-tab-btn" data-provider-id="google-drive"><i class="bi-google me-2 text-danger"></i> Google Drive</button></li>
                          </ul>
                        </div>

                        ${isAlbumEditMode ? `
                          <button class="btn btn-sm btn-theme-danger d-flex align-items-center gap-2 delete-album-btn" id="deleteAlbumBtn" title="Delete entire album and songs from library">
                            <i class="bi-trash"></i> <span class="d-none d-sm-inline">Delete Album</span>
                          </button>
                          <button class="btn btn-sm btn-theme-primary d-flex align-items-center gap-2 toggle-album-edit-btn" id="toggleAlbumEditBtn" title="Done editing">
                            <i class="bi-check-lg"></i> <span class="d-none d-sm-inline">Done</span>
                          </button>
                        ` : `
                          <button class="btn btn-sm btn-theme-outline d-flex align-items-center gap-2 toggle-album-edit-btn" id="toggleAlbumEditBtn" title="Edit album tracks">
                            <i class="bi-pencil"></i> <span class="d-none d-sm-inline">Edit</span>
                          </button>
                        `}
                      </div>
                    </div>

                    ${hasAlbumTabs ? `
                      <div class="album-tabs-container pt-2 border-top border-secondary-subtle d-flex flex-wrap align-items-center gap-2">
                        <span class="small text-muted fw-semibold me-1" style="font-size: 0.72rem;"><i class="bi-journal-bookmark me-1 text-info"></i>Album Tabs:</span>
                        ${albumTabs.map((t, idx) => {
                          const isDefault = (t.id === defaultAlbumTabId) || (!defaultAlbumTabId && idx === 0);
                          return `
                          <div class="tab-option-chip ${isDefault ? 'tab-option-chip-default' : ''} play-album-tab-chip-btn" data-tab-id="${t.id}" title="Open Album Tab: ${escapeHtml(t.name)}">
                            <button class="btn btn-link p-0 set-default-album-tab-btn ${isDefault ? 'text-warning' : 'text-muted'} me-1" data-tab-id="${t.id}" title="${isDefault ? 'Default Album Tab' : 'Set as default album tab'}">
                              <i class="bi-star${isDefault ? '-fill' : ''}"></i>
                            </button>
                            <i class="bi-file-earmark-music text-info me-1"></i>
                            <span class="text-truncate" style="max-width: 220px;">${escapeHtml(t.name)}</span>
                            ${(t.tuning && isTuningMatchingInstrument(t.tuning)) ? (() => {
                              const info = getTuningInfo(t.tuning);
                              const label = info?.displayName || t.tuning;
                              return `<button class="badge badge-tuning badge-tuning-clickable border-0 py-0 px-2" data-tuning-target="${escapeHtml(info?.key || t.tuning)}" style="font-size:0.62rem;" title="Browse ${escapeHtml(info?.displayName || t.tuning)}">${escapeHtml(label)}</button>`;
                            })() : ''}
                            <button class="btn btn-link p-0 text-muted remove-album-tab-chip-btn ms-1" data-tab-id="${t.id}" title="Remove album tab"><i class="bi-x"></i></button>
                          </div>
                          `;
                        }).join('')}
                      </div>
                    ` : ''}
                  </div>

                  <!-- Songs List -->
                  <div class="library-songs-list d-flex flex-column gap-2" id="libSongsList">
                    ${renderAlbumSongsList(album.songs, { albumTabs })}
                  </div>
                </div>
                </div>
                `;
            } else {
                // Subfolders Grid and/or Songs List (Supports Infinite Layers and Layer 1 Songs)
                let subfoldersHtml = '';
                if (currentSubfolders.length > 0) {
                    subfoldersHtml = `
                    <div class="library-albums-grid mb-3" id="libAlbumsGrid">
                      ${currentSubfolders.map(sub => {
                        const cover = sub.coverUrl || (isCustomArtist ? null : getPlaceholderCoverSvg(sub.name));
                        const subSongNames = (sub.songs || []).map(s => s.title || s.name || '');
                        const albumSearchTerms = [sub.name, sub.year, ...subSongNames].filter(Boolean).join(' ').toLowerCase();
                        return `
                        <div class="library-card album-card p-3" data-album-title="${escapeHtml(sub.name)}" data-folder-name="${escapeHtml(sub.name)}" data-search-terms="${escapeHtml(albumSearchTerms)}">
                          <div class="album-cover-container mb-2">
                            ${cover
                                ? `<img src="${cover}" class="album-cover-img" alt="${escapeHtml(sub.name)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(sub.name)}'">`
                                : `<i class="bi-folder2 fs-1 text-info opacity-75"></i>`
                            }
                            ${sub.year ? `<span class="badge badge-theme-year position-absolute bottom-0 end-0 m-2">${sub.year}</span>` : ''}
                          </div>
                          <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(sub.name)}">${escapeHtml(sub.name)}</h6>
                          <div class="small text-muted text-truncate">${sub.songsCount} ${sub.songsCount === 1 ? 'Song' : 'Songs'}</div>
                        </div>
                        `;
                      }).join('')}
                    </div>
                    `;
                }

                let songsHtml = '';
                if (currentSongs.length > 0) {
                    songsHtml = `
                    <div class="library-songs-list d-flex flex-column gap-2" id="libSongsList">
                      ${currentSubfolders.length > 0 ? `<div class="small text-white-50 fw-semibold mb-1"><i class="bi-music-note me-1 text-info"></i>Songs:</div>` : ''}
                      ${renderAlbumSongsList(currentSongs)}
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

                bodyHtml = `
                <div class="artist-detail-view">
                  ${subfoldersHtml}
                  ${songsHtml}
                  ${emptyHtml}
                </div>
                </div>
                `;
            }
        } else {
            // Render Pinned Songs (if any) and Artists Grid (Top Level)
            let pinnedHtml = '';
            if (pinnedSongs.length > 0) {
                pinnedHtml = `
                <div class="library-pinned-section mb-4" id="libPinnedSection">
                  <div class="d-flex align-items-center justify-content-between mb-2">
                    <div class="small fw-semibold text-white d-flex align-items-center gap-2">
                      <i class="bi-pin-angle-fill text-warning"></i> Pinned Songs
                      <span class="badge badge-theme-secondary py-0 px-2" style="font-size:0.65rem;">${pinnedSongs.length}</span>
                    </div>
                  </div>
                  <div class="library-pinned-grid" id="libPinnedSongsList">
                    ${pinnedSongs.map(song => renderPinnedSongTile(song)).join('')}
                  </div>
                </div>
                `;
            }

            bodyHtml = `
            <div class="collection-root-view">
              ${pinnedHtml}
              ${pinnedHtml ? `<div class="small text-white-50 fw-semibold mb-2 d-flex align-items-center gap-2" id="libArtistsSectionHeading"><i class="bi-person me-1 text-info"></i> Artists</div>` : ''}
              <div class="library-artists-grid" id="libArtistsGrid">
                ${artists.map(artist => {
                  const isCustomArtist = Boolean(artist.isCustom);
                  const albumCount = artist.albums.length;
                  const songCount = (artist.songs ? artist.songs.length : 0) + artist.albums.reduce((acc, a) => acc + a.songs.length, 0);
                  const collageHtml = renderArtistCollageHtml(artist);
                  const albumNames = artist.albums.map(a => a.name || a.title || '');
                  const songNames = [
                      ...(artist.songs || []).map(s => s.title || s.name || ''),
                      ...artist.albums.flatMap(a => (a.songs || []).map(s => s.title || s.name || ''))
                  ];
                  const artistSearchTerms = [artist.name, ...albumNames, ...songNames].filter(Boolean).join(' ').toLowerCase();

                  return `
                  <div class="library-card artist-card p-3" data-artist-name="${escapeHtml(artist.name)}" data-search-terms="${escapeHtml(artistSearchTerms)}">
                    <div class="d-flex align-items-center gap-3 min-w-0">
                      ${collageHtml}
                      <div class="min-w-0 flex-grow-1">
                        <h6 class="mb-1 fw-bold text-white text-truncate" title="${escapeHtml(artist.name)}">${escapeHtml(artist.name)}</h6>
                        <div class="small text-muted text-truncate">${albumCount > 0 ? `${albumCount} ${albumCount === 1 ? (isCustomArtist ? 'Folder' : 'Album') : (isCustomArtist ? 'Folders' : 'Albums')} • ` : ''}${songCount} ${songCount === 1 ? 'Song' : 'Songs'}</div>
                      </div>
                      <i class="bi-chevron-right text-muted flex-shrink-0"></i>
                    </div>
                  </div>
                  `;
                }).join('')}
              </div>
            </div>
            </div>
            `;
        }
    }

    container.innerHTML = headerHtml + breadcrumbHtml + bodyHtml;

    bindLibraryToolbarEvents(container);

    // In-view Back button click
    container.querySelector('#libBrowseBackBtn')?.addEventListener('click', handleBack);

    // Breadcrumb clicks
    container.querySelector('#bcRoot')?.addEventListener('click', () => {
        selectedArtist = null;
        selectedAlbum = null;
        selectedFolderPath = [];
        isAlbumEditMode = false;
        renderLibraryBrowseView(container);
    });
    container.querySelector('#bcArtist')?.addEventListener('click', () => {
        selectedAlbum = null;
        selectedFolderPath = [];
        isAlbumEditMode = false;
        renderLibraryBrowseView(container);
    });
    container.querySelectorAll('.bc-folder-segment').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.segmentIndex, 10);
            if (!isNaN(idx)) {
                selectedFolderPath = selectedFolderPath.slice(0, idx + 1);
                selectedAlbum = selectedArtist?.albums?.find(a => (a.folderPath || a.title) === selectedFolderPath.join('/')) || null;
                isAlbumEditMode = false;
                renderLibraryBrowseView(container);
            }
        });
    });

    container.querySelector('#bcTuningRoot')?.addEventListener('click', () => {
        selectedTuning = null;
        renderLibraryBrowseView(container);
    });

    // Artist card clicks
    container.querySelectorAll('.artist-card').forEach(card => {
        card.addEventListener('click', () => {
            const artistName = card.dataset.artistName;
            selectedArtist = artists.find(a => a.name === artistName);
            selectedAlbum = null;
            selectedFolderPath = [];
            isAlbumEditMode = false;
            renderLibraryBrowseView(container);
        });
    });

    // Tuning card clicks & edit buttons
    container.querySelectorAll('.tuning-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.edit-tuning-btn')) return;
            const tuningKey = card.dataset.tuningKey || card.dataset.tuningName;
            selectedTuning = tuningKey;
            renderLibraryBrowseView(container);
        });
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
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                card.classList.add('album-drop-active');
            });

            card.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
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
                    }
                }

                if (attachedCount > 0) {
                    await renderLibraryBrowseView(container);
                }
            });
        }
    });

    // Search / Filter setup
    setupLibraryFilter(container);

    // Song actions & album tab actions
    setupSongRowActions(container);

    // Hydrate cached images
    hydrateCachedImages(container);
}

function bindLibraryToolbarEvents(container) {
    const collectionSelect = container.querySelector('#libCollectionSelect');
    collectionSelect?.addEventListener('change', (e) => {
        activeCollectionId = e.target.value;
        selectedArtist = null;
        selectedAlbum = null;
        selectedTuning = null;
        isAlbumEditMode = false;
        renderLibraryBrowseView(container);
    });

    // Browse Mode Switcher (Artists vs Tunings)
    container.querySelectorAll('#libBrowseModePill button').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            if (mode && mode !== libraryBrowseMode) {
                libraryBrowseMode = mode;
                selectedArtist = null;
                selectedAlbum = null;
                selectedTuning = null;
                isAlbumEditMode = false;
                renderLibraryBrowseView(container);
            }
        });
    });

    container.querySelector('#libNewCollectionBtn')?.addEventListener('click', () => {
        openThemedInputModal({
            title: 'New Collection',
            subtitle: 'Create a dedicated tab collection',
            icon: 'bi-folder-plus',
            inputLabel: 'Collection Name',
            placeholder: 'e.g. Live Setlist, Favorites, Acoustic...',
            confirmText: 'Create Collection',
            onConfirm: async (name) => {
                const col = await createCollection(name);
                activeCollectionId = col.id;
                await renderLibraryBrowseView(container);
            }
        });
    });

    container.querySelector('#libOpenFileBtn')?.addEventListener('click', () => {
        openOpenFileModal();
    });

    container.querySelector('#libAddMusicBtn')?.addEventListener('click', () => {
        switchView('search');
    });
}

function setupLibraryFilter(container) {
    const filterInput = container.querySelector('#libFilterInput');
    const clearBtn = container.querySelector('#libFilterClearBtn');
    if (!filterInput) return;

    const applyFilter = () => {
        const query = (filterInput.value || '').toLowerCase().trim();
        if (clearBtn) {
            clearBtn.style.display = query.length > 0 ? 'inline-flex' : 'none';
        }

        // Clean up previous filter empty message if any
        container.querySelectorAll('.library-filter-empty-msg').forEach(el => el.remove());

        // 1. Song List View (Album Detail or Tuning Detail - specifically #libSongsList)
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
            return;
        }

        // 2. Tunings Grid View (#libTuningsGrid)
        const tuningsGrid = container.querySelector('#libTuningsGrid');
        if (tuningsGrid) {
            const tuningCards = tuningsGrid.querySelectorAll('.tuning-card');
            let totalVisibleCount = 0;
            const sections = tuningsGrid.querySelectorAll('.library-tuning-section');
            if (sections.length > 0) {
                sections.forEach(sec => {
                    const cards = sec.querySelectorAll('.tuning-card');
                    let secVisible = 0;
                    cards.forEach(card => {
                        const name = (card.dataset.tuningName || '').toLowerCase();
                        const notes = (card.dataset.tuningNotes || '').toLowerCase();
                        const key = (card.dataset.tuningKey || '').toLowerCase();
                        const text = (card.textContent || '').toLowerCase();
                        const matches = !query || name.includes(query) || notes.includes(query) || key.includes(query) || text.includes(query);
                        card.style.display = matches ? '' : 'none';
                        if (matches) secVisible++;
                    });
                    sec.style.display = (!query || secVisible > 0) ? '' : 'none';
                    totalVisibleCount += secVisible;
                });
            } else {
                tuningCards.forEach(card => {
                    const name = (card.dataset.tuningName || '').toLowerCase();
                    const notes = (card.dataset.tuningNotes || '').toLowerCase();
                    const key = (card.dataset.tuningKey || '').toLowerCase();
                    const text = (card.textContent || '').toLowerCase();
                    const matches = !query || name.includes(query) || notes.includes(query) || key.includes(query) || text.includes(query);
                    card.style.display = matches ? '' : 'none';
                    if (matches) totalVisibleCount++;
                });
            }
            if (totalVisibleCount === 0 && query) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'library-filter-empty-msg text-center py-4 text-muted w-100';
                emptyMsg.style.gridColumn = '1 / -1';
                emptyMsg.innerHTML = `<i class="bi-search fs-3 mb-2 d-block text-white-50"></i>No tunings match "${escapeHtml(query)}"`;
                tuningsGrid.appendChild(emptyMsg);
            }
            return;
        }

        // 3. Albums Grid View (Artist Detail - #libAlbumsGrid)
        const albumsGrid = container.querySelector('#libAlbumsGrid');
        if (albumsGrid) {
            const albumCards = albumsGrid.querySelectorAll('.album-card');
            let visibleCount = 0;
            albumCards.forEach(card => {
                const title = (card.dataset.albumTitle || '').toLowerCase();
                const terms = (card.dataset.searchTerms || '').toLowerCase();
                const matches = !query || title.includes(query) || terms.includes(query);
                card.style.display = matches ? '' : 'none';
                if (matches) visibleCount++;
            });
            if (visibleCount === 0 && query) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'library-filter-empty-msg text-center py-4 text-muted';
                emptyMsg.style.gridColumn = '1 / -1';
                emptyMsg.innerHTML = `<i class="bi-search fs-3 mb-2 d-block text-white-50"></i>No albums or songs match "${escapeHtml(query)}"`;
                albumsGrid.appendChild(emptyMsg);
            }
            return;
        }

        // 4. Collection Root View (#libArtistsGrid and optional #libPinnedSection)
        const artistsGrid = container.querySelector('#libArtistsGrid');
        const pinnedSection = container.querySelector('#libPinnedSection');
        if (artistsGrid || pinnedSection) {
            let visiblePinned = 0;
            if (pinnedSection) {
                const pinnedRows = pinnedSection.querySelectorAll('.library-pinned-card, .library-song-row');
                pinnedRows.forEach(row => {
                    const title = (row.dataset.songTitle || '').toLowerCase();
                    const artist = (row.dataset.songArtist || '').toLowerCase();
                    const album = (row.dataset.songAlbum || '').toLowerCase();
                    const matches = !query || title.includes(query) || artist.includes(query) || album.includes(query);
                    row.style.display = matches ? '' : 'none';
                    if (matches) visiblePinned++;
                });
                pinnedSection.style.display = (!query || visiblePinned > 0) ? '' : 'none';
            }

            let visibleArtists = 0;
            if (artistsGrid) {
                const artistCards = artistsGrid.querySelectorAll('.artist-card');
                artistCards.forEach(card => {
                    const name = (card.dataset.artistName || '').toLowerCase();
                    const terms = (card.dataset.searchTerms || '').toLowerCase();
                    const matches = !query || name.includes(query) || terms.includes(query);
                    card.style.display = matches ? '' : 'none';
                    if (matches) visibleArtists++;
                });

                const artistsHeading = container.querySelector('#libArtistsSectionHeading');
                if (artistsHeading) {
                    artistsHeading.style.display = (!query || visibleArtists > 0) ? '' : 'none';
                }

                if (visibleArtists === 0 && visiblePinned === 0 && query) {
                    const emptyMsg = document.createElement('div');
                    emptyMsg.className = 'library-filter-empty-msg text-center py-4 text-muted';
                    emptyMsg.style.gridColumn = '1 / -1';
                    emptyMsg.innerHTML = `<i class="bi-search fs-3 mb-2 d-block text-white-50"></i>No artists, albums, or songs match "${escapeHtml(query)}"`;
                    artistsGrid.appendChild(emptyMsg);
                }
            }
            return;
        }
    };

    filterInput.addEventListener('input', applyFilter);

    clearBtn?.addEventListener('click', () => {
        filterInput.value = '';
        applyFilter();
        filterInput.focus();
    });
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
        return `<img src="${getPlaceholderCoverSvg(artist.name)}" class="artist-thumbnail flex-shrink-0" alt="${escapeHtml(artist.name)}">`;
    }

    if (covers.length === 1) {
        return `<div class="artist-thumbnail artist-thumbnail-collage artist-collage-1 flex-shrink-0"><img src="${covers[0]}" class="artist-collage-img" alt="${escapeHtml(artist.name)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(artist.name)}'"></div>`;
    }

    if (covers.length === 2) {
        return `
        <div class="artist-thumbnail artist-thumbnail-collage artist-collage-2 flex-shrink-0" title="${escapeHtml(artist.name)}">
          <img src="${covers[0]}" class="artist-collage-img" alt="" onerror="this.style.display='none'">
          <img src="${covers[1]}" class="artist-collage-img" alt="" onerror="this.style.display='none'">
        </div>`;
    }

    if (covers.length === 3) {
        return `
        <div class="artist-thumbnail artist-thumbnail-collage artist-collage-3 flex-shrink-0" title="${escapeHtml(artist.name)}">
          <img src="${covers[0]}" class="artist-collage-img" alt="" onerror="this.style.display='none'">
          <img src="${covers[1]}" class="artist-collage-img" alt="" onerror="this.style.display='none'">
          <img src="${covers[2]}" class="artist-collage-img artist-collage-span-2" alt="" onerror="this.style.display='none'">
        </div>`;
    }

    return `
    <div class="artist-thumbnail artist-thumbnail-collage artist-collage-4 flex-shrink-0" title="${escapeHtml(artist.name)}">
      <img src="${covers[0]}" class="artist-collage-img" alt="" onerror="this.style.display='none'">
      <img src="${covers[1]}" class="artist-collage-img" alt="" onerror="this.style.display='none'">
      <img src="${covers[2]}" class="artist-collage-img" alt="" onerror="this.style.display='none'">
      <img src="${covers[3]}" class="artist-collage-img" alt="" onerror="this.style.display='none'">
    </div>`;
}

function renderPinnedSongTile(song) {
    const artistName = song.artist || '';
    const albumName = song.album || '';
    const subtext = [artistName, albumName].filter(Boolean).join(' • ');

    return `
    <div class="library-pinned-card d-flex align-items-center gap-2 p-2 rounded-3 position-relative" 
         data-song-id="${song.id}" 
         data-song-title="${escapeHtml(song.title)}" 
         data-song-artist="${escapeHtml(artistName)}" 
         data-song-album="${escapeHtml(albumName)}"
         title="Play ${escapeHtml(song.title)}">
      
      <div class="pinned-play-badge flex-shrink-0" title="Play default tab">
        <i class="bi-play-fill"></i>
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

function renderSongRow(song, options = {}) {
    const tabOptions = Array.isArray(song.tabOptions) ? song.tabOptions : [];
    const hasTabs = tabOptions.length > 0;
    const tunings = (Array.isArray(song.tunings) ? song.tunings : []).filter(t => isTuningMatchingInstrument(t));
    const durationText = formatTrackDuration(song.length);
    const isPinned = Boolean(song.pinned);
    const defaultTabId = song.defaultTabId || (tabOptions[0]?.id || null);
    const albumPdfTabs = (options.albumTabs || []).filter(t => (t.name || '').toLowerCase().endsWith('.pdf') || t.isPdf || t.fileType === 'pdf');
    const showTrackNumber = options.showTrackNumber !== undefined ? options.showTrackNumber : !options.showArtistAlbum;

    return `
    <div class="library-song-row d-flex flex-column gap-2 position-relative ${isPinned ? 'library-song-row-pinned' : ''}" data-song-id="${song.id}" data-song-title="${escapeHtml(song.title)}" data-song-artist="${escapeHtml(song.artist || '')}" title="Drag &amp; drop a tab file (.gp, .pdf, .txt) here to attach">
      <div class="d-flex align-items-center justify-content-between gap-3">
        <div class="d-flex align-items-center gap-3 min-w-0 flex-grow-1">
          ${showTrackNumber ? `<span class="badge-track-num flex-shrink-0">${song.trackNumber || '•'}</span>` : ''}
          <div class="min-w-0 flex-grow-1">
            <div class="d-flex align-items-center gap-2 min-w-0 flex-wrap">
              <span class="fw-semibold text-white text-truncate" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</span>
              ${isPinned ? `<span class="badge badge-theme-warning py-0 px-2" style="font-size:0.62rem;"><i class="bi-pin-angle-fill me-1"></i>Pinned</span>` : ''}
              ${durationText ? `<span class="badge badge-theme-secondary py-1 px-2 text-muted font-monospace" style="font-size:0.68rem;" title="Duration: ${durationText}">${durationText}</span>` : ''}
            </div>
            ${options.showArtistAlbum ? `
              <div class="small text-muted text-truncate mt-1" title="${escapeHtml(song.artist || '')} • ${escapeHtml(song.album || '')}">
                ${escapeHtml(song.artist || 'Unknown Artist')}${song.album ? ` • ${escapeHtml(song.album)}` : ''}
              </div>
            ` : ''}
            ${(tunings.length > 0 || hasTabs) ? `
              <div class="d-flex align-items-center gap-2 flex-wrap mt-2">
                ${tunings.map(t => {
                  const info = getTuningInfo(t);
                  const label = info?.displayName || t;
                  return `<button type="button" class="badge badge-tuning badge-tuning-clickable border-0" data-tuning-target="${escapeHtml(info?.key || t)}" title="Browse songs in ${escapeHtml(info?.displayName || t)}">${escapeHtml(label)}</button>`;
                }).join('')}
                ${hasTabs ? `<span class="badge badge-has-tabs"><i class="bi-file-earmark-music me-1 text-info"></i>${tabOptions.length} ${tabOptions.length === 1 ? 'tab' : 'tabs'}</span>` : ''}
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="d-flex align-items-center gap-2 flex-shrink-0 ms-2">
          <!-- Pin Song Button -->
          <button class="btn btn-sm btn-theme-icon p-1 px-2 pin-song-btn ${isPinned ? 'text-warning' : 'text-muted'}" data-song-id="${song.id}" title="${isPinned ? 'Unpin song from collection' : 'Pin song to collection'}">
            <i class="bi-pin-angle${isPinned ? '-fill' : ''}"></i>
          </button>

          ${hasTabs ? `
            <button class="btn btn-sm btn-theme-primary py-1 px-3 d-flex align-items-center gap-1 play-default-tab-btn" data-song-id="${song.id}" title="Play Default Tab">
              <i class="bi-play-fill"></i> <span class="d-none d-sm-inline">Play</span>
            </button>
          ` : ''}

          <!-- Import / Download Tab Dropdown -->
          <div class="dropdown">
            <button class="btn btn-sm btn-theme-outline py-1 px-3 dropdown-toggle d-flex align-items-center gap-1" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="Import Tab">
              <i class="bi-plus-lg"></i> <span>Tab</span>
            </button>
            <ul class="dropdown-menu dropdown-menu-end theme-dropdown-menu">
              ${albumPdfTabs.length > 0 ? `
                <li><button class="dropdown-item small set-album-pdf-pages-btn" data-song-id="${song.id}"><i class="bi-file-earmark-pdf me-2 text-warning"></i> Set Album PDF Pages...</button></li>
                <li><hr class="dropdown-divider"></li>
              ` : ''}
              <li><button class="dropdown-item small import-tab-provider-btn" data-song-id="${song.id}" data-provider-id="tab-downloader"><i class="bi-cloud-arrow-down me-2 text-info"></i> Tab Downloader</button></li>
              <li><button class="dropdown-item small import-tab-provider-btn" data-song-id="${song.id}" data-provider-id="local"><i class="bi-folder2-open me-2 text-primary"></i> Local Device</button></li>
              <li><button class="dropdown-item small import-tab-provider-btn" data-song-id="${song.id}" data-provider-id="google-drive"><i class="bi-google me-2 text-danger"></i> Google Drive</button></li>
            </ul>
          </div>

          <!-- Song options (Delete) - only visible in Edit Mode -->
          ${isAlbumEditMode ? `
            <button class="btn btn-sm btn-theme-danger p-1 px-2 delete-song-btn ms-1" data-song-id="${song.id}" title="Remove song from library">
              <i class="bi-trash"></i>
            </button>
          ` : ''}
        </div>
      </div>

      <!-- Multiple Tab Options List (if has tabs) -->
      ${hasTabs ? `
        <div class="tab-options-container pt-2 mt-1 border-top border-secondary-subtle d-flex flex-wrap align-items-center gap-2">
          <span class="small text-muted fw-semibold me-1" style="font-size: 0.72rem;">Tabs:</span>
          ${tabOptions.map((t, idx) => {
            const isDefault = (t.id === defaultTabId) || (!defaultTabId && idx === 0);
            const isPdfRange = Boolean(t.isAlbumRange || t.startPage);
            const iconClass = isPdfRange ? 'bi-file-earmark-pdf text-warning' : 'bi-file-earmark-music text-info';
            return `
            <div class="tab-option-chip ${isDefault ? 'tab-option-chip-default' : ''} play-tab-chip-btn" data-song-id="${song.id}" data-tab-id="${t.id}" title="Load ${escapeHtml(t.name)}">
              <button class="btn btn-link p-0 set-default-tab-btn ${isDefault ? 'text-warning' : 'text-muted'} me-1" data-song-id="${song.id}" data-tab-id="${t.id}" title="${isDefault ? 'Default Tab' : 'Set as default tab'}">
                <i class="bi-star${isDefault ? '-fill' : ''}"></i>
              </button>
              <i class="${iconClass} me-1" style="font-size: 0.78rem;"></i>
              <span class="text-truncate" style="max-width: 160px;">${escapeHtml(t.name)}</span>
              ${(t.startPage && t.endPage) ? `<span class="badge badge-theme-warning py-0 px-1 ms-1" style="font-size:0.6rem;">pp. ${t.startPage}-${t.endPage}</span>` : ''}
              ${(t.tuning && isTuningMatchingInstrument(t.tuning)) ? (() => {
                const info = getTuningInfo(t.tuning);
                const label = info?.displayName || t.tuning;
                return `<button class="badge badge-theme-secondary badge-tuning-clickable border-0 py-0 px-2 ms-1" data-tuning-target="${escapeHtml(info?.key || t.tuning)}" style="font-size:0.62rem;" title="Browse ${escapeHtml(info?.displayName || t.tuning)}">${escapeHtml(label)}</button>`;
              })() : ''}
              <button class="btn btn-link p-0 text-muted remove-tab-chip-btn ms-1" data-song-id="${song.id}" data-tab-id="${t.id}" title="Remove tab"><i class="bi-x"></i></button>
            </div>
            `;
          }).join('')}
        </div>
      ` : ''}
    </div>
    `;
}

function renderAlbumSongsList(songs, options = {}) {
    const hasCd = (songs || []).some(s => !isDvdOrBlurayMedium(s) && !isVinylOrTapeMedium(s));
    const cleanSongs = (songs || []).filter(s => !isDvdOrBlurayMedium(s) && !(hasCd && isVinylOrTapeMedium(s)));
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
    const deleteAlbumBtn = container.querySelector('#deleteAlbumBtn');
    deleteAlbumBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!selectedArtist || !selectedAlbum) return;

        if (deleteAlbumBtn.dataset.confirming === 'true') {
            const songIds = (selectedAlbum.songs || []).map(s => s.id);
            await deleteAlbumFromLibrary(selectedArtist.name, selectedAlbum.title, activeCollectionId, songIds);
            selectedAlbum = null;
            isAlbumEditMode = false;
            await renderView();
        } else {
            deleteAlbumBtn.dataset.confirming = 'true';
            deleteAlbumBtn.innerHTML = '<i class="bi-exclamation-triangle-fill me-1"></i> <span class="d-none d-sm-inline">Confirm Delete Album?</span><span class="d-inline d-sm-none">Confirm?</span>';
            setTimeout(() => {
                if (deleteAlbumBtn.dataset.confirming === 'true') {
                    deleteAlbumBtn.dataset.confirming = 'false';
                    deleteAlbumBtn.innerHTML = '<i class="bi-trash"></i> <span class="d-none d-sm-inline">Delete Album</span>';
                }
            }, 4000);
        }
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
                    selectedFolderPath = selectedAlbum ? (selectedAlbum.folderPath ? selectedAlbum.folderPath.split('/') : [selectedAlbum.title || selectedAlbum.name]) : [];
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
            if (e.target.closest('.remove-tab-chip-btn') || e.target.closest('.set-default-tab-btn') || e.target.closest('.badge-tuning-clickable')) return;
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
            const song = await getSongById(songId);
            if (!song) return;
            const albumTabs = (selectedArtist && selectedAlbum)
                ? await getAlbumTabOptions(activeCollectionId, selectedArtist.name, selectedAlbum.title)
                : [];
            const albumPdfTabs = albumTabs.filter(t => (t.name || '').toLowerCase().endsWith('.pdf') || t.isPdf || t.fileType === 'pdf');
            if (albumPdfTabs.length === 0) {
                showToast('No whole-album PDF found for this album.', 'warning');
                return;
            }
            openSetAlbumPdfPagesModal(song, albumPdfTabs);
        });
    });

    // Explore Tracklist from Library Album Detail View
    const exploreLibBtn = container.querySelector('#exploreLibAlbumTracklistBtn');
    exploreLibBtn?.addEventListener('click', async () => {
        if (!selectedArtist || !selectedAlbum) return;
        const origHtml = exploreLibBtn.innerHTML;
        exploreLibBtn.disabled = true;
        exploreLibBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status"></span> Looking up...';

        try {
            let releaseGroupMbid = selectedAlbum.albumMbid || selectedAlbum.songs?.find(s => s.albumMbid)?.albumMbid;
            if (!releaseGroupMbid) {
                const q = `${selectedArtist.name} ${selectedAlbum.title}`;
                const results = await searchMusicBrainz(q, 'album');
                const match = results.find(r => (r.title || '').toLowerCase() === selectedAlbum.title.toLowerCase()) || results[0];
                if (match) {
                    releaseGroupMbid = match.id;
                }
            }

            if (!releaseGroupMbid) {
                showToast(`Could not find "${selectedAlbum.title}" on MusicBrainz.`, 'warning');
                exploreLibBtn.innerHTML = origHtml;
                exploreLibBtn.disabled = false;
                return;
            }

            // Save library view state to viewHistory
            viewHistory.push({
                view: 'library',
                libraryBrowseMode,
                selectedArtist,
                selectedAlbum,
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

    // Album Tabs Actions
    container.querySelectorAll('.import-album-tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (!selectedArtist || !selectedAlbum) return;
            const providerId = btn.dataset.providerId;
            const targetProviderId = (providerId === 'tab-downloader' && !window.__TAURI__) ? 'tab-downloader-web' : providerId;
            openFromProvider(targetProviderId, {
                isAlbumTab: true,
                collectionId: activeCollectionId,
                artistName: selectedArtist.name,
                albumTitle: selectedAlbum.title,
                artist: selectedArtist.name,
                songName: selectedAlbum.title,
                query: `${selectedArtist.name} ${selectedAlbum.title}`
            });
        });
    });

    container.querySelectorAll('.play-album-tab-chip-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            if (e.target.closest('.remove-album-tab-chip-btn') || e.target.closest('.set-default-album-tab-btn') || e.target.closest('.badge-tuning-clickable')) return;
            e.stopPropagation();
            if (!selectedArtist || !selectedAlbum) return;
            const tabId = btn.dataset.tabId;
            const albumTabs = await getAlbumTabOptions(activeCollectionId, selectedArtist.name, selectedAlbum.title);
            const tab = albumTabs.find(t => t.id === tabId);
            if (tab) {
                const albumSongId = `album_tab_${activeCollectionId}_${selectedArtist.name}_${selectedAlbum.title}`.replace(/[^a-zA-Z0-9_-]/g, '_');
                await loadSongTab({
                    id: albumSongId,
                    title: selectedAlbum.title,
                    artist: selectedArtist.name,
                    album: selectedAlbum.title,
                    coverUrl: selectedAlbum.coverUrl
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
            if (!selectedArtist || !selectedAlbum) return;
            const tabId = btn.dataset.tabId;
            await removeTabOptionFromAlbum(activeCollectionId, selectedArtist.name, selectedAlbum.title, tabId);
            showToast('Removed album tab', 'info');
            await renderView();
        });
    });

    // Tuning badge clicks to navigate to tuning view
    container.querySelectorAll('.badge-tuning-clickable').forEach(badge => {
        badge.addEventListener('click', (e) => {
            e.stopPropagation();
            const tuning = badge.dataset.tuningTarget;
            if (tuning) {
                const info = getTuningInfo(tuning);
                activeView = 'library';
                libraryBrowseMode = 'tunings';
                selectedTuning = info?.key || tuning;
                renderLibraryModal();
            }
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

            if (providerId === 'google-drive') {
                openFromProvider('google-drive', { songId });
                return;
            }

            // Tab downloader
            const targetProviderId = (providerId === 'tab-downloader' && !window.__TAURI__) ? 'tab-downloader-web' : providerId;
            getSongById(songId).then(song => {
                if (!song) return;
                openFromProvider(targetProviderId, {
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

        row.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            row.classList.add('song-drop-active');
        });

        row.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
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
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        });

        albumDetailView.addEventListener('dragover', (e) => {
            e.preventDefault();
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
                }
            }

            if (attachedCount > 0) {
                await renderView();
            }
        });
    }
}

/**
 * Helper to save a file to persistent store and attach it as a tab option on a song
 */
async function attachFileToSong(file, songId) {
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
async function loadSongTab(song, tabOption) {
    try {
        let file = null;
        if (tabOption.fileStoreId) {
            const stored = await getStoredFile(tabOption.fileStoreId);
            if (stored && stored.file) {
                file = stored.file;
            }
        }

        if (file) {
            file.songTitle = song.title;
            file.librarySongTitle = song.title;
            file.artist = song.artist;
            file.album = song.album;
            file.startPage = tabOption.startPage;
            file.endPage = tabOption.endPage;
            closeLibraryModal();
            await loadFile(file);

            // Record recent with full library metadata
            await addRecentOpened({
                id: file.name + (tabOption.startPage ? `_p${tabOption.startPage}_${tabOption.endPage}` : ''),
                name: tabOption.name || file.name,
                fileStoreId: tabOption.fileStoreId,
                providerId: tabOption.providerId || 'local',
                relativePath: tabOption.relativePath || file.name,
                librarySongId: song.id,
                songTitle: song.title,
                artist: song.artist,
                album: song.album,
                coverUrl: song.coverUrl,
                tunings: song.tunings
            });
        } else {
            showToast(`Tab file not found locally. Please re-import tab for ${song.title}.`, 'warning');
        }
    } catch (err) {
        console.error('Failed to load song tab:', err);
        showToast(`Error opening tab: ${err.message}`, 'error');
    }
}

// -----------------------------------------------------------------------------
// 2. SEARCH & ADD TO LIBRARY VIEW (Supports Song, Album, Artist, Musician, Custom Music)
// -----------------------------------------------------------------------------
function renderSearchMusicBrainzView(container) {
    container.innerHTML = `
    <div class="library-page-container search-mb-view">
      <!-- Search Sticky Toolbar -->
      <div class="search-sticky-header mb-3">
        <div class="d-flex align-items-center justify-content-between mb-2 flex-wrap gap-2">
          <div class="d-flex align-items-center gap-2">
            <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2" id="searchBackToLibBtn" title="Back to Library">
              <i class="bi-arrow-left"></i> <span>Library</span>
            </button>
            <span class="small fw-semibold text-white-50">Add Music:</span>
          </div>
          <div class="hud-pill-group" role="group" id="searchTypePill">
            <button type="button" class="btn btn-sm ${searchType === 'song' ? 'active' : ''}" data-type="song">Song</button>
            <button type="button" class="btn btn-sm ${searchType === 'album' ? 'active' : ''}" data-type="album">Album</button>
            <button type="button" class="btn btn-sm ${searchType === 'artist' ? 'active' : ''}" data-type="artist">Artist</button>
            <button type="button" class="btn btn-sm ${searchType === 'musician' ? 'active' : ''}" data-type="musician">Musician</button>
            <button type="button" class="btn btn-sm ${searchType === 'custom' ? 'active' : ''}" data-type="custom" title="Add custom music, exercises, and custom folder structure">
              <i class="bi-folder-plus me-1"></i>Custom Music
            </button>
          </div>
        </div>

        ${searchType === 'custom' ? '' : `
          <form id="mbSearchForm" class="d-flex align-items-center gap-2">
            <div class="input-group input-group-sm flex-grow-1">
              <span class="input-group-text"><i class="bi-search"></i></span>
              <input type="text" class="form-control" id="mbSearchInput" placeholder="Search ${searchType} to add music..." value="${escapeHtml(currentSearchQuery)}" autofocus>
            </div>
            <button type="submit" class="btn btn-theme-primary btn-sm px-3" id="mbSearchSubmitBtn">
              Search
            </button>
          </form>
        `}
      </div>

      <!-- Search Results / Custom Form Area -->
      <div id="mbSearchResultsContainer" class="search-results-container">
        ${searchType === 'custom' ? renderCustomDocFormHtml() : `
          <div class="text-center py-5 text-muted">
            <i class="bi-compass fs-2 mb-2 d-block text-white-50"></i>
            <div>Search across songs, albums, and artists to add music to your library</div>
          </div>
        `}
      </div>
    </div>
    `;

    container.querySelector('#searchBackToLibBtn')?.addEventListener('click', () => switchView('library'));

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
              <button type="button" class="btn btn-sm btn-theme-outline d-inline-flex align-items-center gap-2" id="customDocPickDriveBtn">
                <i class="bi-google text-danger"></i> Google Drive
              </button>
              <button type="button" class="btn btn-sm btn-theme-outline d-inline-flex align-items-center gap-2" id="customDocPickDownloaderBtn">
                <i class="bi-cloud-arrow-down text-info"></i> Tab Downloader
              </button>
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
                else if (attachedTab.providerId.startsWith('tab-downloader')) pName = 'Tab Downloader';
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

    container.querySelector('#customDocRemoveFileBtn')?.addEventListener('click', () => {
        attachedTab = null;
        updateAttachedUi();
    });

    // Pick Local
    container.querySelector('#customDocPickLocalBtn')?.addEventListener('click', () => {
        openFromProvider('local', { onFileSelected: handleFileAttached });
    });

    // Pick Google Drive
    container.querySelector('#customDocPickDriveBtn')?.addEventListener('click', () => {
        openFromProvider('google-drive', { onFileSelected: handleFileAttached });
    });

    // Pick Tab Downloader
    container.querySelector('#customDocPickDownloaderBtn')?.addEventListener('click', () => {
        const query = form.querySelector('#customDocTitle')?.value?.trim() || '';
        const targetProviderId = !window.__TAURI__ ? 'tab-downloader-web' : 'tab-downloader';
        openFromProvider(targetProviderId, { query, onFileSelected: handleFileAttached });
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
            <div class="library-row-card d-flex align-items-center justify-content-between gap-3">
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
            <div class="library-card album-card p-3">
              <div class="album-cover-container mb-2">
                <img src="${cover}" class="album-cover-img" alt="${escapeHtml(rg.title)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(rg.title)}'">
                ${rg.year ? `<span class="badge badge-theme-year position-absolute bottom-0 end-0 m-2">${rg.year}</span>` : ''}
              </div>
              <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(rg.title)}">${escapeHtml(rg.title)}</h6>
              <div class="small text-muted text-truncate" title="${escapeHtml(rg.artist)}">
                ${rg.inLibrary ? `<span class="badge badge-theme-primary me-1" style="font-size:0.62rem;"><i class="bi-collection-play me-1"></i>In Library</span>` : ''}
                ${escapeHtml(rg.artist)} ${rg.year ? `• ${rg.year}` : ''}
              </div>
              <div class="d-flex gap-2 mt-2">
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
            <div class="library-row-card d-flex align-items-center justify-content-between gap-3">
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
            <div class="library-card album-card p-3">
              <div class="album-cover-container mb-2">
                <img src="${a.coverUrl || getPlaceholderCoverSvg(a.title)}" class="album-cover-img" alt="${escapeHtml(a.title)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(a.title)}'">
                ${a.year ? `<span class="badge badge-theme-year position-absolute bottom-0 end-0 m-2">${a.year}</span>` : ''}
              </div>
              <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(a.title)}">${escapeHtml(a.title)}</h6>
              <div class="small text-muted text-truncate">
                ${isAlbumInLib ? `<span class="badge badge-theme-primary me-1" style="font-size:0.62rem;"><i class="bi-collection-play me-1"></i>In Library</span>` : ''}
                ${a.year || 'Album'}
              </div>
              <div class="d-flex gap-2 mt-2">
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
            <div class="library-row-card d-flex align-items-center justify-content-between gap-3">
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
        const cleanTracks = (albumData.tracks || []).filter(t => !isDvdOrBlurayMedium(t) && !(hasCd && isVinylOrTapeMedium(t)));

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
            ${addAllBtnHtml}
          </div>

          <div class="library-album-banner d-flex align-items-center gap-3 mb-3">
            <img src="${cover}" class="album-cover-banner flex-shrink-0" alt="${escapeHtml(albumData.title)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(albumData.title)}'">
            <div class="min-w-0 flex-grow-1">
              <span class="badge badge-theme-success mb-1" style="font-size:0.68rem;">Release (${albumData.country || 'International'})</span>
              <h5 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(albumData.title)}">${escapeHtml(albumData.title)}</h5>
              <div class="small text-muted text-truncate" title="${escapeHtml(albumData.artist)}">${escapeHtml(albumData.artist)} ${albumData.year ? `• ${albumData.year}` : ''} • ${albumData.tracks.length} Tracks</div>
            </div>
          </div>

          <!-- Tracks Checklist -->
          <div class="d-flex flex-column gap-2" id="albumTracksChecklist">
            ${renderAddAlbumTracksList(albumData.tracks, existingSongKeys, albumData.artist)}
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
                await handleBack();
            });
        }

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
            });
        });
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

function renderAddAlbumTracksList(tracks, existingSongKeys = new Set(), artistName = '') {
    const hasCd = (tracks || []).some(t => !isDvdOrBlurayMedium(t) && !isVinylOrTapeMedium(t));
    const cleanTracks = (tracks || []).filter(t => !isDvdOrBlurayMedium(t) && !(hasCd && isVinylOrTapeMedium(t)));
    if (!cleanTracks || cleanTracks.length === 0) return '';
    const mediaGroups = new Map();
    cleanTracks.forEach((t, idx) => {
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
        grp.items.push({ track: t, idx });
    });

    const groups = Array.from(mediaGroups.values()).sort((a, b) => a.mediumNumber - b.mediumNumber);

    const renderTrackItem = (t, idx) => {
        const isSongInLib = (t.recordingMbid && existingSongKeys.has(`rec:${t.recordingMbid}`)) ||
                            (t.id && existingSongKeys.has(`rec:${t.id}`)) ||
                            existingSongKeys.has(`${(artistName || '').toLowerCase().trim()}:::${(t.title || '').toLowerCase().trim()}`);
        return `
        <div class="library-track-row d-flex align-items-center justify-content-between gap-3">
          <div class="d-flex align-items-center gap-3 min-w-0 flex-grow-1">
            <span class="badge-track-num flex-shrink-0">${t.trackNumber || idx + 1}</span>
            <span class="text-white text-truncate fw-semibold" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
          </div>
          ${isSongInLib ? `
            <button class="btn btn-sm btn-theme-success py-1 px-3 disabled flex-shrink-0 ms-2" title="Track already in library">
              <i class="bi-check-lg me-1"></i> In Library
            </button>
          ` : `
            <button class="btn btn-sm btn-theme-outline py-1 px-3 add-single-track-btn flex-shrink-0 ms-2" data-track-idx="${idx}">
              <i class="bi-plus"></i> Add
            </button>
          `}
        </div>
        `;
    };

    if (groups.length === 1 && !groups[0].mediumTitle) {
        return groups[0].items.map(({ track: t, idx }) => renderTrackItem(t, idx)).join('');
    }

    return groups.map(grp => {
        const formatLabel = grp.mediumFormat || 'CD';
        const discTitle = grp.mediumTitle ? `: ${escapeHtml(grp.mediumTitle)}` : '';
        const headerText = `${formatLabel} ${grp.mediumNumber}${discTitle}`;

        return `
        <div class="library-medium-section mb-2">
          <div class="library-disc-header d-flex align-items-center gap-2 py-2 px-3 mb-2">
            <i class="bi-disc text-accent"></i>
            <span class="fw-bold small text-white text-uppercase" style="letter-spacing: 0.04em; font-size: 0.78rem;">${headerText}</span>
            <span class="badge badge-theme-secondary py-0 px-2 ms-auto text-muted font-monospace" style="font-size:0.68rem;">${grp.items.length} ${grp.items.length === 1 ? 'Track' : 'Tracks'}</span>
          </div>
          <div class="d-flex flex-column gap-2">
            ${grp.items.map(({ track: t, idx }) => renderTrackItem(t, idx)).join('')}
          </div>
        </div>
        `;
    }).join('');
}

// -----------------------------------------------------------------------------
// 3. RECENTS VIEW (Enriched with Library & Metadata, Edit Mode & Individual Delete)
// -----------------------------------------------------------------------------
async function renderRecentsView(container) {
    const recents = await getRecents(40);

    if (recents.length === 0) {
        container.innerHTML = `
        <div class="library-page-container">
          <div class="text-center py-5 text-muted">
            <i class="bi-clock-history fs-1 mb-2 d-block text-white-50"></i>
            <h6 class="text-white fw-semibold">No Recent Files</h6>
            <p class="small text-muted">Files and tabs you open will appear here with rich metadata and artwork.</p>
          </div>
        </div>
        `;
        return;
    }

    container.innerHTML = `
    <div class="library-page-container recents-view">
      <div class="library-body-header d-flex align-items-center justify-content-between mb-3">
        <span class="small fw-semibold text-white-50"><i class="bi-clock-history me-2 text-info"></i>Recently Opened (${recents.length})</span>
        <div class="d-flex align-items-center gap-2">
          ${isRecentsEditMode ? `
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
          `}
        </div>
      </div>

      <div class="d-flex flex-column gap-2" id="recentsList">
        ${recents.map(r => {
            const cover = r.coverUrl || getPlaceholderCoverSvg(r.songTitle || r.name);
            const tunings = (Array.isArray(r.tunings) ? r.tunings : []).filter(t => isTuningMatchingInstrument(t));
            const timeAgo = formatTimeAgo(r.openedAt);

            return `
            <div class="library-row-card d-flex align-items-center justify-content-between gap-3" data-recent-id="${escapeHtml(r.id)}">
              <div class="d-flex align-items-center gap-3 min-w-0 flex-grow-1">
                <img src="${cover}" class="artist-thumbnail flex-shrink-0" style="width: 48px; height: 48px;" alt="${escapeHtml(r.songTitle || r.name)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(r.songTitle || r.name)}'">
                <div class="min-w-0 flex-grow-1">
                  <h6 class="mb-1 fw-bold text-white text-truncate" title="${escapeHtml(r.songTitle || r.name)}">${escapeHtml(r.songTitle || r.name)}</h6>
                  <div class="small text-muted text-truncate" title="${escapeHtml(r.artist || 'Unknown Artist')} ${r.album ? `• ${escapeHtml(r.album)}` : ''}">${escapeHtml(r.artist || 'Unknown Artist')} ${r.album ? `• ${escapeHtml(r.album)}` : ''}</div>
                  <div class="d-flex align-items-center gap-2 mt-1 flex-wrap">
                    ${tunings.map(t => {
                      const info = getTuningInfo(t);
                      const label = info?.displayName || t;
                      return `<button type="button" class="badge badge-tuning badge-tuning-clickable border-0" data-tuning-target="${escapeHtml(info?.key || t)}" title="Browse songs in ${escapeHtml(info?.displayName || t)}">${escapeHtml(label)}</button>`;
                    }).join('')}
                    <span class="small text-white-50" style="font-size:0.7rem;"><i class="bi-clock me-1"></i>${timeAgo}</span>
                  </div>
                </div>
              </div>

              <div class="d-flex align-items-center gap-2 flex-shrink-0 ms-2">
                ${isRecentsEditMode ? `
                  <button class="btn btn-sm btn-theme-danger p-1 px-2 delete-recent-item-btn" data-recent-id="${escapeHtml(r.id)}" title="Delete from recents">
                    <i class="bi-trash"></i>
                  </button>
                ` : `
                  <button class="btn btn-sm btn-theme-primary py-1 px-3 open-recent-btn" data-recent='${escapeHtml(JSON.stringify(r))}'>
                    <i class="bi-play-fill me-1"></i> Open
                  </button>
                `}
              </div>
            </div>
            `;
        }).join('')}
      </div>
    </div>
    `;

    container.querySelector('#toggleRecentsEditBtn')?.addEventListener('click', () => {
        isRecentsEditMode = !isRecentsEditMode;
        renderRecentsView(container);
    });

    container.querySelectorAll('.delete-recent-item-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.recentId;
            await deleteRecentItem(id);
            showToast('Removed item from recents', 'info');
            await renderRecentsView(container);
        });
    });

    const clearBtn = container.querySelector('#clearRecentsBtn');
    clearBtn?.addEventListener('click', async () => {
        if (clearBtn.dataset.confirming === 'true') {
            await clearRecents();
            isRecentsEditMode = false;
            showToast('Cleared recent history', 'info');
            await renderRecentsView(container);
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

    container.querySelectorAll('.open-recent-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const r = JSON.parse(btn.dataset.recent);
            if (r.fileStoreId) {
                const stored = await getStoredFile(r.fileStoreId);
                if (stored?.file) {
                    stored.file.songTitle = r.songTitle || r.name;
                    stored.file.librarySongTitle = r.songTitle || r.name;
                    stored.file.artist = r.artist || '';
                    stored.file.album = r.album || '';
                    closeLibraryModal();
                    await loadFile(stored.file);
                    return;
                }
            }
            showToast(`File "${r.name}" could not be restored from storage.`, 'warning');
        });
    });

    // Handle tuning badge clicks in recents view
    container.querySelectorAll('.badge-tuning-clickable').forEach(badge => {
        badge.addEventListener('click', (e) => {
            e.stopPropagation();
            const tuning = badge.dataset.tuningTarget;
            if (tuning) {
                const info = getTuningInfo(tuning);
                activeView = 'library';
                libraryBrowseMode = 'tunings';
                selectedTuning = info?.key || tuning;
                renderLibraryModal();
            }
        });
    });

    hydrateCachedImages(container);
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
export function openSetAlbumPdfPagesModal(song, albumPdfTabs = []) {
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

    const firstTab = albumPdfTabs[0];

    modal.innerHTML = `
    <div class="theme-modal-card" style="max-width: 480px; width: 90%;">
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          <div class="theme-modal-icon">
            <i class="bi-file-earmark-pdf text-primary fs-5"></i>
          </div>
          <div class="theme-modal-titles">
            <h5 class="modal-title mb-0 fs-6 fw-bold text-white">Set Album PDF Pages</h5>
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
                ${albumPdfTabs.map((t, idx) => `<option value="${escapeHtml(t.id)}" ${idx === 0 ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
              </select>
            </div>
          ` : `
            <div>
              <label class="form-label small text-white-50 mb-1">Album PDF Source</label>
              <div class="small text-white fw-semibold"><i class="bi-file-earmark-pdf text-warning me-1"></i>${escapeHtml(firstTab.name)}</div>
            </div>
          `}
          <div class="row g-2">
            <div class="col-6">
              <label class="form-label small text-white-50 mb-1">Start Page</label>
              <input type="number" class="form-control" id="albumPdfStartPage" min="1" step="1" value="1" required>
            </div>
            <div class="col-6">
              <label class="form-label small text-white-50 mb-1">End Page</label>
              <input type="number" class="form-control" id="albumPdfEndPage" min="1" step="1" value="1" required>
            </div>
          </div>
          <div>
            <label class="form-label small text-white-50 mb-1">Tab Name (optional)</label>
            <input type="text" class="form-control" id="albumPdfTabName" placeholder="${escapeHtml(firstTab.name)} (pp. 1-1)">
          </div>
        </div>
        <div class="d-flex justify-content-end gap-2 p-3 pt-0 border-0">
          <button type="button" class="btn btn-sm btn-theme-outline px-3" id="themedAlbumPdfCancelBtn">Cancel</button>
          <button type="submit" class="btn btn-sm btn-theme-primary px-4" id="themedAlbumPdfConfirmBtn">Save Tab Range</button>
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
        const selId = sourceSelect ? sourceSelect.value : firstTab.id;
        const selTab = albumPdfTabs.find(t => t.id === selId) || firstTab;
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
        const selId = sourceSelect ? sourceSelect.value : firstTab.id;
        const selTab = albumPdfTabs.find(t => t.id === selId) || firstTab;
        const startPage = parseInt(startInput.value, 10) || 1;
        const endPage = parseInt(endInput.value, 10) || startPage;
        const customName = (nameInput.value || '').trim() || `${selTab.name} (pp. ${startPage}-${endPage})`;

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

