// storage/contract.js
// The one interface every storage backend (local folder, iCloud folder, S3, WebDAV, Google Drive) implements, so the
// sync engine and the pack reader can work with paths and never with a provider's ids, listings or folder handles.
//
// A store is a flat set of files addressed by '/'-separated paths ("packs/<id>/manifest.json"). Folders are not objects:
// they exist while a file is under them. Adapters that need real folders (a local folder, WebDAV, Drive) create and prune
// them behind this interface.
//
//   label: string                                  for messages ("your S3 bucket")
//   location: string                               for the UI ("bucket / MajesticTab")
//   capabilities: { rangeRead, conditionalWrite, cheapList, realFolders }   see CAPABILITIES
//   open({ create }) -> boolean                    resolves the root; false when absent and !create
//   list(prefix = '') -> [{ path, size, version, modifiedTime }]   every file under prefix, recursively, in no set order
//   stat(path) -> { path, size, version, modifiedTime } | null
//   read(path, { range: { start, end } }?) -> Uint8Array          end is exclusive; throws NotFoundError
//   write(path, bytes, { ifVersion }?) -> { version }             creates folders; replaces atomically; see below
//   delete(path, { ifVersion }?) -> boolean                       true when a file was removed; absent is not an error
//
// Versions are opaque strings (an ETag, a generation, "mtime:size"). Only equality means anything. A write with
// `ifVersion: string` succeeds only while the file still has that version; `ifVersion: null` only while the file does
// not exist. Failing either throws ConflictError and changes nothing. Omitting ifVersion overwrites without a check.
// A backend with `conditionalWrite: false` still honours ifVersion by checking before it writes, which narrows the race
// without closing it; callers that need the guarantee read the capability.
//
// Writes are atomic per file: a reader sees the old bytes or the new bytes, never a mixture. A pack in directory form
// (SPEC section 3.2) relies on that and on writing manifest.json last.

/** What an adapter can do beyond the minimum. Callers branch on these, never on the provider name. */
export const CAPABILITIES = Object.freeze({
    /** read(path, { range }) fetches only those bytes (S3, WebDAV, Drive, local files). Without it the adapter reads the whole file and slices. */
    rangeRead: 'rangeRead',
    /** write/delete with ifVersion is enforced by the server (If-Match, If-None-Match, generation match), not by a check-then-write. */
    conditionalWrite: 'conditionalWrite',
    /** list(prefix) is one cheap call (S3 listing, a directory read). False for Drive, where every folder level is a query. */
    cheapList: 'cheapList',
    /** Files are visible to the user as real files and folders and may be edited or moved outside the app. */
    realFolders: 'realFolders',
});

export class StorageError extends Error {
    constructor(message, options) { super(message, options); this.name = this.constructor.name; }
}
/** read() of a path that holds no file. */
export class NotFoundError extends StorageError {}
/** A write or delete whose ifVersion no longer matches. `current` is the version now stored, or null when absent. */
export class ConflictError extends StorageError {
    constructor(message, current = null) { super(message); this.current = current; }
}
/** A path an adapter cannot or must not store (see checkStorePath). */
export class BadPathError extends StorageError {}

const SEGMENT_BAD = /[\\\u0000-\u001f\u007f:*?"<>|]/;

/**
 * Throws BadPathError unless `path` is a safe store path: no leading or trailing slash, no empty, "." or ".." segments,
 * no backslash, control character or character that Windows, WebDAV or an S3 key listing mishandles. Every adapter calls
 * this first, so a name that works on one backend works on all of them.
 */
export function checkStorePath(path) {
    if (typeof path !== 'string' || !path) throw new BadPathError('Path is empty');
    if (path.length > 900) throw new BadPathError(`Path is too long: ${path.slice(0, 40)}…`);
    for (const segment of path.split('/')) {
        if (!segment || segment === '.' || segment === '..') throw new BadPathError(`Unsafe path: ${path}`);
        if (SEGMENT_BAD.test(segment)) throw new BadPathError(`Unsafe character in path: ${path}`);
        if (segment.length > 200) throw new BadPathError(`Path segment is too long: ${path}`);
        if (/[ .]$/.test(segment)) throw new BadPathError(`Path segment ends in a space or dot: ${path}`);
    }
    return path;
}

/** Throws unless `prefix` is '' or a safe path ending in '/'. */
export function checkStorePrefix(prefix) {
    if (prefix === '' || prefix == null) return '';
    if (!prefix.endsWith('/')) throw new BadPathError(`A prefix must end in "/": ${prefix}`);
    checkStorePath(prefix.slice(0, -1));
    return prefix;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

export const readText = async (store, path) => decoder.decode(await store.read(path));
export const readJson = async (store, path) => JSON.parse(await readText(store, path));
export const writeText = (store, path, text, options) => store.write(path, encoder.encode(text), options);
export const writeJson = (store, path, value, options) => writeText(store, path, JSON.stringify(value), options);

/** The value of a read that may find nothing: the bytes, or null when the file is absent. */
export async function readIfExists(store, path, options) {
    try { return await store.read(path, options); } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
    }
}

/**
 * Read-modify-write one small file (library.json) so that two devices cannot silently overwrite each other. `change`
 * gets the parsed current value (or null) and returns the new value. A ConflictError reloads and retries.
 * Returns the written version.
 */
export async function updateJson(store, path, change, { attempts = 5 } = {}) {
    for (let attempt = 0; ; attempt++) {
        const entry = await store.stat(path);
        const current = entry ? JSON.parse(await readText(store, path)) : null;
        const next = await change(current);
        try {
            return (await writeJson(store, path, next, { ifVersion: entry ? entry.version : null })).version;
        } catch (err) {
            if (!(err instanceof ConflictError) || attempt >= attempts - 1) throw err;
        }
    }
}

/**
 * Writes the files of one pack in directory form (SPEC section 3.2) under `dir` ("packs/<id>"): every file except
 * manifest.json first, manifest.json last, so a pack with a manifest is a complete pack. `files` maps relative path to bytes.
 * Files that are already in the store with the same size are skipped when `skipSameSize` (audio, which is Stored and large).
 */
export async function writePackDir(store, dir, files, { skipSameSize = false, onProgress, manifestIfVersion } = {}) {
    checkStorePath(dir);
    const paths = Object.keys(files).filter((p) => p !== 'manifest.json');
    let done = 0;
    for (const rel of paths) {
        const full = `${dir}/${rel}`;
        const bytes = files[rel];
        const existing = skipSameSize ? await store.stat(full) : null;
        if (!existing || existing.size !== bytes.length) await store.write(full, bytes);
        onProgress?.(++done, paths.length + 1);
    }
    if (!files['manifest.json']) throw new StorageError('A pack needs a manifest.json');
    // manifestIfVersion: null = a new pack only, a string = replace exactly that manifest (two devices editing one pack)
    await store.write(`${dir}/manifest.json`, files['manifest.json'], manifestIfVersion === undefined ? undefined : { ifVersion: manifestIfVersion });
    onProgress?.(paths.length + 1, paths.length + 1);
}

/** Removes a pack directory, manifest first, so a half-removed pack reads as absent rather than as a broken pack. */
export async function deletePackDir(store, dir) {
    checkStorePath(dir);
    await store.delete(`${dir}/manifest.json`);
    for (const entry of await store.list(`${dir}/`)) await store.delete(entry.path);
}

export { encoder as textEncoder, decoder as textDecoder };
