// storage/memoryStore.js
// An in-memory store that follows the contract exactly, including versions, conditional writes and range reads.
// It is the reference the conformance suite runs against first, the stand-in for a backend in the tests of the sync
// engine, and a place to inject failures (`failNext`) to test retries and interrupted writes.
import { CAPABILITIES, NotFoundError, ConflictError, checkStorePath, checkStorePrefix, toBytes } from './contract.js';

export function createMemoryStore({ label = 'memory', capabilities = {} } = {}) {
    const files = new Map();      // path -> { bytes, version, modifiedTime }
    let counter = 0;
    let opened = false;
    const failures = [];

    const caps = {
        [CAPABILITIES.rangeRead]: true, [CAPABILITIES.conditionalWrite]: true,
        [CAPABILITIES.cheapList]: true, [CAPABILITIES.realFolders]: false, ...capabilities,
    };
    const entryOf = (path, f) => ({ path, size: f.bytes.length, version: f.version, modifiedTime: f.modifiedTime });
    const maybeFail = (op, path) => {
        const i = failures.findIndex((f) => f.op === op && (!f.path || path.startsWith(f.path)));
        if (i >= 0) throw failures.splice(i, 1)[0].error;
    };

    return {
        label, location: 'memory', capabilities: caps,
        /** Test hook: the next `op` ('write'|'read'|'delete'|'list') on a path under `path` throws `error`. */
        failNext(op, error = new Error('injected failure'), path = '') { failures.push({ op, error, path }); },
        /** Test hook: every file, for assertions. */
        dump() { return new Map([...files].map(([p, f]) => [p, f.bytes])); },

        async open({ create } = {}) {
            if (!opened && !create) return false;
            opened = true;
            return true;
        },

        async list(prefix = '') {
            checkStorePrefix(prefix);
            maybeFail('list', prefix);
            return [...files].filter(([p]) => p.startsWith(prefix)).map(([p, f]) => entryOf(p, f));
        },

        async stat(path) {
            checkStorePath(path);
            const f = files.get(path);
            return f ? entryOf(path, f) : null;
        },

        async read(path, { range } = {}) {
            checkStorePath(path);
            maybeFail('read', path);
            const f = files.get(path);
            if (!f) throw new NotFoundError(`No such file: ${path}`);
            if (!range) return f.bytes.slice();
            const start = Math.max(0, range.start ?? 0);
            const end = Math.min(f.bytes.length, range.end ?? f.bytes.length);
            return f.bytes.slice(start, Math.max(start, end));
        },

        async write(path, bytes, { ifVersion } = {}) {
            checkStorePath(path);
            maybeFail('write', path);
            const f = files.get(path);
            if (ifVersion !== undefined) {
                const current = f ? f.version : null;
                if (current !== ifVersion) throw new ConflictError(`Version mismatch writing ${path}`, current);
            }
            const stored = { bytes: new Uint8Array(await toBytes(bytes)), version: `v${++counter}`, modifiedTime: new Date().toISOString() };
            files.set(path, stored);
            return { version: stored.version };
        },

        async delete(path, { ifVersion } = {}) {
            checkStorePath(path);
            maybeFail('delete', path);
            const f = files.get(path);
            if (ifVersion !== undefined && (f ? f.version : null) !== ifVersion) {
                throw new ConflictError(`Version mismatch deleting ${path}`, f ? f.version : null);
            }
            return files.delete(path);
        },
    };
}
