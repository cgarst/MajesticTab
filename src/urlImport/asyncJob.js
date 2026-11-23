// urlImport/asyncJob.js
// Runs a job that a service answers with instead of a file: poll its status address, report progress, and return the
// address of the finished file. Every field name comes from the service's own API description (see
// openApiDiscovery.js); this file knows no field of any particular service. Unit tested in tests/asyncJob.test.mjs.

const FIRST_DELAY_MS = 1500;
const MAX_DELAY_MS = 4000;
const MAX_POLL_FAILURES = 3;

/** The value a JSON Pointer (RFC 6901) names in a document, or undefined. */
export function readPointer(doc, pointer) {
    if (typeof pointer !== 'string' || (pointer !== '' && pointer[0] !== '/')) return undefined;
    let node = doc;
    for (const raw of pointer.split('/').slice(1)) {
        if (node === null || typeof node !== 'object') return undefined;
        node = node[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return node;
}

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The bar's value from 0 to 1, or null when the service reports no step or percentage (an indeterminate bar). */
export function fractionOf({ percent = null, step = null, steps = null } = {}) {
    let value = null;
    if (steps > 0 && step >= 1) value = ((step - 1) + (percent === null ? 0 : Math.min(Math.max(percent, 0), 100) / 100)) / steps;
    else if (percent !== null) value = percent / 100;
    return value === null ? null : Math.min(Math.max(value, 0), 1);
}

/**
 * Reads one status body with the service's mapping.
 * @returns {{state: 'pending'|'running'|'done'|'failed'|'unknown', fraction: number|null, label: string, error: string}}
 */
export function interpretJob(body, mapping) {
    const text = (pointer) => {
        const value = pointer ? readPointer(body, pointer) : undefined;
        return typeof value === 'string' ? value : '';
    };
    const raw = text(mapping.state);
    let state = 'unknown';
    for (const name of ['pending', 'running', 'done', 'failed']) if (mapping.states[name]?.includes(raw)) state = name;
    const p = mapping.progress || {};
    const progress = {
        percent: p.percent ? number(readPointer(body, p.percent)) : null,
        step: p.step ? number(readPointer(body, p.step)) : null,
        steps: p.steps ? number(readPointer(body, p.steps)) : null
    };
    return {
        state,
        fraction: state === 'running' ? fractionOf(progress) : null,
        label: text(p.label),
        error: text(mapping.error)
    };
}

/** An address with the access token added to its query (the only place a token goes), unless it already has one. */
export function withToken(address, auth) {
    if (!auth?.token || !auth.queryName) return address;
    const url = new URL(address);
    if (!url.searchParams.has(auth.queryName)) url.searchParams.set(auth.queryName, auth.token);
    return url.href;
}

/** The address with every named query parameter removed, so a token never lands in a stored source address. */
export function stripParams(address, names = []) {
    try {
        const url = new URL(address);
        for (const name of names) url.searchParams.delete(name);
        return url.href;
    } catch {
        return address;
    }
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cancelled.')); }, { once: true });
});

/**
 * Follows a job until it is done.
 * @param {object} options
 * @param {object} options.first the body of the response that started the job
 * @param {object} options.mapping the validated x-async-job mapping
 * @param {{status: (body: object) => string, result: (body: object) => string}} options.addresses where the job's status
 *   and file are for a job body, built from the description's links; both are on the origin the user entered
 * @param {{token: string, queryName: string}|null} [options.auth]
 * @param {(url: string) => Promise<Response>} options.fetchJson GET an address
 * @param {(update: {state: string, fraction: number|null, label: string}) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 * @returns {Promise<{resultUrl: string}>} the address of the finished file
 */
export async function runJob({ first, mapping, addresses, auth = null, fetchJson, onProgress = () => {}, signal, sleep = wait }) {
    let body = first;
    let delay = FIRST_DELAY_MS;
    let failures = 0;
    let statusUrl = '';
    for (;;) {
        if (signal?.aborted) throw new Error('Cancelled.');
        const job = interpretJob(body, mapping);
        statusUrl = addresses.status(body) || statusUrl;
        if (job.state === 'done') {
            const resultUrl = addresses.result(body);
            if (!resultUrl) throw new Error('The service finished but gave no file address.');
            return { resultUrl };
        }
        if (job.state === 'failed') throw new Error(job.error || 'The service could not make that file.');
        if (job.state === 'unknown') throw new Error('The service reported a state this app does not know.');
        onProgress({ state: job.state, fraction: job.fraction, label: job.label });
        if (!statusUrl) throw new Error('The service gave no address to check the job.');
        await sleep(delay, signal);
        delay = Math.min(Math.round(delay * 1.15), MAX_DELAY_MS);
        try {
            const res = await fetchJson(withToken(statusUrl, auth));
            if (res.status === 401 || res.status === 403) throw Object.assign(new Error('The service refused the access token.'), { fatal: true });
            if (res.status === 404) throw Object.assign(new Error('The service no longer has that job.'), { fatal: true });
            if (!res.ok) throw new Error(`The service answered ${res.status}.`);
            body = await res.json();
            failures = 0;
        } catch (error) {
            if (error?.message === 'Cancelled.' || error?.fatal) throw error;
            if (++failures >= MAX_POLL_FAILURES) throw new Error('Lost contact with the service.');
        }
    }
}
