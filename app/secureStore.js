// Credential storage backed by the OS keychain (Tauri on macOS, iOS and Windows; see src/secrets.rs).
// Secrets are read from the keychain on first use (loadSecret) and then cached, so macOS only asks for
// the login password when a feature needs a credential, not at launch. getSecret() reads the cache
// synchronously; writes update the cache at once and reach the keychain in order. Where there is no keychain (web, Android, Linux)
// isSecureStorageAvailable() is false and callers keep their credentials in localStorage as before.

const cache = new Map();
const loads = new Map();
let available = false;
let pending = Promise.resolve();

const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);

/** Detects whether a keychain exists. Call once at startup; it does not read any secret. */
export async function initSecureStore() {
    if (!window.__TAURI__?.core?.invoke) return;
    try {
        available = await invoke('secret_supported');
    } catch (error) {
        console.warn('[SecureStore] Keychain unavailable, using localStorage:', error);
        available = false;
    }
}

/** Reads `name` from the keychain once (this is what can trigger the OS password prompt) and resolves to its value or null. */
export function loadSecret(name) {
    if (!available) return Promise.resolve(null);
    if (!loads.has(name)) {
        loads.set(name, invoke('secret_get', { name })
            .then((value) => {
                if (value != null && !cache.has(name)) cache.set(name, value);
                return cache.get(name) ?? null;
            })
            .catch((error) => {
                console.warn('[SecureStore] secret_get failed:', error);
                loads.delete(name);
                return null;
            }));
    }
    return loads.get(name);
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
    loads.set(name, Promise.resolve(value));
    return persist('secret_set', { name, value });
}

export function deleteSecret(name) {
    cache.delete(name);
    loads.set(name, Promise.resolve(null));
    return persist('secret_delete', { name });
}
