// bulkExportTool.js
// Bulk export page in Tools:
// 1. Library metadata: CSV containing artist, album, song, youtube url, youtube backing url, sync data
// 2. Original tab files: All .gp, .pdf, .txt files from library and storage bundled into a ZIP
// 3. PDF export: Runs all tabs in library through score PDF export, bundled into a ZIP

import { getAllSongs, getCollections } from '../libraryStore.js';
import { getAllStoredFiles, getStoredFile } from '../fileStore.js';
import {
    exportMetadataCsv,
    buildOriginalsZipEntries,
    buildLibraryPdfsZipEntries,
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
    includeUnlinkedPdfs: false,
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
        const songs = state.cachedSongs || [];
        const stored = state.cachedStoredFiles || [];
        const totalTabs = songs.reduce((n, s) => n + (Array.isArray(s.tabOptions) ? s.tabOptions.length : 0), 0);

        const statsText = `${totalTabs} tab ${totalTabs === 1 ? 'file' : 'files'} across ${songs.length} ${songs.length === 1 ? 'song' : 'songs'}`;

        return `
        <div class="be-section">
          <p class="ct-sub">Run every tab in your library through the score layout engine and export them as printable A4 PDFs, organized into artist and album folders inside a single ZIP archive.</p>
          <div class="be-card">
            <div class="be-stats-row"><span class="be-stats-label">${esc(statsText)}</span></div>
            <label class="be-option">
              <input type="checkbox" class="form-check-input" data-act="toggle-unlinked-pdfs" ${state.includeUnlinkedPdfs ? 'checked' : ''} ${state.running ? 'disabled' : ''}>
              <span class="be-option-text">
                <span class="be-option-title">Include unlinked tab files from storage</span>
                <span class="be-option-sub">Placed under an Unsorted folder</span>
              </span>
            </label>
          </div>
          <div class="be-actions">
            <button type="button" class="btn btn-sm btn-theme-primary" data-act="export-library-pdfs" ${state.running || (totalTabs === 0 && stored.length === 0) ? 'disabled' : ''}>
              Export all tabs as PDF (ZIP)
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

    async function handleExportLibraryPdfs() {
        if (state.running) return;
        state.running = true;
        state.abortController = new AbortController();
        const signal = state.abortController.signal;
        state.statusText = 'Preparing tabs for PDF export…';
        state.progressPct = 5;
        notify();

        try {
            const songs = state.cachedSongs || (await getAllSongs().catch(() => []));
            const collections = state.cachedCollections || (await getCollections().catch(() => []));
            const allStored = state.cachedStoredFiles || (await getAllStoredFiles().catch(() => []));

            const { renderTabFileToPdfBytes } = await import('../exportPdf.js');

            const result = await buildLibraryPdfsZipEntries({
                songs,
                collections,
                allStoredFiles: allStored,
                getStoredFile,
                renderTabToPdfFn: (file, opts) => renderTabFileToPdfBytes(file, { ...opts, abortSignal: signal }),
                includeUnlinked: state.includeUnlinkedPdfs,
                abortSignal: signal,
                onProgress: (done, total, msg) => {
                    state.progressPct = Math.round((done / Math.max(1, total)) * 85);
                    state.statusText = msg;
                    notify();
                }
            });

            if (!result || signal.aborted) {
                state.statusText = 'PDF export cancelled';
                return;
            }

            if (result.count === 0) {
                state.statusText = 'No tabs could be exported';
                return;
            }

            state.statusText = 'Building ZIP archive…';
            state.progressPct = 90;
            notify();

            await new Promise((r) => setTimeout(r, 10));
            const zipped = createZip(result.entries);

            state.statusText = 'Saving ZIP…';
            state.progressPct = 95;
            notify();

            const today = new Date().toISOString().slice(0, 10);
            const filename = `MajesticTab_Library_PDFs_${today}.zip`;
            const blob = new Blob([zipped], { type: 'application/zip' });
            const file = new File([blob], filename, { type: 'application/zip' });
            state.readyExport = { file, filename, mode: 'pdf' };

            await saveOrDownloadBlob(file, filename);
            state.statusText = `Exported ${result.count} PDF ${result.count === 1 ? 'file' : 'files'}`;
            state.progressPct = 100;
        } catch (err) {
            if (signal.aborted) {
                state.statusText = 'PDF export cancelled';
            } else {
                console.error('[BulkExport] Error during PDF bulk export:', err);
                state.statusText = 'PDF export failed';
            }
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
        else if (act === 'export-library-pdfs') handleExportLibraryPdfs();
        else if (act === 'share-ready') {
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
        } else if (t.dataset.act === 'toggle-unlinked-pdfs') {
            state.includeUnlinkedPdfs = t.checked;
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
