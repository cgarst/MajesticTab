// storage/folderStore.js
// The storage contract (contract.js) on a local folder, reached two ways like folderBackup.js:
//   - browsers: File System Access API directory handles (Chrome, Edge)
//   - desktop app and iCloud Drive: Tauri's fs plugin on a path
// Both keep the files as real files, so the user can see and copy them. Version of a file is "<mtimeMs>:<size>[:<inode>]". Every write replaces the file by rename, so where
// the platform reports an inode it tells apart two same-size writes within one clock tick; a browser handle has none, so
// there a same-size rewrite in the same millisecond is not told apart (callers that need that read the capability).
//
// Folder file systems are usually case-insensitive (macOS, Windows). Writing "case/file" next to "Case/File" would
// silently replace it, so a write whose name differs from an existing sibling only in case or unicode form throws
// ConflictError instead. A directory is checked once per store, then remembered.
import { CAPABILITIES, NotFoundError, ConflictError, checkStorePath, checkStorePrefix } from './contract.js';

const STAT_CONCURRENCY = 16;
const PART_SUFFIX = '.part';
const fold = (name) => name.normalize('NFC').toLowerCase();
const versionOf = (mtimeMs, size, ino) => `${Math.round(mtimeMs)}:${size}${ino ? `:${ino}` : ''}`;
const isoOf = (mtimeMs) => new Date(mtimeMs || 0).toISOString();
const splitPath = (path) => { const i = path.lastIndexOf('/'); return i < 0 ? ['', path] : [path.slice(0, i), path.slice(i + 1)]; };

async function pool(items, limit, worker) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) { const i = next++; out[i] = await worker(items[i], i); }
    }));
    return out;
}

/** Shared by both flavours: the check-then-write ifVersion rule, and the result shape. */
async function checkVersion(store, path, ifVersion, what) {
    if (ifVersion === undefined) return;
    const current = await store.stat(path);
    const currentVersion = current ? current.version : null;
    if (currentVersion !== ifVersion) throw new ConflictError(`Version mismatch ${what} ${path}`, currentVersion);
}

// --- browser: File System Access API ---

/**
 * @param rootHandle a FileSystemDirectoryHandle the user granted
 * @param {{ rootName?: string, label?: string }} options  rootName is the folder created inside it ('' uses the handle itself)
 */
