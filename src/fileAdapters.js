import { createExtensionSandbox, getSandboxLibSource } from './extensionSandbox.js';

const EXTENSIONS_STORAGE_KEY = 'customExtensions';
const LOAD_TIMEOUT_MS = 15000;
const MATCH_TIMEOUT_MS = 15000;
const TRANSFORM_TIMEOUT_MS = 120000;

// Adapters registered by loaded extensions, in run order, as { id, ext }.
let adapters = [];
let sandbox = null;
let loaded = false;
let installChain = Promise.resolve();

async function install(localExtensions) {
    sandbox?.dispose();
    sandbox = null;
    adapters = [];

    const extensions = localExtensions;
    const errors = [];
    const idsByExtension = {};
    if (!extensions.length) return { count: 0, registrationCount: 0, errors, idsByExtension };

    const next = createExtensionSandbox();
    let results;
    try {
        results = await next.load(
            extensions.map(({ id, source }) => ({ id, source })),
            await getSandboxLibSource(),
            LOAD_TIMEOUT_MS
        );
    } catch (error) {
        next.dispose();
        return {
            count: 0,
            registrationCount: 0,
            errors: extensions.map(extension => ({ id: extension.id, message: error.message })),
            idsByExtension
        };
    }

    const seen = new Set();
    for (const result of results) {
        if (result.error) {
            errors.push({ id: result.id, message: result.error });
            continue;
        }
        const duplicate = result.ids.find(id => seen.has(id));
        if (duplicate !== undefined) {
            errors.push({ id: result.id, message: `Duplicate file adapter id: ${duplicate}` });
            continue;
        }
        result.ids.forEach(id => {
            seen.add(id);
            adapters.push({ id, ext: result.id });
        });
        idsByExtension[result.id] = result.ids;
    }
    sandbox = next;
    return { count: adapters.length, registrationCount: adapters.length, errors, idsByExtension };
}

/** Load these { id, source } extensions in the sandbox, replacing whatever was loaded before. */
export function installExtensionSources(localExtensions) {
    loaded = true;
    const run = installChain.then(() => install(localExtensions));
    installChain = run.catch(() => {});
    return run;
}

/** Enabled extensions saved on this device, as { id, source }. */
export function getEnabledExtensionSources() {
    try {
        const parsed = JSON.parse(localStorage.getItem(EXTENSIONS_STORAGE_KEY) || '[]');
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(e => e && e.enabled && typeof e.source === 'string')
            .map(({ id, source }) => ({ id, source }));
    } catch {
        return [];
    }
}

async function ensureExtensionsLoaded() {
    if (!loaded) installExtensionSources(getEnabledExtensionSources());
    await installChain;
}

/** A timed-out or crashed sandbox is gone; reload from storage on next use. */
function noteSandboxFailure(error) {
    if (!error?.fatal) return;
    sandbox = null;
    adapters = [];
    loaded = false;
}

const callAdapter = (op, adapter, file) =>
    sandbox.call({ op, ext: adapter.ext, adapter: adapter.id, file }, op === 'matches' ? MATCH_TIMEOUT_MS : TRANSFORM_TIMEOUT_MS);

export async function applyFileAdapters(file) {
    await ensureExtensionsLoaded();
    let result = file;

    try {
        for (const adapter of [...adapters]) {
            if (!sandbox || !await callAdapter('matches', adapter, result)) continue;

            const transformed = await callAdapter('transform', adapter, result);
            if (transformed == null) continue;
            if (!(transformed instanceof Blob)) {
                throw new TypeError(`Adapter "${adapter.id}" must return a File, Blob, or null.`);
            }

            result = transformed instanceof File
                ? transformed
                : new File([transformed], result.name, { type: transformed.type || result.type });
        }
    } catch (error) {
        noteSandboxFailure(error);
        throw error;
    }

    return result;
}

export async function hasMatchingFileAdapter(file) {
    await ensureExtensionsLoaded();
    for (const adapter of [...adapters]) {
        try {
            if (sandbox && await callAdapter('matches', adapter, file)) return true;
        } catch (error) {
            noteSandboxFailure(error);
        }
    }
    return false;
}
