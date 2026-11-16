// storage/webdavStore.js
// The storage contract (contract.js) on a WebDAV server (Nextcloud, ownCloud, Synology, Apache mod_dav, rclone serve).
// Versions are ETags (or "mtime:size" when the server sends none). Every write lists the parent folder first: that shows
// the current version for ifVersion and finds a name that differs only in case or unicode, which a case-insensitive
// server would otherwise overwrite silently. The If-Match / If-None-Match headers are sent too, but most servers
// do not enforce them reliably, so `conditionalWrite` is false unless the caller says the server does.
import {
    CAPABILITIES, NotFoundError, ConflictError, StorageError, checkStorePath, checkStorePrefix,
} from './contract.js';
import { STORE_ROOT_NAME } from './storeInfo.js';
import { request, davEnsureDir, davJoin } from '../webdavClient.js';

const fold = (name) => name.normalize('NFC').toLowerCase();
const decodeXml = (text) => text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tagIn = (xml, name) => {
    const m = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
    return m ? decodeXml(m[1].trim()) : '';
};
const safeDecode = (text) => { try { return decodeURIComponent(text); } catch (_) { return text; } };
const PROPFIND = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>';

function failure(res, action) {
    let text = `${action} failed (${res.status}).`;
    if (res.status === 401) text = `${action} failed: the server rejected the username or password.`;
    else if (res.status === 403) text = `${action} failed: access was refused (403).`;
    else if (res.status === 507) text = `${action} failed: the server is out of space.`;
    const err = new StorageError(text);
    err.status = res.status;
    return err;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool(items, limit, fn) {
    const out = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
    }));
    return out;
}

/**
 * @param {{ url: string, username?: string, password?: string, folder?: string }} config  the saved WebDAV settings
 * @param {{ rootName?: string, request?: Function, conditional?: boolean }} options
 *   request replaces the HTTP call, for tests; conditional: true when the server enforces If-Match
 */
