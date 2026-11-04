// webdavUi.js
// Shared WebDAV UI: the connection form (used by Sync, Backup and the file picker) and a folder
// browser for opening a tab file.
import { loadSecret, isSecureStorageAvailable } from './secureStore.js';
import { WEBDAV_SECRET_NAME, getWebDavConfig, saveWebDavConfig, clearWebDavConfig, davCheck, davList, davGet, davJoin, hasNativeHttp, webdavCorsHint } from './webdavClient.js';
import { escapeHtml, formatBytes } from './backupRestore.js';
import { isSupportedTabFile } from './utils/fileHandlingUtils.js';
import { showToast } from './utils/toast.js';

/** Web only: the app is not exempt from CORS there, so show what the server has to send. */
function corsHintHtml() {
    if (hasNativeHttp()) return '';
    const headers = webdavCorsHint();
    return `
        <div class="mt-3 small text-white-50">
            <div class="mb-1">Browsers need the server to allow this site. Add these response headers (and answer OPTIONS with them):</div>
            <pre class="p-2 rounded-3 mb-1 text-white-50" style="font-size: 0.7rem; white-space: pre-wrap; user-select: all; background: var(--bg-card-solid);">${escapeHtml(headers)}</pre>
            <div class="text-muted" style="font-size: 0.7rem;">The desktop and mobile apps do not need this.</div>
        </div>`;
}

const field = (id, label, value, { type = 'text', placeholder = '', autocomplete = 'off' } = {}) => `
    <div class="mb-2">
        <label class="form-label small text-white-50 mb-1" for="${id}">${label}</label>
        <input type="${type}" class="form-control form-control-sm" id="${id}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder)}" autocomplete="${autocomplete}" autocapitalize="off" spellcheck="false">
    </div>`;

/** Connection form fields, prefilled from the saved settings. */
export function webdavConfigFormHtml(config = getWebDavConfig() || {}) {
    return `
    <form data-webdav-form class="mb-1" onsubmit="return false">
        ${field('webdavUrl', 'Server address', config.url, { type: 'url', placeholder: 'https://cloud.example.com/remote.php/dav/files/me' })}
        <div class="row g-2">
            <div class="col-6">${field('webdavUser', 'Username', config.username, { autocomplete: 'username' })}</div>
            <div class="col-6">${field('webdavPassword', 'Password', config.password, { type: 'password', autocomplete: 'current-password', placeholder: isSecureStorageAvailable() && config.username ? 'Saved in your keychain (leave blank to keep)' : '' })}</div>
        </div>
        ${field('webdavFolder', 'Folder on the server (optional)', config.folder, { placeholder: 'Server root' })}
        <div class="text-muted" style="font-size: 0.72rem;">Use an app password if your server offers one. Use https: the password is sent with every request.</div>
    </form>${corsHintHtml()}`;
}

/** Reads the form inside `root`, tests the connection and saves it. Throws with a readable reason. */
export async function saveWebDavConfigFromForm(root) {
    const value = (id) => root.querySelector(`#${id}`)?.value || '';
    const username = value('webdavUser');
    // A blank password field means "keep the saved one", which lives in the keychain
    const password = value('webdavPassword') || (username ? await loadSecret(WEBDAV_SECRET_NAME) : '') || '';
    const config = saveWebDavConfig({ url: value('webdavUrl'), username, password, folder: value('webdavFolder') });
    await davCheck(config);
    return config;
}

// --- folder browser ---

const TAB_EXTENSIONS = /\.(gp|gp3|gp4|gp5|gpx|pdf|txt)$/i;

/**
 * Lets the user browse the server and pick a tab file.
 * @param {function(File): Promise<void>} onPick receives the downloaded file
 */
