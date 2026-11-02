// debugRestore.js
// Dev builds only: `run.sh --restore-backup` asks the native side (debug_restore.rs, `debug-tools` builds) to hand
// over a .mtbackup file, and it is restored with the normal restore code before the library opens. In any other
// build the native commands do not exist, so this does nothing.

import { showToast } from './utils/toast.js';

/** @returns {Promise<boolean>} whether a restore was carried out */
export async function restoreDebugBackup() {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return false;
    let request;
    try {
        request = await invoke('debug_restore_request');
    } catch {
        return false; // not a debug-tools build
    }
    if (!request) return false;

    const label = `${request.name} (${request.mode === 'wipe' ? 'replace all' : 'add missing'})`;
    console.log(`[Debug Restore] Restoring ${label}, ${request.size} bytes`);
    showToast(`Restoring ${label}...`, 'info', 5000);
    try {
        const bytes = await invoke('debug_restore_data');
        const file = new File([bytes], request.name, { type: 'application/octet-stream' });
        const { restoreBackup } = await import('./backupRestore.js');
        const result = await restoreBackup(file, { mode: request.mode });
        console.log('[Debug Restore] Done:', result);
        showToast(`Restored ${request.name}: ${result.filesImported} tabs, ${result.songsImported} songs`, 'success', 5000);
        return true;
    } catch (e) {
        console.error('[Debug Restore] Failed:', e);
        showToast(`Could not restore ${request.name}: ${e?.message || e}`, 'error', 8000);
        return false;
    }
}
