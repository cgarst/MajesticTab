// tests/storageIcloud.test.mjs
// The native folder store in iCloud mode: the shared conformance suite on a real temp folder, then files iCloud has
// evicted (hidden ".name.icloud" stubs), system files, and a download that finishes late or never.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createNativeFolderStore } from '../src/storage/folderStore.js';
import { NotFoundError, ConflictError, StorageError } from '../src/storage/contract.js';
import { runConformance } from './storage/conformance.mjs';
import { nodeTauriFs } from './storage/fakes.mjs';

const roots = [];
async function tmp() { const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'mt-icloud-')); roots.push(d); return d; }

runConformance('icloud folder', async () => {
    const s = createNativeFolderStore(await tmp(), { fs: nodeTauriFs, icloud: {} });
    await s.open({ create: true });
    return s;
});

// What iCloud does to a file it evicts: the real file goes and a small hidden stub takes its place
async function evict(dir, rel) {
    const full = path.join(dir, 'MajesticTab Library', rel);
    const bytes = await fsp.readFile(full);
    await fsp.rm(full);
    await fsp.writeFile(path.join(path.dirname(full), `.${path.basename(full)}.icloud`), 'stub');
    return bytes;
}

test('icloud: an evicted file is listed and stat-ed under its real name, with a version that never matches', async () => {
    const dir = await tmp();
    const s = createNativeFolderStore(dir, { fs: nodeTauriFs, icloud: {} });
    await s.open({ create: true });
    await s.write('packs/a/manifest.json', new Uint8Array([1, 2, 3]));
    await s.write('packs/a/audio/a.flac', new Uint8Array(5000));
    await fsp.writeFile(path.join(dir, 'MajesticTab Library', '.DS_Store'), 'x');
    await evict(dir, 'packs/a/audio/a.flac');
    const listed = await s.list('packs/');
    assert.deepEqual(listed.map((e) => e.path).sort(), ['packs/a/audio/a.flac', 'packs/a/manifest.json']);
    assert.equal(listed.find((e) => e.path.endsWith('a.flac')).version, 'evicted');
    assert.equal((await s.stat('packs/a/audio/a.flac')).version, 'evicted');
    await assert.rejects(() => s.write('packs/a/audio/a.flac', new Uint8Array([1]), { ifVersion: null }), ConflictError);
    assert.deepEqual((await s.list()).map((e) => e.path).sort(), ['packs/a/audio/a.flac', 'packs/a/manifest.json']);
});

test('icloud: reading an evicted file asks for the download, waits for it, and returns the bytes', async () => {
    const dir = await tmp();
    const asked = [];
    let original;
    const s = createNativeFolderStore(dir, {
        fs: nodeTauriFs,
        icloud: {
            pollMs: 5,
            download: async (abs) => {
                asked.push(abs);
                // iCloud brings the file back a little later and removes the stub
                setTimeout(async () => {
                    await fsp.writeFile(abs, original);
                    await fsp.rm(path.join(path.dirname(abs), `.${path.basename(abs)}.icloud`));
                }, 30);
            },
        },
    });
    await s.open({ create: true });
    await s.write('x/big.bin', new Uint8Array([7, 8, 9, 10]));
    original = await evict(dir, 'x/big.bin');
    assert.deepEqual([...await s.read('x/big.bin', { range: { start: 1, end: 3 } })], [8, 9]);
    assert.equal(asked.length, 1);
    assert.ok(asked[0].endsWith(path.join('MajesticTab Library', 'x', 'big.bin')));
    assert.equal((await s.stat('x/big.bin')).version === 'evicted', false);
});

test('icloud: a download that never arrives, or no way to ask for one, fails with a clear error', async () => {
    const dir = await tmp();
    const slow = createNativeFolderStore(dir, { fs: nodeTauriFs, icloud: { download: async () => {}, timeoutMs: 40, pollMs: 5 } });
    await slow.open({ create: true });
    await slow.write('a.bin', new Uint8Array([1]));
    await evict(dir, 'a.bin');
    await assert.rejects(() => slow.read('a.bin'), (e) => e instanceof StorageError && /iCloud has not finished/.test(e.message));
    const mute = createNativeFolderStore(dir, { fs: nodeTauriFs, icloud: {} });
    await assert.rejects(() => mute.read('a.bin'), (e) => e instanceof StorageError && /not on this device/.test(e.message));
    await assert.rejects(() => mute.read('nothing.bin'), NotFoundError);
});

test('icloud: deleting an evicted file removes its stub, and a file that is back wins over a leftover stub', async () => {
    const dir = await tmp();
    const s = createNativeFolderStore(dir, { fs: nodeTauriFs, icloud: {} });
    await s.open({ create: true });
    await s.write('d/one.bin', new Uint8Array([1]));
    await evict(dir, 'd/one.bin');
    assert.equal(await s.delete('d/one.bin'), true);
    assert.deepEqual(await s.list(), []);
    await s.write('d/two.bin', new Uint8Array([2]));
    await fsp.writeFile(path.join(dir, 'MajesticTab Library', 'd', '.two.bin.icloud'), 'stale');
    const listed = await s.list('d/');
    assert.equal(listed.length, 1);
    assert.notEqual(listed[0].version, 'evicted');
});

test('plain native store ignores stubs and dotfiles exactly as before', async () => {
    const dir = await tmp();
    const s = createNativeFolderStore(dir, { fs: nodeTauriFs });
    await s.open({ create: true });
    await fsp.writeFile(path.join(dir, 'MajesticTab Library', '.x.icloud'), 'stub');
    assert.equal((await s.list()).length, 1);
    assert.equal(await s.stat('x'), null);
});
