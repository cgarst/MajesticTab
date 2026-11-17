// customMusicModal.js
// "Add custom music" dialog: a song, exercise or PDF book that is not in the music catalog, saved to Custom Music.
// Options: title, folder (nested with "/"), book switch, tuning and string count. A song gets its tab afterward from the tab picker; a book asks for its PDF on save.

import { saveSongToLibrary, addTabOptionToAlbum, getSongById } from './libraryStore.js';
import { openFromProvider } from './fileProviders.js';
import { showToast } from './utils/toast.js';

const TUNINGS = [
    ['E Standard', 'E standard'],
    ['Drop D', 'Drop D'],
    ['Eb Standard', 'E flat standard'],
    ['D Standard', 'D standard'],
    ['Drop C', 'Drop C'],
    ['7-String Standard', '7-string standard'],
    ['7-String Drop A', '7-string drop A'],
    ['8-String Standard', '8-string standard'],
    ['Bass Standard', 'Bass standard'],
    ['5-String Bass Standard', '5-string bass standard'],
    ['6-String Bass Standard', '6-string bass standard'],
    ['Open D', 'Open D'],
    ['DADGAD', 'DADGAD']
];
const STRING_COUNTS = [['6', '6 strings'], ['7', '7 strings'], ['8', '8 strings'], ['4', '4 strings'], ['5', '5 strings']];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {object} o
 * @param {string} o.collectionId
 * @param {string} [o.initialTitle]
 * @param {string} [o.folderPath]  folder to start in ("A/B")
 * @param {string[]} [o.folders]   existing custom folders, offered as suggestions
 * @param {object} [o.song]  an existing custom song to edit: the dialog then changes its title, folder, tuning and strings
 * @param {function({song: object|null, hasTab: boolean}): void} [o.onSaved]
 */
