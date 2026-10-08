// tabDownloader.js
// Tab Downloader file provider for Native (Tauri WebviewWindow + FS) and Web environments.

import { saveStoredFile } from './fileStore.js';
import { loadFile } from './main.js';
import { addTabOptionToSong, getSongById } from './libraryStore.js';
import { inferTuningFromTextOrName } from './utils/tuningUtils.js';
import { openLibraryModal } from './libraryModal.js';

const SOURCES_STORAGE_KEY = 'majestictab_tab_sources';

export const UG_DEFAULT_USERSCRIPT = `document.querySelectorAll('div').forEach(div => {
    const text = div.textContent.trim();
    if (div.children.length === 0 && ['Official', 'Pro', 'Power'].includes(text)) {
        const row = div.parentElement;
        if (row) {
            const artistLink = row.querySelector('a[href*="/artist/"]');
            if (artistLink && row.nextElementSibling) {
                const nextRowFirstCell = row.nextElementSibling.firstElementChild;
                if (nextRowFirstCell && !nextRowFirstCell.querySelector('a[href*="/artist/"]')) {
                    nextRowFirstCell.innerHTML = artistLink.outerHTML;
                }
            }
            row.style.display = 'none';
        }
    }
});
document.querySelectorAll('.is_sticky_player').forEach(player => player.remove());`;

export const DEFAULT_SOURCES = [
    {
        id: 'ug',
        name: 'Ultimate Guitar',
        urlTemplate: 'https://www.ultimate-guitar.com/search.php?title=SEARCH+TERM',
        defaultUrl: 'https://www.ultimate-guitar.com/search.php?title=SEARCH+TERM',
        userscriptEnabled: true,
        userscript: UG_DEFAULT_USERSCRIPT,
        defaultUserscript: UG_DEFAULT_USERSCRIPT,
        isSeed: true
    },
    {
        id: 'metaltabs',
        name: 'MetalTabs',
        urlTemplate: 'https://metaltabs.org/search?search=SEARCH+TERM&bands=true&albums=false&tracks=true',
        defaultUrl: 'https://metaltabs.org/search?search=SEARCH+TERM&bands=true&albums=false&tracks=true',
        userscriptEnabled: false,
        userscript: '',
        defaultUserscript: '',
        isSeed: true
    }
];

let activeTargetSong = null;
let activeSourceId = 'ug';
let currentSearchQuery = '';

/**
 * Get configured sources with fallback to defaults
 */
