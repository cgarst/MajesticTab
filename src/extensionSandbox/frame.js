// Loaded by extensionSandbox/frame.html inside the sandboxed iframe. Routes parent requests to one
// Worker per extension. Workers inherit the frame's CSP (no network, no remote scripts) and never see
// the page's native bridges or Tauri IPC. Must stay a classic script with no external references.

/** Runs inside each Worker. Serialized with toString(), so it must not use outer variables. */
function workerMain() {
    'use strict';
    const adapters = [];
    const syncSources = [];
    const urlImporters = [];
    const loadedLibs = new Set();
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

    // A sync source turns an address into sync point text. The sandbox has no network, so `step` never fetches: it is
    // called with the address and the response texts so far, and returns `{ fetch: [addresses] }` for the app to fetch
    // (their responses are appended on the next call) or `{ text }` when done.
    const registerSyncSource = source => {
        if (!source || typeof source.id !== 'string' || !source.id.trim()) {
            throw new TypeError('Each sync source must have a non-empty id.');
        }
        if (syncSources.some(existing => existing.id === source.id)) {
            throw new TypeError(`Duplicate sync source id: ${source.id}`);
        }
        if (typeof source.matches !== 'function' || typeof source.step !== 'function') {
            throw new TypeError(`Sync source "${source.id}" must provide matches and step functions.`);
        }
        syncSources.push(source);
    };

    const findSyncSource = id => {
        const source = syncSources.find(item => item.id === id);
        if (!source) throw new Error(`Unknown sync source: ${id}`);
        return source;
    };

    // A URL importer turns an address into a tab file. Like a sync source it never fetches: `step(url, responses)` returns
    // `{ fetch: [addresses], optional? }` (answered by the app, only from `hosts` or the address's own site; `optional` makes a failed request an empty response) or a finished
    // `{ file: { name, bytes }, sync? }`. `libs: ['alphaTab']` loads alphaTab into the worker first, so the importer can
    // build a score and export it. `sync` is an optional list of `{ label, videoId, barTimesMs }` for the opened score.
    const registerUrlImporter = importer => {
        if (!importer || typeof importer.id !== 'string' || !importer.id.trim()) {
            throw new TypeError('Each URL importer must have a non-empty id.');
        }
        if (urlImporters.some(existing => existing.id === importer.id)) {
            throw new TypeError(`Duplicate URL importer id: ${importer.id}`);
        }
        if (!Array.isArray(importer.hosts) || importer.hosts.some(h => typeof h !== 'string' || !h.trim())) {
            throw new TypeError(`URL importer "${importer.id}" must declare hosts as an array of host names.`);
        }
        if (typeof importer.matches !== 'function' || typeof importer.step !== 'function') {
            throw new TypeError(`URL importer "${importer.id}" must provide matches and step functions.`);
        }
        if (importer.libs !== undefined && (!Array.isArray(importer.libs) || importer.libs.some(name => name !== 'alphaTab'))) {
            throw new TypeError(`URL importer "${importer.id}" may only ask for libs: ['alphaTab'].`);
        }
        urlImporters.push(importer);
    };

    const findUrlImporter = id => {
        const importer = urlImporters.find(item => item.id === id);
        if (!importer) throw new Error(`Unknown URL importer: ${id}`);
        return importer;
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
                new Function('registerFileAdapter', 'registerGpScoreTransform', 'registerSyncSource', 'registerUrlImporter', `"use strict";\n${data.source}`)(
                    registerFileAdapter, registerGpScoreTransform, registerSyncSource, registerUrlImporter
                );
                result = adapters.map(adapter => adapter.id);
            } else if (op === 'matches') {
                result = !!(await findAdapter(data.adapter).matches(data.file));
            } else if (op === 'syncIds') {
                result = syncSources.map(source => source.id);
            } else if (op === 'syncMatches') {
                result = !!(await findSyncSource(data.source).matches(data.url));
            } else if (op === 'syncStep') {
                const out = await findSyncSource(data.source).step(data.url, data.responses);
                const ok = out && (typeof out.text === 'string' || (Array.isArray(out.fetch) && out.fetch.every(u => typeof u === 'string')));
                if (!ok) throw new TypeError(`Sync source "${data.source}" must return { text } or { fetch: [addresses] }.`);
                result = typeof out.text === 'string' ? { text: out.text } : { fetch: out.fetch };
            } else if (op === 'lib') {
                // A library an importer asked for (`libs`), loaded once into this worker's global scope.
                if (!loadedLibs.has(data.name)) {
                    new Function(data.source).call(self);
                    loadedLibs.add(data.name);
                }
                result = true;
            } else if (op === 'urlIds') {
                result = urlImporters.map(importer => ({ id: importer.id, hosts: importer.hosts, libs: importer.libs || [] }));
            } else if (op === 'urlMatches') {
                result = !!(await findUrlImporter(data.importer).matches(data.url));
            } else if (op === 'urlStep') {
                const out = await findUrlImporter(data.importer).step(data.url, data.responses);
                const hasFile = out && out.file && typeof out.file.name === 'string' &&
                    (out.file.bytes instanceof Uint8Array || out.file.bytes instanceof ArrayBuffer);
                const hasFetch = out && Array.isArray(out.fetch) && out.fetch.every(u => typeof u === 'string');
                if (!hasFile && !hasFetch) {
                    throw new TypeError(`URL importer "${data.importer}" must return { file: { name, bytes } } or { fetch: [addresses] }.`);
                }
                result = hasFile ? { file: out.file, sync: Array.isArray(out.sync) ? out.sync : [] } : { fetch: out.fetch, optional: out.optional === true };
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
                    const syncIds = await callWorker(entry, { op: 'syncIds' });
                    const urlImporters = await callWorker(entry, { op: 'urlIds' });
                    results.push({ id: extension.id, ids, syncIds, urlImporters });
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
