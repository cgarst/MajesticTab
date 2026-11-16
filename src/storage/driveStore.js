// storage/driveStore.js
// The storage contract (contract.js) on Google Drive, under one folder ("MajesticTab Library") in My Drive.
// Drive addresses files by id and lets two files share a name, so this adapter keeps the path model honest:
//  - a path is resolved by listing one folder level at a time (folder ids are remembered for the session);
//  - versions are Drive's per-file `version` counter, which changes on every content change;
//  - Drive has no conditional writes, so ifVersion is checked just before the write (`conditionalWrite: false`);
//  - two devices that create the same folder or file at once leave duplicates. The oldest wins, ours is removed, and a
//    create-only write that lost the race reports a ConflictError;
//  - with the drive.file scope the app sees only what it created, which is exactly this folder.
// `fetch` is the authenticated Drive call (googleDrive.driveFetch); `apiError` turns a failed Response into an Error.
import {
    CAPABILITIES, NotFoundError, ConflictError, StorageError, checkStorePath, checkStorePrefix,
} from './contract.js';
import { STORE_ROOT_NAME } from './storeInfo.js';

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,size,version,modifiedTime,createdTime';
const fold = (name) => name.normalize('NFC').toLowerCase();
const quote = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const oldestFirst = (a, b) => (a.createdTime < b.createdTime ? -1 : a.createdTime > b.createdTime ? 1 : a.id < b.id ? -1 : 1);