export function getSources() {
    try {
        const stored = localStorage.getItem(SOURCES_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch {}
    return JSON.parse(JSON.stringify(DEFAULT_SOURCES));
}

/**
 * Save sources list
 */
export function saveSources(sources) {
    localStorage.setItem(SOURCES_STORAGE_KEY, JSON.stringify(sources));
}

/**
 * Reset a seed source to default URL & userscript
 */
export function resetSourceToDefault(sourceId) {
    const sources = getSources();
    const seed = DEFAULT_SOURCES.find(s => s.id === sourceId);
    if (!seed) return sources;

    const idx = sources.findIndex(s => s.id === sourceId);
    if (idx >= 0) {
        sources[idx] = JSON.parse(JSON.stringify(seed));
    } else {
        sources.push(JSON.parse(JSON.stringify(seed)));
    }
    saveSources(sources);
    return sources;
}

/**
 * Build target search URL from template and query
 */
export function buildSearchUrl(source, query) {
    const term = (query || '').trim();
    const encodedPlus = encodeURIComponent(term).replace(/%20/g, '+');
    const encodedStandard = encodeURIComponent(term);

    let url = source.urlTemplate || '';
    if (url.includes('SEARCH+TERM')) {
        url = url.replace('SEARCH+TERM', encodedPlus);
    } else if (url.includes('{search}')) {
        url = url.replace('{search}', encodedStandard);
    } else {
        url = `${url}${url.includes('?') ? '&' : '?'}q=${encodedStandard}`;
    }
    return url;
}

/**
 * Set up Tauri native event listener for completed downloads
 */
export function initTauriDownloadListener() {
    if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.listen('tab-downloaded', async (event) => {
            console.log('[Tab Downloader] Received downloaded file event:', event.payload);
            const { name, data, path } = event.payload || {};
            if (data && Array.isArray(data)) {
                const uint8 = new Uint8Array(data);
                const blob = new Blob([uint8], { type: 'application/octet-stream' });
                const file = new File([blob], name || 'downloaded.gp', { type: blob.type, lastModified: Date.now() });

                // Save to file store
                const stored = await saveStoredFile(file, 'tab-downloader', {
                    name: file.name,
                    relativePath: path || file.name,
                    targetSongId: activeTargetSong?.id || null
                });

                // Attach to library song if target active
                if (activeTargetSong?.id) {
                    await addTabOptionToSong(activeTargetSong.id, {
                        name: file.name,
                        providerId: 'tab-downloader',
                        relativePath: path || file.name,
                        fileStoreId: stored.id,
                        tuning: inferTuningFromTextOrName(file.name),
                        fileType: file.name.split('.').pop().toLowerCase()
                    });
                }

                // Load file into player
                await loadFile(file);
                closeTabDownloaderModal();
            }
        });
    }
}

/**
 * Open the Tab Downloader UI
 * @param {Object} [options]
 * @param {string} [options.query]
 * @param {string} [options.artist]
 * @param {string} [options.songName]
 * @param {Object} [options.targetSong]
 */
export async function openTabDownloader(options = {}) {
    activeTargetSong = options.targetSong || null;
    if (options.songId && !activeTargetSong) {
        try { activeTargetSong = await getSongById(options.songId); } catch {}
    }

    // Build search query: Artist + Song or query or songName
    let query = options.query || '';
    if (!query) {
        if (options.artist && options.songName) {
            query = `${options.artist} ${options.songName}`;
        } else if (activeTargetSong) {
            query = `${activeTargetSong.artist} ${activeTargetSong.title}`;
        } else if (options.songName) {
            query = options.songName;
        }
    }
    currentSearchQuery = query;

    renderTabDownloaderModal(query);
}

export function closeTabDownloaderModal() {
    const modal = document.getElementById('tabDownloaderModal');
    if (modal) modal.style.display = 'none';
}

/**
 * Renders the Tab Downloader Modal
 */
function renderTabDownloaderModal(initialQuery = '') {
    let modal = document.getElementById('tabDownloaderModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'tabDownloaderModal';
        modal.className = 'theme-modal-backdrop';
        document.body.appendChild(modal);
    }

    const isNative = !!(window.__TAURI__);
    const sources = getSources();
    const activeSource = sources.find(s => s.id === activeSourceId) || sources[0] || DEFAULT_SOURCES[0];
    activeSourceId = activeSource.id;

    modal.innerHTML = `
    <div class="theme-modal-card tab-downloader-card">
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          ${activeTargetSong ? `
            <button type="button" class="brand-btn theme-modal-back-btn p-1 px-2" id="tabDownloaderBackBtn" title="Back to Library" aria-label="Back to Library">
              <i class="bi-arrow-left"></i>
            </button>
          ` : ''}
          <div class="brand-btn p-2" style="width: 36px; height: 36px;">
            <i class="bi-cloud-arrow-down text-info"></i>
          </div>
          <div class="theme-modal-titles">
            <h6 class="mb-0 fw-bold text-white text-truncate">Tab Downloader ${isNative ? '<span class="badge bg-primary ms-1" style="font-size:0.65rem;">Native Webview</span>' : '<span class="badge bg-secondary ms-1" style="font-size:0.65rem;">Web</span>'}</h6>
            <small class="text-muted d-none d-sm-block" style="font-size: 0.75rem;">
              ${activeTargetSong ? `Targeting Library Song: <strong class="text-info">${escapeHtml(activeTargetSong.artist)} — ${escapeHtml(activeTargetSong.title)}</strong>` : 'Find and download guitar tabs directly into your library'}
            </small>
          </div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="btn btn-sm btn-outline-secondary py-1 px-2 text-white" id="downloaderManageSourcesBtn" title="Manage Tab Sources">
            <i class="bi-gear me-1"></i><span class="d-none d-sm-inline">Sources</span>
          </button>
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="tabDownloaderCloseBtn" aria-label="Close modal">
            <i class="bi-x-lg"></i>
          </button>
        </div>
      </div>

      <!-- Browser-Style Source Tabs -->
      <div class="tab-downloader-nav d-flex align-items-center gap-1 px-3 pt-2 overflow-x-auto border-bottom border-secondary-subtle" id="downloaderTabsList">
        ${sources.map(s => `
          <button type="button" class="btn btn-sm downloader-tab-btn ${s.id === activeSourceId ? 'active' : ''}" data-source-id="${s.id}">
            <i class="bi bi-globe me-1"></i> ${s.name}
          </button>
        `).join('')}
        <button type="button" class="btn btn-sm btn-outline-secondary py-0 px-2" id="downloaderAddSourceTabBtn" title="Add Source">
          <i class="bi-plus-lg"></i>
        </button>
      </div>

      <!-- Search & Action Toolbar -->
      <div class="p-3 border-bottom border-secondary-subtle">
        <form id="downloaderSearchForm" class="d-flex align-items-center gap-2">
          <div class="input-group input-group-sm flex-grow-1">
            <span class="input-group-text bg-dark border-secondary text-white-50"><i class="bi-search"></i></span>
            <input type="text" class="form-control bg-dark text-white border-secondary" id="downloaderSearchInput" value="${escapeHtml(currentSearchQuery)}" placeholder="Artist and song name...">
          </div>
          <button type="submit" class="btn btn-primary btn-sm px-3 d-flex align-items-center gap-1" id="downloaderGoBtn">
            <i class="bi-box-arrow-up-right"></i> Launch
          </button>
        </form>
      </div>

      <!-- Body / Mode Details & Dropzone Area -->
      <div class="theme-modal-body p-3" id="downloaderModalBody">
        ${isNative ? renderNativeInstructions(activeSource) : renderWebInstructions(activeSource)}
      </div>
    </div>
    `;

    // Event handlers
    modal.querySelector('#tabDownloaderBackBtn')?.addEventListener('click', () => {
        closeTabDownloaderModal();
        openLibraryModal('library');
    });
    modal.querySelector('#tabDownloaderCloseBtn')?.addEventListener('click', closeTabDownloaderModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeTabDownloaderModal();
    });

    // Source tab switching
    modal.querySelectorAll('.downloader-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeSourceId = btn.dataset.sourceId;
            renderTabDownloaderModal(modal.querySelector('#downloaderSearchInput')?.value || currentSearchQuery);
        });
    });

    // Search submit
    const searchForm = modal.querySelector('#downloaderSearchForm');
    searchForm?.addEventListener('submit', (e) => {
        e.preventDefault();
        const inputVal = modal.querySelector('#downloaderSearchInput')?.value || '';
        currentSearchQuery = inputVal;
        launchSource(activeSource, inputVal);
    });

    // Add source button
    modal.querySelector('#downloaderAddSourceTabBtn')?.addEventListener('click', () => {
        openSourceEditorModal();
    });

    // Manage sources button
    modal.querySelector('#downloaderManageSourcesBtn')?.addEventListener('click', () => {
        openSourceEditorModal();
    });

    // Web upload dropzone attachment
    setupWebDropzone(modal);
}

