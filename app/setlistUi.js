// setlistUi.js
// Setlists library view, the "Add to Setlist" picker, and the notation-menu button.

import {
    getAllSetlists, getSetlist, createSetlist, renameSetlist, deleteSetlist,
    addToSetlist, removeFromSetlist, moveSetlistItem
} from './setlistStore.js';
import { getSongById, getAllSongs, getRecents } from './libraryStore.js';
import { getPlaceholderCoverSvg, hydrateCachedImages } from './musicbrainz.js';
import { playSetlist } from './setlistPlayer.js';
import { openThemedInputModal, libraryViewSwitchHtml, libraryHeaderHtml, libraryListToolbarHtml, libraryEmptyStateHtml, bindListFilter } from './libraryModal.js';
import { getCurrentFile } from './main.js';
import { requireSupporter } from './supporter.js';
import { showToast } from './utils/toast.js';
import { gamepadManager } from './utils/gamepadManager.js';

let isEditMode = false;
let selectedSetlistId = null;
let songSearchQuery = '';
let keepAddSongsOpen = false; // keep the search block after the first add to an empty setlist
const MAX_SEARCH_RESULTS = 25;

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function countLabel(n) {
    return `${n} ${n === 1 ? 'tab' : 'tabs'}`;
}

/** Two-click delete: first click arms the button, a second click within 4s confirms. */
function bindTwoClickDelete(btn, idleHtml, onConfirm) {
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (btn.dataset.confirming === 'true') {
            await onConfirm();
            return;
        }
        btn.dataset.confirming = 'true';
        btn.innerHTML = '<i class="bi-exclamation-triangle-fill me-1"></i> Confirm?';
        setTimeout(() => {
            if (btn.isConnected && btn.dataset.confirming === 'true') {
                btn.dataset.confirming = 'false';
                btn.innerHTML = idleHtml;
            }
        }, 4000);
    });
}

export async function renderSetlistsView(container, { onBack }) {
    if (selectedSetlistId && await getSetlist(selectedSetlistId)) {
        await renderSetlistDetail(container, onBack);
    } else {
        selectedSetlistId = null;
        await renderSetlistList(container, onBack);
    }
}

