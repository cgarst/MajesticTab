// bulkExportTool.js
// Bulk export page in Tools:
// 1. Library metadata: CSV containing artist, album, song, youtube url, youtube backing url, sync data
// 2. Original tab files: All .gp, .pdf, .txt files from library and storage bundled into a ZIP
// 3. PDF export: Condensed A4 printable PDFs using pdfProcessor and pdf-lib, either as a ZIP or individual downloads

import { getAllSongs, getCollections } from '../libraryStore.js';
import { getAllStoredFiles, getStoredFile } from '../fileStore.js';
import {
    exportMetadataCsv,
    buildOriginalsZipEntries,
    renderCondensedPdf,
    createZip,
    saveOrDownloadBlob,
    safeName,
    uniquePath
} from './bulkExportCore.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Global state remembered between draws
const state = {
    activeMode: 'metadata', // 'metadata' | 'originals' | 'pdf'
    running: false,
    abortController: null,
    statusText: '',
    progressPct: 0,
    includeUnlinkedOriginals: true,
    scale: 1.5,
    bundlePdfZip: true,
    pdfFiles: [], // { file, displayName, exportKey, startPage, endPage, selected, status: 'idle'|'working'|'done'|'error', errorText }
    processedPdfKeys: new Set(),
    cachedSongs: null,
    cachedCollections: null,
    cachedStoredFiles: null,
    readyExport: null
};

const listeners = new Set();
const notify = () => listeners.forEach((cb) => { try { cb(); } catch (e) { console.error('[BulkExport]', e); } });

/** Readout for the Tools destination row */
export function bulkExportReadout() {
    return state.running ? (state.statusText || 'Exporting…') : '';
}

