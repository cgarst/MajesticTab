// classtab/download.js
// Gets the Classtab archive onto the device: streamed through the native shell (the site does not allow cross-origin
// requests, so a browser build cannot do it and offers "Choose ZIP file" instead), or read from a file the user picks.

import { hasNativeHttp } from '../s3Client.js';
import { ClasstabError } from './archive.js';

export const CLASSTAB_HOME = 'https://www.classtab.org/';
export const CLASSTAB_ZIP_URL = 'https://www.classtab.org/zip/classtab.zip';

export const canDownloadArchive = () => hasNativeHttp();

const UNREACHABLE = "Couldn't reach classtab.org. Check your connection, or use a ZIP from this device.";

/**
 * @param {{onProgress?: (loaded:number, total:number)=>void, signal?: AbortSignal}} opts
 * @returns {Promise<Uint8Array>}
 */
export async function downloadArchive({ onProgress, signal } = {}) {
    if (!hasNativeHttp()) throw new ClasstabError(UNREACHABLE, 'no-native-http');
    let res;
    try {
        res = await window.__TAURI__.http.fetch(CLASSTAB_ZIP_URL, { signal });
    } catch (e) {
        if (signal?.aborted) throw new ClasstabError('Cancelled.', 'cancelled');
        throw new ClasstabError(UNREACHABLE, 'unreachable');
    }
    if (!res.ok) throw new ClasstabError(UNREACHABLE, 'status');
    const total = Number(res.headers?.get?.('content-length')) || 0;
    const reader = res.body?.getReader?.();
    if (!reader) {
        const all = new Uint8Array(await res.arrayBuffer());
        onProgress?.(all.length, all.length);
        return all;
    }
    const chunks = [];
    let loaded = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            onProgress?.(loaded, total);
        }
    } catch (e) {
        if (signal?.aborted) throw new ClasstabError('Cancelled.', 'cancelled');
        throw new ClasstabError(UNREACHABLE, 'interrupted');
    }
    const out = new Uint8Array(loaded);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

/** Bytes of a ZIP the user chose. */
export async function readLocalZip(file) {
    return new Uint8Array(await file.arrayBuffer());
}
