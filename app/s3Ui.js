// s3Ui.js
// Shared S3 bucket UI: the connection form (used by Sync and the file picker) and a bucket browser
// for opening a tab file.
import { getS3Config, saveS3Config, s3Check, s3List, s3Get, s3BasePrefix, hasNativeHttp, s3CorsRules } from './s3Client.js';
import { escapeHtml, formatBytes } from './backupRestore.js';
import { isSupportedTabFile } from './utils/fileHandlingUtils.js';
import { showToast } from './utils/toast.js';

/** Web only: the app is not exempt from CORS there, so show the exact rules this origin needs. */
function corsHintHtml() {
    if (hasNativeHttp()) return '';
    const rules = s3CorsRules();
    return `
        <div class="mt-3 small text-white-50">
            <div class="mb-1">Add this to your bucket's CORS configuration so this site can reach it:</div>
            <pre class="p-2 rounded-3 mb-1 text-white-50" style="font-size: 0.7rem; white-space: pre-wrap; user-select: all; background: var(--bg-card-solid); border: 1px solid var(--border-subtle);">${escapeHtml(rules)}</pre>
            <button type="button" class="btn btn-sm btn-theme-outline px-2 py-1" style="font-size: 0.72rem;" data-s3-copy="${escapeHtml(rules)}"><i class="bi-clipboard me-1"></i>Copy</button>
            <div class="text-muted mt-1" style="font-size: 0.7rem;">Amazon S3 and Cloudflare R2 take this JSON as is. Other providers (Backblaze B2, MinIO, Wasabi) have the same fields in their own CORS settings.</div>
        </div>`;
}

document.addEventListener('click', async (e) => {
    const copy = e.target.closest?.('[data-s3-copy]');
    if (!copy) return;
    try {
        await navigator.clipboard.writeText(copy.dataset.s3Copy);
        showToast('CORS rules copied', 'success');
    } catch (_) {
        showToast('Select the rules and copy them manually', 'warning');
    }
});

const field = (id, label, value, { type = 'text', placeholder = '', autocomplete = 'off' } = {}) => `
    <div class="mb-2">
        <label class="form-label small text-white-50 mb-1" for="${id}">${label}</label>
        <input type="${type}" class="form-control form-control-sm" id="${id}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder)}" autocomplete="${autocomplete}" autocapitalize="off" spellcheck="false">
    </div>`;

/** Connection form fields, prefilled from the saved settings. */
export function s3ConfigFormHtml(config = getS3Config() || {}) {
    return `
    <form data-s3-form class="mb-1">
        ${field('s3Bucket', 'Bucket', config.bucket, { placeholder: 'my-tabs' })}
        ${field('s3Endpoint', 'Endpoint (leave empty for Amazon S3)', config.endpoint, { placeholder: 'https://<account>.r2.cloudflarestorage.com' })}
        <div class="row g-2">
            <div class="col-6">${field('s3Region', 'Region', config.region, { placeholder: 'us-east-1' })}</div>
            <div class="col-6">${field('s3Prefix', 'Folder in bucket (optional)', config.prefix, { placeholder: 'Bucket root' })}</div>
        </div>
        ${field('s3AccessKey', 'Access key ID', config.accessKeyId)}
        ${field('s3Secret', 'Secret access key', config.secretAccessKey, { type: 'password' })}
        <div class="form-check form-switch mb-2">
            <input class="form-check-input theme-switch" type="checkbox" id="s3PathStyle" ${config.pathStyle ? 'checked' : ''}>
            <label class="form-check-label small text-white-50" for="s3PathStyle">Path-style addressing (some providers and MinIO need this)</label>
        </div>
        <div class="text-muted" style="font-size: 0.72rem;">Keys stay in this browser's local storage. Use a key limited to this bucket.</div>
    </form>${corsHintHtml()}`;
}

/** Reads the form inside `root`, tests the connection and saves it. Throws with a readable reason. */
export async function saveS3ConfigFromForm(root) {
    const value = (id) => root.querySelector(`#${id}`)?.value || '';
    const config = saveS3Config({
        bucket: value('s3Bucket'),
        endpoint: value('s3Endpoint'),
        region: value('s3Region'),
        prefix: value('s3Prefix'),
        accessKeyId: value('s3AccessKey'),
        secretAccessKey: value('s3Secret'),
        pathStyle: root.querySelector('#s3PathStyle')?.checked
    });
    await s3Check(config);
    return config;
}

// --- bucket browser ---

const TAB_EXTENSIONS = /\.(gp|gp3|gp4|gp5|gpx|pdf|txt)$/i;

/**
 * Lets the user browse the bucket and pick a tab file.
 * @param {function(File): Promise<void>} onPick receives the downloaded file
 */
