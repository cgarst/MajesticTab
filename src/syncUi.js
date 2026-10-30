// syncUi.js
// The Sync dialog: one tap from Settings, then a single review of exactly what will change
// (see syncEngine.js), one confirmation, and a short result. The sync location is remembered.
import { planSync, applySync, getSyncBase, SYNC_ACTION } from './syncEngine.js';
import { formatBytes, escapeHtml } from './backupRestore.js';
import { isFolderBackupSupported } from './folderBackup.js';
import { isIcloudDriveSupported, ICLOUD_UNAVAILABLE_MESSAGE } from './icloudDrive.js';
import { getPreferredStorage, setPreferredStorage } from './fileProviders.js';
import { s3ConfigFormHtml, saveS3ConfigFromForm } from './s3Ui.js';
import { showToast } from './utils/toast.js';

const DRIVE = 'google-drive';
const FOLDER = 'folder';
const ICLOUD = 'icloud';
const S3 = 's3';
// A plan that removes this share of the tabs (and at least MASS_REMOVAL_MIN) is called out as unusual
const MASS_REMOVAL_SHARE = 0.5;
const MASS_REMOVAL_MIN = 5;

let modal = null;
let authHandler = null;
let session = 0;
let context = null;
let reloadOnClose = false;

const getTarget = getPreferredStorage;
const setTarget = setPreferredStorage;
// Set just before sending the user to Google, so a failed sign-in shows the Connect screen instead of looping
const AUTO_AUTH_KEY = 'majestictab_sync_auto_auth';
const targetLabel = (target) => target === DRIVE ? 'Google Drive' : target === ICLOUD ? 'iCloud Drive' : target === S3 ? 'your S3 bucket' : 'your backup folder';

function relativeTime(ms) {
    const minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Fills the "Last synced" line under the Sync button in Settings. */
export function refreshSyncStatus() {
    const el = document.getElementById('syncStatusLine');
    if (!el) return;
    const base = getSyncBase();
    const target = getTarget();
    el.textContent = base && target
        ? `Last synced ${relativeTime(base.syncedAt)} with ${targetLabel(target)}`
        : 'Keep this device and your backup location matching';
}

// --- backend ---

/** @returns {Promise<{status: 'ready', backend: object}|{status: string, folderName?: string}>} */
async function resolveBackend(target, { interactive = false } = {}) {
    // @googleDrive:begin
    if (target === DRIVE) {
        const { isTokenValid, ensureFreshToken } = await import('./googleDrive.js');
        await ensureFreshToken();
        if (!isTokenValid()) return { status: 'needs-auth' };
        const { createDriveBackend } = await import('./driveBackup.js');
        return { status: 'ready', backend: createDriveBackend() };
    }
    // @googleDrive:end
    if (target === ICLOUD) {
        const { getIcloudBackupFolder, createFolderBackend } = await import('./folderBackup.js');
        const handle = await getIcloudBackupFolder();
        return handle ? { status: 'ready', backend: createFolderBackend(handle) } : { status: 'needs-icloud' };
    }
    if (target === S3) {
        const { createS3Backend } = await import('./s3Backup.js');
        const backend = createS3Backend();
        return backend ? { status: 'ready', backend } : { status: 'needs-s3' };
    }
    const folders = await import('./folderBackup.js');
    let handle = await folders.getSavedBackupFolder();
    if (!handle && interactive) handle = await folders.pickBackupFolder();
    if (!handle) return { status: 'needs-folder' };
    const granted = interactive
        ? await folders.ensureFolderPermission(handle)
        : (await folders.queryFolderPermission(handle)) === 'granted';
    if (!granted) return { status: 'needs-permission', folderName: handle.name };
    return { status: 'ready', backend: folders.createFolderBackend(handle) };
}

// --- modal shell ---

function getModal() {
    if (modal && document.body.contains(modal)) return modal;
    modal = document.getElementById('syncModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'syncModal';
        modal.className = 'theme-modal-backdrop';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'syncModalTitle');
        document.body.appendChild(modal);
    }
    return modal;
}

export function closeSyncModal() {
    session++;
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
    context = null;
    refreshSyncStatus();
    // Open library views read their stores once, so a reload shows what the sync brought in
    if (reloadOnClose) window.location.reload();
}

