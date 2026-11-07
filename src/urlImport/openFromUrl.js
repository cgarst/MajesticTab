// urlImport/openFromUrl.js
// The "From URL" flow: downloads a file directly from a web address, and leaves opening it to the caller.

import { hasNativeHttp } from '../s3Client.js';
import { parseWebAddress, fileNameFor } from './urlImport.js';
import { decodeText, charsetOf } from '../utils/decodeText.js';

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
