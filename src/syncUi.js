// syncUi.js
// The Sync task: a row in Settings (Library and backup) that opens in place under its row. One tap, then a single review of exactly what will change
// (see syncEngine.js), one confirmation, and a short result. The sync location is remembered.
import { planSync, applySync, planReplaceRemote, applyReplaceRemote, getSyncBase, clearSyncBase, SYNC_ACTION } from './syncEngine.js';
import { formatBytes, escapeHtml } from './backupRestore.js';
import { isFolderBackupSupported } from './folderBackup.js';
import { isIcloudDriveSupported, ICLOUD_UNAVAILABLE_MESSAGE } from './icloudDrive.js';
import { getPreferredStorage, setPreferredStorage } from './fileProviders.js';
import { s3ConfigFormHtml, saveS3ConfigFromForm } from './s3Ui.js';
import { webdavConfigFormHtml, saveWebDavConfigFromForm } from './webdavUi.js';
import { getS3Config, clearS3Config } from './s3Client.js';
import { getWebDavConfig, clearWebDavConfig } from './webdavClient.js';
import { showToast } from './utils/toast.js';

const DRIVE = 'google-drive';
const FOLDER = 'folder';
const ICLOUD = 'icloud';
const S3 = 's3';
const WEBDAV = 'webdav';
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
const targetLabel = (target) => target === DRIVE ? 'Google Drive' : target === ICLOUD ? 'iCloud Drive' : target === S3 ? 'your S3 bucket' : target === WEBDAV ? 'your WebDAV server' : 'your backup folder';

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
        : 'Not synced yet';
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
    if (target === WEBDAV) {
        const { createWebDavBackend } = await import('./webdavBackup.js');
        const backend = createWebDavBackend();
        return backend ? { status: 'ready', backend } : { status: 'needs-webdav' };
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
    if (modal) return modal;
    modal = document.getElementById('syncModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'syncModal';
        modal.className = 'theme-modal-backdrop tool-embedded';
        modal.setAttribute('aria-label', 'Sync');
        modal.style.display = 'none';
        document.body.appendChild(modal);
    }
    return modal;
}

/** Stops whatever the task is doing and puts its element back out of the way. */
function reset() {
    session++;
    stopChecking();
    context = null;
    if (modal) {
        modal.style.display = 'none';
        document.body.appendChild(modal);
    }
    refreshSyncStatus();
}

export async function closeSyncModal() {
    const mod = await import('./backupRestore.js');
    reset();
    mod.setTaskOpenState(null);
    // Open library views read their stores once, so a reload shows what the sync brought in
    if (reloadOnClose) { reloadOnClose = false; window.location.reload(); }
}

function frame(body, { subtitle = '', footer = '' } = {}) {
    // The row names the task, so the screen opens with its own state line instead of a second title
    modal.innerHTML = `
    <div class="theme-modal-card backup-modal-card sync-card" role="region" aria-label="Sync">
      <div class="theme-modal-body sync-body">${subtitle ? `<div class="sync-subtitle">${subtitle}</div>` : ''}${body}</div>
      ${footer ? `<div class="theme-modal-footer sync-footer">${footer}</div>` : ''}
    </div>`;
}

const button = (action, label, { primary = false, danger = false } = {}) =>
    `<button type="button" class="btn btn-sm ${danger ? 'btn-theme-danger' : primary ? 'btn-theme-primary' : 'btn-theme-outline'}" data-sync-action="${action}">${label}</button>`;

const textAction = (action, label) => `<button type="button" class="sync-text-action" data-sync-action="${action}">${label}</button>`;

const notice = (text, { error = false } = {}) => `<div class="task-status${error ? ' task-status-error' : ''}" role="${error ? 'alert' : 'status'}">${text}</div>`;

const progressTrack = (id = '', indeterminate = false) =>
    `<div class="task-progress-track${indeterminate ? ' is-indeterminate' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" ${id ? `id="${id}"` : ''}><div class="task-progress-fill"${id ? ` id="${id}Fill"` : ''}></div></div>`;

