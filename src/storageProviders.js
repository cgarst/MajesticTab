// storageProviders.js
// Builds a storage-contract store (src/storage/contract.js) from the connection the user already saved for each
// provider, so the sync engine and the pack reader can work with any of them through one call. The providers' own
// settings, sign-in and permission flows stay in their modules; this file only reads what they saved.
//
//   createProviderStore('s3' | 'webdav' | 'google-drive' | 'icloud' | 'local') -> store | null
//
// null means the provider is not connected on this device (no settings, no sign-in, no folder chosen).
import { createBrowserFolderStore, createNativeFolderStore } from './storage/folderStore.js';
import { createS3Store } from './storage/s3Store.js';
import { createWebDavStore } from './storage/webdavStore.js';
import { createDriveStore } from './storage/driveStore.js';

export const STORAGE_PROVIDERS = ['local', 'icloud', 'google-drive', 's3', 'webdav'];

async function localStore() {
    const { getSavedBackupFolder } = await import('./folderBackup.js');
    const handle = await getSavedBackupFolder();
    if (!handle) return null;
    return handle.kind === 'native-path'
        ? createNativeFolderStore(handle.path, { label: 'your folder', rootLabel: `${handle.name} / MajesticTab Library` })
        : createBrowserFolderStore(handle, { label: 'your folder' });
}

async function icloudStore() {
    const { getIcloudDriveRoot, isIcloudDriveSupported } = await import('./icloudDrive.js');
    if (!isIcloudDriveSupported()) return null;
    const root = await getIcloudDriveRoot();
    if (!root) return null;
    const invoke = window.__TAURI__.core.invoke;
    return createNativeFolderStore(root, {
        label: 'iCloud Drive', rootLabel: 'iCloud Drive / MajesticTab Library',
        icloud: { download: (path) => invoke('icloud_download', { path }) },
    });
}

async function driveStore() {
    const drive = await import('./googleDrive.js');
    if (!(await drive.isGoogleDriveConnected())) return null;
    return createDriveStore({ fetch: drive.driveFetch, apiError: drive.driveApiErrorFromResponse });
}

async function s3Store() {
    const { getS3Config } = await import('./s3Client.js');
    const config = getS3Config();
    return config ? createS3Store(config) : null;
}

async function webdavStore() {
    const { getWebDavConfig } = await import('./webdavClient.js');
    const config = getWebDavConfig();
    return config ? createWebDavStore(config) : null;
}

const BUILDERS = { local: localStore, icloud: icloudStore, 'google-drive': driveStore, s3: s3Store, webdav: webdavStore };

/** The store for `provider`, or null when it is not connected. Throws for a name that is not a provider. */
export async function createProviderStore(provider) {
    const build = BUILDERS[provider];
    if (!build) throw new Error(`Unknown storage provider: ${provider}`);
    return build();
}
