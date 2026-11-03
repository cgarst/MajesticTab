// webdavClient.js
// Minimal WebDAV client (Nextcloud, ownCloud, Synology, Apache mod_dav, nginx, rclone serve webdav, ...)
// with HTTP Basic auth. In the native app requests go through Tauri's http plugin, which is not subject
// to CORS. In a browser the server must answer the preflight for PROPFIND/MKCOL (see webdavCorsHint).
import { isSecureStorageAvailable, getSecret, loadSecret, setSecret, deleteSecret } from './secureStore.js';

const CONFIG_KEY = 'majestictab_webdav_config';
export const WEBDAV_SECRET_NAME = 'majestictab_webdav_secret';

const encoder = new TextEncoder();

/** True in the native app, where requests bypass CORS. */
export const hasNativeHttp = () => typeof window !== 'undefined' && typeof window.__TAURI__?.http?.fetch === 'function';

// --- configuration ---

/** @returns {{url: string, username: string, password: string, folder: string}|null} */
export function getWebDavConfig() {
    try {
        const config = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
        if (!config?.url) return null;
        // With a keychain the password lives there and is read when a request is sent
        if (isSecureStorageAvailable()) return { ...config, password: getSecret(WEBDAV_SECRET_NAME) || config.password };
        return config;
    } catch (_) { return null; }
}

export function saveWebDavConfig(config) {
    const clean = {
        url: (config.url || '').trim().replace(/\/+$/, ''),
        username: (config.username || '').trim(),
        password: config.password || '',
        folder: (config.folder || '').trim().replace(/^\/+|\/+$/g, '')
    };
    if (clean.url && !/^https?:\/\//i.test(clean.url)) clean.url = `https://${clean.url}`;
    try { new URL(clean.url); } catch (_) { throw new Error('Enter the WebDAV address, for example https://cloud.example.com/remote.php/dav/files/me'); }
    if (!clean.url || clean.url === 'https://') throw new Error('Enter the WebDAV address.');
    if (clean.username && !clean.password) throw new Error('Enter the password for this user.');
    if (isSecureStorageAvailable()) {
        setSecret(WEBDAV_SECRET_NAME, clean.password);
        localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...clean, password: '' }));
    } else {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(clean));
    }
    return clean;
}

export function clearWebDavConfig() {
    try { localStorage.removeItem(CONFIG_KEY); } catch (_) {}
    if (isSecureStorageAvailable()) deleteSecret(WEBDAV_SECRET_NAME);
}

/** What a server must send for a browser to reach it from this origin. */
export const webdavCorsHint = (origin = window.location.origin) => [
    `Access-Control-Allow-Origin: ${origin}`,
    'Access-Control-Allow-Methods: GET, PUT, DELETE, MKCOL, PROPFIND, OPTIONS',
    'Access-Control-Allow-Headers: Authorization, Content-Type, Depth',
    'Access-Control-Max-Age: 3600'
].join('\n');

// --- paths and requests ---

const encodePath = (path) => path.split('/').filter(Boolean).map(encodeURIComponent).join('/');

/** Joins path pieces into one relative path with no leading or trailing slash. */
export const davJoin = (...parts) => parts.join('/').split('/').filter(Boolean).join('/');

/** Absolute URL for `path`, which is relative to the configured folder. */
function davUrl(config, path = '') {
    const rel = encodePath(davJoin(config.folder, path));
    return `${config.url}${rel ? `/${rel}` : ''}`;
}

function decodeURIComponentSafe(text) {
    try { return decodeURIComponent(text); } catch (_) { return text; }
}

function authHeader(config) {
    if (!config.username) return {};
    const bytes = encoder.encode(`${config.username}:${config.password || ''}`);
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return { Authorization: `Basic ${btoa(binary)}` };
}

async function request(config, method, path, { body, headers = {} } = {}) {
    if (config.username && !config.password) {
        config = { ...config, password: await loadSecret(WEBDAV_SECRET_NAME) || '' };
        if (!config.password) throw new Error('The WebDAV password is missing. Re-enter it in the WebDAV settings.');
    }
    try {
        return await (hasNativeHttp() ? window.__TAURI__.http.fetch : fetch)(davUrl(config, path), {
            method,
            body,
            headers: { ...authHeader(config), ...headers }
        });
    } catch (_) {
        throw new Error(hasNativeHttp()
            ? 'Could not reach the server. Check the address.'
            : 'Could not reach the server. Check the address and that the server allows this origin (CORS, including PROPFIND).');
    }
}

