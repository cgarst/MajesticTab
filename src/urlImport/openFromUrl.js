// urlImport/openFromUrl.js
// The "From URL" flow: downloads a file directly from a web address, and leaves opening it to the caller.

import { hasNativeHttp } from '../s3Client.js';
import { parseWebAddress, fileNameFor } from './urlImport.js';

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

// Browsers undo Content-Encoding themselves, but the native HTTP client can hand back the gzip bytes of a server that
// sends them anyway even when not asked, so a body that starts with the gzip magic is unpacked.
export const fetchText = async url => {
    const res = await request(url, 'application/json, text/html, text/plain, */*');
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b && typeof DecompressionStream === 'function') {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return new TextDecoder().decode(bytes);
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
