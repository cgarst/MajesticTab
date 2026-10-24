// driveFolderPicker.js
// Small Google Drive folder chooser for the backup location. Separate from the tab library
// browser so backups never follow that browser's root directory.
import { listDriveSubfolders, createDriveFolder, getDriveBackupFolder } from './driveBackup.js';

function escapeHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Let the user pick (or create) the Drive folder that holds "MajesticTab Backup".
 * @returns {Promise<{id: string, name: string}|null>} The chosen folder, or null if dismissed.
 */
export function chooseDriveBackupFolder() {
    return new Promise((resolve) => {
        const current = getDriveBackupFolder();
        // Breadcrumb trail; the last entry is the folder being viewed
        const trail = [{ id: 'root', name: 'My Drive' }];
        if (current.id !== 'root') trail.push(current);

        const backdrop = document.createElement('div');
        backdrop.className = 'theme-modal-backdrop';
        backdrop.style.display = 'flex';
        backdrop.setAttribute('role', 'dialog');
        backdrop.setAttribute('aria-modal', 'true');
        backdrop.innerHTML = `
            <div class="theme-modal-card" style="max-width: 460px; width: 100%;">
                <div class="theme-modal-header">
                    <div class="theme-modal-title-group">
                        <div class="theme-modal-titles">
                            <h5 class="mb-0 fw-bold text-white fs-6">Choose backup folder</h5>
                            <small class="text-muted" style="font-size: 0.75rem;">MajesticTab Backup is created inside this folder</small>
                        </div>
                    </div>
                    <div class="theme-modal-actions">
                        <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" data-action="close" aria-label="Close"><i class="bi-x-lg"></i></button>
                    </div>
                </div>
                <div class="theme-modal-body p-3">
                    <div class="small text-white-50 mb-2 text-truncate" data-role="crumbs"></div>
                    <div data-role="error" class="small text-danger mb-2" style="display:none;"></div>
                    <div data-role="newRow" class="d-flex gap-2 mb-2" style="display:none;">
                        <input type="text" class="form-control form-control-sm bg-dark text-white border-secondary" data-role="newName" placeholder="Folder name" maxlength="120" aria-label="New folder name">
                        <button type="button" class="btn btn-sm btn-theme-primary px-3 flex-shrink-0" data-action="create">Create</button>
                    </div>
                    <div data-role="list" class="d-flex flex-column gap-1" style="max-height: 260px; overflow-y: auto;"></div>
                </div>
                <div class="theme-modal-footer d-flex align-items-center justify-content-between gap-2 p-3">
                    <button type="button" class="btn btn-sm btn-theme-outline px-3" data-action="new"><i class="bi-folder-plus me-1"></i> New Folder</button>
                    <div class="d-flex gap-2">
                        <button type="button" class="btn btn-sm btn-theme-outline px-3" data-action="close">Cancel</button>
                        <button type="button" class="btn btn-sm btn-theme-primary px-3" data-action="select">Use This Folder</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(backdrop);

        const crumbsEl = backdrop.querySelector('[data-role="crumbs"]');
        const listEl = backdrop.querySelector('[data-role="list"]');
        const errorEl = backdrop.querySelector('[data-role="error"]');
        const newRowEl = backdrop.querySelector('[data-role="newRow"]');
        const newNameEl = backdrop.querySelector('[data-role="newName"]');
        const here = () => trail[trail.length - 1];

        const finish = (result) => {
            backdrop.remove();
            resolve(result);
        };

        const showError = (err) => {
            errorEl.style.display = 'block';
            errorEl.textContent = err.message;
        };

        const render = async () => {
            errorEl.style.display = 'none';
            crumbsEl.innerHTML = trail.map((f, i) =>
                `<a href="#" class="text-info text-decoration-none" data-crumb="${i}">${escapeHtml(f.name)}</a>`).join(' <i class="bi-chevron-right" style="font-size:0.6rem;"></i> ');
            listEl.innerHTML = '<div class="py-3 text-center text-white-50 small"><span class="spinner-border spinner-border-sm me-2" role="status"></span>Loading folders...</div>';
            try {
                const folders = await listDriveSubfolders(here().id);
                listEl.innerHTML = folders.length
                    ? folders.map(f => `
                        <button type="button" class="drive-backup-item btn text-start d-flex align-items-center gap-2 p-2 rounded-2" data-folder="${escapeHtml(f.id)}" data-name="${escapeHtml(f.name)}">
                            <i class="bi-folder-fill text-warning flex-shrink-0"></i>
                            <span class="text-white small text-truncate">${escapeHtml(f.name)}</span>
                        </button>`).join('')
                    : '<div class="py-3 text-center text-white-50 small">No subfolders here.</div>';
            } catch (err) {
                listEl.innerHTML = '';
                showError(err);
            }
        };

        backdrop.addEventListener('click', async (e) => {
            if (e.target === backdrop) return finish(null);
            const crumb = e.target.closest('[data-crumb]');
            if (crumb) {
                e.preventDefault();
                trail.length = Number(crumb.dataset.crumb) + 1;
                return render();
            }
            const folderBtn = e.target.closest('[data-folder]');
            if (folderBtn) {
                trail.push({ id: folderBtn.dataset.folder, name: folderBtn.dataset.name });
                return render();
            }
            const action = e.target.closest('[data-action]')?.dataset.action;
            if (action === 'close') return finish(null);
            if (action === 'select') return finish({ ...here() });
            if (action === 'new') {
                newRowEl.style.display = 'flex';
                newNameEl.focus();
            }
            if (action === 'create') {
                const name = newNameEl.value.trim();
                if (!name) return;
                try {
                    const folder = await createDriveFolder(name, here().id);
                    newNameEl.value = '';
                    newRowEl.style.display = 'none';
                    trail.push(folder);
                    render();
                } catch (err) {
                    showError(err);
                }
            }
        });
        backdrop.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') finish(null);
            if (e.key === 'Enter' && e.target === newNameEl) backdrop.querySelector('[data-action="create"]').click();
        });

        render();
    });
}