function failure(res, action) {
    if (res.status === 401) return new Error(`${action} failed: the server rejected the username or password.`);
    if (res.status === 403) return new Error(`${action} failed: access was refused (403).`);
    if (res.status === 507) return new Error(`${action} failed: the server is out of space.`);
    return new Error(`${action} failed (${res.status}).`);
}

// --- operations ---

const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';

/**
 * Lists the children of the folder `path`. Resolves to null when the folder does not exist.
 * @returns {Promise<Array<{name: string, path: string, isDir: boolean, size: number, modifiedTime: string}>|null>}
 */
export async function davList(config, path = '') {
    const res = await request(config, 'PROPFIND', path, {
        body: PROPFIND_BODY,
        headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }
    });
    if (res.status === 404) return null;
    if (res.status !== 207 && !res.ok) throw failure(res, 'Listing the folder');
    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
    const selfPath = decodeURIComponentSafe(new URL(davUrl(config, path)).pathname).replace(/\/+$/, '');
    const text = (node, tag) => node.getElementsByTagNameNS('DAV:', tag)[0]?.textContent || '';
    const entries = [];
    for (const node of doc.getElementsByTagNameNS('DAV:', 'response')) {
        // Only the properties the server reported with a 200 status are real (a 404 propstat holds empty ones)
        const href = text(node, 'href');
        if (!href) continue;
        const pathname = decodeURIComponentSafe(new URL(href, config.url).pathname).replace(/\/+$/, '');
        if (pathname === selfPath) continue;
        const name = pathname.slice(pathname.lastIndexOf('/') + 1);
        if (!name) continue;
        const modified = new Date(text(node, 'getlastmodified'));
        entries.push({
            name,
            path: davJoin(path, name),
            isDir: node.getElementsByTagNameNS('DAV:', 'collection').length > 0,
            size: Number(text(node, 'getcontentlength')) || 0,
            modifiedTime: Number.isNaN(modified.getTime()) ? '' : modified.toISOString()
        });
    }
    return entries;
}

export async function davGet(config, path) {
    const res = await request(config, 'GET', path);
    if (!res.ok) throw failure(res, `Downloading ${path.split('/').pop()}`);
    return res;
}

/** Creates one folder. Already existing is fine; a missing parent resolves to false. */
async function mkcol(config, path) {
    const res = await request(config, 'MKCOL', path);
    // 405: already exists. Some servers answer 301 for an existing folder or 200/204 for a no-op
    if (res.ok || res.status === 405 || res.status === 301 || res.status === 302) return true;
    if (res.status === 409) return false;
    throw failure(res, `Creating the folder ${path.split('/').pop()}`);
}

/** Creates `path` (and the configured folder above it) and every missing parent below the configured address. */
export async function davEnsureDir(config, path = '') {
    // `request` joins the configured folder itself, so walk the full path from the address instead
    const bare = { ...config, folder: '' };
    let current = '';
    for (const segment of davJoin(config.folder, path).split('/').filter(Boolean)) {
        current = davJoin(current, segment);
        if (!(await mkcol(bare, current))) throw new Error(`Could not create ${current}: its parent folder is missing on the server.`);
    }
}

export async function davPut(config, path, body, contentType = 'application/octet-stream') {
    const send = () => request(config, 'PUT', path, { body, headers: { 'Content-Type': contentType } });
    let res = await send();
    // 409: the parent folder is missing. Create it once and retry
    if (res.status === 409) {
        await davEnsureDir(config, path.split('/').slice(0, -1).join('/'));
        res = await send();
    }
    if (!res.ok) throw failure(res, `Uploading ${path.split('/').pop()}`);
}

export async function davDelete(config, path) {
    const res = await request(config, 'DELETE', path);
    // 404 means it is already gone, which is the outcome we wanted
    if (!res.ok && res.status !== 404) throw failure(res, `Deleting ${path.split('/').pop()}`);
}

/** Resolves when the address and credentials work, throws with the reason otherwise. Creates the folder when it is missing. */
export async function davCheck(config) {
    const res = await request(config, 'PROPFIND', '', { body: PROPFIND_BODY, headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' } });
    if (res.status === 404 && config.folder) return davEnsureDir(config, '');
    if (res.status !== 207 && !res.ok) {
        if (res.status === 404) throw new Error('Connecting failed: that address does not exist on the server.');
        throw failure(res, 'Connecting');
    }
}