function renderNativeInstructions(source) {
    const url = buildSearchUrl(source, currentSearchQuery);
    return `
    <div class="p-3 rounded-3" style="background: var(--bg-card-solid); border: 1px solid var(--border-subtle);">
      <div class="d-flex align-items-center gap-2 mb-2">
        <i class="bi-shield-check text-success fs-5"></i>
        <h6 class="mb-0 fw-bold text-white">Native Webview Integration</h6>
      </div>
      <p class="small text-muted mb-3">
        Clicking <strong>Launch</strong> spawns a dedicated browser window loading <strong>${escapeHtml(source.name)}</strong> natively with CORS bypassed. Downloaded tabs are automatically captured via the Tauri Filesystem API and saved into your library.
      </p>
      <div class="small text-white-50 p-2 rounded bg-black bg-opacity-40 border border-secondary font-monospace text-truncate mb-3">
        ${escapeHtml(url)}
      </div>
      <div class="d-flex align-items-center justify-content-between">
        <span class="small text-muted">
          Userscript: ${source.userscriptEnabled ? '<span class="text-success fw-semibold"><i class="bi-check-circle me-1"></i>Active</span>' : '<span class="text-secondary">Disabled</span>'}
        </span>
        <button type="button" class="btn btn-primary btn-sm px-4" id="downloaderLaunchDirectBtn">
          <i class="bi-box-arrow-up-right me-1"></i> Open in Native Browser
        </button>
      </div>
    </div>
    `;
}