function frame(body, { subtitle = '', footer = '' } = {}) {
    modal.innerHTML = `
    <div class="theme-modal-card backup-modal-card">
      <div class="theme-modal-header">
        <div class="theme-modal-title-group">
          <div class="brand-btn p-2 theme-modal-icon" style="width: 38px; height: 38px;">
            <i class="bi-arrow-repeat text-primary fs-5"></i>
          </div>
          <div class="theme-modal-titles">
            <h5 class="mb-0 fw-bold text-white fs-6" id="syncModalTitle">Sync</h5>
            <small class="text-muted d-block text-truncate" style="font-size: 0.75rem;">${subtitle}</small>
          </div>
        </div>
        <div class="theme-modal-actions">
          <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" data-sync-action="close" aria-label="Close">
            <i class="bi-x-lg"></i>
          </button>
        </div>
      </div>
      <div class="theme-modal-body p-3">${body}</div>
      ${footer ? `<div class="theme-modal-footer d-flex justify-content-end align-items-center gap-2 px-3 py-2">${footer}</div>` : ''}
    </div>`;
}

const button = (action, label, { primary = false, icon = '' } = {}) =>
    `<button type="button" class="btn btn-sm ${primary ? 'btn-theme-primary px-4' : 'btn-theme-outline px-3'} d-inline-flex align-items-center gap-2" data-sync-action="${action}">${icon ? `<i class="${icon}"></i>` : ''}<span>${label}</span></button>`;

const notice = (icon, text) => `<div class="small text-white-50 py-2"><i class="${icon} me-2"></i>${text}</div>`;

// --- screens ---

let checkingTimer = null;

function stopChecking() {
    clearInterval(checkingTimer);
    checkingTimer = null;
}

/** Show the compare screen; returns a setter for the current step. A timer shows how long it has run. */
function showChecking(target) {
    stopChecking();
    frame(`<div class="py-4 text-center text-white-50 small">
        <div><span class="spinner-border spinner-border-sm text-primary me-2" role="status"></span>Comparing this device with ${targetLabel(target)}...</div>
        <div class="mt-2 text-white" data-sync-step>Starting...</div>
        <div class="mt-1" style="font-size:0.72rem;" data-sync-elapsed></div>
    </div>`, { subtitle: 'Checking for changes' });
    const startedAt = Date.now();
    const elapsed = document.querySelector('[data-sync-elapsed]');
    checkingTimer = setInterval(() => {
        const secs = Math.floor((Date.now() - startedAt) / 1000);
        if (!elapsed || !elapsed.isConnected) return stopChecking();
        elapsed.textContent = secs < 10 ? '' : `${secs}s elapsed${secs >= 30 ? '. Large libraries or slow connections can take a while.' : ''}`;
    }, 1000);
    return (text) => {
        const el = document.querySelector('[data-sync-step]');
        if (el) el.textContent = text;
    };
}

function showChooseLocation() {
    const options = [
        // @googleDrive:begin
        { id: DRIVE, icon: 'bi-google text-danger', title: 'Google Drive', text: 'Sync across your devices through your Google account.' },
        // @googleDrive:end
        ...(isIcloudDriveSupported()
            ? [{ id: ICLOUD, icon: 'bi-cloud text-info', title: 'iCloud Drive', text: 'Sync through iCloud Drive across your Apple devices. No sign-in needed.' }]
            : []),
        { id: S3, icon: 'bi-hdd-network text-warning', title: 'S3 bucket', text: 'Sync through Amazon S3, Cloudflare R2, Backblaze B2, MinIO or any S3-compatible storage.' },
        ...(isFolderBackupSupported()
            ? [{ id: FOLDER, icon: 'bi-folder2-open text-primary', title: 'A folder on this device', text: 'Sync through a folder, such as one a cloud drive app keeps in step.' }]
            : [])
    ];
    frame(`
        <div class="small text-white-50 mb-3">Choose where MajesticTab keeps your synced library. You only do this once. Your other devices sync with the same location.</div>
        <div class="d-flex flex-column gap-2">
            ${options.map(o => `
                <button type="button" class="backup-provider-option p-3 rounded-3 d-flex align-items-center gap-3 text-start w-100" data-sync-action="pick-${o.id}" style="cursor: pointer;">
                    <div class="provider-mini-icon"><i class="${o.icon} fs-5"></i></div>
                    <div class="min-w-0">
                        <div class="fw-bold text-white small leading-tight">${o.title}</div>
                        <div class="text-muted" style="font-size: 0.73rem;">${o.text}</div>
                    </div>
                </button>`).join('')}
        </div>`, { subtitle: 'Choose a sync location', footer: button('close', 'Cancel') });
}

