// syncUi.js
// The Sync task: a row in Settings (Library and backup) that opens in place under its row. One tap, then a single review of exactly what will change
// (see syncEngine.js), one confirmation, and a short result. The sync location is remembered.
import { planSync, applySync, clearSyncBase } from './syncEngine.js';
import { UPGRADE_MARKER_NAME } from './incrementalBackup.js';
import { planPackSync, applyPackSync, exportLocalToStore, seedItemBaselines, replaceRemoteFromLocal, ITEM_ACTION } from './storage/packSync.js';
import { probeLocation, needsUpgrade, upgradeLocation } from './storage/upgrade.js';
import { writeStoreInfo, StoreTooNewError } from './storage/storeInfo.js';
import { createProviderStore } from './storageProviders.js';
import { createLocalAdapter, localBaselines, isHybridSyncEnabled, setHybridSyncEnabled, evictLocalHeavyAssets } from './packSyncLocal.js';
import { formatBytes, escapeHtml } from './backupRestore.js';
import { isFolderBackupSupported } from './folderBackup.js';
import { isIcloudDriveSupported, ICLOUD_UNAVAILABLE_MESSAGE } from './icloudDrive.js';
import { s3ConfigFormHtml, saveS3ConfigFromForm } from './s3Ui.js';
import { webdavConfigFormHtml, saveWebDavConfigFromForm } from './webdavUi.js';
import { getS3Config, clearS3Config } from './s3Client.js';
import { getWebDavConfig, clearWebDavConfig } from './webdavClient.js';
import { showToast } from './utils/toast.js';
import {
    DRIVE, FOLDER, ICLOUD, S3, WEBDAV, MASS_REMOVAL_SHARE, MASS_REMOVAL_MIN,
    getTarget, setTarget, providerOf, rememberLocation, lastSyncedAt, appVersion,
    targetLabel, resolveBackend,
} from './syncBackend.js';
import {
    getAutoSyncState, onManualSyncComplete, runWithSyncLock, initAutoSync, STATE_CHANGED_EVENT,
} from './autoSync.js';

let modal = null;
let authHandler = null;
let session = 0;
let context = null;
let reloadOnClose = false;

// Set just before sending the user to Google, so a failed sign-in shows the Connect screen instead of looping
const AUTO_AUTH_KEY = 'majestictab_sync_auto_auth';

