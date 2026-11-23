// urlImport/urlImport.js
// Helpers for opening a tab file from a web address: reading the address and naming the download.
// Unit tested in tests/urlImport.test.mjs.

/** A web address from user text, or an Error saying why not. */
export function parseWebAddress(text) {
    let url;
    try { url = new URL(String(text).trim()); } catch { throw new Error('That is not a web address.'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https addresses are supported.');
    return url;
}

/** A file name for a download: the Content-Disposition name, else the last path segment, else a fallback. */
export function fileNameFor(url, contentDisposition = '') {
    const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition || '')?.[1];
    let name = fromHeader;
    if (name) { try { name = decodeURIComponent(name); } catch { /* keep as is */ } }
    if (!name) {
        const segment = new URL(url).pathname.split('/').filter(Boolean).pop();
        if (segment) { try { name = decodeURIComponent(segment); } catch { name = segment; } }
    }
    return (name || 'tab-from-url').replace(/[\\/:*?"<>|]+/g, '_');
}
