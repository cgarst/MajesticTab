// openFileModal.js
// "Open tab file" library view: drop zone for local files, and a list of file providers.

import { getFileProviders, openFromProvider, openLocalFile } from './fileProviders.js';
import { libraryViewSwitchHtml, libraryPageTitleHtml } from './libraryModal.js';
import { fileDropSupported } from './utils/fileHandlingUtils.js';

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Renders the Open Tab File view into the library page container.
 * @param {HTMLElement} container
 * @param {{onBack: function(): void}} handlers
 */
export function renderOpenFileView(container, { onBack }) {
    // The local device is covered by the drop zone above
    const allProviders = getFileProviders();
    const providers = allProviders.filter(p => p.id !== 'local' && p.id !== 'web-search');
    // The web search provider (native apps only) is a search bar rather than a card
    const hasWebSearch = allProviders.some(p => p.id === 'web-search');
    const canDrop = fileDropSupported();

    container.innerHTML = `
    <div class="library-page-container open-file-view">
      <div class="lib-view-switch-row">${libraryViewSwitchHtml()}</div>
      <button type="button" class="btn btn-sm open-file-back" id="openFileBackBtn"><i class="bi-chevron-left" aria-hidden="true"></i> Library</button>
      ${libraryPageTitleHtml({
        title: 'Open a tab file',
        subtitle: 'Play a file without adding it to your library.'
      })}
      <div class="open-file-body">
      <div class="open-file-dropzone" id="openFileDropzone" role="button" tabindex="0" aria-label="${canDrop ? 'Drop a tab file here or browse your device' : 'Browse your device for a tab file'}">
        <div class="open-file-dropzone-title">${canDrop ? 'Drop a tab file here' : 'Open a tab file'}</div>
        <div class="open-file-dropzone-sub">Guitar Pro (.gp, .gp3, .gp4, .gp5, .gpx), PDF or text</div>
        <button type="button" class="btn btn-sm btn-theme-primary" id="openFileBrowseBtn" tabindex="-1">Browse files</button>
      </div>

      ${hasWebSearch ? `
      <form class="library-search-box library-search-form open-file-web-search" id="openFileWebSearchForm">
        <div class="library-search-bar">
          <i class="bi-search search-icon" aria-hidden="true"></i>
          <input type="text" class="search-input" id="openFileWebSearchInput" placeholder="Search the web for a tab\u2026" autocomplete="off" spellcheck="false" aria-label="Search the web for a tab">
        </div>
        <button type="submit" class="btn btn-sm btn-theme-outline flex-shrink-0">Search</button>
      </form>` : ''}

      ${providers.length ? `
      <h6 class="open-file-section-label">Or open from</h6>
      <div class="open-file-provider-list" id="openFileProvidersList">
        ${providers.map(p => {
          const tint = String(p.icon).startsWith('icon-') ? '' : ` ${p.iconColorClass || ''}`;
          return `
          <div class="open-file-provider-item" data-provider-id="${escapeHtml(p.id)}" role="button" tabindex="0">
            <div class="open-file-provider-icon flex-shrink-0">
              <i class="${escapeHtml(p.icon || 'bi-file-earmark')}${tint}"></i>
            </div>
            <div class="open-file-provider-text">
              <span class="open-file-provider-name">${escapeHtml(p.name)}${p.badge ? ` <span class="open-file-provider-meta">\u00b7 ${escapeHtml(p.badge)}</span>` : ''}</span>
              <span class="open-file-provider-desc">${escapeHtml(p.description || 'Load tabs from this provider')}</span>
            </div>
          </div>
          `;
        }).join('')}
      </div>` : ''}
      </div>
    </div>
    `;

    container.querySelector('#openFileBackBtn')?.addEventListener('click', onBack);

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
    if (canDrop) dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('is-dragover');
    });
    if (canDrop) dropzone.addEventListener('dragleave', (e) => {
        if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove('is-dragover');
    });
    if (canDrop) dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('is-dragover');
        const file = e.dataTransfer?.files?.[0];
        if (file) openLocalFile(file);
    });

    // Web search: opens the system browser on the typed query
    container.querySelector('#openFileWebSearchForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const query = container.querySelector('#openFileWebSearchInput').value.trim();
        openFromProvider('web-search', query ? { query } : {});
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
