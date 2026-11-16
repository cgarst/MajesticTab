// syncBackend.js
// Shared, DOM-free helpers for resolving the configured sync target and opening its pack store.
// Used by both the interactive Sync task (syncUi.js) and background auto-sync (autoSync.js).
import { createProviderStore } from './storageProviders.js';
import { localBaselines } from './packSyncLocal.js';
import { getPreferredStorage, setPreferredStorage } from './fileProviders.js';

export const DRIVE = 'google-drive';
export const FOLDER = 'folder';
export const ICLOUD = 'icloud';
export const S3 = 's3';
export const WEBDAV = 'webdav';

// A plan that removes this share of the tabs (and at least MASS_REMOVAL_MIN) is called out as unusual
export const MASS_REMOVAL_SHARE = 0.5;
export const MASS_REMOVAL_MIN = 5;

export const LAST_LOCATION_KEY = 'majestictab_sync_location';

export const getTarget = getPreferredStorage;
export const setTarget = setPreferredStorage;
export const providerOf = (target) => (target === FOLDER ? 'local' : target);
export const locationOf = (target, store) => `${target}|${store.location}`;

export function rememberLocation(location) {
    try { localStorage.setItem(LAST_LOCATION_KEY, location); } catch (_) {}
}

export function lastSyncedAt() {
    try {
        const l = localStorage.getItem(LAST_LOCATION_KEY);
        return l ? localBaselines.get(l)?.syncedAt || 0 : 0;
    } catch (_) {
        return 0;
    }
}

export async function appVersion() {
    try {
        const [{ default: info }, { formatBuildVersion }] = await Promise.all([import('./build-info.js'), import('./updater.js')]);
        return formatBuildVersion(info);
    } catch (_) {
        return '';
    }
}

export function targetLabel(target) {
    return target === DRIVE ? 'Google Drive'
        : target === ICLOUD ? 'iCloud Drive'
            : target === S3 ? 'your S3 bucket'
                : target === WEBDAV ? 'your WebDAV server'
                    : 'your backup folder';
}

export function isMassRemovalPlan(plan) {
    const removals = (plan?.items || []).filter((c) => c.action === 'delete-local' || c.action === 'delete-remote').length;
    const total = (plan?.items?.length || 0) + (plan?.unchanged || 0);
    return {
        removals,
        total,
        unusual: removals >= MASS_REMOVAL_MIN && removals / Math.max(1, total) >= MASS_REMOVAL_SHARE,
    };
}

/** @returns {Promise<{status: 'ready', backend: object}|{status: string, folderName?: string}>} */
export async function resolveBackend(target, { interactive = false } = {}) {
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

/** Opens a configured target non-interactively for background sync. */
export async function openSyncStore(target, { interactive = false } = {}) {
    const resolved = await resolveBackend(target, { interactive });
    if (resolved.status !== 'ready') return { status: resolved.status, folderName: resolved.folderName };
    const store = await createProviderStore(providerOf(target));
    if (!store) return { status: `needs-${target === FOLDER ? 'folder' : target}` };
    return { status: 'ready', legacy: resolved.backend, store };
}
