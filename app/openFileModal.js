// openFileModal.js
// Modal offering all file providers for direct opening while highlighting the benefits of Library integration.

import { getFileProviders, openFromProvider } from './fileProviders.js';
import { openLibraryModal } from './libraryModal.js';

let modalElement = null;

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Creates or gets the Open File Modal DOM element
 */
function getOrCreateModal() {
    if (modalElement && document.body.contains(modalElement)) {
        return modalElement;
    }

    let modal = document.getElementById('openFileModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'openFileModal';
        modal.className = 'theme-modal-backdrop';
        document.body.appendChild(modal);
    }
    modalElement = modal;
    return modal;
}

/**
 * Renders the content inside the Open File modal
 */
function renderModalContent(modal) {
    const providers = getFileProviders();

    modal.innerHTML = `
    <div class="theme-modal-card open-file-modal-card" style="max-width: 640px;">
      <!-- Modal Header -->
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          <div class="theme-modal-icon">
            <i class="bi-folder2-open text-primary fs-5"></i>
          </div>
          <div class="theme-modal-titles">
            <h5 class="modal-title mb-0 fs-6 fw-bold text-white">Open Tab File</h5>
            <div class="small text-muted" style="font-size: 0.78rem;">Choose a file provider to load a tab directly into MajesticTab</div>
          </div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="openFileModalCloseBtn" title="Close" aria-label="Close">
            <i class="bi-x-lg"></i>
          </button>
        </div>
      </div>

      <!-- Modal Body -->
      <div class="theme-modal-body p-3">
        <!-- Library Benefits Callout -->
        <div class="open-file-benefits-card p-3 rounded-3 mb-2">
          <div class="d-flex align-items-center justify-content-between gap-2 mb-2">
            <div class="d-flex align-items-center gap-2">
              <span class="badge badge-theme-primary px-2 py-1" style="font-size: 0.68rem;">
                <i class="bi-stars me-1 text-warning"></i> Recommended
              </span>
              <span class="fw-bold text-white small">Why add tabs to your Library?</span>
            </div>
            <button type="button" class="btn btn-sm btn-theme-outline py-1 px-3 d-flex align-items-center gap-2" id="openFileSwitchToLibraryBtn" style="font-size: 0.75rem;">
              <i class="bi-plus-lg"></i> Add to Library
            </button>
          </div>
          <p class="small text-white-50 mb-2" style="line-height: 1.45; font-size: 0.8rem;">
            Opening a file directly loads it for a quick one-off session. Adding tabs into your <strong>Tab Library</strong> provides significant advantages:
          </p>
          <div class="d-flex flex-column gap-2">
            <div class="d-flex align-items-start gap-2 small text-white-50" style="font-size: 0.78rem;">
              <i class="bi-collection-play text-info mt-1 flex-shrink-0 fs-6"></i>
              <div><strong class="text-white">Smart Music Catalog:</strong> Automatically categorizes songs by Artist &amp; Album with official cover art, release years, and tracklists.</div>
            </div>
            <div class="d-flex align-items-start gap-2 small text-white-50" style="font-size: 0.78rem;">
              <i class="bi-music-note-list text-warning mt-1 flex-shrink-0 fs-6"></i>
              <div><strong class="text-white">Multiple Tab Variations:</strong> Attach multiple tabs to a single song.</div>
            </div>
            <div class="d-flex align-items-start gap-2 small text-white-50" style="font-size: 0.78rem;">
              <i class="bi-lightning-charge text-success mt-1 flex-shrink-0 fs-6"></i>
              <div><strong class="text-white">Instant 1-Click Access:</strong> Launch and switch tabs instantly anytime without digging through folders or cloud dialogs.</div>
            </div>
          </div>
        </div>

        <!-- Section Header -->
        <div class="d-flex align-items-center justify-content-between mt-1 mb-2 px-1">
          <span class="small fw-semibold text-white-50" style="font-size: 0.78rem; letter-spacing: 0.02em;">CHOOSE A FILE PROVIDER TO OPEN DIRECTLY</span>
        </div>

        <!-- Providers List -->
        <div class="d-flex flex-column gap-2" id="openFileProvidersList">
          ${providers.map(p => `
            <div class="open-file-provider-item p-3 rounded-3 d-flex align-items-center justify-content-between gap-3" data-provider-id="${escapeHtml(p.id)}" role="button" tabindex="0">
              <div class="d-flex align-items-center gap-3 min-w-0">
                <div class="provider-icon-wrapper d-flex align-items-center justify-content-center rounded-3 flex-shrink-0">
                  <i class="${escapeHtml(p.icon || 'bi-file-earmark')} ${escapeHtml(p.iconColorClass || 'text-primary')} fs-4"></i>
                </div>
                <div class="min-w-0">
                  <div class="d-flex align-items-center gap-2 mb-1">
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
                  ${escapeHtml(p.actionLabel || 'Open')} <i class="bi-chevron-right ms-1"></i>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
    `;

    // Event: Close Button
    modal.querySelector('#openFileModalCloseBtn')?.addEventListener('click', closeOpenFileModal);

    // Event: Backdrop Click
    modal.onclick = (e) => {
        if (e.target === modal) {
            closeOpenFileModal();
        }
    };

    // Event: Switch to Add to Library
    modal.querySelector('#openFileSwitchToLibraryBtn')?.addEventListener('click', async () => {
        closeOpenFileModal();
        await openLibraryModal('search');
    });

    // Events: Provider Selection
    modal.querySelectorAll('.open-file-provider-item').forEach(item => {
        const handleOpen = () => {
            const providerId = item.dataset.providerId;
            closeOpenFileModal();
            openFromProvider(providerId);
        };

        item.addEventListener('click', handleOpen);
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleOpen();
            }
        });
    });
}

/**
 * Open the Open File modal
 */
export function openOpenFileModal() {
    const modal = getOrCreateModal();
    renderModalContent(modal);
    modal.style.display = 'flex';
    document.body.classList.add('modal-open');
}

/**
 * Close the Open File modal
 */
export function closeOpenFileModal() {
    if (modalElement) {
        modalElement.style.display = 'none';
        document.body.classList.remove('modal-open');
    }
}

// Global keydown handler for Escape
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalElement && modalElement.style.display === 'flex') {
        closeOpenFileModal();
    }
});
