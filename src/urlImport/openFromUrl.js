// urlImport/openFromUrl.js
// The "From URL" flow: downloads a file directly from a web address, and leaves opening it to the caller.

import { hasNativeHttp } from '../s3Client.js';
import { parseWebAddress, fileNameFor } from './urlImport.js';
import { decodeText, charsetOf } from '../utils/decodeText.js';

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

// Backward-compatible alias
export const unwrapGoogleUrl = unwrapRedirectUrl;

const CORS_HINT = 'Could not reach that address. In the browser the site must allow cross-origin requests; the desktop and mobile apps can fetch it.';

const httpFetch = () => (hasNativeHttp() ? window.__TAURI__.http.fetch : fetch);

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

// Android: once the downloader webview exists, plugin command replies (including the HTTP plugin's) never reach the
// app, so a request made then would hang. The shell's own bridge does the GET and answers through __onNativeFetch.
const nativeFetchWaiters = new Map();
let nativeFetchSeq = 0;
const NATIVE_FETCH_TIMEOUT_MS = 30000;

if (typeof window !== 'undefined') {
    window.__onNativeFetch = (id, status, body) => {
        const done = nativeFetchWaiters.get(id);
        if (!done) return;
        nativeFetchWaiters.delete(id);
        done(status, body);
    };
}

const hasBridgeFetch = () => typeof window !== 'undefined' && typeof window.MajesticDownloaderNative?.fetchText === 'function';

function bridgeFetchText(url) {
    return new Promise((resolve, reject) => {
        const id = `nf${++nativeFetchSeq}`;
        const timer = setTimeout(() => {
            nativeFetchWaiters.delete(id);
            reject(new Error(CORS_HINT));
        }, NATIVE_FETCH_TIMEOUT_MS);
        nativeFetchWaiters.set(id, (status, body) => {
            clearTimeout(timer);
            if (!status) reject(new Error(CORS_HINT));
            else if (status < 200 || status > 299) reject(new Error(`That address answered ${status}.`));
            else resolve(body);
        });
        try {
            window.MajesticDownloaderNative.fetchText(id, url);
        } catch {
            clearTimeout(timer);
            nativeFetchWaiters.delete(id);
            reject(new Error(CORS_HINT));
        }
    });
}

// Browsers undo Content-Encoding themselves, but the native HTTP client can hand back the gzip bytes of a server that
// sends them anyway even when not asked, so a body that starts with the gzip magic is unpacked.
export const fetchText = async url => {
    if (hasBridgeFetch()) return bridgeFetchText(url);
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
 * @returns {Promise<{file: File, sync: object[]}>}
 */
export async function openFromUrl(urlText) {
    const url = parseWebAddress(urlText);
    return { file: await fetchFile(url.href), sync: [] };
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

/**
 * Asks an address that does not end in a tab file extension (a download endpoint, say) what it serves. Returns the
 * file when it is a supported tab file (by its Content-Disposition name, or the bytes), else null so the caller
 * can browse the address as a page. A page is not read past its headers. Never throws.
 * @param {string} urlText
 * @returns {Promise<File|null>}
 */
export async function probeTabFile(urlText) {
    try {
        const url = parseWebAddress(urlText);
        const res = await request(url.href, '*/*');
        const type = res.headers?.get?.('content-type') || '';
        if (/^(text\/html|application\/xhtml)/i.test(type)) {
            try { await res.body?.cancel?.(); } catch { /* nothing to cancel */ }
            return null;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        let name = fileNameFor(url.href, res.headers?.get?.('content-disposition') || '');
        if (!/\.(gp[345x]?|pdf|txt|mpak)$/i.test(name)) {
            const ext = await sniffExtension(bytes, type);
            if (!ext) return null;
            name = `${name.replace(/\.[^.]*$/, '') || 'tab-from-url'}.${ext}`;
        }
        return new File([bytes], name, { type });
    } catch {
        return null;
    }
}