export function createBrowserFolderStore(rootHandle, { rootName = 'MajesticTab Library', label = 'the folder' } = {}) {
    let root = null;
    const verified = new Set();

    const notFound = (err) => err?.name === 'NotFoundError' || err?.name === 'TypeMismatchError';

    /** The directory handle for `dir` ('' is the root); null when absent and !create. */
    async function dirHandle(dir, create) {
        let handle = root;
        let walked = '';
        for (const segment of dir ? dir.split('/') : []) {
            if (create && !verified.has(`${walked}/${segment}`)) await assertNoCaseTwin(handle, segment, `${walked}/${segment}`);
            try { handle = await handle.getDirectoryHandle(segment, { create }); } catch (err) {
                if (notFound(err)) return null;
                throw err;
            }
            walked = walked ? `${walked}/${segment}` : segment;
            if (create) verified.add(walked);
        }
        return handle;
    }

    async function assertNoCaseTwin(parent, name, shown) {
        const wanted = fold(name);
        for await (const [existing] of parent.entries()) {
            if (existing !== name && fold(existing) === wanted) {
                throw new ConflictError(`"${name}" collides with "${existing}" in ${shown}: this folder ignores case`);
            }
        }
    }

    async function fileHandle(path, create) {
        const [dir, name] = splitPath(path);
        const parent = await dirHandle(dir, create);
        if (!parent) return null;
        if (create) await assertNoCaseTwinOnce(parent, dir, name);
        try { return await parent.getFileHandle(name, { create }); } catch (err) {
            if (notFound(err)) return null;
            throw err;
        }
    }
    // Files in a directory are checked on every write (a twin may appear any time), but only when the exact name is absent
    async function assertNoCaseTwinOnce(parent, dir, name) {
        try { await parent.getFileHandle(name); return; } catch (err) { if (!notFound(err)) throw err; }
        await assertNoCaseTwin(parent, name, dir || '/');
    }

    async function walk(handle, base, out) {
        const files = [];
        for await (const [name, child] of handle.entries()) {
            if (child.kind === 'directory') files.push(...await walk(child, `${base}${name}/`, []));
            else if (!name.endsWith(PART_SUFFIX)) files.push({ base, name, child });
        }
        return out.concat(files);
    }

    const store = {
        label, location: rootName ? `${rootHandle.name} / ${rootName}` : rootHandle.name,
        capabilities: { [CAPABILITIES.rangeRead]: true, [CAPABILITIES.conditionalWrite]: false, [CAPABILITIES.cheapList]: true, [CAPABILITIES.realFolders]: true },

        async open({ create } = {}) {
            try {
                root = rootName ? await rootHandle.getDirectoryHandle(rootName, { create: Boolean(create) }) : rootHandle;
                return true;
            } catch (err) {
                if (notFound(err)) return false;
                throw err;
            }
        },

        async list(prefix = '') {
            checkStorePrefix(prefix);
            const start = await dirHandle(prefix.replace(/\/$/, ''), false);
            if (!start) return [];
            const found = await walk(start, prefix, []);
            return pool(found, STAT_CONCURRENCY, async ({ base, name, child }) => {
                const file = await child.getFile();
                return { path: `${base}${name}`, size: file.size, version: versionOf(file.lastModified, file.size), modifiedTime: isoOf(file.lastModified) };
            });
        },

        async stat(path) {
            checkStorePath(path);
            const handle = await fileHandle(path, false);
            if (!handle) return null;
            const file = await handle.getFile();
            return { path, size: file.size, version: versionOf(file.lastModified, file.size), modifiedTime: isoOf(file.lastModified) };
        },

        async read(path, { range } = {}) {
            checkStorePath(path);
            const handle = await fileHandle(path, false);
            if (!handle) throw new NotFoundError(`No such file: ${path}`);
            const file = await handle.getFile();
            const blob = range ? file.slice(Math.max(0, range.start ?? 0), Math.min(file.size, range.end ?? file.size)) : file;
            return new Uint8Array(await blob.arrayBuffer());
        },

        async write(path, bytes, { ifVersion } = {}) {
            checkStorePath(path);
            await checkVersion(store, path, ifVersion, 'writing');
            const handle = await fileHandle(path, true);
            // The content lands in a swap file and replaces the target on close, so no half-written file is ever visible
            const writable = await handle.createWritable();
            try { await writable.write(bytes); await writable.close(); } catch (err) { try { await writable.abort?.(); } catch (_) {} throw err; }
            const file = await handle.getFile();
            return { version: versionOf(file.lastModified, file.size) };
        },

        async delete(path, { ifVersion } = {}) {
            checkStorePath(path);
            await checkVersion(store, path, ifVersion, 'deleting');
            const [dir, name] = splitPath(path);
            const parent = await dirHandle(dir, false);
            if (!parent) return false;
            try { await parent.removeEntry(name); } catch (err) {
                if (notFound(err)) return false;
                throw err;
            }
            await pruneEmpty(dir);
            return true;
        },
    };

    // Empty folders are not part of the contract; clear them so the user's folder does not fill with shells
    async function pruneEmpty(dir) {
        while (dir) {
            const [parentDir, name] = splitPath(dir);
            const parent = await dirHandle(parentDir, false);
            const handle = parent && await dirHandle(dir, false);
            if (!handle) return;
            for await (const _ of handle.entries()) return;
            try { await parent.removeEntry(name); } catch (_) { return; }
            verified.delete(dir);
            dir = parentDir;
        }
    }
    return store;
}

// --- desktop app: Tauri fs plugin ---

/**
 * @param rootPath absolute path of the folder the user chose
 * @param {{ fs?: object, rootName?: string, label?: string, rootLabel?: string }} options  `fs` defaults to the Tauri plugin
 */
