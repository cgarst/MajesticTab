// Loaded by extensionSandbox/frame.html inside the sandboxed iframe. Routes parent requests to one
// Worker per extension. Workers inherit the frame's CSP (no network, no remote scripts) and never see
// the page's native bridges or Tauri IPC. Must stay a classic script with no external references.

/** Runs inside each Worker. Serialized with toString(), so it must not use outer variables. */
function workerMain() {
    'use strict';
    const adapters = [];
    const cryptoPending = new Map();
    let nextCryptoId = 1;

    // Chromium marks blob:null/ Workers spawned from sandbox="allow-scripts" iframes as non-secure
    // contexts (stripping self.crypto.subtle), even when the iframe itself is a secure context.
    // Forward SubtleCrypto calls to the sandboxed iframe when the worker lacks its own.
    const installSubtleBridge = () => {
        if (self.crypto?.subtle) return;
        const subtle = {};
        for (const method of [
            'encrypt', 'decrypt', 'sign', 'verify', 'digest',
            'generateKey', 'deriveKey', 'deriveBits',
            'importKey', 'exportKey', 'wrapKey', 'unwrapKey'
        ]) {
            subtle[method] = (...args) => new Promise((resolve, reject) => {
                const cryptoId = nextCryptoId++;
                cryptoPending.set(cryptoId, { resolve, reject });
                self.postMessage({ cryptoId, method, args });
            });
        }
        if (self.crypto) {
            Object.defineProperty(self.crypto, 'subtle', { value: subtle, configurable: true });
        } else {
            Object.defineProperty(self, 'crypto', { value: { subtle }, configurable: true });
        }
    };

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
        if (data && 'cryptoId' in data) {
            const waiting = cryptoPending.get(data.cryptoId);
            if (!waiting) return;
            cryptoPending.delete(data.cryptoId);
            if (data.ok) waiting.resolve(data.result);
            else waiting.reject(new Error(data.error));
            return;
        }
        const { id, op } = data;
        try {
            let result;
            if (op === 'load') {
                if (data.hasSubtle) installSubtleBridge();
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
function iframeMain() {
    const workerUrl = URL.createObjectURL(new Blob([`(${workerMain})()`], { type: 'text/javascript' }));
    const workers = new Map();
    const post = message => parent.postMessage(message, '*');

    const callWorker = (entry, message) => new Promise((resolve, reject) => {
        const id = entry.nextId++;
        entry.pending.set(id, { resolve, reject });
        entry.worker.postMessage({ ...message, id });
    });

    const createWorker = () => {
        const entry = { worker: new Worker(workerUrl), pending: new Map(), nextId: 1 };
        const keys = new Map();
        let nextKeyId = 1;

        const wrapKey = value => {
            if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) {
                const keyId = nextKeyId++;
                keys.set(keyId, value);
                return {
                    __cryptoKeyId: keyId,
                    type: value.type,
                    extractable: value.extractable,
                    algorithm: value.algorithm,
                    usages: value.usages
                };
            }
            if (value && typeof value === 'object' && typeof CryptoKey !== 'undefined' &&
                (value.publicKey instanceof CryptoKey || value.privateKey instanceof CryptoKey)) {
                return {
                    publicKey: wrapKey(value.publicKey),
                    privateKey: wrapKey(value.privateKey)
                };
            }
            return value;
        };

        const unwrapArg = arg => {
            if (!arg || typeof arg !== 'object') return arg;
            if (arg.__cryptoKeyId) return keys.get(arg.__cryptoKeyId);
            if (arg.public?.__cryptoKeyId) return { ...arg, public: keys.get(arg.public.__cryptoKeyId) };
            return arg;
        };

        entry.worker.onmessage = async ({ data }) => {
            if (data && 'cryptoId' in data) {
                try {
                    const fn = window.crypto?.subtle?.[data.method];
                    if (typeof fn !== 'function') throw new Error(`Unsupported crypto.subtle.${data.method}`);
                    const result = wrapKey(await fn.apply(window.crypto.subtle, data.args.map(unwrapArg)));
                    entry.worker.postMessage({ cryptoId: data.cryptoId, ok: true, result });
                } catch (error) {
                    entry.worker.postMessage({ cryptoId: data.cryptoId, ok: false, error: String(error?.message ?? error) });
                }
                return;
            }
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
            const hasSubtle = !!window.crypto?.subtle;
            for (const extension of message.extensions) {
                const entry = createWorker();
                try {
                    const ids = await callWorker(entry, {
                        op: 'load',
                        source: extension.source,
                        lib: message.lib,
                        hasSubtle
                    });
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

iframeMain();