export function openS3Browser(onPick) {
    const modal = document.createElement('div');
    modal.className = 'theme-modal-backdrop';
    modal.style.display = 'flex';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    const close = () => modal.remove();
    let config = getS3Config();
    let prefix = '';
    let request = 0;

    const frame = (body, footer = '') => {
        modal.innerHTML = `
        <div class="theme-modal-card backup-modal-card">
          <div class="theme-modal-header">
            <div class="theme-modal-title-group">
              <div class="brand-btn p-2 theme-modal-icon" style="width: 38px; height: 38px;"><i class="bi-hdd-network text-warning fs-5"></i></div>
              <div class="theme-modal-titles">
                <h5 class="mb-0 fw-bold text-white fs-6">Open from S3 bucket</h5>
                <small class="text-muted d-block text-truncate" style="font-size: 0.75rem;">${config ? escapeHtml(config.bucket) : 'Connect a bucket'}</small>
              </div>
            </div>
            <div class="theme-modal-actions">
              <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" data-s3-action="close" aria-label="Close"><i class="bi-x-lg"></i></button>
            </div>
          </div>
          <div class="theme-modal-body p-3">${body}</div>
          ${footer ? `<div class="theme-modal-footer d-flex justify-content-end align-items-center gap-2 px-3 py-2">${footer}</div>` : ''}
        </div>`;
    };
    const btn = (action, label, primary = false) =>
        `<button type="button" class="btn btn-sm ${primary ? 'btn-theme-primary px-4' : 'btn-theme-outline px-3'}" data-s3-action="${action}">${label}</button>`;

    const showForm = (error = '') => {
        frame(`${error ? `<div class="small text-warning mb-2"><i class="bi-exclamation-triangle me-2"></i>${escapeHtml(error)}</div>` : ''}${s3ConfigFormHtml()}`,
            btn('close', 'Cancel') + btn('connect', 'Connect', true));
    };

    const showListing = async () => {
        const mine = ++request;
        frame('<div class="small text-white-50"><span class="spinner-border spinner-border-sm me-2" role="status"></span>Loading...</div>', btn('settings', 'Bucket Settings') + btn('close', 'Close'));
        try {
            const base = s3BasePrefix(config);
            const { objects, folders } = await s3List(config, base + prefix, { delimiter: '/' });
            if (mine !== request) return;
            const shown = objects.filter(o => TAB_EXTENSIONS.test(o.key));
            const label = (key) => escapeHtml(key.slice((base + prefix).length).replace(/\/$/, ''));
            const row = (icon, action, key, name, meta = '') => `
                <button type="button" class="backup-provider-option p-2 px-3 rounded-3 d-flex align-items-center gap-3 text-start w-100" data-s3-action="${action}" data-s3-key="${escapeHtml(key)}" style="cursor: pointer;">
                    <i class="${icon} flex-shrink-0"></i>
                    <span class="text-white small text-truncate flex-grow-1 min-w-0">${name}</span>
                    ${meta ? `<span class="text-muted flex-shrink-0" style="font-size: 0.72rem;">${meta}</span>` : ''}
                </button>`;
            frame(`
                <div class="small text-white-50 mb-2 text-truncate"><i class="bi-folder2 me-1"></i>${escapeHtml(config.bucket)} / ${escapeHtml(base + prefix)}</div>
                <div class="d-flex flex-column gap-1">
                    ${prefix ? row('bi-arrow-up-circle text-muted', 'up', '', 'Up one folder') : ''}
                    ${folders.map(f => row('bi-folder2 text-primary', 'folder', f, label(f))).join('')}
                    ${shown.map(o => row('bi-file-earmark-music text-info', 'file', o.key, label(o.key), formatBytes(o.size))).join('')}
                    ${!folders.length && !shown.length ? '<div class="small text-white-50 py-2">No tab files in this folder.</div>' : ''}
                </div>`, btn('settings', 'Bucket Settings') + btn('close', 'Close'));
        } catch (err) {
            if (mine === request) showForm(err.message);
        }
    };

    const pick = async (key) => {
        frame('<div class="small text-white-50"><span class="spinner-border spinner-border-sm me-2" role="status"></span>Downloading...</div>');
        try {
            const bytes = await (await s3Get(config, key)).arrayBuffer();
            const file = new File([bytes], key.split('/').pop());
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
        const target = e.target.closest('[data-s3-action]');
        if (!target) return;
        const { s3Action: action, s3Key: key } = target.dataset;
        if (action === 'close') return close();
        if (action === 'settings') return showForm();
        if (action === 'folder') { prefix = key.slice(s3BasePrefix(config).length); return showListing(); }
        if (action === 'up') { prefix = prefix.replace(/[^/]+\/$/, ''); return showListing(); }
        if (action === 'file') return pick(key);
        if (action === 'connect') {
            target.disabled = true;
            try {
                config = await saveS3ConfigFromForm(modal);
                prefix = '';
                showListing();
            } catch (err) {
                showForm(err.message);
            }
        }
    });

    if (config) showListing(); else showForm();
}
