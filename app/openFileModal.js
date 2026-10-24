// openFileModal.js
// Library page view offering all file providers for direct opening while highlighting the benefits of Library integration.

import { getFileProviders, openFromProvider } from './fileProviders.js';

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Renders the Open File page into the library content container.
 * @param {HTMLElement} container
 * @param {{ onBack: () => void, onAddToLibrary: () => void }} handlers
 */
export function renderOpenFileView(container, { onBack, onAddToLibrary }) {
    const providers = getFileProviders();

    container.innerHTML = `
    <div class="library-page-container open-file-view">
      <div class="library-body-header d-flex align-items-center mb-3">
        <div class="d-flex align-items-center gap-3 min-w-0">
          <button class="btn btn-sm btn-theme-outline lib-open-file-btn flex-shrink-0" id="openFileBackBtn" title="Back to Tab Library">
            <i class="bi-chevron-left"></i> <span>Library</span>
          </button>
          <span class="small fw-semibold text-white-50 text-truncate"><i class="bi-folder2-open me-2 text-info"></i>Open tab file</span>
        </div>
      </div>

      <div class="mx-auto" style="max-width: 640px;">
        <!-- Library Benefits Callout -->
        <div class="open-file-benefits-card p-3 rounded-3 mb-2">
          <div class="d-flex align-items-center justify-content-between gap-2 mb-1 flex-wrap flex-sm-nowrap">
            <div class="d-flex align-items-center gap-2">
              <span class="badge badge-theme-primary px-2 py-1 flex-shrink-0" style="font-size: 0.68rem;">
                <i class="bi-stars me-1 text-warning"></i> Recommended
              </span>
              <span class="fw-bold text-white small">Why add tabs to your Library?</span>
            </div>
            <button type="button" class="btn btn-sm btn-theme-outline py-1 px-3 d-flex align-items-center gap-2 flex-shrink-0" id="openFileSwitchToLibraryBtn" style="font-size: 0.75rem;">
              <i class="bi-plus-lg"></i> <span>Add to Library</span>
            </button>
          </div>

          <details class="open-file-benefits-details">
            <summary class="small text-white-50 d-flex align-items-center gap-1 pt-1" style="cursor: pointer; font-size: 0.78rem;">
              <span>Learn why tabs are better in Tab Library...</span>
              <i class="bi-chevron-down ms-1" style="font-size: 0.7rem;"></i>
            </summary>
            <div class="pt-2">
              <p class="small text-white-50 mb-2" style="line-height: 1.45; font-size: 0.78rem;">
                Opening a file directly loads it for a quick one-off session. Adding tabs into your <strong>Tab Library</strong> provides significant advantages:
              </p>
              <div class="d-flex flex-column gap-2">
                <div class="d-flex align-items-start gap-2 small text-white-50" style="font-size: 0.78rem;">
                  <i class="bi-collection-play text-info mt-1 flex-shrink-0 fs-6"></i>
                  <div><strong class="text-white">Smart music catalog:</strong> Automatically categorizes songs by artist and album with official cover art, release years, and tracklists.</div>
                </div>
                <div class="d-flex align-items-start gap-2 small text-white-50" style="font-size: 0.78rem;">
                  <i class="bi-music-note-list text-warning mt-1 flex-shrink-0 fs-6"></i>
                  <div><strong class="text-white">Multiple tab variations:</strong> Attach multiple tabs to a single song.</div>
                </div>
                <div class="d-flex align-items-start gap-2 small text-white-50" style="font-size: 0.78rem;">
                  <i class="bi-lightning-charge text-success mt-1 flex-shrink-0 fs-6"></i>
                  <div><strong class="text-white">Instant 1-click access:</strong> Launch and switch tabs instantly anytime without digging through folders or cloud dialogs.</div>
                </div>
              </div>
            </div>
          </details>
        </div>

        <!-- Section Header -->
        <div class="d-flex align-items-center justify-content-between mt-1 mb-2 px-1">
          <span class="small fw-semibold text-white-50" style="font-size: 0.78rem; letter-spacing: 0.02em;">CHOOSE A FILE PROVIDER TO OPEN DIRECTLY</span>
        </div>

        <!-- Providers List -->
        <div class="d-flex flex-column gap-2" id="openFileProvidersList">
          ${providers.map(p => `
            <div class="open-file-provider-item p-3 rounded-3 d-flex align-items-center justify-content-between gap-3" data-provider-id="${escapeHtml(p.id)}" role="button" tabindex="0">
              <div class="d-flex align-items-center gap-3 min-w-0 flex-grow-1">
                <div class="provider-icon-wrapper d-flex align-items-center justify-content-center rounded-3 flex-shrink-0">
                  <i class="${escapeHtml(p.icon || 'bi-file-earmark')} ${escapeHtml(p.iconColorClass || 'text-primary')} fs-4"></i>
                </div>
                <div class="min-w-0 flex-grow-1">
                  <div class="d-flex align-items-center gap-2 mb-1 flex-wrap">
                    <span class="fw-bold text-white small">${escapeHtml(p.name)}</span>
                    ${p.badge ? `<span class="badge badge-theme-secondary py-0 px-2" style="font-size: 0.65rem;">${escapeHtml(p.badge)}</span>` : ''}
                  </div>
                  <div class="small text-muted text-truncate-2" style="font-size: 0.76rem; line-height: 1.35;">
                    ${escapeHtml(p.description || 'Load tabs from this provider')}
                  </div>
                </div>
              </div>
              <div class="flex-shrink-0">
                <button type="button" class="btn btn-sm btn-theme-outline py-1 px-3 provider-action-trigger" tabindex="-1">
                  <span class="provider-action-label">${escapeHtml(p.actionLabel || 'Open')}</span> <i class="bi-chevron-right ms-1"></i>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
    `;

    // On larger screens, keep details open by default; on mobile (<=576px), collapsed
    const isPhone = typeof window !== 'undefined' && window.innerWidth <= 576;
    const details = container.querySelector('.open-file-benefits-details');
    if (details && !isPhone) {
        details.open = true;
    }

    container.querySelector('#openFileBackBtn')?.addEventListener('click', onBack);
    container.querySelector('#openFileSwitchToLibraryBtn')?.addEventListener('click', onAddToLibrary);

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