export function createNativeFolderStore(rootPath, { fs, rootName = 'MajesticTab Library', label = 'the folder', rootLabel } = {}) {
    const api = () => fs || window.__TAURI__.fs;
    const sep = rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/';
    const base = rootPath.replace(/[\\/]+$/, '');
    const rootDir = rootName ? `${base}${sep}${rootName}` : base;
    const abs = (path) => (path ? `${rootDir}${sep}${path.split('/').join(sep)}` : rootDir);
    const verified = new Set();
    const isMissing = (err) => /not found|no such file|ENOENT|os error 2\b|does not exist/i.test(String(err?.message || err));

    async function names(dirPath) {
        try { return await api().readDir(dirPath); } catch (err) {
            if (isMissing(err)) return null;
            throw err;
        }
    }

    async function assertNoCaseTwin(dir, name) {
        const entries = await names(abs(dir));
        if (!entries) return;
        const wanted = fold(name);
        for (const e of entries) {
            if (e.name !== name && fold(e.name) === wanted) throw new ConflictError(`"${name}" collides with "${e.name}": this folder ignores case`);
        }
    }

    // Every folder level along `path` and its file name are checked against case twins once per store
    async function checkTwins(path) {
        const parts = path.split('/');
        let dir = '';
        for (let i = 0; i < parts.length; i++) {
            const last = i === parts.length - 1;
            const here = dir ? `${dir}/${parts[i]}` : parts[i];
            // A directory is checked once; the file name on every write. The listing decides, because an exact-name hit
            // proves nothing on a case-insensitive disk
            if (last || !verified.has(here)) {
                await assertNoCaseTwin(dir, parts[i]);
                if (!last) verified.add(here);
            }
            dir = here;
        }
    }

    async function statPath(path) {
        let info;
        try { info = await api().stat(abs(path)); } catch (err) {
            if (isMissing(err)) return null;
            throw err;
        }
        if (!info || info.isDirectory) return null;
        const mtime = info.mtime instanceof Date ? info.mtime.getTime() : Number(info.mtime || 0);
        return { path, size: info.size || 0, version: versionOf(mtime, info.size || 0, info.ino), modifiedTime: isoOf(mtime) };
    }

    async function walk(dir, out) {
        const entries = await names(abs(dir));
        if (!entries) return out;
        for (const e of entries) {
            const rel = dir ? `${dir}/${e.name}` : e.name;
            if (e.isDirectory) await walk(rel, out);
            else if (e.isFile !== false && !e.name.endsWith(PART_SUFFIX)) out.push(rel);
        }
        return out;
    }

    const store = {
        label, location: rootLabel || (rootName ? `${base.split(/[\\/]/).pop()} / ${rootName}` : base),
        capabilities: { [CAPABILITIES.rangeRead]: false, [CAPABILITIES.conditionalWrite]: false, [CAPABILITIES.cheapList]: true, [CAPABILITIES.realFolders]: true },

        async open({ create } = {}) {
            if (create) { await api().mkdir(rootDir, { recursive: true }); return true; }
            return Boolean(await api().exists(rootDir));
        },

        async list(prefix = '') {
            checkStorePrefix(prefix);
            const paths = await walk(prefix.replace(/\/$/, ''), []);
            return (await pool(paths, STAT_CONCURRENCY, statPath)).filter(Boolean);
        },

        stat(path) { checkStorePath(path); return statPath(path); },

        async read(path, { range } = {}) {
            checkStorePath(path);
            let bytes;
            try { bytes = await api().readFile(abs(path)); } catch (err) {
                if (isMissing(err)) throw new NotFoundError(`No such file: ${path}`);
                throw err;
            }
            const whole = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            return range ? whole.slice(Math.max(0, range.start ?? 0), Math.min(whole.length, range.end ?? whole.length)) : whole.slice();
        },

        async write(path, bytes, { ifVersion } = {}) {
            checkStorePath(path);
            await checkVersion(store, path, ifVersion, 'writing');
            await checkTwins(path);
            const [dir] = splitPath(path);
            if (dir) await api().mkdir(abs(dir), { recursive: true });
            // Written under a temporary name and renamed, so an interrupted write never leaves a partial file
            const partial = `${abs(path)}${PART_SUFFIX}`;
            try {
                await api().writeFile(partial, bytes);
                await api().rename(partial, abs(path));
            } catch (err) {
                try { await api().remove(partial); } catch (_) {}
                throw err;
            }
            return { version: (await statPath(path)).version };
        },

        async delete(path, { ifVersion } = {}) {
            checkStorePath(path);
            await checkVersion(store, path, ifVersion, 'deleting');
            if (!(await statPath(path))) return false;
            await api().remove(abs(path));
            let [dir] = splitPath(path);
            while (dir) {
                const left = await names(abs(dir));
                if (!left || left.length) break;
                try { await api().remove(abs(dir)); } catch (_) { break; }
                verified.delete(dir);
                [dir] = splitPath(dir);
            }
            return true;
        },
    };
    return store;
}
