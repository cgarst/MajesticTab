// syncRecordStore.js
// Where audio sync records (`audio_sync_<song>_<recording>` and the per song share flags) live. They used to sit in
// localStorage, where a library of a few hundred synced videos fills the webview's ~10 MB quota and then every other
// setting silently stops saving. They are now kept in their own IndexedDB database and read through a Storage-like
// object (getItem, setItem, removeItem, key, length) over an in-memory copy, so syncStore.js stays synchronous.
// initSyncRecordStore() loads the copy at startup and moves any records still in localStorage across (each is removed
// from localStorage only after IndexedDB has it). When IndexedDB is not available the object passes through to localStorage.

const DB_NAME = 'majestictab_syncpoints';
const STORE = 'records';
const PREFIX = 'audio_sync_';
// Small player settings that share the prefix: they stay in localStorage
const SETTING_KEYS = new Set(['audio_sync_tap_offset', 'audio_sync_timeline', 'audio_sync_snap']);

export const isSyncRecordKey = (k) => typeof k === 'string' && k.startsWith(PREFIX) && !SETTING_KEYS.has(k);

let db = null;          // set once IndexedDB is open and the copy is loaded
let ready = null;
const cache = new Map();
let keyList = null;
let writes = Promise.resolve();

const ls = () => { try { return localStorage; } catch { return null; } };

function openDb() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not supported')); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function run(mode, fn) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const out = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(out?.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
    });
}

function queue(fn) {
    writes = writes.then(fn).catch((e) => console.warn('[Audio Sync] Could not write to the sync point database:', e));
    return writes;
}

/** Loads the records (and moves any left in localStorage). Safe to call more than once. */
export function initSyncRecordStore() {
    if (ready) return ready;
    ready = (async () => {
        try {
            db = await openDb();
            const entries = await new Promise((resolve, reject) => {
                const out = [];
                const tx = db.transaction(STORE, 'readonly');
                const cur = tx.objectStore(STORE).openCursor();
                cur.onsuccess = () => { const c = cur.result; if (c) { out.push([c.key, c.value]); c.continue(); } };
                tx.oncomplete = () => resolve(out);
                tx.onerror = tx.onabort = () => reject(tx.error);
            });
            for (const [k, v] of entries) cache.set(k, v);
            const store = ls();
            const moving = [];
            for (let i = 0; store && i < store.length; i++) {
                const k = store.key(i);
                if (isSyncRecordKey(k)) moving.push(k);
            }
            for (const k of moving) {
                const v = store.getItem(k);
                // a copy already in the database (newer edits) wins over an old localStorage one
                if (!cache.has(k)) { await run('readwrite', (s) => s.put(v, k)); cache.set(k, v); }
                store.removeItem(k);
            }
            keyList = null;
            if (moving.length) console.info(`[Audio Sync] Moved ${moving.length} sync point records out of localStorage`);
        } catch (e) {
            db = null;
            cache.clear();
            console.warn('[Audio Sync] Sync points stay in localStorage:', e);
        }
    })();
    return ready;
}

export const recordStorage = {
    getItem(k) {
        if (!db) return ls()?.getItem(k) ?? null;
        return cache.has(k) ? cache.get(k) : null;
    },
    setItem(k, v) {
        if (!db) { ls().setItem(k, v); return; }
        const value = String(v);
        cache.set(k, value); keyList = null;
        queue(() => run('readwrite', (s) => s.put(value, k)));
    },
    removeItem(k) {
        if (!db) { ls()?.removeItem(k); return; }
        if (!cache.delete(k)) return;
        keyList = null;
        queue(() => run('readwrite', (s) => s.delete(k)));
    },
    key(i) {
        if (!db) return ls()?.key(i) ?? null;
        keyList ||= [...cache.keys()];
        return keyList[i] ?? null;
    },
    get length() {
        return db ? cache.size : (ls()?.length ?? 0);
    }
};

/** Resolves when every write so far has reached IndexedDB. */
export const flushSyncRecords = () => writes;
