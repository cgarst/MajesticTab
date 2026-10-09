let adapters = [];
let scoreTransforms = [];

function compileExtensions(source, ids = new Set()) {
    const registeredAdapters = [];
    const registeredScoreTransforms = [];

    const registerFileAdapter = adapter => {
        if (!adapter || typeof adapter.id !== 'string' || !adapter.id.trim()) {
            throw new TypeError('Each adapter must have a non-empty id.');
        }
        if (ids.has(adapter.id)) {
            throw new TypeError(`Duplicate file adapter id: ${adapter.id}`);
        }
        if (typeof adapter.matches !== 'function' || typeof adapter.transform !== 'function') {
            throw new TypeError(`Adapter "${adapter.id}" must provide matches and transform functions.`);
        }
        ids.add(adapter.id);
        registeredAdapters.push(adapter);
    };

    const registerGpScoreTransform = extension => {
        if (!extension || typeof extension.id !== 'string' || !extension.id.trim()) {
            throw new TypeError('Each GP score transform must have a non-empty id.');
        }
        if (ids.has(extension.id)) {
            throw new TypeError(`Duplicate extension id: ${extension.id}`);
        }
        if (typeof extension.transform !== 'function') {
            throw new TypeError(`GP score transform "${extension.id}" must provide a transform function.`);
        }
        ids.add(extension.id);
        registeredScoreTransforms.push(extension);
    };

    new Function('registerFileAdapter', 'registerGpScoreTransform', `"use strict";\n${source}`)(registerFileAdapter, registerGpScoreTransform);
    return { adapters: registeredAdapters, scoreTransforms: registeredScoreTransforms };
}

export function installFileAdapters(source) {
    const compiled = compileExtensions(source);
    adapters = compiled.adapters;
    scoreTransforms = compiled.scoreTransforms;
    return adapters.length;
}

export function installExtensionSources(extensions) {
    const nextAdapters = [];
    const ids = new Set();
    const errors = [];
    const idsByExtension = {};
    const nextScoreTransforms = [];

    for (const extension of extensions) {
        const extensionIds = new Set(ids);
        try {
            const compiled = compileExtensions(extension.source, extensionIds);
            nextAdapters.push(...compiled.adapters);
            nextScoreTransforms.push(...compiled.scoreTransforms);
            idsByExtension[extension.id] = [
                ...compiled.adapters.map(adapter => adapter.id),
                ...compiled.scoreTransforms.map(transform => transform.id)
            ];
            ids.clear();
            extensionIds.forEach(id => ids.add(id));
        } catch (error) {
            errors.push({ id: extension.id, message: error.message });
        }
    }

    adapters = nextAdapters;
    scoreTransforms = nextScoreTransforms;
    return {
        count: adapters.length,
        registrationCount: adapters.length + scoreTransforms.length,
        errors,
        idsByExtension
    };
}

export function clearFileAdapters() {
    adapters = [];
    scoreTransforms = [];
}

export function applyGpScoreTransforms(score) {
    for (const extension of scoreTransforms) {
        try {
            extension.transform(score);
        } catch (error) {
            console.error(`GP score extension "${extension.id}" failed:`, error);
        }
    }
    return score;
}

export function ensureExtensionsLoaded() {
    if (adapters.length > 0 || scoreTransforms.length > 0) return;
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem('majesticTab_custom_extensions');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    const active = parsed.filter(e => e && e.enabled && typeof e.source === 'string');
                    if (active.length > 0) {
                        installExtensionSources(active);
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[fileAdapters] Could not auto-load saved extensions:', e);
    }
}

export async function applyFileAdapters(file) {
    ensureExtensionsLoaded();
    let result = file;

    for (const adapter of adapters) {
        if (!await adapter.matches(result)) continue;

        const transformed = await adapter.transform(result);
        if (transformed == null) continue;
        if (!(transformed instanceof Blob)) {
            throw new TypeError(`Adapter "${adapter.id}" must return a File, Blob, or null.`);
        }

        result = transformed instanceof File
            ? transformed
            : new File([transformed], result.name, { type: transformed.type || result.type });
    }

    return result;
}