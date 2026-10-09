// libraryModal.js
// Artwork-rich MusicBrainz-powered Tab Library Page aligned to themes.

import {
    getCollections, createCollection, deleteCollection, getLibraryHierarchy,
    getSongsByCollection, saveSongToLibrary, addAlbumToLibrary, deleteSongFromLibrary,
    deleteAlbumFromLibrary, getSongById, addTabOptionToSong, removeTabOptionFromSong, mapOpenFileToSong,
    getRecents, clearRecents, addRecentOpened, DEFAULT_COLLECTION_ID
} from './libraryStore.js';
import {
    searchMusicBrainz, getArtistAlbums, getAlbumTracks, getMusicianRelations,
    getCoverArtUrl, getPlaceholderCoverSvg
} from './musicbrainz.js';
import { getStoredFile, saveStoredFile } from './fileStore.js';
import { loadFile, getCurrentFile } from './main.js';
import { openFromProvider, getFileProviders } from './fileProviders.js';
import { openOpenFileModal } from './openFileModal.js';
import { extractScoreTunings, inferTuningFromTextOrName } from './utils/tuningUtils.js';
import { updateGlobalAudioControls } from './utils/navigationUtils.js';
import { showToast } from './utils/toast.js';

let activeView = 'library'; // 'library', 'search', 'recents'
let activeCollectionId = DEFAULT_COLLECTION_ID;
let selectedArtist = null;
let selectedAlbum = null;
let isAlbumEditMode = false;
let searchType = 'song'; // 'song' (default), 'album', 'artist', 'musician'
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

/**
 * Check if the library page can go back to a parent view
 */
export function canGoBack() {
    if (activeView === 'library' && (selectedArtist || selectedAlbum)) return true;
    if (activeView === 'search' && (searchSubView || searchHistory.length > 0)) return true;
    return viewHistory.length > 0;
}

/**
 * Unified back handler for library page (used by in-view back buttons & shortcuts)
 */
