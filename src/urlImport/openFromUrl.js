// urlImport/openFromUrl.js
// The "From URL" flow: a direct link to a supported file is downloaded as it is; an address an extension's URL importer
// claims (see urlImport.js) is run through it, after the user has agreed to the hosts it declared. Returns the file and
// any sync sets, and leaves opening them to the caller.

import { hasNativeHttp } from '../s3Client.js';
import { findUrlImporter } from '../fileAdapters.js';
import { parseWebAddress, runUrlSteps, fileNameFor } from './urlImport.js';

const APPROVED_KEY = 'url_importer_approved';
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

/** An extension importer for this address, once the user has agreed to it fetching from its hosts. */
async function findApprovedImporter(url) {
    const importer = await findUrlImporter(url);
    if (!importer) return null;
    const hosts = [...new Set([new URL(url).host, ...importer.hosts])];
    const approval = `${importer.ext}:${importer.id}@${hosts.join(',')}`;
    let approved = [];
    try { approved = JSON.parse(localStorage.getItem(APPROVED_KEY) || '[]'); } catch { /* none yet */ }
    if (!approved.includes(approval)) {
        if (!confirm(`The extension importer "${importer.id}" will fetch data from ${hosts.join(', ')} to build the file. Continue?`)) throw new Error('Cancelled.');
        try { localStorage.setItem(APPROVED_KEY, JSON.stringify([...approved, approval])); } catch { /* asked again next time */ }
    }
    return importer;
}

/**
 * @param {string} urlText what the user typed
 * @returns {Promise<{file: File, sync: object[]}>}
 */
export async function openFromUrl(urlText) {
    const url = parseWebAddress(urlText);
    const importer = await findApprovedImporter(url.href);
    if (!importer) return { file: await fetchFile(url.href), sync: [] };
    const { file, sync } = await runUrlSteps({ url: url.href, hosts: importer.hosts, step: importer.step, fetchText });
    return { file: new File([file.bytes], file.name), sync };
}
