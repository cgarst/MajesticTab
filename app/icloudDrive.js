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

const joinPath = (dir, name) => `${dir.replace(/\/+$/, '')}/${name}`;

/** Writes a file into MajesticTab's iCloud Drive folder. Returns the saved path. */
export async function saveToIcloudDrive(blob, filename) {
    const root = await getIcloudDriveRoot();
    if (!root) throw new Error(ICLOUD_UNAVAILABLE_MESSAGE);
    const path = joinPath(root, filename);
    await tauri().fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return path;
}

/** Folders and files directly inside `dir` (defaults to MajesticTab's iCloud Drive folder). */
export async function listIcloudDirectory(dir) {
    const root = await getIcloudDriveRoot();
    if (!root) throw new Error(ICLOUD_UNAVAILABLE_MESSAGE);
    const base = dir || root;
    const entries = await tauri().fs.readDir(base);
    return {
        root,
        dir: base,
        entries: entries
            .filter(e => !e.name.startsWith('.'))
            .map(e => ({ name: e.name, path: joinPath(base, e.name), isDirectory: Boolean(e.isDirectory) }))
            .sort((a, b) => b.isDirectory - a.isDirectory || a.name.localeCompare(b.name))
    };
}

export async function readIcloudFile(path) {
    const name = path.split('/').pop();
    return new File([await tauri().fs.readFile(path)], name);
}
