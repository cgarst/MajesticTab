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
    return `${n} ${n === 1 ? 'song' : 'songs'}`;
}

function formatTrackDuration(duration) {
    if (!duration || duration <= 0) return '';
    let totalSecs = Number(duration);
    if (isNaN(totalSecs) || totalSecs <= 0) return '';
    if (totalSecs > 10000) totalSecs = Math.round(totalSecs / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = Math.floor(totalSecs % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
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
      <div class="title-row mb-3">
        <div>
          <h2>Setlists</h2>
          <p class="tnum">${setlists.length} ${setlists.length === 1 ? 'setlist' : 'setlists'} to play</p>
        </div>
        <div class="d-flex align-items-center gap-2">
          <button class="btn btn-sm btn-theme-primary d-flex align-items-center gap-1" id="newSetlistBtn" title="Create a new setlist">
            <i class="bi-plus-lg"></i> <span>New Setlist</span>
          </button>
          ${setlists.length > 0 ? `
            <button class="btn btn-sm ${isEditMode ? 'btn-theme-primary' : 'btn-theme-outline'} d-flex align-items-center gap-1" id="toggleSetlistsEditBtn" title="${isEditMode ? 'Done editing' : 'Edit setlists'}">
              <i class="bi-${isEditMode ? 'check-lg' : 'pencil'}"></i> <span>${isEditMode ? 'Done' : 'Edit'}</span>
            </button>
          ` : ''}
        </div>
      </div>

      ${setlists.length > 0 ? `
        <div class="library-search-bar mb-3">
          <i class="bi-search search-icon"></i>
          <input type="text" class="search-input" id="setlistsFilterInput" placeholder="Search setlists..." aria-label="Search setlists">
          <button class="btn btn-sm search-clear-btn" id="setlistsFilterClearBtn" style="display:none;" aria-label="Clear search"><i class="bi-x-lg"></i></button>
        </div>
      ` : ''}

      ${setlists.length === 0 ? `
        ${libraryEmptyStateHtml({
          icon: 'bi-collection-play',
          title: 'No setlists yet',
          message: 'Create a setlist, then add songs from your library, recents or tunings, or from a tab\'s notation menu.',
          actionsHtml: `<button class="btn btn-sm btn-theme-primary px-4" id="newSetlistBtn"><i class="bi-plus-lg me-1"></i> New Setlist</button>`
        })}
      ` : `
        <div class="scroll" style="margin-top: 8px;" id="setlistsList">
          ${setlists.map(sl => `
            <div class="rowwrap">
              <button class="row setrow" data-setlist-id="${escapeHtml(sl.id)}">
                <span class="mono"><i class="bi-collection-play"></i></span>
                <span class="t">
                  <b>${escapeHtml(sl.name)}</b>
                  <span class="tnum">${countLabel(sl.items.length)}</span>
                </span>
                ${isEditMode ? '' : '<span class="end"><i class="bi-chevron-right text-white-50"></i></span>'}
              </button>
              ${isEditMode ? `
                <div class="d-flex align-items-center gap-2 position-absolute end-0 me-3">
                  <button class="btn btn-sm theme-control-btn p-1 px-2 rename-setlist-btn" data-setlist-id="${escapeHtml(sl.id)}" title="Rename setlist"><i class="bi-pencil"></i></button>
                  <button class="btn btn-sm btn-theme-danger p-1 px-2 delete-setlist-btn" data-setlist-id="${escapeHtml(sl.id)}" title="Delete setlist">${trashHtml}</button>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      `}
    </div>`;

    const rerender = () => renderSetlistList(container, onBack);

    bindListFilter(container, { inputId: 'setlistsFilterInput', clearId: 'setlistsFilterClearBtn', rowSelector: '#setlistsList .rowwrap' });

    container.querySelector('#toggleSetlistsEditBtn')?.addEventListener('click', () => {
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

    container.querySelectorAll('#setlistsList .rowwrap .setrow').forEach(row => {
        const open = async () => {
            if (isEditMode) return;
            selectedSetlistId = row.dataset.setlistId;
            await renderSetlistDetail(container, onBack);
        };
        row.addEventListener('click', (e) => { if (!e.target.closest('button.rename-setlist-btn, button.delete-setlist-btn')) open(); });
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

    let totSec = 0;
    const tuningsList = [];
    songs.forEach(s => {
        if (s?.length && Number(s.length) > 0) {
            let sec = Number(s.length);
            if (sec > 10000) sec = Math.round(sec / 1000);
            totSec += sec;
        }
        const t = s?.tunings?.[0] || s?.tuning || (s?.tabOptions?.[0]?.tuning) || 'Standard';
        if (t) tuningsList.push(t);
    });
    const tuningChanges = Math.max(0, new Set(tuningsList).size - 1);
    const fmtTot = formatTrackDuration(totSec);

    container.innerHTML = `
    <div class="library-page-container setlists-view">
      <div class="title-row mb-3">
        <div>
          <div class="d-flex align-items-center gap-2 mb-2">
            <button class="btn btn-sm btn-theme-outline setback" id="setlistsBackBtn" title="Back to all setlists">Setlists</button>
          </div>
          <h2>${escapeHtml(setlist.name)}</h2>
          <p class="tnum">${[`${setlist.items.length} ${setlist.items.length === 1 ? 'song' : 'songs'}`, fmtTot, tuningsList.length > 0 ? (tuningChanges === 0 ? 'no tuning changes' : `${tuningChanges} ${tuningChanges === 1 ? 'tuning change' : 'tuning changes'}`) : ''].filter(Boolean).join(' \u00b7 ')}</p>
        </div>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          ${setlist.items.length > 0 && !isEditMode ? `
            <button class="btn btn-sm btn-theme-primary" id="playSetlistBtn" title="Start set from the first song">Start set</button>
          ` : ''}
          <button class="btn btn-sm theme-control-btn" id="renameSetlistBtn" title="Rename setlist">Rename</button>
          <button class="btn btn-sm btn-theme-outline" id="toggleSetlistEditBtn" title="${isEditMode ? 'Done editing' : 'Edit setlist'}">${isEditMode ? 'Done' : 'Edit'}</button>
        </div>
      </div>

      ${(isEditMode || keepAddSongsOpen || setlist.items.length === 0) ? `
        <div class="setlist-add-songs mb-3 p-3 rounded-2" style="background:var(--s1);">
          <div class="small fw-semibold text-white-50 mb-2">${setlist.items.length === 0 ? 'This setlist is empty. Search your library to add songs.' : 'Add songs'}</div>
          <div class="library-search-bar mb-2">
            <i class="bi-search search-icon"></i>
            <input type="text" class="search-input" id="setlistSongSearch" placeholder="Search songs with tabs..." value="${escapeHtml(songSearchQuery)}" autocomplete="off" spellcheck="false" aria-label="Search songs to add">
          </div>
          <div class="d-flex flex-column gap-1" id="setlistSongResults"></div>
        </div>
      ` : ''}

      ${setlist.items.length === 0 ? '' : `
        <div class="scroll" style="margin-top: 8px;" id="setlistItems">
          ${setlist.items.map((item, idx) => {
              const song = songs[idx];
              const tab = song?.tabOptions?.find(t => t.id === item.tabId);
              const tuning = tab?.tuning || song?.tunings?.[0] || song?.tuning || '';
              const dur = formatTrackDuration(song?.length);
              const isStandard = tuning === 'Standard' || tuning === 'E Standard' || !tuning;
              const metaLine = [song?.artist || '', tuning].filter(Boolean).join(' \u00b7 ');
              return `
              <div class="rowwrap">
                <button class="row setrow ${isEditMode ? '' : 'clickable'}" data-index="${idx}" ${isEditMode ? 'style="cursor:default;"' : ''}>
                  <span class="num tnum">${idx + 1}</span>
                  <span class="t">
                    <b>${escapeHtml(song?.title || 'Song removed from library')}</b>
                    <span title="${escapeHtml(tab ? tab.name : '')}">${escapeHtml(metaLine)}</span>
                  </span>
                  ${dur ? `<span class="end tnum">${dur}</span>` : ''}
                </button>
                ${isEditMode ? `
                  <div class="d-flex align-items-center gap-1 position-absolute end-0 me-3">
                    <button class="btn btn-sm btn-theme-icon p-1 px-2 move-item-btn" data-item-id="${escapeHtml(item.id)}" data-delta="-1" title="Move up" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}><i class="bi-arrow-up"></i></button>
                    <button class="btn btn-sm btn-theme-icon p-1 px-2 move-item-btn" data-item-id="${escapeHtml(item.id)}" data-delta="1" title="Move down" aria-label="Move down" ${idx === setlist.items.length - 1 ? 'disabled' : ''}><i class="bi-arrow-down"></i></button>
                    <button class="btn btn-sm btn-theme-danger p-1 px-2 remove-item-btn" data-item-id="${escapeHtml(item.id)}" title="Remove from setlist" aria-label="Remove from setlist"><i class="bi-x-lg"></i></button>
                  </div>
                ` : ''}
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
        container.querySelectorAll('#setlistItems .rowwrap .setrow.clickable').forEach(row => {
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
                  <div class="rowwrap" style="cursor:pointer;" data-row-action=".setlist-search-add-btn">
                    <div class="row setrow" style="padding-right:72px;">
                      <span class="t">
                        <b>${escapeHtml(song.title)}</b>
                        <span>${escapeHtml(song.artist || '')}${song.album ? ` • ${escapeHtml(song.album)}` : ''}</span>
                      </span>
                    </div>
                    <button class="btn btn-sm btn-theme-outline py-1 px-3 flex-shrink-0 position-absolute end-0 me-2 setlist-search-add-btn" data-song-id="${escapeHtml(song.id)}" data-tab-id="${escapeHtml(tabId || '')}"><i class="bi-plus-lg me-1"></i>Add</button>
                  </div>`).join('');
        };
        renderResults();
        searchInput.addEventListener('input', renderResults);
        resultsEl.addEventListener('click', async (e) => {
            const btn = e.target.closest('.setlist-search-add-btn') || e.target.closest('.rowwrap[data-row-action]')?.querySelector('.setlist-search-add-btn');
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
