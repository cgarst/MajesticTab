// urlImport/openFromUrl.js
// The "From URL" flow: downloads a file directly from a web address, and leaves opening it to the caller.

import { hasNativeHttp } from '../s3Client.js';
import { parseWebAddress, fileNameFor } from './urlImport.js';
import { decodeText, charsetOf } from '../utils/decodeText.js';
import { serviceDescLink, loadSpec, findOperation, asyncMapping, authOf } from './openApiDiscovery.js';
import { withToken } from './asyncJob.js';

/**
 * Extracts target URL if wrapped in a known search engine or proxy redirect endpoint
 * (e.g. Google /url?q=..., DuckDuckGo /l/?uddg=..., or generic /url?url=...)
 * @param {string} rawUrl
 * @returns {string}
 */
export function unwrapRedirectUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
        const u = new URL(rawUrl);
        const host = u.hostname.toLowerCase();
        const path = u.pathname.toLowerCase();

        // 1. Google redirect wrapper: ONLY on /url endpoint
        if (host.includes('google.') && (path === '/url' || path.startsWith('/url/'))) {
            const val = u.searchParams.get('url') || u.searchParams.get('q');
            if (val && /^https?:/i.test(val)) return val;
        }

        // 2. DuckDuckGo redirect wrapper: ONLY on /l/ endpoint with uddg
        if (host.includes('duckduckgo.com') && (path === '/l' || path.startsWith('/l/'))) {
            const val = u.searchParams.get('uddg');
            if (val && /^https?:/i.test(val)) return val;
        }

        // 3. Generic redirect wrappers on explicit redirect endpoints
        if (path.includes('url') || path.includes('redirect') || path.includes('goto') || path.includes('link') || path.includes('out')) {
            for (const key of ['url', 'target', 'dest', 'u', 'r', 'uddg']) {
                const val = u.searchParams.get(key);
                if (val && /^https?:/i.test(val)) return val;
            }
        }
    } catch {}
    return rawUrl;
}

const CORS_HINT = 'Could not reach that address. In the browser the site must allow cross-origin requests; the desktop and mobile apps can fetch it.';

export const httpFetch = () => (hasNativeHttp() ? window.__TAURI__.http.fetch : fetch);

async function request(url, accept) {
    let res;
    try {
        res = await httpFetch()(url, { headers: { Accept: accept } });
    } catch {
        throw new Error(CORS_HINT);
    }
    if (!res.ok) throw new Error(`That address answered ${res.status}.`);
    return res;
}

// Browsers undo Content-Encoding themselves, but the native HTTP client can hand back the gzip bytes of a server that
// sends them anyway even when not asked, so a body that starts with the gzip magic is unpacked.
export const fetchText = async url => {
    const res = await request(url, 'application/json, text/html, text/plain, */*');
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b && typeof DecompressionStream === 'function') {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return decodeText(bytes, charsetOf(res.headers?.get?.('content-type')));
};

async function fetchFile(url) {
    const res = await request(url, '*/*');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const name = fileNameFor(url, res.headers?.get?.('content-disposition') || '');
    return new File([bytes], name, { type: res.headers?.get?.('content-type') || '' });
}

/**
 * @param {string} urlText what the user typed
 * @returns {Promise<{file: File}>}
 */
export async function openFromUrl(urlText) {
    const url = parseWebAddress(urlText);
    return { file: await fetchFile(url.href) };
}

const startsWith = (bytes, text) => [...text].every((c, i) => bytes[i] === c.charCodeAt(0));

/** The extension a downloaded body's first bytes and Content-Type show, or '' when it is not a supported tab file. */
async function sniffExtension(bytes, contentType) {
    if (startsWith(bytes, '%PDF')) return 'pdf';
    if (startsWith(bytes, 'BCFZ') || startsWith(bytes, 'BCFS')) return 'gpx';
    if (startsWith(bytes, 'PK')) return (await (await import('../mpak.js')).isMpakBytes(bytes)) ? 'mpak' : 'gp';
    const head = String.fromCharCode(...bytes.slice(1, 40));
    const version = bytes[0] === 0 ? /FICHIER GUITAR PRO v(\d)/.exec(head) : null;
    if (version) return version[1] === '3' ? 'gp3' : version[1] === '4' ? 'gp4' : 'gp5';
    if (/^text\/plain/i.test(contentType)) return 'txt';
    return '';
}

const JOB_BODY_MAX = 256 * 1024;

/** What a service said about an address that answered with JSON: a job to follow, or null when it describes none. */
async function jobFrom(res, address) {
    const link = serviceDescLink(res.headers?.get?.('link'), address);
    if (!link || new URL(link).origin !== new URL(address).origin) return null;
    const text = await res.text();
    if (text.length > JOB_BODY_MAX) return null;
    let first;
    try { first = JSON.parse(text); } catch { return null; }
    const spec = await loadSpec(link, httpFetch());
    const found = findOperation(spec, address);
    if (!found) return null;
    const { mapping, error } = asyncMapping(found.operation);
    if (!mapping) {
        if (found.operation['x-async-job']) throw new Error(error);
        return null;
    }
    const access = authOf(spec, found.operation);
    const url = new URL(address);
    const token = access.queryName ? url.searchParams.get(access.queryName) : '';
    return {
        first,
        mapping,
        origin: url.origin,
        title: String(spec.info?.title || ''),
        strip: access.strip,
        auth: token ? { token, queryName: access.queryName } : null
    };
}

/**
 * Asks an address what it serves. Returns a file ({ file }) when it is a supported tab file, a job to follow
 * ({ job }) when the service's own description says the address starts one, else null so the caller can browse the
 * address as a page. A page is not read past its headers. Throws only for a service that needs an access token or
 * describes its job incompletely.
 * @param {string} urlText
 * @returns {Promise<{file: File}|{job: object}|null>}
 */
export async function probeAddress(urlText) {
    let url;
    let res;
    try {
        url = parseWebAddress(urlText);
        res = await httpFetch()(url.href, { headers: { Accept: '*/*' } });
    } catch {
        return null;
    }
    const link = serviceDescLink(res.headers?.get?.('link'), url.href);
    if (!res.ok) {
        try { await res.body?.cancel?.(); } catch { /* nothing to cancel */ }
        if ((res.status === 401 || res.status === 403) && link) throw new Error('This service needs an access token. Add it to the address.');
        return null;
    }
    const type = res.headers?.get?.('content-type') || '';
    if (/^(text\/html|application\/xhtml)/i.test(type)) {
        try { await res.body?.cancel?.(); } catch { /* nothing to cancel */ }
        return null;
    }
    if (/json/i.test(type)) {
        const job = await jobFrom(res, url.href);
        return job ? { job } : null;
    }
    try {
        const bytes = new Uint8Array(await res.arrayBuffer());
        let name = fileNameFor(url.href, res.headers?.get?.('content-disposition') || '');
        if (!/\.(gp[345x]?|pdf|txt|mpak)$/i.test(name)) {
            const ext = await sniffExtension(bytes, type);
            if (!ext) return null;
            name = `${name.replace(/\.[^.]*$/, '') || 'tab-from-url'}.${ext}`;
        }
        return { file: new File([bytes], name, { type }) };
    } catch {
        return null;
    }
}

/** The file a finished job made, fetched from its result address with the job's access token. */
export async function fetchJobFile(resultUrl, auth) {
    return fetchFile(withToken(resultUrl, auth));
}

/** GET for the job runner: the status address (it already carries the token) as JSON. */
export const fetchStatus = (url) => httpFetch()(url, { headers: { Accept: 'application/json' } });