function renderWebInstructions(source) {
    const url = buildSearchUrl(source, currentSearchQuery);
    return `
    <div class="d-flex flex-column gap-3">
      <div class="p-3 rounded-3" style="background: var(--bg-card-solid); border: 1px solid var(--border-subtle);">
        <div class="d-flex align-items-center gap-2 mb-2">
          <i class="bi-info-circle text-info fs-5"></i>
          <h6 class="mb-0 fw-bold text-white">Download &amp; Attach Tab (Web Version)</h6>
        </div>
        <p class="small text-muted mb-2">
          1. Click <strong>Search on ${escapeHtml(source.name)}</strong> to open the tab search in a new browser tab.<br>
          2. Download the Guitar Pro (.gp/.gp5), PDF, or TXT file to your device.<br>
          3. Drag &amp; drop or browse the downloaded file below to attach it to <strong>${activeTargetSong ? `${activeTargetSong.artist} — ${activeTargetSong.title}` : 'your library'}</strong>.
        </p>
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline-primary btn-sm w-100 py-1.5" id="webExternalSearchBtn">
          <i class="bi-box-arrow-up-right me-1"></i> Search on ${escapeHtml(source.name)}
        </a>
      </div>

      <!-- File Dropzone -->
      <div class="downloader-dropzone p-4 text-center rounded-3 border border-2 border-dashed border-secondary" id="downloaderDropzone">
        <i class="bi-cloud-arrow-up text-info fs-1 mb-2 d-block"></i>
        <div class="fw-semibold text-white mb-1">Drop downloaded tab file here</div>
        <div class="small text-muted mb-3">Supports .gp, .gp3, .gp4, .gp5, .gpx, .pdf, .txt</div>
        <label class="btn btn-primary btn-sm px-3">
          <i class="bi-folder2-open me-1"></i> Browse File
          <input type="file" class="d-none" id="downloaderFileInput" accept=".pdf,.gp,.gp3,.gp4,.gp5,.gpx,.txt">
        </label>
      </div>
    </div>
    `;
}

/**
 * Launch target source in Native WebviewWindow or Web tab
 */
async function launchSource(source, query) {
    const url = buildSearchUrl(source, query);
    const userscript = source.userscriptEnabled ? (source.userscript || '') : '';

    if (window.__TAURI__ && window.__TAURI__.core) {
        try {
            await window.__TAURI__.core.invoke('open_tab_downloader', {
                url,
                userscript: userscript || null
            });
        } catch (err) {
            console.error('Failed to open native webview window:', err);
            // Fallback to opener
            if (window.__TAURI__.opener) {
                window.__TAURI__.opener.openUrl(url);
            } else {
                window.open(url, '_blank');
            }
        }
    } else {
        window.open(url, '_blank');
    }
}

/**
 * Handles dropzone and file input in Web mode
 */
function setupWebDropzone(modal) {
    const dropzone = modal.querySelector('#downloaderDropzone');
    const fileInput = modal.querySelector('#downloaderFileInput');
    const launchDirectBtn = modal.querySelector('#downloaderLaunchDirectBtn');

    if (launchDirectBtn) {
        launchDirectBtn.addEventListener('click', () => {
            const sources = getSources();
            const source = sources.find(s => s.id === activeSourceId) || sources[0];
            launchSource(source, currentSearchQuery);
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (file) await handleImportedDownloadedFile(file);
        });
    }

    if (dropzone) {
        ['dragenter', 'dragover'].forEach(name => {
            dropzone.addEventListener(name, (e) => {
                e.preventDefault();
                dropzone.classList.add('border-primary');
            });
        });
        ['dragleave', 'drop'].forEach(name => {
            dropzone.addEventListener(name, (e) => {
                e.preventDefault();
                dropzone.classList.remove('border-primary');
            });
        });
        dropzone.addEventListener('drop', async (e) => {
            const file = e.dataTransfer?.files?.[0];
            if (file) await handleImportedDownloadedFile(file);
        });
    }
}