export function openWebDavBrowser(onPick) {
    const modal = document.createElement('div');
    modal.className = 'theme-modal-backdrop';
    modal.style.display = 'flex';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    const close = () => modal.remove();
    let config = getWebDavConfig();
    let dir = '';
    let request = 0;

    const frame = (body, footer = '') => {
        modal.innerHTML = `
        <div class="theme-modal-card backup-modal-card">
          <div class="theme-modal-header">
            <div class="theme-modal-title-group">
              <div class="theme-modal-titles">
                <h5 class="mb-0 fw-bold text-white fs-6">Open from WebDAV</h5>
                <small class="text-muted d-block text-truncate" style="font-size: 0.75rem;">${config ? escapeHtml(config.url.replace(/^https?:\/\//, '')) : 'Connect a server'}</small>
              </div>
            </div>
            <div class="theme-modal-actions">
              <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" data-webdav-action="close" aria-label="Close"><i class="bi-x-lg"></i></button>
            </div>
          </div>
          <div class="theme-modal-body p-3">${body}</div>
          ${footer ? `<div class="theme-modal-footer d-flex justify-content-end align-items-center gap-2 px-3 py-2">${footer}</div>` : ''}
        </div>`;
    };
    const btn = (action, label, { primary = false, danger = false, extraClass = '' } = {}) =>
        `<button type="button" class="btn btn-sm ${primary ? 'btn-theme-primary px-4' : danger ? 'btn-theme-danger px-3' : 'btn-theme-outline px-3'} ${extraClass}" data-webdav-action="${action}">${label}</button>`;

    const showForm = (error = '') => {
        frame(`${error ? `<div class="small text-warning mb-2">${escapeHtml(error)}</div>` : ''}${webdavConfigFormHtml()}`,
            (config ? btn('disconnect', 'Disconnect', { danger: true, extraClass: 'me-auto' }) : '') +
            btn('close', 'Cancel') +
            btn('connect', 'Connect', { primary: true }));
    };

    const showListing = async () => {
        const mine = ++request;
        frame('<div class="small text-white-50"><span class="spinner-border spinner-border-sm me-2" role="status"></span>Loading...</div>', btn('settings', 'Server settings') + btn('close', 'Close'));
        try {
            const items = (await davList(config, dir)) || [];
            if (mine !== request) return;
            const folders = items.filter(i => i.isDir).sort((a, b) => a.name.localeCompare(b.name));
            const shown = items.filter(i => !i.isDir && TAB_EXTENSIONS.test(i.name)).sort((a, b) => a.name.localeCompare(b.name));
            const row = (action, path, name, meta = '') => `
                <button type="button" class="backup-provider-option p-2 px-3 rounded-3 d-flex align-items-center gap-3 text-start w-100" data-webdav-action="${action}" data-webdav-path="${escapeHtml(path)}" style="cursor: pointer;">
                    <span class="text-white small text-truncate flex-grow-1 min-w-0">${name}</span>
                    ${meta ? `<span class="text-muted flex-shrink-0" style="font-size: 0.72rem;">${meta}</span>` : ''}
                </button>`;
            frame(`
                <div class="small text-white-50 mb-2 text-truncate">/${escapeHtml(davJoin(config.folder, dir))}</div>
                <div class="d-flex flex-column gap-1">
                    ${dir ? row('up', '', 'Up one folder') : ''}
                    ${folders.map(f => row('folder', f.path, `${escapeHtml(f.name)}/`)).join('')}
                    ${shown.map(f => row('file', f.path, escapeHtml(f.name), formatBytes(f.size))).join('')}
                    ${!folders.length && !shown.length ? '<div class="small text-white-50 py-2">No tab files in this folder.</div>' : ''}
                </div>`, btn('settings', 'Server settings') + btn('close', 'Close'));
        } catch (err) {
            if (mine === request) showForm(err.message);
        }
    };

    const pick = async (path) => {
        frame('<div class="small text-white-50"><span class="spinner-border spinner-border-sm me-2" role="status"></span>Downloading...</div>');
        try {
            const bytes = await (await davGet(config, path)).arrayBuffer();
            const file = new File([bytes], path.split('/').pop());
            if (!(await isSupportedTabFile(file))) {
                showToast(`"${file.name}" is not a supported tab file`, 'warning');
                return showListing();
            }
            close();
            await onPick(file);
        } catch (err) {
            showToast(err.message, 'error');
            showListing();
        }
    };

    modal.addEventListener('click', async (e) => {
        if (e.target === modal) return close();
        const target = e.target.closest('[data-webdav-action]');
        if (!target) return;
        const { webdavAction: action, webdavPath: path } = target.dataset;
        if (action === 'close') return close();
        if (action === 'settings') return showForm();
        if (action === 'disconnect') {
            clearWebDavConfig();
            config = null;
            dir = '';
            showToast('Disconnected WebDAV server on this device.', 'info');
            return showForm();
        }
        if (action === 'folder') { dir = path; return showListing(); }
        if (action === 'up') { dir = dir.split('/').slice(0, -1).join('/'); return showListing(); }
        if (action === 'file') return pick(path);
        if (action === 'connect') {
            target.disabled = true;
            try {
                config = await saveWebDavConfigFromForm(modal);
                dir = '';
                showListing();
            } catch (err) {
                showForm(err.message);
            }
        }
    });

    if (config) showListing(); else showForm();
}
