// openFileModal.js
// "Open tab file" library view: drop zone for local files, a grid of file providers,
// and a slim Library callout.

import { getFileProviders, openFromProvider, openLocalFile } from './fileProviders.js';

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Renders the Open Tab File view into the library page container.
 * @param {HTMLElement} container
 * @param {{onBack: function(): void, onAddToLibrary: function(): void}} handlers
 */
export function renderOpenFileView(container, { onBack, onAddToLibrary }) {
    // The local device is covered by the drop zone above
    const providers = getFileProviders().filter(p => p.id !== 'local');

    container.innerHTML = `
    <div class="library-page-container open-file-view">
      <div class="library-body-header d-flex align-items-center justify-content-between mb-3">
        <div class="d-flex align-items-center gap-3 min-w-0">
          <button class="btn btn-sm btn-theme-outline lib-open-file-btn flex-shrink-0" id="openFileBackBtn" title="Back to Tab Library">
            <i class="bi-chevron-left"></i> <span>Library</span>
          </button>
          <span class="small fw-semibold text-white-50 text-truncate"><i class="bi-folder2-open me-2 text-info"></i>Open Tab File</span>
        </div>
      </div>

      <div class="open-file-dropzone" id="openFileDropzone" role="button" tabindex="0" aria-label="Drop a tab file here or browse your device">
        <i class="bi-cloud-arrow-up open-file-dropzone-icon"></i>
        <div class="open-file-dropzone-title">Drop a tab file here</div>
        <div class="open-file-dropzone-sub">Guitar Pro (.gp, .gp3, .gp4, .gp5, .gpx), PDF or text</div>
        <button type="button" class="btn btn-sm btn-theme-primary px-4 mt-3" id="openFileBrowseBtn" tabindex="-1">
          <i class="bi-folder2-open me-1"></i> Browse Files
        </button>
      </div>

      <div class="open-file-section-label">Or open from</div>
      <div class="open-file-provider-grid" id="openFileProvidersList">
        ${providers.map(p => `
          <div class="open-file-provider-item" data-provider-id="${escapeHtml(p.id)}" role="button" tabindex="0">
            <div class="provider-icon-wrapper d-flex align-items-center justify-content-center rounded-3 flex-shrink-0">
              <i class="${escapeHtml(p.icon || 'bi-file-earmark')} ${escapeHtml(p.iconColorClass || 'text-primary')} fs-4"></i>
            </div>
            <div class="min-w-0 flex-grow-1">
              <div class="d-flex align-items-center gap-2 flex-wrap">
                <span class="fw-bold text-white small">${escapeHtml(p.name)}</span>
                ${p.badge ? `<span class="badge badge-theme-secondary py-0 px-2 open-file-badge">${escapeHtml(p.badge)}</span>` : ''}
              </div>
              <div class="open-file-provider-desc">${escapeHtml(p.description || 'Load tabs from this provider')}</div>
            </div>
            <i class="bi-chevron-right open-file-provider-chevron flex-shrink-0"></i>
          </div>
        `).join('')}
      </div>

      <div class="open-file-library-callout">
        <div class="min-w-0">
          <div class="fw-bold text-white small">Keep your tabs in the Library</div>
          <div class="open-file-provider-desc">Get cover art, multiple tab versions per song and one-click access.</div>
        </div>
        <button type="button" class="btn btn-sm btn-theme-outline px-3 flex-shrink-0" id="openFileSwitchToLibraryBtn">
          <i class="bi-plus-lg me-1"></i> Add Music
        </button>
      </div>
    </div>
    `;

    container.querySelector('#openFileBackBtn')?.addEventListener('click', onBack);
    container.querySelector('#openFileSwitchToLibraryBtn')?.addEventListener('click', onAddToLibrary);

    // Drop zone: click/keyboard opens the file picker, drop opens the file directly
    const dropzone = container.querySelector('#openFileDropzone');
    const browse = () => openFromProvider('local');
    dropzone.addEventListener('click', browse);
    dropzone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            browse();
        }
    });
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('is-dragover');
    });
    dropzone.addEventListener('dragleave', (e) => {
        if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove('is-dragover');
    });
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('is-dragover');
        const file = e.dataTransfer?.files?.[0];
        if (file) openLocalFile(file);
    });

    // Providers
    container.querySelectorAll('.open-file-provider-item').forEach(item => {
        const handleOpen = () => openFromProvider(item.dataset.providerId);
        item.addEventListener('click', handleOpen);
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleOpen();
            }
        });
    });
}
