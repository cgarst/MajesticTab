// tests/storage/fakes.mjs
// Test doubles for the two folder APIs: an in-memory File System Access directory handle, and Tauri's fs plugin over a
// real temp directory (so the native adapter meets the real file system, case rules included).
import fsp from 'node:fs/promises';
import path from 'node:path';

const nf = (name) => Object.assign(new Error(`${name} not found`), { name: 'NotFoundError' });

class FakeFile {
    constructor() { this.bytes = new Uint8Array(0); this.mtime = 0; }
}
export class FakeDirHandle {
    constructor(name = 'root') { this.kind = 'directory'; this.name = name; this.children = new Map(); this.clock = { t: 1700000000000 }; }
    async getDirectoryHandle(name, { create } = {}) {
        const c = this.children.get(name);
        if (c) { if (c.kind !== 'directory') throw Object.assign(new Error('type'), { name: 'TypeMismatchError' }); return c; }
        if (!create) throw nf(name);
        const d = new FakeDirHandle(name); d.clock = this.clock; this.children.set(name, d); return d;
    }
    async getFileHandle(name, { create } = {}) {
        const c = this.children.get(name);
        if (c) { if (c.kind !== 'file') throw Object.assign(new Error('type'), { name: 'TypeMismatchError' }); return c; }
        if (!create) throw nf(name);
        const f = new FakeFileHandle(name, this.clock); this.children.set(name, f); return f;
    }
    async removeEntry(name) { if (!this.children.delete(name)) throw nf(name); }
    async *entries() { for (const e of [...this.children]) yield e; }
}
class FakeFileHandle {
    constructor(name, clock) { this.kind = 'file'; this.name = name; this.data = new FakeFile(); this.clock = clock; }
    async getFile() { return new File([this.data.bytes], this.name, { lastModified: this.data.mtime }); }
    async createWritable() {
        const self = this; let pending = null;
        return {
            async write(b) { pending = new Uint8Array(b); },
            async close() { self.data.bytes = pending ?? new Uint8Array(0); self.data.mtime = ++self.clock.t; },
            async abort() { pending = null; },
        };
    }
}

/** Tauri fs plugin API over a real directory. Errors say "No such file" like the plugin's. */
export const nodeTauriFs = {
    async readDir(p) { return (await fsp.readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() })); },
    async stat(p) { const s = await fsp.stat(p); return { size: s.size, mtime: s.mtime, ino: s.ino, isDirectory: s.isDirectory(), isFile: s.isFile() }; },
    async exists(p) { try { await fsp.access(p); return true; } catch { return false; } },
    async mkdir(p, o) { await fsp.mkdir(p, o); },
    async readFile(p) { return new Uint8Array(await fsp.readFile(p)); },
    async writeFile(p, b) { await fsp.writeFile(p, b); },
    async rename(a, b) { await fsp.rename(a, b); },
    async remove(p) { await fsp.rm(p, { recursive: true }); },
};
export { path };
