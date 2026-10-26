// icloudUi.js
// In-app browser for MajesticTab's iCloud Drive folder. Used on iOS, where the system file picker
// can't be pointed at iCloud Drive and always opens in "On My iPhone".
import { listIcloudDirectory, readIcloudFile } from './icloudDrive.js';
import { escapeHtml } from './backupRestore.js';
import { isSupportedTabFile } from './utils/fileHandlingUtils.js';
import { showToast } from './utils/toast.js';

const TAB_EXTENSIONS = /\.(gp|gp3|gp4|gp5|gpx|pdf|txt)$/i;

/**
 * Lets the user browse the iCloud Drive folder and pick a tab file.
 * @param {function(File): Promise<void>} onPick receives the chosen file
 */
export function openIcloudBrowser(onPick) {
    const modal = document.createElement('div');
    modal.className = 'theme-modal-backdrop';
    modal.style.display = 'flex';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    const close = () => modal.remove();
    let dir = null;
    let root = null;
    let request = 0;

    const frame = (body, footer = '') => {
        modal.innerHTML = `
        <div class="theme-modal-card backup-modal-card">
          <div class="theme-modal-header">
            <div class="theme-modal-title-group">
              <div class="brand-btn p-2 theme-modal-icon" style="width: 38px; height: 38px;"><i class="bi-cloud text-info fs-5"></i></div>
              <div class="theme-modal-titles">
                <h5 class="mb-0 fw-bold text-white fs-6">Open from iCloud Drive</h5>
                <small class="text-muted d-block text-truncate" style="font-size: 0.75rem;">MajesticTab folder</small>
              </div>
            </div>
            <div class="theme-modal-actions">
              <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" data-icloud-action="close" aria-label="Close"><i class="bi-x-lg"></i></button>
            </div>
          </div>
          <div class="theme-modal-body p-3">${body}</div>
          <div class="theme-modal-footer d-flex justify-content-end align-items-center gap-2 px-3 py-2">${footer}<button type="button" class="btn btn-sm btn-theme-outline px-3" data-icloud-action="close">Close</button></div>
        </div>`;
    };

    const showListing = async () => {
        const mine = ++request;
        frame('<div class="small text-white-50"><span class="spinner-border spinner-border-sm me-2" role="status"></span>Loading...</div>');
        try {
            const listing = await listIcloudDirectory(dir);
            if (mine !== request) return;
            root = listing.root;
            dir = listing.dir;
            const shown = listing.entries.filter(e => e.isDirectory || TAB_EXTENSIONS.test(e.name));
            const row = (icon, action, path, name) => `
                <button type="button" class="backup-provider-option p-2 px-3 rounded-3 d-flex align-items-center gap-3 text-start w-100" data-icloud-action="${action}" data-icloud-path="${escapeHtml(path)}" style="cursor: pointer;">
                    <i class="${icon} flex-shrink-0"></i>
                    <span class="text-white small text-truncate flex-grow-1 min-w-0">${escapeHtml(name)}</span>
                </button>`;
            frame(`
                <div class="small text-white-50 mb-2 text-truncate"><i class="bi-folder2 me-1"></i>iCloud Drive / MajesticTab${escapeHtml(dir.slice(root.length))}</div>
                <div class="d-flex flex-column gap-1">
                    ${dir !== root ? row('bi-arrow-up-circle text-muted', 'up', dir.replace(/\/[^/]+\/?$/, ''), 'Up one folder') : ''}
                    ${shown.map(e => e.isDirectory
                        ? row('bi-folder2 text-primary', 'folder', e.path, e.name)
                        : row('bi-file-earmark-music text-info', 'file', e.path, e.name)).join('')}
                    ${!shown.length ? '<div class="small text-white-50 py-2">No tab files in this folder. Put tabs in the MajesticTab folder in the Files app, under iCloud Drive.</div>' : ''}
                </div>`);
        } catch (err) {
            if (mine !== request) return;
            frame(`<div class="small text-warning"><i class="bi-exclamation-triangle me-2"></i>${escapeHtml(err.message)}</div>`);
        }
    };

    modal.addEventListener('click', async (e) => {
        if (e.target === modal) return close();
        const target = e.target.closest('[data-icloud-action]');
        if (!target) return;
        const { icloudAction: action, icloudPath: path } = target.dataset;
        if (action === 'close') return close();
        if (action === 'folder' || action === 'up') { dir = path; return showListing(); }
        if (action === 'file') {
            try {
                const file = await readIcloudFile(path);
                if (!(await isSupportedTabFile(file))) {
                    showToast(`"${file.name}" is not a supported tab file`, 'warning');
                    return;
                }
                close();
                await onPick(file);
            } catch (err) {
                showToast(`Could not read that file from iCloud Drive: ${err.message}`, 'error');
            }
        }
    });

    showListing();
}
