// Credential storage backed by the OS keychain (Tauri on macOS, iOS and Windows; see src/secrets.rs).
// Values are loaded into memory by initSecureStore() so reads stay synchronous; writes update the
// cache at once and reach the keychain in order. Where there is no keychain (web, Android, Linux)
// isSecureStorageAvailable() is false and callers keep their credentials in localStorage as before.

const cache = new Map();
let available = false;
let pending = Promise.resolve();

const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);

/** Loads the named secrets. Call once at startup, before anything reads them. */
export async function initSecureStore(names) {
    if (!window.__TAURI__?.core?.invoke) return;
    try {
        available = await invoke('secret_supported');
        if (!available) return;
        for (const name of names) {
            const value = await invoke('secret_get', { name });
            if (value != null) cache.set(name, value);
        }
    } catch (error) {
        console.warn('[SecureStore] Keychain unavailable, using localStorage:', error);
        available = false;
    }
}

export const isSecureStorageAvailable = () => available;

export const getSecret = (name) => cache.get(name) ?? null;

function persist(command, args) {
    pending = pending.then(() => invoke(command, args)).catch((error) => {
        console.warn(`[SecureStore] ${command} failed:`, error);
    });
    return pending;
}

export function setSecret(name, value) {
    cache.set(name, value);
    return persist('secret_set', { name, value });
}

export function deleteSecret(name) {
    cache.delete(name);
    return persist('secret_delete', { name });
}