export async function handleBack() {
    const content = document.getElementById('libraryModalContent');
    if (activeView === 'library') {
        if (selectedAlbum) {
            selectedAlbum = null;
            isAlbumEditMode = false;
            await renderView();
            return;
        }
        if (selectedArtist) {
            selectedArtist = null;
            isAlbumEditMode = false;
            await renderView();
            return;
        }
        if (viewHistory.length > 0) {
            const prev = viewHistory.pop();
            activeView = prev.view || 'library';
            selectedArtist = prev.selectedArtist || null;
            selectedAlbum = prev.selectedAlbum || null;
            isAlbumEditMode = false;
            searchSubView = prev.searchSubView || null;
            await renderLibraryModal();
            return;
        }
    } else if (activeView === 'search') {
        if (searchHistory.length > 0) {
            const prevSearch = searchHistory.pop();
            if (prevSearch.type === 'results') {
                searchSubView = null;
                const searchHeader = document.querySelector('.search-sticky-header');
                if (searchHeader) searchHeader.style.display = '';
                const resContainer = document.getElementById('mbSearchResultsContainer') || content;
                renderSearchResults(currentSearchResults, searchType, resContainer);
            } else if (prevSearch.type === 'albums') {
                searchSubView = prevSearch;
                await exploreArtistAlbums(prevSearch.artistMbid, prevSearch.artistName, content, false);
            } else if (prevSearch.type === 'bands') {
                searchSubView = prevSearch;
                await exploreMusicianBands(prevSearch.musicianMbid, prevSearch.musicianName, content, false);
            }
            return;
        }
        if (searchSubView) {
            searchSubView = null;
            const searchHeader = document.querySelector('.search-sticky-header');
            if (searchHeader) searchHeader.style.display = '';
            const resContainer = document.getElementById('mbSearchResultsContainer') || content;
            renderSearchResults(currentSearchResults, searchType, resContainer);
            return;
        }
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
    const libraryRight = document.getElementById('libraryRightControls');
    const libraryPill = document.getElementById('libraryPill');
    const globalAudio = document.getElementById('globalAudioControls');
    const audioSourcePill = document.getElementById('audioSourcePill');
    const navButtons = document.getElementById('navButtons');
    const returnBtn = document.getElementById('libraryReturnToSongBtn');
    const returnName = document.getElementById('libraryReturnSongName');
    const currentOpen = getCurrentFile();

    if (libraryNav) libraryNav.style.display = 'flex';
    if (modeButtons) modeButtons.style.display = 'none';
    if (libraryRight) libraryRight.style.display = 'flex';
    if (libraryPill) libraryPill.style.display = 'none';
    if (globalAudio) globalAudio.style.display = 'none';
    if (audioSourcePill) audioSourcePill.style.display = 'none';
    if (navButtons) navButtons.style.display = 'none';

    if (returnBtn) {
        if (currentOpen && currentOpen.name) {
            returnBtn.style.display = 'inline-flex';
            if (returnName) returnName.textContent = currentOpen.name;
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
        const libraryRight = document.getElementById('libraryRightControls');
        const libraryPill = document.getElementById('libraryPill');
        const navButtons = document.getElementById('navButtons');

        if (libraryNav) libraryNav.style.display = 'none';
        if (modeButtons) modeButtons.style.display = currentOpen ? 'flex' : 'none';
        if (libraryRight) libraryRight.style.display = 'none';
        if (libraryPill) {
            libraryPill.style.display = '';
            document.getElementById('libraryToggleBtn')?.classList.remove('active');
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
        if (currentOpen) {
            returnBtn.style.display = 'inline-flex';
            if (returnName) returnName.textContent = currentOpen.name;
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

// -----------------------------------------------------------------------------
// 1. LIBRARY BROWSER VIEW (Collection > Artist > Album > Song)
// -----------------------------------------------------------------------------
async function renderLibraryBrowseView(container) {
    const collections = await getCollections();
    const currentCollection = collections.find(c => c.id === activeCollectionId) || collections[0] || { id: DEFAULT_COLLECTION_ID, name: 'My Library' };
    activeCollectionId = currentCollection.id;

    const hierarchy = await getLibraryHierarchy(activeCollectionId);
    const artists = hierarchy.artists || [];

    // Re-sync selectedArtist and selectedAlbum against latest hierarchy data
    if (selectedArtist) {
        selectedArtist = artists.find(a => a.name === selectedArtist.name || (selectedArtist.artistMbid && a.artistMbid === selectedArtist.artistMbid)) || null;
    }
    if (selectedAlbum && selectedArtist) {
        selectedAlbum = selectedArtist.albums.find(a => a.title === selectedAlbum.title || (selectedAlbum.albumMbid && a.albumMbid === selectedAlbum.albumMbid)) || null;
    }

    // Top Library Body Toolbar (Collection Selector + Universal Search/Filter + Add Music)
    const headerHtml = `
    <div class="library-page-container">
      <div class="library-body-header mb-3">
        <!-- Collection Selector Group (Left) -->
        <div class="lib-toolbar-left d-flex align-items-center gap-2">
          <label for="libCollectionSelect" class="small text-muted mb-0 fw-semibold text-nowrap d-none d-lg-inline-flex align-items-center gap-2">
            <i class="bi-folder2 text-info"></i> <span>Collection:</span>
          </label>
          <div class="collection-pill-group">
            <select class="theme-select collection-select-input" id="libCollectionSelect" title="Select Collection" aria-label="Select Collection">
              ${collections.map(c => `<option value="${c.id}" ${c.id === activeCollectionId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
            </select>
            <button class="btn collection-add-btn" id="libNewCollectionBtn" title="Create New Collection" aria-label="New Collection">
              <i class="bi-plus-lg"></i>
            </button>
          </div>
        </div>

        <!-- Universal Search & Filter Bar (True Center) -->
        <div class="lib-toolbar-center">
          <div class="library-search-bar">
            <i class="bi-search search-icon"></i>
            <input type="text" class="search-input" id="libFilterInput" placeholder="${selectedAlbum ? 'Filter tracks in album...' : selectedArtist ? 'Filter albums by title...' : 'Filter artists in library...'}" autocomplete="off" spellcheck="false" aria-label="Filter library">
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
          <button type="button" class="btn btn-sm btn-theme-primary lib-add-music-btn" id="libAddMusicBtn" title="Search catalog to add music">
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
            <p class="small text-muted mb-4">Add your favorite songs and albums to build your personalized tab catalog, or open a tab file directly.</p>
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

    // Breadcrumb Navigation with integrated in-view Back Button
    let breadcrumbHtml = '';
    if (selectedArtist || selectedAlbum) {
        breadcrumbHtml = `
        <div class="library-sticky-breadcrumbs d-flex align-items-center justify-content-between gap-3 small mb-3">
          <div class="d-flex align-items-center gap-3 flex-wrap min-w-0">
            <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2 flex-shrink-0" id="libBrowseBackBtn" title="${selectedAlbum ? 'Back to ' + escapeHtml(selectedArtist.name) : 'Back to All Artists'}">
              <i class="bi-arrow-left"></i> <span>Back</span>
            </button>
            <div class="library-breadcrumbs-trail d-flex align-items-center min-w-0">
              <button class="theme-breadcrumb-btn flex-shrink-0" id="bcRoot">
                <i class="bi-collection"></i> <span>All Artists</span>
              </button>
              ${selectedArtist ? `
                <i class="bi-chevron-right breadcrumb-separator flex-shrink-0"></i>
                <button class="theme-breadcrumb-btn ${!selectedAlbum ? 'active' : ''} text-truncate" id="bcArtist" title="${escapeHtml(selectedArtist.name)}" style="max-width: 240px;">
                  <span class="text-truncate">${escapeHtml(selectedArtist.name)}</span>
                </button>
              ` : ''}
              ${selectedAlbum ? `
                <i class="bi-chevron-right breadcrumb-separator flex-shrink-0"></i>
                <span class="theme-breadcrumb-btn active text-truncate" title="${escapeHtml(selectedAlbum.title)}" style="max-width: 240px;">${escapeHtml(selectedAlbum.title)}</span>
              ` : ''}
            </div>
          </div>
          <div class="d-flex align-items-center gap-2 flex-shrink-0">
            <span class="badge badge-theme-secondary d-none d-sm-inline-flex py-1 px-2" style="font-size: 0.72rem;">
              ${selectedAlbum ? `${selectedAlbum.songs.length} ${selectedAlbum.songs.length === 1 ? 'Track' : 'Tracks'}` : `${selectedArtist.albums.length} ${selectedArtist.albums.length === 1 ? 'Album' : 'Albums'}`}
            </span>
          </div>
        </div>
        `;
    }

    let bodyHtml = '';

    if (!selectedArtist) {
        // Render Artists Grid
        bodyHtml = `
        <div class="library-artists-grid" id="libArtistsGrid">
          ${artists.map(artist => {
            const albumCount = artist.albums.length;
            const songCount = artist.albums.reduce((acc, a) => acc + a.songs.length, 0);
            const firstCover = artist.albums.find(a => a.coverUrl)?.coverUrl || getPlaceholderCoverSvg(artist.name);

            return `
            <div class="library-card artist-card p-3" data-artist-name="${escapeHtml(artist.name)}">
              <div class="d-flex align-items-center gap-3 min-w-0">
                <img src="${firstCover}" class="artist-thumbnail flex-shrink-0" alt="${escapeHtml(artist.name)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(artist.name)}'">
                <div class="min-w-0 flex-grow-1">
                  <h6 class="mb-1 fw-bold text-white text-truncate" title="${escapeHtml(artist.name)}">${escapeHtml(artist.name)}</h6>
                  <div class="small text-muted text-truncate">${albumCount} ${albumCount === 1 ? 'Album' : 'Albums'} • ${songCount} ${songCount === 1 ? 'Song' : 'Songs'}</div>
                </div>
                <i class="bi-chevron-right text-muted flex-shrink-0"></i>
              </div>
            </div>
            `;
          }).join('')}
        </div>
        </div>
        `;
    } else if (!selectedAlbum) {
        // Render Albums Grid for selected artist (sorted by release date, oldest first)
        const artist = artists.find(a => a.name === selectedArtist.name) || selectedArtist;
        const sortedAlbums = [...artist.albums].sort((a, b) => {
            const yA = parseInt(a.year, 10) || 9999;
            const yB = parseInt(b.year, 10) || 9999;
            if (yA !== yB) return yA - yB;
            return (a.title || '').localeCompare(b.title || '');
        });

        bodyHtml = `
        <div class="library-albums-grid" id="libAlbumsGrid">
          ${sortedAlbums.map(album => {
            const cover = album.coverUrl || getPlaceholderCoverSvg(album.title);
            const songCount = album.songs.length;
            return `
            <div class="library-card album-card p-3" data-album-title="${escapeHtml(album.title)}" data-album-year="${album.year || ''}">
              <div class="album-cover-container mb-2 position-relative">
                <img src="${cover}" class="album-cover-img w-100" alt="${escapeHtml(album.title)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(album.title)}'">
                ${album.year ? `<span class="badge badge-theme-year position-absolute bottom-0 end-0 m-2">${album.year}</span>` : ''}
              </div>
              <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(album.title)}">${escapeHtml(album.title)}</h6>
              <div class="small text-muted text-truncate">${songCount} ${songCount === 1 ? 'Song' : 'Songs'}</div>
            </div>
            `;
          }).join('')}
        </div>
        </div>
        `;
    } else {
        // Render Songs List for selected album
        const album = selectedAlbum;
        const cover = album.coverUrl || getPlaceholderCoverSvg(album.title);
        
        // Calculate total album duration if tracks have length
        const totalDurationSecs = album.songs.reduce((acc, s) => acc + (typeof s.length === 'number' ? s.length : 0), 0);
        const albumDurationText = totalDurationSecs > 0 ? formatTrackDuration(totalDurationSecs) : '';

        bodyHtml = `
        <div class="album-detail-view">
          <div class="library-album-banner d-flex align-items-center justify-content-between gap-3 mb-3">
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

          <!-- Songs List -->
          <div class="library-songs-list d-flex flex-column gap-2" id="libSongsList">
            ${renderAlbumSongsList(album.songs)}
          </div>
        </div>
        </div>
        `;
    }

    container.innerHTML = headerHtml + breadcrumbHtml + bodyHtml;

    bindLibraryToolbarEvents(container);

    // In-view Back button click
    container.querySelector('#libBrowseBackBtn')?.addEventListener('click', handleBack);

    // Breadcrumb clicks
    container.querySelector('#bcRoot')?.addEventListener('click', () => {
        selectedArtist = null;
        selectedAlbum = null;
        isAlbumEditMode = false;
        renderLibraryBrowseView(container);
    });
    container.querySelector('#bcArtist')?.addEventListener('click', () => {
        selectedAlbum = null;
        isAlbumEditMode = false;
        renderLibraryBrowseView(container);
    });

    // Artist click
    container.querySelectorAll('.artist-card').forEach(card => {
        card.addEventListener('click', () => {
            const artistName = card.dataset.artistName;
            selectedArtist = artists.find(a => a.name === artistName);
            selectedAlbum = null;
            isAlbumEditMode = false;
            renderLibraryBrowseView(container);
        });
    });

    // Album click & drag-and-drop
    container.querySelectorAll('.album-card').forEach(card => {
        const albumTitle = card.dataset.albumTitle;
        const album = selectedArtist?.albums?.find(a => a.title === albumTitle);

        card.addEventListener('click', () => {
            selectedAlbum = album;
            isAlbumEditMode = false;
            renderLibraryBrowseView(container);
        });

        if (album) {
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
                    const matchedSong = matchSongInAlbum(album.songs, file.name);
                    if (matchedSong) {
                        const ok = await attachFileToSong(file, matchedSong.id);
                        if (ok) attachedCount++;
                    } else if (album.songs?.length > 0) {
                        const ok = await attachFileToSong(file, album.songs[0].id);
                        if (ok) attachedCount++;
                    }
                }

                if (attachedCount > 0) {
                    await renderView();
                }
            });
        }
    });

    // Search / Filter setup
    setupLibraryFilter(container);

    // Song actions: Play tab, Import tab, Delete song, Switch tabs
    setupSongRowActions(container);
}

function bindLibraryToolbarEvents(container) {
    const collectionSelect = container.querySelector('#libCollectionSelect');
    collectionSelect?.addEventListener('change', (e) => {
        activeCollectionId = e.target.value;
        selectedArtist = null;
        selectedAlbum = null;
        isAlbumEditMode = false;
        renderLibraryBrowseView(container);
    });

    container.querySelector('#libNewCollectionBtn')?.addEventListener('click', async () => {
        const name = prompt('Enter name for new collection:');
        if (name && name.trim()) {
            const col = await createCollection(name.trim());
            activeCollectionId = col.id;
            await renderLibraryBrowseView(container);
        }
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

        // 1. Song List View (Album Detail)
        const songRows = container.querySelectorAll('.library-song-row');
        if (songRows.length > 0) {
            let visibleCount = 0;
            songRows.forEach(row => {
                const title = (row.dataset.songTitle || '').toLowerCase();
                const matches = !query || title.includes(query);
                row.style.display = matches ? '' : 'none';
                if (matches) visibleCount++;
            });
            const songsList = container.querySelector('#libSongsList');
            if (songsList && visibleCount === 0 && query) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'library-filter-empty-msg text-center py-4 text-muted';
                emptyMsg.innerHTML = `<i class="bi-search fs-3 mb-2 d-block text-white-50"></i>No songs match "${escapeHtml(query)}"`;
                songsList.appendChild(emptyMsg);
            }
            return;
        }

        // 2. Albums Grid View (Artist Detail)
        const albumCards = container.querySelectorAll('.library-albums-grid .album-card');
        if (albumCards.length > 0) {
            let visibleCount = 0;
            albumCards.forEach(card => {
                const title = (card.dataset.albumTitle || '').toLowerCase();
                const year = (card.dataset.albumYear || '').toLowerCase();
                const matches = !query || title.includes(query) || year.includes(query);
                card.style.display = matches ? '' : 'none';
                if (matches) visibleCount++;
            });
            const albumsGrid = container.querySelector('#libAlbumsGrid');
            if (albumsGrid && visibleCount === 0 && query) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'library-filter-empty-msg text-center py-4 text-muted';
                emptyMsg.style.gridColumn = '1 / -1';
                emptyMsg.innerHTML = `<i class="bi-search fs-3 mb-2 d-block text-white-50"></i>No albums match "${escapeHtml(query)}"`;
                albumsGrid.appendChild(emptyMsg);
            }
            return;
        }

        // 3. Artists Grid View (Top Level)
        const artistCards = container.querySelectorAll('.library-artists-grid .artist-card');
        if (artistCards.length > 0) {
            let visibleCount = 0;
            artistCards.forEach(card => {
                const name = (card.dataset.artistName || '').toLowerCase();
                const matches = !query || name.includes(query);
                card.style.display = matches ? '' : 'none';
                if (matches) visibleCount++;
            });
            const artistsGrid = container.querySelector('#libArtistsGrid');
            if (artistsGrid && visibleCount === 0 && query) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'library-filter-empty-msg text-center py-4 text-muted';
                emptyMsg.style.gridColumn = '1 / -1';
                emptyMsg.innerHTML = `<i class="bi-search fs-3 mb-2 d-block text-white-50"></i>No artists match "${escapeHtml(query)}"`;
                artistsGrid.appendChild(emptyMsg);
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

function renderSongRow(song) {
    const tabOptions = Array.isArray(song.tabOptions) ? song.tabOptions : [];
    const hasTabs = tabOptions.length > 0;
    const tunings = Array.isArray(song.tunings) ? song.tunings : [];
    const durationText = formatTrackDuration(song.length);

    return `
    <div class="library-song-row d-flex flex-column gap-2 position-relative" data-song-id="${song.id}" data-song-title="${escapeHtml(song.title)}" title="Drag &amp; drop a tab file (.gp, .pdf, .txt) here to attach">
      <div class="d-flex align-items-center justify-content-between gap-3">
        <div class="d-flex align-items-center gap-3 min-w-0 flex-grow-1">
          <span class="badge-track-num flex-shrink-0">${song.trackNumber || '•'}</span>
          <div class="min-w-0 flex-grow-1">
            <div class="d-flex align-items-center gap-2 min-w-0 flex-wrap">
              <span class="fw-semibold text-white text-truncate" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</span>
              ${durationText ? `<span class="badge badge-theme-secondary py-1 px-2 text-muted font-monospace" style="font-size:0.68rem;" title="Duration: ${durationText}">${durationText}</span>` : ''}
            </div>
            ${(tunings.length > 0 || hasTabs) ? `
              <div class="d-flex align-items-center gap-2 flex-wrap mt-2">
                ${tunings.map(t => `<span class="badge badge-tuning">${escapeHtml(t)}</span>`).join('')}
                ${hasTabs ? `<span class="badge badge-has-tabs"><i class="bi-file-earmark-music me-1 text-info"></i>${tabOptions.length} ${tabOptions.length === 1 ? 'tab' : 'tabs'}</span>` : ''}
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="d-flex align-items-center gap-2 flex-shrink-0 ms-2">
          ${hasTabs ? `
            <button class="btn btn-sm btn-theme-primary py-1 px-3 d-flex align-items-center gap-1 play-default-tab-btn" data-song-id="${song.id}" title="Play Tab">
              <i class="bi-play-fill"></i> <span class="d-none d-sm-inline">Play</span>
            </button>
          ` : ''}

          <!-- Import / Download Tab Dropdown -->
          <div class="dropdown">
            <button class="btn btn-sm btn-theme-outline py-1 px-3 dropdown-toggle d-flex align-items-center gap-1" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="Import Tab">
              <i class="bi-plus-lg"></i> <span>Tab</span>
            </button>
            <ul class="dropdown-menu dropdown-menu-end theme-dropdown-menu">
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
          ${tabOptions.map(t => `
            <div class="tab-option-chip play-tab-chip-btn" data-song-id="${song.id}" data-tab-id="${t.id}" title="Load ${escapeHtml(t.name)}">
              <span class="text-truncate" style="max-width: 160px;">${escapeHtml(t.name)}</span>
              ${t.tuning ? `<span class="badge badge-theme-secondary py-0 px-2" style="font-size:0.62rem;">${escapeHtml(t.tuning)}</span>` : ''}
              <button class="btn btn-link p-0 text-muted remove-tab-chip-btn ms-1" data-song-id="${song.id}" data-tab-id="${t.id}" title="Remove tab"><i class="bi-x"></i></button>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
    `;
}

function renderAlbumSongsList(songs) {
    if (!songs || songs.length === 0) {
        return '<div class="text-muted p-4 text-center">No songs in this album.</div>';
    }

    // Group songs by mediumNumber
    const mediaGroups = new Map();
    for (const song of songs) {
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
        return groups[0].songs.map(song => renderSongRow(song)).join('');
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
            ${grp.songs.map(song => renderSongRow(song)).join('')}
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

    // Play default tab
    container.querySelectorAll('.play-default-tab-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const songId = btn.dataset.songId;
            const song = await getSongById(songId);
            if (song && song.tabOptions?.length > 0) {
                await loadSongTab(song, song.tabOptions[0]);
            }
        });
    });

    // Play specific tab chip
    container.querySelectorAll('.play-tab-chip-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            if (e.target.closest('.remove-tab-chip-btn')) return;
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
                if (!currentAlbum || currentAlbum.songs.length === 0) {
                    selectedAlbum = null;
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
                // Open local file picker synchronously in user click gesture
                openFromProvider('local', { songId });
                return;
            }

            if (providerId === 'google-drive') {
                // Open Google drive picker cleanly without forwarding search query
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

            if (addedCount > 0) {
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
        const stored = await saveStoredFile(file, 'local');
        await addTabOptionToSong(songId, {
            name: file.name,
            providerId: 'local',
            relativePath: file.name,
            fileStoreId: stored.id,
            tuning: inferTuningFromTextOrName(file.name),
            fileType: file.name.split('.').pop().toLowerCase()
        });
        return true;
    } catch (err) {
        console.error('Error attaching dropped tab to song:', err);
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
            closeLibraryModal();
            await loadFile(file);

            // Record recent with full library metadata
            await addRecentOpened({
                id: file.name,
                name: file.name,
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
// 2. SEARCH & ADD TO LIBRARY VIEW (Defaults to Song Search Mode)
// -----------------------------------------------------------------------------
function renderSearchMusicBrainzView(container) {
    container.innerHTML = `
    <div class="library-page-container search-mb-view">
      <!-- Search Sticky Toolbar -->
      <div class="search-sticky-header mb-3">
        <div class="d-flex align-items-center justify-content-between mb-2">
          <div class="d-flex align-items-center gap-2">
            <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2" id="searchBackToLibBtn" title="Back to Library">
              <i class="bi-arrow-left"></i> <span>Library</span>
            </button>
            <span class="small fw-semibold text-white-50">Search Music:</span>
          </div>
          <div class="hud-pill-group" role="group" id="searchTypePill">
            <button type="button" class="btn btn-sm ${searchType === 'song' ? 'active' : ''}" data-type="song">Song</button>
            <button type="button" class="btn btn-sm ${searchType === 'album' ? 'active' : ''}" data-type="album">Album</button>
            <button type="button" class="btn btn-sm ${searchType === 'artist' ? 'active' : ''}" data-type="artist">Artist</button>
            <button type="button" class="btn btn-sm ${searchType === 'musician' ? 'active' : ''}" data-type="musician">Musician</button>
          </div>
        </div>

        <form id="mbSearchForm" class="d-flex align-items-center gap-2">
          <div class="input-group input-group-sm flex-grow-1">
            <span class="input-group-text"><i class="bi-search"></i></span>
            <input type="text" class="form-control" id="mbSearchInput" placeholder="Search ${searchType} to add music..." autofocus>
          </div>
          <button type="submit" class="btn btn-theme-primary btn-sm px-3" id="mbSearchSubmitBtn">
            Search
          </button>
        </form>
      </div>

      <!-- Search Results Area -->
      <div id="mbSearchResultsContainer" class="search-results-container">
        <div class="text-center py-5 text-muted">
          <i class="bi-compass fs-2 mb-2 d-block text-white-50"></i>
          <div>Search across songs, albums, and artists to add music to your library</div>
        </div>
      </div>
    </div>
    `;

    container.querySelector('#searchBackToLibBtn')?.addEventListener('click', () => switchView('library'));

    // Type pills
    container.querySelectorAll('#searchTypePill button').forEach(btn => {
        btn.addEventListener('click', () => {
            searchType = btn.dataset.type;
            renderSearchMusicBrainzView(container);
        });
    });

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

async function performMusicBrainzSearch(query, type) {
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

        // Fetch artists already in library to prioritize them in search results (Point 6)
        const hierarchy = await getLibraryHierarchy(activeCollectionId);
        const existingArtists = new Set((hierarchy.artists || []).map(a => a.name.toLowerCase().trim()));

        let sortedResults = rawResults;
        if (type === 'song' || type === 'album') {
            const inLib = [];
            const notInLib = [];

            for (const item of rawResults) {
                const artistName = (item.artist || '').toLowerCase().trim();
                const isInLib = existingArtists.has(artistName);
                const enriched = { ...item, inLibrary: isInLib };
                if (isInLib) {
                    inLib.push(enriched);
                } else {
                    notInLib.push(enriched);
                }
            }
            sortedResults = [...inLib, ...notInLib];
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
              <img src="${cover}" class="album-cover-img w-100 mb-2" alt="${escapeHtml(rg.title)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(rg.title)}'">
              <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(rg.title)}">${escapeHtml(rg.title)}</h6>
              <div class="small text-muted text-truncate" title="${escapeHtml(rg.artist)}">
                ${rg.inLibrary ? `<span class="badge badge-theme-primary me-1" style="font-size:0.62rem;"><i class="bi-collection-play me-1"></i>In Library</span>` : ''}
                ${escapeHtml(rg.artist)} ${rg.year ? `• ${rg.year}` : ''}
              </div>
              <div class="d-flex gap-2 mt-2">
                <button class="btn btn-sm btn-theme-primary flex-grow-1 add-album-btn" data-rg-id="${rg.id}" data-rg-title="${escapeHtml(rg.title)}">
                  <i class="bi-plus-lg me-1"></i> Add Album
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
              <button class="btn btn-sm btn-theme-primary flex-shrink-0 add-single-song-btn" data-song='${escapeHtml(JSON.stringify(song))}'>
                <i class="bi-plus-lg me-1"></i> Add Song
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
                btn.innerHTML = '<i class="bi-check-lg me-1"></i> Added';
            });
        });
    }
}

/**
 * Add an album and all of its tracks into the library
 */
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
        btn.innerHTML = `<i class="bi-check-lg me-1"></i> Added (${added.length} tracks)`;
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

    container.innerHTML = `
    <div class="text-center py-5 text-muted">
      <div class="spinner-border spinner-border-sm text-info mb-2" role="status"></div>
      <div>Loading studio albums for ${escapeHtml(artistName)}...</div>
    </div>
    `;

    try {
        const albums = await getArtistAlbums(artistMbid);
        if (albums.length === 0) {
            container.innerHTML = `
            <div class="mb-3">
              <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2" id="backToSearchResultsBtn">
                <i class="bi-arrow-left"></i> <span>Back to Search</span>
              </button>
            </div>
            <div class="text-center py-4 text-muted">No studio albums found for ${escapeHtml(artistName)}.</div>`;
            container.querySelector('#backToSearchResultsBtn')?.addEventListener('click', handleBack);
            return;
        }

        container.innerHTML = `
        <div class="library-sticky-breadcrumbs mb-3 d-flex align-items-center justify-content-between flex-wrap gap-2 pb-2 border-bottom border-secondary-subtle">
          <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2 flex-shrink-0" id="backToSearchResultsBtn">
            <i class="bi-arrow-left"></i> <span>Back to Search</span>
          </button>
          <div class="d-flex align-items-center gap-2 min-w-0">
            <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(artistName)}">${escapeHtml(artistName)} (${albums.length} Studio Albums)</h6>
          </div>
        </div>
        <div class="library-albums-grid">
          ${albums.map(a => `
            <div class="library-card album-card p-3">
              <img src="${a.coverUrl || getPlaceholderCoverSvg(a.title)}" class="album-cover-img w-100 mb-2" alt="${escapeHtml(a.title)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(a.title)}'">
              <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(a.title)}">${escapeHtml(a.title)}</h6>
              <div class="small text-muted text-truncate">${a.year || 'Album'}</div>
              <div class="d-flex gap-2 mt-2">
                <button class="btn btn-sm btn-theme-primary flex-grow-1 add-album-btn" data-rg-id="${a.id}" data-rg-title="${escapeHtml(a.title)}">
                  <i class="bi-plus-lg me-1"></i> Add Album
                </button>
                <button class="btn btn-sm btn-theme-outline view-album-tracks-btn px-2 flex-shrink-0" data-rg-id="${a.id}" title="View Tracks">
                  <i class="bi-music-note-list"></i>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
        `;

        container.querySelector('#backToSearchResultsBtn')?.addEventListener('click', handleBack);

        container.querySelectorAll('.add-album-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await handleAddAlbum(btn.dataset.rgId, btn);
            });
        });

        container.querySelectorAll('.view-album-tracks-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await exploreAlbumTracklist(btn.dataset.rgId, container);
            });
        });
    } catch (err) {
        container.innerHTML = `<div class="text-danger">Failed to load albums: ${escapeHtml(err.message)}</div>`;
    }
}

async function exploreMusicianBands(musicianMbid, musicianName, container, pushHistory = true) {
    const searchHeader = document.querySelector('.search-sticky-header');
    if (searchHeader) searchHeader.style.display = 'none';

    if (pushHistory) {
        searchHistory.push({ type: 'results' });
    }
    searchSubView = { type: 'bands', musicianMbid, musicianName };

    container.innerHTML = `
    <div class="text-center py-5 text-muted">
      <div class="spinner-border spinner-border-sm text-info mb-2" role="status"></div>
      <div>Finding bands &amp; projects for ${escapeHtml(musicianName)}...</div>
    </div>
    `;

    try {
        const bands = await getMusicianRelations(musicianMbid);
        if (bands.length === 0) {
            container.innerHTML = `
            <div class="mb-3">
              <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2" id="backToSearchResultsBtn">
                <i class="bi-arrow-left"></i> <span>Back to Search</span>
              </button>
            </div>
            <div class="text-center py-4 text-muted">No associated bands found for ${escapeHtml(musicianName)}.</div>`;
            container.querySelector('#backToSearchResultsBtn')?.addEventListener('click', handleBack);
            return;
        }

        container.innerHTML = `
        <div class="library-sticky-breadcrumbs mb-3 d-flex align-items-center justify-content-between pb-2 border-bottom border-secondary-subtle">
          <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2 flex-shrink-0" id="backToSearchResultsBtn">
            <i class="bi-arrow-left"></i> <span>Back to Search</span>
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

        container.querySelector('#backToSearchResultsBtn')?.addEventListener('click', handleBack);

        container.querySelectorAll('.explore-band-albums-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await exploreArtistAlbums(btn.dataset.bandId, btn.dataset.bandName, container);
            });
        });
    } catch (err) {
        container.innerHTML = `<div class="text-danger">Failed to load bands: ${escapeHtml(err.message)}</div>`;
    }
}

async function exploreAlbumTracklist(releaseGroupMbid, container, pushHistory = true) {
    const searchHeader = document.querySelector('.search-sticky-header');
    if (searchHeader) searchHeader.style.display = 'none';

    if (pushHistory) {
        searchHistory.push(searchSubView ? { ...searchSubView } : { type: 'results' });
    }
    searchSubView = { type: 'tracks', releaseGroupMbid };

    container.innerHTML = `
    <div class="text-center py-5 text-muted">
      <div class="spinner-border spinner-border-sm text-info mb-2" role="status"></div>
      <div>Fetching album tracklist...</div>
    </div>
    `;

    try {
        const albumData = await getAlbumTracks(releaseGroupMbid);
        if (!albumData || !albumData.tracks || albumData.tracks.length === 0) {
            container.innerHTML = `
            <div class="mb-3">
              <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2" id="backToAlbumsListBtn">
                <i class="bi-arrow-left"></i> <span>Back</span>
              </button>
            </div>
            <div class="text-center py-4 text-muted">No tracklist available for this album.</div>`;
            container.querySelector('#backToAlbumsListBtn')?.addEventListener('click', handleBack);
            return;
        }

        const cover = albumData.coverUrl || getPlaceholderCoverSvg(albumData.title);

        container.innerHTML = `
        <div class="album-tracks-view">
          <div class="library-sticky-breadcrumbs d-flex align-items-center justify-content-between mb-3 pb-2 border-bottom border-secondary-subtle">
            <button class="btn btn-sm btn-theme-outline in-view-back-btn py-1 px-3 d-inline-flex align-items-center gap-2 flex-shrink-0" id="backToAlbumsListBtn">
              <i class="bi-arrow-left"></i> <span>Back</span>
            </button>
            <button class="btn btn-sm btn-theme-primary px-3 flex-shrink-0" id="addAllAlbumTracksBtn">
              <i class="bi-plus-circle me-1"></i> Add Full Album to Library
            </button>
          </div>

          <div class="library-album-banner d-flex align-items-center gap-3 mb-3">
            <img src="${cover}" class="album-cover-banner flex-shrink-0" alt="${escapeHtml(albumData.title)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(albumData.title)}'">
            <div class="min-w-0 flex-grow-1">
              <span class="badge badge-theme-success mb-1" style="font-size:0.68rem;">Release (${albumData.country})</span>
              <h5 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(albumData.title)}">${escapeHtml(albumData.title)}</h5>
              <div class="small text-muted text-truncate" title="${escapeHtml(albumData.artist)}">${escapeHtml(albumData.artist)} ${albumData.year ? `• ${albumData.year}` : ''} • ${albumData.tracks.length} Tracks</div>
            </div>
          </div>

          <!-- Tracks Checklist -->
          <div class="d-flex flex-column gap-2" id="albumTracksChecklist">
            ${renderAddAlbumTracksList(albumData.tracks)}
          </div>
        </div>
        `;

        container.querySelector('#backToAlbumsListBtn')?.addEventListener('click', handleBack);

        // Add full album button
        container.querySelector('#addAllAlbumTracksBtn')?.addEventListener('click', async () => {
            await addAlbumToLibrary(albumData, albumData.tracks, activeCollectionId);
            await switchView('library');
        });

        // Add single track
        container.querySelectorAll('.add-single-track-btn').forEach(btn => {
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
                btn.className = 'btn btn-sm btn-theme-success py-1 px-3 disabled flex-shrink-0 ms-2';
                btn.innerHTML = '<i class="bi-check"></i> Added';
            });
        });
    } catch (err) {
        container.innerHTML = `<div class="text-danger">Failed to load tracklist: ${escapeHtml(err.message)}</div>`;
    }
}