function showS3Form(error = '') {
    frame(`${error ? notice('bi-exclamation-triangle text-warning', escapeHtml(error)) : ''}${s3ConfigFormHtml()}`,
        { subtitle: 'S3 bucket', footer: button('switch', 'Choose Another') + button('save-s3', 'Save and Connect', { primary: true, icon: 'bi-plug' }) });
}

function showNeedsSetup(status, folderName = '') {
    if (status === 'needs-auth') {
        // @googleDrive:begin
        frame(notice('bi-info-circle', 'Connect Google Drive so MajesticTab can compare and sync your library.'),
            { subtitle: 'Google Drive', footer: button('switch', 'Choose Another') + button('connect', 'Connect Google Drive', { primary: true, icon: 'bi-google' }) });
        // @googleDrive:end
    } else if (status === 'needs-icloud') {
        frame(notice('bi-cloud-slash', ICLOUD_UNAVAILABLE_MESSAGE),
            { subtitle: 'iCloud Drive', footer: button('switch', 'Choose Another') + button('retry', 'Try Again', { primary: true, icon: 'bi-arrow-repeat' }) });
    } else if (status === 'needs-s3') {
        showS3Form();
    } else if (status === 'needs-permission') {
        frame(notice('bi-lock', `MajesticTab needs permission to use "${escapeHtml(folderName)}" again.`),
            { subtitle: 'Backup folder', footer: button('switch', 'Choose Another') + button('allow-folder', 'Allow Access', { primary: true, icon: 'bi-unlock' }) });
    } else {
        frame(notice('bi-folder2-open', 'Choose the folder to sync through.'),
            { subtitle: 'Backup folder', footer: button('switch', 'Choose Another') + button('choose-folder', 'Choose Folder', { primary: true, icon: 'bi-folder2-open' }) });
    }
}

function tile(n, label, cls) {
    return `<div class="col-6 col-md-3"><div class="p-2 rounded-2 backup-stat-card"><div class="fw-bold fs-6 ${n ? cls : 'text-white-50'}">${n}</div><div class="text-white-50 text-truncate" style="font-size:0.72rem;">${label}</div></div></div>`;
}

function section(changes, { icon, title, note = '', tone }) {
    if (!changes.length) return '';
    const bytes = changes.reduce((acc, c) => acc + c.size, 0);
    return `
        <details class="mb-2" ${changes.length <= 8 || tone === 'text-warning' ? 'open' : ''}>
            <summary class="small fw-semibold text-white py-1 d-flex align-items-center gap-2" style="cursor: pointer; user-select: none;">
                <i class="${icon} ${tone}"></i><span>${title} (${changes.length})</span>
                ${bytes ? `<span class="text-white-50 fw-normal ms-auto" style="font-size:0.72rem;">${formatBytes(bytes)}</span>` : ''}
            </summary>
            ${note ? `<div class="text-white-50 mb-1" style="font-size:0.72rem;">${note}</div>` : ''}
            <ul class="list-unstyled mb-0 rounded-2 backup-summary-box" style="max-height: 28vh; overflow-y: auto;">
                ${changes.map(c => `
                    <li class="d-flex align-items-start gap-2 px-2 py-2 border-bottom border-secondary-subtle">
                        <i class="${c.kind === 'soundfont' ? 'bi-music-note-list' : 'bi-file-earmark-music'} text-white-50 flex-shrink-0 mt-1"></i>
                        <div class="min-w-0 flex-grow-1">
                            <div class="small text-white text-truncate" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</div>
                            <div class="text-white-50" style="font-size:0.7rem;">${escapeHtml(c.reason)}${c.size ? ` · ${formatBytes(c.size)}` : ''}</div>
                        </div>
                        ${c.conflict ? '<span class="badge badge-theme-secondary py-0 px-2 flex-shrink-0" style="font-size:0.65rem;">Both changed</span>' : ''}
                    </li>`).join('')}
            </ul>
        </details>`;
}

const OTHER_ICONS = { song: 'bi-music-note-beamed', collection: 'bi-collection', extension: 'bi-puzzle', setting: 'bi-gear' };

