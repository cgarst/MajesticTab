// libraryEditModal.js
// Edit mode's "Edit song" and "Edit album" dialogs for songs from the catalog: the names a song or an album is filed under.
// A custom song keeps its own dialog (customMusicModal.js), since its folder and tuning are what it has.

import { saveSongToLibrary, getSongById, getSongsByCollection } from './libraryStore.js';
import { showToast } from './utils/toast.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function openDialog({ title, subtitle, fields, onSave }) {
    document.getElementById('libraryEditModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'libraryEditModal';
    modal.className = 'theme-modal-backdrop';
    document.body.appendChild(modal);
    modal.innerHTML = `
    <div class="theme-modal-card cm-card" role="dialog" aria-modal="true" aria-labelledby="leTitle">
      <div class="theme-modal-header">
        <div class="theme-modal-titles">
          <h5 class="modal-title mb-0 fs-6 fw-bold text-white" id="leTitle">${esc(title)}</h5>
          <div class="small text-muted">${esc(subtitle)}</div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="leClose" aria-label="Close"><i class="bi-x-lg" aria-hidden="true"></i></button>
        </div>
      </div>
      <form id="leForm" novalidate>
        <div class="theme-modal-body cm-body">
          ${fields.map((f) => `<div class="cm-field"><label class="form-label" for="le_${f.key}">${esc(f.label)}</label>
            <input type="${f.type || 'text'}" class="form-control" id="le_${f.key}" value="${esc(f.value)}" autocomplete="off" ${f.required ? 'required' : ''}></div>`).join('')}
        </div>
        <div class="theme-modal-footer cm-footer">
          <button type="button" class="btn btn-sm btn-theme-outline px-3" id="leCancel">Cancel</button>
          <button type="submit" class="btn btn-sm btn-theme-primary px-4">Save</button>
        </div>
      </form>
    </div>`;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => {
        document.removeEventListener('keydown', onKey);
        modal.classList.add('is-closing');
        setTimeout(() => modal.remove(), 160);
    };
    document.addEventListener('keydown', onKey);
    modal.querySelector('#leClose').addEventListener('click', close);
    modal.querySelector('#leCancel').addEventListener('click', close);
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
    modal.querySelector('#leForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const values = {};
        for (const f of fields) values[f.key] = modal.querySelector(`#le_${f.key}`).value.trim();
        const missing = fields.find((f) => f.required && !values[f.key]);
        if (missing) { modal.querySelector(`#le_${missing.key}`).focus(); return; }
        try { await onSave(values); close(); } catch (err) {
            console.warn('Could not save library edit:', err);
            showToast('Could not save those changes', 'error');
        }
    });
    modal.style.display = 'flex';
    modal.querySelector('input')?.focus();
}

/** Title, artist, album and track number of one song. */
export async function openEditSongModal(songId, { onSaved = () => {} } = {}) {
    const song = await getSongById(songId);
    if (!song) return;
    openDialog({
        title: 'Edit song',
        subtitle: 'Where the song is filed in your library',
        fields: [
            { key: 'title', label: 'Title', value: song.title, required: true },
            { key: 'artist', label: 'Artist', value: song.artist, required: true },
            { key: 'album', label: 'Album', value: song.album },
            { key: 'track', label: 'Track number', value: song.trackNumber ?? '', type: 'text' }
        ],
        onSave: async (v) => {
            const current = (await getSongById(songId)) || song;
            await saveSongToLibrary({ ...current, title: v.title, artist: v.artist, album: v.album || 'Unknown Album', trackNumber: v.track || null }, current.collectionId);
            showToast(`Saved "${v.title}"`, 'success');
            onSaved();
        }
    });
}

/** Album title, artist and year, applied to every song filed under the album (and its album-tab holder). */
export async function openEditAlbumModal({ collectionId, artistName, albumTitle }, { onSaved = () => {} } = {}) {
    const norm = (x) => (x || '').trim().toLowerCase();
    const matches = async () => (await getSongsByCollection(collectionId))
        .filter((s) => norm(s.artist) === norm(artistName) && norm(s.album) === norm(albumTitle));
    const songs = await matches();
    if (!songs.length) { showToast('Nothing to edit in this album.', 'info'); return; }
    openDialog({
        title: 'Edit album',
        subtitle: `${songs.length} ${songs.length === 1 ? 'song' : 'songs'} change with it`,
        fields: [
            { key: 'album', label: 'Album title', value: albumTitle, required: true },
            { key: 'artist', label: 'Artist', value: artistName, required: true },
            { key: 'year', label: 'Year', value: songs.find((s) => s.year)?.year ?? '' }
        ],
        onSave: async (v) => {
            for (const s of await matches()) {
                await saveSongToLibrary({
                    ...s,
                    album: v.album,
                    artist: v.artist,
                    title: s.isAlbumTabContainer ? v.album : s.title,
                    year: v.year || null
                }, s.collectionId || collectionId);
            }
            showToast(`Saved "${v.album}"`, 'success');
            onSaved();
        }
    });
}