function relativeTime(ms) {
    const minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

const PAUSE_NOTE = {
    'needs-auth': 'sign in to resume auto-sync',
    'needs-permission': 'allow folder access to resume auto-sync',
    'needs-review': 'review changes in Sync',
    'needs-upgrade': 'upgrade needed in Sync',
    'store-too-new': 'update MajesticTab to sync',
    'offline': 'offline',
};

/** Fills the "Last synced" line under the Sync button in Settings. */
export function refreshSyncStatus() {
    const el = document.getElementById('syncStatusLine');
    if (!el) return;
    const at = lastSyncedAt();
    const target = getTarget();
    const auto = getAutoSyncState();
    if (auto.status === 'syncing' && target) {
        el.textContent = `Syncing with ${targetLabel(target)}...`;
        return;
    }
    const base = at && target
        ? `Last synced ${relativeTime(at)} with ${targetLabel(target)}`
        : 'Not synced yet';
    if (auto.status === 'paused' && PAUSE_NOTE[auto.reason]) {
        el.textContent = `${base} · ${PAUSE_NOTE[auto.reason]}`;
    } else if (auto.status === 'error') {
        el.textContent = `${base} · auto-sync failed`;
    } else {
        el.textContent = base;
    }
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

const REASON = {
    [ITEM_ACTION.DOWNLOAD]: () => 'new or changed there',
    [ITEM_ACTION.UPLOAD]: () => 'new or changed here',
    [ITEM_ACTION.MERGE]: () => 'changed on both sides, will be combined',
    [ITEM_ACTION.DELETE_LOCAL]: () => 'removed on another device',
    [ITEM_ACTION.DELETE_REMOTE]: () => 'removed here',
};
const asChange = (i) => ({ name: i.name, reason: REASON[i.action](i), size: i.size || 0, conflict: Boolean(i.conflict) });

function hybridControlsHtml(target) {
    const on = isHybridSyncEnabled();
    return `
        <div class="sync-hybrid">
            <div class="form-check form-switch sync-hybrid-toggle">
                <input class="form-check-input theme-switch" type="checkbox" id="syncHybridToggle" ${on ? 'checked' : ''}>
                <label class="form-check-label" for="syncHybridToggle">Keep files in cloud until opened</label>
            </div>
            ${on ? textAction('evict-local-heavy', `Remove local files already in ${shortPlace(target)}`) : ''}
        </div>`;
}

function showReview(target, store, plan) {
    const by = (action) => plan.items.filter(c => c.action === action).map(asChange);
    const down = by(ITEM_ACTION.DOWNLOAD);
    const merge = by(ITEM_ACTION.MERGE);
    const up = by(ITEM_ACTION.UPLOAD);
    const removeHere = by(ITEM_ACTION.DELETE_LOCAL);
    const removeThere = by(ITEM_ACTION.DELETE_REMOTE);
    const place = where(target);
    const removals = removeHere.length + removeThere.length;
    const total = plan.items.length + plan.unchanged;
    const unusual = removals >= MASS_REMOVAL_MIN && removals / Math.max(1, total) >= MASS_REMOVAL_SHARE;

    const header = `
        <div class="sync-head">
            <div class="min-w-0">
                <div class="sync-status">${plan.firstSync
                    ? `First sync with this location.${removals ? '' : ' Nothing will be removed.'}`
                    : `Last synced ${escapeHtml(relativeTime(lastSyncedAt()))}`}</div>
                <div class="sync-location" title="${escapeHtml(store.location)}">${escapeHtml(store.location)}</div>
            </div>
            <div class="sync-head-actions">
                ${target === FOLDER ? textAction('change-folder', 'Change folder') : ''}
                ${target === S3 ? textAction('edit-s3', 'Bucket settings') : ''}
                ${target === WEBDAV ? textAction('edit-webdav', 'Server settings') : ''}
                ${textAction('replace-remote', `Replace ${shortPlace(target)}`)}
                ${textAction('switch', 'Change location')}
            </div>
        </div>`;

    const parts = [
        down.length && `receive ${down.length}`,
        up.length && `send ${up.length}`,
        merge.length && `combine ${merge.length}`,
        removals && `remove ${removals}`
    ].filter(Boolean);

    frame(`
        ${header}
        ${unusual ? `<div class="task-status task-status-error" role="alert"><strong>This removes ${removals} of ${total} songs</strong><span class="task-status-detail">If that isn't what you expect, cancel and check ${place} first.</span></div>` : ''}
        ${counts([[down.length, 'to receive'], [up.length, 'to send'], [merge.length, 'to combine'], [removeHere.length, 'removed here'], [removeThere.length, `removed from ${shortPlace(target)}`]])}
        ${section(removeHere, { title: 'Removed from this device', open: true, note: `Removed from ${place} on another device.` })}
        ${section(removeThere, { title: `Removed from ${place}`, open: true, note: 'You removed these here.' })}
        ${section(down, { title: 'Received on this device' })}
        ${section(merge, { title: 'Combined with the copy there' })}
        ${section(up, { title: `Sent to ${place}` })}
        <p class="sync-hint">
            Songs, collections, recents, setlists and settings follow the newest change on either side, and a removal on one side is carried to the other. When both sides changed a song, its tabs and recordings are combined and none is dropped.
        </p>
        ${hybridControlsHtml(target)}`,
        {
            subtitle: `Sync with ${place}`,
            footer: button('close', 'Cancel') + button('apply', parts.length ? `Sync now (${parts.join(', ')})` : 'Sync now', { primary: true })
        });
}

/** Confirms overwriting the remote store with this device's library. */
function showConfirmReplace(target, store) {
    const place = where(target);
    frame(`
        <div class="task-status task-status-error" role="alert">
            <strong>Replace everything in ${escapeHtml(place)}?</strong>
            <span class="task-status-detail">This sends every song and setting from this device and removes anything in ${escapeHtml(place)} that is not on this device.</span>
        </div>`,
        {
            subtitle: `Replace ${place}`,
            footer: button('back-to-review', 'Cancel') + button('confirm-replace-remote', `Replace ${shortPlace(target)}`, { danger: true })
        });
}

/** The old layout is here and the new one is not: say what the upgrade does and wait for the press. */
function showUpgrade(target, store, probe) {
    const place = where(target);
    frame(`
        <div class="task-status" role="status">
            <strong>${probe.partial ? 'Finish upgrading this backup location' : 'Upgrade this backup location'}</strong>
            <span class="task-status-detail">${escapeHtml(place.charAt(0).toUpperCase() + place.slice(1))} holds a library saved by an earlier version of MajesticTab. Upgrading keeps it as one .mpak file per song, which syncs faster and can be opened by other music tools.</span>
        </div>
        <p class="sync-hint">This device syncs with the existing copy one last time, so nothing is missed. The existing copy is not changed or removed.</p>
        <p class="sync-hint">Update MajesticTab on your other devices before they sync again. Older versions keep using the existing copy and will not see changes made after the upgrade.</p>
        <div class="sync-hint" title="${escapeHtml(store.location)}">${escapeHtml(store.location)}</div>`,
        { subtitle: `Sync with ${place}`, footer: button('close', 'Not now') + button('upgrade', probe.partial ? 'Finish upgrade' : 'Upgrade', { primary: true }) });
}

function showProgress(target, { upgrade = false } = {}) {
    frame(`
        <div class="task-progress" role="status" aria-live="polite">
            <div class="task-progress-text"><span class="task-progress-label" id="syncProgressPercent">0%</span><span class="task-progress-detail" id="syncProgressText">Starting...</span></div>
            ${progressTrack('syncProgressBar')}
        </div>
        <p class="sync-hint">Keep this window open until it finishes.</p>`, { subtitle: `${upgrade ? 'Upgrading' : 'Syncing with'} ${targetLabel(target)}` });
}

function setProgressText(text) {
    const textEl = modal.querySelector('#syncProgressText');
    if (textEl) textEl.textContent = text;
}

function setProgress(pct, text) {
    const clamped = Math.max(0, Math.min(99, Math.round(pct)));
    const bar = modal.querySelector('#syncProgressBarFill');
    if (bar) bar.style.transform = `scaleX(${clamped / 100})`;
    modal.querySelector('#syncProgressBar')?.setAttribute('aria-valuenow', String(clamped));
    const pctEl = modal.querySelector('#syncProgressPercent');
    if (pctEl) pctEl.textContent = `${clamped}%`;
    if (text !== undefined) setProgressText(text);
}

function updateProgress({ phase, current, total, text }) {
    const share = total > 0 ? current / total : 0;
    // Receiving takes the first half of the bar and sending the second
    setProgress(phase === 'pull' ? share * 50 : 50 + share * 49, text);
}

function showDone(target, r, { title = 'Sync complete' } = {}) {
    const lines = [
        r.downloaded && `Received ${r.downloaded} song${r.downloaded === 1 ? '' : 's'}`,
        r.merged && `Combined ${r.merged} song${r.merged === 1 ? '' : 's'} with the copy there`,
        r.uploaded && `Sent ${r.uploaded}`,
        r.removedHere && `Removed ${r.removedHere} from this device`,
        r.removedThere && `Removed ${r.removedThere} from ${targetLabel(target)}`,
        r.records && (r.records.pulled || r.records.pushed) && 'Library and settings updated'
    ].filter(Boolean);
    const failed = r.failed || [];
    reloadOnClose = Boolean(r.downloaded || r.merged || r.removedHere || r.records?.pulled || r.records?.removedHere);
    frame(`<div class="task-status" role="status"><strong>${escapeHtml(title)}</strong>
        <span class="task-status-detail">${lines.length ? lines.map(escapeHtml).join('<br>') : 'Library and settings are up to date.'}</span></div>
        ${failed.length ? notice(`${failed.length} song${failed.length === 1 ? '' : 's'} could not be synced and will be tried again next time: ${escapeHtml(failed.map((f) => f.reason).filter((v, i, a) => a.indexOf(v) === i).join('; '))}`, { error: true }) : ''}
        ${context?.store ? hybridControlsHtml(target) : ''}`,
        { subtitle: `Synced with ${targetLabel(target)}`, footer: button('close', 'Done', { primary: true }) });
}

function showError(message, note = '') {
    frame(notice(escapeHtml(message), { error: true }) + (note ? `<p class="sync-hint">${escapeHtml(note)}</p>` : ''),
        { subtitle: 'Sync stopped', footer: button('close', 'Close') + button('retry', 'Try again', { primary: true }) });
}

// --- flow ---

/** What a failure left behind. Items already moved stay moved; the rest is offered again. */
function failureNote(target) {
    return `Songs already received or sent were kept, and nothing was lost. Try again to pick up the rest.`;
}

/** Opens the chosen location, in both layouts. Resolves to what the screens need, or shows the setup screen and returns null. */
async function openLocation(target, mine, setStep, interactive) {
    setStep(target === DRIVE ? 'Signing in to Google Drive...' : target === ICLOUD ? 'Opening iCloud Drive...' : target === S3 ? 'Connecting to the bucket...' : target === WEBDAV ? 'Connecting to the server...' : 'Opening the sync folder...');
    const resolved = await resolveBackend(target, { interactive });
    if (mine !== session) return null;
    // @googleDrive:begin
    if (resolved.status === 'needs-auth' && !interactive && !sessionStorage.getItem(AUTO_AUTH_KEY)) {
        // Google sign-ins last about an hour; go straight back instead of asking again
        sessionStorage.setItem(AUTO_AUTH_KEY, '1');
        const { redirectToGoogleAuth } = await import('./googleDrive.js');
        await redirectToGoogleAuth('sync');
        return null;
    }
    // @googleDrive:end
    sessionStorage.removeItem(AUTO_AUTH_KEY);
    if (resolved.status !== 'ready') { showNeedsSetup(resolved.status, resolved.folderName); return null; }
    const store = await createProviderStore(providerOf(target));
    if (!store) { showNeedsSetup(`needs-${target === FOLDER ? 'folder' : target}`); return null; }
    return { legacy: resolved.backend, store };
}

const location = (target, store) => `${target}|${store.location}`;

/** Compare and show the review screen. `interactive` calls come from a click, so folders may prompt. */
async function start({ interactive = false } = {}) {
    const mine = ++session;
    const target = getTarget();
    if (!target) return showChooseLocation();
    const setStep = showChecking(target);
    try {
        const opened = await openLocation(target, mine, setStep, interactive);
        if (!opened || mine !== session) return;
        const { legacy, store } = opened;

        setStep('Looking at what is stored there...');
        const probe = await probeLocation({ legacy, current: store });
        if (mine !== session) return;
        if (needsUpgrade(probe)) {
            stopChecking();
            context = { target, legacy, store, probe };
            return showUpgrade(target, store, probe);
        }
        // Nothing of ours there yet: this sync creates the library
        if (probe.state === 'none') { await store.open({ create: true }); await writeStoreInfo(store, { appVersion: await appVersion() }); }

        setStep('Comparing songs...');
        const local = createLocalAdapter();
        const hybrid = isHybridSyncEnabled();
        const plan = await planPackSync({ store, local, baselines: localBaselines, location: location(target, store), hybrid });
        stopChecking();
        if (mine !== session) return;
        context = { target, legacy, store, local, plan, plannedHybrid: hybrid };
        // Nothing to review: still settle the library and settings, which have no review of their own
        if (!plan.items.length) return apply({ quiet: true });
        showReview(target, store, plan);
    } catch (err) {
        stopChecking();
        if (mine !== session) return;
        console.error('[Sync] Could not compare:', err);
        showError(err instanceof StoreTooNewError ? 'This library was saved by a newer MajesticTab. Update MajesticTab on this device to sync with it.' : err.message);
    }
}

async function apply({ quiet = false } = {}) {
    if (!context?.plan) return;
    const { target, store, local } = context;
    const mine = ++session;
    if (!quiet) showProgress(target);
    try {
        const result = await runWithSyncLock(() => applyPackSync({
            store, local, baselines: localBaselines, location: location(target, store), hybrid: isHybridSyncEnabled(),
            onProgress: (p) => {
                if (quiet) return;
                const push = p.action === ITEM_ACTION.UPLOAD || p.action === ITEM_ACTION.DELETE_REMOTE;
                updateProgress({ phase: push ? 'push' : 'pull', current: p.current - 1, total: p.total, text: p.name });
            },
        }));
        if (mine !== session) return;
        rememberLocation(location(target, store));
        onManualSyncComplete();
        context = null;
        showDone(target, result, { title: quiet ? 'Everything is in sync' : 'Sync complete' });
        refreshSyncStatus();
    } catch (err) {
        if (mine !== session) return;
        console.error('[Sync] Failed:', err);
        showError(err.message, failureNote(target));
    }
}

/** Overwrites the remote store with this device's library after confirmation. */
async function replaceRemote() {
    if (!context?.store) return;
    const { target, store, local } = context;
    const mine = ++session;
    showProgress(target);
    try {
        const result = await runWithSyncLock(() => replaceRemoteFromLocal({
            store, local, baselines: localBaselines, location: location(target, store),
            onProgress: (p) => {
                if (mine !== session) return;
                const push = p.action === ITEM_ACTION.UPLOAD || p.action === ITEM_ACTION.DELETE_REMOTE;
                updateProgress({ phase: push ? 'push' : 'pull', current: p.current - 1, total: p.total, text: p.name });
            },
        }));
        if (mine !== session) return;
        rememberLocation(location(target, store));
        onManualSyncComplete();
        context = null;
        showDone(target, result, { title: `Replaced ${where(target)}` });
        refreshSyncStatus();
    } catch (err) {
        if (mine !== session) return;
        console.error('[Sync] Replace remote failed:', err);
        showError(err.message, failureNote(target));
    }
}

/** Moves the location from the old layout to the new one, then goes on to a normal sync. */
async function upgrade() {
    if (!context?.probe) return;
    const { target, legacy, store } = context;
    const mine = ++session;
    showProgress(target, { upgrade: true });
    const local = createLocalAdapter();
    let maxPct = 0;
    const advance = (pct, text) => {
        maxPct = Math.max(maxPct, pct);
        setProgress(maxPct, text);
    };
    const say = (text, info) => {
        if (mine !== session) return;
        if (!info?.total) return setProgressText(text);
        const share = info.current / info.total;
        if (text === 'Checking') advance(85 + share * 14, `Checking (${info.current} of ${info.total})`);
        else advance(30 + share * 55, info.name || text);
    };
    try {
        await upgradeLocation({
            legacy, current: store, appVersion: await appVersion(), onStatus: say,
            // The existing sync, so this device holds everything the old copy holds before the new copy is written
            syncWithLegacy: async () => {
                const plan = await planSync(legacy, (t) => say(t));
                await applySync(legacy, plan, (p) => {
                    if (mine !== session) return;
                    const share = p.total > 0 ? p.current / p.total : 0;
                    advance(p.phase === 'pull' ? share * 15 : 15 + share * 15, p.text);
                });
            },
            exportToStore: (to, onProgress) => exportLocalToStore(to, local, onProgress),
            // Versions that still sync with the old copy find this and stop, with a note to update
            markLegacy: () => legacy.putManifest(UPGRADE_MARKER_NAME, JSON.stringify({ app: 'MajesticTab', upgradedTo: 'MajesticTab Library', at: new Date().toISOString() }), { tabs: 0, soundFonts: 0, audio: 0 }),
        });
        await seedItemBaselines({ store, local, baselines: localBaselines, location: location(target, store) });
        if (mine !== session) return;
        reloadOnClose = true;
        return start();
    } catch (err) {
        if (mine !== session) return;
        console.error('[Sync] Upgrade failed:', err);
        showError(err.message, 'The existing copy was not changed. Try the upgrade again; it picks up where it stopped.');
    }
}

async function evictHeavy() {
    if (!context?.store) return;
    const { target, store } = context;
    showProgress(target);
    updateProgress({ phase: 'pull', current: 1, total: 2, text: `Checking ${where(target)}...` });
    try {
        const res = await evictLocalHeavyAssets({ store, baselines: localBaselines, location: location(target, store) });
        if (res.freedAudio || res.freedSoundFonts || res.freedScores) {
            reloadOnClose = true;
            const mb = res.freedBytes >= 1024 * 1024 ? ` (${(res.freedBytes / (1024 * 1024)).toFixed(1)} MB)` : '';
            showToast(`Removed local files from this device${mb}. Copies remain in ${where(target)}.`, 'success');
        } else {
            showToast(`No local files in ${where(target)} to remove.`, 'info');
        }
        return start();
    } catch (err) {
        console.error('[Sync] Free local copies failed:', err);
        showError(err.message);
    }
}

async function handleAction(action) {
    try {
        if (action === 'close') return closeSyncModal();
        if (action === 'upgrade') return upgrade();
        if (action === 'retry') return start({ interactive: true });
        if (action === 'apply') return apply();
        if (action === 'evict-local-heavy') return evictHeavy();
        if (action === 'replace-remote' && context) return showConfirmReplace(context.target, context.store);
        if (action === 'back-to-review' && context) return showReview(context.target, context.store, context.plan);
        if (action === 'confirm-replace-remote') return replaceRemote();
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
async function onHybridToggle(checked) {
    setHybridSyncEnabled(checked);
    if (!context?.plan || !context?.store) return start();
    const { target, store, local } = context;
    if (checked) {
        const basePlan = context.fullPlan || context.plan;
        context.fullPlan = basePlan;
        context.plan = {
            ...basePlan,
            items: basePlan.items.filter((i) => !(i.kind === 'soundfont' && i.action === ITEM_ACTION.DOWNLOAD)),
        };
        return showReview(target, store, context.plan);
    }
    if (context.fullPlan && !context.plannedHybrid) {
        context.plan = context.fullPlan;
        return showReview(target, store, context.plan);
    }
    // Originally planned with hybrid=true, so SoundFont downloads were omitted; re-plan without re-opening or probing
    const applyBtn = modal.querySelector('[data-sync-action="apply"]');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Updating...'; }
    const mine = session;
    try {
        const plan = await planPackSync({ store, local, baselines: localBaselines, location: location(target, store), hybrid: false });
        if (mine !== session || !context) return;
        context.plan = plan;
        context.fullPlan = plan;
        context.plannedHybrid = false;
        showReview(target, store, plan);
    } catch (err) {
        if (mine !== session) return;
        console.error('[Sync] Could not update comparison:', err);
        showError(err.message);
    }
}

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
        modal.addEventListener('change', (e) => {
            if (e.target.id === 'syncHybridToggle') onHybridToggle(e.target.checked);
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
    window.addEventListener(STATE_CHANGED_EVENT, refreshSyncStatus);
    refreshSyncStatus();
    initAutoSync();
}
