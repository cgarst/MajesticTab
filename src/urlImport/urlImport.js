// urlImport/urlImport.js
// Opens a tab file from a web address. A direct link to a supported file is just downloaded. A site that needs more
// than one request is handled by a user extension's URL importer (`registerUrlImporter`, see extensionSandbox/frame.js),
// which runs in a sandbox with no network: it is a step function that returns `{ fetch: [addresses] }` for this module
// to fetch (`optional: true` turns a failed request into an empty response instead of an error), or the finished
// `{ file: { name, bytes }, sync? }`. The extension decides where the data is; this decides
// what it may fetch: https only, hosts the extension declared (`example.com` or `*.example.com`) plus the site the user
// gave, a few rounds and requests, and a size cap. Pure apart from the injected functions; unit tested in
// tests/urlImport.test.mjs.

const MAX_ROUNDS = 8;
const MAX_PER_ROUND = 8;
const MAX_CHARS = 5_000_000;
const MAX_FILE_BYTES = 50_000_000;

/** True when `host` is the pattern's host, or (for `*.name`) any subdomain of it, matching whole labels only. */
export function hostMatches(host, pattern) {
    const h = String(host).toLowerCase();
    const p = String(pattern).trim().toLowerCase();
    if (!p) return false;
    if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
    return h === p;
}

/** True when `host` is allowed by any of the declared `hosts`. */
export function hostAllowed(host, hosts) {
    return (hosts || []).some(pattern => hostMatches(host, pattern));
}

/** A web address from user text, or an Error saying why not. */
export function parseWebAddress(text) {
    let url;
    try { url = new URL(String(text).trim()); } catch { throw new Error('That is not a web address.'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https addresses are supported.');
    return url;
}

/**
 * Runs an importer's steps to a finished file.
 * @param {object} opts
 * @param {string} opts.url the address the user gave
 * @param {string[]} opts.hosts hosts the importer declared
 * @param {(url: string, responses: string[]) => Promise<{file?: {name: string, bytes: Uint8Array|ArrayBuffer}, sync?: object[], fetch?: string[]}>} opts.step
 * @param {(url: string) => Promise<string>} opts.fetchText
 * @returns {Promise<{file: {name: string, bytes: Uint8Array|ArrayBuffer}, sync: object[]}>}
 */
export async function runUrlSteps({ url, hosts, step, fetchText }) {
    const ownHost = new URL(url).host.toLowerCase();
    const responses = [];
    for (let round = 0; round < MAX_ROUNDS; round++) {
        const out = await step(url, responses);
        if (out?.file) {
            const size = out.file.bytes?.byteLength ?? 0;
            if (!size) throw new Error('The importer returned an empty file.');
            if (size > MAX_FILE_BYTES) throw new Error('The file is too large.');
            return { file: out.file, sync: Array.isArray(out.sync) ? out.sync : [] };
        }
        const wanted = out?.fetch;
        if (!Array.isArray(wanted) || !wanted.length) throw new Error('The importer returned nothing to fetch or read.');
        if (wanted.length > MAX_PER_ROUND) throw new Error(`The importer asked for ${wanted.length} addresses at once; the limit is ${MAX_PER_ROUND}.`);
        for (const address of wanted) {
            let target;
            try { target = new URL(address); } catch { throw new Error('The importer asked for something that is not a web address.'); }
            if (target.protocol !== 'https:') throw new Error('The importer may only fetch https addresses.');
            if (target.host.toLowerCase() !== ownHost && !hostAllowed(target.hostname, hosts)) {
                throw new Error(`The importer asked for ${target.host}, which it did not declare and is not the site you gave (${ownHost}).`);
            }
            let text;
            try {
                text = await fetchText(target.href);
            } catch (error) {
                if (!out.optional) throw error;
                text = ''; // the importer asked for a best-effort fetch and reads the empty answer itself
            }
            if (text.length > MAX_CHARS) throw new Error('A response was too large.');
            responses.push(text);
        }
    }
    throw new Error('The importer needed too many steps.');
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

/**
 * Turns an importer's sync sets into points on the played bars, keeping the ones that fit exactly.
 * @param {Array<{label?: string, videoId?: string, barTimesMs: number[]}>} sets
 * @param {(barTimesMs: number[]) => object[]} place throws when the count does not match
 * @returns {{ placed: Array<{label: string, videoId: string, points: object[]}>, skipped: string[] }}
 */
export function placeSyncSets(sets, place) {
    const placed = [];
    const skipped = [];
    for (const set of sets || []) {
        const label = String(set?.label || set?.videoId || 'video');
        if (typeof set?.videoId !== 'string' || !/^[\w-]{6,20}$/.test(set.videoId) || !Array.isArray(set.barTimesMs)) {
            skipped.push(`${label}: not usable`);
            continue;
        }
        try {
            placed.push({ label, videoId: set.videoId, points: place(set.barTimesMs) });
        } catch (error) {
            skipped.push(`${label}: ${error.message}`);
        }
    }
    return { placed, skipped };
}
