let adapters = [];

function compileAdapters(source, ids = new Set()) {
    const registered = [];

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
        registered.push(adapter);
    };

    new Function('registerFileAdapter', `"use strict";\n${source}`)(registerFileAdapter);
    return registered;
}

export function installFileAdapters(source) {
    const nextAdapters = compileAdapters(source);
    adapters = nextAdapters;
    return adapters.length;
}

export function installExtensionSources(extensions) {
    const nextAdapters = [];
    const ids = new Set();
    const errors = [];
    const idsByExtension = {};

    for (const extension of extensions) {
        const extensionIds = new Set(ids);
        try {
            const registered = compileAdapters(extension.source, extensionIds);
            nextAdapters.push(...registered);
            idsByExtension[extension.id] = registered.map(adapter => adapter.id);
            ids.clear();
            extensionIds.forEach(id => ids.add(id));
        } catch (error) {
            errors.push({ id: extension.id, message: error.message });
        }
    }

    adapters = nextAdapters;
    return { count: adapters.length, errors, idsByExtension };
}

export function clearFileAdapters() {
    adapters = [];
}

export async function applyFileAdapters(file) {
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