const where = (target) => targetLabel(target);
const shortPlace = (target) => target === DRIVE ? 'Drive' : target === ICLOUD ? 'iCloud' : target === S3 ? 'bucket' : target === WEBDAV ? 'server' : 'folder';

// --- screens ---

let checkingTimer = null;

function stopChecking() {
    clearInterval(checkingTimer);
    checkingTimer = null;
}

/** Show the compare screen; returns a setter for the current step. A timer shows how long it has run. */
function showChecking(target, { title = `Comparing this device with ${targetLabel(target)}`, subtitle = 'Checking for changes' } = {}) {
    stopChecking();
    frame(`<div class="task-progress" role="status" aria-live="polite">
        <div class="task-progress-text"><span class="task-progress-label">${escapeHtml(title)}</span><span class="task-progress-detail" data-sync-step>Starting...</span></div>
        ${progressTrack('', true)}
        <div class="sync-hint" data-sync-elapsed></div>
    </div>`, { subtitle });
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
        { id: DRIVE, title: 'Google Drive', text: 'Sync across your devices through your Google account.' },
        // @googleDrive:end
        ...(isIcloudDriveSupported()
            ? [{ id: ICLOUD, title: 'iCloud Drive', text: 'Sync through iCloud Drive across your Apple devices. No sign-in needed.' }]
            : []),
        { id: S3, title: 'S3 bucket', text: 'Sync through Amazon S3, Cloudflare R2, Backblaze B2, MinIO or any S3-compatible storage.' },
        { id: WEBDAV, title: 'WebDAV server', text: 'Sync through Nextcloud, ownCloud, Synology or any WebDAV server.' },
        ...(isFolderBackupSupported()
            ? [{ id: FOLDER, title: 'A folder on this device', text: 'Sync through a folder, such as one a cloud drive app keeps in step.' }]
            : [])
    ];
    frame(`
        <p class="sync-lead">Choose where MajesticTab keeps your synced library. You only do this once. Your other devices sync with the same location.</p>
        <div class="sync-list" role="list">
            ${options.map(o => `
                <button type="button" class="sync-option" role="listitem" data-sync-action="pick-${o.id}">
                    <span class="sync-option-title">${o.title}</span>
                    <span class="sync-option-text">${o.text}</span>
                </button>`).join('')}
        </div>`, { subtitle: 'Choose a sync location', footer: button('close', 'Cancel') });
}

function showS3Form(error = '') {
    const hasConfig = Boolean(getS3Config());
    frame(`${error ? notice(escapeHtml(error), { error: true }) : ''}${s3ConfigFormHtml()}`,
        {
            subtitle: 'S3 bucket',
            footer: (hasConfig ? button('disconnect-s3', 'Disconnect', { danger: true }) : '') +
                button('switch', 'Choose another') +
                button('save-s3', 'Save and connect', { primary: true })
        });
}

function showWebDavForm(error = '') {
    const hasConfig = Boolean(getWebDavConfig());
    frame(`${error ? notice(escapeHtml(error), { error: true }) : ''}${webdavConfigFormHtml()}`,
        {
            subtitle: 'WebDAV server',
            footer: (hasConfig ? button('disconnect-webdav', 'Disconnect', { danger: true }) : '') +
                button('switch', 'Choose another') +
                button('save-webdav', 'Save and connect', { primary: true })
        });
}

