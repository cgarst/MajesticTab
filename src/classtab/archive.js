// classtab/archive.js
// The Classtab archive on this device. The ZIP is stored once, as bytes, in its own IndexedDB next to the parsed
// catalog; tabs and MIDI files are read out of it on demand, so thousands of files are never unpacked into storage.
// Installing a new ZIP replaces both records in one transaction, so a bad download or file leaves the old library alone.
// Songs added to the library are copies and never refer back to the archive.

import { parseClasstabIndex, catalogCounts } from './parse.js';

const DB_NAME = 'majestictab_classtab';
const STORE = 'archive';
const INDEX_FILE = 'index_old.htm';
const MIN_PIECES = 3000;

export class ClasstabError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'ClasstabError';
        this.code = code;
    }
}

const fflate = () => {
    const f = globalThis.fflate;
    if (!f?.unzipSync) throw new ClasstabError('The ZIP reader is not available.', 'no-zip-reader');
    return f;
};

let dbPromise = null;
function db() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => { dbPromise = null; reject(req.error); };
        });
    }
    return dbPromise;
}

async function readRecord(key) {
    const d = await db();
    return new Promise((resolve, reject) => {
        const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
    });
}

let catalogCache; // undefined = not read yet, null = no archive
let zipCache = null;
const listeners = new Set();

/** Called with no arguments after the archive is installed or removed. Returns an unsubscribe function. */
export function onArchiveChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** The parsed catalog record: { composers, counts, updatedAt, bytes, prefix, sizes } or null. */
export async function getCatalogRecord() {
    if (catalogCache === undefined) {
        try { catalogCache = await readRecord('catalog'); } catch { catalogCache = null; }
    }
    return catalogCache;
}

export async function hasArchive() {
    return Boolean(await getCatalogRecord());
}

/** Unzip just the catalog page. Throws a ClasstabError when the bytes are not the Classtab archive. */
export function readCatalogFromZip(bytes) {
    let files;
    const sizes = {};
    try {
        files = fflate().unzipSync(bytes, {
            filter: (f) => {
                const base = f.name.slice(f.name.lastIndexOf('/') + 1);
                if (/\.(txt|mid)$/i.test(base)) sizes[f.name] = f.originalSize;
                return base === INDEX_FILE;
            }
        });
    } catch (e) {
        if (e instanceof ClasstabError) throw e;
        throw new ClasstabError("That file isn't the Classtab archive. It needs to contain index_old.htm.", 'bad-zip');
    }
    const indexName = Object.keys(files).find((n) => n.endsWith(INDEX_FILE));
    if (!indexName) throw new ClasstabError("That file isn't the Classtab archive. It needs to contain index_old.htm.", 'no-index');
    const html = new TextDecoder('windows-1252').decode(files[indexName]);
    const composers = parseClasstabIndex(html);
    const counts = catalogCounts(composers);
    if (counts.pieces < MIN_PIECES) {
        throw new ClasstabError("That file isn't the Classtab archive. It needs to contain index_old.htm.", 'too-small');
    }
    const prefix = indexName.slice(0, indexName.length - INDEX_FILE.length);
    return { composers, counts, prefix, sizes };
}

/** How the new catalog differs from the old: pieces that were not there, and pieces whose tab changed. */
export function diffCatalogs(oldRec, newRec) {
    if (!oldRec) return { added: 0, changed: 0 };
    const known = new Set();
    for (const c of oldRec.composers) for (const p of c.pieces) known.add(p.tab_url);
    let added = 0;
    let changed = 0;
    for (const c of newRec.composers) {
        for (const p of c.pieces) {
            if (!known.has(p.tab_url)) { added++; continue; }
            const was = oldRec.sizes?.[oldRec.prefix + p.tab_url];
            const now = newRec.sizes?.[newRec.prefix + p.tab_url];
            if (was != null && now != null && was !== now) changed++;
        }
    }
    return { added, changed };
}

/**
 * Validate a ZIP and make it the Classical tab library, replacing any earlier one atomically.
 * @param {Uint8Array} bytes
 * @returns {Promise<{counts: {composers:number, pieces:number}, added:number, changed:number, first:boolean}>}
 */
export async function installArchive(bytes) {
    const parsed = readCatalogFromZip(bytes);
    const old = await getCatalogRecord();
    const record = { ...parsed, updatedAt: Date.now(), bytes: bytes.byteLength };
    const d = await db();
    try {
        await new Promise((resolve, reject) => {
            const tx = d.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            store.put(bytes, 'zip');
            store.put(record, 'catalog');
            tx.oncomplete = resolve;
            tx.onabort = tx.onerror = () => reject(tx.error || new Error('write failed'));
        });
    } catch (e) {
        const full = e?.name === 'QuotaExceededError';
        const mb = Math.round(bytes.byteLength / 1048576);
        throw new ClasstabError(full ? `Not enough space to store the archive (${mb} MB).` : "Couldn't store the archive on this device.", full ? 'quota' : 'store');
    }
    zipCache = bytes;
    catalogCache = record;
    const diff = diffCatalogs(old, record);
    listeners.forEach((fn) => { try { fn(); } catch { /* a listener failing must not stop the others */ } });
    return { counts: record.counts, ...diff, first: !old };
}

export async function removeArchive() {
    const d = await db();
    await new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
    zipCache = null;
    catalogCache = null;
    listeners.forEach((fn) => { try { fn(); } catch { /* see above */ } });
}

async function getZip() {
    if (!zipCache) zipCache = await readRecord('zip');
    return zipCache;
}

/** The bytes of one file in the archive (a tab or a MIDI), or null when the archive does not have it. */
export async function readArchiveEntry(fileName) {
    const rec = await getCatalogRecord();
    const zip = rec && (await getZip());
    if (!zip) return null;
    const want = rec.prefix + fileName;
    const out = fflate().unzipSync(zip, { filter: (f) => f.name === want });
    return out[want] || null;
}

/** Whether the installed archive still lists a piece (used after an update for "No longer in the archive"). */
export async function archiveHasPiece(tabFile) {
    const rec = await getCatalogRecord();
    return Boolean(rec && rec.sizes?.[rec.prefix + tabFile] != null);
}
