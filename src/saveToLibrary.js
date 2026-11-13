// saveToLibrary.js
// "Save to Library" for a tab that was opened directly (not from the library).

import { getCurrentFile } from './main.js';
import { getCollections, saveSongToLibrary, mapOpenFileToSong, resolveAndSaveOrMergeSong, DEFAULT_COLLECTION_ID } from './libraryStore.js';
import { searchMusicBrainz, lookupMusicBrainzByIds, getPlaceholderCoverSvg, hydrateCachedImages, getSynchronousCachedArtUrl } from './musicbrainz.js';
import { detectFileMetadata, getTuningInfo } from './utils/tuningUtils.js';
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

export async function openSaveToLibraryModal(file) {
    const [collections, meta] = await Promise.all([
        getCollections(),
        detectFileMetadata(file, file.name).catch(() => null)
    ]);
    const isClassical = Boolean(file.classtabTab);
    const mtabSong = (file.mtabSong && typeof file.mtabSong === 'object') ? file.mtabSong : null;
    // A classical piece's file name is the archive's lowercase path; its title keeps the catalog's case
    const baseName = isClassical && file.songTitle ? file.songTitle : file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
    const initialTitle = mtabSong?.title || meta?.title || file.songTitle || baseName;
    const initialArtist = mtabSong?.artist || meta?.artist || file.artist || '';
    const initialAlbum = mtabSong?.album || meta?.album || file.album || '';
    // The tuning the tab is saved with: the one the player set in the Song menu, else what the data gives
    const chosenTuning = file.tabTuning && typeof file.tabTuning === 'object' ? file.tabTuning : null;
    const savedTunings = chosenTuning ? (chosenTuning.tuning ? [chosenTuning.tuning] : []) : (meta?.tunings || []);
    const tuningSourceText = { classtab: 'from the classical archive', header: 'from the tab\'s header', filename: 'from the file name' }[meta?.tuningSource] || '';
    const tuningLine = savedTunings.length
        ? `${savedTunings.map((t) => getTuningInfo(t)?.displayName || t).join(', ')}${chosenTuning ? '' : (tuningSourceText ? `, ${tuningSourceText}` : '')}`
        : '';

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
            <input type="radio" class="btn-check" name="saveToLibraryKind" id="saveToLibraryKindSong" value="song" autocomplete="off"${isClassical ? '' : ' checked'}>
            <label class="btn btn-sm" for="saveToLibraryKindSong" style="flex: 1;"><i class="bi-music-note me-1"></i>Song</label>
            <input type="radio" class="btn-check" name="saveToLibraryKind" id="saveToLibraryKindCustom" value="custom" autocomplete="off"${isClassical ? ' checked' : ''}>
            <label class="btn btn-sm" for="saveToLibraryKindCustom" style="flex: 1;"><i class="bi-journal-text me-1"></i>Custom Song</label>
          </div>
          <div id="saveToLibrarySongFields" class="d-flex flex-column gap-2">
            <label class="form-label small text-white-50 mb-0 fw-semibold" for="saveToLibrarySearch">Find the song on MusicBrainz</label>
            <input type="text" class="form-control form-control-sm" id="saveToLibrarySearch" value="${escapeHtml([initialTitle, initialArtist].filter(Boolean).join(' '))}" placeholder="Song title and artist" autocomplete="off">
            <div id="saveToLibraryResults" class="d-flex flex-column gap-1" style="max-height: 240px; overflow-y: auto;"></div>
          </div>
          <div id="saveToLibraryCustomFields" class="d-flex flex-column gap-3" style="display: none !important;">
            <div>
              <label class="form-label small text-white-50 mb-1 fw-semibold" for="saveToLibraryTitle">Title</label>
              <input type="text" class="form-control form-control-sm" id="saveToLibraryTitle" value="${escapeHtml(initialTitle)}" autocomplete="off">
            </div>
            <div>
              <label class="form-label small text-white-50 mb-1 fw-semibold" for="saveToLibraryArtist">Artist</label>
              <input type="text" class="form-control form-control-sm" id="saveToLibraryArtist" value="${escapeHtml(isClassical ? '' : initialArtist)}" placeholder="Custom Music" autocomplete="off">
            </div>
            <div>
              <label class="form-label small text-white-50 mb-1 fw-semibold" for="saveToLibraryAlbum">Folder (Optional)</label>
              <input type="text" class="form-control form-control-sm" id="saveToLibraryAlbum" value="${escapeHtml(initialAlbum)}" autocomplete="off">
            </div>
          </div>
          ${tuningLine ? `<div class="small text-muted" id="saveToLibraryTuningLine">Tuning \u00b7 ${escapeHtml(tuningLine)}.${/\.(gp[345x]?)$/i.test(file.name) ? '' : ' Change it in the Song menu.'}</div>` : ''}
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
        resultsEl.innerHTML = results.map((r, i) => {
            const coverSrc = getSynchronousCachedArtUrl(r.coverUrl) || r.coverUrl || getPlaceholderCoverSvg(r.title);
            return `
          <button type="button" class="btn btn-theme-outline text-start d-flex align-items-center gap-2 p-2 save-to-library-result ${selected?.id === r.id ? 'active' : ''}" data-index="${i}">
            <img src="${escapeHtml(coverSrc)}" width="36" height="36" class="shelf-cover rounded flex-shrink-0" style="object-fit: cover;" alt="" onerror="this.style.visibility='hidden'">
            <span class="min-w-0 flex-grow-1">
              <span class="d-block fw-semibold text-truncate">${escapeHtml(r.title)}</span>
              <span class="d-block small text-muted text-truncate">${escapeHtml(r.artist)}${r.album ? ` • ${escapeHtml(r.album)}` : ''}${r.year ? ` • ${r.year}` : ''}</span>
            </span>
            ${selected?.id === r.id ? '<i class="bi-check-lg flex-shrink-0"></i>' : ''}
          </button>`;
        }).join('');
        hydrateCachedImages(resultsEl);
        resultsEl.querySelectorAll('.save-to-library-result').forEach(btn => {
            btn.addEventListener('click', () => {
                selected = results[Number(btn.dataset.index)];
                renderResults(results);
                syncMode();
            });
        });
    };

    const runSearch = async (useMtabIds = false) => {
        const q = searchInput.value.trim();
        const seq = ++searchSeq;
        const hasMtabIds = Boolean(useMtabIds && mtabSong && (mtabSong.recordingMbid || mtabSong.albumMbid || mtabSong.artistMbid));
        if (!q && !hasMtabIds) { resultsEl.innerHTML = ''; return; }
        resultsEl.innerHTML = '<div class="small text-muted text-center py-3">Searching...</div>';
        try {
            const [idMatch, searchList] = await Promise.all([
                hasMtabIds ? lookupMusicBrainzByIds(mtabSong).catch(() => null) : Promise.resolve(null),
                q ? searchMusicBrainz(q, 'song').catch(() => []) : Promise.resolve([])
            ]);
            if (seq !== searchSeq) return;
            const combined = [];
            if (idMatch) {
                combined.push(idMatch);
                if (!selected) selected = idMatch;
            }
            for (const item of (searchList || [])) {
                if (!combined.some(c => (c.recordingMbid && c.recordingMbid === item.recordingMbid) || (c.id && c.id === item.id))) {
                    combined.push(item);
                }
            }
            renderResults(combined.slice(0, 15));
            syncMode();
        } catch (err) {
            if (seq === searchSeq) resultsEl.innerHTML = `<div class="small text-danger-emphasis text-center py-3">Search failed: ${escapeHtml(err.message)}</div>`;
        }
    };

    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => runSearch(false), 400);
    });
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); runSearch(false); }
    });
    form.querySelectorAll('input[name="saveToLibraryKind"]').forEach(radio => radio.addEventListener('change', syncMode));
    syncMode();
    runSearch(true);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const isCustom = isCustomMode();
        const title = isCustom ? modal.querySelector('#saveToLibraryTitle').value.trim() : selected?.title;
        if (!title) return;
        const collectionId = modal.querySelector('#saveToLibraryCollection')?.value || DEFAULT_COLLECTION_ID;
        confirmBtn.disabled = true;
        try {
            let song;
            let merged = false;
            if (isCustom) {
                song = await saveSongToLibrary({
                    title,
                    artist: modal.querySelector('#saveToLibraryArtist').value.trim(),
                    album: albumInput.value.trim(),
                    isCustom: true,
                    tunings: savedTunings,
                    hiddenTunings: Array.isArray(file.hiddenTunings) ? file.hiddenTunings : [],
                    stringCount: meta?.stringCount || null
                }, collectionId);
            } else {
                const resolved = await resolveAndSaveOrMergeSong({
                    title,
                    artist: selected.artist,
                    artistMbid: selected.artistMbid || mtabSong?.artistMbid || null,
                    album: selected.album || mtabSong?.album || null,
                    albumMbid: selected.albumMbid || mtabSong?.albumMbid || null,
                    recordingMbid: selected.recordingMbid || mtabSong?.recordingMbid || null,
                    year: selected.year ?? mtabSong?.year ?? null,
                    length: selected.length ?? mtabSong?.length ?? null,
                    trackNumber: selected.trackNumber ?? mtabSong?.trackNumber ?? null,
                    mediumNumber: selected.mediumNumber ?? mtabSong?.mediumNumber ?? null,
                    coverUrl: selected.coverUrl || mtabSong?.coverUrl || null
                }, collectionId, { queryMusicBrainz: true });
                song = resolved.song;
                merged = resolved.merged;
            }
            const { tabOption } = await mapOpenFileToSong(file, song.id, isClassical && file.songTitle ? file.songTitle : file.name);
            file.librarySongId = song.id;
            file.tabId = tabOption.id;

            // Link any audio files and sync points attached to the open tab's key to the saved/merged library song
            try {
                const { getSongKey, rememberSongKey } = await import('./youtubePlayer.js');
                const { linkAudioFile } = await import('./audioSync/audioFileStore.js');
                const { attachLibraryAudio } = await import('./audioSync/libraryAudio.js');
                const { listRecords, saveRecord, isSyncSharedFromOriginal, setSyncSharedFromOriginal } = await import('./audioSync/syncStore.js');
                const openKey = getSongKey();
                const libKey = (song.artist && song.title) ? `${song.artist} - ${song.title}` : song.title;
                const enc = (s) => encodeURIComponent(String(s).toLowerCase());
                if (openKey) rememberSongKey(song.id, openKey, { filename: file.name, tabName: tabOption.name });
                if (libKey) rememberSongKey(song.id, libKey, { filename: file.name, tabName: tabOption.name });
                if (openKey && libKey) {
                    for (const slot of ['original', 'backing']) {
                        const audioId = localStorage.getItem(`audio_file_${enc(openKey)}_${slot}`);
                        if (audioId) {
                            localStorage.setItem(`audio_file_${enc(libKey)}_${slot}`, audioId);
                            localStorage.setItem(`real_audio_source_${enc(libKey)}_${slot}`, 'local');
                            await linkAudioFile(audioId, libKey).catch(() => {});
                            try { attachLibraryAudio(song, audioId, slot); } catch {}
                        }
                        const ytId = localStorage.getItem(`yt_track_${enc(openKey)}_${slot}`);
                        if (ytId) {
                            localStorage.setItem(`yt_track_${enc(libKey)}_${slot}`, ytId);
                        }
                    }
                    if (openKey.toLowerCase() !== libKey.toLowerCase()) {
                        for (const rec of listRecords(openKey)) {
                            if (rec?.media && Array.isArray(rec.points)) saveRecord(libKey, rec.media, rec.points);
                        }
                        if (isSyncSharedFromOriginal(openKey)) setSyncSharedFromOriginal(libKey, true);
                    }
                }
            } catch (_) {}

            closeModal();
            refreshSaveToLibraryBtn();
            showToast(merged ? `Added tab to "${song.title}" in your library.` : `Saved "${song.title || title}" to your library.`, 'success');
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
