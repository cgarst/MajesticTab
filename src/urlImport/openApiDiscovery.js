// urlImport/openApiDiscovery.js
// Finds out from a service's own API description (OpenAPI 3, JSON) what an address does: whether it starts a job, how
// to read the job's progress, whether it needs an access token and where the token goes. The app knows no host and no
// field of any service. It reads:
//   - the Link header: rel="service-desc" (RFC 8631) points at the description, rel="search" at an OpenSearch
//     description whose application/json template is the search address (the search text takes the place of
//     {searchTerms});
//   - the standard parts of the description: paths, parameters, security schemes, info.title, and the `links` of a
//     job's response, which say where its status and its file are (the link's parameters are runtime expressions such as
//     $response.body#/id, and only that form and plain values are understood);
//   - x-choices on a response that asks the user to pick (a 409 that lists matches): where the list is in the body, which
//     fields are the label, the detail and the value, and which query parameter takes the chosen value;
//   - x-async-job on the start operation: it names those two links and says what the job's
//     fields mean (the state values, the progress fields and the error), as JSON Pointers into the job.
//   x-choices and x-async-job are the two vendor extensions; everything else is standard OpenAPI.
// The description is data from the network: only GET, only local $refs, a size cap, JSON only.
// Unit tested in tests/openApiDiscovery.test.mjs.

import { readPointer } from './asyncJob.js';

export const SPEC_MAX_BYTES = 512 * 1024;
const SPEC_TTL_MS = 10 * 60 * 1000;
const MAX_REF_DEPTH = 8;

const specCache = new Map();

/** Forgets every loaded description (tests, and a "Test" that should read the service again). */
export function clearSpecCache() { specCache.clear(); }

/** The address a Link header names with the given rel, resolved against `base`, or ''. */
export function linkWithRel(linkHeader, base, wanted) {
    for (const part of String(linkHeader || '').split(/,(?=\s*<)/)) {
        const m = /^\s*<([^>]*)>\s*((?:;[^;,]*)*)/.exec(part);
        if (!m) continue;
        const rel = /;\s*rel\s*=\s*"?([^";]+)"?/i.exec(m[2])?.[1] || '';
        if (rel.toLowerCase().split(/\s+/).includes(wanted)) {
            try { return new URL(m[1], base).href; } catch { /* not an address */ }
        }
    }
    return '';
}

/** The address a Link header names with rel="service-desc", or ''. */
export const serviceDescLink = (linkHeader, base) => linkWithRel(linkHeader, base, 'service-desc');

/** The address a Link header names with rel="search", or ''. */
export const searchDescLink = (linkHeader, base) => linkWithRel(linkHeader, base, 'search');

/** A parsed description, or an Error saying why it can not be used. */
export function parseSpec(text) {
    if (String(text).length > SPEC_MAX_BYTES) throw new Error('The service description is too large.');
    let spec;
    try { spec = JSON.parse(text); } catch { throw new Error('The service description is not JSON.'); }
    if (!spec || typeof spec.openapi !== 'string' || !spec.openapi.startsWith('3.') || typeof spec.paths !== 'object' || !spec.paths) {
        throw new Error('The service description is not an OpenAPI 3 document.');
    }
    return spec;
}

