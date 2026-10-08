// libraryModal.js
// Artwork-rich MusicBrainz-powered Tab Library Modal aligned to themes.

import {
    getCollections, createCollection, deleteCollection, getLibraryHierarchy,
    getSongsByCollection, saveSongToLibrary, addAlbumToLibrary, deleteSongFromLibrary,
    getSongById, addTabOptionToSong, removeTabOptionFromSong, mapOpenFileToSong,
    getRecents, clearRecents, addRecentOpened, DEFAULT_COLLECTION_ID
} from './libraryStore.js';
import {
    searchMusicBrainz, getArtistAlbums, getAlbumTracks, getMusicianRelations,
    getCoverArtUrl, getPlaceholderCoverSvg
} from './musicbrainz.js';
import { getStoredFile, saveStoredFile } from './fileStore.js';
import { loadFile, getCurrentFile } from './main.js';
import { openFromProvider, getFileProviders } from './fileProviders.js';
import { extractScoreTunings, inferTuningFromTextOrName } from './utils/tuningUtils.js';

let activeView = 'library'; // 'library', 'search', 'recents', 'map'
let activeCollectionId = DEFAULT_COLLECTION_ID;
let selectedArtist = null;
let selectedAlbum = null;
let searchType = 'artist'; // 'artist', 'album', 'song', 'musician'
let currentSearchResults = [];
let searchSubView = null; // null | { type: 'albums', artistMbid, artistName } | { type: 'bands', musicianMbid, musicianName } | { type: 'tracks', releaseGroupMbid, parentView }
let viewHistory = [];
let searchHistory = [];
let isSearching = false;
let searchDebounceTimer = null;
let artistAlbumsCache = new Map();

/**
 * Check if the modal can go back
 */
export function canGoBack() {
    if (activeView === 'library' && (selectedArtist || selectedAlbum)) return true;
    if (activeView === 'search' && (searchSubView || searchHistory.length > 0)) return true;
    return viewHistory.length > 0;
}

/**
 * Unified back handler for library modal
 */
export async function handleBack() {
    const content = document.getElementById('libraryModalContent');
    if (activeView === 'library') {
        if (selectedAlbum) {
            selectedAlbum = null;
            await renderView();
            updateBackBtnVisibility();
            return;
        }
        if (selectedArtist) {
            selectedArtist = null;
            await renderView();
            updateBackBtnVisibility();
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
            updateBackBtnVisibility();
            return;
        }
        if (searchSubView) {
            searchSubView = null;
            const searchHeader = document.querySelector('.search-sticky-header');
            if (searchHeader) searchHeader.style.display = '';
            const resContainer = document.getElementById('mbSearchResultsContainer') || content;
            renderSearchResults(currentSearchResults, searchType, resContainer);
            updateBackBtnVisibility();
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
        }
    } else if (activeView === 'recents' || activeView === 'map') {
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
    const backBtn = document.getElementById('libraryModalBackBtn');
    if (backBtn) {
        backBtn.style.display = canGoBack() ? 'inline-flex' : 'none';
    }
}

/**
 * Open the Tab Library Modal
 */
export async function openLibraryModal(initialView = 'library') {
    if (initialView !== activeView) {
        viewHistory = [];
    }
    activeView = initialView;
    let modal = document.getElementById('libraryModal');
    if (!modal) {
        modal = createLibraryModalElement();
    }
    modal.style.display = 'flex';
    await renderLibraryModal();
}

/**
 * Close the Tab Library Modal
 */
export function closeLibraryModal() {
    const modal = document.getElementById('libraryModal');
    if (modal) modal.style.display = 'none';
}

/**
 * Create DOM element for Library Modal
 */
function createLibraryModalElement() {
    const modal = document.createElement('div');
    modal.id = 'libraryModal';
    modal.className = 'theme-modal-backdrop';
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeLibraryModal();
    });

    return modal;
}

/**
 * Main render function
 */
