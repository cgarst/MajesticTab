// icloudDrive.js
// iCloud Drive through the operating system (macOS and iOS in the native app only). The system keeps
// the folder in step with iCloud, so there is no network code here: MajesticTab reads and writes
// plain files. See build/tauri/src-tauri/src/icloud.rs for how the folder is found.
import { isIOSDevice } from './utils/iosAudioUnlock.js';

const tauri = () => (typeof window !== 'undefined' ? window.__TAURI__ : undefined);

export const isIcloudDriveSupported = () =>
    Boolean(tauri()?.core?.invoke && (isIOSDevice() || /Mac/i.test(navigator.platform)));

/** Folder MajesticTab uses inside iCloud Drive, or null when iCloud Drive is off or not signed in. */
export async function getIcloudDriveRoot() {
    if (!isIcloudDriveSupported()) return null;
    return (await tauri().core.invoke('icloud_drive_root')) || null;
}

export const ICLOUD_UNAVAILABLE_MESSAGE =
    'iCloud Drive is not available. Turn it on in Settings > Apple Account > iCloud, and make sure MajesticTab is allowed to use it.';