export function renderBulkExportTool(container) {
    let alive = true;
    const root = document.createElement('div');
    root.className = 'be-root';
    container.appendChild(root);

    const onStateChange = () => { if (alive) patchOrRender(); };
    listeners.add(onStateChange);

    async function loadData() {
        try {
            const [songs, collections, storedFiles] = await Promise.all([
                getAllSongs().catch(() => []),
                getCollections().catch(() => []),
                getAllStoredFiles().catch(() => [])
            ]);
            if (!alive) return;
            state.cachedSongs = songs;
            state.cachedCollections = collections;
            state.cachedStoredFiles = storedFiles;
            render();
        } catch (e) {
            console.error('[BulkExport] Error loading library data:', e);
        }
    }

    function patchOrRender() {
        if (!alive || !root.isConnected) return;
        render();
    }

    function renderModesHtml() {
        return `
        <div class="be-modes" role="tablist" aria-label="Bulk export modes">
          <button type="button" class="be-mode-btn" data-mode="metadata" role="tab" aria-selected="${state.activeMode === 'metadata'}" ${state.running ? 'disabled' : ''}>Library metadata</button>
          <button type="button" class="be-mode-btn" data-mode="originals" role="tab" aria-selected="${state.activeMode === 'originals'}" ${state.running ? 'disabled' : ''}>Original tab files</button>
          <button type="button" class="be-mode-btn" data-mode="pdf" role="tab" aria-selected="${state.activeMode === 'pdf'}" ${state.running ? 'disabled' : ''}>PDF export</button>
        </div>`;
    }

    function renderMetadataHtml() {
        const songs = state.cachedSongs || [];
        const metadata = exportMetadataCsv({ songs, collections: state.cachedCollections || [] });
        const { totalSongs, songsWithOriginalVideo, songsWithBackingVideo, songsWithSync } = metadata.stats;

        const statsText = [
            `${totalSongs} ${totalSongs === 1 ? 'song' : 'songs'}`,
            `${songsWithOriginalVideo} with YouTube audio`,
            `${songsWithBackingVideo} with backing track`,
            `${songsWithSync} with sync points`
        ].join(' \u00b7 ');

        return `
        <div class="be-section">
          <p class="ct-sub">Export your entire library’s metadata into a CSV spreadsheet. Includes artist, album, song title, linked YouTube original and backing audio URLs, audio sync points, tunings, tab filenames and release year.</p>
          <div class="be-card">
            <div class="be-stats-row"><span class="be-stats-label">${esc(statsText)}</span></div>
            <div class="be-info-sub">Columns: artist, album, song, youtube url, youtube backing url, sync data, tunings, tab_files, year</div>
          </div>
          <div class="be-actions">
            <button type="button" class="btn btn-sm btn-theme-primary" data-act="export-metadata" ${state.running || totalSongs === 0 ? 'disabled' : ''}>
              Export metadata as CSV
            </button>
            ${state.readyExport?.mode === 'metadata' && !state.running ? `<button type="button" class="btn btn-sm btn-theme-outline d-inline-flex align-items-center gap-2" data-act="share-ready"><i class="bi-share"></i> Save / Share (${esc(state.readyExport.filename)})</button>` : ''}
            ${state.statusText ? `<span class="be-status" role="status">${esc(state.statusText)}</span>` : ''}
          </div>
        </div>`;
    }

    function renderOriginalsHtml() {
        const songs = state.cachedSongs || [];
        const stored = state.cachedStoredFiles || [];
        const totalTabs = songs.reduce((n, s) => n + (Array.isArray(s.tabOptions) ? s.tabOptions.length : 0), 0);

        const statsText = `${totalTabs} tab ${totalTabs === 1 ? 'file' : 'files'} across ${songs.length} ${songs.length === 1 ? 'song' : 'songs'} \u00b7 ${stored.length} total stored items`;

        return `
        <div class="be-section">
          <p class="ct-sub">Export every tab file in your library (.gp, .gp3, .gp4, .gp5, .gpx, .pdf, .txt), organized into artist and album folders inside a single ZIP archive.</p>
          <div class="be-card">
            <div class="be-stats-row"><span class="be-stats-label">${esc(statsText)}</span></div>
            <label class="be-option">
              <input type="checkbox" class="form-check-input" data-act="toggle-unlinked" ${state.includeUnlinkedOriginals ? 'checked' : ''} ${state.running ? 'disabled' : ''}>
              <span class="be-option-text">
                <span class="be-option-title">Include unlinked tab files from storage</span>
                <span class="be-option-sub">Placed under an Unsorted folder</span>
              </span>
            </label>
          </div>
          <div class="be-actions">
            <button type="button" class="btn btn-sm btn-theme-primary" data-act="export-originals" ${state.running || (totalTabs === 0 && stored.length === 0) ? 'disabled' : ''}>
              Export original tabs as ZIP
            </button>
            ${state.running ? '<button type="button" class="ct-text" data-act="cancel">Cancel</button>' : ''}
            ${state.readyExport?.mode === 'originals' && !state.running ? `<button type="button" class="btn btn-sm btn-theme-outline d-inline-flex align-items-center gap-2" data-act="share-ready"><i class="bi-share"></i> Save / Share (${esc(state.readyExport.filename)})</button>` : ''}
            ${state.statusText ? `<span class="be-status" role="status">${esc(state.statusText)}</span>` : ''}
          </div>
        </div>`;
    }

    function renderPdfHtml() {
        const selectedCount = state.pdfFiles.filter((f) => f.selected).length;
        const totalCount = state.pdfFiles.length;

        return `
        <div class="be-section">
          <p class="ct-sub">Re-render and condense tab PDFs from your library or local files into compact A4 printable pages, eliminating empty space between musical systems.</p>

          <div class="be-dropzone" id="bePdfDropzone" role="button" tabindex="0" aria-label="Drop PDF files here or browse your device">
            <div class="be-dropzone-title">Drop PDF tabs here</div>
            <div class="be-dropzone-sub">Supports single or multi-page tab PDFs</div>
            <button type="button" class="btn btn-sm btn-theme-outline mt-2" tabindex="-1">Browse files</button>
            <input type="file" id="bePdfFileInput" multiple accept=".pdf" style="display: none">
          </div>

          <div class="be-listhead">
            <button type="button" class="btn btn-sm btn-theme-outline" data-act="load-library-pdfs" ${state.running ? 'disabled' : ''}>
              Add all PDFs from library
            </button>
            ${totalCount > 0 ? `
            <div class="be-listhead-actions">
              <span>${totalCount} ${totalCount === 1 ? 'file' : 'files'} · ${selectedCount} selected</span>
              <button type="button" class="ct-text" data-act="select-all-pdfs" ${state.running ? 'disabled' : ''}>Select all</button>
              <button type="button" class="ct-text" data-act="select-none-pdfs" ${state.running ? 'disabled' : ''}>Select none</button>
              <button type="button" class="ct-text" data-act="clear-pdfs" ${state.running ? 'disabled' : ''}>Clear</button>
            </div>` : ''}
          </div>

          ${totalCount > 0 ? `
          <div class="be-file-list" role="group" aria-label="PDF files to export">
            ${state.pdfFiles.map((f, i) => `
              <div class="be-file-row ${f.status === 'working' ? 'be-row-working' : ''}">
                <label class="be-file-label">
                  <input type="checkbox" class="form-check-input" data-pdf-index="${i}" ${f.selected ? 'checked' : ''} ${state.running ? 'disabled' : ''}>
                  <span class="be-file-title" title="${esc(f.displayName || f.file.name)}">${esc(f.displayName || f.file.name)}</span>
                </label>
                <div class="be-file-meta">
                  ${f.status === 'done' ? '<span class="be-badge-done"><i class="bi-check-circle-fill"></i> Done</span>' : ''}
                  ${f.status === 'working' ? '<span class="be-badge-working"><span class="spinner-border spinner-border-sm" role="status"></span> Processing…</span>' : ''}
                  ${f.status === 'error' ? `<span class="be-badge-error" title="${esc(f.errorText || 'Failed')}">Error</span>` : ''}
                  <button type="button" class="ct-text be-remove-btn" data-act="remove-pdf" data-index="${i}" ${state.running ? 'disabled' : ''} aria-label="Remove">
                    <i class="bi-x-lg" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
            `).join('')}
          </div>` : ''}

          <div class="be-card mt-2">
            <div class="be-setting-row">
              <label for="beScaleInput" class="be-setting-label">Render scale:</label>
              <input type="number" id="beScaleInput" class="be-scale-input" value="${state.scale}" min="0.5" max="3.0" step="0.1" ${state.running ? 'disabled' : ''}>
              <span class="be-setting-hint">(Higher = sharper, slower. Default: 1.5)</span>
            </div>
            <label class="be-option">
              <input type="checkbox" class="form-check-input" data-act="toggle-pdf-zip" ${state.bundlePdfZip ? 'checked' : ''} ${state.running ? 'disabled' : ''}>
              <span class="be-option-text">
                <span class="be-option-title">Bundle exported PDFs into a single ZIP</span>
                <span class="be-option-sub">Uncheck to download each PDF separately</span>
              </span>
            </label>
          </div>

          <div class="be-actions">
            <button type="button" class="btn btn-sm btn-theme-primary" data-act="export-pdf" ${state.running || selectedCount === 0 ? 'disabled' : ''}>
              Process and export PDFs
            </button>
            ${state.running ? '<button type="button" class="ct-text" data-act="cancel">Cancel</button>' : ''}
            ${state.readyExport?.mode === 'pdf' && !state.running ? `<button type="button" class="btn btn-sm btn-theme-outline d-inline-flex align-items-center gap-2" data-act="share-ready"><i class="bi-share"></i> Save / Share (${esc(state.readyExport.filename)})</button>` : ''}
            ${state.statusText ? `<span class="be-status" role="status">${esc(state.statusText)}</span>` : ''}
          </div>
        </div>`;
    }

    function render() {
        if (!alive || !root.isConnected) return;
        const progressBarHtml = state.running
            ? `<div class="be-progress-track" role="progressbar" aria-valuenow="${state.progressPct}" aria-valuemin="0" aria-valuemax="100">
                 <div class="be-progress-fill" style="width: ${state.progressPct}%"></div>
               </div>`
            : '';

        let modeContentHtml = '';
        if (state.activeMode === 'metadata') modeContentHtml = renderMetadataHtml();
        else if (state.activeMode === 'originals') modeContentHtml = renderOriginalsHtml();
        else if (state.activeMode === 'pdf') modeContentHtml = renderPdfHtml();

        root.innerHTML = `
          ${renderModesHtml()}
          ${progressBarHtml}
          ${modeContentHtml}
        `;
    }

    // --- Action Handlers -----------------------------------------------------------------------------------------

    async function handleExportMetadata() {
        if (state.running) return;
        state.running = true;
        state.statusText = 'Generating CSV…';
        state.progressPct = 25;
        notify();

        try {
            const songs = state.cachedSongs || (await getAllSongs().catch(() => []));
            const collections = state.cachedCollections || (await getCollections().catch(() => []));
            state.progressPct = 50;
            notify();

            const { csvString, count } = exportMetadataCsv({ songs, collections });
            state.progressPct = 80;
            notify();

            const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
            const today = new Date().toISOString().slice(0, 10);
            const filename = `MajesticTab_Metadata_${today}.csv`;
            const file = new File([blob], filename, { type: 'text/csv' });
            state.readyExport = { file, filename, mode: 'metadata' };

            await saveOrDownloadBlob(file, filename);
            state.statusText = `Exported ${count} ${count === 1 ? 'song' : 'songs'} to CSV`;
            state.progressPct = 100;
        } catch (err) {
            console.error('[BulkExport] Error exporting metadata CSV:', err);
            state.statusText = 'Export failed';
        } finally {
            state.running = false;
            notify();
        }
    }

    async function handleExportOriginals() {
        if (state.running) return;
        state.running = true;
        state.abortController = new AbortController();
        state.statusText = 'Reading library tab files…';
        state.progressPct = 5;
        notify();

        try {
            const songs = state.cachedSongs || (await getAllSongs().catch(() => []));
            const collections = state.cachedCollections || (await getCollections().catch(() => []));
            const allStored = state.cachedStoredFiles || (await getAllStoredFiles().catch(() => []));

            const result = await buildOriginalsZipEntries({
                songs,
                collections,
                allStoredFiles: allStored,
                getStoredFile,
                includeUnlinked: state.includeUnlinkedOriginals,
                abortSignal: state.abortController.signal,
                onProgress: (done, total, msg) => {
                    state.progressPct = Math.round((done / Math.max(1, total)) * 80);
                    state.statusText = msg;
                    notify();
                }
            });

            if (!result || state.abortController.signal.aborted) {
                state.statusText = 'Export cancelled';
                return;
            }

            if (result.count === 0) {
                state.statusText = 'No tab files found';
                return;
            }

            state.statusText = 'Building ZIP…';
            state.progressPct = 90;
            notify();

            await new Promise((r) => setTimeout(r, 10));
            const zipped = createZip(result.entries);

            state.statusText = 'Saving ZIP…';
            state.progressPct = 95;
            notify();

            const today = new Date().toISOString().slice(0, 10);
            const filename = `MajesticTab_Original_Tabs_${today}.zip`;
            const blob = new Blob([zipped], { type: 'application/zip' });
            const file = new File([blob], filename, { type: 'application/zip' });
            state.readyExport = { file, filename, mode: 'originals' };

            await saveOrDownloadBlob(file, filename);
            state.statusText = `Exported ${result.count} tab ${result.count === 1 ? 'file' : 'files'}`;
            state.progressPct = 100;
        } catch (err) {
            if (state.abortController?.signal.aborted) {
                state.statusText = 'Export cancelled';
            } else {
                console.error('[BulkExport] Error exporting originals ZIP:', err);
                state.statusText = 'Export failed';
            }
        } finally {
            state.running = false;
            state.abortController = null;
            notify();
        }
    }

    async function handleAddLibraryPdfs() {
        if (state.running) return;
        state.statusText = 'Loading library PDFs…';
        notify();

        try {
            const songs = state.cachedSongs || (await getAllSongs().catch(() => []));
            let addedCount = 0;

            for (const song of songs) {
                const tabs = Array.isArray(song.tabOptions) ? song.tabOptions : [];
                for (const t of tabs) {
                    const isPdf = (t.name || t.relativePath || '').toLowerCase().endsWith('.pdf') ||
                        t.fileType === 'pdf' ||
                        Boolean(t.isPdf) ||
                        Boolean(t.startPage);
                    if (!isPdf || !t.fileStoreId) continue;

                    const stored = await getStoredFile(t.fileStoreId);
                    if (!stored?.file) continue;

                    const startPage = t.startPage ? parseInt(t.startPage, 10) : null;
                    const endPage = t.endPage ? parseInt(t.endPage, 10) : null;
                    const fileObj = new File([stored.file], stored.file.name, {
                        type: stored.file.type || 'application/pdf'
                    });
                    fileObj.startPage = startPage;
                    fileObj.endPage = endPage;

                    const displayName = song.title
                        ? `${song.artist ? `${song.artist} - ` : ''}${song.title}${startPage ? ` (pp. ${startPage}-${endPage})` : ''}`
                        : fileObj.name;
                    const exportKey = `${song.id || ''}_${t.id || ''}_${fileObj.name}_${startPage || ''}_${endPage || ''}`;

                    if (!state.pdfFiles.some((f) => f.exportKey === exportKey)) {
                        state.pdfFiles.push({
                            file: fileObj,
                            displayName,
                            exportKey,
                            startPage,
                            endPage,
                            selected: true,
                            status: 'idle',
                            errorText: ''
                        });
                        addedCount++;
                    }
                }
            }

            state.statusText = addedCount > 0
                ? `Added ${addedCount} library PDF ${addedCount === 1 ? 'tab' : 'tabs'}`
                : 'All library PDFs already added';
        } catch (err) {
            console.error('[BulkExport] Error loading library PDFs:', err);
            state.statusText = 'Could not load library PDFs';
        } finally {
            notify();
        }
    }

    function addLocalPdfFiles(files) {
        let added = 0;
        for (const file of files) {
            if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
                const exportKey = `local_${file.name}_${file.size}_${file.lastModified}`;
                if (!state.pdfFiles.some((f) => f.exportKey === exportKey)) {
                    state.pdfFiles.push({
                        file,
                        displayName: file.name,
                        exportKey,
                        startPage: null,
                        endPage: null,
                        selected: true,
                        status: 'idle',
                        errorText: ''
                    });
                    added++;
                }
            }
        }
        if (added > 0) {
            state.statusText = `Added ${added} PDF ${added === 1 ? 'file' : 'files'}`;
            notify();
        }
    }

    async function handleExportPdfs() {
        const toProcess = state.pdfFiles.filter((f) => f.selected);
        if (!toProcess.length || state.running) return;

        state.running = true;
        state.abortController = new AbortController();
        const signal = state.abortController.signal;
        state.statusText = `Starting export of ${toProcess.length} PDFs…`;
        state.progressPct = 0;
        notify();

        const zipEntries = {};
        const zipNames = new Set();
        let successCount = 0;

        try {
            for (let i = 0; i < toProcess.length; i++) {
                if (signal.aborted) break;
                const item = toProcess[i];
                item.status = 'working';
                state.statusText = `Rendering ${i + 1} of ${toProcess.length}: ${item.displayName}…`;
                state.progressPct = Math.round((i / toProcess.length) * 100);
                notify();

                try {
                    const pdfBytes = await renderCondensedPdf({
                        file: item.file,
                        scale: state.scale,
                        abortSignal: signal,
                        onProgress: (pct, msg) => {
                            if (msg) state.statusText = `${item.displayName}: ${msg}`;
                            notify();
                        }
                    });

                    if (signal.aborted || !pdfBytes) {
                        item.status = 'idle';
                        break;
                    }

                    const pdfName = item.displayName
                        ? `Majestic_${safeName(item.displayName).replace(/\.pdf$/i, '')}.pdf`
                        : `Majestic_${safeName(item.file.name)}`;

                    if (state.bundlePdfZip) {
                        zipEntries[uniquePath(pdfName, zipNames)] = [pdfBytes, { level: 0 }];
                    } else {
                        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
                        await saveOrDownloadBlob(blob, pdfName);
                    }

                    item.status = 'done';
                    state.processedPdfKeys.add(item.exportKey);
                    successCount++;
                } catch (itemErr) {
                    console.error(`[BulkExport] Error processing PDF ${item.displayName}:`, itemErr);
                    item.status = 'error';
                    item.errorText = itemErr.message || 'Error';
                }
                notify();
            }

            if (signal.aborted) {
                state.statusText = 'PDF export cancelled';
                return;
            }

            if (state.bundlePdfZip && Object.keys(zipEntries).length > 0) {
                state.statusText = 'Building ZIP bundle…';
                state.progressPct = 95;
                notify();

                await new Promise((r) => setTimeout(r, 10));
                const zipped = createZip(zipEntries);
                const today = new Date().toISOString().slice(0, 10);
                const filename = `MajesticTab_Condensed_PDFs_${today}.zip`;
                const blob = new Blob([zipped], { type: 'application/zip' });
                const file = new File([blob], filename, { type: 'application/zip' });
                state.readyExport = { file, filename, mode: 'pdf' };
                await saveOrDownloadBlob(file, filename);
            }

            state.statusText = `Successfully exported ${successCount} PDF ${successCount === 1 ? 'file' : 'files'}`;
            state.progressPct = 100;
        } catch (err) {
            console.error('[BulkExport] Error during PDF export:', err);
            state.statusText = 'Export encountered an error';
        } finally {
            state.running = false;
            state.abortController = null;
            notify();
        }
    }

    // --- DOM Event Listeners -------------------------------------------------------------------------------------

    root.addEventListener('click', (e) => {
        const modeBtn = e.target.closest('button[data-mode]');
        if (modeBtn && !state.running) {
            state.activeMode = modeBtn.dataset.mode;
            state.statusText = '';
            render();
            return;
        }

        const actBtn = e.target.closest('[data-act]');
        if (!actBtn) return;
        const act = actBtn.dataset.act;

        if (act === 'export-metadata') handleExportMetadata();
        else if (act === 'export-originals') handleExportOriginals();
        else if (act === 'export-pdf') handleExportPdfs();
        else if (act === 'load-library-pdfs') handleAddLibraryPdfs();
        else if (act === 'select-all-pdfs') {
            state.pdfFiles.forEach((f) => { f.selected = true; });
            render();
        } else if (act === 'select-none-pdfs') {
            state.pdfFiles.forEach((f) => { f.selected = false; });
            render();
        } else if (act === 'clear-pdfs') {
            state.pdfFiles = [];
            state.statusText = '';
            render();
        } else if (act === 'remove-pdf') {
            const idx = parseInt(actBtn.dataset.index, 10);
            if (!Number.isNaN(idx)) {
                state.pdfFiles.splice(idx, 1);
                render();
            }
        } else if (act === 'share-ready') {
            if (state.readyExport?.file) {
                saveOrDownloadBlob(state.readyExport.file, state.readyExport.filename, { forcePrompt: false });
            }
        } else if (act === 'cancel') {
            if (state.abortController) state.abortController.abort();
        }
    });

    root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.act === 'toggle-unlinked') {
            state.includeUnlinkedOriginals = t.checked;
        } else if (t.dataset.act === 'toggle-pdf-zip') {
            state.bundlePdfZip = t.checked;
        } else if (t.id === 'beScaleInput') {
            const val = parseFloat(t.value);
            if (!Number.isNaN(val) && val >= 0.5 && val <= 3.0) {
                state.scale = val;
            }
        } else if (t.dataset.pdfIndex != null) {
            const idx = parseInt(t.dataset.pdfIndex, 10);
            if (state.pdfFiles[idx]) {
                state.pdfFiles[idx].selected = t.checked;
                render();
            }
        } else if (t.id === 'bePdfFileInput') {
            if (t.files?.length) addLocalPdfFiles(t.files);
        }
    });

    // Drag and drop for PDF dropzone
    root.addEventListener('dragover', (e) => {
        const drop = e.target.closest('#bePdfDropzone');
        if (drop) {
            e.preventDefault();
            drop.classList.add('is-dragover');
        }
    });

    root.addEventListener('dragleave', (e) => {
        const drop = e.target.closest('#bePdfDropzone');
        if (drop && !drop.contains(e.relatedTarget)) {
            drop.classList.remove('is-dragover');
        }
    });

    root.addEventListener('drop', (e) => {
        const drop = e.target.closest('#bePdfDropzone');
        if (drop) {
            e.preventDefault();
            drop.classList.remove('is-dragover');
            if (e.dataTransfer?.files?.length) {
                addLocalPdfFiles(e.dataTransfer.files);
            }
        }
    });

    // Clicking dropzone triggers file picker
    root.addEventListener('click', (e) => {
        const drop = e.target.closest('#bePdfDropzone');
        if (drop && !e.target.closest('input')) {
            const input = root.querySelector('#bePdfFileInput');
            if (input) input.click();
        }
    });

    // Initial load
    render();
    loadData();

    return () => {
        alive = false;
        listeners.delete(onStateChange);
        if (state.abortController) {
            state.abortController.abort();
            state.running = false;
        }
    };
}
