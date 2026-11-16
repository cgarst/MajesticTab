// storage/s3Store.js
// The storage contract (contract.js) on an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi).
// Requests are signed by s3Client.js. Versions are ETags. Writes use If-None-Match / If-Match, which AWS S3, R2 and MinIO
// enforce; a server that answers 501 or ignores them falls back to check-then-write and the store says so in
// `capabilities.conditionalWrite`, which the sync engine reads. Objects are flat keys, so there are no folders to create
// and names are case-sensitive and byte exact.
import {
    CAPABILITIES, NotFoundError, ConflictError, StorageError, checkStorePath, checkStorePrefix,
} from './contract.js';
import { STORE_ROOT_NAME } from './storeInfo.js';
import { request } from '../s3Client.js';

const decodeXml = (text) => text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => {
    const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? decodeXml(m[1]) : '';
};

async function failure(res, action) {
    let detail = '';
    try { const text = await res.text(); detail = tag(text, 'Message') || tag(text, 'Code'); } catch (_) {}
    const err = new StorageError(`${action} failed (${res.status})${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
    return err;
}

/**
 * @param {object} config  the saved bucket settings (s3Client.getS3Config)
 * @param {{ rootName?: string, request?: Function, conditional?: boolean }} options
 *   rootName: folder-like key prefix inside config.prefix ('' for none); request: replaces the signed request, for tests;
 *   conditional: false forces check-then-write
 */
export function createS3Store(config, { rootName = STORE_ROOT_NAME, request: send = request, conditional = true } = {}) {
    const base = `${config.prefix ? `${config.prefix}/` : ''}${rootName ? `${rootName}/` : ''}`;
    const key = (path) => `${base}${path}`;
    const caps = {
        [CAPABILITIES.rangeRead]: true, [CAPABILITIES.conditionalWrite]: conditional,
        [CAPABILITIES.cheapList]: true, [CAPABILITIES.realFolders]: false,
    };
    let opened = false;
    const etagOf = (res) => res.headers.get('etag') || '';

    async function head(path) {
        const res = await send(config, 'HEAD', key(path));
        if (res.status === 404) return null;
        if (!res.ok) throw await failure(res, `Checking ${path}`);
        return {
            path, size: Number(res.headers.get('content-length')) || 0, version: etagOf(res),
            modifiedTime: res.headers.get('last-modified') ? new Date(res.headers.get('last-modified')).toISOString() : '',
        };
    }

    async function listKeys(fullPrefix, maxKeys) {
        const out = [];
        let token = null;
        do {
            const query = { 'list-type': 2, prefix: fullPrefix };
            if (maxKeys) query['max-keys'] = maxKeys;
            if (token) query['continuation-token'] = token;
            const res = await send(config, 'GET', '', { query });
            if (!res.ok) throw await failure(res, 'Listing the bucket');
            const xml = await res.text();
            for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
                out.push({ key: tag(m[1], 'Key'), size: Number(tag(m[1], 'Size')) || 0, version: tag(m[1], 'ETag'), modifiedTime: tag(m[1], 'LastModified') });
            }
            token = !maxKeys && tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') || null : null;
        } while (token);
        return out;
    }

    // ETags come back quoted from PUT and HEAD and, in some servers, unquoted or entity-escaped in listings. Compare on
    // the bare value so a version read from one call matches the one from another.
    const bare = (v) => String(v || '').replace(/^W\//, '').replace(/^"|"$/g, '').replace(/&quot;/g, '');

    async function checkVersion(path, ifVersion) {
        const cur = await head(path);
        if (ifVersion === null ? cur : (!cur || bare(cur.version) !== bare(ifVersion))) {
            throw new ConflictError(`${path} changed since it was read`, cur ? cur.version : null);
        }
    }

    return {
        label: 'your S3 bucket',
        location: `${config.bucket} / ${base.replace(/\/$/, '') || '(top)'}`,
        get capabilities() { return caps; },

        // A bucket has no folders to create: the store exists once something is under its prefix
        async open({ create } = {}) {
            if (opened) return true;
            if (create) { opened = true; return true; }
            opened = (await listKeys(base, 1)).length > 0;
            return opened;
        },

        async list(prefix = '') {
            checkStorePrefix(prefix);
            const items = await listKeys(key(prefix));
            return items.filter((o) => !o.key.endsWith('/')).map((o) => ({
                path: o.key.slice(base.length), size: o.size, version: o.version, modifiedTime: o.modifiedTime,
            }));
        },

        async stat(path) { checkStorePath(path); return head(path); },

        async read(path, { range } = {}) {
            checkStorePath(path);
            if (range && !(range.end > range.start)) {
                // nothing asked for; still say so when the file is absent
                if (!(await head(path))) throw new NotFoundError(`No such file: ${path}`);
                return new Uint8Array(0);
            }
            const headers = range ? { Range: `bytes=${range.start}-${range.end - 1}` } : {};
            const res = await send(config, 'GET', key(path), { headers });
            if (res.status === 404) throw new NotFoundError(`No such file: ${path}`);
            if (res.status === 416) return new Uint8Array(0);
            if (!res.ok) throw await failure(res, `Downloading ${path.split('/').pop()}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            // a server that ignores Range answers 200 with the whole object
            if (range && res.status === 200) return bytes.slice(range.start, range.end);
            return bytes;
        },

        async write(path, bytes, { ifVersion } = {}) {
            checkStorePath(path);
            const headers = { 'Content-Type': 'application/octet-stream' };
            const checked = ifVersion !== undefined;
            if (checked && caps.conditionalWrite) {
                if (ifVersion === null) headers['If-None-Match'] = '*';
                else headers['If-Match'] = ifVersion.startsWith('"') || ifVersion.startsWith('W/') ? ifVersion : `"${bare(ifVersion)}"`;
            } else if (checked) {
                await checkVersion(path, ifVersion);
            }
            const res = await send(config, 'PUT', key(path), { body: bytes, headers });
            if (res.status === 412 || res.status === 409) {
                const cur = await head(path).catch(() => null);
                throw new ConflictError(`${path} changed since it was read`, cur ? cur.version : null);
            }
            if (checked && caps.conditionalWrite && (res.status === 501 || (res.status === 400 && /NotImplemented|not supported/i.test(await res.clone().text().catch(() => ''))))) {
                // this server does not know conditional writes: remember it, and check first from now on
                caps[CAPABILITIES.conditionalWrite] = false;
                await checkVersion(path, ifVersion);
                return this.write(path, bytes);
            }
            if (!res.ok) throw await failure(res, `Uploading ${path.split('/').pop()}`);
            let version = etagOf(res);
            if (!version) version = (await head(path))?.version || '';
            return { version };
        },

        async delete(path, { ifVersion } = {}) {
            checkStorePath(path);
            if (ifVersion !== undefined) await checkVersion(path, ifVersion);
            // S3 answers 204 for a missing key too, so look first to report whether anything was removed
            const existed = await head(path);
            if (!existed) return false;
            const res = await send(config, 'DELETE', key(path));
            if (!res.ok && res.status !== 404) throw await failure(res, `Deleting ${path.split('/').pop()}`);
            return true;
        },
    };
}
