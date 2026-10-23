// saveToLibrary.js
// "Save to Library" for a tab that was opened directly (not from the library).

import { getCurrentFile } from './main.js';
import { getCollections, saveSongToLibrary, mapOpenFileToSong, DEFAULT_COLLECTION_ID } from './libraryStore.js';
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
          <div>
            <label class="form-label small text-white-50 mb-1 fw-semibold" for="saveToLibraryTitle">Title</label>
            <input type="text" class="form-control form-control-sm" id="saveToLibraryTitle" value="${escapeHtml(meta?.title || baseName)}" autocomplete="off" required>
          </div>
          <div>
            <label class="form-label small text-white-50 mb-1 fw-semibold" for="saveToLibraryArtist">Artist</label>
            <input type="text" class="form-control form-control-sm" id="saveToLibraryArtist" value="${escapeHtml(meta?.artist || '')}" placeholder="Custom Music" autocomplete="off">
          </div>
          <div>
            <label class="form-label small text-white-50 mb-1 fw-semibold" for="saveToLibraryAlbum" id="saveToLibraryAlbumLabel">Album</label>
            <input type="text" class="form-control form-control-sm" id="saveToLibraryAlbum" value="${escapeHtml(meta?.album || '')}" autocomplete="off">
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
    const albumLabel = modal.querySelector('#saveToLibraryAlbumLabel');
    const albumInput = modal.querySelector('#saveToLibraryAlbum');
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

    form.querySelectorAll('input[name="saveToLibraryKind"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const isCustom = form.querySelector('input[name="saveToLibraryKind"]:checked').value === 'custom';
            albumLabel.textContent = isCustom ? 'Folder (Optional)' : 'Album';
        });
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = modal.querySelector('#saveToLibraryTitle').value.trim();
        if (!title) return;
        const isCustom = form.querySelector('input[name="saveToLibraryKind"]:checked').value === 'custom';
        const collectionId = modal.querySelector('#saveToLibraryCollection')?.value || DEFAULT_COLLECTION_ID;
        confirmBtn.disabled = true;
        try {
            const song = await saveSongToLibrary({
                title,
                artist: modal.querySelector('#saveToLibraryArtist').value.trim(),
                album: albumInput.value.trim(),
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
    setTimeout(() => modal.querySelector('#saveToLibraryTitle')?.focus(), 50);
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
