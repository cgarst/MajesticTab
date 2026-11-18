// syncRecordStore.js
// Where audio sync records (`audio_sync_<song>_<recording>` and the per song share flags) live. They used to sit in
// localStorage, where a library of a few hundred synced videos fills the webview's ~10 MB quota and then every other
// setting silently stops saving. They are now kept in their own IndexedDB database and read through a Storage-like
// object (getItem, setItem, removeItem, key, length) over an in-memory copy, so syncStore.js stays synchronous.
// The copy holds a large record deflated (fflate, a page global) and inflates it on each read: a library of a few thousand
// records of a few hundred points took about 500 MB as text and takes about a tenth of that this way. The database holds
// the text, as it always did, so other versions of the app read it. Without fflate (a test, a failed script) the copy is text.
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
const cache = new Map();   // key -> string, or Uint8Array when deflated
const COMPRESS_OVER = 4096; // characters: smaller values stay text, the saving is not worth the call
const lib = () => { const f = globalThis.fflate; return f?.deflateSync && f?.inflateSync && f?.strToU8 && f?.strFromU8 ? f : null; };

export const packValue = (value) => {
    const f = lib();
    if (!f || typeof value !== 'string' || value.length <= COMPRESS_OVER) return value;
    try { return f.deflateSync(f.strToU8(value), { level: 1 }); } catch { return value; }
};
export const unpackValue = (stored) => {
    if (typeof stored === 'string' || stored === undefined) return stored;
    return lib().strFromU8(lib().inflateSync(stored));
};
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
            // Each record is packed as it is read, so the text of the whole library is never held at once
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readonly');
                const cur = tx.objectStore(STORE).openCursor();
                cur.onsuccess = () => { const c = cur.result; if (c) { cache.set(c.key, packValue(c.value)); c.continue(); } };
                tx.oncomplete = () => resolve();
                tx.onerror = tx.onabort = () => reject(tx.error);
            });
            const store = ls();
            const moving = [];
            for (let i = 0; store && i < store.length; i++) {
                const k = store.key(i);
                if (isSyncRecordKey(k)) moving.push(k);
            }
            for (const k of moving) {
                const v = store.getItem(k);
                // a copy already in the database (newer edits) wins over an old localStorage one
                if (!cache.has(k)) { await run('readwrite', (s) => s.put(v, k)); cache.set(k, packValue(v)); }
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
        return cache.has(k) ? unpackValue(cache.get(k)) : null;
    },
    setItem(k, v) {
        if (!db) { ls().setItem(k, v); return; }
        const value = String(v);
        cache.set(k, packValue(value)); keyList = null;
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
