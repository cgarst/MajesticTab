// urlImport/openApiDiscovery.js
// Finds out from a service's own API description (OpenAPI 3, JSON) what an address does: whether it starts a job, how
// to read the job's progress, whether it needs an access token and where the token goes. The app knows no host and no
// field of any service. It reads three things:
//   - the Link header with rel="service-desc" (RFC 8631), which points at the description;
//   - the standard parts of the description: paths, parameters, security schemes, info.title;
//   - two vendor extensions: x-async-job on the operation (how to read the job, as JSON Pointers into the response)
//     and x-search-text on the parameter that takes the artist and song text.
// The description is data from the network: only GET, only local $refs, a size cap, JSON only.
// Unit tested in tests/openApiDiscovery.test.mjs.

export const SPEC_MAX_BYTES = 512 * 1024;
const SPEC_TTL_MS = 10 * 60 * 1000;
const MAX_REF_DEPTH = 8;

const specCache = new Map();

/** Forgets every loaded description (tests, and a "Test" that should read the service again). */
export function clearSpecCache() { specCache.clear(); }

/** The address a Link header names with rel="service-desc", resolved against `base`, or ''. */
export function serviceDescLink(linkHeader, base) {
    for (const part of String(linkHeader || '').split(/,(?=\s*<)/)) {
        const m = /^\s*<([^>]*)>\s*((?:;[^;,]*)*)/.exec(part);
        if (!m) continue;
        const rel = /;\s*rel\s*=\s*"?([^";]+)"?/i.exec(m[2])?.[1] || '';
        if (rel.toLowerCase().split(/\s+/).includes('service-desc')) {
            try { return new URL(m[1], base).href; } catch { /* not an address */ }
        }
    }
    return '';
}

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

/**
 * The job mapping an operation declares in x-async-job, or an Error saying what is missing.
 * Required: statusUrl, state, states (pending, running, done, failed) and result. Optional: progress and error.
 */
export function asyncMapping(operation) {
    const raw = operation?.['x-async-job'];
    if (!raw || typeof raw !== 'object') return { error: 'This address does not describe a job.' };
    const mapping = { statusUrl: pointerOrNull(raw.statusUrl), state: pointerOrNull(raw.state), result: pointerOrNull(raw.result), error: pointerOrNull(raw.error), states: {}, progress: {} };
    for (const key of ['statusUrl', 'state', 'result']) {
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

const encode = (value) => encodeURIComponent(String(value));

/**
 * A search address template for an operation: `$s` takes the artist and song text, `$token` the access token. Required
 * parameters and parameters with a default are included; the others are listed in `optional` for the user to choose.
 * @returns {{template: string, optional: {name: string, values: string[], description: string}[]}|null} null when the
 *   operation has no parameter marked x-search-text
 */
export function buildTemplate(spec, found, origin) {
    const query = found.parameters.filter((p) => p.in === 'query');
    const search = query.find((p) => p['x-search-text'] === true);
    if (!search) return null;
    const auth = authOf(spec, found.operation);
    const pairs = [];
    const optional = [];
    for (const p of query) {
        const schema = resolveRef(spec, p.schema) || {};
        if (p === search) pairs.push(`${encode(p.name)}=$s`);
        else if (auth.queryName && p.name === auth.queryName) continue;
        else if (schema.default !== undefined) pairs.push(`${encode(p.name)}=${encode(schema.default)}`);
        else if (p.required && Array.isArray(schema.enum) && schema.enum.length) pairs.push(`${encode(p.name)}=${encode(schema.enum[0])}`);
        else if (!p.required) optional.push({ name: p.name, values: Array.isArray(schema.enum) ? schema.enum.map(String) : [], description: String(p.description || '') });
    }
    if (auth.queryName) pairs.push(`${encode(auth.queryName)}=$token`);
    return { template: `${origin}${found.prefix === '/' ? '' : found.prefix}${found.path}?${pairs.join('&')}`, optional };
}

/**
 * A source to add, read from a description: its name, address template, and what it needs.
 * @returns {{name: string, template: string, needsToken: boolean, optional: object[]}|{error: string}}
 */
export function suggestSource(spec, specUrl) {
    const origin = new URL(specUrl).origin;
    for (const [path, item] of Object.entries(spec.paths)) {
        const operation = item && typeof item === 'object' ? resolveRef(spec, item.get) : null;
        if (!operation || /\{/.test(path) || !asyncMapping(operation).mapping) continue;
        const found = { path, operation, parameters: [...(item.parameters || []), ...(operation.parameters || [])].map((p) => resolveRef(spec, p)).filter(Boolean), prefix: '' };
        const built = buildTemplate(spec, found, origin);
        if (!built) continue;
        const auth = authOf(spec, operation);
        return { name: String(spec.info?.title || new URL(origin).host).slice(0, 60), template: built.template, needsToken: auth.required, optional: built.optional };
    }
    return { error: 'That service does not describe a way to search for a file.' };
}

/**
 * Reads what an address is, for the source editor: the description itself, or a service that links to it.
 * @param {string} address a host or the address of the description
 * @param {(url: string, init?: object) => Promise<Response>} fetchImpl
 * @returns {Promise<{spec: object, specUrl: string}>}
 */
export async function discoverFromAddress(address, fetchImpl) {
    let url;
    try { url = new URL(/^[a-z]+:\/\//i.test(address) ? address : `https://${address}`); } catch { throw new Error('That is not a web address.'); }
    let res;
    try { res = await fetchImpl(url.href, { headers: { Accept: 'application/json' } }); } catch { throw new Error('Could not reach that address.'); }
    const link = serviceDescLink(res.headers?.get?.('link'), url.href);
    if (link && new URL(link).origin === url.origin && link !== url.href) return { spec: await loadSpec(link, fetchImpl), specUrl: link };
    if (!res.ok) throw new Error(`That address answered ${res.status}.`);
    const spec = parseSpec(await res.text());
    specCache.set(url.href, { spec, at: Date.now() });
    return { spec, specUrl: url.href };
}