export function createWebDavStore(config, { rootName = STORE_ROOT_NAME, request: send = request, ensureDir = davEnsureDir, conditional = false } = {}) {
    const root = (path) => davJoin(rootName, path);
    const caps = {
        [CAPABILITIES.rangeRead]: true, [CAPABILITIES.conditionalWrite]: conditional,
        [CAPABILITIES.cheapList]: false, [CAPABILITIES.realFolders]: true,
    };
    const urlOf = (dir) => `${config.url}/${davJoin(config.folder, dir).split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
    const verifiedDirs = new Set();
    let opened = false;

    // Children of the folder `dir` (relative to the store), or null when it does not exist
    async function children(dir) {
        const res = await send(config, 'PROPFIND', root(dir), { body: PROPFIND, headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' } });
        if (res.status === 404) return null;
        if (res.status !== 207 && !res.ok) throw failure(res, 'Listing the folder');
        const xml = await res.text();
        const selfPath = safeDecode(new URL(urlOf(root(dir)).replace(/\/+$/, '')).pathname).replace(/\/+$/, '');
        const entries = [];
        for (const m of xml.matchAll(/<(?:\w+:)?response[\s>][\s\S]*?<\/(?:\w+:)?response>/g)) {
            const href = tagIn(m[0], 'href');
            if (!href) continue;
            const pathname = safeDecode(new URL(href, config.url).pathname).replace(/\/+$/, '');
            if (pathname === selfPath || !pathname.startsWith(`${selfPath}/`)) continue;
            const name = pathname.slice(selfPath.length + 1);
            if (name.includes('/')) continue;
            let props = '';
            for (const ps of m[0].matchAll(/<(?:\w+:)?propstat>([\s\S]*?)<\/(?:\w+:)?propstat>/g)) if (/\s200[\s<]/.test(ps[1] + '<')) props += ps[1];
            const mtime = new Date(tagIn(props, 'getlastmodified'));
            const size = Number(tagIn(props, 'getcontentlength')) || 0;
            const modifiedTime = Number.isNaN(mtime.getTime()) ? '' : mtime.toISOString();
            entries.push({
                name, isDir: /<(?:\w+:)?collection\s*\/?>/.test(props), size, modifiedTime,
                version: tagIn(props, 'getetag') || `${mtime.getTime() || 0}:${size}`,
            });
        }
        return entries;
    }

    // The file's current entry (or null), after checking that no folder level or file name has a case or unicode twin
    async function resolve(path) {
        const parts = path.split('/');
        let dir = '';
        let entry = null;
        for (let i = 0; i < parts.length; i++) {
            const last = i === parts.length - 1;
            const here = dir ? `${dir}/${parts[i]}` : parts[i];
            if (last || !verifiedDirs.has(here)) {
                const list = await children(dir);
                if (!list) return null;      // a missing folder has no twins and no file
                const wanted = fold(parts[i]);
                for (const e of list) {
                    if (e.name !== parts[i] && fold(e.name) === wanted) throw new ConflictError(`"${parts[i]}" collides with "${e.name}": this server ignores case`);
                }
                const exact = list.find((e) => e.name === parts[i]);
                if (!last) { if (exact) verifiedDirs.add(here); else return null; } else entry = exact && !exact.isDir ? exact : null;
            }
            dir = here;
        }
        return entry && { path, size: entry.size, version: entry.version, modifiedTime: entry.modifiedTime };
    }

    const sameVersion = (a, b) => String(a || '').replace(/^W\//, '') === String(b || '').replace(/^W\//, '');

    async function pruneEmpty(path) {
        const parts = path.split('/').slice(0, -1);
        while (parts.length) {
            const dir = parts.join('/');
            try {
                const list = await children(dir);
                if (list && list.length) return;
                if (list) await send(config, 'DELETE', root(dir));
            } catch (_) { return; }
            verifiedDirs.delete(dir);
            parts.pop();
        }
    }

    return {
        label: 'your WebDAV server',
        location: `${config.url.replace(/^https?:\/\//, '')}${config.folder ? ` / ${config.folder}` : ''} / ${rootName || '(top)'}`,
        get capabilities() { return caps; },

        async open({ create } = {}) {
            if (opened) return true;
            const res = await send(config, 'PROPFIND', root(''), { body: PROPFIND, headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' } });
            if (res.status === 404) {
                if (!create) return false;
                await ensureDir(config, root(''));
            } else if (res.status !== 207 && !res.ok) throw failure(res, 'Connecting');
            opened = true;
            return true;
        },

        async list(prefix = '') {
            checkStorePrefix(prefix);
            const out = [];
            const walk = async (dir) => {
                const list = await children(dir);
                if (!list) return;
                const subdirs = [];
                for (const e of list) {
                    const p = dir ? `${dir}/${e.name}` : e.name;
                    if (e.isDir) subdirs.push(p);
                    else out.push({ path: p, size: e.size, version: e.version, modifiedTime: e.modifiedTime });
                }
                await pool(subdirs, 4, walk);
            };
            await walk(prefix.replace(/\/$/, ''));
            return out;
        },

        async stat(path) { checkStorePath(path); return resolve(path); },

        async read(path, { range } = {}) {
            checkStorePath(path);
            if (range && !(range.end > range.start)) {
                if (!(await resolve(path))) throw new NotFoundError(`No such file: ${path}`);
                return new Uint8Array(0);
            }
            const res = await send(config, 'GET', root(path), range ? { headers: { Range: `bytes=${range.start}-${range.end - 1}` } } : {});
            if (res.status === 404) throw new NotFoundError(`No such file: ${path}`);
            if (res.status === 416) return new Uint8Array(0);
            if (!res.ok) throw failure(res, `Downloading ${path.split('/').pop()}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (range && res.status === 200) return bytes.slice(range.start, range.end);
            return bytes;
        },

        async write(path, bytes, { ifVersion } = {}) {
            checkStorePath(path);
            const existing = await resolve(path);
            if (ifVersion !== undefined && (ifVersion === null ? existing : (!existing || !sameVersion(existing.version, ifVersion)))) {
                throw new ConflictError(`${path} changed since it was read`, existing ? existing.version : null);
            }
            const headers = { 'Content-Type': 'application/octet-stream' };
            if (ifVersion === null) headers['If-None-Match'] = '*';
            else if (typeof ifVersion === 'string' && /^(W\/)?"/.test(ifVersion)) headers['If-Match'] = ifVersion;
            const put = () => send(config, 'PUT', root(path), { body: bytes, headers });
            let res = await put();
            // 409: a parent folder is missing. Create the chain once and retry
            if (res.status === 409) {
                await ensureDir(config, root(path.split('/').slice(0, -1).join('/')));
                res = await put();
            }
            if (res.status === 412) throw new ConflictError(`${path} changed since it was read`, (await resolve(path).catch(() => null))?.version ?? null);
            if (!res.ok) throw failure(res, `Uploading ${path.split('/').pop()}`);
            let version = res.headers.get('etag') || '';
            if (!version) version = (await resolve(path))?.version || '';
            return { version };
        },

        async delete(path, { ifVersion } = {}) {
            checkStorePath(path);
            const existing = await resolve(path);
            if (ifVersion !== undefined && (ifVersion === null ? existing : (!existing || !sameVersion(existing.version, ifVersion)))) {
                throw new ConflictError(`${path} changed since it was read`, existing ? existing.version : null);
            }
            if (!existing) return false;
            const res = await send(config, 'DELETE', root(path));
            if (res.status === 404) return false;
            if (!res.ok) throw failure(res, `Deleting ${path.split('/').pop()}`);
            await pruneEmpty(path);
            return true;
        },
    };
}
