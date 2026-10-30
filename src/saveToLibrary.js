// saveToLibrary.js
// "Save to Library" for a tab that was opened directly (not from the library).

import { getCurrentFile } from './main.js';
import { getCollections, saveSongToLibrary, mapOpenFileToSong, DEFAULT_COLLECTION_ID } from './libraryStore.js';
import { searchMusicBrainz, getPlaceholderCoverSvg } from './musicbrainz.js';
import { detectFileMetadata } from './utils/tuningUtils.js';
import { showToast } from './utils/toast.js';

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isSavableFile(file) {
    return Boolean(file && file.name && !file.librarySongId && !file.jamTransient && typeof file.arrayBuffer === 'function');
}

function refreshSaveToLibraryBtn() {
    const btn = document.getElementById('saveToLibraryBtn');
    if (btn) btn.style.display = isSavableFile(getCurrentFile()) ? '' : 'none';
}

async function openSaveToLibraryModal(file) {
    const [collections, meta] = await Promise.all([
        getCollections(),
        detectFileMetadata(file, file.name).catch(() => null)
    ]);
    const baseName = file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');

    let modal = document.getElementById('saveToLibraryModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'saveToLibraryModal';
        modal.className = 'theme-modal-backdrop';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
    <div class="theme-modal-card" style="max-width: 460px; width: 90%;">
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          <div class="theme-modal-icon"><i class="bi-bookmark-plus text-primary fs-5"></i></div>
          <div class="theme-modal-titles">
            <h5 class="modal-title mb-0 fs-6 fw-bold text-white">Save to Library</h5>
            <div class="small text-muted text-truncate" style="font-size: 0.78rem;">${escapeHtml(file.name)}</div>
          </div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="saveToLibraryCloseBtn" aria-label="Close">
            <i class="bi-x-lg"></i>
          </button>
        </div>
      </div>
      <form id="saveToLibraryForm">
        <div class="theme-modal-body p-3 d-flex flex-column gap-3">
          <div class="hud-pill-group w-100" role="group" aria-label="Save as">
            <input type="radio" class="btn-check" name="saveToLibraryKind" id="saveToLibraryKindSong" value="song" autocomplete="off" checked>
            <label class="btn btn-sm" for="saveToLibraryKindSong" style="flex: 1;"><i class="bi-music-note me-1"></i>Song</label>
            <input type="radio" class="btn-check" name="saveToLibraryKind" id="saveToLibraryKindCustom" value="custom" autocomplete="off">
            <label class="btn btn-sm" for="saveToLibraryKindCustom" style="flex: 1;"><i class="bi-journal-text me-1"></i>Custom Song</label>
          </div>
          <div id="saveToLibrarySongFields" class="d-flex flex-column gap-2">
            <label class="form-label small text-white-50 mb-0 fw-semibold" for="saveToLibrarySearch">Find the song on MusicBrainz</label>
            <input type="text" class="form-control form-control-sm" id="saveToLibrarySearch" value="${escapeHtml([meta?.title || baseName, meta?.artist].filter(Boolean).join(' '))}" placeholder="Song title and artist" autocomplete="off">
            <div id="saveToLibraryResults" class="d-flex flex-column gap-1" style="max-height: 240px; overflow-y: auto;"></div>
          </div>
          <div id="saveToLibraryCustomFields" class="d-flex flex-column gap-3" style="display: none !important;">
            <div>
              <label class="form-label small text-white-50 mb-1 fw-semibold" for="saveToLibraryTitle">Title</label>
              <input type="text" class="form-control form-control-sm" id="saveToLibraryTitle" value="${escapeHtml(meta?.title || baseName)}" autocomplete="off">
            </div>
            <div>
              <label class="form-label small text-white-50 mb-1 fw-semibold" for="saveToLibraryArtist">Artist</label>
              <input type="text" class="form-control form-control-sm" id="saveToLibraryArtist" value="${escapeHtml(meta?.artist || '')}" placeholder="Custom Music" autocomplete="off">
            </div>
            <div>
              <label class="form-label small text-white-50 mb-1 fw-semibold" for="saveToLibraryAlbum">Folder (Optional)</label>
              <input type="text" class="form-control form-control-sm" id="saveToLibraryAlbum" value="${escapeHtml(meta?.album || '')}" autocomplete="off">
            </div>
          </div>
          ${collections.length > 1 ? `
          <div>
            <label class="form-label small text-white-50 mb-1 fw-semibold" for="saveToLibraryCollection">Collection</label>
            <select class="form-select form-select-sm" id="saveToLibraryCollection">
              ${collections.map(c => `<option value="${c.id}" ${c.id === DEFAULT_COLLECTION_ID ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
            </select>
          </div>` : ''}
        </div>
        <div class="d-flex justify-content-end gap-2 p-3 pt-0 border-0">
          <button type="button" class="btn btn-sm btn-theme-outline px-3" id="saveToLibraryCancelBtn">Cancel</button>
          <button type="submit" class="btn btn-sm btn-theme-primary px-4" id="saveToLibraryConfirmBtn">Save to Library</button>
        </div>
      </form>
    </div>
    `;

    const form = modal.querySelector('#saveToLibraryForm');
    const albumInput = modal.querySelector('#saveToLibraryAlbum');
    const songFields = modal.querySelector('#saveToLibrarySongFields');
    const customFields = modal.querySelector('#saveToLibraryCustomFields');
    const searchInput = modal.querySelector('#saveToLibrarySearch');
    const resultsEl = modal.querySelector('#saveToLibraryResults');
    let selected = null;
    let searchSeq = 0;
    let searchTimer = null;
    const confirmBtn = modal.querySelector('#saveToLibraryConfirmBtn');

    const handleKeyDown = (e) => { if (e.key === 'Escape') closeModal(); };
    const closeModal = () => {
        modal.classList.remove('show');
        modal.style.display = 'none';
        document.removeEventListener('keydown', handleKeyDown);
    };

    modal.querySelector('#saveToLibraryCloseBtn').addEventListener('click', closeModal);
    modal.querySelector('#saveToLibraryCancelBtn').addEventListener('click', closeModal);
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };

    const isCustomMode = () => form.querySelector('input[name="saveToLibraryKind"]:checked').value === 'custom';

    const syncMode = () => {
        const custom = isCustomMode();
        songFields.style.setProperty('display', custom ? 'none' : 'flex', 'important');
        customFields.style.setProperty('display', custom ? 'flex' : 'none', 'important');
        confirmBtn.disabled = !custom && !selected;
    };

    const renderResults = (results) => {
        if (!results.length) {
            resultsEl.innerHTML = '<div class="small text-muted text-center py-3">No matches. Try a different search, or save as a Custom Song.</div>';
            return;
        }
        resultsEl.innerHTML = results.map((r, i) => `
          <button type="button" class="btn btn-theme-outline text-start d-flex align-items-center gap-2 p-2 save-to-library-result ${selected?.id === r.id ? 'active' : ''}" data-index="${i}">
            <img src="${escapeHtml(r.coverUrl || getPlaceholderCoverSvg(r.title))}" width="36" height="36" class="rounded flex-shrink-0" style="object-fit: cover;" alt="" onerror="this.style.visibility='hidden'">
            <span class="min-w-0 flex-grow-1">
              <span class="d-block fw-semibold text-truncate">${escapeHtml(r.title)}</span>
              <span class="d-block small text-muted text-truncate">${escapeHtml(r.artist)}${r.album ? ` • ${escapeHtml(r.album)}` : ''}${r.year ? ` • ${r.year}` : ''}</span>
            </span>
            ${selected?.id === r.id ? '<i class="bi-check-lg flex-shrink-0"></i>' : ''}
          </button>`).join('');
        resultsEl.querySelectorAll('.save-to-library-result').forEach(btn => {
            btn.addEventListener('click', () => {
                selected = results[Number(btn.dataset.index)];
                renderResults(results);
                syncMode();
            });
        });
    };

    const runSearch = async () => {
        const q = searchInput.value.trim();
        const seq = ++searchSeq;
        if (!q) { resultsEl.innerHTML = ''; return; }
        resultsEl.innerHTML = '<div class="small text-muted text-center py-3">Searching...</div>';
        try {
            const results = await searchMusicBrainz(q, 'song');
            if (seq === searchSeq) renderResults(results.slice(0, 15));
        } catch (err) {
            if (seq === searchSeq) resultsEl.innerHTML = `<div class="small text-danger-emphasis text-center py-3">Search failed: ${escapeHtml(err.message)}</div>`;
        }
    };

    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(runSearch, 400);
    });
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); runSearch(); }
    });
    form.querySelectorAll('input[name="saveToLibraryKind"]').forEach(radio => radio.addEventListener('change', syncMode));
    syncMode();
    runSearch();

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const isCustom = isCustomMode();
        const title = isCustom ? modal.querySelector('#saveToLibraryTitle').value.trim() : selected?.title;
        if (!title) return;
        const collectionId = modal.querySelector('#saveToLibraryCollection')?.value || DEFAULT_COLLECTION_ID;
        confirmBtn.disabled = true;
        try {
            const songData = isCustom ? {
                title,
                artist: modal.querySelector('#saveToLibraryArtist').value.trim(),
                album: albumInput.value.trim()
            } : {
                title,
                artist: selected.artist,
                artistMbid: selected.artistMbid,
                album: selected.album,
                albumMbid: selected.albumMbid,
                recordingMbid: selected.recordingMbid,
                year: selected.year,
                length: selected.length,
                coverUrl: selected.coverUrl
            };
            const song = await saveSongToLibrary({
                ...songData,
                isCustom,
                tunings: meta?.tunings || [],
                stringCount: meta?.stringCount || null
            }, collectionId);
            const { tabOption } = await mapOpenFileToSong(file, song.id, file.name);
            file.librarySongId = song.id;
            file.tabId = tabOption.id;
            closeModal();
            refreshSaveToLibraryBtn();
            showToast(`Saved "${title}" to your library.`, 'success');
        } catch (err) {
            console.error('[SaveToLibrary] Failed:', err);
            confirmBtn.disabled = false;
            showToast('Could not save to library.', 'error');
        }
    });

    document.addEventListener('keydown', handleKeyDown);
    modal.style.display = 'flex';
    modal.classList.add('show');
    setTimeout(() => searchInput.focus(), 50);
}

export function setupSaveToLibraryButton() {
    document.addEventListener('scoreoptions:open', refreshSaveToLibraryBtn);
    document.getElementById('saveToLibraryBtn')?.addEventListener('click', () => {
        const file = getCurrentFile();
        if (!isSavableFile(file)) return;
        document.getElementById('scoreOptionsPanelCloseBtn')?.click();
        openSaveToLibraryModal(file);
    });
}