export function openCustomMusicModal({ collectionId, initialTitle = '', folderPath = '', folders = [], song: editSong = null, onSaved = () => {} } = {}) {
    const editing = Boolean(editSong);
    if (editing) { initialTitle = editSong.title || ''; folderPath = editSong.folderPath || editSong.album || ''; }
    const initialTuning = editing ? ((editSong.tunings || [])[0] || '') : '';
    const tuningList = initialTuning && !TUNINGS.some(([v]) => v === initialTuning) ? [...TUNINGS, [initialTuning, initialTuning]] : TUNINGS;
    document.getElementById('customMusicModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'customMusicModal';
    modal.className = 'theme-modal-backdrop';
    document.body.appendChild(modal);

    modal.innerHTML = `
    <div class="theme-modal-card cm-card" role="dialog" aria-modal="true" aria-labelledby="cmTitle">
      <div class="theme-modal-header">
        <div class="theme-modal-titles">
          <h5 class="modal-title mb-0 fs-6 fw-bold text-white" id="cmTitle">${editing ? 'Edit custom music' : 'Add custom music'}</h5>
          <div class="small text-muted">${editing ? 'Title, folder, tuning and strings' : 'An original, an exercise or a book that is not in the catalog'}</div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="cmClose" aria-label="Close"><i class="bi-x-lg" aria-hidden="true"></i></button>
        </div>
      </div>
      <form id="cmForm" novalidate>
        <div class="theme-modal-body cm-body">
          <div class="cm-field">
            <label class="form-label" for="cmName">Title</label>
            <input type="text" class="form-control" id="cmName" value="${esc(initialTitle)}" placeholder="Major triad inversions" autocomplete="off" required>
          </div>
          <div class="cm-field">
            <label class="form-label" for="cmFolder">Folder</label>
            <input type="text" class="form-control" id="cmFolder" list="cmFolderList" value="${esc(folderPath)}" placeholder="Exercises/Technique" autocomplete="off" spellcheck="false">
            <datalist id="cmFolderList">${folders.map((f) => `<option value="${esc(f)}"></option>`).join('')}</datalist>
            <div class="cm-hint">Optional. Use a slash for subfolders. Blank puts it at the top of Custom Music.</div>
          </div>
          <div class="cm-row">
            <div class="cm-field">
              <label class="form-label" for="cmTuning">Tuning</label>
              <select class="form-select" id="cmTuning">
                <option value="">Unspecified</option>
                ${tuningList.map(([v, l]) => `<option value="${esc(v)}"${v === initialTuning ? ' selected' : ''}>${esc(l)}</option>`).join('')}
              </select>
            </div>
            <div class="cm-field">
              <label class="form-label" for="cmStrings">Strings</label>
              <select class="form-select" id="cmStrings">
                <option value="">Unspecified</option>
                ${STRING_COUNTS.map(([v, l]) => `<option value="${v}"${editing && String(editSong.stringCount || '') === v ? ' selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
          </div>
          ${editing ? '' : `<div class="cm-field">
            <div class="form-check form-switch cm-switch">
              <input class="form-check-input theme-switch" type="checkbox" role="switch" id="cmBook">
              <label class="form-check-label" for="cmBook">This is a book (PDF)
                <span class="cm-hint d-block">Saved to the folder as a book. Set page ranges afterward to make songs from it.</span>
              </label>
            </div>
          </div>`}
        </div>
        <div class="theme-modal-footer cm-footer">
          <button type="button" class="btn btn-sm btn-theme-outline px-3" id="cmCancel">Cancel</button>
          <button type="submit" class="btn btn-sm btn-theme-primary px-4" id="cmSave">${editing ? 'Save' : 'Add song'}</button>
        </div>
      </form>
    </div>`;

    const $ = (sel) => modal.querySelector(sel);
    const bookEl = $('#cmBook') || { checked: false, addEventListener() {} }, saveEl = $('#cmSave');
    const nameEl = $('#cmName'), folderEl = $('#cmFolder'), tuningEl = $('#cmTuning'), stringsEl = $('#cmStrings');

    const close = () => {
        document.removeEventListener('keydown', onKey);
        modal.classList.add('is-closing');
        setTimeout(() => modal.remove(), 160);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    $('#cmClose').addEventListener('click', close);
    $('#cmCancel').addEventListener('click', close);
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });

    bookEl.addEventListener('change', () => { saveEl.textContent = bookEl.checked ? 'Choose PDF' : 'Add song'; });

    $('#cmForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = nameEl.value.trim();
        if (!title) { nameEl.focus(); return; }
        const folder = folderEl.value.trim().replace(/^\/+|\/+$/g, '');
        const tuning = tuningEl.value || null;
        const stringCount = stringsEl.value ? parseInt(stringsEl.value, 10) : null;
        const where = `Custom Music${folder ? ' / ' + folder : ''}`;

        if (editing) {
            try {
                const current = (await getSongById(editSong.id)) || editSong;
                const updated = await saveSongToLibrary({
                    ...current,
                    title,
                    album: folder,
                    folderPath: folder,
                    tunings: tuning === initialTuning ? current.tunings : (tuning ? [tuning] : []),
                    stringCount
                }, current.collectionId || collectionId);
                showToast(`Saved "${title}"`, 'success');
                close();
                onSaved({ song: updated, hasTab: true });
            } catch (err) {
                console.warn('Could not edit custom music:', err);
                showToast('Could not save those changes', 'error');
            }
            return;
        }

        if (bookEl.checked) {
            // A book is its PDF: ask for the file, then save it into the folder
            openFromProvider('local', {
                onFileSelected: async (file) => {
                    if (!/\.pdf$/i.test(file?.name || '')) { showToast('Choose a PDF to add a book.', 'warning'); return; }
                    try {
                        const meta = file.meta || {};
                        await addTabOptionToAlbum(collectionId, 'Custom Music', folder || 'Custom Music', {
                            name: title,
                            providerId: file.providerId,
                            relativePath: file.name,
                            fileStoreId: file.fileStoreId,
                            tuning: tuning || meta?.primaryTuning || null,
                            tunings: tuning ? [tuning] : (meta?.tunings || []),
                            stringCount: stringCount || meta?.stringCount || null,
                            fileType: 'pdf',
                            isCustom: true
                        });
                        showToast(`Added "${title}" to ${where}`, 'success');
                        close();
                        onSaved({ song: null, hasTab: true });
                    } catch (err) {
                        console.warn('Could not add book:', err);
                        showToast('Could not add that to your library', 'error');
                    }
                }
            });
            return;
        }

        try {
            const song = await saveSongToLibrary({
                id: `song_custom_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
                collectionId,
                title,
                artist: 'Custom Music',
                album: folder,
                folderPath: folder,
                isCustom: true,
                tunings: tuning ? [tuning] : [],
                stringCount,
                tabOptions: [],
                defaultTabId: null,
                addedAt: Date.now()
            }, collectionId);
            showToast(`Added "${title}" to ${where}`, 'success');
            close();
            onSaved({ song, hasTab: false });
        } catch (err) {
            console.warn('Could not add custom music:', err);
            showToast('Could not add that to your library', 'error');
        }
    });

    modal.style.display = 'flex';
    modal.classList.add('show');
    setTimeout(() => { nameEl.focus(); nameEl.select(); }, 50);
}
