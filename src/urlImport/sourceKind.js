// urlImport/sourceKind.js
// Decides what a search source's address does, from the service's own description, so the user does not have to say:
//   'job'    the address is an operation that starts a job (fetch a file, with a progress bar);
//   'search' the address is in the description but starts nothing (it only lists matches);
//   'page'   anything else: a web page, opened in the system browser;
//   'unknown' the service could not be reached.
// Only an address on a host that links to its description (Link, rel="service-desc") is ever read further, so an
// ordinary search engine costs one request to its home address, once a day. The answer is kept on this device only
// (it is not synced: it is a fact about the address, found again when it is missing). A source can still say 'page' or
// 'api' itself, which wins over the detection. Unit tested in tests/sourceKind.test.mjs.

import { serviceDescLink, searchDescLink, loadSpec, findOperation, asyncMapping, authOf, suggestSource, loadOpenSearch } from './openApiDiscovery.js';

export const SOURCE_KINDS_KEY = 'majestictab_source_kinds';
const KIND_TTL_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5000;

const keyOf = (template) => {
    try {
        const url = new URL(String(template).replace(/\$s|\$token/g, 'x'));
        return url.origin + url.pathname;
    } catch { return ''; }
};

function readCache() {
    try { return JSON.parse(localStorage.getItem(SOURCE_KINDS_KEY) || '{}') || {}; } catch { return {}; }
}

/** The kind found for an address on this device, 'job' | 'search' | 'page', or '' when it has not been found (or is stale). */
export function cachedKind(template) {
    const entry = readCache()[keyOf(template)];
    return entry && Date.now() - entry.at < KIND_TTL_MS ? entry.kind : '';
}

export function rememberKind(template, kind) {
    const key = keyOf(template);
    if (!key || !['job', 'search', 'page'].includes(kind)) return;
    try {
        const cache = readCache();
        const now = Date.now();
        for (const k of Object.keys(cache)) if (now - cache[k].at >= KIND_TTL_MS) delete cache[k];
        cache[key] = { kind, at: now };
        localStorage.setItem(SOURCE_KINDS_KEY, JSON.stringify(cache));
    } catch { /* storage unavailable: it is found again next time */ }
}

/**
 * Reads an address's own service to say what it does. Never starts a job.
 * @param {string} template an address or a search template ($s, $token)
 * @param {(url: string, init?: object) => Promise<Response>} fetchImpl
 * @returns {Promise<{kind: string, title?: string, needsToken?: boolean, suggestion?: string, problem?: string}>}
 *   `suggestion` is, for a 'search' address, the template of the service's own address that fetches a file
 */
export async function classifyAddress(template, fetchImpl) {
    let url;
    try { url = new URL(String(template).replace(/\$s|\$token/g, 'x')); } catch { return { kind: 'page' }; }
    if (!/^https?:$/.test(url.protocol)) return { kind: 'page' };
    const init = { headers: { Accept: 'application/json' } };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    let res;
    try { res = await fetchImpl(`${url.origin}/`, init); } catch { return { kind: 'unknown' }; }
    try { await res.body?.cancel?.(); } catch { /* nothing to cancel */ }
    const header = res.headers?.get?.('link');
    const specUrl = serviceDescLink(header, url.origin + '/');
    if (!specUrl || new URL(specUrl).origin !== url.origin) return { kind: 'page' };
    let spec;
    try { spec = await loadSpec(specUrl, fetchImpl); } catch { return { kind: 'unknown' }; }
    const title = String(spec.info?.title || url.host);
    const found = findOperation(spec, url.href);
    if (!found) return { kind: 'page', title };
    const { mapping, error } = asyncMapping(found.operation);
    if (mapping) return { kind: 'job', title, needsToken: authOf(spec, found.operation).required };
    if (found.operation['x-async-job']) return { kind: 'page', title, problem: error };
    // In the description but starts nothing: offer the service's own address that does.
    let suggestion = '';
    const searchUrl = searchDescLink(header, url.origin + '/');
    if (searchUrl && new URL(searchUrl).origin === url.origin) {
        try {
            const made = suggestSource(spec, specUrl, await loadOpenSearch(searchUrl, fetchImpl));
            suggestion = made.template || '';
        } catch { /* no suggestion */ }
    }
    return { kind: 'search', title, suggestion };
}

/**
 * Whether a source fetches a file, without any request: its own choice, else what was found for its address.
 * An address nobody has looked at yet is a page.
 */
export function sourceFetchesCached(source) {
    if (!source || source.isSeed) return false;
    if (source.kind === 'api') return true;
    if (source.kind === 'page') return false;
    return cachedKind(source.urlTemplate) === 'job';
}

/** Whether a source fetches a file: its own choice, else what was found (looked up now when it is not known yet). */
export async function sourceFetches(source, fetchImpl) {
    if (!source || source.isSeed || source.kind === 'page') return false;
    if (source.kind === 'api') return true;
    const known = cachedKind(source.urlTemplate);
    if (known) return known === 'job';
    const impl = fetchImpl || (await import('./openFromUrl.js')).httpFetch();
    const { kind } = await classifyAddress(source.urlTemplate, impl);
    if (kind !== 'unknown') rememberKind(source.urlTemplate, kind);
    return kind === 'job';
}