export async function renderLibraryModal() {
    const modal = document.getElementById('libraryModal');
    if (!modal) return;

    const collections = await getCollections();
    const currentCollection = collections.find(c => c.id === activeCollectionId) || collections[0] || { id: DEFAULT_COLLECTION_ID, name: 'My Library' };
    activeCollectionId = currentCollection.id;

    const currentOpen = getCurrentFile();
    const showBack = canGoBack();

    modal.innerHTML = `
    <div class="theme-modal-card library-modal-card">
      <!-- Modal Header -->
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          <button type="button" class="brand-btn theme-modal-back-btn p-1 px-2" id="libraryModalBackBtn" title="Go back" aria-label="Go back" style="${showBack ? 'display:inline-flex;' : 'display:none;'}">
            <i class="bi-arrow-left"></i>
          </button>
          <div class="brand-btn p-2" style="width: 36px; height: 36px;">
            <i class="bi-music-player-fill text-info"></i>
          </div>
          <div class="theme-modal-titles">
            <h6 class="mb-0 fw-bold text-white text-truncate">Tab Library</h6>
          </div>
        </div>

        <!-- Collections Selector & Actions -->
        <div class="theme-modal-actions">
          <div class="d-none d-md-flex align-items-center gap-1">
            <select class="form-select form-select-sm" id="libCollectionSelect" style="max-width: 160px; font-size: 0.78rem;">
              ${collections.map(c => `<option value="${c.id}" ${c.id === activeCollectionId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
            </select>
            <button class="btn btn-sm btn-theme-outline py-1 px-2" id="libNewCollectionBtn" title="New Collection">
              <i class="bi-folder-plus"></i>
            </button>
          </div>
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="libraryModalCloseBtn" aria-label="Close modal">
            <i class="bi-x-lg"></i>
          </button>
        </div>
      </div>

      <!-- Top Navigation Tabs (Library, Add to Library, Recents, Map Open File) -->
      <div class="library-nav-bar px-3 pt-2 border-bottom border-secondary-subtle d-flex align-items-center justify-content-between overflow-x-auto">
        <div class="hud-pill-group flex-nowrap" role="group">
          <button type="button" class="btn btn-sm ${activeView === 'library' ? 'active' : ''}" id="tabBtnLibrary">
            <i class="bi-collection-play me-1"></i> Library
          </button>
          <button type="button" class="btn btn-sm ${activeView === 'search' ? 'active' : ''}" id="tabBtnSearch">
            <i class="bi-plus-circle me-1"></i> Add to Library
          </button>
          <button type="button" class="btn btn-sm ${activeView === 'recents' ? 'active' : ''}" id="tabBtnRecents">
            <i class="bi-clock-history me-1"></i> Recents
          </button>
          ${currentOpen ? `
            <button type="button" class="btn btn-sm ${activeView === 'map' ? 'active' : ''}" id="tabBtnMap">
              <i class="bi-link-45deg me-1"></i> Map Open File
            </button>
          ` : ''}
        </div>

        ${currentOpen && activeView !== 'map' ? `
          <button class="btn btn-sm btn-theme-outline py-0 px-2 d-none d-lg-flex align-items-center gap-1" id="quickMapFileBtn" style="font-size:0.75rem;" title="Map active file to a library song">
            <i class="bi-link-45deg text-info"></i> <span class="text-truncate" style="max-width:140px;">${escapeHtml(currentOpen.name)}</span>
          </button>
        ` : ''}
      </div>

      <!-- Modal Body Content -->
      <div class="theme-modal-body p-3" id="libraryModalContent">
        <!-- Injected dynamically -->
      </div>
    </div>
    `;

    // Event listeners
    modal.querySelector('#libraryModalBackBtn')?.addEventListener('click', handleBack);
    modal.querySelector('#libraryModalCloseBtn')?.addEventListener('click', closeLibraryModal);
    modal.querySelector('#tabBtnLibrary')?.addEventListener('click', () => switchView('library'));
    modal.querySelector('#tabBtnSearch')?.addEventListener('click', () => switchView('search'));
    modal.querySelector('#tabBtnRecents')?.addEventListener('click', () => switchView('recents'));
    modal.querySelector('#tabBtnMap')?.addEventListener('click', () => switchView('map'));
    modal.querySelector('#quickMapFileBtn')?.addEventListener('click', () => switchView('map'));

    const collectionSelect = modal.querySelector('#libCollectionSelect');
    collectionSelect?.addEventListener('change', (e) => {
        activeCollectionId = e.target.value;
        selectedArtist = null;
        selectedAlbum = null;
        renderView();
    });

    modal.querySelector('#libNewCollectionBtn')?.addEventListener('click', async () => {
        const name = prompt('Enter name for new collection:');
        if (name && name.trim()) {
            const col = await createCollection(name.trim());
            activeCollectionId = col.id;
            await renderLibraryModal();
        }
    });

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
    if (view === 'library') {
        // Keep current selectedArtist / album unless switching from another tab
    }
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
    } else if (activeView === 'map') {
        await renderMapFileView(content);
    }
}

// -----------------------------------------------------------------------------
// 1. LIBRARY BROWSER VIEW (Collection > Artist > Album > Song)
// -----------------------------------------------------------------------------
async function renderLibraryBrowseView(container) {
    const hierarchy = await getLibraryHierarchy(activeCollectionId);
    const artists = hierarchy.artists || [];

    if (artists.length === 0) {
        container.innerHTML = `
        <div class="text-center py-5 text-muted">
          <i class="bi-music-note-list fs-1 mb-2 d-block text-white-50"></i>
          <h6 class="text-white fw-semibold">Your Library is Empty</h6>
          <p class="small text-muted mb-3">Add your favorite artists, albums, and songs to your library, or map your open files.</p>
          <div class="d-flex justify-content-center gap-2">
            <button class="btn btn-theme-primary btn-sm px-3" onclick="document.getElementById('tabBtnSearch').click()">
              <i class="bi-plus-circle me-1"></i> Add to Library
            </button>
          </div>
        </div>
        `;
        return;
    }

    // Breadcrumb Navigation
    let breadcrumbHtml = `
      <div class="library-sticky-breadcrumbs d-flex align-items-center justify-content-between mb-3 pb-2 border-bottom border-secondary-subtle">
        <div class="d-flex align-items-center gap-1.5 small overflow-x-auto">
          <button class="theme-breadcrumb-btn ${!selectedArtist ? 'active' : ''}" id="bcRoot">
            <i class="bi-collection me-1"></i> All Artists (${artists.length})
          </button>
          ${selectedArtist ? `
            <i class="bi-chevron-right text-muted" style="font-size:0.7rem;"></i>
            <button class="theme-breadcrumb-btn ${!selectedAlbum ? 'active' : ''}" id="bcArtist">
              ${escapeHtml(selectedArtist.name)}
            </button>
          ` : ''}
          ${selectedAlbum ? `
            <i class="bi-chevron-right text-muted" style="font-size:0.7rem;"></i>
            <span class="theme-breadcrumb-btn active">${escapeHtml(selectedAlbum.title)}</span>
          ` : ''}
        </div>
        <div class="d-flex align-items-center gap-2">
          <input type="text" class="form-control form-control-sm" id="libFilterInput" placeholder="Filter songs..." style="max-width: 180px; font-size: 0.75rem;">
        </div>
      </div>
    `;

    let bodyHtml = '';

    if (!selectedArtist) {
        // Render Artists Grid
        bodyHtml = `
        <div class="library-artists-grid">
          ${artists.map(artist => {
            const albumCount = artist.albums.length;
            const songCount = artist.albums.reduce((acc, a) => acc + a.songs.length, 0);
            const firstCover = artist.albums.find(a => a.coverUrl)?.coverUrl || getPlaceholderCoverSvg(artist.name);

            return `
            <div class="library-card artist-card p-3" data-artist-name="${escapeHtml(artist.name)}">
              <div class="d-flex align-items-center gap-3">
                <img src="${firstCover}" class="artist-thumbnail" alt="${escapeHtml(artist.name)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(artist.name)}'">
                <div class="min-w-0 flex-grow-1">
                  <h6 class="mb-1 fw-bold text-white text-truncate">${escapeHtml(artist.name)}</h6>
                  <div class="small text-muted">${albumCount} ${albumCount === 1 ? 'Album' : 'Albums'} • ${songCount} ${songCount === 1 ? 'Song' : 'Songs'}</div>
                </div>
                <i class="bi-chevron-right text-muted"></i>
              </div>
            </div>
            `;
        }).join('')}
        </div>
        `;
    } else if (!selectedAlbum) {
        // Render Albums Grid for selected artist
        const artist = artists.find(a => a.name === selectedArtist.name) || selectedArtist;
        bodyHtml = `
        <div class="library-albums-grid">
          ${artist.albums.map(album => {
            const cover = album.coverUrl || getPlaceholderCoverSvg(album.title);
            const songCount = album.songs.length;
            return `
            <div class="library-card album-card p-3" data-album-title="${escapeHtml(album.title)}">
              <div class="album-cover-container mb-2 position-relative">
                <img src="${cover}" class="album-cover-img w-100" alt="${escapeHtml(album.title)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(album.title)}'">
                ${album.year ? `<span class="badge badge-theme-year position-absolute bottom-0 end-0 m-1.5">${album.year}</span>` : ''}
              </div>
              <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(album.title)}">${escapeHtml(album.title)}</h6>
              <div class="small text-muted text-truncate">${songCount} ${songCount === 1 ? 'Song' : 'Songs'}</div>
            </div>
            `;
        }).join('')}
        </div>
        `;
    } else {
        // Render Songs List for selected album
        const album = selectedAlbum;
        const cover = album.coverUrl || getPlaceholderCoverSvg(album.title);
        bodyHtml = `
        <div class="album-detail-view">
          <div class="library-album-banner d-flex align-items-center gap-3 mb-3">
            <img src="${cover}" class="album-cover-banner" alt="${escapeHtml(album.title)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(album.title)}'">
            <div class="min-w-0 flex-grow-1">
              <span class="badge badge-theme-primary mb-1" style="font-size:0.68rem;">Album</span>
              <h5 class="mb-0 fw-bold text-white text-truncate">${escapeHtml(album.title)}</h5>
              <div class="small text-muted">${escapeHtml(selectedArtist.name)} ${album.year ? `• ${album.year}` : ''} • ${album.songs.length} Tracks</div>
            </div>
          </div>

          <!-- Songs List -->
          <div class="library-songs-list d-flex flex-column gap-2" id="libSongsList">
            ${album.songs.map(song => renderSongRow(song)).join('')}
          </div>
        </div>
        `;
    }

    container.innerHTML = breadcrumbHtml + bodyHtml;

    // Breadcrumb clicks
    container.querySelector('#bcRoot')?.addEventListener('click', () => {
        selectedArtist = null;
        selectedAlbum = null;
        renderLibraryBrowseView(container);
        updateBackBtnVisibility();
    });
    container.querySelector('#bcArtist')?.addEventListener('click', () => {
        selectedAlbum = null;
        renderLibraryBrowseView(container);
        updateBackBtnVisibility();
    });

    // Artist click
    container.querySelectorAll('.artist-card').forEach(card => {
        card.addEventListener('click', () => {
            const artistName = card.dataset.artistName;
            selectedArtist = artists.find(a => a.name === artistName);
            selectedAlbum = null;
            renderLibraryBrowseView(container);
            updateBackBtnVisibility();
        });
    });

    // Album click
    container.querySelectorAll('.album-card').forEach(card => {
        card.addEventListener('click', () => {
            const albumTitle = card.dataset.albumTitle;
            selectedAlbum = selectedArtist?.albums.find(a => a.title === albumTitle);
            renderLibraryBrowseView(container);
            updateBackBtnVisibility();
        });
    });

    // Filter input
    const filterInput = container.querySelector('#libFilterInput');
    filterInput?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        container.querySelectorAll('.library-song-row').forEach(row => {
            const title = (row.dataset.songTitle || '').toLowerCase();
            row.style.display = title.includes(query) ? '' : 'none';
        });
    });

    // Song actions: Play tab, Import tab, Delete song, Switch tabs
    setupSongRowActions(container);
}

function renderSongRow(song) {
    const tabOptions = Array.isArray(song.tabOptions) ? song.tabOptions : [];
    const hasTabs = tabOptions.length > 0;
    const tunings = Array.isArray(song.tunings) ? song.tunings : [];

    return `
    <div class="library-song-row p-2.5 d-flex flex-column gap-2" data-song-id="${song.id}" data-song-title="${escapeHtml(song.title)}">
      <div class="d-flex align-items-center justify-content-between gap-2">
        <div class="d-flex align-items-center gap-2.5 min-w-0 flex-grow-1">
          <span class="badge-track-num">${song.trackNumber || '•'}</span>
          <div class="min-w-0">
            <span class="fw-semibold text-white text-truncate d-block">${escapeHtml(song.title)}</span>
            <div class="d-flex align-items-center gap-1.5 flex-wrap mt-0.5">
              ${tunings.map(t => `<span class="badge badge-tuning">${escapeHtml(t)}</span>`).join('')}
              ${hasTabs ? `<span class="badge badge-has-tabs"><i class="bi-file-earmark-music me-1 text-info"></i>${tabOptions.length} ${tabOptions.length === 1 ? 'tab' : 'tabs'}</span>` : '<span class="badge badge-no-tab"><i class="bi-exclamation-circle me-1"></i>No tab attached</span>'}
            </div>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="d-flex align-items-center gap-1.5 flex-shrink-0">
          ${hasTabs ? `
            <button class="btn btn-sm btn-theme-primary py-1 px-2.5 d-flex align-items-center gap-1 play-default-tab-btn" data-song-id="${song.id}" title="Play Tab">
              <i class="bi-play-fill"></i> <span class="d-none d-sm-inline">Play</span>
            </button>
          ` : ''}

          <!-- Import / Download Tab Dropdown -->
          <div class="dropdown">
            <button class="btn btn-sm btn-theme-outline py-1 px-2 dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="Import Tab">
              <i class="bi-plus-lg me-1"></i> Tab
            </button>
            <ul class="dropdown-menu dropdown-menu-end theme-dropdown-menu">
              <li><button class="dropdown-item small import-tab-provider-btn" data-song-id="${song.id}" data-provider-id="tab-downloader"><i class="bi-cloud-arrow-down me-2 text-info"></i> Tab Downloader</button></li>
              <li><button class="dropdown-item small import-tab-provider-btn" data-song-id="${song.id}" data-provider-id="local"><i class="bi-folder2-open me-2 text-primary"></i> Local Device</button></li>
              <li><button class="dropdown-item small import-tab-provider-btn" data-song-id="${song.id}" data-provider-id="google-drive"><i class="bi-google me-2 text-danger"></i> Google Drive</button></li>
            </ul>
          </div>

          <!-- Song options dropdown (Delete, etc.) -->
          <button class="btn btn-sm btn-theme-icon p-1 px-1.5 delete-song-btn" data-song-id="${song.id}" title="Remove song from library">
            <i class="bi-trash"></i>
          </button>
        </div>
      </div>

      <!-- Multiple Tab Options List (if has tabs) -->
      ${hasTabs ? `
        <div class="tab-options-container ps-4 pt-1 border-top border-secondary-subtle d-flex flex-wrap align-items-center gap-1.5">
          <span class="small text-muted" style="font-size: 0.7rem;">Tabs:</span>
          ${tabOptions.map(t => `
            <div class="tab-option-chip">
              <span class="text-truncate" style="max-width: 140px;" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
              ${t.tuning ? `<span class="badge badge-theme-secondary py-0 px-1" style="font-size:0.6rem;">${escapeHtml(t.tuning)}</span>` : ''}
              <button class="btn btn-link p-0 text-info play-tab-chip-btn" data-song-id="${song.id}" data-tab-id="${t.id}" title="Load this tab"><i class="bi-play-circle-fill"></i></button>
              <button class="btn btn-link p-0 text-muted remove-tab-chip-btn" data-song-id="${song.id}" data-tab-id="${t.id}" title="Remove tab"><i class="bi-x"></i></button>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
    `;
}

function setupSongRowActions(container) {
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
            if (confirm('Remove this tab option?')) {
                await removeTabOptionFromSong(songId, tabId);
                await renderView();
            }
        });
    });

    // Delete song from library
    container.querySelectorAll('.delete-song-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const songId = btn.dataset.songId;
            if (confirm('Delete this song from library?')) {
                await deleteSongFromLibrary(songId);
                await renderView();
            }
        });
    });

    // Import Tab with Provider (feeds search query based on song name + artist!)
    container.querySelectorAll('.import-tab-provider-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const songId = btn.dataset.songId;
            const providerId = btn.dataset.providerId;
            const song = await getSongById(songId);
            if (!song) return;

            // Target provider ID: 'local', 'google-drive', 'tab-downloader' (or 'tab-downloader-web')
            const targetProviderId = (providerId === 'tab-downloader' && !window.__TAURI__) ? 'tab-downloader-web' : providerId;

            closeLibraryModal();
            await openFromProvider(targetProviderId, {
                songId: song.id,
                targetSong: song,
                songName: song.title,
                artist: song.artist,
                query: `${song.artist} ${song.title}`
            });
        });
    });
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
            // Prompt re-download or re-import
            alert(`Tab file not found locally. Please re-import tab for ${song.title}.`);
        }
    } catch (err) {
        console.error('Failed to load song tab:', err);
        alert(`Error opening tab: ${err.message}`);
    }
}

// -----------------------------------------------------------------------------
// 2. SEARCH & ADD TO LIBRARY VIEW (Artist, Album, Song, Musician)
// -----------------------------------------------------------------------------
function renderSearchMusicBrainzView(container) {
    container.innerHTML = `
    <div class="search-mb-view">
      <!-- Search Input & Type Selector (Sticky Header) -->
      <div class="search-sticky-header mb-3">
        <div class="d-flex align-items-center justify-content-between mb-2">
          <label class="form-label small fw-semibold text-white-50 mb-0">Search by:</label>
          <div class="hud-pill-group" role="group" id="searchTypePill">
            <button type="button" class="btn btn-sm ${searchType === 'artist' ? 'active' : ''}" data-type="artist">Artist</button>
            <button type="button" class="btn btn-sm ${searchType === 'album' ? 'active' : ''}" data-type="album">Album</button>
            <button type="button" class="btn btn-sm ${searchType === 'song' ? 'active' : ''}" data-type="song">Song</button>
            <button type="button" class="btn btn-sm ${searchType === 'musician' ? 'active' : ''}" data-type="musician">Musician</button>
          </div>
        </div>

        <form id="mbSearchForm" class="d-flex align-items-center gap-2">
          <div class="input-group input-group-sm flex-grow-1">
            <span class="input-group-text"><i class="bi-search"></i></span>
            <input type="text" class="form-control" id="mbSearchInput" placeholder="Search ${searchType}..." autofocus>
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
          <div>Search across artists, albums, and songs to add to your library</div>
        </div>
      </div>
    </div>
    `;

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
        const results = await searchMusicBrainz(query, type);
        currentSearchResults = results;
        renderSearchResults(results, type, resultsContainer);
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
            <div class="library-row-card d-flex align-items-center justify-content-between gap-2">
              <div class="min-w-0">
                <h6 class="mb-0 fw-bold text-white text-truncate">${escapeHtml(a.name)}</h6>
                <div class="small text-muted">${a.type || 'Artist'} • ${a.country || 'International'} ${a.lifeSpan ? `• ${a.lifeSpan}` : ''}</div>
                ${a.disambiguation ? `<div class="small text-white-50 text-truncate" style="font-size:0.75rem;">${escapeHtml(a.disambiguation)}</div>` : ''}
              </div>
              <div class="d-flex align-items-center gap-1.5 flex-shrink-0">
                ${type === 'artist' ? `
                  <button class="btn btn-sm btn-theme-primary add-artist-btn" data-artist-id="${a.id}" data-artist-name="${escapeHtml(a.name)}" title="Add all albums and songs by this artist">
                    <i class="bi-plus-circle me-1"></i> Add Artist
                  </button>
                ` : ''}
                <button class="btn btn-sm btn-theme-outline explore-artist-btn" data-artist-id="${a.id}" data-artist-name="${escapeHtml(a.name)}" data-is-musician="${type === 'musician'}">
                  <i class="bi-${type === 'musician' ? 'people' : 'disc'} me-1"></i> ${type === 'musician' ? 'View Bands' : 'Browse Albums'}
                </button>
              </div>
            </div>
          `).join('')}
        </div>
        `;

        container.querySelectorAll('.add-artist-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await handleAddArtist(btn.dataset.artistId, btn.dataset.artistName, btn);
            });
        });

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
              <div class="small text-muted text-truncate">${escapeHtml(rg.artist)} ${rg.year ? `• ${rg.year}` : ''}</div>
              <div class="d-flex gap-1.5 mt-2">
                <button class="btn btn-sm btn-theme-primary flex-grow-1 add-album-btn" data-rg-id="${rg.id}" data-rg-title="${escapeHtml(rg.title)}">
                  <i class="bi-plus-lg me-1"></i> Add Album
                </button>
                <button class="btn btn-sm btn-theme-outline view-album-tracks-btn px-2" data-rg-id="${rg.id}" title="View Tracks">
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
                <h6 class="mb-0 fw-bold text-white text-truncate">${escapeHtml(song.title)}</h6>
                <div class="small text-muted">${escapeHtml(song.artist)} • ${escapeHtml(song.album || 'Single')} ${song.year ? `• ${song.year}` : ''}</div>
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
 * Recursively add an artist and all of their albums and songs into the library
 */
async function handleAddArtist(artistMbid, artistName, btn) {
    if (!btn || btn.disabled) return;
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status"></span> Loading albums...';

    try {
        const albums = await getArtistAlbums(artistMbid);
        if (!albums || albums.length === 0) {
            btn.innerHTML = '<i class="bi-exclamation-circle me-1"></i> No albums found';
            setTimeout(() => { btn.innerHTML = origHtml; btn.disabled = false; }, 3000);
            return;
        }

        let totalSongsAdded = 0;
        for (let i = 0; i < albums.length; i++) {
            const alb = albums[i];
            btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status"></span> Adding (${i + 1}/${albums.length})...`;
            try {
                const albumData = await getAlbumTracks(alb.id);
                if (albumData && albumData.tracks?.length > 0) {
                    const added = await addAlbumToLibrary(albumData, albumData.tracks, activeCollectionId);
                    totalSongsAdded += added.length;
                }
            } catch (err) {
                console.warn(`Failed to fetch tracks for album "${alb.title}":`, err);
            }
        }

        btn.className = 'btn btn-sm btn-theme-success flex-shrink-0 disabled';
        btn.innerHTML = `<i class="bi-check-lg me-1"></i> Added (${totalSongsAdded} songs)`;
    } catch (err) {
        console.error('Failed to add artist:', err);
        btn.className = 'btn btn-sm btn-theme-danger flex-shrink-0';
        btn.innerHTML = '<i class="bi-exclamation-circle me-1"></i> Failed';
        setTimeout(() => { btn.innerHTML = origHtml; btn.disabled = false; }, 3000);
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
        btn.innerHTML = '<i class="bi-exclamation-circle me-1"></i> Failed';
        setTimeout(() => { btn.innerHTML = origHtml; btn.disabled = false; }, 3000);
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
      <div>Loading albums for ${escapeHtml(artistName)}...</div>
    </div>
    `;

    try {
        const albums = await getArtistAlbums(artistMbid);
        if (albums.length === 0) {
            container.innerHTML = `
            <div class="mb-3">
              <button class="btn btn-sm btn-theme-outline" id="backToSearchResultsBtn">
                <i class="bi-arrow-left me-1"></i> Back to Search
              </button>
            </div>
            <div class="text-center py-4 text-muted">No albums found for ${escapeHtml(artistName)}.</div>`;
            container.querySelector('#backToSearchResultsBtn')?.addEventListener('click', handleBack);
            return;
        }

        container.innerHTML = `
        <div class="library-sticky-breadcrumbs mb-3 d-flex align-items-center justify-content-between flex-wrap gap-2 pb-2 border-bottom border-secondary-subtle">
          <button class="btn btn-sm btn-theme-outline" id="backToSearchResultsBtn">
            <i class="bi-arrow-left me-1"></i> Back to Search
          </button>
          <div class="d-flex align-items-center gap-2">
            <h6 class="mb-0 fw-bold text-white">${escapeHtml(artistName)} (${albums.length} Albums)</h6>
            <button class="btn btn-sm btn-theme-primary add-artist-btn" data-artist-id="${artistMbid}" data-artist-name="${escapeHtml(artistName)}" title="Add all albums and songs by this artist">
              <i class="bi-plus-circle me-1"></i> Add All Albums
            </button>
          </div>
        </div>
        <div class="library-albums-grid">
          ${albums.map(a => `
            <div class="library-card album-card p-3">
              <img src="${a.coverUrl || getPlaceholderCoverSvg(a.title)}" class="album-cover-img w-100 mb-2" alt="${escapeHtml(a.title)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(a.title)}'">
              <h6 class="mb-0 fw-bold text-white text-truncate" title="${escapeHtml(a.title)}">${escapeHtml(a.title)}</h6>
              <div class="small text-muted">${a.year || 'Album'}</div>
              <div class="d-flex gap-1.5 mt-2">
                <button class="btn btn-sm btn-theme-primary flex-grow-1 add-album-btn" data-rg-id="${a.id}" data-rg-title="${escapeHtml(a.title)}">
                  <i class="bi-plus-lg me-1"></i> Add Album
                </button>
                <button class="btn btn-sm btn-theme-outline view-album-tracks-btn px-2" data-rg-id="${a.id}" title="View Tracks">
                  <i class="bi-music-note-list"></i>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
        `;

        container.querySelector('#backToSearchResultsBtn')?.addEventListener('click', handleBack);

        container.querySelectorAll('.add-artist-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await handleAddArtist(btn.dataset.artistId, btn.dataset.artistName, btn);
            });
        });

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
    updateBackBtnVisibility();

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
              <button class="btn btn-sm btn-theme-outline" id="backToSearchResultsBtn">
                <i class="bi-arrow-left me-1"></i> Back to Search
              </button>
            </div>
            <div class="text-center py-4 text-muted">No associated bands found for ${escapeHtml(musicianName)}.</div>`;
            container.querySelector('#backToSearchResultsBtn')?.addEventListener('click', handleBack);
            return;
        }

        container.innerHTML = `
        <div class="library-sticky-breadcrumbs mb-3 d-flex align-items-center justify-content-between pb-2 border-bottom border-secondary-subtle">
          <button class="btn btn-sm btn-theme-outline" id="backToSearchResultsBtn">
            <i class="bi-arrow-left me-1"></i> Back to Search
          </button>
          <h6 class="mb-0 fw-bold text-white">${escapeHtml(musicianName)} — Associated Bands</h6>
        </div>
        <div class="d-flex flex-column gap-2">
          ${bands.map(b => `
            <div class="library-row-card d-flex align-items-center justify-content-between gap-2">
              <div class="min-w-0">
                <h6 class="mb-0 fw-bold text-white text-truncate">${escapeHtml(b.name)}</h6>
                <div class="small text-muted">${b.role ? escapeHtml(b.role) : 'Band Member'}</div>
              </div>
              <button class="btn btn-sm btn-theme-outline flex-shrink-0 explore-band-albums-btn" data-band-id="${b.id}" data-band-name="${escapeHtml(b.name)}">
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
    updateBackBtnVisibility();

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
              <button class="btn btn-sm btn-theme-outline" id="backToAlbumsListBtn">
                <i class="bi-arrow-left me-1"></i> Back
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
            <button class="btn btn-sm btn-theme-outline" id="backToAlbumsListBtn">
              <i class="bi-arrow-left me-1"></i> Back
            </button>
            <button class="btn btn-sm btn-theme-primary px-3" id="addAllAlbumTracksBtn">
              <i class="bi-plus-circle me-1"></i> Add Full Album to Library
            </button>
          </div>

          <div class="library-album-banner d-flex align-items-center gap-3 mb-3">
            <img src="${cover}" class="album-cover-banner" alt="${escapeHtml(albumData.title)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(albumData.title)}'">
            <div class="min-w-0 flex-grow-1">
              <span class="badge badge-theme-success mb-1" style="font-size:0.68rem;">US Release (${albumData.country})</span>
              <h5 class="mb-0 fw-bold text-white text-truncate">${escapeHtml(albumData.title)}</h5>
              <div class="small text-muted">${escapeHtml(albumData.artist)} ${albumData.year ? `• ${albumData.year}` : ''} • ${albumData.tracks.length} Tracks</div>
            </div>
          </div>

          <!-- Tracks Checklist -->
          <div class="d-flex flex-column gap-1.5" id="albumTracksChecklist">
            ${albumData.tracks.map((t, idx) => `
              <div class="library-track-row p-2 d-flex align-items-center justify-content-between gap-2">
                <div class="d-flex align-items-center gap-2.5 min-w-0">
                  <span class="badge-track-num">${t.trackNumber || idx + 1}</span>
                  <span class="text-white text-truncate fw-semibold">${escapeHtml(t.title)}</span>
                </div>
                <button class="btn btn-sm btn-theme-outline py-0.5 px-2 add-single-track-btn" data-track-idx="${idx}">
                  <i class="bi-plus"></i> Add
                </button>
              </div>
            `).join('')}
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
                    albumMbid: albumData.releaseGroupId,
                    year: albumData.year,
                    trackNumber: track.trackNumber,
                    recordingMbid: track.recordingMbid,
                    coverUrl: albumData.coverUrl
                };
                await saveSongToLibrary(song, activeCollectionId);
                btn.className = 'btn btn-sm btn-theme-success py-0.5 px-2 disabled';
                btn.innerHTML = '<i class="bi-check"></i> Added';
            });
        });
    } catch (err) {
        container.innerHTML = `<div class="text-danger">Failed to load tracklist: ${escapeHtml(err.message)}</div>`;
    }
}

// -----------------------------------------------------------------------------
// 3. RECENTS VIEW (Enriched with Library & Metadata)
// -----------------------------------------------------------------------------
async function renderRecentsView(container) {
    const recents = await getRecents(40);

    if (recents.length === 0) {
        container.innerHTML = `
        <div class="text-center py-5 text-muted">
          <i class="bi-clock-history fs-1 mb-2 d-block text-white-50"></i>
          <h6 class="text-white fw-semibold">No Recent Files</h6>
          <p class="small text-muted">Files and tabs you open will appear here with rich metadata and artwork.</p>
        </div>
        `;
        return;
    }

    container.innerHTML = `
    <div class="recents-view">
      <div class="d-flex align-items-center justify-content-between mb-3 pb-2 border-bottom border-secondary-subtle">
        <span class="small text-white-50">Recently Opened (${recents.length})</span>
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
                <img src="${cover}" class="rounded-2" style="width: 48px; height: 48px; object-fit: cover; border: 1px solid var(--border-subtle);" alt="${escapeHtml(r.songTitle || r.name)}" onerror="this.onerror=null; this.src='${getPlaceholderCoverSvg(r.songTitle || r.name)}'">
                <div class="min-w-0">
                  <h6 class="mb-0.5 fw-bold text-white text-truncate">${escapeHtml(r.songTitle || r.name)}</h6>
                  <div class="small text-muted text-truncate">${escapeHtml(r.artist || 'Unknown Artist')} ${r.album ? `• ${escapeHtml(r.album)}` : ''}</div>
                  <div class="d-flex align-items-center gap-1.5 mt-1 flex-wrap">
                    ${tunings.map(t => `<span class="badge badge-tuning">${escapeHtml(t)}</span>`).join('')}
                    <span class="small text-white-50" style="font-size:0.7rem;"><i class="bi-clock me-1"></i>${timeAgo}</span>
                  </div>
                </div>
              </div>

              <div class="d-flex align-items-center gap-2 flex-shrink-0">
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

    container.querySelector('#clearRecentsBtn')?.addEventListener('click', async () => {
        if (confirm('Clear all recent files history?')) {
            await clearRecents();
            await renderRecentsView(container);
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
            alert(`File "${r.name}" could not be restored from storage.`);
        });
    });
}