function showNeedsSetup(status, folderName = '') {
    if (status === 'needs-auth') {
        // @googleDrive:begin
        frame(notice('Connect Google Drive so MajesticTab can compare and sync your library.'),
            { subtitle: 'Google Drive', footer: button('switch', 'Choose another') + button('connect', 'Connect Google Drive', { primary: true }) });
        // @googleDrive:end
    } else if (status === 'needs-icloud') {
        frame(notice(escapeHtml(ICLOUD_UNAVAILABLE_MESSAGE)),
            { subtitle: 'iCloud Drive', footer: button('switch', 'Choose another') + button('retry', 'Try again', { primary: true }) });
    } else if (status === 'needs-s3') {
        showS3Form();
    } else if (status === 'needs-webdav') {
        showWebDavForm();
    } else if (status === 'needs-permission') {
        frame(notice(`MajesticTab needs permission to use "${escapeHtml(folderName)}" again.`),
            { subtitle: 'Backup folder', footer: button('switch', 'Choose another') + button('allow-folder', 'Allow access', { primary: true }) });
    } else {
        frame(notice('Choose the folder to sync through.'),
            { subtitle: 'Backup folder', footer: button('switch', 'Choose another') + button('choose-folder', 'Choose folder', { primary: true }) });
    }
}

/** Plain counts in one line, separated by middle dots; zero counts stay so the layout does not jump. */
function counts(entries) {
    return `<p class="sync-counts">${entries.map(([n, label]) => `<span class="${n ? '' : 'is-zero'}"><strong>${n}</strong> ${label}</span>`).join('<span aria-hidden="true"> · </span>')}</p>`;
}

function section(changes, { title, note = '', open = false }) {
    if (!changes.length) return '';
    const bytes = changes.reduce((acc, c) => acc + c.size, 0);
    return `
        <details class="sync-section" ${changes.length <= 8 || open ? 'open' : ''}>
            <summary><span>${title} (${changes.length})</span>${bytes ? `<span class="sync-meta">${formatBytes(bytes)}</span>` : ''}</summary>
            ${note ? `<div class="sync-hint">${note}</div>` : ''}
            <ul class="sync-rows">
                ${changes.map(c => `
                    <li>
                        <span class="sync-row-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
                        <span class="sync-row-note">${escapeHtml(c.reason)}${c.conflict ? ' · both changed' : ''}${c.size ? ` · ${formatBytes(c.size)}` : ''}</span>
                    </li>`).join('')}
            </ul>
        </details>`;
}

function otherSection(items, { title }) {
    if (!items.length) return '';
    return `
        <details class="sync-section" open>
            <summary><span>${title}</span></summary>
            <ul class="sync-rows">${items.map(i => `<li><span class="sync-row-name">${escapeHtml(i.text)}</span></li>`).join('')}</ul>
        </details>`;
}

/** The one place the destructive option lives. The first press opens a confirmation screen; the second one does it. */
function dangerZone(target) {
    return `
        <div class="sync-danger">
            <h3>Danger zone</h3>
            <div class="sync-danger-row">
                <div class="min-w-0">
                    <div class="sync-row-name">Replace ${where(target)} with this device</div>
                    <div class="sync-row-note">Makes ${where(target)} an exact copy of this library. Anything only stored there is left out.</div>
                </div>
                <button type="button" class="btn btn-sm btn-theme-danger" data-sync-action="replace">Replace...</button>
            </div>
        </div>`;
}