function renderAddAlbumTracksList(tracks) {
    if (!tracks || tracks.length === 0) return '';
    const mediaGroups = new Map();
    tracks.forEach((t, idx) => {
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

    if (groups.length === 1 && !groups[0].mediumTitle) {
        return groups[0].items.map(({ track: t, idx }) => `
            <div class="library-track-row d-flex align-items-center justify-content-between gap-3">
              <div class="d-flex align-items-center gap-3 min-w-0 flex-grow-1">
                <span class="badge-track-num flex-shrink-0">${t.trackNumber || idx + 1}</span>
                <span class="text-white text-truncate fw-semibold" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
              </div>
              <button class="btn btn-sm btn-theme-outline py-1 px-3 add-single-track-btn flex-shrink-0 ms-2" data-track-idx="${idx}">
                <i class="bi-plus"></i> Add
              </button>
            </div>
        `).join('');
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
            ${grp.items.map(({ track: t, idx }) => `
              <div class="library-track-row d-flex align-items-center justify-content-between gap-3">
                <div class="d-flex align-items-center gap-3 min-w-0 flex-grow-1">
                  <span class="badge-track-num flex-shrink-0">${t.trackNumber || idx + 1}</span>
                  <span class="text-white text-truncate fw-semibold" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
                </div>
                <button class="btn btn-sm btn-theme-outline py-1 px-3 add-single-track-btn flex-shrink-0 ms-2" data-track-idx="${idx}">
                  <i class="bi-plus"></i> Add
                </button>
              </div>
            `).join('')}
          </div>
        </div>
        `;
    }).join('');
}

// -----------------------------------------------------------------------------
// 3. RECENTS VIEW (Enriched with Library & Metadata)
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
        <button class="btn btn-sm btn-theme-icon p-1 px-2" id="clearRecentsBtn">
          <i class="bi-trash me-1"></i> Clear History
        </button>
      </div>

      <div class="d-flex flex-column gap-2" id="recentsList">
        ${recents.map(r => {
            const cover = r.coverUrl || getPlaceholderCoverSvg(r.songTitle || r.name);
            const tunings = Array.isArray(r.tunings) ? r.tunings : [];
            const timeAgo = formatTimeAgo(r.openedAt);

            return `
            <div class="library-row-card d-flex align-items-center justify-content-between gap-3">
              <div class="d-flex align-items-center gap-3 min-w-0 flex-grow-1">
                <img src="${cover}" class="artist-thumbnail flex-shrink-0" style="width: 48px; height: 48px;" alt="${escapeHtml(r.songTitle || r.name)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(r.songTitle || r.name)}'">
                <div class="min-w-0 flex-grow-1">
                  <h6 class="mb-1 fw-bold text-white text-truncate" title="${escapeHtml(r.songTitle || r.name)}">${escapeHtml(r.songTitle || r.name)}</h6>
                  <div class="small text-muted text-truncate" title="${escapeHtml(r.artist || 'Unknown Artist')} ${r.album ? `• ${escapeHtml(r.album)}` : ''}">${escapeHtml(r.artist || 'Unknown Artist')} ${r.album ? `• ${escapeHtml(r.album)}` : ''}</div>
                  <div class="d-flex align-items-center gap-2 mt-1 flex-wrap">
                    ${tunings.map(t => `<span class="badge badge-tuning">${escapeHtml(t)}</span>`).join('')}
                    <span class="small text-white-50" style="font-size:0.7rem;"><i class="bi-clock me-1"></i>${timeAgo}</span>
                  </div>
                </div>
              </div>

              <div class="d-flex align-items-center gap-2 flex-shrink-0 ms-2">
                <button class="btn btn-sm btn-theme-primary py-1 px-3 open-recent-btn" data-recent='${escapeHtml(JSON.stringify(r))}'>
                  <i class="bi-play-fill me-1"></i> Open
                </button>
              </div>
            </div>
            `;
        }).join('')}
      </div>
    </div>
    `;

    const clearBtn = container.querySelector('#clearRecentsBtn');
    clearBtn?.addEventListener('click', async () => {
        if (clearBtn.dataset.confirming === 'true') {
            await clearRecents();
            await renderRecentsView(container);
        } else {
            clearBtn.dataset.confirming = 'true';
            clearBtn.className = 'btn btn-sm btn-theme-danger p-1 px-2';
            clearBtn.innerHTML = '<i class="bi-exclamation-circle me-1"></i> Confirm Clear?';
            setTimeout(() => {
                if (clearBtn.dataset.confirming === 'true') {
                    clearBtn.dataset.confirming = 'false';
                    clearBtn.className = 'btn btn-sm btn-theme-icon p-1 px-2';
                    clearBtn.innerHTML = '<i class="bi-trash me-1"></i> Clear History';
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
                    closeLibraryModal();
                    await loadFile(stored.file);
                    return;
                }
            }
            showToast(`File "${r.name}" could not be restored from storage.`, 'warning');
        });
    });
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