function otherSection(items, { icon, title, tone }) {
    if (!items.length) return '';
    return `
        <details class="mb-2" open>
            <summary class="small fw-semibold text-white py-1 d-flex align-items-center gap-2" style="cursor: pointer; user-select: none;">
                <i class="${icon} ${tone}"></i><span>${title}</span>
            </summary>
            <ul class="list-unstyled mb-0 rounded-2 backup-summary-box">
                ${items.map(i => `
                    <li class="d-flex align-items-start gap-2 px-2 py-2 border-bottom border-secondary-subtle">
                        <i class="${OTHER_ICONS[i.kind] || 'bi-gear'} text-white-50 flex-shrink-0 mt-1"></i>
                        <div class="small text-white min-w-0" style="overflow-wrap:anywhere;">${escapeHtml(i.text)}</div>
                    </li>`).join('')}
            </ul>
        </details>`;
}

function showReview(target, backend, plan) {
    const by = (action) => plan.changes.filter(c => c.action === action);
    const down = by(SYNC_ACTION.DOWNLOAD);
    const up = by(SYNC_ACTION.UPLOAD);
    const removeHere = by(SYNC_ACTION.DELETE_LOCAL);
    const removeThere = by(SYNC_ACTION.DELETE_REMOTE);
    const where = targetLabel(target);
    const removals = removeHere.length + removeThere.length;
    const total = plan.changes.length + plan.unchanged;
    const unusual = removals >= MASS_REMOVAL_MIN && removals / Math.max(1, total) >= MASS_REMOVAL_SHARE;

    const header = `
        <div class="d-flex align-items-start justify-content-between gap-2 mb-3">
            <div class="min-w-0">
                <div class="small fw-semibold text-white">${plan.firstSync
                    ? '<i class="bi-info-circle text-info me-1"></i> First sync with this location. Nothing will be removed.'
                    : `<i class="bi-check-circle text-success me-1"></i> Last synced ${escapeHtml(relativeTime(plan.lastSyncedAt))}`}</div>
                <div class="text-white-50 text-truncate" style="font-size:0.72rem;" title="${escapeHtml(backend.location)}"><i class="bi-folder2 me-1"></i>${escapeHtml(backend.location)}</div>
            </div>
            <div class="d-flex gap-1 flex-shrink-0">
                ${target === FOLDER ? '<button type="button" class="btn btn-sm btn-theme-outline px-2 py-1" style="font-size:0.72rem;" data-sync-action="change-folder">Change Folder</button>' : ''}
                ${target === S3 ? '<button type="button" class="btn btn-sm btn-theme-outline px-2 py-1" style="font-size:0.72rem;" data-sync-action="edit-s3">Bucket Settings</button>' : ''}
                <button type="button" class="btn btn-sm btn-theme-outline px-2 py-1" style="font-size:0.72rem;" data-sync-action="switch">Change Location</button>
            </div>
        </div>`;

    const other = plan.other || { receive: [], send: [] };
    if (!plan.changes.length && !plan.needsPush && !other.receive.length) {
        frame(`${header}<div class="text-center py-3"><i class="bi-check2-circle text-success fs-1 d-block mb-2"></i><div class="fw-bold text-white small">Everything is in sync</div><div class="text-white-50" style="font-size:0.75rem;">${plan.unchanged} tab${plan.unchanged === 1 ? '' : 's'} match ${where}.</div></div>`,
            { subtitle: `Sync with ${where}`, footer: button('close', 'Done', { primary: true }) });
        return;
    }

    const parts = [
        down.length && `receive ${down.length}`,
        up.length && `send ${up.length}`,
        removals && `remove ${removals}`
    ].filter(Boolean);

    frame(`
        ${header}
        ${unusual ? `<div class="small text-warning mb-3 p-2 rounded-2 backup-summary-box"><i class="bi-exclamation-triangle-fill me-1"></i> This removes ${removals} of ${total} tabs. If that isn't what you expect, cancel and check ${where} first.</div>` : ''}
        <div class="row g-2 mb-3">
            ${tile(down.length, 'To receive', 'text-info')}
            ${tile(up.length, 'To send', 'text-success')}
            ${tile(removeHere.length, 'Removed here', 'text-warning')}
            ${tile(removeThere.length, `Removed from ${target === DRIVE ? 'Drive' : target === ICLOUD ? 'iCloud' : target === S3 ? 'bucket' : 'folder'}`, 'text-warning')}
        </div>
        ${section(removeHere, { icon: 'bi-trash3', title: 'Removed from this device', tone: 'text-warning', note: `Removed from ${where} on another device. Older snapshots still hold a copy.` })}
        ${section(removeThere, { icon: 'bi-cloud-minus', title: `Removed from ${where}`, tone: 'text-warning', note: 'You removed these here. Older snapshots still hold a copy.' })}
        ${section(down, { icon: 'bi-cloud-arrow-down', title: 'Received on this device', tone: 'text-info' })}
        ${section(up, { icon: 'bi-cloud-arrow-up', title: `Sent to ${where}`, tone: 'text-success' })}
        ${otherSection(other.receive, { icon: 'bi-sliders', title: 'Library and settings received', tone: 'text-info' })}
        ${otherSection(other.send, { icon: 'bi-sliders', title: `Library and settings sent to ${where}`, tone: 'text-success' })}
        <div class="text-white-50 mt-2" style="font-size:0.72rem;">
            Library entries and settings are merged, so nothing there is deleted. A new snapshot is saved only when this device has something to send.
        </div>`,
        {
            subtitle: `Sync with ${where}`,
            footer: button('close', 'Cancel') + button('apply', parts.length ? `Sync Now (${parts.join(', ')})` : 'Sync Now', { primary: true, icon: 'bi-arrow-repeat' })
        });
}

function showProgress(target) {
    frame(`
        <div class="p-2 rounded-2" style="background: rgba(0,0,0,0.25); border: 1px solid var(--border-subtle);">
            <div class="d-flex justify-content-between text-white small mb-1" style="font-size: 0.75rem;">
                <span id="syncProgressText" class="text-truncate">Starting...</span>
                <span id="syncProgressPercent" class="fw-bold text-info ms-2">0%</span>
            </div>
            <div class="progress" style="height: 6px; background: rgba(255,255,255,0.1);">
                <div class="progress-bar progress-bar-striped progress-bar-animated bg-primary" id="syncProgressBar" role="progressbar" style="width: 0%;"></div>
            </div>
        </div>
        <div class="small text-white-50 mt-2">Keep this window open until it finishes.</div>`, { subtitle: `Syncing with ${targetLabel(target)}` });
}

function updateProgress({ phase, current, total, text }) {
    const share = total > 0 ? current / total : 0;
    // Receiving takes the first half of the bar and sending the second
    const pct = Math.min(99, Math.round(phase === 'pull' ? share * 50 : 50 + share * 49));
    const bar = modal.querySelector('#syncProgressBar');
    if (bar) bar.style.width = `${pct}%`;
    const pctEl = modal.querySelector('#syncProgressPercent');
    if (pctEl) pctEl.textContent = `${pct}%`;
    const textEl = modal.querySelector('#syncProgressText');
    if (textEl) textEl.textContent = text;
}

function showDone(target, r) {
    const lines = [
        r.downloaded && `Received ${r.downloaded} tab${r.downloaded === 1 ? '' : 's'}`,
        r.uploaded && `Sent ${r.uploaded} (${formatBytes(r.bytesSent)})`,
        r.removedLocal && `Removed ${r.removedLocal} from this device`,
        r.removedRemote && `Removed ${r.removedRemote} from ${targetLabel(target)}`
    ].filter(Boolean);
    reloadOnClose = Boolean(r.downloaded || r.removedLocal);
    frame(`<div class="text-center py-3"><i class="bi-check2-circle text-success fs-1 d-block mb-2"></i>
        <div class="fw-bold text-white small mb-1">Sync complete</div>
        <div class="text-white-50" style="font-size:0.75rem;">${lines.length ? lines.map(escapeHtml).join('<br>') : 'Library and settings are up to date.'}</div></div>`,
        { subtitle: `Synced with ${targetLabel(target)}`, footer: button('close', 'Done', { primary: true }) });
}

function showError(message) {
    frame(`<div class="small text-danger py-2"><i class="bi-exclamation-triangle-fill me-1"></i> ${escapeHtml(message)}</div>`,
        { subtitle: 'Sync stopped', footer: button('close', 'Close') + button('retry', 'Try Again', { primary: true }) });
}

// --- flow ---

/** Compare and show the review screen. `interactive` calls come from a click, so folders may prompt. */
async function start({ interactive = false } = {}) {
    const mine = ++session;
    const target = getTarget();
    if (!target) return showChooseLocation();
    const setStep = showChecking(target);
    try {
        setStep(target === DRIVE ? 'Signing in to Google Drive...' : target === ICLOUD ? 'Opening iCloud Drive...' : target === S3 ? 'Connecting to the bucket...' : 'Opening the sync folder...');
        const resolved = await resolveBackend(target, { interactive });
        if (mine !== session) return;
        // @googleDrive:begin
        if (resolved.status === 'needs-auth' && !interactive && !sessionStorage.getItem(AUTO_AUTH_KEY)) {
            // Google sign-ins last about an hour; go straight back instead of asking again
            sessionStorage.setItem(AUTO_AUTH_KEY, '1');
            const { redirectToGoogleAuth } = await import('./googleDrive.js');
            return redirectToGoogleAuth('sync');
        }
        // @googleDrive:end
        sessionStorage.removeItem(AUTO_AUTH_KEY);
        if (resolved.status !== 'ready') return showNeedsSetup(resolved.status, resolved.folderName);

        setStep(target === DRIVE ? 'Listing snapshots on Google Drive...' : target === ICLOUD ? 'Listing snapshots in iCloud Drive...' : target === S3 ? 'Listing snapshots in the bucket...' : 'Listing snapshots in the folder...');
        const plan = await planSync(resolved.backend, (text) => { if (mine === session) setStep(text); });
        stopChecking();
        if (mine !== session) return;
        // Nothing to move yet: record the baseline now so later removals are understood
        if (plan.firstSync && !plan.changes.length && !plan.needsPush) await applySync(resolved.backend, plan);
        context = { target, backend: resolved.backend, plan };
        showReview(target, resolved.backend, plan);
    } catch (err) {
        stopChecking();
        if (mine !== session) return;
        console.error('[Sync] Could not compare:', err);
        showError(err.message);
    }
}

async function apply() {
    if (!context) return;
    const { target, backend, plan } = context;
    const mine = ++session;
    showProgress(target);
    try {
        const result = await applySync(backend, plan, updateProgress);
        if (mine !== session) return;
        context = null;
        showDone(target, result);
        refreshSyncStatus();
    } catch (err) {
        if (mine !== session) return;
        console.error('[Sync] Failed:', err);
        showError(err.message);
    }
}

async function handleAction(action) {
    try {
        if (action === 'close') return closeSyncModal();
        if (action === 'retry') return start({ interactive: true });
        if (action === 'apply') return apply();
        if (action === 'switch') return showChooseLocation();
        // @googleDrive:begin
        if (action === 'pick-google-drive') {
            setTarget(DRIVE);
            const { isTokenValid, ensureFreshToken, redirectToGoogleAuth } = await import('./googleDrive.js');
            await ensureFreshToken();
            if (!isTokenValid()) return redirectToGoogleAuth('sync');
            return start();
        }
        // @googleDrive:end
        if (action === 'pick-icloud') {
            setTarget(ICLOUD);
            return start();
        }
        if (action === 'pick-s3' || action === 'edit-s3') return showS3Form();
        if (action === 'save-s3') {
            try {
                await saveS3ConfigFromForm(modal);
            } catch (err) {
                return showS3Form(err.message);
            }
            setTarget(S3);
            return start();
        }
        if (action === 'pick-folder') {
            const { pickBackupFolder } = await import('./folderBackup.js');
            if (!(await pickBackupFolder())) return;
            setTarget(FOLDER);
            return start();
        }
        // @googleDrive:begin
        if (action === 'connect') {
            const { redirectToGoogleAuth } = await import('./googleDrive.js');
            return redirectToGoogleAuth('sync');
        }
        // @googleDrive:end
        if (action === 'choose-folder' || action === 'allow-folder') return start({ interactive: true });
        if (action === 'change-folder') {
            const { pickBackupFolder } = await import('./folderBackup.js');
            if (!(await pickBackupFolder())) return;
            return start();
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

export async function openSyncModal() {
    getModal();
    reloadOnClose = false;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    const fileMenu = document.getElementById('fileMenu');
    if (fileMenu) bootstrap.Offcanvas.getInstance(fileMenu)?.hide();

    if (!modal.dataset.wired) {
        modal.dataset.wired = '1';
        modal.addEventListener('click', (e) => {
            if (e.target === modal) return closeSyncModal();
            const action = e.target.closest('[data-sync-action]')?.dataset.syncAction;
            if (action) handleAction(action);
        });
    }
    await start();
}

export function initSync() {
    document.getElementById('syncDataBtn')?.addEventListener('click', openSyncModal);
    // Desktop and mobile sign in without reloading the page, so resume the comparison that was waiting on it
    window.addEventListener('googleAuthSuccess', (e) => {
        if (e.detail?.state !== 'sync' || modal?.style.display !== 'flex') return;
        sessionStorage.removeItem(AUTO_AUTH_KEY);
        start({ interactive: true });
    });
    refreshSyncStatus();
}