function showReview(target, backend, plan) {
    const by = (action) => plan.changes.filter(c => c.action === action);
    const down = by(SYNC_ACTION.DOWNLOAD);
    const up = by(SYNC_ACTION.UPLOAD);
    const removeHere = by(SYNC_ACTION.DELETE_LOCAL);
    const removeThere = by(SYNC_ACTION.DELETE_REMOTE);
    const place = where(target);
    const removals = removeHere.length + removeThere.length;
    const total = plan.changes.length + plan.unchanged;
    const unusual = removals >= MASS_REMOVAL_MIN && removals / Math.max(1, total) >= MASS_REMOVAL_SHARE;
    const danger = dangerZone(target);

    const header = `
        <div class="sync-head">
            <div class="min-w-0">
                <div class="sync-status">${plan.firstSync
                    ? 'First sync with this location. Nothing will be removed.'
                    : `Last synced ${escapeHtml(relativeTime(plan.lastSyncedAt))}`}</div>
                <div class="sync-location" title="${escapeHtml(backend.location)}">${escapeHtml(backend.location)}</div>
            </div>
            <div class="sync-head-actions">
                ${target === FOLDER ? textAction('change-folder', 'Change folder') : ''}
                ${target === S3 ? textAction('edit-s3', 'Bucket settings') : ''}
                ${target === WEBDAV ? textAction('edit-webdav', 'Server settings') : ''}
                ${textAction('switch', 'Change location')}
            </div>
        </div>`;

    const other = plan.other || { receive: [], send: [] };
    if (!plan.changes.length && !plan.needsPush && !other.receive.length) {
        frame(`${header}<div class="task-status" role="status"><strong>Everything is in sync</strong><span class="task-status-detail">${plan.unchanged} tab${plan.unchanged === 1 ? '' : 's'} match ${place}.</span></div>${danger}`,
            { subtitle: `Sync with ${place}`, footer: button('close', 'Done', { primary: true }) });
        return;
    }

    const parts = [
        down.length && `receive ${down.length}`,
        up.length && `send ${up.length}`,
        removals && `remove ${removals}`
    ].filter(Boolean);

    frame(`
        ${header}
        ${unusual ? `<div class="task-status task-status-error" role="alert"><strong>This removes ${removals} of ${total} tabs</strong><span class="task-status-detail">If that isn't what you expect, cancel and check ${place} first.</span></div>` : ''}
        ${counts([[down.length, 'to receive'], [up.length, 'to send'], [removeHere.length, 'removed here'], [removeThere.length, `removed from ${shortPlace(target)}`]])}
        ${section(removeHere, { title: 'Removed from this device', open: true, note: `Removed from ${place} on another device. Older snapshots still hold a copy.` })}
        ${section(removeThere, { title: `Removed from ${place}`, open: true, note: 'You removed these here. Older snapshots still hold a copy.' })}
        ${section(down, { title: 'Received on this device' })}
        ${section(up, { title: `Sent to ${place}` })}
        ${otherSection(other.receive, { title: 'Library and settings received' })}
        ${otherSection(other.send, { title: `Library and settings sent to ${place}` })}
        <p class="sync-hint">
            Settings, songs, collections, recents and setlists follow the newest change on either side, and a removal on one side is carried to the other. A new snapshot is saved only when this device has something to send.
        </p>
        ${danger}`,
        {
            subtitle: `Sync with ${place}`,
            footer: button('close', 'Cancel') + button('apply', parts.length ? `Sync now (${parts.join(', ')})` : 'Sync now', { primary: true })
        });
}

/** Second step of the destructive option: says exactly what will be left out, and waits for the second press. */
function showReplaceConfirm(target, replacePlan) {
    const place = where(target);
    const { lost } = replacePlan;
    const lines = [
        lost.tabs && `${lost.tabs} tab${lost.tabs === 1 ? '' : 's'}`,
        lost.soundfonts && `${lost.soundfonts} SoundFont${lost.soundfonts === 1 ? '' : 's'}`,
        lost.audio && `${lost.audio} audio file${lost.audio === 1 ? '' : 's'}`,
        lost.records && `${lost.records} setting, song or setlist record${lost.records === 1 ? '' : 's'}`
    ].filter(Boolean);
    frame(`
        <div class="task-status task-status-error" role="alert">
            <strong>Replace ${place} with this device?</strong>
            <span class="task-status-detail">${place} will become an exact copy of this library. Nothing is received from it, and your other devices will follow this device the next time they sync.</span>
        </div>
        ${counts([[replacePlan.sending, 'to send'], [lines.length ? lost.tabs + lost.soundfonts + lost.audio : 0, `left out of ${shortPlace(target)}`], [replacePlan.unchanged, 'already there']])}
        ${lines.length ? `<div class="sync-section"><div class="sync-row-name">Only in ${place}, left out of the new snapshot</div><ul class="sync-rows"><li><span class="sync-row-name">${escapeHtml(lines.join(', '))}</span></li></ul></div>` : `<p class="sync-hint">${place} holds nothing this device lacks.</p>`}
        <p class="sync-hint">Older snapshots stay in ${place} until they age out, so a restore can still reach them. This cannot be undone from here.</p>`,
        {
            subtitle: `Replace ${place}`,
            footer: button('replace-cancel', 'Cancel') + button('replace-confirm', `Replace ${place}`, { danger: true })
        });
}

function showProgress(target, { replace = false } = {}) {
    frame(`
        <div class="task-progress" role="status" aria-live="polite">
            <div class="task-progress-text"><span class="task-progress-label" id="syncProgressPercent">0%</span><span class="task-progress-detail" id="syncProgressText">Starting...</span></div>
            ${progressTrack('syncProgressBar')}
        </div>
        <p class="sync-hint">Keep this window open until it finishes.</p>`, { subtitle: `${replace ? 'Replacing' : 'Syncing with'} ${targetLabel(target)}` });
}

function updateProgress({ phase, current, total, text }) {
    const share = total > 0 ? current / total : 0;
    // Receiving takes the first half of the bar and sending the second
    const pct = Math.min(99, Math.round(phase === 'pull' ? share * 50 : 50 + share * 49));
    const bar = modal.querySelector('#syncProgressBarFill');
    if (bar) bar.style.transform = `scaleX(${pct / 100})`;
    modal.querySelector('#syncProgressBar')?.setAttribute('aria-valuenow', String(pct));
    const pctEl = modal.querySelector('#syncProgressPercent');
    if (pctEl) pctEl.textContent = `${pct}%`;
    const textEl = modal.querySelector('#syncProgressText');
    if (textEl) textEl.textContent = text;
}

function showDone(target, r, { replace = false } = {}) {
    const lines = [
        r.downloaded && `Received ${r.downloaded} tab${r.downloaded === 1 ? '' : 's'}`,
        r.uploaded && `Sent ${r.uploaded} (${formatBytes(r.bytesSent)})`,
        r.removedLocal && `Removed ${r.removedLocal} from this device`,
        r.removedRemote && `Removed ${r.removedRemote} from ${targetLabel(target)}`
    ].filter(Boolean);
    reloadOnClose = Boolean(r.downloaded || r.removedLocal || r.recordsChanged);
    frame(`<div class="task-status" role="status"><strong>${replace ? `${escapeHtml(targetLabel(target))} now matches this device` : 'Sync complete'}</strong>
        <span class="task-status-detail">${lines.length ? lines.map(escapeHtml).join('<br>') : 'Library and settings are up to date.'}</span></div>`,
        { subtitle: `Synced with ${targetLabel(target)}`, footer: button('close', 'Done', { primary: true }) });
}

function showError(message) {
    frame(notice(escapeHtml(message), { error: true }),
        { subtitle: 'Sync stopped', footer: button('close', 'Close') + button('retry', 'Try again', { primary: true }) });
}

// --- flow ---

/** Compare and show the review screen. `interactive` calls come from a click, so folders may prompt. */
async function start({ interactive = false } = {}) {
    const mine = ++session;
    const target = getTarget();
    if (!target) return showChooseLocation();
    const setStep = showChecking(target);
    try {
        setStep(target === DRIVE ? 'Signing in to Google Drive...' : target === ICLOUD ? 'Opening iCloud Drive...' : target === S3 ? 'Connecting to the bucket...' : target === WEBDAV ? 'Connecting to the server...' : 'Opening the sync folder...');
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

        setStep(target === DRIVE ? 'Listing snapshots on Google Drive...' : target === ICLOUD ? 'Listing snapshots in iCloud Drive...' : target === S3 ? 'Listing snapshots in the bucket...' : target === WEBDAV ? 'Listing snapshots on the server...' : 'Listing snapshots in the folder...');
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

/** First press of the destructive option: compare, then show what would be left out. Nothing changes yet. */
async function startReplace() {
    if (!context) return;
    const { target, backend } = context;
    const mine = ++session;
    const setStep = showChecking(target, { title: `Reading ${targetLabel(target)}`, subtitle: `Replace ${targetLabel(target)}` });
    try {
        const replacePlan = await planReplaceRemote(backend, (text) => { if (mine === session) setStep(text); });
        stopChecking();
        if (mine !== session) return;
        context.replacePlan = replacePlan;
        showReplaceConfirm(target, replacePlan);
    } catch (err) {
        stopChecking();
        if (mine !== session) return;
        console.error('[Sync] Could not read the sync location:', err);
        showError(err.message);
    }
}

/** Second press: this device's library becomes the new snapshot. */
async function confirmReplace() {
    if (!context?.replacePlan) return;
    const { target, backend, replacePlan } = context;
    const mine = ++session;
    showProgress(target, { replace: true });
    try {
        const result = await applyReplaceRemote(backend, replacePlan, updateProgress);
        if (mine !== session) return;
        context = null;
        showDone(target, result, { replace: true });
        refreshSyncStatus();
    } catch (err) {
        if (mine !== session) return;
        console.error('[Sync] Replace failed:', err);
        showError(err.message);
    }
}

async function handleAction(action) {
    try {
        if (action === 'close') return closeSyncModal();
        if (action === 'replace') return startReplace();
        if (action === 'replace-confirm') return confirmReplace();
        if (action === 'replace-cancel') return context ? showReview(context.target, context.backend, context.plan) : start();
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
        if (action === 'disconnect-s3') {
            clearS3Config();
            clearSyncBase();
            showToast('Disconnected S3 bucket on this device.', 'info');
            return showChooseLocation();
        }
        if (action === 'save-s3') {
            try {
                await saveS3ConfigFromForm(modal);
            } catch (err) {
                return showS3Form(err.message);
            }
            setTarget(S3);
            return start();
        }
        if (action === 'pick-webdav' || action === 'edit-webdav') return showWebDavForm();
        if (action === 'disconnect-webdav') {
            clearWebDavConfig();
            clearSyncBase();
            showToast('Disconnected WebDAV server on this device.', 'info');
            return showChooseLocation();
        }
        if (action === 'save-webdav') {
            try {
                await saveWebDavConfigFromForm(modal);
            } catch (err) {
                return showWebDavForm(err.message);
            }
            setTarget(WEBDAV);
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

/** Opens the Sync task under its row in Settings and compares. Used by the row and by the Sync button in the library. */
export async function openSyncModal() {
    const back = await import('./backupRestore.js');
    const host = await back.getSettingsDataHost('sync');
    if (!host) return console.warn('[Sync] Settings is not available');
    back.closeBackupModal();
    reset();
    getModal();
    reloadOnClose = false;
    host.appendChild(modal);
    modal.style.display = 'block';
    back.setTaskOpenState('sync');
    if (!modal.dataset.wired) {
        modal.dataset.wired = '1';
        modal.addEventListener('click', (e) => {
            const action = e.target.closest('[data-sync-action]')?.dataset.syncAction;
            if (action) handleAction(action);
        });
    }
    await start();
}

export function initSync() {
    // The Sync row in Settings opens the task itself (settingsPage.js); another data task opening closes this one
    window.addEventListener('dataTaskOpened', () => { if (modal?.style.display === 'block') reset(); });
    // Desktop and mobile sign in without reloading the page, so resume the comparison that was waiting on it
    window.addEventListener('googleAuthSuccess', (e) => {
        if (e.detail?.state !== 'sync' || modal?.style.display !== 'block') return;
        sessionStorage.removeItem(AUTO_AUTH_KEY);
        start({ interactive: true });
    });
    refreshSyncStatus();
}