async function renderSetlistList(container, onBack) {
    const setlists = await getAllSetlists();
    const trashHtml = '<i class="bi-trash"></i>';

    container.innerHTML = `
    <div class="library-page-container setlists-view">
      ${libraryHeaderHtml({
          activeTab: 'setlists', searchId: 'setlistsFilterInput', clearId: 'setlistsFilterClearBtn',
          placeholder: 'Search setlists...', searchLabel: 'Search setlists', searchDisabled: setlists.length === 0
      })}

      ${setlists.length > 0 ? libraryListToolbarHtml({
          count: `${setlists.length} ${setlists.length === 1 ? 'setlist' : 'setlists'}`,
          actionsHtml: `
            <button class="btn btn-sm btn-theme-primary p-1 px-3 d-flex align-items-center gap-1" id="newSetlistBtn" title="Create a new setlist">
              <i class="bi-plus-lg"></i> <span>New Setlist</span>
            </button>
            <button class="btn btn-sm ${isEditMode ? 'btn-theme-primary' : 'btn-theme-outline'} p-1 px-3 d-flex align-items-center gap-1" id="toggleSetlistsEditBtn" title="${isEditMode ? 'Done editing' : 'Edit setlists'}">
              <i class="bi-${isEditMode ? 'check-lg' : 'pencil'}"></i> <span>${isEditMode ? 'Done' : 'Edit'}</span>
            </button>`
      }) : ''}

      ${setlists.length === 0 ? `
        ${libraryEmptyStateHtml({
          icon: 'bi-collection-play',
          title: 'No setlists yet',
          message: 'Create a setlist, then add songs from your library, recents or tunings, or from a tab\'s notation menu.',
          actionsHtml: `<button class="btn btn-sm btn-theme-primary px-4" id="newSetlistBtn"><i class="bi-plus-lg me-1"></i> New Setlist</button>`
        })}
      ` : `
        <div class="d-flex flex-column gap-2" id="setlistsList">
          ${setlists.map(sl => `
            <div class="library-row-card library-row-clickable d-flex align-items-center justify-content-between gap-3" data-setlist-id="${escapeHtml(sl.id)}" role="button" tabindex="0">
              <div class="d-flex align-items-center gap-3 min-w-0 flex-grow-1">
                <i class="bi-collection-play text-info fs-4 flex-shrink-0"></i>
                <div class="min-w-0">
                  <h6 class="mb-1 fw-bold text-white text-truncate">${escapeHtml(sl.name)}</h6>
                  <div class="small text-muted">${countLabel(sl.items.length)}</div>
                </div>
              </div>
              <div class="d-flex align-items-center gap-2 flex-shrink-0 ms-2">
                ${isEditMode ? `
                  <button class="btn btn-sm theme-control-btn p-1 px-2 rename-setlist-btn" data-setlist-id="${escapeHtml(sl.id)}" title="Rename setlist"><i class="bi-pencil"></i></button>
                  <button class="btn btn-sm btn-theme-danger p-1 px-2 delete-setlist-btn" data-setlist-id="${escapeHtml(sl.id)}" title="Delete setlist">${trashHtml}</button>
                ` : `<i class="bi-chevron-right text-white-50"></i>`}
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>`;

    const rerender = () => renderSetlistList(container, onBack);

    bindListFilter(container, { inputId: 'setlistsFilterInput', clearId: 'setlistsFilterClearBtn', rowSelector: '#setlistsList .library-row-card' });

    container.querySelector('#toggleSetlistsEditBtn')?.addEventListener('click', () => {
        if (!isEditMode && !requireSupporter('setlists')) return;
        isEditMode = !isEditMode;
        rerender();
    });
    container.querySelector('#newSetlistBtn')?.addEventListener('click', () => promptNewSetlist(async (sl) => {
        selectedSetlistId = sl.id;
        isEditMode = true;
        await renderSetlistDetail(container, onBack);
    }));

    container.querySelectorAll('.delete-setlist-btn').forEach(btn => {
        bindTwoClickDelete(btn, trashHtml, async () => {
            await deleteSetlist(btn.dataset.setlistId);
            showToast('Setlist deleted', 'info');
            if (isEditMode && (await getAllSetlists()).length === 0) isEditMode = false;
            rerender();
        });
    });
    container.querySelectorAll('.rename-setlist-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const sl = await getSetlist(btn.dataset.setlistId);
            if (sl) promptRenameSetlist(sl, rerender);
        });
    });

    container.querySelectorAll('#setlistsList .library-row-card').forEach(row => {
        const open = async () => {
            if (isEditMode) return;
            selectedSetlistId = row.dataset.setlistId;
            await renderSetlistDetail(container, onBack);
        };
        row.addEventListener('click', (e) => { if (!e.target.closest('button')) open(); });
        row.addEventListener('keydown', (e) => {
            if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                open();
            }
        });
    });

    gamepadManager.onLibraryViewRendered();
}