async function handleImportedDownloadedFile(file) {
    try {
        const stored = await saveStoredFile(file, 'tab-downloader-web', {
            name: file.name,
            relativePath: file.name,
            targetSongId: activeTargetSong?.id || null
        });

        if (activeTargetSong?.id) {
            await addTabOptionToSong(activeTargetSong.id, {
                name: file.name,
                providerId: 'tab-downloader-web',
                relativePath: file.name,
                fileStoreId: stored.id,
                tuning: inferTuningFromTextOrName(file.name),
                fileType: file.name.split('.').pop().toLowerCase()
            });
        }

        await loadFile(file);
        closeTabDownloaderModal();
    } catch (err) {
        console.error('Error importing downloaded tab file:', err);
        alert(`Error importing tab: ${err.message}`);
    }
}

/**
 * Modal to add / edit / delete sources and edit userscripts
 */
export function openSourceEditorModal(editingSourceId = null) {
    let modal = document.getElementById('sourceEditorModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'sourceEditorModal';
        modal.className = 'theme-modal-backdrop';
        document.body.appendChild(modal);
    }

    const sources = getSources();
    let currentEditing = editingSourceId ? sources.find(s => s.id === editingSourceId) : (sources[0] || DEFAULT_SOURCES[0]);
    if (!currentEditing && sources.length > 0) currentEditing = sources[0];

    modal.innerHTML = `
    <div class="theme-modal-card" style="max-width: 600px;">
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          <button type="button" class="brand-btn theme-modal-back-btn p-1 px-2" id="sourceEditorBackBtn" title="Back to Tab Downloader" aria-label="Back">
            <i class="bi-arrow-left"></i>
          </button>
          <div class="brand-btn p-2" style="width: 36px; height: 36px;">
            <i class="bi-sliders text-info"></i>
          </div>
          <div class="theme-modal-titles">
            <h6 class="mb-0 fw-bold text-white">Configure Tab Sources</h6>
            <small class="text-muted">Manage search providers and custom userscripts</small>
          </div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="sourceEditorCloseBtn">
            <i class="bi-x-lg"></i>
          </button>
        </div>
      </div>

      <div class="theme-modal-body p-3">
        <!-- Source Selector & Add New -->
        <div class="d-flex align-items-center justify-content-between mb-2">
          <label class="form-label small fw-semibold text-muted mb-0">Select Source:</label>
          <button type="button" class="btn btn-sm btn-outline-secondary py-0 px-2" id="sourceCreateNewBtn">
            <i class="bi-plus-lg me-1"></i> New Source
          </button>
        </div>
        <div class="hud-pill-group w-100 mb-3" id="sourceSelectorPill">
          ${sources.map(s => `
            <button type="button" class="btn btn-sm ${currentEditing && currentEditing.id === s.id ? 'active' : ''}" data-edit-id="${s.id}" style="flex:1;">
              ${escapeHtml(s.name)}
            </button>
          `).join('')}
        </div>

        <form id="sourceEditForm">
          <div class="mb-2">
            <label class="form-label small text-white-50 mb-1">Source Name</label>
            <input type="text" class="form-control form-control-sm bg-dark text-white border-secondary" id="editSourceName" value="${currentEditing ? escapeHtml(currentEditing.name) : ''}" required>
          </div>

          <div class="mb-3">
            <div class="d-flex justify-content-between align-items-center mb-1">
              <label class="form-label small text-white-50 mb-0">Search URL Template</label>
              ${currentEditing?.defaultUrl ? `<button type="button" class="btn btn-link btn-sm p-0 text-info" id="resetUrlBtn" style="font-size:0.75rem;">Reset URL</button>` : ''}
            </div>
            <input type="text" class="form-control form-control-sm bg-dark text-white border-secondary font-monospace" id="editSourceUrl" value="${currentEditing ? escapeHtml(currentEditing.urlTemplate) : ''}" placeholder="https://www.ultimate-guitar.com/search.php?title=SEARCH+TERM" required>
            <div class="text-muted mt-1" style="font-size: 0.72rem;">Use <code>SEARCH+TERM</code> where the search keywords should be inserted.</div>
          </div>

          <!-- Userscript Section -->
          <div class="p-2 rounded-2 mb-3" style="background: var(--bg-card); border: 1px solid var(--border-subtle);">
            <div class="d-flex align-items-center justify-content-between mb-2">
              <div class="form-check form-switch mb-0">
                <input class="form-check-input theme-switch" type="checkbox" id="editUserscriptEnabled" ${currentEditing?.userscriptEnabled ? 'checked' : ''}>
                <label class="form-check-label small fw-semibold text-white" for="editUserscriptEnabled">Inject Userscript (Native Webview)</label>
              </div>
              ${currentEditing?.defaultUserscript ? `<button type="button" class="btn btn-link btn-sm p-0 text-info" id="resetUserscriptBtn" style="font-size:0.75rem;">Reset Script</button>` : ''}
            </div>
            <textarea class="form-control form-control-sm bg-dark text-white border-secondary font-monospace" id="editUserscriptCode" rows="4" style="font-size: 0.78rem;" placeholder="// Custom JavaScript injected into webview">${currentEditing?.userscript || ''}</textarea>
          </div>

          <div class="d-flex align-items-center justify-content-between gap-2">
            <div>
              ${currentEditing && !currentEditing.isSeed ? `
                <button type="button" class="btn btn-sm btn-outline-danger" id="deleteSourceBtn">
                  <i class="bi-trash me-1"></i> Delete
                </button>
              ` : ''}
            </div>
            <div class="d-flex gap-2">
              <button type="button" class="btn btn-sm theme-control-btn" id="cancelSourceEditBtn">Cancel</button>
              <button type="submit" class="btn btn-sm btn-primary px-3">Save Changes</button>
            </div>
          </div>
        </form>
      </div>
    </div>
    `;

    modal.style.display = 'flex';

    // Close and Back buttons
    modal.querySelector('#sourceEditorBackBtn')?.addEventListener('click', () => {
        modal.style.display = 'none';
        renderTabDownloaderModal(currentSearchQuery);
    });
    modal.querySelector('#sourceEditorCloseBtn')?.addEventListener('click', () => modal.style.display = 'none');
    modal.querySelector('#cancelSourceEditBtn')?.addEventListener('click', () => modal.style.display = 'none');

    // Switch active source in editor
    modal.querySelectorAll('[data-edit-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            openSourceEditorModal(btn.dataset.editId);
        });
    });

    // Reset URL button
    modal.querySelector('#resetUrlBtn')?.addEventListener('click', () => {
        if (currentEditing?.defaultUrl) {
            modal.querySelector('#editSourceUrl').value = currentEditing.defaultUrl;
        }
    });

    // Reset Userscript button
    modal.querySelector('#resetUserscriptBtn')?.addEventListener('click', () => {
        if (currentEditing?.defaultUserscript) {
            modal.querySelector('#editUserscriptCode').value = currentEditing.defaultUserscript;
            modal.querySelector('#editUserscriptEnabled').checked = true;
        }
    });

    // Create New Source
    modal.querySelector('#sourceCreateNewBtn')?.addEventListener('click', () => {
        const newSource = {
            id: `source_${Date.now()}`,
            name: 'Custom Source',
            urlTemplate: 'https://www.ultimate-guitar.com/search.php?title=SEARCH+TERM',
            userscriptEnabled: false,
            userscript: '',
            isSeed: false
        };
        const curSources = getSources();
        curSources.push(newSource);
        saveSources(curSources);
        openSourceEditorModal(newSource.id);
    });

    // Delete Source
    modal.querySelector('#deleteSourceBtn')?.addEventListener('click', () => {
        if (!currentEditing || currentEditing.isSeed) return;
        const curSources = getSources().filter(s => s.id !== currentEditing.id);
        saveSources(curSources);
        openSourceEditorModal(curSources[0]?.id || null);
    });

    // Save Form
    modal.querySelector('#sourceEditForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const curSources = getSources();
        const name = modal.querySelector('#editSourceName').value.trim();
        const urlTemplate = modal.querySelector('#editSourceUrl').value.trim();
        const userscriptEnabled = modal.querySelector('#editUserscriptEnabled').checked;
        const userscript = modal.querySelector('#editUserscriptCode').value;

        if (currentEditing) {
            const idx = curSources.findIndex(s => s.id === currentEditing.id);
            if (idx >= 0) {
                curSources[idx].name = name;
                curSources[idx].urlTemplate = urlTemplate;
                curSources[idx].userscriptEnabled = userscriptEnabled;
                curSources[idx].userscript = userscript;
            }
        }
        saveSources(curSources);
        modal.style.display = 'none';
        renderTabDownloaderModal(currentSearchQuery);
    });
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
