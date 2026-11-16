// storage/storeInfo.js
// store.json: the file that makes a location a MajesticTab Library store. It is written last, so a location without it
// is not (yet) a store, and it carries the format number so an app that does not understand a newer layout leaves it alone.
import { readIfExists, readJson, writeJson, ConflictError } from './contract.js';

export const STORE_FILE = 'store.json';
/** The layout this app reads and writes: packs/, library.json, profile.json, soundfonts/, classtab/. */
export const STORE_FORMAT = 1;
export const STORE_ROOT_NAME = 'MajesticTab Library';

export class StoreTooNewError extends Error {
    constructor(info) {
        super(`This storage location was made by a newer MajesticTab (layout ${info.format}${info.minApp ? `, needs app ${info.minApp} or later` : ''}). Update the app to use it.`);
        this.info = info;
    }
}

/** The store's info, or null when the location is not a store. Throws StoreTooNewError for a layout this app cannot use. */
export async function readStoreInfo(store) {
    if (!(await readIfExists(store, STORE_FILE))) return null;
    const info = await readJson(store, STORE_FILE);
    if (!info || typeof info.format !== 'number' || info.format > STORE_FORMAT) throw new StoreTooNewError(info || {});
    return info;
}

/**
 * Marks the location as a store. Resolves true when this call made it one; false when another device did first (nothing changes).
 */
export async function writeStoreInfo(store, { appVersion = '', now = Date.now(), minApp = null } = {}) {
    try {
        await writeJson(store, STORE_FILE, { format: STORE_FORMAT, createdAt: new Date(now).toISOString(), createdBy: { app: 'MajesticTab', version: appVersion }, minApp }, { ifVersion: null });
        return true;
    } catch (err) {
        if (err instanceof ConflictError) return false;
        throw err;
    }
}