async function renderSetlistDetail(container, onBack) {
    const setlist = await getSetlist(selectedSetlistId);
    if (!setlist) {
        selectedSetlistId = null;
        return renderSetlistList(container, onBack);
    }
    const songs = await Promise.all(setlist.items.map(i => getSongById(i.songId)));
    const rerender = () => renderSetlistDetail(container, onBack);

    container.innerHTML = `
    <div class="library-page-container setlists-view">
      <div class="library-body-header d-flex align-items-center justify-content-between mb-3">
        <div class="d-flex align-items-center gap-3 min-w-0">
          <button class="btn btn-sm btn-theme-outline lib-open-file-btn flex-shrink-0" id="setlistsBackBtn" title="Back to all setlists">
            <i class="bi-chevron-left"></i> <span>Setlists</span>
          </button>
          <span class="small fw-semibold text-white text-truncate"><i class="bi-collection-play me-2 text-info"></i>${escapeHtml(setlist.name)}</span>
          <span class="badge badge-theme-secondary py-1 px-2 flex-shrink-0" style="font-size: 0.72rem;">${countLabel(setlist.items.length)}</span>
        </div>
        <div class="d-flex align-items-center gap-2 flex-shrink-0">
          ${isEditMode ? `
            <button class="btn btn-sm theme-control-btn p-1 px-3 d-flex align-items-center gap-1" id="renameSetlistBtn" title="Rename setlist">
              <i class="bi-pencil"></i> <span>Rename</span>
            </button>
          ` : (setlist.items.length > 0 ? `
            <button class="btn btn-sm btn-theme-primary p-1 px-3 d-flex align-items-center gap-1" id="playSetlistBtn" title="Play setlist from the first tab">
              <i class="bi-play-fill"></i> <span>Play</span>
            </button>
          ` : '')}
          <button class="btn btn-sm ${isEditMode ? 'btn-theme-primary' : 'btn-theme-outline'} p-1 px-3 d-flex align-items-center gap-1" id="toggleSetlistEditBtn" title="${isEditMode ? 'Done editing' : 'Edit setlist'}">
            <i class="bi-${isEditMode ? 'check-lg' : 'pencil'}"></i> <span>${isEditMode ? 'Done' : 'Edit'}</span>
          </button>
        </div>
      </div>

      ${(isEditMode || keepAddSongsOpen || setlist.items.length === 0) ? `
        <div class="setlist-add-songs mb-3">
          <div class="small fw-semibold text-white-50 mb-2">${setlist.items.length === 0 ? 'This setlist is empty. Search your library to add songs.' : 'Add songs'}</div>
          <div class="library-search-bar mb-2">
            <i class="bi-search search-icon"></i>
            <input type="text" class="search-input" id="setlistSongSearch" placeholder="Search songs with tabs..." value="${escapeHtml(songSearchQuery)}" autocomplete="off" spellcheck="false" aria-label="Search songs to add">
          </div>
          <div class="d-flex flex-column gap-2" id="setlistSongResults"></div>
        </div>
      ` : ''}
      ${setlist.items.length === 0 ? '' : `
        <div class="d-flex flex-column gap-2" id="setlistItems">
          ${setlist.items.map((item, idx) => {
              const song = songs[idx];
              const tab = song?.tabOptions?.find(t => t.id === item.tabId);
              const cover = song?.coverUrl || getPlaceholderCoverSvg(song?.title || 'Missing');
              return `
              <div class="library-row-card d-flex align-items-center justify-content-between gap-3 ${isEditMode ? '' : 'library-row-clickable'}" data-item-id="${escapeHtml(item.id)}" data-index="${idx}" role="button" tabindex="0">
                <div class="d-flex align-items-center gap-3 min-w-0 flex-grow-1">
                  <span class="badge-track-num flex-shrink-0">${idx + 1}</span>
                  <img src="${cover}" class="artist-thumbnail flex-shrink-0" style="width: 44px; height: 44px;" alt="" draggable="false">
                  <div class="min-w-0 flex-grow-1">
                    <h6 class="mb-1 fw-bold text-white text-truncate">${escapeHtml(song?.title || 'Song removed from library')}</h6>
                    <div class="small text-muted text-truncate">${escapeHtml(song?.artist || '')}${tab ? ` • ${escapeHtml(tab.name)}` : ''}</div>
                  </div>
                </div>
                <div class="d-flex align-items-center gap-2 flex-shrink-0 ms-2">
                  ${isEditMode ? `
                    <button class="btn btn-sm btn-theme-icon p-1 px-2 move-item-btn" data-item-id="${escapeHtml(item.id)}" data-delta="-1" title="Move up" ${idx === 0 ? 'disabled' : ''}><i class="bi-arrow-up"></i></button>
                    <button class="btn btn-sm btn-theme-icon p-1 px-2 move-item-btn" data-item-id="${escapeHtml(item.id)}" data-delta="1" title="Move down" ${idx === setlist.items.length - 1 ? 'disabled' : ''}><i class="bi-arrow-down"></i></button>
                    <button class="btn btn-sm btn-theme-danger p-1 px-2 remove-item-btn" data-item-id="${escapeHtml(item.id)}" title="Remove from setlist"><i class="bi-x-lg"></i></button>
                  ` : `<i class="bi-play-fill text-white-50"></i>`}
                </div>
              </div>`;
          }).join('')}
        </div>
      `}
    </div>`;

    container.querySelector('#setlistsBackBtn')?.addEventListener('click', () => {
        selectedSetlistId = null;
        isEditMode = false;
        songSearchQuery = '';
        keepAddSongsOpen = false;
        renderSetlistList(container, onBack);
    });
    container.querySelector('#toggleSetlistEditBtn')?.addEventListener('click', () => {
        if (!isEditMode && !requireSupporter('setlists')) return;
        isEditMode = !isEditMode;
        keepAddSongsOpen = false;
        rerender();
    });
    container.querySelector('#renameSetlistBtn')?.addEventListener('click', () => promptRenameSetlist(setlist, rerender));
    container.querySelector('#playSetlistBtn')?.addEventListener('click', () => playSetlist(setlist.id, 0));

    container.querySelectorAll('.move-item-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            await moveSetlistItem(setlist.id, btn.dataset.itemId, Number(btn.dataset.delta));
            rerender();
        });
    });
    container.querySelectorAll('.remove-item-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            await removeFromSetlist(setlist.id, btn.dataset.itemId);
            rerender();
        });
    });
    if (!isEditMode) {
        container.querySelectorAll('#setlistItems .library-row-card').forEach(row => {
            row.addEventListener('click', () => playSetlist(setlist.id, Number(row.dataset.index)));
        });
    }

    const searchInput = container.querySelector('#setlistSongSearch');
    if (searchInput) {
        const allSongs = (await getAllSongs()).filter(song => song.tabOptions?.length);
        const resultsEl = container.querySelector('#setlistSongResults');
        const songsById = new Map(allSongs.map(song => [song.id, song]));
        // Most recently opened song first, with the specific tab that was opened
        const recentPicks = [];
        for (const r of await getRecents()) {
            const song = songsById.get(r.librarySongId);
            if (song && !recentPicks.some(p => p.song.id === song.id)) {
                recentPicks.push({ song, tabId: song.tabOptions.some(t => t.id === r.tabId) ? r.tabId : null });
            }
        }
        const renderResults = () => {
            songSearchQuery = searchInput.value;
            const q = songSearchQuery.trim().toLowerCase();
            const picks = q
                ? allSongs
                    .filter(song => `${song.title} ${song.artist || ''} ${song.album || ''}`.toLowerCase().includes(q))
                    .sort((a, b) => (a.title || '').localeCompare(b.title || ''))
                    .slice(0, MAX_SEARCH_RESULTS)
                    .map(song => ({ song, tabId: null }))
                : recentPicks;
            resultsEl.innerHTML = picks.length === 0
                ? `<div class="small text-muted py-2">${allSongs.length === 0 ? 'No songs with tabs in your library yet.' : (q ? 'No matching songs.' : 'Nothing opened recently. Type to search your library.')}</div>`
                : (q ? '' : '<div class="small text-white-50"><i class="bi-clock-history me-1"></i>Recently opened</div>') + picks.map(({ song, tabId }) => `
                  <div class="library-row-card d-flex align-items-center justify-content-between gap-3" role="button" tabindex="0" data-row-action=".setlist-search-add-btn" style="cursor:pointer;">
                    <div class="min-w-0">
                      <div class="fw-semibold text-white text-truncate">${escapeHtml(song.title)}</div>
                      <div class="small text-muted text-truncate">${escapeHtml(song.artist || '')}${song.album ? ` • ${escapeHtml(song.album)}` : ''}</div>
                    </div>
                    <button class="btn btn-sm btn-theme-outline py-1 px-3 flex-shrink-0 ms-2 setlist-search-add-btn" data-song-id="${escapeHtml(song.id)}" data-tab-id="${escapeHtml(tabId || '')}"><i class="bi-plus-lg me-1"></i>Add</button>
                  </div>`).join('');
        };
        renderResults();
        searchInput.addEventListener('input', renderResults);
        resultsEl.addEventListener('click', async (e) => {
            const btn = e.target.closest('.setlist-search-add-btn') || e.target.closest('.library-row-card[data-row-action]')?.querySelector('.setlist-search-add-btn');
            if (!btn) return;
            const song = allSongs.find(x => x.id === btn.dataset.songId);
            const tab = song.tabOptions.find(t => t.id === btn.dataset.tabId)
                || (song.defaultTabId && song.tabOptions.find(t => t.id === song.defaultTabId))
                || song.tabOptions[0];
            await addToSetlist(setlist.id, song.id, tab.id);
            keepAddSongsOpen = true;
            await rerender();
            container.querySelector('#setlistSongSearch')?.focus();
        });
    }

    hydrateCachedImages(container);
    gamepadManager.onLibraryViewRendered();
}