/** Follows a local reference ("#/components/..."), or returns the node itself. External references are refused. */
export function resolveRef(spec, node) {
    let current = node;
    for (let depth = 0; current && typeof current === 'object' && '$ref' in current; depth++) {
        const ref = current.$ref;
        if (depth >= MAX_REF_DEPTH || typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
        current = ref.slice(2).split('/').reduce((n, key) => (n && typeof n === 'object' ? n[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), spec);
    }
    return current;
}

/** Loads a description from an address. Cached per address for a few minutes. */
export async function loadSpec(specUrl, fetchImpl) {
    const cached = specCache.get(specUrl);
    if (cached && Date.now() - cached.at < SPEC_TTL_MS) return cached.spec;
    let res;
    try { res = await fetchImpl(specUrl, { headers: { Accept: 'application/json' } }); } catch { throw new Error('Could not read the service description.'); }
    if (!res.ok) throw new Error(`The service description answered ${res.status}.`);
    const spec = parseSpec(await res.text());
    specCache.set(specUrl, { spec, at: Date.now() });
    return spec;
}

const POINTER = /^\/(?:[^/]*\/)*[^/]*$/;
const pointerOrNull = (value) => (typeof value === 'string' && POINTER.test(value) ? value : null);

const nameOrNull = (value) => (typeof value === 'string' && value ? value : null);

/**
 * The job mapping an operation declares in x-async-job, or an Error saying what is missing.
 * Required: statusLink and resultLink (names of links on the operation's response), state, states (pending, running,
 * done, failed). Optional: progress and error.
 */
export function asyncMapping(operation) {
    const raw = operation?.['x-async-job'];
    if (!raw || typeof raw !== 'object') return { error: 'This address does not describe a job.' };
    const mapping = { statusLink: nameOrNull(raw.statusLink), resultLink: nameOrNull(raw.resultLink), state: pointerOrNull(raw.state), error: pointerOrNull(raw.error), states: {}, progress: {} };
    for (const key of ['statusLink', 'resultLink', 'state']) {
        if (!mapping[key]) return { error: `The service description is missing "${key}" in x-async-job.` };
    }
    for (const name of ['pending', 'running', 'done', 'failed']) {
        const list = raw.states?.[name];
        if (!Array.isArray(list) || !list.every((s) => typeof s === 'string') || (name !== 'pending' && name !== 'running' && !list.length)) {
            return { error: `The service description is missing the "${name}" states in x-async-job.` };
        }
        mapping.states[name] = list;
    }
    for (const key of ['percent', 'step', 'steps', 'label']) {
        const pointer = pointerOrNull(raw.progress?.[key]);
        if (pointer) mapping.progress[key] = pointer;
    }
    return { mapping };
}

const pathRegex = (template) => new RegExp('^' + template.split(/(\{[^}]+\})/).map((p) => (/^\{[^}]+\}$/.test(p) ? '[^/]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('') + '/?$');

/**
 * The GET operation an address calls: its path in the description, the operation, and its parameters. A service behind
 * a path prefix (a reverse proxy) still matches, because leading segments of the address are tried away one by one.
 * @returns {{path: string, operation: object, parameters: object[], prefix: string}|null}
 */
export function findOperation(spec, address) {
    let pathname;
    try { pathname = new URL(address).pathname; } catch { return null; }
    const segments = pathname.split('/').filter(Boolean);
    for (let skip = 0; skip <= segments.length; skip++) {
        const tail = '/' + segments.slice(skip).join('/');
        for (const [path, item] of Object.entries(spec.paths)) {
            if (!item || typeof item !== 'object' || !item.get || !pathRegex(path).test(tail)) continue;
            const operation = resolveRef(spec, item.get);
            if (!operation) continue;
            const parameters = [...(item.parameters || []), ...(operation.parameters || [])].map((p) => resolveRef(spec, p)).filter(Boolean);
            return { path, operation, parameters, prefix: '/' + segments.slice(0, skip).join('/') };
        }
    }
    return null;
}

/**
 * What access an operation needs. A token goes only in the query: a service that asks for it anywhere else is
 * reported as needing a token this app can not send (`queryName` is null).
 * @returns {{required: boolean, queryName: string|null, strip: string[]}} `strip` lists every query
 *   parameter the description uses for credentials, so none lands in a stored address.
 */
export function authOf(spec, operation) {
    const schemes = spec.components?.securitySchemes || {};
    const strip = Object.values(schemes).filter((s) => s?.type === 'apiKey' && s.in === 'query' && typeof s.name === 'string').map((s) => s.name);
    const requirements = Array.isArray(operation?.security) ? operation.security : Array.isArray(spec.security) ? spec.security : [];
    const required = requirements.length > 0 && requirements.every((r) => r && Object.keys(r).length > 0);
    let queryName = null;
    if (required) {
        for (const requirement of requirements) {
            for (const key of Object.keys(requirement)) {
                const scheme = schemes[key];
                if (scheme?.type === 'apiKey' && scheme.in === 'query' && !queryName) queryName = scheme.name;
            }
        }
    }
    return { required, queryName, strip };
}

/**
 * What an operation says about a response that asks the user to choose, in x-choices on that response, or null.
 * Required: items (a JSON Pointer to the list), label and value (pointers into each item) and parameter (the query
 * parameter the chosen value goes in). Optional: detail (a pointer into each item) and replaces (a query parameter the
 * choice makes unnecessary, such as the search text).
 */
export function choicesOf(spec, operation, status) {
    const raw = resolveRef(spec, operation?.responses?.[String(status)])?.['x-choices'];
    if (!raw || typeof raw !== 'object') return null;
    const choices = { items: pointerOrNull(raw.items), label: pointerOrNull(raw.label), value: pointerOrNull(raw.value), detail: pointerOrNull(raw.detail), parameter: nameOrNull(raw.parameter), replaces: nameOrNull(raw.replaces) };
    return choices.items && choices.label && choices.value && choices.parameter ? choices : null;
}

const MAX_CHOICES = 50;

/** The options a body lists, as {label, detail, value} text; entries without a label or a value are left out. */
export function readChoices(body, choices) {
    const list = readPointer(body, choices.items);
    if (!Array.isArray(list)) return [];
    const text = (item, pointer) => {
        const v = pointer ? readPointer(item, pointer) : undefined;
        return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    };
    return list.slice(0, MAX_CHOICES)
        .map((item) => ({ label: text(item, choices.label), detail: text(item, choices.detail), value: text(item, choices.value) }))
        .filter((c) => c.label && c.value);
}

/** The address again with the chosen value in the choice's parameter (and the parameter it replaces removed). */
export function choiceAddress(address, choices, value) {
    const url = new URL(address);
    if (choices.replaces) url.searchParams.delete(choices.replaces);
    url.searchParams.set(choices.parameter, value);
    return url.href;
}

const encode = (value) => encodeURIComponent(String(value));
const prefixOf = (found) => (found.prefix === '/' ? '' : found.prefix);

/** The GET operation of a description with this operationId: its path, operation and parameters. */
function operationById(spec, operationId) {
    for (const [path, item] of Object.entries(spec.paths)) {
        const operation = item && typeof item === 'object' ? resolveRef(spec, item.get) : null;
        if (operation?.operationId !== operationId) continue;
        const parameters = [...(item.parameters || []), ...(operation.parameters || [])].map((p) => resolveRef(spec, p)).filter(Boolean);
        return { path, operation, parameters };
    }
    return null;
}

/**
 * The address a link of a start operation leads to for one job body, on `origin` and behind the same path prefix as the
 * address the user entered. The link's parameters are read as plain values or as `$response.body#/pointer`; any other
 * runtime expression makes the link unusable (''). Only the operation's own 2xx responses are searched.
 * @param {object} found from findOperation (the start operation)
 * @param {string} linkName a name from x-async-job (statusLink or resultLink)
 * @param {object} body the job JSON the service returned
 * @returns {string} '' when the description has no such link or the body lacks what it needs
 */
export function linkAddress(spec, found, linkName, body, origin) {
    let link = null;
    for (const code of Object.keys(found.operation.responses || {})) {
        if (!/^2/.test(code)) continue;
        link = resolveRef(spec, resolveRef(spec, found.operation.responses[code])?.links?.[linkName]);
        if (link) break;
    }
    const target = link && typeof link.operationId === 'string' ? operationById(spec, link.operationId) : null;
    if (!target) return '';
    let path = target.path;
    const query = [];
    for (const [key, expression] of Object.entries(link.parameters || {})) {
        const name = key.replace(/^(?:query|path)\./, '');
        let value = expression;
        if (typeof expression === 'string' && expression.startsWith('$')) {
            if (!expression.startsWith('$response.body#')) return '';
            value = readPointer(body, expression.slice('$response.body#'.length));
        }
        if (typeof value !== 'string' && typeof value !== 'number') return '';
        const where = target.parameters.find((p) => p.name === name)?.in;
        if (where === 'path') path = path.replace(`{${name}}`, encode(value));
        else if (where === 'query') query.push(`${encode(name)}=${encode(value)}`);
        else return '';
    }
    if (/\{/.test(path)) return '';
    return `${origin}${prefixOf(found)}${path}${query.length ? '?' + query.join('&') : ''}`;
}

/**
 * Parses an OpenSearch description: its Url elements. Read as text, not as a document, so it works wherever this
 * runs; the element is matched by its local name and the template is the attribute's value with XML entities undone.
 * @returns {{type: string, template: string}[]} GET templates only
 */
export function parseOpenSearch(text) {
    if (String(text).length > SPEC_MAX_BYTES) throw new Error('The search description is too large.');
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    const unescape = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => entities[n]);
    const urls = [];
    for (const tag of String(text).match(/<(?:[\w-]+:)?Url\b[^>]*>/g) || []) {
        const attr = (name) => { const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag); return m ? unescape(m[1] ?? m[2]) : ''; };
        const template = attr('template');
        if (template && (attr('method') || 'get').toLowerCase() === 'get') urls.push({ type: attr('type').toLowerCase(), template });
    }
    return urls;
}

/** The text a search puts in the template's {searchTerms} slot. */
const SEARCH_SLOT = /^\{searchTerms\??\}$/;

/**
 * A search address template for an operation, from the application/json Url of an OpenSearch description: `$s` takes the
 * artist and song text, `$token` the access token. Everything else in the service's own template stays, and the
 * operation's other query parameters are listed in `optional` for the user to choose.
 * @param {object} found from findOperation (the operation the template calls)
 * @param {string} searchTemplate the OpenSearch template, on the entered origin
 * @returns {{template: string, optional: {name: string, values: string[], description: string}[]}|null} null when the
 *   template has no {searchTerms} in its query
 */
export function buildTemplate(spec, found, searchTemplate) {
    const [base, query = ''] = searchTemplate.split('?');
    const pairs = query.split('&').filter(Boolean);
    let slot = null;
    const out = pairs.map((pair) => {
        const eq = pair.indexOf('=');
        const name = eq < 0 ? pair : pair.slice(0, eq);
        const value = eq < 0 ? '' : pair.slice(eq + 1);
        let decoded = value;
        try { decoded = decodeURIComponent(value); } catch { /* keep it raw */ }
        if (SEARCH_SLOT.test(decoded)) { slot = decodeURIComponent(name); return `${name}=$s`; }
        return pair;
    });
    if (!slot) return null;
    const auth = authOf(spec, found.operation);
    const present = new Set(out.map((p) => decodeURIComponent(p.split('=')[0])));
    const optional = [];
    for (const p of found.parameters.filter((q) => q.in === 'query')) {
        if (present.has(p.name) || p.name === auth.queryName) continue;
        const schema = resolveRef(spec, p.schema) || {};
        if (!p.required) optional.push({ name: p.name, values: Array.isArray(schema.enum) ? schema.enum.map(String) : [], description: String(p.description || '') });
    }
    if (auth.queryName && !present.has(auth.queryName)) out.push(`${encode(auth.queryName)}=$token`);
    return { template: `${base}?${out.join('&')}`, optional };
}

/** The same address on `origin`: an address that names another host (a service that reports its own) keeps its path and query. */
function onOrigin(address, origin) {
    const url = new URL(address.replace(/\{searchTerms\??\}/g, 'SEARCHTERMS'), origin);
    const text = url.origin === new URL(origin).origin ? url.href : new URL(url.pathname + url.search, origin).href;
    return text.replace(/SEARCHTERMS/g, '{searchTerms}');
}

/**
 * A source to add, read from a description and the service's OpenSearch description (the application/json Url is the
 * search address): its name, address template, and what it needs.
 * @param {object} spec the OpenAPI description
 * @param {string} specUrl where it was read from (its origin is the service's)
 * @param {{type: string, template: string}[]} searchUrls from parseOpenSearch
 * @returns {{name: string, template: string, needsToken: boolean, optional: object[]}|{error: string}}
 */
export function suggestSource(spec, specUrl, searchUrls = []) {
    const origin = new URL(specUrl).origin;
    const api = searchUrls.find((u) => /^application\/(?:[\w.+-]*\+)?json$/.test(u.type));
    if (!api) return { error: 'That service does not describe a search address (OpenSearch).' };
    let template;
    try { template = onOrigin(api.template, origin); } catch { return { error: 'The service gave a search address that is not a web address.' }; }
    const found = findOperation(spec, template.replace(/\{searchTerms\??\}/g, 'x'));
    if (!found || !asyncMapping(found.operation).mapping) return { error: 'That service does not describe a way to search for a file.' };
    const built = buildTemplate(spec, found, template);
    if (!built) return { error: 'That service does not describe a way to search for a file.' };
    return { name: String(spec.info?.title || new URL(origin).host).slice(0, 60), template: built.template, needsToken: authOf(spec, found.operation).required, optional: built.optional };
}

/** Loads an OpenSearch description from an address on the service's origin. */
export async function loadOpenSearch(searchUrl, fetchImpl) {
    let res;
    try { res = await fetchImpl(searchUrl, { headers: { Accept: 'application/opensearchdescription+xml, application/xml, */*' } }); } catch { throw new Error('Could not read the service search description.'); }
    if (!res.ok) throw new Error(`The service search description answered ${res.status}.`);
    return parseOpenSearch(await res.text());
}

/**
 * Reads what an address is, for the source editor: the description itself, or a service that links to it, and the
 * search description the service links to (an empty list when it has none).
 * @param {string} address a host or the address of the description
 * @param {(url: string, init?: object) => Promise<Response>} fetchImpl
 * @returns {Promise<{spec: object, specUrl: string, searchUrls: {type: string, template: string}[]}>}
 */
export async function discoverFromAddress(address, fetchImpl) {
    let url;
    try { url = new URL(/^[a-z]+:\/\//i.test(address) ? address : `https://${address}`); } catch { throw new Error('That is not a web address.'); }
    let res;
    try { res = await fetchImpl(url.href, { headers: { Accept: 'application/json' } }); } catch { throw new Error('Could not reach that address.'); }
    const sameOrigin = (href) => (href && new URL(href).origin === url.origin ? href : '');
    const searchLink = sameOrigin(searchDescLink(res.headers?.get?.('link'), url.href));
    const searchUrls = async () => { try { return searchLink ? await loadOpenSearch(searchLink, fetchImpl) : []; } catch { return []; } };
    const link = serviceDescLink(res.headers?.get?.('link'), url.href);
    if (link && new URL(link).origin === url.origin && link !== url.href) return { spec: await loadSpec(link, fetchImpl), specUrl: link, searchUrls: await searchUrls() };
    if (!res.ok) throw new Error(`That address answered ${res.status}.`);
    const spec = parseSpec(await res.text());
    specCache.set(url.href, { spec, at: Date.now() });
    return { spec, specUrl: url.href, searchUrls: await searchUrls() };
}
