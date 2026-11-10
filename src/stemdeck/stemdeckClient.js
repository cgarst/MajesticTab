// stemdeck/stemdeckClient.js
// Talks to a StemDeck desktop app: the one on this computer (loopback, the default in the desktop apps) or one on
// the same network, by the address the person enters (StemDeck has to be made available on the network in its own
// Settings first). StemDeck separates a song into stems; asking it for every stem except the guitar gives a backing
// track on the same timeline as the file sent. Its API sends no cross-origin headers, so the requests go through the
// native shell (see hasStemDeckSupport) and the web build has no such tool. Plain http only: StemDeck's https
// listener uses a certificate signed by nobody, which the native client refuses.
// The calls used, all under /api at that address:
//   GET  health                      is this StemDeck, and which version
//   POST jobs (multipart file+stems) start a separation, returns { job_id }
//   GET  jobs/<id>                   { status, progress, stage, error }
//   GET  jobs/<id>/mixdown.flac      the chosen stems summed into one file (mixdown.wav for the same as WAV)
//   POST jobs/<id>/cancel            stop a job that is still running

/** StemDeck's own default. It moves to a free port when that one is taken, so the port is part of the address. */
export const DEFAULT_PORT = 8000;
const LOCAL_ADDRESS = `127.0.0.1:${DEFAULT_PORT}`;
const ADDRESS_KEY = 'stemdeck_address';

/** Every stem StemDeck makes except the guitar. */
export const NO_GUITAR_STEMS = ['vocals', 'drums', 'bass', 'piano', 'other'];

const FINISHED = new Set(['done', 'error', 'cancelled', 'stopped']);
const POLL_MS = 1000;
const MAX_POLL_FAILURES = 5;

// StemDeck accepts a file by its extension
const ACCEPTED_EXTS = ['mp3', 'wav', 'flac', 'mp4', 'm4a', 'ogg', 'opus'];
const EXT_OF_TYPE = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
    'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a',
    'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/opus': 'opus'
};

export class StemDeckError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'StemDeckError';
        this.code = code;
    }
}

/**
 * Reads what a person typed or pasted: "192.168.1.20", "192.168.1.20:8000", "my-mac.local:8000", or either with
 * "http://" in front and a path behind. No port means StemDeck's default.
 * @returns {{ host: string, port: number, address: string } | { error: 'https' | 'invalid' }}
 */