function promptNewSetlist(onCreated) {
    if (!requireSupporter('setlists')) return;
    openThemedInputModal({
        title: 'New Setlist',
        icon: 'bi-collection-play',
        inputLabel: 'Setlist Name',
        placeholder: 'Friday gig',
        confirmText: 'Create',
        onConfirm: async (name) => onCreated(await createSetlist(name))
    });
}

function promptRenameSetlist(setlist, onDone) {
    if (!requireSupporter('setlists')) return;
    openThemedInputModal({
        title: 'Rename Setlist',
        icon: 'bi-pencil-square',
        inputLabel: 'Setlist Name',
        initialValue: setlist.name,
        confirmText: 'Save',
        onConfirm: async (name) => {
            await renameSetlist(setlist.id, name);
            onDone();
        }
    });
}

/** Themed picker: choose an existing setlist (or create one) to append a tab to. */
export async function openAddToSetlistModal({ songId, tabId, title }) {
    if (!requireSupporter('setlists')) return;
    const setlists = await getAllSetlists();

    let modal = document.getElementById('addToSetlistModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'addToSetlistModal';
        modal.className = 'theme-modal-backdrop';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
    <div class="theme-modal-card" style="max-width: 440px; width: 90%;">
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          <div class="theme-modal-icon"><i class="bi-collection-play text-primary fs-5"></i></div>
          <div class="theme-modal-titles">
            <h5 class="modal-title mb-0 fs-6 fw-bold text-white">Add to Setlist</h5>
            <div class="small text-muted text-truncate" style="font-size: 0.78rem;">${escapeHtml(title || '')}</div>
          </div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="addToSetlistCloseBtn" aria-label="Close"><i class="bi-x-lg"></i></button>
        </div>
      </div>
      <div class="theme-modal-body p-3 d-flex flex-column gap-3">
        ${setlists.length > 0 ? `
          <div class="d-flex flex-column gap-2" style="max-height: 260px; overflow-y: auto;">
            ${setlists.map(sl => `
              <button type="button" class="btn btn-theme-outline d-flex align-items-center justify-content-between gap-2 text-start px-3 py-2 add-to-setlist-choice" data-setlist-id="${escapeHtml(sl.id)}">
                <span class="text-truncate">${escapeHtml(sl.name)}</span>
                <span class="small text-muted flex-shrink-0">${countLabel(sl.items.length)}</span>
              </button>`).join('')}
          </div>` : ''}
        <form id="addToSetlistNewForm" class="d-flex gap-2">
          <input type="text" class="form-control form-control-sm" id="addToSetlistNewName" placeholder="New setlist name" autocomplete="off" aria-label="New setlist name">
          <button type="submit" class="btn btn-sm btn-theme-primary px-3 flex-shrink-0">Create</button>
        </form>
      </div>
    </div>`;

    const handleKeyDown = (e) => { if (e.key === 'Escape') closeModal(); };
    const closeModal = () => {
        modal.classList.remove('show');
        modal.style.display = 'none';
        document.removeEventListener('keydown', handleKeyDown);
    };
    const addTo = async (setlistId) => {
        const sl = await addToSetlist(setlistId, songId, tabId);
        closeModal();
        if (sl) showToast(`Added to "${sl.name}"`, 'success');
    };

    modal.querySelector('#addToSetlistCloseBtn').addEventListener('click', closeModal);
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    modal.querySelectorAll('.add-to-setlist-choice').forEach(btn => {
        btn.addEventListener('click', () => addTo(btn.dataset.setlistId));
    });
    modal.querySelector('#addToSetlistNewForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = modal.querySelector('#addToSetlistNewName').value.trim();
        if (!name) return;
        addTo((await createSetlist(name)).id);
    });

    document.addEventListener('keydown', handleKeyDown);
    modal.style.display = 'flex';
    modal.classList.add('show');
    setTimeout(() => modal.querySelector(setlists.length ? '.add-to-setlist-choice' : '#addToSetlistNewName')?.focus(), 50);
}

/** "Add to Setlist" button in the notation menu (only for tabs that live in the library). */
export function setupAddToSetlistButton() {
    const btn = document.getElementById('addToSetlistBtn');
    if (!btn) return;
    document.addEventListener('scoreoptions:open', () => {
        const file = getCurrentFile();
        btn.style.display = file?.librarySongId && file?.tabId ? '' : 'none';
    });
    btn.addEventListener('click', () => {
        const file = getCurrentFile();
        if (!file?.librarySongId || !file?.tabId) return;
        document.getElementById('scoreOptionsPanelCloseBtn')?.click();
        openAddToSetlistModal({
            songId: file.librarySongId,
            tabId: file.tabId,
            title: file.songTitle || file.librarySongTitle || file.name
        });
    });
}