async function defaultApiError(res) {
    let text = '';
    try { text = await res.text(); } catch (_) {}
    const err = new StorageError(`Google Drive returned an error (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
    err.status = res.status;
    return err;
}

async function pool(items, limit, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) await fn(items[next++]);
    }));
}

/**
 * @param {{ fetch: (url: string, options?: object) => Promise<Response>, apiError?: (res: Response) => Promise<Error>, rootName?: string }} options
 */
export function createDriveStore({ fetch: call, apiError = defaultApiError, rootName = STORE_ROOT_NAME } = {}) {
    if (typeof call !== 'function') throw new TypeError('createDriveStore needs an authenticated fetch');
    const caps = {
        [CAPABILITIES.rangeRead]: true, [CAPABILITIES.conditionalWrite]: false,
        [CAPABILITIES.cheapList]: false, [CAPABILITIES.realFolders]: true,
    };
    const folderIds = new Map();   // '' (the store root) and 'packs/abc' -> Drive folder id
    let opened = false;

    async function json(res, action) {
        if (!res.ok) { const err = await apiError(res); err.action = action; throw err; }
        return res.json();
    }

    async function query(q, { pageSize = 1000 } = {}) {
        const out = [];
        let token = '';
        do {
            const url = `${API}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`nextPageToken,files(${FIELDS})`)}&pageSize=${pageSize}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}&spaces=drive`;
            const body = await json(await call(url), 'Listing Google Drive');
            out.push(...(body.files || []));
            token = pageSize < 1000 ? '' : body.nextPageToken || '';
        } while (token);
        return out;
    }

    const childrenOf = (parentId) => query(`${quote(parentId)} in parents and trashed = false`);
    // Drive compares `name =` loosely, so keep only exact matches and report the near misses separately
    async function named(parentId, name) {
        const found = await query(`${quote(parentId)} in parents and name = ${quote(name)} and trashed = false`);
        return {
            exact: found.filter((f) => f.name === name),
            twin: found.find((f) => f.name !== name && fold(f.name) === fold(name)) || null,
        };
    }

    async function createFolder(parentId, name) {
        const res = await call(`${API}?fields=${encodeURIComponent(FIELDS)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }),
        });
        return json(res, `Creating the folder ${name}`);
    }

    // The id of the folder for `dir` ('' is the store root, 'packs/abc' a subfolder), or null when absent and !create
    async function dirId(dir, create) {
        if (folderIds.has(dir)) return folderIds.get(dir);
        let parentId;
        let name;
        if (dir === '') { parentId = 'root'; name = rootName; } else {
            const cut = dir.lastIndexOf('/');
            parentId = await dirId(cut < 0 ? '' : dir.slice(0, cut), create);
            if (!parentId) return null;
            name = dir.slice(cut + 1);
        }
        if (dir === '' && !rootName) { folderIds.set('', 'root'); return 'root'; }
        const { exact, twin } = await named(parentId, name);
        let folders = exact.filter((f) => f.mimeType === FOLDER).sort(oldestFirst);
        if (!folders.length) {
            if (twin && twin.mimeType === FOLDER) throw new ConflictError(`"${name}" collides with "${twin.name}": Drive ignores case here`);
            if (!create) return null;
            const made = await createFolder(parentId, name);
            // another device may have created it at the same moment: the oldest folder wins and an empty duplicate goes
            folders = (await named(parentId, name)).exact.filter((f) => f.mimeType === FOLDER).sort(oldestFirst);
            if (folders[0].id !== made.id) await call(`${API}/${made.id}`, { method: 'DELETE' }).catch(() => {});
        }
        folderIds.set(dir, folders[0].id);
        return folders[0].id;
    }

    const parentDir = (path) => path.split('/').slice(0, -1).join('/');
    const entryOf = (path, f) => ({ path, size: Number(f.size) || 0, version: String(f.version), modifiedTime: f.modifiedTime || '' });

    // The file at `path` as Drive reports it, with the folder it is in. `twin` is a differently-cased name in that folder.
    async function locate(path, { create = false } = {}) {
        const parentId = await dirId(parentDir(path), create);
        if (!parentId) return { parentId: null, file: null, twin: null };
        const name = path.slice(path.lastIndexOf('/') + 1);
        const { exact, twin } = await named(parentId, name);
        const files = exact.filter((f) => f.mimeType !== FOLDER).sort(oldestFirst);
        return { parentId, file: files[0] || null, twin: files.length ? null : twin, extras: files.slice(1) };
    }

    const multipart = (metadata, bytes) => {
        const boundary = `mt${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
        return { type: `multipart/related; boundary=${boundary}`, body: new Blob([head, bytes, `\r\n--${boundary}--`]) };
    };

    async function upload(parentId, name, bytes, existing) {
        if (existing) {
            const res = await call(`${UPLOAD}/${existing.id}?uploadType=media&fields=${encodeURIComponent(FIELDS)}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
            });
            return json(res, `Uploading ${name}`);
        }
        const { type, body } = multipart({ name, parents: [parentId] }, bytes);
        const res = await call(`${UPLOAD}?uploadType=multipart&fields=${encodeURIComponent(FIELDS)}`, { method: 'POST', headers: { 'Content-Type': type }, body });
        return json(res, `Uploading ${name}`);
    }

    async function pruneEmpty(dir) {
        while (dir) {
            const id = folderIds.get(dir);
            if (!id) return;
            try {
                if ((await query(`${quote(id)} in parents and trashed = false`, { pageSize: 1 })).length) return;
                await call(`${API}/${id}`, { method: 'DELETE' });
            } catch (_) { return; }
            folderIds.delete(dir);
            for (const k of [...folderIds.keys()]) if (k.startsWith(`${dir}/`)) folderIds.delete(k);
            dir = parentDir(dir);
        }
    }

    const staleOrMissing = (err) => err?.status === 404;

    return {
        label: 'your Google Drive',
        location: `Google Drive / ${rootName || 'My Drive'}`,
        get capabilities() { return caps; },

        async open({ create } = {}) {
            if (opened) return true;
            opened = Boolean(await dirId('', Boolean(create)));
            return opened;
        },

        async list(prefix = '') {
            checkStorePrefix(prefix);
            const out = [];
            const walk = async (dir, id) => {
                const subdirs = [];
                for (const f of await childrenOf(id)) {
                    const p = dir ? `${dir}/${f.name}` : f.name;
                    if (f.mimeType === FOLDER) subdirs.push([p, f.id]);
                    else if (!f.mimeType.startsWith('application/vnd.google-apps.')) out.push(entryOf(p, f));
                }
                await pool(subdirs, 4, ([p, i]) => walk(p, i));
            };
            const start = prefix.replace(/\/$/, '');
            const id = await dirId(start, false);
            if (id) await walk(start, id);
            return out;
        },

        async stat(path) {
            checkStorePath(path);
            const { file } = await locate(path);
            return file ? entryOf(path, file) : null;
        },

        async read(path, { range } = {}) {
            checkStorePath(path);
            if (range && !(range.end > range.start)) {
                if (!(await this.stat(path))) throw new NotFoundError(`No such file: ${path}`);
                return new Uint8Array(0);
            }
            const { file } = await locate(path);
            if (!file) throw new NotFoundError(`No such file: ${path}`);
            const res = await call(`${API}/${file.id}?alt=media`, range ? { headers: { Range: `bytes=${range.start}-${range.end - 1}` } } : {});
            if (res.status === 404) throw new NotFoundError(`No such file: ${path}`);
            if (res.status === 416) return new Uint8Array(0);
            if (!res.ok) throw await apiError(res);
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (range && res.status === 200) return bytes.slice(range.start, range.end);
            return bytes;
        },

        async write(path, bytes, { ifVersion } = {}) {
            checkStorePath(path);
            for (let attempt = 0; ; attempt++) {
                const { parentId, file, twin, extras } = await locate(path, { create: true });
                if (twin) throw new ConflictError(`"${twin.name}" already exists and differs from "${path.split('/').pop()}" only in case`);
                if (ifVersion !== undefined && (ifVersion === null ? file : (!file || String(file.version) !== ifVersion))) {
                    throw new ConflictError(`${path} changed since it was read`, file ? String(file.version) : null);
                }
                const name = path.slice(path.lastIndexOf('/') + 1);
                let saved;
                try { saved = await upload(parentId, name, bytes, file); } catch (err) {
                    // the folder (or file) was removed by another device after we resolved it: resolve again once
                    if (staleOrMissing(err) && attempt === 0) { folderIds.clear(); continue; }
                    throw err;
                }
                for (const extra of extras || []) await call(`${API}/${extra.id}`, { method: 'DELETE' }).catch(() => {});
                if (!file) {
                    // two devices creating the same file at once leave two files: keep the oldest
                    const rivals = (await named(parentId, name)).exact.filter((f) => f.mimeType !== FOLDER).sort(oldestFirst);
                    if (rivals.length > 1 && rivals[0].id !== saved.id) {
                        if (ifVersion === null) {
                            await call(`${API}/${saved.id}`, { method: 'DELETE' }).catch(() => {});
                            throw new ConflictError(`${path} was created by another device`, String(rivals[0].version));
                        }
                        const winner = await upload(parentId, name, bytes, rivals[0]);
                        await call(`${API}/${saved.id}`, { method: 'DELETE' }).catch(() => {});
                        return { version: String(winner.version) };
                    }
                }
                return { version: String(saved.version) };
            }
        },

        async delete(path, { ifVersion } = {}) {
            checkStorePath(path);
            const { file, extras } = await locate(path);
            if (ifVersion !== undefined && (ifVersion === null ? file : (!file || String(file.version) !== ifVersion))) {
                throw new ConflictError(`${path} changed since it was read`, file ? String(file.version) : null);
            }
            if (!file) return false;
            for (const f of [file, ...(extras || [])]) {
                const res = await call(`${API}/${f.id}`, { method: 'DELETE' });
                if (!res.ok && res.status !== 404) throw await apiError(res);
            }
            await pruneEmpty(parentDir(path));
            return true;
        },
    };
}