export function parseAddress(text) {
    let rest = String(text || '').trim();
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
    if (scheme) {
        if (scheme[1].toLowerCase() === 'https') return { error: 'https' };
        if (scheme[1].toLowerCase() !== 'http') return { error: 'invalid' };
        rest = rest.slice(scheme[0].length);
    }
    rest = rest.replace(/[/?#].*$/, '');
    const m = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(rest);
    if (!m) return { error: 'invalid' };
    const port = m[2] === undefined ? DEFAULT_PORT : Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'invalid' };
    const host = m[1].toLowerCase();
    return { host, port, address: `${host}:${port}` };
}

export const isLoopback = (host) => host === 'localhost' || /^127\./.test(String(host));

/** True in the Windows, macOS and Linux apps: the folder dialog is registered only there. */
export function isDesktopShell(win = globalThis.window) {
    return typeof win?.__TAURI__?.dialog?.open === 'function';
}

/**
 * The address the person entered, as "host:port", or '' when they have not entered one. A desktop app then looks for
 * StemDeck on this computer by itself (findLocalStemDeck); a phone has nothing to look for until it is given one.
 */
export function getStemDeckAddress(storage = globalThis.localStorage) {
    let saved = null;
    try { saved = storage?.getItem(ADDRESS_KEY); } catch { saved = null; }
    return (saved && parseAddress(saved).address) || '';
}

export function setStemDeckAddress(address, storage = globalThis.localStorage) {
    try { if (address) storage?.setItem(ADDRESS_KEY, address); else storage?.removeItem(ADDRESS_KEY); } catch { /* the address just won't be remembered */ }
}

// The StemDeck desktop app asks for its Settings port (its default port unless changed) and, when that is taken, for any free port
// from the OS: 49152 to 65535 on macOS and Windows, 32768 to 60999 on Linux. Its https listener (8443 or a free port)
// is for other devices and not used here. So on this computer: the last place it was found, then its default port, then every
// unprivileged port that has anything listening, each asked who it is.
const LOWEST_PORT = 1024;
const HIGHEST_PORT = 65535;
let lastFound = null;

/**
 * Finds the StemDeck running on this computer. Desktop apps only (`scan` is the native loopback port scan; without
 * it only the known places are tried).
 * @param {{ preferred?: string[], scan?: (from:number, to:number) => Promise<number[]>, fetchImpl?: typeof fetch,
 *           signal?: AbortSignal }} opts `preferred` are "host:port" addresses to try first (the saved one).
 * @returns {Promise<{ address: string, version: string, device: string } | null>}
 */
export async function findLocalStemDeck({ preferred = [], scan = null, fetchImpl = null, signal } = {}) {
    const asked = new Set();
    const ask = async (address) => {
        if (asked.has(address) || signal?.aborted) return null;
        asked.add(address);
        try {
            const info = await createStemDeckClient({ address, fetchImpl }).health(signal);
            return { address, ...info };
        } catch { return null; }
    };
    for (const address of [lastFound, ...preferred, LOCAL_ADDRESS]) {
        if (!address || !isLoopback(parseAddress(address).host || '')) continue;
        const hit = await ask(address);
        if (hit) return (lastFound = hit.address, hit);
    }
    if (!scan) return null;
    let ports = [];
    try { ports = await scan(LOWEST_PORT, HIGHEST_PORT); } catch { ports = []; }
    // Something else is often listening too (a dev server, a database): ask each who it is, a few at a time
    const queue = ports.map((p) => `127.0.0.1:${p}`).filter((a) => !asked.has(a));
    let found = null;
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
        while (queue.length && !found && !signal?.aborted) {
            const hit = await ask(queue.shift());
            if (hit && !found) found = hit;
        }
    }));
    if (found) lastFound = found.address;
    return found;
}

/** The native loopback port scan, or null where there is none (phones). */
export function nativeLoopbackScan(win = globalThis.window) {
    const invoke = win?.__TAURI__?.core?.invoke;
    return typeof invoke === 'function' && isDesktopShell(win)
        ? (from, to) => invoke('loopback_open_ports', { from, to })
        : null;
}

/**
 * The native apps only (desktop, Android, iOS): the native HTTP client is what reaches StemDeck. A browser cannot,
 * because StemDeck allows no other origin.
 */
export function hasStemDeckSupport(win = globalThis.window) {
    return typeof win?.__TAURI__?.http?.fetch === 'function';
}

/** The file name to upload under: the stored name when StemDeck accepts its extension, else one built from the type. */
export function uploadName(name, type) {
    const clean = String(name || 'audio').replace(/[\\/]/g, '_');
    const ext = /\.([a-z0-9]+)$/i.exec(clean)?.[1]?.toLowerCase();
    if (ext && ACCEPTED_EXTS.includes(ext)) return clean;
    const fromType = EXT_OF_TYPE[String(type || '').split(';')[0].trim().toLowerCase()];
    return fromType ? `${clean}.${fromType}` : clean;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new StemDeckError('Cancelled', 'cancelled')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(new StemDeckError('Cancelled', 'cancelled')); }
    signal?.addEventListener('abort', onAbort, { once: true });
});

/**
 * @param {{ address?: string, fetchImpl?: typeof fetch, pollMs?: number }} opts `address` is "host:port" as
 * parseAddress returns it. `fetchImpl` defaults to the native shell's fetch; tests pass their own.
 */