// -----------------------------------------------------------------------------
// 4. MAP OPEN FILE VIEW
// -----------------------------------------------------------------------------
async function renderMapFileView(container) {
    const currentOpen = getCurrentFile();
    if (!currentOpen) {
        container.innerHTML = `
        <div class="text-center py-5 text-muted">
          <i class="bi-link-45deg fs-1 mb-2 d-block text-white-50"></i>
          <div>No file is currently loaded in MajesticTab.</div>
        </div>
        `;
        return;
    }

    const songs = await getSongsByCollection(activeCollectionId);
    const inferredTuning = inferTuningFromTextOrName(currentOpen.name);

    container.innerHTML = `
    <div class="map-file-view">
      <div class="library-album-banner mb-3">
        <span class="badge badge-theme-info mb-1">Active Loaded File</span>
        <h5 class="mb-1 fw-bold text-white text-truncate">${escapeHtml(currentOpen.name)}</h5>
        <div class="small text-muted">Detected Tuning: <strong class="text-accent">${inferredTuning || 'Standard'}</strong> • Size: ${(currentOpen.size / 1024).toFixed(1)} KB</div>
      </div>

      <h6 class="mb-2 fw-semibold text-white">Select a Library Song to Map this File To:</h6>
      <div class="input-group input-group-sm mb-3">
        <span class="input-group-text"><i class="bi-search"></i></span>
        <input type="text" class="form-control" id="mapSearchFilter" placeholder="Filter library songs...">
      </div>

      <div class="d-flex flex-column gap-2" style="max-height: 320px; overflow-y: auto;" id="mapSongsList">
        ${songs.length === 0 ? '<div class="text-muted small">No songs in library. Add music from the Add to Library tab first.</div>' : ''}
        ${songs.map(song => `
          <div class="library-row-card map-song-target-row d-flex align-items-center justify-content-between gap-2" data-song-id="${song.id}" data-song-title="${escapeHtml(song.title)}">
            <div class="min-w-0">
              <h6 class="mb-0 fw-bold text-white text-truncate">${escapeHtml(song.title)}</h6>
              <div class="small text-muted">${escapeHtml(song.artist)} • ${escapeHtml(song.album)}</div>
            </div>
            <button class="btn btn-sm btn-theme-primary py-1 px-3 select-map-target-btn" data-song-id="${song.id}">
              <i class="bi-link-45deg me-1"></i> Map Here
            </button>
          </div>
        `).join('')}
      </div>
    </div>
    `;

    container.querySelector('#mapSearchFilter')?.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase().trim();
        container.querySelectorAll('.map-song-target-row').forEach(row => {
            const title = (row.dataset.songTitle || '').toLowerCase();
            row.style.display = title.includes(q) ? '' : 'none';
        });
    });

    container.querySelectorAll('.select-map-target-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const songId = btn.dataset.songId;
            try {
                await mapOpenFileToSong(currentOpen, songId, currentOpen.name, 'local', currentOpen.name);
                alert(`Successfully mapped "${currentOpen.name}" to library song!`);
                switchView('library');
            } catch (err) {
                alert(`Mapping failed: ${err.message}`);
            }
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
