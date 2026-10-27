// Runs user extensions in isolation. A hidden null-origin iframe (no app storage, no parent access)
// carries a CSP that forbids network access and remote scripts, and spawns one Worker per
// extension. Workers inherit that CSP and never see the page's native bridges or Tauri IPC.
// Extensions can run any JS on the files they are handed; they just can't reach anything else.

const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:";
const READY_TIMEOUT_MS = 10000;

/** Runs inside each Worker. Serialized with toString(), so it must not use outer variables. */
function workerMain() {
    'use strict';
    const adapters = [];

    const registerFileAdapter = adapter => {
        if (!adapter || typeof adapter.id !== 'string' || !adapter.id.trim()) {
            throw new TypeError('Each adapter must have a non-empty id.');
        }
        if (adapters.some(existing => existing.id === adapter.id)) {
            throw new TypeError(`Duplicate file adapter id: ${adapter.id}`);
        }
        if (typeof adapter.matches !== 'function' || typeof adapter.transform !== 'function') {
            throw new TypeError(`Adapter "${adapter.id}" must provide matches and transform functions.`);
        }
        adapters.push(adapter);
    };

    const registerGpScoreTransform = () => {
        throw new Error('registerGpScoreTransform is no longer supported. Extensions can only register file adapters.');
    };

    const findAdapter = id => {
        const adapter = adapters.find(item => item.id === id);
        if (!adapter) throw new Error(`Unknown adapter: ${id}`);
        return adapter;
    };

    self.onmessage = async ({ data }) => {
        const { id, op } = data;
        try {
            let result;
            if (op === 'load') {
                if (data.lib) new Function(data.lib).call(self);
                new Function('registerFileAdapter', 'registerGpScoreTransform', `"use strict";\n${data.source}`)(
                    registerFileAdapter, registerGpScoreTransform
                );
                result = adapters.map(adapter => adapter.id);
            } else if (op === 'matches') {
                result = !!(await findAdapter(data.adapter).matches(data.file));
            } else if (op === 'transform') {
                result = await findAdapter(data.adapter).transform(data.file);
                if (result != null && !(result instanceof Blob)) {
                    throw new TypeError(`Adapter "${data.adapter}" must return a File, Blob, or null.`);
                }
            } else {
                throw new Error(`Unknown operation: ${op}`);
            }
            self.postMessage({ id, ok: true, result });
        } catch (error) {
            self.postMessage({ id, ok: false, error: String(error?.message ?? error) });
        }
    };
}

/** Runs inside the sandboxed iframe: routes parent requests to one Worker per extension. */
function iframeMain(workerSource) {
    const workerUrl = URL.createObjectURL(new Blob([`(${workerSource})()`], { type: 'text/javascript' }));
    const workers = new Map();
    const post = message => parent.postMessage(message, '*');

    const callWorker = (entry, message) => new Promise((resolve, reject) => {
        const id = entry.nextId++;
        entry.pending.set(id, { resolve, reject });
        entry.worker.postMessage({ ...message, id });
    });

    const createWorker = () => {
        const entry = { worker: new Worker(workerUrl), pending: new Map(), nextId: 1 };
        entry.worker.onmessage = ({ data }) => {
            const waiting = entry.pending.get(data.id);
            if (!waiting) return;
            entry.pending.delete(data.id);
            if (data.ok) waiting.resolve(data.result);
            else waiting.reject(new Error(data.error));
        };
        entry.worker.onerror = event => {
            const error = new Error(event.message || 'Extension worker crashed');
            entry.pending.forEach(waiting => waiting.reject(error));
            entry.pending.clear();
        };
        return entry;
    };

    const handle = async message => {
        if (message.op === 'load') {
            const results = [];
            for (const extension of message.extensions) {
                const entry = createWorker();
                try {
                    const ids = await callWorker(entry, { op: 'load', source: extension.source, lib: message.lib });
                    workers.set(extension.id, entry);
                    results.push({ id: extension.id, ids });
                } catch (error) {
                    entry.worker.terminate();
                    results.push({ id: extension.id, error: error.message });
                }
            }
            return results;
        }
        const entry = workers.get(message.ext);
        if (!entry) throw new Error('Extension is not loaded');
        return callWorker(entry, message);
    };

    window.addEventListener('message', async ({ data }) => {
        try {
            post({ id: data.id, ok: true, result: await handle(data) });
        } catch (error) {
            post({ id: data.id, ok: false, error: error.message });
        }
    });
    post({ op: 'ready' });
}

function buildSrcdoc() {
    const script = `(${iframeMain})(${JSON.stringify(`(${workerMain})`)})`.replace(/</g, '\\u003c');
    return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><script>${script}</script>`;
}

let libSourcePromise = null;

/** Source of the fflate UMD build the page already loads, so extensions keep `globalThis.fflate`. */
export function getSandboxLibSource() {
    if (!libSourcePromise) {
        const src = document.querySelector('script[src*="fflate"]')?.src;
        libSourcePromise = src
            ? fetch(src).then(response => (response.ok ? response.text() : null)).catch(() => null)
            : Promise.resolve(null);
    }
    return libSourcePromise;
}

export function createExtensionSandbox() {
    const frame = document.createElement('iframe');
    const pending = new Map();
    let nextId = 1;
    let disposed = false;
    let markReady;
    let readyTimer;
    const ready = new Promise(resolve => { markReady = resolve; });

    const failAll = error => {
        pending.forEach(waiting => waiting.reject(error));
        pending.clear();
    };

    const onMessage = ({ source, data }) => {
        if (source !== frame.contentWindow || !data) return;
        if (data.op === 'ready') {
            clearTimeout(readyTimer);
            markReady();
            return;
        }
        const waiting = pending.get(data.id);
        if (!waiting) return;
        pending.delete(data.id);
        if (data.ok) waiting.resolve(data.result);
        else waiting.reject(new Error(data.error));
    };

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(readyTimer);
        window.removeEventListener('message', onMessage);
        frame.remove();
        failAll(new Error('Extension sandbox was shut down'));
    };

    const request = async (message, timeoutMs) => {
        if (disposed) throw new Error('Extension sandbox was shut down');
        await ready;
        if (disposed) throw new Error('Extension sandbox did not start');
        return new Promise((resolve, reject) => {
            const id = nextId++;
            const timer = setTimeout(() => {
                pending.delete(id);
                dispose();
                const error = new Error('Extension timed out');
                error.fatal = true;
                reject(error);
            }, timeoutMs);
            pending.set(id, {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); }
            });
            frame.contentWindow.postMessage({ ...message, id }, '*');
        });
    };

    window.addEventListener('message', onMessage);
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;';
    frame.srcdoc = buildSrcdoc();
    document.body.append(frame);

    readyTimer = setTimeout(() => {
        dispose();
        markReady();
    }, READY_TIMEOUT_MS);

    return {
        /** Compiles each { id, source } in its own Worker; resolves per extension to { id, ids } or { id, error }. */
        load: (extensions, lib, timeoutMs) => request({ op: 'load', extensions, lib }, timeoutMs),
        call: (message, timeoutMs) => request(message, timeoutMs),
        dispose
    };
}