export function createStemDeckClient({ address = LOCAL_ADDRESS, fetchImpl = null, pollMs = POLL_MS } = {}) {
    const target = parseAddress(address);
    if (target.error) throw new StemDeckError('That is not an address StemDeck can be reached at', 'address');
    const scheme = 'http';
    const base = `${scheme}://${target.address}/api`;
    const where = isLoopback(target.host) ? `port ${target.port}` : target.address;
    const doFetch = fetchImpl || ((...args) => globalThis.window.__TAURI__.http.fetch(...args));

    async function call(path, init = {}) {
        let res;
        try {
            res = await doFetch(`${base}${path}`, init);
        } catch (e) {
            if (init.signal?.aborted) throw new StemDeckError('Cancelled', 'cancelled');
            throw new StemDeckError(`StemDeck is not answering on ${where}`, 'unreachable');
        }
        return res;
    }

    /** The reason StemDeck gave for refusing a request, in its own words. */
    async function refusal(res, fallback) {
        try {
            const detail = (await res.json())?.detail;
            if (typeof detail === 'string' && detail) return detail;
        } catch { /* no readable reason */ }
        return fallback;
    }

    async function health(signal) {
        const res = await call('/health', { signal });
        // StemDeck turns other devices away until it is made available on the network
        if (res.status === 403) throw new StemDeckError('StemDeck is not available on the network', 'network-off');
        let body = null;
        try { body = res.ok ? await res.json() : null; } catch { body = null; }
        if (body?.name !== 'StemDeck') throw new StemDeckError(`Something other than StemDeck is answering on ${where}`, 'not-stemdeck');
        return { version: body.version || '', device: body.demucs_device || '' };
    }

    /** Uploads `data` and asks for the stems in `stems`. Resolves with the job id. */
    async function submit({ name, type, data, stems = NO_GUITAR_STEMS }, signal) {
        const form = new FormData();
        form.append('file', new Blob([data], { type: type || 'application/octet-stream' }), uploadName(name, type));
        form.append('stems', JSON.stringify(stems));
        const res = await call('/jobs', { method: 'POST', body: form, signal });
        if (!res.ok) throw new StemDeckError(await refusal(res, 'StemDeck did not accept the file'), 'rejected');
        const id = (await res.json())?.job_id;
        if (!id) throw new StemDeckError('StemDeck did not start the job', 'rejected');
        return id;
    }

    async function jobState(jobId, signal) {
        const res = await call(`/jobs/${jobId}`, { signal });
        if (!res.ok) throw new StemDeckError('StemDeck no longer has this job', 'gone');
        return res.json();
    }

    /** Polls until the job is finished. `onProgress({ status, progress, stage })` on every answer. */
    async function waitForJob(jobId, { onProgress, signal } = {}) {
        let failures = 0;
        for (;;) {
            let state = null;
            try {
                state = await jobState(jobId, signal);
                failures = 0;
            } catch (e) {
                if (e.code !== 'unreachable' || ++failures >= MAX_POLL_FAILURES) throw e;
            }
            if (state) {
                onProgress?.({ status: state.status, progress: state.progress || 0, stage: state.stage || '' });
                if (state.status === 'done') return state;
                if (FINISHED.has(state.status)) {
                    throw new StemDeckError(state.error || (state.status === 'error' ? 'StemDeck could not separate this file' : 'Stopped in StemDeck'), state.status);
                }
            }
            await sleep(pollMs, signal);
        }
    }

    /**
     * The chosen stems of a finished job summed into one file. FLAC by default (lossless, about half the size of the
     * WAV); `format: 'wav'` is for a webview that cannot decode FLAC.
     */
    async function downloadMix(jobId, { stems = NO_GUITAR_STEMS, format = 'flac', signal } = {}) {
        const ext = format === 'wav' ? 'wav' : 'flac';
        const query = `stems=${stems.join(',')}&gains=${stems.map(() => 1).join(',')}`;
        const res = await call(`/jobs/${jobId}/mixdown.${ext}?${query}`, { signal });
        if (!res.ok) throw new StemDeckError(await refusal(res, 'StemDeck could not export the mix'), 'export');
        const data = await res.arrayBuffer();
        if (!data.byteLength) throw new StemDeckError('StemDeck returned an empty file', 'export');
        return { data, type: `audio/${ext}`, ext };
    }

    /** Asks StemDeck to stop a job. Never throws: it is called on the way out. */
    async function cancel(jobId) {
        try { await doFetch(`${base}/jobs/${jobId}/cancel`, { method: 'POST' }); } catch { /* it is already gone */ }
    }

    return { address: target.address, health, submit, jobState, waitForJob, downloadMix, cancel };
}
